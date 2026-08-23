import { createHash } from 'node:crypto';
import { config } from '../config/index.js';
import { repositories } from '../db/index.js';
import {
  AUDIT_EVENT_TYPE,
  LAWFUL_BASIS,
  OVERRIDE_REASONS,
  RETENTION_CLASS,
} from '../clinical/constants.js';

/**
 * Append-only, tamper-evident audit log.
 *
 * Jurisdiction: India — Digital Personal Data Protection Act 2023, read with the
 * ABDM Health Data Management Policy.
 *
 * Three properties, each of which exists because an audit log that lacks it is
 * not evidence of anything:
 *
 * **Append-only.** There is no update path and no delete path in this module, and
 * no route exposes one. A mistake is corrected by appending a CORRECTION event
 * that references the original. An audit trail that can be edited records only
 * what someone was last willing to admit.
 *
 * **Tamper-evident.** Each event stores the hash of its predecessor, so altering
 * any historical event invalidates every hash after it. `verifyAuditChain` walks
 * the chain and names the first break. Sequence numbers are gap-free, so a
 * deletion is as visible as an edit.
 *
 * **Complete enough to reconstruct the decision.** An override records not only
 * what the clinician chose but what the machine had recommended, which model
 * version produced it, and the hash of the exact feature vector it saw. Months
 * later, in a morbidity review, "the AI said 4 and the nurse said 2" is only
 * useful if you can also establish what the AI was looking at.
 */

export const GENESIS_HASH = '0'.repeat(64);

/** Minimum justification for making a patient *less* urgent. */
export const DEESCALATION_MIN_REASON_LENGTH = 20;

const RETENTION_YEARS = {
  [RETENTION_CLASS.CLINICAL_AUDIT]: config.compliance.auditRetentionYears,
  [RETENTION_CLASS.ACCESS_LOG]: 3,
  [RETENTION_CLASS.OPERATIONAL]: 1,
};

/**
 * Deterministic serialisation. Object key order must not affect the hash, or the
 * chain would break on a harmless change to how a document happens to be built.
 */
