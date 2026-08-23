import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { connectDatabase, disconnectDatabase, repositories, resetDatabase } from '../src/db/index.js';
import { activateProtocol, clearProtocolCache } from '../src/services/protocolService.js';
import { TriageEngine } from '../src/queue/engine.js';
import { verifyAuditChain } from '../src/services/auditService.js';
import { AGE_BAND, ENCOUNTER_STATUS, ESI } from '../src/clinical/constants.js';

/**
 * These tests run the queue engine against the real repository layer (the
 * memory driver) with a fake socket emitter, so they exercise the actual
 * decay → breach → alert → audit path end to end, not just the pure math in
 * decay.test.js and surge.test.js.
 *
 * The ML service is not running in this test process. scoreAndPersist degrades
 * to rules-only scoring when it can't reach it — exactly the degradation path
 * fusion.test.js and triageService are built to handle — so these tests are
 * unaffected by whether `uvicorn` happens to be up.
 */

before(async () => {
  await connectDatabase();
  await activateProtocol('default');
});

after(async () => disconnectDatabase());

beforeEach(async () => {
  await resetDatabase();
  clearProtocolCache();
  await activateProtocol('default');
});

/** Collects every event a fake socket would have broadcast. */
function fakeIo() {
  const events = [];
  return { emit: (event, payload) => events.push({ event, payload }), events };
}

async function seedWaitingEncounter({ esi, arrivedMinutesAgo, band = AGE_BAND.ADULT, ageYears = 40 }) {
  const patient = await repositories.patients.create({
    displayRef: `P-${Math.floor(Math.random() * 1e6)}`,
    hasPriorRecord: false,
  });
  return repositories.encounters.create({
    patientRef: patient._id,
    displayRef: patient.displayRef,
    age: { ageYears, band },
    chiefComplaint: 'test',
    currentESI: esi,
    status: ENCOUNTER_STATUS.WAITING,
    arrivalAt: new Date(Date.now() - arrivedMinutesAgo * 60000),
    queue: {},
  });
}

describe('engine: decay is applied and broadcast on every tick', () => {
  it('updates decay fields on a waiting encounter and emits a queue:patch', async () => {
    await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 5 });
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });

    const result = await engine.tick();

    assert.equal(result.patchCount, 1);
    const patchEvent = io.events.find((e) => e.event === 'queue:patch');
    assert.ok(patchEvent);
    assert.equal(patchEvent.payload.patches.length, 1);
    assert.equal(patchEvent.payload.patches[0].queue.decayStatus, 'green');
  });

  it('does nothing to encounters that are not waiting', async () => {
    const patient = await repositories.patients.create({ displayRef: 'P-9', hasPriorRecord: false });
    await repositories.encounters.create({
      patientRef: patient._id,
      displayRef: patient.displayRef,
      age: { ageYears: 40, band: AGE_BAND.ADULT },
      chiefComplaint: 'test',
      currentESI: ESI.URGENT,
      status: ENCOUNTER_STATUS.IN_TREATMENT,
      arrivalAt: new Date(Date.now() - 500 * 60000),
    });

    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });
    const result = await engine.tick();

    assert.equal(result.patchCount, 0);
  });
});

describe('engine: a wait breach is caught and logged, not just detected', () => {
  it('marks the breach, emits an alert, and writes an auditable event', async () => {
    // ESI 3 safe wait is 30 minutes.
    const encounter = await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 31 });
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });

    await engine.tick();

    const updated = await repositories.encounters.findById(encounter._id);
    assert.equal(updated.queue.decayStatus, 'red');
    assert.ok(updated.queue.breachedAt);

    const alert = io.events.find((e) => e.event === 'patient:alert' && e.payload.kind === 'wait_breach');
    assert.ok(alert, 'a breach must produce a patient:alert event, not just a silent status change');
    assert.equal(alert.payload.displayRef, encounter.displayRef);
    assert.ok(alert.payload.minutesWaiting >= 31);

    const auditEvents = await repositories.auditEvents.find({ 'subject.encounterRef': encounter._id });
    assert.ok(
      auditEvents.some((e) => e.eventType === 'WAIT_THRESHOLD_BREACHED'),
      'a breach must be recorded in the audit trail, not only broadcast',
    );
    assert.equal((await verifyAuditChain()).valid, true);
  });

  it('does not re-alert on every subsequent tick for the same breach', async () => {
    const encounter = await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 31 });
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });

    await engine.tick();
    await engine.tick();

    const breachAlerts = io.events.filter((e) => e.event === 'patient:alert' && e.payload.kind === 'wait_breach');
    assert.equal(breachAlerts.length, 1, 'the breach is new evidence once, not every tick');
  });

  it('an ESI 1 patient breaches on the very first tick — there is no safe wait to sit inside', async () => {
    const encounter = await seedWaitingEncounter({ esi: ESI.RESUSCITATION, arrivedMinutesAgo: 1 });
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });

    await engine.tick();

    const updated = await repositories.encounters.findById(encounter._id);
    assert.equal(updated.queue.decayStatus, 'red');
  });
});

