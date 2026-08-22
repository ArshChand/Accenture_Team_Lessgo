import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connectDatabase, disconnectDatabase, repositories, resetDatabase } from '../src/db/index.js';
import { AGE_BAND, ENCOUNTER_STATUS, SOURCE } from '../src/clinical/constants.js';
import { measured, nlpObservation, selfReported } from '../src/clinical/observation.js';

/**
 * These tests pin the guarantee the whole prototype leans on: the in-memory driver
 * is not a loose stand-in for MongoDB. It enforces the same schema, the same enums,
 * the same unique indexes and the same query semantics, so behaviour verified here
 * is behaviour that holds against a real database.
 */

before(async () => {
  await connectDatabase();
});

after(async () => {
  await disconnectDatabase();
});

const makePatient = (overrides = {}) => ({
  displayRef: 'P-0001',
  sex: 'female',
  preferredLanguage: 'kn-IN',
  hasPriorRecord: true,
  ...overrides,
});

describe('repository: schema enforcement', () => {
  it('applies schema defaults on create', async () => {
    await resetDatabase();
    const patient = await repositories.patients.create(makePatient());

    assert.equal(patient.hasPriorRecord, true);
    assert.deepEqual(patient.allergies, []);
    assert.ok(patient._id, 'expected an _id to be generated');
    assert.ok(patient.createdAt instanceof Date, 'expected timestamps to be applied');
  });

  it('rejects a value outside an enum', async () => {
    await resetDatabase();
    await assert.rejects(
      () => repositories.patients.create(makePatient({ sex: 'not-a-value' })),
      (error) => error.name === 'ValidationError',
    );
  });

  it('rejects a document missing a required field', async () => {
    await resetDatabase();
    await assert.rejects(
      () => repositories.encounters.create({ chiefComplaint: 'chest pain' }),
      (error) => error.name === 'ValidationError',
    );
  });

  it('enforces unique indexes the way MongoDB would', async () => {
    await resetDatabase();
    await repositories.patients.create(makePatient({ displayRef: 'P-1234' }));

    await assert.rejects(
      () => repositories.patients.create(makePatient({ displayRef: 'P-1234' })),
      (error) => error.code === 11000,
    );
  });

  it('casts values to their schema type', async () => {
    await resetDatabase();
    const patient = await repositories.patients.create(
      makePatient({ dateOfBirth: '1958-04-11T00:00:00.000Z' }),
    );
    assert.ok(patient.dateOfBirth instanceof Date, 'expected the string to be cast to a Date');
  });

  it('derives observation reliability from its source', async () => {
    await resetDatabase();
    const patient = await repositories.patients.create(makePatient());
    const encounter = await repositories.encounters.create({
      patientRef: patient._id,
      displayRef: patient.displayRef,
      age: { ageYears: 58, band: AGE_BAND.ADULT },
      chiefComplaint: 'chest pain',
    });

    const vitals = await repositories.vitals.create({
      encounterRef: encounter._id,
      patientRef: patient._id,
      heartRate: measured(112),
      painScore: selfReported(3),
      spo2: nlpObservation(94, { asrConfidence: 0.5, extractionConfidence: 0.8 }),
    });

    assert.equal(vitals.heartRate.reliability, 1.0);
    assert.equal(vitals.painScore.reliability, 0.6);
    assert.equal(vitals.spo2.reliability, 0.4, 'NLP reliability is ASR x extraction');
  });

  it('refuses a clinical value that arrives without a stated reliability', async () => {
    await resetDatabase();
    const patient = await repositories.patients.create(makePatient());
    const encounter = await repositories.encounters.create({
      patientRef: patient._id,
      displayRef: patient.displayRef,
      age: { ageYears: 58, band: AGE_BAND.ADULT },
      chiefComplaint: 'chest pain',
    });

    await assert.rejects(
      () =>
        repositories.vitals.create({
          encounterRef: encounter._id,
          patientRef: patient._id,
          // Constructed by hand rather than via the helpers: no provenance weight.
          heartRate: { value: 112, source: SOURCE.MEASURED },
        }),
      (error) => error.name === 'ValidationError',
    );
  });
});

