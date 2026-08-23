import { repositories } from '../db/index.js';
import { CLINICIAN_ROLE, ESI, TRIAGE_TRIGGER } from '../clinical/constants.js';
import { getActiveProtocol } from '../services/protocolService.js';
import { WAITING_STATUSES, scoreAndPersist } from '../services/triageService.js';
import { recordSurgeChange, recordWaitBreach } from '../services/auditService.js';
import { computeEsi3SubBand, computeQueueState } from './decay.js';
import { SURGE_STATE, evaluateSurge } from './surge.js';

/**
 * The queue engine: the "Continuous Re-Triage" loop from the Round 1 pitch,
 * running for real.
 *
 * Every tick it does three things, in order: measures whether the department is
 * surging, recomputes how much of each waiting patient's safe window is left, and
 * triggers a full re-score for anyone whose window is closing or who is overdue
 * for a recheck. A patient who was "stable" on arrival and has since been sitting
 * quietly for ninety minutes past their safe wait is exactly the failure this loop
 * exists to catch — the wait itself becomes new evidence, scored the same way a
 * new vital sign would be.
 *
 * Nothing here decides an ESI. `computeQueueState` decides whether a patient needs
 * re-scoring; `scoreAndPersist` — the same function the initial intake and every
 * new vitals reading calls — does the actual scoring, through the same rule
 * engine, the same model, and the same escalation-only ratchet. The queue engine
 * is a scheduler for the safety pipeline, not a second one.
 */
