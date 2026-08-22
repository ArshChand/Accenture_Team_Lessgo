/**
 * Controlled symptom vocabulary.
 *
 * The NLP layer maps free multilingual speech onto these codes, the rule engine
 * matches on them, and the model one-hot encodes them. Keeping one vocabulary means
 * a Kannada phrase, an English phrase and a model feature all refer to the same
 * clinical concept rather than three near-synonyms that silently fail to match.
 *
 * Anything the extractor cannot map is preserved verbatim in `unmappedTerms` and
 * shown to the nurse, rather than dropped. A symptom we did not understand is a
 * reason to look, not a reason to assume nothing was said.
 */
export const SYMPTOM = {
  // Cardiac / circulatory
  CHEST_PAIN: 'chest_pain',
  RADIATING_PAIN: 'radiating_pain',
  PALPITATIONS: 'palpitations',
  SYNCOPE: 'syncope',
  // Respiratory
  DYSPNOEA: 'dyspnoea',
  WHEEZE: 'wheeze',
  STRIDOR: 'stridor',
  COUGH: 'cough',
  HAEMOPTYSIS: 'haemoptysis',
  // Neurological
  HEADACHE: 'headache',
  VISUAL_DISTURBANCE: 'visual_disturbance',
  FACIAL_DROOP: 'facial_droop',
  UNILATERAL_WEAKNESS: 'unilateral_weakness',
  SPEECH_DIFFICULTY: 'speech_difficulty',
  SEIZURE: 'seizure',
  CONFUSION: 'confusion',
  DIZZINESS: 'dizziness',
  // Abdominal / GI
  ABDOMINAL_PAIN: 'abdominal_pain',
  VOMITING: 'vomiting',
  DIARRHOEA: 'diarrhoea',
  GI_BLEEDING: 'gi_bleeding',
  // Infection
  FEVER: 'fever',
  SORE_THROAT: 'sore_throat',
  RASH: 'rash',
  DYSURIA: 'dysuria',
  // Trauma
  HEAD_INJURY: 'head_injury',
  FALL: 'fall',
  LACERATION: 'laceration',
  DEFORMITY: 'deformity',
  BURN: 'burn',
  BLEEDING: 'bleeding',
  // Obstetric
  PREGNANCY_RELATED: 'pregnancy_related',
  VAGINAL_BLEEDING: 'vaginal_bleeding',
  // Paediatric-specific
  POOR_FEEDING: 'poor_feeding',
  LETHARGY: 'lethargy',
  IRRITABILITY: 'irritability',
  // Other
  BACK_PAIN: 'back_pain',
  JOINT_PAIN: 'joint_pain',
  FATIGUE: 'fatigue',
  ANXIETY: 'anxiety',
  ALLERGIC_REACTION: 'allergic_reaction',
  OVERDOSE: 'overdose',
  SELF_HARM: 'self_harm',
  EYE_PAIN: 'eye_pain',
  EAR_PAIN: 'ear_pain',
  DENTAL_PAIN: 'dental_pain',
  BREAST_LUMP: 'breast_lump',
  URINARY_RETENTION: 'urinary_retention',
  INDIGESTION: 'indigestion',
  NAUSEA: 'nausea',
  SWEATING: 'sweating',
  MALAISE: 'malaise',
};

export const SYMPTOMS = Object.values(SYMPTOM);

/** Symptoms that suggest an infective source, used by the sepsis screen. */
export const INFECTION_SYMPTOMS = [
  SYMPTOM.FEVER,
  SYMPTOM.COUGH,
  SYMPTOM.SORE_THROAT,
  SYMPTOM.DYSURIA,
  SYMPTOM.DIARRHOEA,
  SYMPTOM.RASH,
  SYMPTOM.POOR_FEEDING,
  SYMPTOM.MALAISE,
];

/**
 * Presentations that are cardiac until proven otherwise in an at-risk patient,
 * even without chest pain. Women, diabetics and the elderly disproportionately
 * present this way, and this list is why the "silent MI" case escalates.
 */
export const ATYPICAL_CARDIAC_SYMPTOMS = [
  SYMPTOM.DYSPNOEA,
  SYMPTOM.FATIGUE,
  SYMPTOM.NAUSEA,
  SYMPTOM.SWEATING,
  SYMPTOM.INDIGESTION,
  SYMPTOM.SYNCOPE,
];

/** Time-critical stroke presentation (FAST). */
export const STROKE_SYMPTOMS = [
  SYMPTOM.FACIAL_DROOP,
  SYMPTOM.UNILATERAL_WEAKNESS,
  SYMPTOM.SPEECH_DIFFICULTY,
];

/** Chronic conditions that change how a presentation should be read. */
export const RISK_CONDITION = {
  DIABETES: 'diabetes',
  CORONARY_ARTERY_DISEASE: 'coronary_artery_disease',
  HEART_FAILURE: 'heart_failure',
  COPD: 'copd',
  ASTHMA: 'asthma',
  CHRONIC_KIDNEY_DISEASE: 'chronic_kidney_disease',
  HYPERTENSION: 'hypertension',
  IMMUNOSUPPRESSION: 'immunosuppression',
  MALIGNANCY: 'malignancy',
  DEMENTIA: 'dementia',
  PREGNANCY: 'pregnancy',
  SICKLE_CELL: 'sickle_cell',
  EPILEPSY: 'epilepsy',
};

export const RISK_CONDITIONS = Object.values(RISK_CONDITION);

/** Conditions that raise cardiac suspicion for an otherwise vague presentation. */
export const CARDIAC_RISK_CONDITIONS = [
  RISK_CONDITION.DIABETES,
  RISK_CONDITION.CORONARY_ARTERY_DISEASE,
  RISK_CONDITION.HEART_FAILURE,
  RISK_CONDITION.HYPERTENSION,
  RISK_CONDITION.CHRONIC_KIDNEY_DISEASE,
];