describe('repository: query semantics', () => {
  const seedEncounters = async () => {
    await resetDatabase();
    const patient = await repositories.patients.create(makePatient());

    const rows = [
      { esi: 2, priority: 4300, status: ENCOUNTER_STATUS.WAITING, ref: 'P-0002' },
      { esi: 3, priority: 3100, status: ENCOUNTER_STATUS.WAITING, ref: 'P-0003' },
      { esi: 5, priority: 1050, status: ENCOUNTER_STATUS.WAITING, ref: 'P-0004' },
      { esi: 1, priority: 5000, status: ENCOUNTER_STATUS.IN_TREATMENT, ref: 'P-0005' },
    ];

    for (const row of rows) {
      await repositories.encounters.create({
        patientRef: patient._id,
        displayRef: row.ref,
        age: { ageYears: 40, band: AGE_BAND.ADULT },
        chiefComplaint: 'test',
        currentESI: row.esi,
        status: row.status,
        queue: { priorityScore: row.priority },
      });
    }
    return patient;
  };

  it('filters on a dotted path and sorts descending', async () => {
    await seedEncounters();
    const waiting = await repositories.encounters.find(
      { status: ENCOUNTER_STATUS.WAITING },
      { sort: { 'queue.priorityScore': -1 } },
    );

    assert.equal(waiting.length, 3);
    assert.deepEqual(
      waiting.map((e) => e.displayRef),
      ['P-0002', 'P-0003', 'P-0004'],
    );
  });

  it('supports $in, $lte and $ne', async () => {
    await seedEncounters();

    const urgent = await repositories.encounters.find({ currentESI: { $in: [1, 2] } });
    assert.equal(urgent.length, 2);

    const lowPriority = await repositories.encounters.find({ 'queue.priorityScore': { $lte: 3100 } });
    assert.equal(lowPriority.length, 2);

    const notWaiting = await repositories.encounters.find({ status: { $ne: ENCOUNTER_STATUS.WAITING } });
    assert.equal(notWaiting.length, 1);
    assert.equal(notWaiting[0].displayRef, 'P-0005');
  });

  it('supports $exists and $or', async () => {
    await seedEncounters();

    const withBreach = await repositories.encounters.find({ 'queue.breachedAt': { $exists: true } });
    assert.equal(withBreach.length, 0);

    const either = await repositories.encounters.find({
      $or: [{ currentESI: 1 }, { currentESI: 5 }],
    });
    assert.equal(either.length, 2);
  });

  it('honours limit and skip', async () => {
    await seedEncounters();
    const page = await repositories.encounters.find(
      { status: ENCOUNTER_STATUS.WAITING },
      { sort: { 'queue.priorityScore': -1 }, skip: 1, limit: 1 },
    );
    assert.equal(page.length, 1);
    assert.equal(page[0].displayRef, 'P-0003');
  });

  it('throws on an unsupported operator rather than silently mismatching', async () => {
    await seedEncounters();
    await assert.rejects(
      () => repositories.encounters.find({ currentESI: { $where: 'this.currentESI > 2' } }),
      /Unsupported query operator/,
    );
  });
});

describe('repository: updates and isolation', () => {
  const createOne = async () => {
    await resetDatabase();
    const patient = await repositories.patients.create(makePatient());
    return repositories.encounters.create({
      patientRef: patient._id,
      displayRef: patient.displayRef,
      age: { ageYears: 58, band: AGE_BAND.ADULT },
      chiefComplaint: 'chest pain',
      currentESI: 3,
      queue: { priorityScore: 3000, reassessCount: 0 },
    });
  };

  it('updates a dotted path without clobbering its siblings', async () => {
    const encounter = await createOne();
    const updated = await repositories.encounters.updateById(encounter._id, {
      'queue.priorityScore': 4200,
    });

    assert.equal(updated.queue.priorityScore, 4200);
    assert.equal(updated.queue.reassessCount, 0, 'sibling field should survive the update');
    assert.equal(updated.currentESI, 3);
  });

  it('supports $inc', async () => {
    const encounter = await createOne();
    const updated = await repositories.encounters.updateById(encounter._id, {
      $inc: { 'queue.reassessCount': 1 },
    });
    assert.equal(updated.queue.reassessCount, 1);
  });

  it('revalidates against the schema on update', async () => {
    const encounter = await createOne();
    await assert.rejects(
      () => repositories.encounters.updateById(encounter._id, { currentESI: 9 }),
      (error) => error.name === 'ValidationError',
    );
  });

  it('returns deep copies so a caller cannot mutate the store', async () => {
    const encounter = await createOne();

    const first = await repositories.encounters.findById(encounter._id);
    first.queue.priorityScore = 999999;
    first.chiefComplaint = 'mutated';

    const second = await repositories.encounters.findById(encounter._id);
    assert.equal(second.queue.priorityScore, 3000);
    assert.equal(second.chiefComplaint, 'chest pain');
  });

  it('returns null when updating a document that does not exist', async () => {
    await resetDatabase();
    const patient = await repositories.patients.create(makePatient());
    const result = await repositories.encounters.updateById(patient._id, { currentESI: 2 });
    assert.equal(result, null);
  });

  it('rejects a mix of a plain field and an operator in one update, rather than silently dropping the plain field', async () => {
    const encounter = await createOne();

    // This shape once passed silently: normalizeUpdate saw the $inc key, assumed
    // the whole object was already in operator form, and 'queue.reassessCount'
    // — sorry, 'queue.lastReassessedAt' here — was dropped without error, which
    // is exactly how a wait-clock reset went missing in production.
    await assert.rejects(
      () =>
        repositories.encounters.updateById(encounter._id, {
          'queue.reassessCount': 1,
          $inc: { 'queue.priorityScore': 1 },
        }),
      /Cannot mix a plain field with an update operator/,
    );

    // The correct form still works.
    const updated = await repositories.encounters.updateById(encounter._id, {
      $set: { 'queue.reassessCount': 1 },
      $inc: { 'queue.priorityScore': 1 },
    });
    assert.equal(updated.queue.reassessCount, 1);
    assert.equal(updated.queue.priorityScore, 3001);
  });
});