describe('engine: reassessment is triggered by decay, scored through the real pipeline', () => {
  it('re-scores a patient once their decay ratio crosses the reassessment threshold', async () => {
    // 0.8 * 30 = 24 minutes for ESI 3.
    const encounter = await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 25 });
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });

    await engine.tick();

    const assessments = await repositories.assessments.find({ encounterRef: encounter._id });
    assert.ok(assessments.length >= 1, 'decay past the reassessment ratio must trigger a real scoring run');
    assert.equal(assessments[0].trigger, 'wait_decay');

    const updated = await repositories.encounters.findById(encounter._id);
    assert.ok(updated.queue.lastReassessedAt, 'the wait clock must reset once the patient has been re-seen');
    assert.equal(updated.queue.reassessCount, 1);
  });

  it('does NOT reset the decay clock on an automated re-score with no new information', async () => {
    // This is the important negative case. An automated reassessment runs on the
    // same stale inputs that got the patient into this state in the first place
    // — it must not be allowed to make them look freshly seen. If it did, a
    // truly neglected patient would flip back to green the instant the system
    // noticed the neglect and re-ran the numbers, hiding the exact problem this
    // loop exists to catch.
    const encounter = await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 25 });
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });

    await engine.tick();

    const afterReassessment = await repositories.encounters.findById(encounter._id);
    assert.ok(
      afterReassessment.queue.decayRatio > 0.8,
      'an automated re-score with no new data must not make a still-waiting patient look freshly seen',
    );
    assert.ok(afterReassessment.queue.reassessCount >= 1, 'the re-score itself did happen');
  });

  it('DOES reset the decay clock once new vitals are actually recorded', async () => {
    const encounter = await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 25 });

    const { scoreAndPersist } = await import('../src/services/triageService.js');
    await scoreAndPersist({
      encounter,
      vitals: { heartRate: { value: 78, source: 'measured', reliability: 1.0 } },
      trigger: 'vitals_change',
    });

    const afterNewVitals = await repositories.encounters.findById(encounter._id);
    assert.ok(
      afterNewVitals.queue.lastInformedAt,
      'recording a new observation is genuinely new information and must reset the clock',
    );
  });

  it('does not lose a patient from the queue if processing one of them throws', async () => {
    // The pipeline is deliberately built to degrade rather than throw (a bad ML
    // response falls back to rules-only, a missing model falls back further
    // still), so reaching a genuine exception deep inside scoring is hard to do
    // honestly. Faulting the repository call directly is a cleaner way to prove
    // the same guarantee: whatever the cause, one patient failing this tick must
    // not take the rest of the queue down with them.
    const troubled = await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 25 });
    const fine = await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 5 });

    const originalUpdateById = repositories.encounters.updateById.bind(repositories.encounters);
    repositories.encounters.updateById = async (id, update) => {
      if (String(id) === String(troubled._id)) throw new Error('simulated storage failure');
      return originalUpdateById(id, update);
    };

    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });

    try {
      await assert.doesNotReject(() => engine.tick(), 'one patient failing must not crash the whole tick');

      const patchEvent = io.events.find((e) => e.event === 'queue:patch');
      assert.ok(
        patchEvent.payload.patches.some((p) => p.encounterId === String(fine._id)),
        'a failure on one patient must not stop others in the same tick from being processed',
      );
      assert.ok(
        !patchEvent.payload.patches.some((p) => p.encounterId === String(troubled._id)),
        'the failed patient is skipped this tick, not silently reported as processed',
      );
    } finally {
      repositories.encounters.updateById = originalUpdateById;
    }

    const stillThere = await repositories.encounters.findById(troubled._id);
    assert.ok(stillThere, 'the patient must still be in the system after a failed processing attempt');
  });
});

describe('the ratchet holds across time, not just within one assessment', () => {
  it('never lets an automated re-score lower a standing score', async () => {
    // The re-score here runs with no vitals and no ML service, so it will
    // conclude something far less urgent than ESI 1. It must not be allowed to
    // act on that: the original escalation stands until a clinician says
    // otherwise, through applyOverride, with a reason and an attestation.
    const encounter = await seedWaitingEncounter({ esi: ESI.RESUSCITATION, arrivedMinutesAgo: 5 });

    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });
    await engine.tick();

    const updated = await repositories.encounters.findById(encounter._id);
    assert.equal(updated.currentESI, ESI.RESUSCITATION, 'a machine re-score must never de-escalate');

    // But the machine's opinion is still recorded, so a nurse can see it and act.
    assert.ok(
      updated.aiRecommendedESI > ESI.RESUSCITATION,
      'the assistant’s (less urgent) recommendation is still surfaced for a human to weigh',
    );
  });

  it('does let an automated re-score raise urgency, including past a nurse’s score', async () => {
    // ESI 5 has a 120-minute safe wait, so 100 minutes puts this patient past the
    // 0.8 reassessment ratio and actually triggers a re-score on this tick.
    const encounter = await seedWaitingEncounter({ esi: ESI.NON_URGENT, arrivedMinutesAgo: 100 });
    await repositories.encounters.updateById(encounter._id, { assignedBy: 'nurse' });

    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });
    await engine.tick();

    const updated = await repositories.encounters.findById(encounter._id);
    // With no vitals recorded, the rule engine floors this at ESI 3 — an
    // escalation, so it applies even over a nurse-assigned score. Catching
    // deterioration in an already-assessed patient is the point of the loop.
    assert.ok(
      updated.currentESI < ESI.NON_URGENT,
      'escalation must still be able to override a standing nurse score',
    );
  });
});

