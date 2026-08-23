import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { connectDatabase, disconnectDatabase, repositories, resetDatabase } from '../src/db/index.js';
import {
  DEESCALATION_MIN_REASON_LENGTH,
  GENESIS_HASH,
  appendAuditEvent,
  canonicalJSON,
  recordOverride,
  verifyAuditChain,
} from '../src/services/auditService.js';
import { AGE_BAND, AUDIT_EVENT_TYPE, OVERRIDE_REASON, RETENTION_CLASS } from '../src/clinical/constants.js';

before(async () => connectDatabase());
after(async () => disconnectDatabase());
beforeEach(async () => resetDatabase());

const nurse = {
  _id: undefined,
  name: 'Priya R.',
  role: 'triage_nurse',
  registrationNumber: 'KA-NUR-88214',
  canOverride: true,
};

async function seedEncounter({ currentESI = 4 } = {}) {
  const patient = await repositories.patients.create({
    displayRef: 'P-2481',
    sex: 'male',
    preferredLanguage: 'kn-IN',
    hasPriorRecord: true,
  });

  const encounter = await repositories.encounters.create({
    patientRef: patient._id,
    displayRef: patient.displayRef,
    age: { ageYears: 58, band: AGE_BAND.ADULT },
    chiefComplaint: 'chest discomfort',
    currentESI,
    assignedBy: 'ai',
    currentConfidence: {
      score: 0.48,
      band: 'low',
      components: {
        completeness: 0.5,
        modelMargin: 0.4,
        inputReliability: 0.5,
        ageBandSupport: 0.95,
      },
      drivers: ['No oxygen saturation recorded'],
    },
  });

  const assessment = await repositories.assessments.create({
    encounterRef: encounter._id,
    patientRef: patient._id,
    sequence: 1,
    trigger: 'initial',
    mode: 'full',
    featureHash: 'a'.repeat(64),
    modelId: 'triagehandler-esi-xgb',
    modelVersion: '1.0.0',
    fusion: { finalESI: currentESI },
    confidence: encounter.currentConfidence,
    explainFlags: [],
  });

  return { patient, encounter, assessment };
}

const system = { name: 'TriageHandler queue engine', role: 'admin', registrationNumber: 'SYSTEM' };

