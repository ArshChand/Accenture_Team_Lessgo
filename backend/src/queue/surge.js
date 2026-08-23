/**
 * Surge detection and policy.
 *
 * The brief's headline scenario is 3x normal volume, and the brief is explicit
 * about what must NOT change when that happens: safe waiting times. Surge changes
 * presentation and cadence — what the dashboard shows, how often low-acuity
 * patients are rechecked, how cautious the assistant is about uncertainty — never
 * the clinical thresholds that decide whether a wait is safe. Those live in the
 * protocol and are validated by guardrails that no runtime state, surge included,
 * can touch. See clinical/protocol.js.
 *
 * `evaluate` is a pure function of metrics and prior state, so the state machine
 * itself is testable without a clock, a database, or real arrivals. The engine
 * supplies the metrics; this module only decides what to do with them.
 */

export const SURGE_STATE = { QUIET: 'quiet', SURGE: 'surge' };

/**
 * @param {object} metrics
 * @param {number} metrics.arrivalsPerHour
 * @param {number} metrics.queueDepth
 * @param {number} metrics.nursesOnDuty
 * @param {object} protocol   site protocol (supplies thresholds)
 * @param {object} prior      { state, belowThresholdSinceMs }
 * @param {number} nowMs
 * @param {number} exitHysteresisMs  how long metrics must stay below threshold before exiting surge
 */
export function evaluateSurge({ metrics, protocol, prior, nowMs, exitHysteresisMs }) {
  const { baselineArrivalsPerHour, surgeMultiplier, queuePerNurseThreshold } = protocol.surge;
  const nurses = Math.max(1, metrics.nursesOnDuty);
  const queuePerNurse = metrics.queueDepth / nurses;
  const multiple = baselineArrivalsPerHour > 0 ? metrics.arrivalsPerHour / baselineArrivalsPerHour : 0;

  const triggered = multiple >= surgeMultiplier || queuePerNurse >= queuePerNurseThreshold;
  const trigger = queuePerNurse >= queuePerNurseThreshold ? 'queue_per_nurse' : 'arrival_rate';

  const computedMetrics = {
    arrivalsPerHour: metrics.arrivalsPerHour,
    baselineArrivalsPerHour,
    multiple: Number(multiple.toFixed(2)),
    queueDepth: metrics.queueDepth,
    nursesOnDuty: nurses,
    queuePerNurse: Number(queuePerNurse.toFixed(2)),
    capacityDebtMinutes: metrics.capacityDebtMinutes ?? 0,
  };

  const policyApplied = {
    escalationThreshold: triggered
      ? protocol.confidence.surgeEscalationThreshold
      : protocol.confidence.thresholds.moderate,
    esi3SubBandingEnabled: triggered && protocol.surge.esi3SubBandingEnabled,
    lowAcuityReassessIntervalMs: protocol.surge.lowAcuityReassessIntervalMs,
    dashboardMode: triggered ? 'action_list' : 'full',
    // Included so a reviewer can confirm this never moves under surge.
    safeWaitMinutes: protocol.safeWaitMinutes,
  };

  // --- state transition, with hysteresis on the way out ---
  if (prior.state === SURGE_STATE.QUIET) {
    if (triggered) {
      return {
        state: SURGE_STATE.SURGE,
        active: true,
        changed: true,
        transition: 'entered',
        trigger,
        belowThresholdSinceMs: null,
        metrics: computedMetrics,
        policyApplied,
      };
    }
    return {
      state: SURGE_STATE.QUIET,
      active: false,
      changed: false,
      belowThresholdSinceMs: null,
      metrics: computedMetrics,
      policyApplied,
    };
  }

  // prior.state === SURGE
  if (triggered) {
    return {
      state: SURGE_STATE.SURGE,
      active: true,
      changed: false,
      belowThresholdSinceMs: null, // reset: still above threshold
      metrics: computedMetrics,
      policyApplied,
    };
  }

  // Below threshold while in surge: don't exit immediately. A single quiet
  // minute after a burst of arrivals is not the same as the surge being over,
  // and flapping in and out would make the dashboard mode change under the
  // nurse's hands.
  const belowSince = prior.belowThresholdSinceMs ?? nowMs;
  const sustainedBelow = nowMs - belowSince >= exitHysteresisMs;

  if (sustainedBelow) {
    return {
      state: SURGE_STATE.QUIET,
      active: false,
      changed: true,
      transition: 'exited',
      trigger: 'rate_normalised',
      belowThresholdSinceMs: null,
      metrics: computedMetrics,
      policyApplied,
    };
  }

  return {
    state: SURGE_STATE.SURGE,
    active: true,
    changed: false,
    belowThresholdSinceMs: belowSince,
    metrics: computedMetrics,
    policyApplied,
  };
}
