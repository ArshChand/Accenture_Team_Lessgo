import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { connectDatabase, disconnectDatabase, repositories, resetDatabase } from '../src/db/index.js';
import { activateProtocol, clearProtocolCache } from '../src/services/protocolService.js';
import { scoreAndPersist } from '../src/services/triageService.js';
import { AGE_BAND, ENCOUNTER_STATUS, TRIAGE_TRIGGER } from '../src/clinical/constants.js';

/**
 * Scoring a patient the instant they register — before any vitals exist —
 * means the very first standing ESI is often a pure uncertainty escalation,
 * not a real assessment of anything measured. `firstRealAssessment` exists so
 * that when real vitals arrive for the first time, the escalate-only ratchet
 * doesn't mistake that uncertainty guess for a clinical decision worth
 * protecting from correction. Without it, seeding a genuinely low-acuity
 * patient with no data, then giving them normal vitals, would leave them
 * stuck at the uncertainty-driven ESI forever — exactly the regression this
 * file exists to catch.
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

async function seedFreshEncounter({ chiefComplaint = 'ankle pain after a fall', currentESI } = {}) {
  const patient = await repositories.patients.create({
    displayRef: `P-${Math.floor(Math.random() * 1e6)}`,
    hasPriorRecord: false,
  });
  return repositories.encounters.create({
    patientRef: patient._id,
    displayRef: patient.displayRef,
    age: { ageYears: 30, band: AGE_BAND.ADULT },
    chiefComplaint,
    ...(currentESI !== undefined && { currentESI, assignedBy: 'ai' }),
    status: ENCOUNTER_STATUS.WAITING,
    queue: {},
  });
}

const NORMAL_ADULT_VITALS = {
  heartRate: { value: 76, source: 'measured', reliability: 1.0 },
  respiratoryRate: { value: 16, source: 'measured', reliability: 1.0 },
  systolicBP: { value: 118, source: 'measured', reliability: 1.0 },
  spo2: { value: 98, source: 'measured', reliability: 1.0 },
  temperatureC: { value: 37.0, source: 'measured', reliability: 1.0 },
  gcs: { value: 15, source: 'measured', reliability: 1.0 },
  painScore: { value: 1, source: 'patient_reported', reliability: 0.6 },
};

describe('scoring a patient with nothing yet known', () => {
  it('escalates on uncertainty alone when registered with zero vitals', async () => {
    const encounter = await seedFreshEncounter();
    const result = await scoreAndPersist({ encounter, vitals: {}, trigger: TRIAGE_TRIGGER.INITIAL });

    assert.ok(Number.isFinite(result.encounter.currentESI), 'a newly registered patient must not sit unscored');
    assert.equal(result.encounter.currentESI, result.fusion.finalESI);
    assert.equal(result.confidence.band, 'low', 'zero data should read as low confidence, not a false positive');
  });
});

describe('the first real vitals correct an uncertainty-driven guess, in either direction', () => {
  it('lets a genuinely low-acuity first assessment lower the uncertainty-inflated ESI', async () => {
    let encounter = await seedFreshEncounter();
    const initial = await scoreAndPersist({ encounter, vitals: {}, trigger: TRIAGE_TRIGGER.INITIAL });
    encounter = initial.encounter;

    const informed = await scoreAndPersist({
      encounter,
      vitals: NORMAL_ADULT_VITALS,
      trigger: TRIAGE_TRIGGER.VITALS_CHANGE,
      firstRealAssessment: true,
    });

    assert.equal(
      informed.encounter.currentESI,
      informed.fusion.finalESI,
      'the first real vitals must be free to set the standing ESI to whatever they actually show, not just downward-blocked',
    );
    assert.ok(
      informed.encounter.currentESI > initial.encounter.currentESI,
      `expected the informed score (${informed.encounter.currentESI}) to be less urgent than the ` +
        `uncertainty guess (${initial.encounter.currentESI}) once normal vitals were actually recorded`,
    );
  });

  it('still lets the first real vitals escalate, if that is what they show', async () => {
    let encounter = await seedFreshEncounter({ chiefComplaint: 'feeling generally unwell' });
    const initial = await scoreAndPersist({ encounter, vitals: {}, trigger: TRIAGE_TRIGGER.INITIAL });
    encounter = initial.encounter;

    const informed = await scoreAndPersist({
      encounter,
      vitals: {
        heartRate: { value: 138, source: 'measured', reliability: 1.0 },
        systolicBP: { value: 78, source: 'measured', reliability: 1.0 },
        spo2: { value: 88, source: 'measured', reliability: 1.0 },
      },
      trigger: TRIAGE_TRIGGER.VITALS_CHANGE,
      firstRealAssessment: true,
    });

    assert.ok(
      informed.encounter.currentESI <= initial.encounter.currentESI,
      'shock-range vitals on the first real reading must be free to escalate too, not just de-escalate',
    );
  });
});

describe('a patient already carrying a real, vitals-informed assessment', () => {
  it('keeps the escalate-only ratchet once a real assessment already exists', async () => {
    // ESI 2, already assigned from a prior, genuine assessment — not the
    // uncertainty placeholder this file is otherwise about.
    const encounter = await seedFreshEncounter({ currentESI: 2 });

    const rescored = await scoreAndPersist({
      encounter,
      vitals: NORMAL_ADULT_VITALS,
      trigger: TRIAGE_TRIGGER.VITALS_CHANGE,
      // firstRealAssessment omitted — this is an ordinary subsequent re-score.
    });

    assert.equal(
      rescored.encounter.currentESI,
      2,
      'an automated re-score must still never walk back a real standing assessment on its own',
    );
    assert.equal(
      rescored.encounter.aiRecommendedESI,
      rescored.fusion.finalESI,
      "the assistant's new opinion is always recorded, even when not applied",
    );
  });
});
