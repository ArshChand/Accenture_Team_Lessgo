import { createHash } from 'node:crypto';
import { repositories } from '../db/index.js';
import { ENCOUNTER_STATUS, SCORING_MODE, TRIAGE_TRIGGER } from '../clinical/constants.js';
import { buildRuleContext, evaluateRules } from '../clinical/rules.js';
import { computeConfidence } from '../clinical/confidence.js';
import { buildExplainFlags, fuse } from '../clinical/fusion.js';
import { evaluateStartProtocol } from '../clinical/start.js';
import { safeWaitMinutesWith } from '../clinical/protocol.js';
import { getActiveProtocol } from './protocolService.js';
import { buildScoringSnapshot, scoreEncounter } from './mlClient.js';
import { recordOverride, recordTriageAssigned } from './auditService.js';
import { canonicalJSON } from './auditService.js';

/**
 * Orchestration: turning an encounter into a scored, explained, audited assessment.
 *
 * The order of operations is the safety design. Rules run first and always, on
 * whatever data exists. The model is consulted second and is allowed to fail. The
 * two are fused through the ratchet, which can only escalate. Confidence is
 * computed from what was actually available and feeds back into that escalation.
 * Only then is anything written, and the write is immutable.
 *
 * Nothing in this pipeline can produce a score without a confidence object
 * attached — not as a convention but because `assertScored` refuses to return one.
 */

/** Absent-safe hash of the exact input, so an assessment stays reproducible. */
function hashFeatures(snapshot) {
  return createHash('sha256').update(canonicalJSON(snapshot)).digest('hex');
}

/**
 * A score must never leave this module without its uncertainty attached.
 * Enforced here rather than trusted to callers, because "we always include
 * confidence" is the kind of convention that survives until the one code path
 * where it does not.
 */
function assertScored(assessment) {
  const { confidence } = assessment;
  if (
    !confidence ||
    !Number.isFinite(confidence.score) ||
    !confidence.band ||
    !confidence.components
  ) {
    throw new Error(
      'Refusing to return a triage score without a confidence indicator. ' +
        'A number with no stated uncertainty invites exactly the over-trust this system exists to avoid.',
    );
  }
  return assessment;
}

/**
 * Score one encounter and persist an immutable assessment.
 *
 * @param {object} args
 * @param {object} args.encounter
 * @param {object} [args.patient]      loaded when absent
 * @param {object} [args.vitals]       latest observation; loaded when absent
 * @param {string} [args.trigger]      why this run happened
 * @param {boolean} [args.surgeActive]
 * @param {boolean} [args.persist]     false for what-if scoring
 */
