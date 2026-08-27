import { AGE_BAND, DECAY_STATUS, ESI } from '../clinical/constants.js';
import { safeWaitMinutesWith } from '../clinical/protocol.js';

/**
 * Queue decay: the "Continuous Re-Triage" mechanism from the Round 1 pitch.
 *
 * A static queue is the failure mode the whole product exists to prevent — a
 * patient triaged as stable on arrival and then left waiting, silently
 * deteriorating, with nothing in the system watching them. Decay is how the
 * assistant keeps watching after the initial score: every waiting patient is
 * re-evaluated against how long they have safely got left, not just how long
 * they have already waited.
 *
 * All of this is pure and DB-free by design, so the safety-critical arithmetic —
 * when does a wait become dangerous, when does it demand a re-score — can be
 * tested without a database, a queue engine, or a socket.
 */

/**
 * Minutes since something genuinely new was learned about this patient — a new
 * vitals reading, or a clinician's decision — falling back to arrival if neither
 * has happened yet.
 *
 * This is deliberately not "time since the system last looked at them": an
 * automated re-score triggered by decay itself (`queue.lastReassessedAt`, see
 * reassessmentIntervalMs below) runs on the same stale inputs and learns nothing
 * new, so it must not reset this clock. If it did, a neglected patient would
 * flip back to green the instant the system noticed and re-ran the numbers on
 * them — masking the exact neglect this loop exists to catch.
 */
export function minutesWaiting(encounter, now = new Date()) {
  const reference = encounter.queue?.lastInformedAt ?? encounter.arrivalAt;
  if (!reference) return 0;
  return Math.max(0, (now.getTime() - new Date(reference).getTime()) / 60000);
}

/**
 * A bonus added to priority ordering for patients who need to be seen sooner
 * than their ESI alone implies, even before any breach. Deliberately modest
 * relative to an ESI level (1000 points) so it reorders within a level, never
 * across one — a vulnerable ESI 4 still waits behind every ESI 3.
 */
/**
 * Chosen to exceed the whole computed range rather than to be "large". Anything
 * reachable by ordinary scoring would make promotion conditional on the patient
 * not already being urgent, which is the opposite of what it is for.
 */
export const MANUAL_PROMOTION_BONUS = 100000;

export function computeVulnerabilityBonus(encounter) {
  const band = encounter.age?.band;
  if (band === AGE_BAND.NEONATE || band === AGE_BAND.INFANT) return 150;
  if (band === AGE_BAND.ADVANCED_GERIATRIC) return 100;
  if (band === AGE_BAND.GERIATRIC) return 50;
  return 0;
}

/**
 * How often a waiting patient at this ESI gets automatically re-scored while
 * nothing else has triggered a re-score (a new vitals reading always triggers
 * one immediately, regardless of this interval).
 *
 * Under surge, low-acuity patients (ESI 4-5) are rechecked far more often —
 * this is the concrete form of "the system must monitor patients already in the
 * waiting queue" holding up when the queue triples. High-acuity patients are
 * already being watched closely under the normal cadence, so surge does not
 * change their interval.
 */
export function reassessmentIntervalMs(protocol, esi, surgeActive) {
  if (surgeActive && esi >= 4) {
    return protocol.surge.lowAcuityReassessIntervalMs;
  }
  const safeWaitMs = safeWaitMinutesWith(protocol, esi) * 60000;
  // A quarter of the safe wait, floored at five minutes so a short safe wait
  // (ESI 2, ten minutes) doesn't demand a reassessment every two and a half.
  return Math.max(5 * 60000, safeWaitMs * 0.25);
}

/**
 * Full queue state for one waiting encounter at this instant.
 *
 * `decayRatio` is minutesWaiting / safeWaitMinutes — under 1 means still within
 * the clinically safe window for this ESI, at or over 1 means the safe wait has
 * been exceeded. ESI 1 has a safe wait of zero, so any wait at all is an
 * immediate breach: a resuscitation patient has no queue to sit in.
 */
export function computeQueueState({ encounter, protocol, surgeActive = false, now = new Date() }) {
  const esi = encounter.currentESI ?? ESI.URGENT;
  const safeWaitMinutesValue = safeWaitMinutesWith(protocol, esi);
  const waited = minutesWaiting(encounter, now);

  // ESI 1 has a safe wait of zero, so any wait at all is already a breach. The
  // ratio is capped rather than left as Infinity: it has to survive JSON and
  // numeric storage on the way to a dashboard, and "999" reads as unbounded just
  // as clearly while remaining a number everything downstream can handle.
  const UNBOUNDED_BREACH = 999;
  const decayRatio =
    safeWaitMinutesValue > 0
      ? waited / safeWaitMinutesValue
      : waited > 0
        ? UNBOUNDED_BREACH
        : 0;

  let decayStatus = DECAY_STATUS.GREEN;
  if (decayRatio >= 1) decayStatus = DECAY_STATUS.RED;
  else if (decayRatio >= protocol.decay.amberRatio) decayStatus = DECAY_STATUS.AMBER;

  const breached = decayRatio >= 1;
  const vulnerabilityBonus = computeVulnerabilityBonus(encounter);

  // Higher ESI number = less urgent, so (6 - esi) puts ESI 1 highest. Decay and
  // vulnerability reorder within roughly one ESI band's worth of points, never
  // enough to let a long-waiting ESI 4 leapfrog a fresh ESI 2.
  const computedScore = (6 - esi) * 1000 + Math.min(decayRatio, 2) * 400 + vulnerabilityBonus;

  /**
   * A manual promotion sits above the entire computed range by construction:
   * the largest score this formula can produce is 5000 + 800 + 150, so a bonus
   * of 100000 cannot be reached by any combination of severity, waiting and
   * vulnerability. That is the point — the nurse saw something the assistant
   * cannot see, and the ordering has to reflect her, not argue with her.
   *
   * Promoted patients are still ranked against each other by their own computed
   * score, so a promoted ESI 1 stays ahead of a promoted ESI 4. Promotion moves
   * a patient to the front of the queue; it does not flatten the queue.
   */
  const promoted = Boolean(encounter.queue?.manualPromotion);
  const priorityScore = promoted ? MANUAL_PROMOTION_BONUS + computedScore : computedScore;

  const interval = reassessmentIntervalMs(protocol, esi, surgeActive);
  const dueAt = encounter.queue?.reassessmentDueAt ? new Date(encounter.queue.reassessmentDueAt) : null;
  const needsReassessment =
    decayRatio >= protocol.decay.reassessRatio && (!dueAt || now.getTime() >= dueAt.getTime());

  return {
    esi,
    safeWaitMinutes: safeWaitMinutesValue,
    minutesWaiting: waited,
    decayRatio: Number.isFinite(decayRatio) ? Number(decayRatio.toFixed(3)) : decayRatio,
    decayStatus,
    breached,
    isNewBreach: breached && !encounter.queue?.breachedAt,
    priorityScore: Math.round(priorityScore),
    vulnerabilityBonus,
    needsReassessment,
    nextReassessmentDueAt: new Date(now.getTime() + interval),
  };
}

/**
 * Whether ESI 3 splits into 3A (closer to breach or the assistant is less sure)
 * or 3B (comfortably stable). Only meaningful under surge, and only for ESI 3 —
 * see the surge policy notes in queue/surge.js for why ESI 3 is the level this
 * matters for.
 */
export function computeEsi3SubBand({ decayRatio, confidenceBand }) {
  if (decayRatio >= 0.5 || confidenceBand === 'low') return '3A';
  return '3B';
}
