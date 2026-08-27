/**
 * Shared clinical vocabulary. The rule engine, the Mongoose schemas, the ML feature
 * builder and the frontend all read their enums from here so a term cannot drift
 * between the safety layer and the storage layer.
 */

/** Emergency Severity Index, 5-level. Lower number = more urgent. */
export const ESI = {
  RESUSCITATION: 1,
  EMERGENT: 2,
  URGENT: 3,
  LESS_URGENT: 4,
  NON_URGENT: 5,
};

export const ESI_LEVELS = [1, 2, 3, 4, 5];

export const ESI_LABELS = {
  1: 'Resuscitation',
  2: 'Emergent',
  3: 'Urgent',
  4: 'Less urgent',
  5: 'Non-urgent',
};

/**
 * Maximum safe wait before a patient at this level must be re-assessed, in minutes.
 * ESI 1 is zero: a resuscitation patient is never "waiting".
 * These are the thresholds that surge mode is explicitly forbidden from relaxing.
 */
export const SAFE_WAIT_MINUTES = {
  1: 0,
  2: 10,
  3: 30,
  4: 60,
  5: 120,
};

/**
 * Provenance of a clinical value, and how much we trust it. Reliability feeds the
 * confidence score, which in turn feeds the escalation ratchet — so an unreliable
 * input makes the system more cautious rather than silently more confident.
 */
export const SOURCE = {
  MEASURED: 'measured',
  CLINICIAN_OBSERVED: 'clinician_observed',
  PRIOR_RECORD: 'prior_record',
  PATIENT_REPORTED: 'patient_reported',
  PROXY_REPORTED: 'proxy_reported',
  NLP_INFERRED: 'nlp_inferred',
};

export const SOURCE_RELIABILITY = {
  [SOURCE.MEASURED]: 1.0,
  [SOURCE.CLINICIAN_OBSERVED]: 0.9,
  [SOURCE.PRIOR_RECORD]: 0.8,
  [SOURCE.PATIENT_REPORTED]: 0.6,
  [SOURCE.PROXY_REPORTED]: 0.45,
  // NLP-inferred reliability is computed per-field as asrConfidence * extractionConfidence.
  [SOURCE.NLP_INFERRED]: 0.5,
};

export const SOURCES = Object.values(SOURCE);

/**
 * Age bands. Vital-sign thresholds and symptom weights differ materially across
 * these; applying one adult-calibrated model to all of them is the silent safety
 * risk the brief calls out.
 */
export const AGE_BAND = {
  NEONATE: 'neonate',
  INFANT: 'infant',
  TODDLER: 'toddler',
  CHILD: 'child',
  ADOLESCENT: 'adolescent',
  ADULT: 'adult',
  GERIATRIC: 'geriatric',
  ADVANCED_GERIATRIC: 'advanced_geriatric',
};

export const AGE_BANDS = Object.values(AGE_BAND);

/** Ordered youngest-first; `maxYears` is exclusive. */
export const AGE_BAND_RANGES = [
  { band: AGE_BAND.NEONATE, minYears: 0, maxYears: 28 / 365 },
  { band: AGE_BAND.INFANT, minYears: 28 / 365, maxYears: 1 },
  { band: AGE_BAND.TODDLER, minYears: 1, maxYears: 5 },
  { band: AGE_BAND.CHILD, minYears: 5, maxYears: 13 },
  { band: AGE_BAND.ADOLESCENT, minYears: 13, maxYears: 18 },
  { band: AGE_BAND.ADULT, minYears: 18, maxYears: 65 },
  { band: AGE_BAND.GERIATRIC, minYears: 65, maxYears: 80 },
  { band: AGE_BAND.ADVANCED_GERIATRIC, minYears: 80, maxYears: Infinity },
];

/**
 * How well the training data covers each band. Published honestly rather than
 * hidden: thin coverage lowers confidence, which escalates rather than downgrades.
 */
export const AGE_BAND_MODEL_SUPPORT = {
  [AGE_BAND.NEONATE]: 0.45,
  [AGE_BAND.INFANT]: 0.6,
  [AGE_BAND.TODDLER]: 0.72,
  [AGE_BAND.CHILD]: 0.8,
  [AGE_BAND.ADOLESCENT]: 0.82,
  [AGE_BAND.ADULT]: 0.95,
  [AGE_BAND.GERIATRIC]: 0.85,
  [AGE_BAND.ADVANCED_GERIATRIC]: 0.7,
};

export const CONFIDENCE_BAND = {
  HIGH: 'high',
  MODERATE: 'moderate',
  LOW: 'low',
};

