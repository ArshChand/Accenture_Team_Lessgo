"""Feature specification shared by training and inference.

Two design commitments matter more than the feature list itself.

Missingness is real. A vital that was never taken is ``NaN``, never zero and never
an imputed mean. XGBoost learns a default split direction for missing values, so
"we did not measure this" becomes a signal the model can act on rather than a hole
we quietly fill with something reassuring. Imputing an average respiratory rate for
a patient nobody has looked at is exactly how a system under-triages with
confidence.

Age enters twice. The raw vital is a feature, and so is its deviation from the
normal range *for this patient's age band*. A heart rate of 150 means something
different in an infant and in an adult, and a model given only the raw number has
to rediscover that from data it may not have enough of. Handing it the deviation
directly makes the age calibration explicit and auditable instead of hoping the
trees infer it.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

# Must stay in step with backend/src/clinical/symptoms.js. A Node test asserts
# parity so the two vocabularies cannot drift apart unnoticed.
SYMPTOMS: list[str] = [
    "chest_pain",
    "radiating_pain",
    "palpitations",
    "syncope",
    "dyspnoea",
    "wheeze",
    "stridor",
    "cough",
    "haemoptysis",
    "headache",
    "visual_disturbance",
    "facial_droop",
    "unilateral_weakness",
    "speech_difficulty",
    "seizure",
    "confusion",
    "dizziness",
    "abdominal_pain",
    "vomiting",
    "diarrhoea",
    "gi_bleeding",
    "fever",
    "sore_throat",
    "rash",
    "dysuria",
    "head_injury",
    "fall",
    "laceration",
    "deformity",
    "burn",
    "bleeding",
    "pregnancy_related",
    "vaginal_bleeding",
    "poor_feeding",
    "lethargy",
    "irritability",
    "back_pain",
    "joint_pain",
    "fatigue",
    "anxiety",
    "allergic_reaction",
    "overdose",
    "self_harm",
    "eye_pain",
    "ear_pain",
    "dental_pain",
    "breast_lump",
    "urinary_retention",
    "indigestion",
    "nausea",
    "sweating",
    "malaise",
]

CONDITIONS: list[str] = [
    "diabetes",
    "coronary_artery_disease",
    "heart_failure",
    "copd",
    "asthma",
    "chronic_kidney_disease",
    "hypertension",
    "immunosuppression",
    "malignancy",
    "dementia",
    "pregnancy",
    "sickle_cell",
    "epilepsy",
]

AGE_BANDS: list[str] = [
    "neonate",
    "infant",
    "toddler",
    "child",
    "adolescent",
    "adult",
    "geriatric",
    "advanced_geriatric",
]

# Ordinal encoding: the bands are genuinely ordered, so a single ordinal feature
# lets a tree split on "younger than school age" in one cut instead of eight.
AGE_BAND_INDEX = {band: index for index, band in enumerate(AGE_BANDS)}

CUES: list[str] = [
    "diaphoresis",
    "guarding",
    "accessory_muscle_use",
    "unable_to_speak_full_sentences",
    "pallor",
    "cyanosis",
    "playful_and_consolable",
    "lethargic",
]

MEDICATION_FLAGS: list[str] = ["anticoagulant", "beta_blocker", "immunosuppressant"]

VITALS: list[str] = [
    "heart_rate",
    "respiratory_rate",
    "systolic_bp",
    "diastolic_bp",
    "spo2",
    "temperature_c",
    "gcs",
    "pain_score",
    "capillary_refill_sec",
    "blood_glucose",
]

# Deviation features, expressed relative to the age band's normal range.
DEVIATION_FEATURES: list[str] = [
    "hr_deviation",
    "rr_deviation",
    "sbp_deviation",
    "spo2_deviation",
    "temp_deviation",
]

DERIVED_FEATURES: list[str] = [
    "shock_index",
    "sbp_delta_pct_vs_baseline",
    "spo2_delta_vs_baseline",
    "missing_vital_count",
    "has_prior_record",
    "via_proxy",
    "age_years",
    "age_band_ordinal",
    "symptom_count",
]

FEATURE_NAMES: list[str] = (
    DERIVED_FEATURES
    + VITALS
    + DEVIATION_FEATURES
    + [f"cue_{cue}" for cue in CUES]
    + [f"med_{flag}" for flag in MEDICATION_FLAGS]
    + [f"symptom_{symptom}" for symptom in SYMPTOMS]
    + [f"condition_{condition}" for condition in CONDITIONS]
)

FEATURE_INDEX = {name: index for index, name in enumerate(FEATURE_NAMES)}

# Features whose absence materially weakens an assessment. Used by the backend's
# completeness score, which weighs a missing saturation far more heavily than a
# missing allergy list.
HIGH_VALUE_FEATURES: list[str] = [
    "heart_rate",
    "respiratory_rate",
    "systolic_bp",
    "spo2",
    "temperature_c",
    "gcs",
]


def _num(value: Any) -> float:
    """Coerce to float, mapping anything absent or unparseable to NaN."""
    if value is None:
        return math.nan
    if isinstance(value, bool):
        return float(value)
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return math.nan
    return parsed if math.isfinite(parsed) else math.nan


def _deviation(value: float, low: float | None, high: float | None) -> float:
    """Signed distance outside a normal range, scaled by the range width.

    Zero means "inside the normal range for this age". Positive means above it,
    negative below, and the magnitude is in units of the range width, so a value
    is comparable across vitals and across age bands. This is the feature that
    carries age calibration into the model.
    """
    if math.isnan(value) or low is None or high is None:
        return math.nan
    width = max(float(high) - float(low), 1e-6)
    if value < low:
        return (value - low) / width
    if value > high:
        return (value - high) / width
    return 0.0


def _threshold(thresholds: dict, vital: str, key: str) -> float | None:
    bounds = (thresholds or {}).get(vital) or {}
    value = bounds.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def build_feature_vector(payload: dict, thresholds: dict | None = None) -> np.ndarray:
    """Turn one clinical snapshot into the model's input vector.

    ``thresholds`` is the age-band table from the site protocol in force, passed in
    by the caller rather than held here, so the model normalises against the same
    numbers the rule engine used for the same patient.
    """
    thresholds = thresholds or {}
    vector = np.full(len(FEATURE_NAMES), np.nan, dtype=np.float32)

    def put(name: str, value: float) -> None:
        vector[FEATURE_INDEX[name]] = value

    vitals = payload.get("vitals") or {}
    baselines = payload.get("baselines") or {}
    cues = payload.get("cues") or {}
    medications = payload.get("medications") or {}
    symptoms = set(payload.get("symptoms") or [])
    conditions = set(payload.get("conditions") or [])

    # --- raw vitals, NaN where absent ---
    measured = 0
    for vital in VITALS:
        value = _num(vitals.get(vital))
        put(vital, value)
        if vital in HIGH_VALUE_FEATURES and not math.isnan(value):
            measured += 1
    put("missing_vital_count", float(len(HIGH_VALUE_FEATURES) - measured))

    hr = _num(vitals.get("heart_rate"))
    rr = _num(vitals.get("respiratory_rate"))
    sbp = _num(vitals.get("systolic_bp"))
    spo2 = _num(vitals.get("spo2"))
    temp = _num(vitals.get("temperature_c"))

    # --- age-relative deviations ---
    put("hr_deviation", _deviation(hr, _threshold(thresholds, "heartRate", "low"), _threshold(thresholds, "heartRate", "high")))
    put(
        "rr_deviation",
        _deviation(rr, _threshold(thresholds, "respiratoryRate", "low"), _threshold(thresholds, "respiratoryRate", "high")),
    )
    # Only a low systolic is pathological in triage, so the upper bound is open.
    sbp_low = _threshold(thresholds, "systolicBP", "low")
    put("sbp_deviation", _deviation(sbp, sbp_low, sbp_low + 60 if sbp_low else None))
    spo2_low = _threshold(thresholds, "spo2", "low")
    put("spo2_deviation", _deviation(spo2, spo2_low, 100.0) if spo2_low else math.nan)
    put(
        "temp_deviation",
        _deviation(
            temp,
            _threshold(thresholds, "temperatureC", "hypothermic"),
            _threshold(thresholds, "temperatureC", "fever"),
        ),
    )

    # --- derived ---
    put("shock_index", hr / sbp if not math.isnan(hr) and not math.isnan(sbp) and sbp > 0 else math.nan)

    baseline_sbp = _num(baselines.get("systolic_bp"))
    put(
        "sbp_delta_pct_vs_baseline",
        ((sbp - baseline_sbp) / baseline_sbp) * 100.0
        if not math.isnan(sbp) and not math.isnan(baseline_sbp) and baseline_sbp > 0
        else math.nan,
    )
    baseline_spo2 = _num(baselines.get("spo2"))
    put(
        "spo2_delta_vs_baseline",
        spo2 - baseline_spo2 if not math.isnan(spo2) and not math.isnan(baseline_spo2) else math.nan,
    )

    put("has_prior_record", 1.0 if payload.get("has_prior_record") else 0.0)
    put("via_proxy", 1.0 if payload.get("via_proxy") else 0.0)
    put("age_years", _num(payload.get("age_years")))
    put("age_band_ordinal", float(AGE_BAND_INDEX.get(payload.get("age_band", "adult"), 5)))
    put("symptom_count", float(len(symptoms)))

    # --- flags: absent means false, not unknown, so these are 0/1 rather than NaN ---
    for cue in CUES:
        put(f"cue_{cue}", 1.0 if cues.get(cue) else 0.0)
    for flag in MEDICATION_FLAGS:
        put(f"med_{flag}", 1.0 if medications.get(flag) else 0.0)
    for symptom in SYMPTOMS:
        put(f"symptom_{symptom}", 1.0 if symptom in symptoms else 0.0)
    for condition in CONDITIONS:
        put(f"condition_{condition}", 1.0 if condition in conditions else 0.0)

    return vector


def feature_spec() -> dict:
    """Serialisable description of the feature contract, written beside the model."""
    return {
        "featureNames": FEATURE_NAMES,
        "featureCount": len(FEATURE_NAMES),
        "vitals": VITALS,
        "symptoms": SYMPTOMS,
        "conditions": CONDITIONS,
        "cues": CUES,
        "medicationFlags": MEDICATION_FLAGS,
        "ageBands": AGE_BANDS,
        "highValueFeatures": HIGH_VALUE_FEATURES,
        "missingValuePolicy": "absent vitals are NaN and are learned as a split direction, never imputed",
    }
