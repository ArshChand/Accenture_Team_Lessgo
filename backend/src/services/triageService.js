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
import { recordOverride, recordStatusChange, recordTriageAssigned } from './auditService.js';
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

  // The ratchet extends across time, not just across layers.
  //
  // fusion.js guarantees that within a single assessment the result is never less
  // urgent than either the rules or the model concluded. That guarantee is
  // worthless over the length of a wait if the *next* assessment can quietly undo
  // it — and it can, because a re-score often runs on thinner evidence than the
  // original (the vitals that justified an escalation are an hour old, the ML
  // service may be down). Left unguarded, the system could walk a patient from
  // ESI 1 down to ESI 3 with nobody deciding anything.
  //
  // So an automated re-score may only ever raise urgency. Lowering it is a
  // clinical decision, and it goes through applyOverride, where it costs a reason
  // code, a written justification and an attestation. The machine proposes, and
  // the proposal is always visible as `aiRecommendedESI`; a human disposes.
  const standingESI = encounter.currentESI;
  const hasStandingScore = Number.isFinite(standingESI);
  const escalates = !hasStandingScore || fusion.finalESI < standingESI;

  const updates = {
    latestAssessmentRef: assessment._id,
    // Always recorded, even when not applied, so the dashboard can show a nurse
    // "the assistant now thinks this is a 4" without acting on it unilaterally.
    aiRecommendedESI: fusion.finalESI,
  };

  if (escalates) {
    // An escalation supersedes a nurse's standing score as well as the AI's own.
    // Catching deterioration in someone a clinician has already assessed is
    // precisely what continuous re-triage is for, and the change is audited.
    updates.currentESI = fusion.finalESI;
    updates.currentConfidence = confidence;
    updates.assignedAt = new Date();
    updates.assignedBy = 'ai';
    updates['queue.safeWaitMinutes'] = safeWaitMinutesWith(protocol, fusion.finalESI);
  }

  // The decay clock resets only when something genuinely new is now known about
  // this patient — new vitals, or the initial assessment itself — never from the
  // system re-running the same stale inputs against itself. A WAIT_DECAY trigger
  // fires precisely because nobody has looked at this patient in a while; letting
  // that automated re-score reset the clock would make a neglected patient read
  // as freshly seen the instant the alert fires, hiding the exact problem this
  // loop exists to surface.
  if (trigger === TRIAGE_TRIGGER.VITALS_CHANGE || trigger === TRIAGE_TRIGGER.INITIAL) {
    updates['queue.lastInformedAt'] = new Date();
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

  const now = new Date();
  const updated = await repositories.encounters.updateById(encounter._id, {
    currentESI: newESI,
    assignedBy: 'nurse',
    assignedAt: now,
    'queue.safeWaitMinutes': safeWaitMinutesWith(protocol, newESI),
    // A clinician has just looked at this patient — the clearest possible new
    // information, so both clocks reset: the decay clock, and the throttle that
    // stops the engine re-scoring them again immediately.
    'queue.lastInformedAt': now,
    'queue.lastReassessedAt': now,
  });

  return { encounter: updated, auditEvent, previousESI, newESI };
}

/** Score without persisting — used by the demo scripts and what-if tooling. */
export async function dryRunScore(args) {
  return scoreAndPersist({ ...args, persist: false });
}

export const WAITING_STATUSES = [ENCOUNTER_STATUS.WAITING, ENCOUNTER_STATUS.IN_TRIAGE];

/**
 * Dispositions that take a patient off the active board. Anything not listed here
 * keeps them in the queue and under the decay clock.
 */
export const CLEARING_STATUSES = [
  ENCOUNTER_STATUS.IN_TREATMENT,
  ENCOUNTER_STATUS.DISCHARGED,
  ENCOUNTER_STATUS.LEFT_WITHOUT_BEING_SEEN,
];

/** Matches the de-escalation bar in the audit service — same act, same weight. */
export const DISPOSITION_MIN_REASON_LENGTH = 20;

/**
 * Clearing a patient from the active queue.
 *
 * Same shape as `applyOverride` and for the same reason: the audit event is
 * written first, so there is no state where a patient vanished from the board and
 * no record says who removed them. Both are clinical acts, not housekeeping.
 *
 * The friction is asymmetric in the same direction as everything else in this
 * system. Taking a patient into treatment is the safe disposition and needs
 * nothing beyond an identified clinician. Discharging someone the assistant still
 * scores ESI 1–2, or recording them as having left without being seen, is the
 * dangerous one — those close the encounter on a patient the system believes is
 * seriously unwell — so they require a written reason. That check lives here
 * rather than in the dialog: a rule enforced only in the UI is bypassed by
 * anything that can reach the API.
 */
export async function applyDisposition({ encounterId, clinicianId, status, reasonText, session = {} }) {
  if (!CLEARING_STATUSES.includes(status)) {
    const error = new Error(
      `A disposition must be one of: ${CLEARING_STATUSES.join(', ')}. Received "${status}".`,
    );
    error.status = 400;
    throw error;
  }

  const encounter = await repositories.encounters.findById(encounterId);
  if (!encounter) throw notFound('Encounter not found');

  const clinician = await repositories.clinicians.findById(clinicianId);
  if (!clinician) throw notFound('Clinician not found');

  if (!WAITING_STATUSES.includes(encounter.status)) {
    const error = new Error(`${encounter.displayRef} has already left the queue (${encounter.status}).`);
    error.status = 409;
    throw error;
  }

  const isHighAcuity = (encounter.currentESI ?? 5) <= 2;
  const needsReason =
    status === ENCOUNTER_STATUS.LEFT_WITHOUT_BEING_SEEN ||
    (status === ENCOUNTER_STATUS.DISCHARGED && isHighAcuity);

  if (needsReason && (reasonText ?? '').trim().length < DISPOSITION_MIN_REASON_LENGTH) {
    const error = new Error(
      status === ENCOUNTER_STATUS.LEFT_WITHOUT_BEING_SEEN
        ? `Recording a patient as having left without being seen needs at least ${DISPOSITION_MIN_REASON_LENGTH} characters explaining what was attempted.`
        : `${encounter.displayRef} is still scored ESI ${encounter.currentESI}. Discharging at this severity needs at least ${DISPOSITION_MIN_REASON_LENGTH} characters of justification.`,
    );
    error.status = 400;
    throw error;
  }

  const waitedMinutes =
    (Date.now() - new Date(encounter.queue?.lastInformedAt ?? encounter.arrivalAt).getTime()) / 60000;

  // Audit first. If this throws, the patient stays on the board.
  const auditEvent = await recordStatusChange({
    clinician,
    encounter,
    fromStatus: encounter.status,
    toStatus: status,
    reasonText,
    waitedMinutes,
    session,
  });

  const now = new Date();
  const updated = await repositories.encounters.updateById(encounter._id, {
    status,
    statusChangedAt: now,
    'queue.lastReassessedAt': now,
  });

  return { encounter: updated, auditEvent, waitedMinutes: Math.round(waitedMinutes) };
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}