/** Band cut points. `LOW` is also the threshold at which the ratchet escalates. */
export const CONFIDENCE_THRESHOLDS = {
  high: 0.75,
  moderate: 0.55,
};

/**
 * Under surge the escalation threshold widens: nurse attention per patient has
 * dropped, so the system compensates by escalating on less uncertainty.
 */
export const SURGE_ESCALATION_THRESHOLD = 0.62;

export const TRIAGE_TRIGGER = {
  INITIAL: 'initial',
  WAIT_DECAY: 'wait_decay',
  VITALS_CHANGE: 'vitals_change',
  PATIENT_REQUEST: 'patient_request',
  SURGE_SWEEP: 'surge_sweep',
  NURSE_REQUEST: 'nurse_request',
};

export const TRIAGE_TRIGGERS = Object.values(TRIAGE_TRIGGER);

export const ENCOUNTER_STATUS = {
  WAITING: 'waiting',
  IN_TRIAGE: 'in_triage',
  IN_TREATMENT: 'in_treatment',
  DISCHARGED: 'discharged',
  LEFT_WITHOUT_BEING_SEEN: 'left_without_being_seen',
};

export const ENCOUNTER_STATUSES = Object.values(ENCOUNTER_STATUS);

export const DECAY_STATUS = {
  GREEN: 'green',
  AMBER: 'amber',
  RED: 'red',
};

export const DECAY_STATUSES = Object.values(DECAY_STATUS);

/** Fraction of safe wait at which the queue turns amber and re-assessment is queued. */
export const DECAY_AMBER_RATIO = 0.6;
export const DECAY_REASSESS_RATIO = 0.8;

export const ARRIVAL_MODE = {
  WALK_IN: 'walk_in',
  AMBULANCE: 'ambulance',
  REFERRAL: 'referral',
};

export const ARRIVAL_MODES = Object.values(ARRIVAL_MODE);

export const LANGUAGE = {
  ENGLISH: 'en-IN',
  HINDI: 'hi-IN',
  KANNADA: 'kn-IN',
};

export const LANGUAGES = Object.values(LANGUAGE);

/**
 * Structured override reasons. Free text alone is not auditable at scale — a reason
 * code lets us measure *why* clinicians disagree with the model and feed that back
 * into calibration.
 */
export const OVERRIDE_REASON = {
  CLINICAL_GESTALT: 'CLINICAL_GESTALT',
  VITALS_UNRELIABLE: 'VITALS_UNRELIABLE',
  ADDITIONAL_HISTORY_OBTAINED: 'ADDITIONAL_HISTORY_OBTAINED',
  MODEL_MISSED_RED_FLAG: 'MODEL_MISSED_RED_FLAG',
  PATIENT_APPEARS_WELL: 'PATIENT_APPEARS_WELL',
  RESOURCE_CONSTRAINT: 'RESOURCE_CONSTRAINT',
  OTHER: 'OTHER',
};

export const OVERRIDE_REASONS = Object.values(OVERRIDE_REASON);

/**
 * Why a nurse pulled a patient up the queue by hand.
 *
 * Deliberately a separate vocabulary from OVERRIDE_REASON, because this is a
 * different act: an override changes what the system believes about a patient's
 * severity, a promotion changes only who gets seen next. Most of these describe
 * something that happened in the waiting room, which is precisely the category
 * of event no model scoring a snapshot at arrival can ever observe.
 */
export const PROMOTION_REASON = {
  VISIBLE_DETERIORATION: 'VISIBLE_DETERIORATION',
  COLLAPSE_OR_SEVERE_DISTRESS: 'COLLAPSE_OR_SEVERE_DISTRESS',
  CLINICAL_GESTALT: 'CLINICAL_GESTALT',
  FAMILY_OR_STAFF_ESCALATION: 'FAMILY_OR_STAFF_ESCALATION',
  INFORMATION_ASSISTANT_LACKED: 'INFORMATION_ASSISTANT_LACKED',
  OPERATIONAL: 'OPERATIONAL',
  OTHER: 'OTHER',
};

export const PROMOTION_REASONS = Object.values(PROMOTION_REASON);

export const AUDIT_EVENT_TYPE = {
  TRIAGE_ASSIGNED: 'TRIAGE_ASSIGNED',
  TRIAGE_OVERRIDE: 'TRIAGE_OVERRIDE',
  TRIAGE_REASSESSED: 'TRIAGE_REASSESSED',
  ACCESS_PHI: 'ACCESS_PHI',
  CONSENT_RECORDED: 'CONSENT_RECORDED',
  CONSENT_WITHDRAWN: 'CONSENT_WITHDRAWN',
  ENCOUNTER_STATUS_CHANGED: 'ENCOUNTER_STATUS_CHANGED',
  /** A nurse moved a patient up the queue by hand, or released that promotion. */
  QUEUE_MANUAL_PROMOTION: 'QUEUE_MANUAL_PROMOTION',
  SURGE_STATE_CHANGED: 'SURGE_STATE_CHANGED',
  WAIT_THRESHOLD_BREACHED: 'WAIT_THRESHOLD_BREACHED',
  CORRECTION: 'CORRECTION',
};

