import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeEsi3SubBand,
  computeQueueState,
  computeVulnerabilityBonus,
  minutesWaiting,
  reassessmentIntervalMs,
} from '../src/queue/decay.js';
import { AGE_BAND, DECAY_STATUS, ESI } from '../src/clinical/constants.js';
import { getDefaultProtocol } from '../src/clinical/protocol.js';

const protocol = getDefaultProtocol();
const NOW = new Date('2026-08-22T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);

const encounterWaiting = ({ esi = ESI.URGENT, arrivedMinutesAgo = 0, band = AGE_BAND.ADULT, queue = {} } = {}) => ({
  currentESI: esi,
  arrivalAt: minutesAgo(arrivedMinutesAgo),
  age: { band },
  queue,
});

describe('minutesWaiting', () => {
  it('measures from arrival when nothing has reset the clock', () => {
    const encounter = encounterWaiting({ arrivedMinutesAgo: 42 });
    assert.equal(minutesWaiting(encounter, NOW), 42);
  });

  it('measures from the last genuinely new information, not arrival, once there is some', () => {
    const encounter = encounterWaiting({
      arrivedMinutesAgo: 90,
      queue: { lastInformedAt: minutesAgo(10) },
    });
    assert.equal(minutesWaiting(encounter, NOW), 10);
  });

  it('is NOT reset by the system merely re-scoring stale data', () => {
    // An automated re-score learns nothing new; only lastInformedAt counts. If
    // lastReassessedAt reset the clock, a neglected patient would read as freshly
    // seen the moment the system noticed the neglect.
    const encounter = encounterWaiting({
      arrivedMinutesAgo: 90,
      queue: { lastReassessedAt: minutesAgo(2) },
    });
    assert.equal(minutesWaiting(encounter, NOW), 90);
  });

  it('never goes negative', () => {
    const encounter = encounterWaiting({ arrivedMinutesAgo: -5 }); // clock skew
    assert.equal(minutesWaiting(encounter, NOW), 0);
  });
});

describe('decay ratio and status', () => {
  it('is green well within the safe wait', () => {
    // ESI 3 safe wait is 30 minutes.
    const encounter = encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 5 });
    const state = computeQueueState({ encounter, protocol, now: NOW });
    assert.equal(state.decayStatus, DECAY_STATUS.GREEN);
    assert.equal(state.breached, false);
  });

  it('turns amber at the configured amber ratio', () => {
    // 0.6 * 30 = 18 minutes.
    const encounter = encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 19 });
    const state = computeQueueState({ encounter, protocol, now: NOW });
    assert.equal(state.decayStatus, DECAY_STATUS.AMBER);
    assert.equal(state.breached, false);
  });

  it('turns red exactly when the safe wait is exceeded', () => {
    const encounter = encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 30 });
    const state = computeQueueState({ encounter, protocol, now: NOW });
    assert.equal(state.decayStatus, DECAY_STATUS.RED);
    assert.equal(state.breached, true);
    assert.equal(state.decayRatio, 1);
  });

  it('an ESI 1 patient breaches immediately — there is no safe queue for resuscitation', () => {
    const encounter = encounterWaiting({ esi: ESI.RESUSCITATION, arrivedMinutesAgo: 1 });
    const state = computeQueueState({ encounter, protocol, now: NOW });
    assert.equal(state.breached, true);
    assert.equal(state.safeWaitMinutes, 0);
  });

  it('flags a breach as new only the first time it crosses', () => {
    const freshlyBreached = encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 31 });
    const alreadyKnownBreach = encounterWaiting({
      esi: ESI.URGENT,
      arrivedMinutesAgo: 45,
      queue: { breachedAt: minutesAgo(15) },
    });

    assert.equal(computeQueueState({ encounter: freshlyBreached, protocol, now: NOW }).isNewBreach, true);
    assert.equal(computeQueueState({ encounter: alreadyKnownBreach, protocol, now: NOW }).isNewBreach, false);
  });
});

