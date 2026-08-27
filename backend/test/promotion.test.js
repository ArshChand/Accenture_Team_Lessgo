import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { connectDatabase, disconnectDatabase, repositories, resetDatabase } from '../src/db/index.js';
import { applyQueuePromotion } from '../src/services/triageService.js';
import { verifyAuditChain } from '../src/services/auditService.js';
import { computeQueueState, MANUAL_PROMOTION_BONUS } from '../src/queue/decay.js';
import { getActiveProtocol } from '../src/services/protocolService.js';
import { AGE_BAND, AUDIT_EVENT_TYPE, ENCOUNTER_STATUS, PROMOTION_REASON } from '../src/clinical/constants.js';

before(async () => connectDatabase());
after(async () => disconnectDatabase());
beforeEach(async () => resetDatabase());

/**
 * Manual queue promotion.
 *
 * The claim being tested is narrow and worth stating plainly: a nurse can move a
 * patient to the front of the queue, cannot move anyone backwards, and cannot
 * change what the record says about how sick a patient is. Everything else here
 * follows from those three.
 */

async function seedEncounter({ currentESI = 4, status = ENCOUNTER_STATUS.WAITING, displayRef = 'P-2481' } = {}) {
  const patient = await repositories.patients.create({
    displayRef,
    sex: 'female',
    preferredLanguage: 'en-IN',
    hasPriorRecord: true,
  });

  return repositories.encounters.create({
    patientRef: patient._id,
    displayRef,
    age: { ageYears: 40, band: AGE_BAND.ADULT },
    chiefComplaint: 'abdominal pain',
    currentESI,
    assignedBy: 'ai',
    status,
    queue: { safeWaitMinutes: 60, decayStatus: 'green', lastInformedAt: new Date(Date.now() - 12 * 60000) },
  });
}

async function seedNurse() {
  return repositories.clinicians.create({
    name: 'Nurse Priya R.',
    role: 'triage_nurse',
    registrationNumber: 'KA-NUR-88214',
    canOverride: true,
    active: true,
  });
}

