import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { connectDatabase, disconnectDatabase, repositories, resetDatabase } from '../src/db/index.js';
import { applyDisposition, WAITING_STATUSES } from '../src/services/triageService.js';
import { verifyAuditChain } from '../src/services/auditService.js';
import { AGE_BAND, AUDIT_EVENT_TYPE, ENCOUNTER_STATUS } from '../src/clinical/constants.js';

before(async () => connectDatabase());
after(async () => disconnectDatabase());
beforeEach(async () => resetDatabase());

/**
 * Clearing a patient off the board.
 *
 * The claims worth asserting are the ones a reviewer could disagree with out
 * loud: that removing someone from the queue always leaves a named trail, that
 * closing an encounter on a patient the assistant still calls critical costs
 * more than closing one on a patient it calls well, and that a failed
 * disposition leaves the patient exactly where they were.
 */

async function seedEncounter({ currentESI = 4, status = ENCOUNTER_STATUS.WAITING } = {}) {
  const patient = await repositories.patients.create({
    displayRef: 'P-2481',
    sex: 'female',
    preferredLanguage: 'en-IN',
    hasPriorRecord: true,
  });

  const encounter = await repositories.encounters.create({
    patientRef: patient._id,
    displayRef: patient.displayRef,
    age: { ageYears: 58, band: AGE_BAND.ADULT },
    chiefComplaint: 'chest discomfort',
    currentESI,
    assignedBy: 'ai',
    status,
    queue: { safeWaitMinutes: 30, decayStatus: 'amber', lastInformedAt: new Date(Date.now() - 42 * 60000) },
  });

  return { patient, encounter };
}

async function seedNurse() {
  return repositories.clinicians.create({
    name: 'Priya R.',
    role: 'triage_nurse',
    registrationNumber: 'KA-NUR-88214',
    canOverride: true,
    active: true,
  });
}

describe('disposition: clearing a patient from the queue', () => {
  it('takes a patient into treatment and removes them from the waiting statuses', async () => {
    const { encounter } = await seedEncounter();
    const nurse = await seedNurse();

    const result = await applyDisposition({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      status: ENCOUNTER_STATUS.IN_TREATMENT,
    });

    assert.equal(result.encounter.status, ENCOUNTER_STATUS.IN_TREATMENT);
    assert.ok(!WAITING_STATUSES.includes(result.encounter.status));
  });

  it('records who cleared the patient, at what severity, and after how long', async () => {
    const { encounter } = await seedEncounter({ currentESI: 3 });
    const nurse = await seedNurse();

    const { auditEvent, waitedMinutes } = await applyDisposition({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      status: ENCOUNTER_STATUS.IN_TREATMENT,
    });

    assert.equal(auditEvent.eventType, AUDIT_EVENT_TYPE.ENCOUNTER_STATUS_CHANGED);
    assert.equal(auditEvent.actor.registrationNumber, 'KA-NUR-88214');
    assert.equal(auditEvent.before.status, ENCOUNTER_STATUS.WAITING);
    assert.equal(auditEvent.before.esi, 3);
    assert.equal(auditEvent.after.status, ENCOUNTER_STATUS.IN_TREATMENT);

    // The waited figure has to be captured at disposition: once the encounter
    // leaves the queue its decay state stops updating and this is unrecoverable.
    assert.equal(auditEvent.after.waitedMinutes, 42);
    assert.equal(waitedMinutes, 42);

    const chain = await verifyAuditChain();
    assert.equal(chain.valid, true);
  });

  it('refuses to discharge a patient the assistant still scores ESI 2 without a written reason', async () => {
    const { encounter } = await seedEncounter({ currentESI: 2 });
    const nurse = await seedNurse();

    await assert.rejects(
      applyDisposition({
        encounterId: encounter._id,
        clinicianId: nurse._id,
        status: ENCOUNTER_STATUS.DISCHARGED,
      }),
      /ESI 2/,
    );

    // The refusal must leave the patient on the board, not half-cleared.
    const untouched = await repositories.encounters.findById(encounter._id);
    assert.equal(untouched.status, ENCOUNTER_STATUS.WAITING);

    const events = await repositories.auditEvents.find({});
    assert.equal(events.length, 0);
  });

  it('allows the same discharge once a reason is given', async () => {
    const { encounter } = await seedEncounter({ currentESI: 2 });
    const nurse = await seedNurse();

    const { encounter: cleared, auditEvent } = await applyDisposition({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      status: ENCOUNTER_STATUS.DISCHARGED,
      reasonText: 'Reviewed by ED consultant, ECG and troponin normal, discharged with GP follow-up.',
    });

    assert.equal(cleared.status, ENCOUNTER_STATUS.DISCHARGED);
    assert.match(auditEvent.reasonText, /troponin/);
  });

  it('discharges a low-acuity patient without demanding a reason', async () => {
    const { encounter } = await seedEncounter({ currentESI: 5 });
    const nurse = await seedNurse();

    const { encounter: cleared } = await applyDisposition({
      encounterId: encounter._id,
      clinicianId: nurse._id,
      status: ENCOUNTER_STATUS.DISCHARGED,
    });

    assert.equal(cleared.status, ENCOUNTER_STATUS.DISCHARGED);
  });

  it('always demands a reason for left-without-being-seen, whatever the severity', async () => {
    const { encounter } = await seedEncounter({ currentESI: 5 });
    const nurse = await seedNurse();

    await assert.rejects(
      applyDisposition({
        encounterId: encounter._id,
        clinicianId: nurse._id,
        status: ENCOUNTER_STATUS.LEFT_WITHOUT_BEING_SEEN,
        reasonText: 'gone',
      }),
      /at least 20 characters/,
    );
  });

  it('rejects a status that would not clear the queue', async () => {
    const { encounter } = await seedEncounter();
    const nurse = await seedNurse();

    await assert.rejects(
      applyDisposition({
        encounterId: encounter._id,
        clinicianId: nurse._id,
        status: ENCOUNTER_STATUS.WAITING,
      }),
      /must be one of/,
    );
  });

  it('refuses to clear an encounter that has already left the queue', async () => {
    const { encounter } = await seedEncounter({ status: ENCOUNTER_STATUS.DISCHARGED });
    const nurse = await seedNurse();

    await assert.rejects(
      applyDisposition({
        encounterId: encounter._id,
        clinicianId: nurse._id,
        status: ENCOUNTER_STATUS.IN_TREATMENT,
      }),
      /already left the queue/,
    );
  });

  it('will not clear a patient on behalf of an unknown clinician', async () => {
    const { encounter, patient } = await seedEncounter();

    await assert.rejects(
      applyDisposition({
        encounterId: encounter._id,
        clinicianId: patient._id,
        status: ENCOUNTER_STATUS.IN_TREATMENT,
      }),
      /Clinician not found/,
    );

    const untouched = await repositories.encounters.findById(encounter._id);
    assert.equal(untouched.status, ENCOUNTER_STATUS.WAITING);
  });
});