export class TriageEngine {
  constructor({ io, tickMs, exitHysteresisMs } = {}) {
    this.io = io;
    this.tickMs = tickMs;
    this.exitHysteresisMs = exitHysteresisMs;
    this.timer = null;
    this.surgeState = { state: SURGE_STATE.QUIET, belowThresholdSinceMs: null };
    this.ticking = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return; // never overlap a slow tick with the next one
      this.ticking = true;
      this.tick()
        .catch((error) => console.error('[engine] tick failed:', error))
        .finally(() => {
          this.ticking = false;
        });
    }, this.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Arrival rate, queue depth and staffing — the inputs surge detection needs. */
  async gatherSurgeMetrics() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [arrivalsPerHour, waiting, nursesOnDuty] = await Promise.all([
      repositories.encounters.count({ arrivalAt: { $gte: oneHourAgo } }),
      repositories.encounters.find({ status: { $in: WAITING_STATUSES } }),
      repositories.clinicians.count({
        active: true,
        role: { $in: [CLINICIAN_ROLE.TRIAGE_NURSE, CLINICIAN_ROLE.CHARGE_NURSE] },
      }),
    ]);
    return { arrivalsPerHour, waiting, nursesOnDuty };
  }

  async tick() {
    const protocol = getActiveProtocol();
    const now = new Date();

    const { arrivalsPerHour, waiting, nursesOnDuty } = await this.gatherSurgeMetrics();

    // Breach status and decay ratio never depend on surge state, so they can be
    // computed once to derive capacity debt — the input surge detection needs —
    // before surge itself is known for this tick. Only reassessment cadence
    // depends on the surge verdict, and that is applied in the second pass below,
    // once the verdict is in. Without this two-pass structure, the surge policy
    // (widened escalation threshold, faster low-acuity rechecks) would not take
    // effect until the tick *after* surge was detected — a lag the brief's
    // "instantly push an alert" requirement does not leave room for.
    const preliminary = waiting.map((encounter) => ({
      encounter,
      state: computeQueueState({ encounter, protocol, surgeActive: false, now }),
    }));

    const capacityDebtMinutes = Math.round(
      preliminary.reduce(
        (sum, { state }) => sum + (state.breached ? state.minutesWaiting - state.safeWaitMinutes : 0),
        0,
      ),
    );

    const surgeResult = evaluateSurge({
      metrics: { arrivalsPerHour, queueDepth: waiting.length, nursesOnDuty, capacityDebtMinutes },
      protocol,
      prior: this.surgeState,
      nowMs: now.getTime(),
      exitHysteresisMs: this.exitHysteresisMs,
    });
    this.surgeState = { state: surgeResult.state, belowThresholdSinceMs: surgeResult.belowThresholdSinceMs };

    const decayed = surgeResult.active
      ? waiting.map((encounter) => ({
          encounter,
          state: computeQueueState({ encounter, protocol, surgeActive: true, now }),
        }))
      : preliminary;

    if (surgeResult.changed) {
      const auditEvent = await recordSurgeChange({
        state: surgeResult.transition,
        metrics: surgeResult.metrics,
        policyApplied: surgeResult.policyApplied,
      });
      this.io?.emit('surge:state', {
        active: surgeResult.active,
        transition: surgeResult.transition,
        trigger: surgeResult.trigger,
        metrics: surgeResult.metrics,
        policyApplied: surgeResult.policyApplied,
        auditSeq: auditEvent.seq,
      });
    }

    const patches = [];
    const alerts = [];

    const subBandFor = (esi, state, confidenceBand) => {
      if (!surgeResult.active || esi !== ESI.URGENT || !protocol.surge.esi3SubBandingEnabled) return null;
      return computeEsi3SubBand({ decayRatio: state.decayRatio, confidenceBand });
    };

    for (const { encounter, state } of decayed) {
      // The whole per-encounter body is guarded: one patient with a corrupted or
      // otherwise unscorable record must not stop the tick for everyone else
      // waiting behind them. They keep their last known state and are retried
      // next tick rather than silently dropping out of the queue.
      try {
        const updates = {
          'queue.decayRatio': state.decayRatio,
          'queue.decayStatus': state.decayStatus,
          'queue.priorityScore': state.priorityScore,
          'queue.safeWaitMinutes': state.safeWaitMinutes,
          'queue.vulnerabilityBonus': state.vulnerabilityBonus,
          'queue.surgeSubBand': subBandFor(encounter.currentESI, state, encounter.currentConfidence?.band),
        };
        if (state.isNewBreach) updates['queue.breachedAt'] = now;
        if (state.needsReassessment) updates['queue.reassessmentDueAt'] = state.nextReassessmentDueAt;

        let updated = await repositories.encounters.updateById(encounter._id, updates);

        if (state.isNewBreach) {
          const auditEvent = await recordWaitBreach({
            encounter,
            safeWaitMinutes: state.safeWaitMinutes,
            waitedMinutes: state.minutesWaiting,
          });
          alerts.push({
            kind: 'wait_breach',
            encounterId: String(encounter._id),
            displayRef: encounter.displayRef,
            esi: encounter.currentESI,
            minutesWaiting: Math.round(state.minutesWaiting),
            safeWaitMinutes: state.safeWaitMinutes,
            auditSeq: auditEvent.seq,
          });
        }

        if (state.needsReassessment) {
          const priorESI = encounter.currentESI;
          const scored = await scoreAndPersist({
            encounter: updated,
            trigger: TRIAGE_TRIGGER.WAIT_DECAY,
            surgeActive: surgeResult.active,
          });
          updated = await repositories.encounters.updateById(encounter._id, {
            $set: { 'queue.lastReassessedAt': now },
            $inc: { 'queue.reassessCount': 1 },
          });

          // The wait clock just reset and the ESI may have changed, so the decay
          // fields written above are now stale — recompute them against the
          // patient's actual post-reassessment state rather than leave the
          // dashboard showing an amber patient who was, a moment ago, just seen.
          const freshState = computeQueueState({
            encounter: updated,
            protocol,
            surgeActive: surgeResult.active,
            now,
          });
          updated = await repositories.encounters.updateById(encounter._id, {
            'queue.decayRatio': freshState.decayRatio,
            'queue.decayStatus': freshState.decayStatus,
            'queue.priorityScore': freshState.priorityScore,
            'queue.safeWaitMinutes': freshState.safeWaitMinutes,
            'queue.reassessmentDueAt': freshState.nextReassessmentDueAt,
            'queue.surgeSubBand': subBandFor(updated.currentESI, freshState, updated.currentConfidence?.band),
          });

          if (scored.fusion.finalESI < (priorESI ?? 6)) {
            alerts.push({
              kind: 'deterioration',
              encounterId: String(encounter._id),
              displayRef: encounter.displayRef,
              fromESI: priorESI,
              toESI: scored.fusion.finalESI,
              minutesWaiting: Math.round(state.minutesWaiting),
              assessmentId: String(scored.assessment._id),
            });
          }
        }

        patches.push({
          encounterId: String(encounter._id),
          displayRef: updated.displayRef,
          currentESI: updated.currentESI,
          status: updated.status,
          queue: updated.queue,
        });
      } catch (error) {
        console.error(`[engine] failed to process ${encounter.displayRef} this tick:`, error.message);
      }
    }

    if (patches.length && this.io) {
      this.io.emit('queue:patch', {
        patches,
        surgeActive: surgeResult.active,
        capacityDebtMinutes,
        tickAt: now.toISOString(),
      });
    }
    for (const alert of alerts) this.io?.emit('patient:alert', alert);

    return {
      surgeActive: surgeResult.active,
      capacityDebtMinutes,
      patchCount: patches.length,
      alertCount: alerts.length,
      tickAt: now.toISOString(),
    };
  }
}