describe('manual queue promotion', () => {
  it('lifts a promoted patient above every unpromoted one, whatever their severity', async () => {
    const protocol = getActiveProtocol();

    // The hardest case for the ordering: a promoted ESI 5 against a fresh ESI 1.
    const promotedLowAcuity = computeQueueState({
      encounter: {
        currentESI: 5,
        arrivalAt: new Date(),
        age: { band: AGE_BAND.ADULT },
        queue: { manualPromotion: { reasonCode: PROMOTION_REASON.VISIBLE_DETERIORATION } },
      },
      protocol,
    });
    const untouchedCritical = computeQueueState({
      encounter: { currentESI: 1, arrivalAt: new Date(), age: { band: AGE_BAND.ADULT }, queue: {} },
      protocol,
    });

    assert.ok(
      promotedLowAcuity.priorityScore > untouchedCritical.priorityScore,
      'a nurse promotion has to win, or it is not a promotion',
    );
  });

  it('still ranks promoted patients against each other by severity', async () => {
    const protocol = getActiveProtocol();
    const base = { arrivalAt: new Date(), age: { band: AGE_BAND.ADULT } };
    const promotion = { manualPromotion: { reasonCode: PROMOTION_REASON.CLINICAL_GESTALT } };

    const sick = computeQueueState({ encounter: { ...base, currentESI: 1, queue: promotion }, protocol });
    const less = computeQueueState({ encounter: { ...base, currentESI: 4, queue: promotion }, protocol });

    // Promotion moves patients to the front; it must not flatten the front.
    assert.ok(sick.priorityScore > less.priorityScore);
  });

  it('cannot be reached by ordinary scoring, however long someone waits', async () => {
    const protocol = getActiveProtocol();
    const worstCase = computeQueueState({
      encounter: {
        currentESI: 1,
        arrivalAt: new Date(Date.now() - 48 * 3600 * 1000),
        age: { band: AGE_BAND.NEONATE },
        queue: { safeWaitMinutes: 1, lastInformedAt: new Date(Date.now() - 48 * 3600 * 1000) },
      },
      protocol,
    });

    assert.ok(worstCase.priorityScore < MANUAL_PROMOTION_BONUS);
  });

  it('records who promoted whom, and why', async () => {
    const encounter = await seedEncounter({ currentESI: 4 });
    const nurse = await seedNurse();

    const { auditEvent, promoted } = await applyQueuePromotion({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      reasonCode: PROMOTION_REASON.VISIBLE_DETERIORATION,
      reasonText: 'Grey and clammy in the waiting room, looks worse than on arrival.',
    });

    assert.equal(promoted, true);
    assert.equal(auditEvent.eventType, AUDIT_EVENT_TYPE.QUEUE_MANUAL_PROMOTION);
    assert.equal(auditEvent.actor.registrationNumber, 'KA-NUR-88214');
    assert.equal(auditEvent.reasonCode, PROMOTION_REASON.VISIBLE_DETERIORATION);
    assert.equal(auditEvent.after.action, 'promoted');
    assert.equal(auditEvent.before.promoted, false);
    assert.equal(auditEvent.after.waitedMinutes, 12);

    const chain = await verifyAuditChain();
    assert.equal(chain.valid, true);
  });

  it('does not change the recorded severity — position is not a clinical claim', async () => {
    const encounter = await seedEncounter({ currentESI: 4 });
    const nurse = await seedNurse();

    const { encounter: after } = await applyQueuePromotion({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      reasonCode: PROMOTION_REASON.CLINICAL_GESTALT,
    });

    assert.equal(after.currentESI, 4, 'promotion must not silently re-score the patient');
    assert.equal(after.assignedBy, 'ai', 'and must not claim a clinician assigned the severity');
    assert.ok(after.queue.manualPromotion);
    assert.ok(after.queue.priorityScore > MANUAL_PROMOTION_BONUS);
  });

  it('refuses a promotion with no structured reason', async () => {
    const encounter = await seedEncounter();
    const nurse = await seedNurse();

    await assert.rejects(
      applyQueuePromotion({ encounterId: encounter._id, clinicianId: nurse._id, reasonCode: 'BECAUSE' }),
      /needs one of/,
    );

    const untouched = await repositories.encounters.findById(encounter._id);
    assert.equal(untouched.queue.manualPromotion ?? null, null);
    assert.equal((await repositories.auditEvents.find({})).length, 0);
  });

  it('refuses to promote a patient who is already promoted', async () => {
    const encounter = await seedEncounter();
    const nurse = await seedNurse();
    const args = {
      encounterId: encounter._id,
      clinicianId: nurse._id,
      reasonCode: PROMOTION_REASON.CLINICAL_GESTALT,
    };

    await applyQueuePromotion(args);
    await assert.rejects(applyQueuePromotion(args), /already at the front/);
  });

  it('demands a written reason to release a promotion, and holds until one is given', async () => {
    const encounter = await seedEncounter();
    const nurse = await seedNurse();

    await applyQueuePromotion({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      reasonCode: PROMOTION_REASON.FAMILY_OR_STAFF_ESCALATION,
    });

    // Releasing sends a patient a clinician judged urgent back to waiting, so it
    // costs more than the promotion did.
    await assert.rejects(
      applyQueuePromotion({
        encounterId: encounter._id,
        clinicianId: nurse._id,
        release: true,
        reasonText: 'fine now',
      }),
      /at least 20 characters/,
    );

    const stillPromoted = await repositories.encounters.findById(encounter._id);
    assert.ok(stillPromoted.queue.manualPromotion);

    const { promoted } = await applyQueuePromotion({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      release: true,
      reasonText: 'Reviewed at the bedside, settled and comfortable, safe to wait normally.',
    });
    assert.equal(promoted, false);
  });

  it('returns a released patient to their computed position, never below it', async () => {
    const encounter = await seedEncounter({ currentESI: 3 });
    const nurse = await seedNurse();
    const protocol = getActiveProtocol();

    const expected = computeQueueState({
      encounter: await repositories.encounters.findById(encounter._id),
      protocol,
    });

    await applyQueuePromotion({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      reasonCode: PROMOTION_REASON.CLINICAL_GESTALT,
    });
    const { encounter: released } = await applyQueuePromotion({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      release: true,
      reasonText: 'Assessed at the bedside and stable; returning to the computed order.',
    });

    assert.equal(released.queue.manualPromotion ?? null, null);
    assert.equal(released.queue.priorityScore, expected.priorityScore);
  });

  it('refuses to reorder a patient who has already left the queue', async () => {
    const encounter = await seedEncounter({ status: ENCOUNTER_STATUS.DISCHARGED });
    const nurse = await seedNurse();

    await assert.rejects(
      applyQueuePromotion({
        encounterId: encounter._id,
        clinicianId: nurse._id,
        reasonCode: PROMOTION_REASON.CLINICAL_GESTALT,
      }),
      /already left the queue/,
    );
  });

  it('will not promote on behalf of an unknown clinician', async () => {
    const encounter = await seedEncounter();

    await assert.rejects(
      applyQueuePromotion({
        encounterId: encounter._id,
        clinicianId: encounter.patientRef,
        reasonCode: PROMOTION_REASON.CLINICAL_GESTALT,
      }),
      /Clinician not found/,
    );
  });
});