export async function scoreAndPersist({
  encounter,
  patient,
  vitals,
  trigger = TRIAGE_TRIGGER.INITIAL,
  surgeActive = false,
  persist = true,
  actor,
}) {
  const started = Date.now();
  const protocol = getActiveProtocol();

  const loadedPatient = patient ?? (await repositories.patients.findById(encounter.patientRef)) ?? {};
  const loadedVitals =
    vitals ??
    (encounter.latestVitalsRef ? await repositories.vitals.findById(encounter.latestVitalsRef) : null) ??
    (await latestVitalsFor(encounter._id)) ??
    {};

  // --- 1. rules, always, on whatever exists ---
  const context = buildRuleContext({
    encounter,
    patient: loadedPatient,
    vitals: loadedVitals,
    protocol,
  });
  const ruleResult = evaluateRules(context);

  // --- 2. model, allowed to fail ---
  const snapshot = buildScoringSnapshot({
    encounter,
    patient: loadedPatient,
    vitals: loadedVitals,
    protocol,
  });
  const featureHash = hashFeatures(snapshot);
  const mlResponse = await scoreEncounter(snapshot);

  const modelAvailable = mlResponse.ok;
  const modelResult = modelAvailable ? mlResponse.data : null;

  // --- 3. degradation: rules alone, or START when even the rules have nothing ---
  let mode = modelAvailable ? SCORING_MODE.FULL : SCORING_MODE.RULES_ONLY;
  let startProtocol;

  if (!modelAvailable && !context.hasAnyVitals && !ruleResult.floorImposed) {
    // No model, no observations, and nothing for the rules to bite on. Rather than
    // return a shrug, fall back to the protocol that needs only what a person can
    // see: START, or JumpSTART for a child.
    startProtocol = evaluateStartProtocol({
      ageYears: encounter.age?.ageYears,
      vitals: loadedVitals,
      reason: mlResponse.reason,
    });
    mode = SCORING_MODE.START_FALLBACK;
    ruleResult.esi = Math.min(ruleResult.esi, startProtocol.esi);
  }

  // --- 4. confidence, from what was actually available ---
  const confidence = computeConfidence({
    protocol,
    encounter,
    patient: loadedPatient,
    vitals: loadedVitals,
    classProbabilities: modelResult?.classProbabilities,
    modelUnavailable: !modelAvailable,
    ageBand: encounter.age?.band,
  });

  // --- 5. fusion: the ratchet ---
  const fusion = fuse({ ruleResult, modelResult, confidence, protocol, surgeActive });

  const explainFlags = buildExplainFlags({ ruleResult, modelResult, confidence, fusion });

  const sequence = (await repositories.assessments.count({ encounterRef: encounter._id })) + 1;

  const assessmentDoc = {
    encounterRef: encounter._id,
    patientRef: encounter.patientRef,
    sequence,
    trigger,
    mode,
    featureVector: snapshot,
    featureHash,
    modelId: modelResult?.modelId ?? (modelAvailable ? undefined : 'unavailable'),
    modelVersion: modelResult?.modelVersion,
    ruleEngine: { esi: ruleResult.esi, firedRules: ruleResult.firedRules },
    model: {
      esi: modelResult?.esi,
      classProbabilities: modelResult?.classProbabilities ?? [],
      topContributions: modelResult?.topContributions ?? [],
      unavailableReason: modelAvailable ? undefined : mlResponse.reason,
    },
    startProtocol: startProtocol
      ? { category: startProtocol.category, pathway: startProtocol.pathway, steps: startProtocol.steps }
      : undefined,
    fusion: {
      finalESI: fusion.finalESI,
      ratchetApplied: fusion.ratchetApplied,
      escalationReason: fusion.escalationReason,
      redFlagLocked: fusion.redFlagLocked,
      escalationThreshold: fusion.escalationThreshold,
    },
    confidence,
    explainFlags,
    latencyMs: Date.now() - started,
    scoredDuringSurge: surgeActive,
  };

  assertScored(assessmentDoc);

  if (!persist) {
    return { assessment: assessmentDoc, fusion, ruleResult, modelResult, confidence, encounter };
  }

  const assessment = await repositories.assessments.create(assessmentDoc);

  // The standing score only changes if a clinician has not overridden it. A human
  // decision outranks a later machine re-score; the assistant may raise an alert,
  // but it does not silently undo what a nurse chose.
  const nurseOwned = encounter.assignedBy === 'nurse';
  const wouldEscalate = fusion.finalESI < (encounter.currentESI ?? 6);

  const updates = {
    latestAssessmentRef: assessment._id,
    aiRecommendedESI: fusion.finalESI,
  };

  if (!nurseOwned || wouldEscalate) {
    updates.currentESI = nurseOwned ? Math.min(encounter.currentESI, fusion.finalESI) : fusion.finalESI;
    updates.currentConfidence = confidence;
    updates.assignedAt = new Date();
    if (!nurseOwned) updates.assignedBy = 'ai';
    updates['queue.safeWaitMinutes'] = safeWaitMinutesWith(protocol, updates.currentESI);
  }

  const updated = await repositories.encounters.updateById(encounter._id, updates);

  await recordTriageAssigned({
    encounter: { ...encounter, ...updated },
    assessment,
    actor,
    consentRef: loadedPatient.consentRef,
  });

  return { assessment, fusion, ruleResult, modelResult, confidence, encounter: updated };
}

async function latestVitalsFor(encounterRef) {
  const [latest] = await repositories.vitals.find(
    { encounterRef },
    { sort: { recordedAt: -1 }, limit: 1 },
  );
  return latest ?? null;
}

/**
 * A clinician changing a standing score.
 *
 * Validation lives in the audit service, so an override cannot be written without
 * being recorded — the two are one operation. The encounter is only updated after
 * the audit event succeeds, which means there is no state in which a score changed
 * and no trail exists.
 */
export async function applyOverride({
  encounterId,
  clinicianId,
  newESI,
  reasonCode,
  reasonText,
  assessmentAttested = false,
  session = {},
}) {
  const encounter = await repositories.encounters.findById(encounterId);
  if (!encounter) throw notFound('Encounter not found');

  const clinician = await repositories.clinicians.findById(clinicianId);
  if (!clinician) throw notFound('Clinician not found');

  const assessment = encounter.latestAssessmentRef
    ? await repositories.assessments.findById(encounter.latestAssessmentRef)
    : null;
  const patient = await repositories.patients.findById(encounter.patientRef);
  const protocol = getActiveProtocol();

  const previousESI = encounter.currentESI;

  // Audit first. If this throws, nothing has changed.
  const auditEvent = await recordOverride({
    encounter,
    assessment,
    clinician,
    previousESI,
    newESI,
    reasonCode,
    reasonText,
    assessmentAttested,
    session,
    consentRef: patient?.consentRef,
  });

  const updated = await repositories.encounters.updateById(encounter._id, {
    currentESI: newESI,
    assignedBy: 'nurse',
    assignedAt: new Date(),
    'queue.safeWaitMinutes': safeWaitMinutesWith(protocol, newESI),
    // Reset the decay clock: a clinician has just looked at this patient.
    'queue.lastReassessedAt': new Date(),
  });

  return { encounter: updated, auditEvent, previousESI, newESI };
}

/** Score without persisting — used by the demo scripts and what-if tooling. */
export async function dryRunScore(args) {
  return scoreAndPersist({ ...args, persist: false });
}

export const WAITING_STATUSES = [ENCOUNTER_STATUS.WAITING, ENCOUNTER_STATUS.IN_TRIAGE];

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}