describe('audit chain: tamper evidence', () => {
  it('links each event to its predecessor and starts from the genesis hash', async () => {
    const first = await appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.TRIAGE_ASSIGNED, actor: system });
    const second = await appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.TRIAGE_REASSESSED, actor: system });

    assert.equal(first.seq, 1);
    assert.equal(first.prevHash, GENESIS_HASH);
    assert.equal(second.seq, 2);
    assert.equal(second.prevHash, first.hash);
    assert.equal(first.hash.length, 64);
  });

  it('verifies an untouched chain', async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.TRIAGE_ASSIGNED, actor: system });
    }

    const result = await verifyAuditChain();
    assert.equal(result.valid, true);
    assert.equal(result.length, 5);
    assert.ok(result.headHash);
  });

  it('detects an event whose content was altered after the fact', async () => {
    const { encounter, assessment } = await seedEncounter();
    await appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.TRIAGE_ASSIGNED, actor: system });
    const target = await recordOverride({
      encounter,
      assessment,
      clinician: nurse,
      previousESI: 4,
      newESI: 2,
      reasonCode: OVERRIDE_REASON.CLINICAL_GESTALT,
      reasonText: 'Patient looks unwell.',
    });
    await appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.TRIAGE_REASSESSED, actor: system });

    assert.equal((await verifyAuditChain()).valid, true);

    // Someone edits the record to make the override look less dramatic.
    await repositories.auditEvents.updateById(target._id, { 'after.esi': 3 });

    const result = await verifyAuditChain();
    assert.equal(result.valid, false);
    assert.equal(result.failure, 'content_altered');
    assert.equal(result.brokenAt.seq, target.seq);
    assert.match(result.message, /altered since it was written/);
  });

  it('detects a removed event as a sequence gap', async () => {
    const events = [];
    for (let i = 0; i < 4; i += 1) {
      events.push(await appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.TRIAGE_ASSIGNED, actor: system }));
    }

    await repositories.auditEvents.deleteMany({ seq: events[1].seq });

    const result = await verifyAuditChain();
    assert.equal(result.valid, false);
    assert.equal(result.failure, 'sequence_gap');
  });

  it('detects a re-linked chain even when each event hashes correctly on its own', async () => {
    await appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.TRIAGE_ASSIGNED, actor: system });
    const second = await appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.TRIAGE_ASSIGNED, actor: system });

    await repositories.auditEvents.updateById(second._id, { prevHash: GENESIS_HASH });

    const result = await verifyAuditChain();
    assert.equal(result.valid, false);
    // The stored hash no longer matches content+prevHash, so this surfaces as an
    // alteration; either way the tampering is visible, which is the point.
    assert.ok(['broken_link', 'content_altered'].includes(result.failure));
  });

  it('produces a stable hash regardless of key ordering', () => {
    const a = canonicalJSON({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJSON({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    assert.equal(a, b);
  });

  it('keeps sequence numbers gap-free under concurrent appends', async () => {
    // Two nurses acting at the same moment must not fork the chain.
    const appends = Array.from({ length: 20 }, (_, i) =>
      appendAuditEvent({ eventType: AUDIT_EVENT_TYPE.ACCESS_PHI, actor: system, after: { i } }),
    );
    await Promise.all(appends);

    const result = await verifyAuditChain();
    assert.equal(result.valid, true);
    assert.equal(result.length, 20);
  });
});

describe('audit chain: what an override must record', () => {
  it('captures timestamp, original AI score, new manual score and structured reason', async () => {
    const { encounter, assessment } = await seedEncounter({ currentESI: 4 });

    const event = await recordOverride({
      encounter,
      assessment,
      clinician: nurse,
      previousESI: 4,
      newESI: 2,
      reasonCode: OVERRIDE_REASON.MODEL_MISSED_RED_FLAG,
      reasonText: 'Diaphoretic and grey on arrival; model did not weight appearance.',
      session: { sessionId: 'sess-1', workstation: 'TRIAGE-02' },
    });

    // When
    assert.ok(event.occurredAt instanceof Date);
    assert.ok(event.recordedAt instanceof Date);

    // What the machine said
    assert.equal(event.before.esi, 4);
    assert.equal(event.before.assignedBy, 'ai');
    assert.equal(event.before.confidence, 0.48);

    // What the human decided
    assert.equal(event.after.esi, 2);
    assert.equal(event.after.assignedBy, 'nurse');
    assert.equal(event.after.direction, 'escalation');
    assert.equal(event.after.levelsChanged, 2);

    // Why
    assert.equal(event.reasonCode, OVERRIDE_REASON.MODEL_MISSED_RED_FLAG);
    assert.match(event.reasonText, /Diaphoretic/);

    // Who, identifiably and licensed
    assert.equal(event.actor.name, 'Priya R.');
    assert.equal(event.actor.registrationNumber, 'KA-NUR-88214');
    assert.equal(event.actor.workstation, 'TRIAGE-02');

    // Enough to reconstruct what the AI was looking at, months later
    assert.equal(event.modelSnapshot.modelId, 'triagehandler-esi-xgb');
    assert.equal(event.modelSnapshot.modelVersion, '1.0.0');
    assert.equal(event.modelSnapshot.featureHash, 'a'.repeat(64));
    assert.equal(event.modelSnapshot.recommendedESI, 4);

    // DPDP fields
    assert.ok(event.lawfulBasis);
    assert.ok(event.purpose);
    assert.equal(event.retentionClass, RETENTION_CLASS.CLINICAL_AUDIT);
    assert.ok(event.retainUntil instanceof Date);
  });

  it('rejects an override with no structured reason code', async () => {
    const { encounter, assessment } = await seedEncounter();
    await assert.rejects(
      () =>
        recordOverride({
          encounter,
          assessment,
          clinician: nurse,
          previousESI: 4,
          newESI: 2,
          reasonCode: 'BECAUSE_I_SAID_SO',
          reasonText: 'no',
        }),
      /structured reason code/,
    );
  });

  it('rejects an override from a clinician with no registration number', async () => {
    const { encounter, assessment } = await seedEncounter();
    await assert.rejects(
      () =>
        recordOverride({
          encounter,
          assessment,
          clinician: { name: 'Anon', role: 'triage_nurse' },
          previousESI: 4,
          newESI: 2,
          reasonCode: OVERRIDE_REASON.CLINICAL_GESTALT,
        }),
      /registration number/,
    );
  });
});

describe('audit chain: override friction is asymmetric', () => {
  it('lets a clinician escalate in one action with no justification', async () => {
    const { encounter, assessment } = await seedEncounter({ currentESI: 4 });

    const event = await recordOverride({
      encounter,
      assessment,
      clinician: nurse,
      previousESI: 4,
      newESI: 2,
      reasonCode: OVERRIDE_REASON.CLINICAL_GESTALT,
      // No reasonText, no attestation.
    });

    assert.equal(event.after.direction, 'escalation');
  });

  it('refuses to de-escalate without a written justification', async () => {
    const { encounter, assessment } = await seedEncounter({ currentESI: 2 });

    await assert.rejects(
      () =>
        recordOverride({
          encounter,
          assessment,
          clinician: nurse,
          previousESI: 2,
          newESI: 4,
          reasonCode: OVERRIDE_REASON.PATIENT_APPEARS_WELL,
          reasonText: 'fine',
          assessmentAttested: true,
        }),
      new RegExp(`at least ${DEESCALATION_MIN_REASON_LENGTH} characters`),
    );
  });

  it('refuses to de-escalate without an assessment attestation', async () => {
    const { encounter, assessment } = await seedEncounter({ currentESI: 2 });

    await assert.rejects(
      () =>
        recordOverride({
          encounter,
          assessment,
          clinician: nurse,
          previousESI: 2,
          newESI: 4,
          reasonCode: OVERRIDE_REASON.PATIENT_APPEARS_WELL,
          reasonText: 'Reviewed at the bedside, patient is comfortable and ambulant.',
          assessmentAttested: false,
        }),
      /attestation that you have assessed the patient/,
    );
  });

  it('permits a de-escalation that is properly justified and attested', async () => {
    const { encounter, assessment } = await seedEncounter({ currentESI: 2 });

    const event = await recordOverride({
      encounter,
      assessment,
      clinician: nurse,
      previousESI: 2,
      newESI: 4,
      reasonCode: OVERRIDE_REASON.VITALS_UNRELIABLE,
      reasonText: 'Repeat manual BP 128/78; original reading taken on a miscuffed arm.',
      assessmentAttested: true,
    });

    assert.equal(event.after.direction, 'de_escalation');
    assert.equal(event.assessmentAttested, true);
    assert.equal((await verifyAuditChain()).valid, true);
  });
});