export function canonicalJSON(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;

  if (typeof value === 'object') {
    // ObjectId and similar wrapper types serialise by their string form.
    if (typeof value.toHexString === 'function') return JSON.stringify(value.toHexString());
    if (typeof value !== 'object') return JSON.stringify(value);

    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

/**
 * Fields covered by the hash chain.
 *
 * Declared explicitly rather than hashing "every field except `hash`". The
 * difference matters: the persistence layer normalises documents on the way in
 * (an empty sub-object is dropped, a default is filled, a string becomes a Date),
 * so a hash taken over the in-memory draft would not reproduce from the stored
 * document and every chain would verify as tampered. An explicit list is stable
 * across that normalisation, and it also states plainly what the chain does and
 * does not attest to — which is the more useful property when someone is relying
 * on this as evidence.
 *
 * Storage-assigned fields (`_id`, `__v`) are excluded because they are not
 * clinical content. Everything a reviewer would care about is here.
 */
export const HASHED_FIELDS = Object.freeze([
  'seq',
  'eventType',
  'actor',
  'subject',
  'before',
  'after',
  'reasonCode',
  'reasonText',
  'assessmentAttested',
  'modelSnapshot',
  'occurredAt',
  'recordedAt',
  'lawfulBasis',
  'purpose',
  'consentRef',
  'retentionClass',
  'retainUntil',
  'prevHash',
]);

/**
 * Collapse the differences that storage introduces but that carry no meaning:
 * absent, null and empty-object are all "nothing was recorded here".
 */
function normaliseForHash(value) {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === 'function') return value.toHexString();

  if (Array.isArray(value)) {
    const items = value.map(normaliseForHash).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalised = normaliseForHash(nested);
      if (normalised !== undefined) out[key] = normalised;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return value;
}

/** The content the chain attests to, in a form independent of how it was stored. */
export function auditHashPayload(event) {
  const payload = {};
  for (const field of HASHED_FIELDS) {
    const normalised = normaliseForHash(event[field]);
    if (normalised !== undefined) payload[field] = normalised;
  }
  return payload;
}

/** The chain link: sha256 over the event's declared content plus its predecessor's hash. */
export function computeEventHash(event, prevHash) {
  return createHash('sha256')
    .update(canonicalJSON(auditHashPayload(event)) + prevHash)
    .digest('hex');
}

/**
 * Appends are serialised through this promise chain.
 *
 * Two concurrent appends could otherwise read the same tip and produce two events
 * claiming the same sequence number and predecessor, forking the chain. In a
 * single-node prototype a promise chain is sufficient and honest; the unique index
 * on `seq` is the backstop, and a multi-node deployment would move allocation into
 * a `findOneAndUpdate($inc)` counter or a queue. That is a scaling change, not a
 * correctness one — the invariant is enforced by the index either way.
 */
let appendQueue = Promise.resolve();

function serialise(task) {
  const result = appendQueue.then(task, task);
  // Keep the chain alive even if one append rejects.
  appendQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function retainUntil(retentionClass) {
  const years = RETENTION_YEARS[retentionClass] ?? 1;
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);
  return date;
}

/** The current tip of the chain, or null when the log is empty. */
export async function getChainTip() {
  const [tip] = await repositories.auditEvents.find({}, { sort: { seq: -1 }, limit: 1 });
  return tip ?? null;
}

/**
 * Append one event. This is the only way anything enters the audit log.
 */
export async function appendAuditEvent({
  eventType,
  actor,
  subject = {},
  before,
  after,
  reasonCode = null,
  reasonText,
  assessmentAttested = false,
  modelSnapshot,
  occurredAt,
  lawfulBasis = LAWFUL_BASIS.MEDICAL_EMERGENCY,
  purpose = 'emergency_triage',
  consentRef,
  retentionClass = RETENTION_CLASS.CLINICAL_AUDIT,
}) {
  if (!actor?.name || !actor?.role) {
    throw new Error('An audit event must identify who caused it (actor.name and actor.role)');
  }

  return serialise(async () => {
    const tip = await getChainTip();
    const seq = (tip?.seq ?? 0) + 1;
    const prevHash = tip?.hash ?? GENESIS_HASH;

    const draft = {
      seq,
      eventType,
      actor,
      subject,
      before,
      after,
      reasonCode,
      reasonText,
      assessmentAttested,
      modelSnapshot,
      occurredAt: occurredAt ?? new Date(),
      recordedAt: new Date(),
      lawfulBasis,
      purpose,
      consentRef,
      retentionClass,
      retainUntil: retainUntil(retentionClass),
      prevHash,
    };

    return repositories.auditEvents.create({ ...draft, hash: computeEventHash(draft, prevHash) });
  });
}

/**
 * Walk the chain and confirm nothing has been altered, inserted or removed.
 *
 * Reports the first break rather than a bare boolean, because "the log is invalid"
 * is not useful to an investigator and "event 412 was altered on 3 March" is.
 */
export async function verifyAuditChain() {
  const events = await repositories.auditEvents.find({}, { sort: { seq: 1 } });

  if (events.length === 0) {
    return { valid: true, length: 0, checkedAt: new Date().toISOString(), message: 'Audit log is empty.' };
  }

  let expectedPrev = GENESIS_HASH;

  for (const [index, event] of events.entries()) {
    const expectedSeq = index + 1;

    if (event.seq !== expectedSeq) {
      return {
        valid: false,
        length: events.length,
        brokenAt: { seq: event.seq, eventType: event.eventType, recordedAt: event.recordedAt },
        failure: 'sequence_gap',
        message: `Sequence gap: expected ${expectedSeq}, found ${event.seq}. An event has been removed or inserted.`,
        checkedAt: new Date().toISOString(),
      };
    }

    if (event.prevHash !== expectedPrev) {
      return {
        valid: false,
        length: events.length,
        brokenAt: { seq: event.seq, eventType: event.eventType, recordedAt: event.recordedAt },
        failure: 'broken_link',
        message: `Event ${event.seq} does not follow its predecessor. The chain was re-linked or an earlier event was replaced.`,
        checkedAt: new Date().toISOString(),
      };
    }

    const recomputed = computeEventHash(event, event.prevHash);
    if (recomputed !== event.hash) {
      return {
        valid: false,
        length: events.length,
        brokenAt: { seq: event.seq, eventType: event.eventType, recordedAt: event.recordedAt },
        failure: 'content_altered',
        message: `Event ${event.seq} has been altered since it was written. Stored hash does not match its content.`,
        expectedHash: recomputed,
        storedHash: event.hash,
        checkedAt: new Date().toISOString(),
      };
    }

    expectedPrev = event.hash;
  }

  return {
    valid: true,
    length: events.length,
    headHash: expectedPrev,
    checkedAt: new Date().toISOString(),
    message: `All ${events.length} events verified. No gaps, no altered content, chain intact.`,
  };
}

// ---------------------------------------------------------------- typed helpers

/** The assistant proposing a score. Recorded so every score has provenance. */
export async function recordTriageAssigned({ encounter, assessment, actor, consentRef }) {
  return appendAuditEvent({
    eventType:
      assessment.trigger === 'initial'
        ? AUDIT_EVENT_TYPE.TRIAGE_ASSIGNED
        : AUDIT_EVENT_TYPE.TRIAGE_REASSESSED,
    actor: actor ?? {
      name: 'TriageHandler assistant',
      role: 'admin',
      registrationNumber: 'SYSTEM',
    },
    subject: {
      encounterRef: encounter._id,
      patientRef: encounter.patientRef,
      displayRef: encounter.displayRef,
    },
    before: { esi: encounter.currentESI ?? null, assignedBy: encounter.assignedBy ?? null },
    after: {
      esi: assessment.fusion.finalESI,
      assignedBy: 'ai',
      confidence: assessment.confidence.score,
      confidenceBand: assessment.confidence.band,
    },
    modelSnapshot: {
      assessmentRef: assessment._id,
      modelId: assessment.modelId,
      modelVersion: assessment.modelVersion,
      featureHash: assessment.featureHash,
      recommendedESI: assessment.fusion.finalESI,
      confidenceScore: assessment.confidence.score,
      confidenceBand: assessment.confidence.band,
      explainFlags: assessment.explainFlags,
    },
    purpose: 'emergency_triage',
    consentRef,
    retentionClass: RETENTION_CLASS.CLINICAL_AUDIT,
  });
}

/**
 * A clinician changing a standing score.
 *
 * The validation here is the accountability control, and it lives on the server
 * rather than in the override dialog. A check that exists only in the UI is a
 * usability feature, not a safeguard — anything that can reach the API can bypass
 * it, and an audit record that is merely usually complete is not a record.
 *
 * The friction is deliberately asymmetric. Escalating a patient takes one click
 * and no justification. De-escalating requires a structured reason code, a written
 * justification, and an explicit attestation that the clinician has actually
 * assessed the patient — because the costs of the two errors are not symmetric and
 * the interface should say so.
 */
export async function recordOverride({
  encounter,
  assessment,
  clinician,
  previousESI,
  newESI,
  reasonCode,
  reasonText,
  assessmentAttested = false,
  session = {},
  consentRef,
}) {
  if (!clinician?.name || !clinician?.role) {
    throw badRequest('An override must identify the clinician making it.');
  }
  if (!clinician.registrationNumber) {
    throw badRequest(
      'An override must record the clinician’s council registration number. ' +
        'Clinical accountability requires an identifiable, licensed decision-maker.',
    );
  }
  if (clinician.canOverride === false) {
    throw badRequest(`${clinician.name} does not hold override rights.`);
  }
  if (!Number.isFinite(newESI) || newESI < 1 || newESI > 5) {
    throw badRequest('An override must specify a valid ESI level between 1 and 5.');
  }
  if (newESI === previousESI) {
    throw badRequest('An override must actually change the score.');
  }
  if (!OVERRIDE_REASONS.includes(reasonCode)) {
    throw badRequest(
      `An override must carry a structured reason code (one of: ${OVERRIDE_REASONS.join(', ')}). ` +
        'Free text alone cannot be analysed across a department to find where the model is wrong.',
    );
  }

  // Higher ESI number = less urgent = the direction that can kill.
  const isDeEscalation = newESI > previousESI;

  if (isDeEscalation) {
    if (!reasonText || reasonText.trim().length < DEESCALATION_MIN_REASON_LENGTH) {
      throw badRequest(
        `Lowering a patient’s priority requires a written justification of at least ` +
          `${DEESCALATION_MIN_REASON_LENGTH} characters. Escalation needs none — the costs are not symmetric.`,
      );
    }
    if (!assessmentAttested) {
      throw badRequest(
        'Lowering a patient’s priority requires an explicit attestation that you have assessed the patient.',
      );
    }
  }

  return appendAuditEvent({
    eventType: AUDIT_EVENT_TYPE.TRIAGE_OVERRIDE,
    actor: {
      clinicianRef: clinician._id,
      name: clinician.name,
      role: clinician.role,
      registrationNumber: clinician.registrationNumber,
      sessionId: session.sessionId,
      workstation: session.workstation,
      ipAddress: session.ipAddress,
    },
    subject: {
      encounterRef: encounter._id,
      patientRef: encounter.patientRef,
      displayRef: encounter.displayRef,
    },
    // What the machine said, and what the human decided instead.
    before: {
      esi: previousESI,
      assignedBy: encounter.assignedBy ?? 'ai',
      confidence: encounter.currentConfidence?.score ?? null,
      confidenceBand: encounter.currentConfidence?.band ?? null,
    },
    after: {
      esi: newESI,
      assignedBy: 'nurse',
      direction: isDeEscalation ? 'de_escalation' : 'escalation',
      levelsChanged: Math.abs(newESI - previousESI),
    },
    reasonCode,
    reasonText: reasonText?.trim(),
    assessmentAttested: isDeEscalation ? true : Boolean(assessmentAttested),
    modelSnapshot: assessment
      ? {
          assessmentRef: assessment._id,
          modelId: assessment.modelId,
          modelVersion: assessment.modelVersion,
          featureHash: assessment.featureHash,
          recommendedESI: assessment.fusion?.finalESI,
          confidenceScore: assessment.confidence?.score,
          confidenceBand: assessment.confidence?.band,
          explainFlags: assessment.explainFlags,
        }
      : undefined,
    occurredAt: new Date(),
    lawfulBasis: LAWFUL_BASIS.MEDICAL_EMERGENCY,
    purpose: 'clinical_care',
    consentRef,
    retentionClass: RETENTION_CLASS.CLINICAL_AUDIT,
  });
}

/**
 * Reading identifying data about a patient.
 *
 * Logged because DPDP requires demonstrable purpose limitation and minimisation.
 * The dashboard runs on pseudonymous references, so revealing a name is a distinct
 * act with its own justification — and one that leaves a trace.
 */
export async function recordPhiAccess({ clinician, encounter, fields, purpose = 'clinical_care', session = {} }) {
  return appendAuditEvent({
    eventType: AUDIT_EVENT_TYPE.ACCESS_PHI,
    actor: {
      clinicianRef: clinician._id,
      name: clinician.name,
      role: clinician.role,
      registrationNumber: clinician.registrationNumber,
      sessionId: session.sessionId,
      workstation: session.workstation,
      ipAddress: session.ipAddress,
    },
    subject: {
      encounterRef: encounter._id,
      patientRef: encounter.patientRef,
      displayRef: encounter.displayRef,
    },
    after: { fieldsRevealed: fields },
    purpose,
    retentionClass: RETENTION_CLASS.ACCESS_LOG,
  });
}

/** A safe waiting time exceeded. Evidence, recorded whether or not anyone acted. */
export async function recordWaitBreach({ encounter, safeWaitMinutes, waitedMinutes }) {
  return appendAuditEvent({
    eventType: AUDIT_EVENT_TYPE.WAIT_THRESHOLD_BREACHED,
    actor: { name: 'TriageHandler queue engine', role: 'admin', registrationNumber: 'SYSTEM' },
    subject: {
      encounterRef: encounter._id,
      patientRef: encounter.patientRef,
      displayRef: encounter.displayRef,
    },
    before: { esi: encounter.currentESI, safeWaitMinutes },
    after: { waitedMinutes: Math.round(waitedMinutes), breachedBy: Math.round(waitedMinutes - safeWaitMinutes) },
    purpose: 'quality_audit',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
  });
}

/** The department entering or leaving surge. */
export async function recordSurgeChange({ state, metrics, policyApplied }) {
  return appendAuditEvent({
    eventType: AUDIT_EVENT_TYPE.SURGE_STATE_CHANGED,
    actor: { name: 'TriageHandler queue engine', role: 'admin', registrationNumber: 'SYSTEM' },
    after: { state, metrics, policyApplied },
    purpose: 'quality_audit',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
  });
}

/**
 * Correct an earlier event without altering it.
 * The original stays exactly as written; this points at it and says what was wrong.
 */
export async function recordCorrection({ clinician, targetSeq, reasonText, correction }) {
  if (!reasonText || reasonText.trim().length < DEESCALATION_MIN_REASON_LENGTH) {
    throw badRequest('A correction must explain what was wrong and why, in at least 20 characters.');
  }
  return appendAuditEvent({
    eventType: AUDIT_EVENT_TYPE.CORRECTION,
    actor: {
      clinicianRef: clinician._id,
      name: clinician.name,
      role: clinician.role,
      registrationNumber: clinician.registrationNumber,
    },
    before: { correctsSeq: targetSeq },
    after: correction,
    reasonText: reasonText.trim(),
    purpose: 'quality_audit',
    retentionClass: RETENTION_CLASS.CLINICAL_AUDIT,
  });
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.name = 'AuditValidationError';
  return error;
}