describe('engine: surge changes cadence and presentation, never safety', () => {
  async function makeSurgeConditions() {
    // Reference protocol: baseline 8/hr, 2x multiplier. 30 arrivals in the last
    // hour is well over 3x.
    for (let i = 0; i < 30; i += 1) {
      const patient = await repositories.patients.create({
        displayRef: `SURGE-${i}`,
        hasPriorRecord: false,
      });
      await repositories.encounters.create({
        patientRef: patient._id,
        displayRef: patient.displayRef,
        age: { ageYears: 40, band: AGE_BAND.ADULT },
        chiefComplaint: 'surge cohort',
        currentESI: ESI.URGENT,
        status: ENCOUNTER_STATUS.WAITING,
        arrivalAt: new Date(Date.now() - 5 * 60000),
        isSurgeCohort: true,
        queue: {},
      });
    }
  }

  it('declares surge and broadcasts the transition', async () => {
    await makeSurgeConditions();
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });

    const result = await engine.tick();

    assert.equal(result.surgeActive, true);
    const surgeEvent = io.events.find((e) => e.event === 'surge:state');
    assert.ok(surgeEvent);
    assert.equal(surgeEvent.payload.active, true);
    assert.equal(surgeEvent.payload.transition, 'entered');
  });

  it('never relaxes safe-wait minutes while surging', async () => {
    await makeSurgeConditions();
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });
    await engine.tick();

    const surgeEvent = io.events.find((e) => e.event === 'surge:state');
    const protocolDefaults = { 1: 0, 2: 10, 3: 30, 4: 60, 5: 120 };
    assert.deepEqual(surgeEvent.payload.policyApplied.safeWaitMinutes, protocolDefaults);
  });

  it('records the surge transition in the audit trail', async () => {
    await makeSurgeConditions();
    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });
    await engine.tick();

    const events = await repositories.auditEvents.find({ eventType: 'SURGE_STATE_CHANGED' });
    assert.equal(events.length, 1);
    assert.equal((await verifyAuditChain()).valid, true);
  });

  it('splits ESI 3 into sub-bands while surging and clears them once surge ends', async () => {
    await makeSurgeConditions();
    // A patient outside the surge cohort, so there is still someone to inspect
    // after the cohort is drained.
    const survivor = await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 5 });

    const io = fakeIo();
    // A short hysteresis so the test can observe a real exit without waiting out
    // the production-sized five-minute window.
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 50 });

    await engine.tick(); // enters surge

    const duringSurge = await repositories.encounters.findById(survivor._id);
    assert.ok(
      duringSurge.queue.surgeSubBand === '3A' || duringSurge.queue.surgeSubBand === '3B',
      'every ESI 3 patient must be sub-banded while surging',
    );

    // Drain the surge cohort so load returns to normal.
    await repositories.encounters.deleteMany({ isSurgeCohort: true });

    // Exiting surge deliberately takes two ticks below threshold: the first
    // starts the hysteresis clock, the second confirms load stayed down. A single
    // quiet moment after a burst is not the surge being over, and flapping would
    // change the dashboard mode under the nurse's hands.
    await engine.tick();
    assert.equal(engine.surgeState.state, 'surge', 'one quiet tick is not enough to stand down');

    await new Promise((resolve) => setTimeout(resolve, 70));
    await engine.tick();

    const surgeEndedEvent = io.events.find(
      (e) => e.event === 'surge:state' && e.payload.transition === 'exited',
    );
    assert.ok(surgeEndedEvent, 'surge must exit once load stays normalised, and say so');

    const afterSurge = await repositories.encounters.findById(survivor._id);
    assert.equal(
      afterSurge.queue.surgeSubBand,
      null,
      'a stale 3A/3B label must not linger on the dashboard once surge is over',
    );
  });

  it('marks assessments made during surge, so the policy in force is recoverable later', async () => {
    // The cadence arithmetic itself is covered in decay.test.js. What only the
    // engine can guarantee is that it actually propagates the surge verdict into
    // scoring — including in the same tick that surge was first detected.
    await makeSurgeConditions();
    await seedWaitingEncounter({ esi: ESI.URGENT, arrivedMinutesAgo: 25 }); // past the reassess ratio

    const io = fakeIo();
    const engine = new TriageEngine({ io, tickMs: 5000, exitHysteresisMs: 5 * 60000 });
    const result = await engine.tick();

    assert.equal(result.surgeActive, true);
    const assessments = await repositories.assessments.find({});
    assert.ok(assessments.length >= 1, 'the overdue patient should have been re-scored');
    assert.ok(
      assessments.every((a) => a.scoredDuringSurge === true),
      'surge policy must apply from the tick it is detected, not the one after',
    );
  });
});