export const AUDIT_EVENT_TYPES = Object.values(AUDIT_EVENT_TYPE);

/**
 * DPDP Act 2023 lawful bases relevant to emergency care. Emergency treatment is a
 * "legitimate use" under s.7(f) — consent is not required to triage an unconscious
 * patient, but the basis must still be recorded.
 */
export const LAWFUL_BASIS = {
  CONSENT: 'DPDP_S6_CONSENT',
  MEDICAL_EMERGENCY: 'DPDP_S7F_MEDICAL_EMERGENCY',
  PUBLIC_HEALTH: 'DPDP_S7G_PUBLIC_HEALTH',
};

export const LAWFUL_BASES = Object.values(LAWFUL_BASIS);

export const RETENTION_CLASS = {
  /** Clinical decision record — retained for the statutory medico-legal period. */
  CLINICAL_AUDIT: 'clinical_audit',
  /** Access log — shorter retention, no clinical content. */
  ACCESS_LOG: 'access_log',
  /** Operational telemetry — aggregate only, purged soonest. */
  OPERATIONAL: 'operational',
};

export const RETENTION_CLASSES = Object.values(RETENTION_CLASS);

/**
 * Graceful degradation, carried forward from the Round 1 concept: when the ML
 * service or the network is unavailable, triage does not stop — it falls back to
 * the hardcoded START protocol (Simple Triage And Rapid Treatment), or JumpSTART
 * for children under 8. START needs only respirations, perfusion and mental status,
 * so it still functions on the thinnest possible data.
 */
export const START_CATEGORY = {
  IMMEDIATE: 'immediate',
  DELAYED: 'delayed',
  MINOR: 'minor',
  EXPECTANT: 'expectant',
};

export const START_CATEGORIES = Object.values(START_CATEGORY);

/**
 * START categories map conservatively onto ESI. `expectant` maps to ESI 1 rather
 * than being deprioritised: this is a hospital ED, not a field mass-casualty
 * incident, so an apnoeic patient gets resuscitation resources.
 */
export const START_TO_ESI = {
  [START_CATEGORY.EXPECTANT]: 1,
  [START_CATEGORY.IMMEDIATE]: 2,
  [START_CATEGORY.DELAYED]: 3,
  [START_CATEGORY.MINOR]: 4,
};

export const SCORING_MODE = {
  /** Rule engine + XGBoost fused through the safety ratchet. Normal operation. */
  FULL: 'full',
  /** ML service unreachable: rule engine only, still fused and confidence-scored. */
  RULES_ONLY: 'rules_only',
  /** Rule engine unusable (data too thin): hardcoded START protocol. */
  START_FALLBACK: 'start_fallback',
};

export const SCORING_MODES = Object.values(SCORING_MODE);

export const CLINICIAN_ROLE = {
  TRIAGE_NURSE: 'triage_nurse',
  CHARGE_NURSE: 'charge_nurse',
  PHYSICIAN: 'physician',
  ADMIN: 'admin',
};

export const CLINICIAN_ROLES = Object.values(CLINICIAN_ROLE);

/**
 * Resolve a decimal age in years to its band.
 * @param {number} ageYears
 * @returns {string} one of AGE_BAND
 */
export function resolveAgeBand(ageYears) {
  if (!Number.isFinite(ageYears) || ageYears < 0) {
    // Unknown age is not a reason to relax: treat as adult but the missing-age
    // penalty in the confidence score will pull the assessment toward escalation.
    return AGE_BAND.ADULT;
  }
  const match = AGE_BAND_RANGES.find(
    (range) => ageYears >= range.minYears && ageYears < range.maxYears,
  );
  return match ? match.band : AGE_BAND.ADULT;
}

export const isPaediatric = (band) =>
  [AGE_BAND.NEONATE, AGE_BAND.INFANT, AGE_BAND.TODDLER, AGE_BAND.CHILD, AGE_BAND.ADOLESCENT].includes(
    band,
  );

export const isGeriatric = (band) =>
  [AGE_BAND.GERIATRIC, AGE_BAND.ADVANCED_GERIATRIC].includes(band);
