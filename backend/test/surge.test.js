import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SURGE_STATE, evaluateSurge } from '../src/queue/surge.js';
import { getDefaultProtocol } from '../src/clinical/protocol.js';

const protocol = getDefaultProtocol(); // baseline 8/hr, 2x multiplier, queuePerNurseThreshold 6
const HYSTERESIS_MS = 5 * 60000;
const T0 = 1_700_000_000_000;

const quiet = { state: SURGE_STATE.QUIET, belowThresholdSinceMs: null };
const surging = { state: SURGE_STATE.SURGE, belowThresholdSinceMs: null };

describe('surge detection: entering', () => {
  it('stays quiet under normal load', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 8, queueDepth: 10, nursesOnDuty: 4 },
      protocol,
      prior: quiet,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.active, false);
    assert.equal(result.changed, false);
  });

  it('declares surge at 3x arrival volume, the brief’s headline scenario', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 24, queueDepth: 10, nursesOnDuty: 4 },
      protocol,
      prior: quiet,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.active, true);
    assert.equal(result.changed, true);
    assert.equal(result.transition, 'entered');
    assert.equal(result.trigger, 'arrival_rate');
    assert.equal(result.metrics.multiple, 3);
  });

  it('also declares surge purely from queue-per-nurse pressure, even at normal arrival volume', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 8, queueDepth: 30, nursesOnDuty: 2 }, // 15 per nurse
      protocol,
      prior: quiet,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.active, true);
    assert.equal(result.trigger, 'queue_per_nurse');
  });

  it('guards against a zero-nurse reading producing a division error', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 8, queueDepth: 5, nursesOnDuty: 0 },
      protocol,
      prior: quiet,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.ok(Number.isFinite(result.metrics.queuePerNurse));
  });
});

describe('surge policy: what changes and what must not', () => {
  it('never relaxes the safe-wait table', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 30, queueDepth: 40, nursesOnDuty: 3 },
      protocol,
      prior: quiet,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.deepEqual(result.policyApplied.safeWaitMinutes, protocol.safeWaitMinutes);
  });

  it('widens the escalation threshold so the assistant escalates on less uncertainty', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 30, queueDepth: 40, nursesOnDuty: 3 },
      protocol,
      prior: quiet,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.policyApplied.escalationThreshold, protocol.confidence.surgeEscalationThreshold);
    assert.ok(result.policyApplied.escalationThreshold > protocol.confidence.thresholds.moderate);
  });

  it('uses the standard threshold when quiet', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 8, queueDepth: 5, nursesOnDuty: 4 },
      protocol,
      prior: quiet,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.policyApplied.escalationThreshold, protocol.confidence.thresholds.moderate);
  });

  it('switches the dashboard to an action list under surge', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 30, queueDepth: 40, nursesOnDuty: 3 },
      protocol,
      prior: quiet,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.policyApplied.dashboardMode, 'action_list');
    assert.equal(result.policyApplied.esi3SubBandingEnabled, true);
  });
});

describe('surge detection: exiting requires sustained normalisation', () => {
  it('does not exit on the first below-threshold reading', () => {
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 8, queueDepth: 5, nursesOnDuty: 4 },
      protocol,
      prior: surging,
      nowMs: T0,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.state, SURGE_STATE.SURGE, 'a single quiet moment is not the surge ending');
    assert.equal(result.active, true);
    assert.equal(result.changed, false);
    assert.equal(result.belowThresholdSinceMs, T0);
  });

  it('does not exit before the hysteresis window elapses', () => {
    const stillWithinWindow = { state: SURGE_STATE.SURGE, belowThresholdSinceMs: T0 };
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 8, queueDepth: 5, nursesOnDuty: 4 },
      protocol,
      prior: stillWithinWindow,
      nowMs: T0 + HYSTERESIS_MS - 1000,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.active, true);
    assert.equal(result.changed, false);
  });

  it('exits once metrics stay below threshold for the full hysteresis window', () => {
    const stillWithinWindow = { state: SURGE_STATE.SURGE, belowThresholdSinceMs: T0 };
    const result = evaluateSurge({
      metrics: { arrivalsPerHour: 8, queueDepth: 5, nursesOnDuty: 4 },
      protocol,
      prior: stillWithinWindow,
      nowMs: T0 + HYSTERESIS_MS + 1000,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(result.state, SURGE_STATE.QUIET);
    assert.equal(result.changed, true);
    assert.equal(result.transition, 'exited');
  });

  it('resets the hysteresis clock if load spikes again before it elapses', () => {
    const partWayThroughExit = { state: SURGE_STATE.SURGE, belowThresholdSinceMs: T0 };
    const spikeAgain = evaluateSurge({
      metrics: { arrivalsPerHour: 30, queueDepth: 40, nursesOnDuty: 3 },
      protocol,
      prior: partWayThroughExit,
      nowMs: T0 + HYSTERESIS_MS - 1000,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(spikeAgain.active, true);
    assert.equal(spikeAgain.belowThresholdSinceMs, null, 'a renewed spike must reset the exit clock');

    // Now even after what would have been the original exit time, surge holds.
    const stillSurging = evaluateSurge({
      metrics: { arrivalsPerHour: 8, queueDepth: 5, nursesOnDuty: 4 },
      protocol,
      prior: { state: spikeAgain.state, belowThresholdSinceMs: spikeAgain.belowThresholdSinceMs },
      nowMs: T0 + HYSTERESIS_MS + 500,
      exitHysteresisMs: HYSTERESIS_MS,
    });
    assert.equal(stillSurging.active, true);
  });
});