describe('priority ordering', () => {
  it('orders strictly by ESI first regardless of how long the less urgent patient has waited', () => {
    const freshEsi2 = computeQueueState({
      encounter: encounterWaiting({ esi: ESI.EMERGENT, arrivedMinutesAgo: 1 }),
      protocol,
      now: NOW,
    });
    const longWaitingEsi4 = computeQueueState({
      encounter: encounterWaiting({ esi: ESI.LESS_URGENT, arrivedMinutesAgo: 200 }), // deep in breach
      protocol,
      now: NOW,
    });

    assert.ok(
      freshEsi2.priorityScore > longWaitingEsi4.priorityScore,
      'a fresh ESI 2 must still outrank a badly overdue ESI 4 — decay reorders within a level, not across one',
    );
  });

  it('within the same ESI, a longer wait outranks a shorter one', () => {
    const justArrived = computeQueueState({
      encounter: encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 1 }),
      protocol,
      now: NOW,
    });
    const almostBreached = computeQueueState({
      encounter: encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 25 }),
      protocol,
      now: NOW,
    });

    assert.ok(almostBreached.priorityScore > justArrived.priorityScore);
  });

  it('gives infants and the very old a bonus, breaking ties in their favour', () => {
    assert.ok(computeVulnerabilityBonus({ age: { band: AGE_BAND.INFANT } }) > 0);
    assert.ok(computeVulnerabilityBonus({ age: { band: AGE_BAND.ADVANCED_GERIATRIC } }) > 0);
    assert.equal(computeVulnerabilityBonus({ age: { band: AGE_BAND.ADULT } }), 0);

    const adult = computeQueueState({
      encounter: encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 5, band: AGE_BAND.ADULT }),
      protocol,
      now: NOW,
    });
    const infant = computeQueueState({
      encounter: encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 5, band: AGE_BAND.INFANT }),
      protocol,
      now: NOW,
    });
    assert.ok(infant.priorityScore > adult.priorityScore);
  });
});

describe('reassessment scheduling', () => {
  it('does not ask for reassessment before the protocol ratio is reached', () => {
    // 0.8 * 30 = 24 minutes for ESI 3.
    const encounter = encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 20 });
    assert.equal(computeQueueState({ encounter, protocol, now: NOW }).needsReassessment, false);
  });

  it('asks for reassessment once the ratio is reached and none is scheduled yet', () => {
    const encounter = encounterWaiting({ esi: ESI.URGENT, arrivedMinutesAgo: 25 });
    assert.equal(computeQueueState({ encounter, protocol, now: NOW }).needsReassessment, true);
  });

  it('does not ask again before the next scheduled due time', () => {
    const encounter = encounterWaiting({
      esi: ESI.URGENT,
      arrivedMinutesAgo: 26,
      queue: { reassessmentDueAt: new Date(NOW.getTime() + 5 * 60000) },
    });
    assert.equal(computeQueueState({ encounter, protocol, now: NOW }).needsReassessment, false);
  });

  it('asks again once the scheduled due time has passed', () => {
    const encounter = encounterWaiting({
      esi: ESI.URGENT,
      arrivedMinutesAgo: 26,
      queue: { reassessmentDueAt: new Date(NOW.getTime() - 1000) },
    });
    assert.equal(computeQueueState({ encounter, protocol, now: NOW }).needsReassessment, true);
  });

  it('checks low-acuity patients far more often under surge', () => {
    const quiet = reassessmentIntervalMs(protocol, ESI.LESS_URGENT, false);
    const surging = reassessmentIntervalMs(protocol, ESI.LESS_URGENT, true);
    assert.ok(surging < quiet, 'surge must check low-acuity patients more often, not less');
    assert.equal(surging, protocol.surge.lowAcuityReassessIntervalMs);
  });

  it('leaves high-acuity cadence unchanged by surge', () => {
    const quiet = reassessmentIntervalMs(protocol, ESI.EMERGENT, false);
    const surging = reassessmentIntervalMs(protocol, ESI.EMERGENT, true);
    assert.equal(quiet, surging, 'ESI 2 is already watched closely; surge should not change that');
  });

  it('floors the interval so a short safe-wait ESI does not get rechecked every few minutes', () => {
    // ESI 2 safe wait is 10 minutes; 25% of that is 2.5 minutes, floored to 5.
    assert.equal(reassessmentIntervalMs(protocol, ESI.EMERGENT, false), 5 * 60000);
  });
});

describe('ESI 3 sub-banding under surge', () => {
  it('puts a patient close to breach in 3A', () => {
    assert.equal(computeEsi3SubBand({ decayRatio: 0.7, confidenceBand: 'high' }), '3A');
  });

  it('puts a low-confidence assessment in 3A even with plenty of time left', () => {
    assert.equal(computeEsi3SubBand({ decayRatio: 0.1, confidenceBand: 'low' }), '3A');
  });

  it('puts a comfortable, confident patient in 3B', () => {
    assert.equal(computeEsi3SubBand({ decayRatio: 0.2, confidenceBand: 'high' }), '3B');
  });
});
