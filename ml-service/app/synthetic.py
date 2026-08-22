"""Synthetic emergency department encounters for training and evaluation.

The generator is built around one decision: the label is *not* the rule engine's
output. If it were, the model would learn to imitate the rules and would add
nothing — a very accurate way of computing something we already compute
deterministically, and worse, it would inherit every blind spot the rules have.

Instead each encounter starts from a latent clinical truth: a presentation
archetype and a true severity. Observable findings are then *generated from* that
truth, with noise, with age-appropriate physiology, and with realistic gaps in what
anyone got round to measuring. The model's job is to recover the latent severity
from an incomplete, noisy view of it. That is a genuinely different task from
applying thresholds, which is why the hybrid is worth having.

Three kinds of realism are deliberately injected, because each one corresponds to a
failure mode named in the problem brief:

* **Atypical presentation.** A proportion of cardiac and septic cases present
  without their textbook symptom — the elderly diabetic who infarcts without chest
  pain, the older patient who is septic without fever. These are the cases that get
  under-triaged in real departments.
* **Under-reported pain.** A proportion of patients report far less pain than their
  observed distress suggests. Stoicism, language and culture all cause it.
* **Missing data.** Roughly half of patients have no prior record, and many are
  scored before a full set of observations exists.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .features import build_feature_vector
from .protocol import load_reference_protocol, resolve_age_band, thresholds_for

# Probability weights over ESI 1..5 for each archetype.
Distribution = list[float]


@dataclass(frozen=True)
class Archetype:
    name: str
    esi_weights: Distribution
    band_weights: dict[str, float]
    #: symptom -> probability of being reported
    symptoms: dict[str, float] = field(default_factory=dict)
    #: chronic condition -> probability of being present
    conditions: dict[str, float] = field(default_factory=dict)
    #: vital -> (direction, weight) where weight scales with severity
    vitals: dict[str, tuple[str, float]] = field(default_factory=dict)
    #: observed cue -> probability, scaled by severity
    cues: dict[str, float] = field(default_factory=dict)
    #: typical self-reported pain at full severity
    pain_at_max: float = 5.0
    #: fraction of cases that hide their defining symptom
    atypical_rate: float = 0.0
    #: symptoms dropped when a case is atypical
    atypical_hides: tuple[str, ...] = ()
    #: share of total ED arrivals, so the training mix resembles a real department
    prevalence: float = 1.0


ALL_BANDS = {
    "neonate": 0.01,
    "infant": 0.05,
    "toddler": 0.09,
    "child": 0.09,
    "adolescent": 0.08,
    "adult": 0.44,
    "geriatric": 0.15,
    "advanced_geriatric": 0.09,
}
ADULT_UP = {"adult": 0.45, "geriatric": 0.33, "advanced_geriatric": 0.22}
PAEDIATRIC = {"neonate": 0.06, "infant": 0.24, "toddler": 0.34, "child": 0.24, "adolescent": 0.12}

ARCHETYPES: list[Archetype] = [
    Archetype(
        name="acute_coronary_syndrome",
        esi_weights=[0.22, 0.58, 0.20, 0.0, 0.0],
        band_weights=ADULT_UP,
        symptoms={"chest_pain": 0.82, "radiating_pain": 0.45, "sweating": 0.55, "nausea": 0.35, "dyspnoea": 0.40},
        conditions={"diabetes": 0.30, "coronary_artery_disease": 0.35, "hypertension": 0.45},
        vitals={"heart_rate": ("up", 0.55), "systolic_bp": ("down", 0.35), "respiratory_rate": ("up", 0.35)},
        cues={"diaphoresis": 0.6, "pallor": 0.35},
        pain_at_max=8.0,
        # The single most important pattern in this dataset: infarction that does
        # not announce itself.
        atypical_rate=0.28,
        atypical_hides=("chest_pain", "radiating_pain"),
        prevalence=0.05,
    ),
    Archetype(
        name="sepsis",
        esi_weights=[0.18, 0.52, 0.30, 0.0, 0.0],
        band_weights=ALL_BANDS,
        symptoms={"fever": 0.70, "malaise": 0.55, "cough": 0.30, "dysuria": 0.25, "confusion": 0.30},
        conditions={"diabetes": 0.25, "immunosuppression": 0.12, "malignancy": 0.10, "chronic_kidney_disease": 0.15},
        vitals={
            "heart_rate": ("up", 0.7),
            "respiratory_rate": ("up", 0.6),
            "systolic_bp": ("down", 0.55),
            "temperature_c": ("up", 0.8),
        },
        cues={"pallor": 0.3, "lethargic": 0.45},
        pain_at_max=4.0,
        # Older and immunosuppressed patients go hypothermic instead of febrile.
        atypical_rate=0.25,
        atypical_hides=("fever",),
        prevalence=0.04,
    ),
    Archetype(
        name="stroke",
        esi_weights=[0.28, 0.66, 0.06, 0.0, 0.0],
        band_weights=ADULT_UP,
        symptoms={"facial_droop": 0.7, "unilateral_weakness": 0.75, "speech_difficulty": 0.65, "confusion": 0.3},
        conditions={"hypertension": 0.6, "diabetes": 0.25, "coronary_artery_disease": 0.2},
        vitals={"systolic_bp": ("up", 0.6), "heart_rate": ("up", 0.2)},
        cues={},
        pain_at_max=2.0,
        prevalence=0.015,
    ),
    Archetype(
        name="respiratory_distress",
        esi_weights=[0.10, 0.44, 0.38, 0.08, 0.0],
        band_weights=ALL_BANDS,
        symptoms={"dyspnoea": 0.9, "wheeze": 0.55, "cough": 0.5},
        conditions={"asthma": 0.35, "copd": 0.3, "heart_failure": 0.15},
        vitals={"respiratory_rate": ("up", 0.8), "spo2": ("down", 0.75), "heart_rate": ("up", 0.5)},
        cues={"accessory_muscle_use": 0.6, "unable_to_speak_full_sentences": 0.45, "cyanosis": 0.12},
        pain_at_max=2.0,
        prevalence=0.08,
    ),
    Archetype(
        name="major_trauma",
        esi_weights=[0.33, 0.50, 0.17, 0.0, 0.0],
        band_weights=ALL_BANDS,
        symptoms={"bleeding": 0.6, "deformity": 0.45, "head_injury": 0.35, "fall": 0.4},
        conditions={},
        vitals={"heart_rate": ("up", 0.75), "systolic_bp": ("down", 0.7), "respiratory_rate": ("up", 0.45)},
        cues={"pallor": 0.5, "diaphoresis": 0.4},
        pain_at_max=8.5,
        prevalence=0.02,
    ),
    Archetype(
        name="minor_trauma",
        esi_weights=[0.0, 0.02, 0.18, 0.64, 0.16],
        band_weights=ALL_BANDS,
        symptoms={"laceration": 0.5, "deformity": 0.3, "fall": 0.35, "joint_pain": 0.3},
        conditions={},
        vitals={"heart_rate": ("up", 0.15)},
        cues={},
        pain_at_max=6.0,
        prevalence=0.12,
    ),
    Archetype(
        name="gastrointestinal",
        esi_weights=[0.0, 0.06, 0.44, 0.44, 0.06],
        band_weights=ALL_BANDS,
        symptoms={"abdominal_pain": 0.8, "vomiting": 0.5, "diarrhoea": 0.4, "nausea": 0.45},
        conditions={},
        vitals={"heart_rate": ("up", 0.35), "temperature_c": ("up", 0.25)},
        cues={"guarding": 0.35},
        pain_at_max=7.0,
        prevalence=0.11,
    ),
    Archetype(
        name="upper_respiratory_minor",
        esi_weights=[0.0, 0.0, 0.14, 0.36, 0.50],
        band_weights=ALL_BANDS,
        symptoms={"sore_throat": 0.6, "cough": 0.55, "fever": 0.3, "ear_pain": 0.15},
        conditions={},
        vitals={"temperature_c": ("up", 0.3)},
        cues={},
        pain_at_max=3.0,
        prevalence=0.12,
    ),
    Archetype(
        name="paediatric_febrile",
        esi_weights=[0.02, 0.24, 0.50, 0.21, 0.03],
        band_weights=PAEDIATRIC,
        symptoms={"fever": 0.9, "irritability": 0.4, "poor_feeding": 0.3, "lethargy": 0.25, "rash": 0.15},
        conditions={},
        vitals={"temperature_c": ("up", 0.75), "heart_rate": ("up", 0.5), "respiratory_rate": ("up", 0.4)},
        cues={"playful_and_consolable": 0.4, "lethargic": 0.3},
        pain_at_max=3.0,
        prevalence=0.08,
    ),
    Archetype(
        name="headache_neuro",
        esi_weights=[0.04, 0.28, 0.46, 0.20, 0.02],
        band_weights=ALL_BANDS,
        symptoms={"headache": 0.9, "visual_disturbance": 0.25, "vomiting": 0.25, "dizziness": 0.3},
        conditions={"hypertension": 0.25, "epilepsy": 0.08},
        vitals={"systolic_bp": ("up", 0.4)},
        cues={},
        pain_at_max=7.5,
        prevalence=0.07,
    ),
    Archetype(
        name="overdose_self_harm",
        esi_weights=[0.10, 0.58, 0.27, 0.05, 0.0],
        band_weights={"adolescent": 0.2, "adult": 0.65, "geriatric": 0.15},
        symptoms={"overdose": 0.6, "self_harm": 0.45, "confusion": 0.3, "vomiting": 0.25},
        conditions={},
        vitals={"heart_rate": ("up", 0.4), "respiratory_rate": ("down", 0.35), "gcs": ("down", 0.5)},
        cues={"lethargic": 0.4},
        pain_at_max=3.0,
        prevalence=0.03,
    ),
    Archetype(
        name="obstetric",
        esi_weights=[0.04, 0.38, 0.42, 0.16, 0.0],
        band_weights={"adolescent": 0.08, "adult": 0.92},
        symptoms={"pregnancy_related": 0.9, "abdominal_pain": 0.5, "vaginal_bleeding": 0.35, "headache": 0.25},
        conditions={"pregnancy": 1.0, "hypertension": 0.2},
        vitals={"systolic_bp": ("up", 0.45), "heart_rate": ("up", 0.3)},
        cues={},
        pain_at_max=6.5,
        prevalence=0.03,
    ),
    Archetype(
        # The hardest class in the dataset, and the one the brief is really about:
        # an older patient who is "just not themselves", with findings that barely
        # move. Deliberately overlaps with sepsis, stroke and ACS.
        name="geriatric_nonspecific",
        esi_weights=[0.04, 0.36, 0.42, 0.17, 0.01],
        band_weights={"geriatric": 0.45, "advanced_geriatric": 0.55},
        symptoms={"malaise": 0.6, "fatigue": 0.55, "confusion": 0.35, "dizziness": 0.3, "nausea": 0.2},
        conditions={"hypertension": 0.55, "diabetes": 0.3, "dementia": 0.25, "heart_failure": 0.2},
        vitals={"systolic_bp": ("down", 0.4), "heart_rate": ("up", 0.25), "temperature_c": ("down", 0.3)},
        cues={"lethargic": 0.35, "pallor": 0.25},
        pain_at_max=3.0,
        prevalence=0.06,
    ),
    Archetype(
        name="musculoskeletal",
        esi_weights=[0.0, 0.0, 0.20, 0.50, 0.30],
        band_weights=ALL_BANDS,
        symptoms={"back_pain": 0.55, "joint_pain": 0.5},
        conditions={},
        vitals={},
        cues={},
        pain_at_max=6.0,
        prevalence=0.1,
    ),
    Archetype(
        name="allergic_reaction",
        esi_weights=[0.08, 0.30, 0.40, 0.20, 0.02],
        band_weights=ALL_BANDS,
        symptoms={"allergic_reaction": 0.9, "rash": 0.6, "dyspnoea": 0.3, "stridor": 0.12},
        conditions={"asthma": 0.2},
        vitals={"heart_rate": ("up", 0.45), "spo2": ("down", 0.35), "systolic_bp": ("down", 0.3)},
        cues={},
        pain_at_max=2.0,
        prevalence=0.04,
    ),
    Archetype(
        name="syncope",
        esi_weights=[0.04, 0.38, 0.46, 0.12, 0.0],
        band_weights=ADULT_UP,
        symptoms={"syncope": 0.85, "dizziness": 0.5, "palpitations": 0.3},
        conditions={"coronary_artery_disease": 0.2, "hypertension": 0.3},
        vitals={"heart_rate": ("up", 0.35), "systolic_bp": ("down", 0.45)},
        cues={"pallor": 0.4},
        pain_at_max=2.0,
        prevalence=0.04,
    ),
]

# Global rates, chosen to match the brief's stated assumptions.
PRIOR_RECORD_RATE = 0.5
UNDER_REPORTED_PAIN_RATE = 0.18
PROXY_HISTORY_RATE = 0.12

# How complete the observation set is at the moment of scoring.
COMPLETENESS_STATES = [
    ("full", 0.58),        # a full set of observations
    ("partial", 0.27),     # mid-triage, some vitals taken
    ("minimal", 0.15),     # just arrived, essentially nothing measured
]

_VITAL_KEYS = {
    "heart_rate": "heartRate",
    "respiratory_rate": "respiratoryRate",
    "systolic_bp": "systolicBP",
    "spo2": "spo2",
    "temperature_c": "temperatureC",
}


def _weighted_choice(rng: np.random.Generator, options: dict[str, float]) -> str:
    keys = list(options.keys())
    weights = np.array([options[k] for k in keys], dtype=float)
    weights = weights / weights.sum()
    return str(rng.choice(keys, p=weights))


def _sample_age(rng: np.random.Generator, band: str, protocol: dict) -> float:
    for entry in protocol["ageBands"]:
        if entry["band"] != band:
            continue
        low = float(entry["minYears"])
        high = float(entry["maxYears"]) if entry["maxYears"] is not None else 95.0
        # Bias adult and geriatric samples toward the middle of the band.
        if band in ("adult", "geriatric", "advanced_geriatric"):
            return float(np.clip(rng.normal((low + high) / 2, (high - low) / 5), low, high - 1e-6))
        return float(rng.uniform(low, high))
    return 40.0


def _derange(
    rng: np.random.Generator,
    thresholds: dict,
    vital: str,
    direction: str,
    weight: float,
    severity: float,
) -> float:
    """Produce a value for one vital, pushed away from normal in proportion to severity."""
    bounds = thresholds.get(_VITAL_KEYS.get(vital, vital), {}) or {}

    if vital == "spo2":
        normal = rng.uniform(96, 100)
        floor = 78.0
        value = normal - (normal - floor) * weight * severity * rng.uniform(0.6, 1.15)
        return float(np.clip(value, 60, 100))

    if vital == "temperature_c":
        normal = rng.normal(36.8, 0.25)
        if direction == "up":
            value = normal + (40.6 - normal) * weight * severity * rng.uniform(0.5, 1.1)
        else:
            value = normal - (normal - 34.8) * weight * severity * rng.uniform(0.5, 1.1)
        return float(np.clip(value, 34.0, 41.5))

    if vital == "gcs":
        value = 15 - round(12 * weight * severity * rng.uniform(0.4, 1.2))
        return float(np.clip(value, 3, 15))

    low = bounds.get("low")
    high = bounds.get("high")
    critical_low = bounds.get("criticalLow")
    critical_high = bounds.get("criticalHigh")
    if low is None or high is None:
        return float("nan")

    normal = rng.uniform(low, high)
    if direction == "up":
        ceiling = float(critical_high if critical_high is not None else high * 1.5) * 1.15
        value = normal + (ceiling - normal) * weight * severity * rng.uniform(0.5, 1.15)
    else:
        floor = float(critical_low if critical_low is not None else low * 0.6) * 0.85
        value = normal - (normal - floor) * weight * severity * rng.uniform(0.5, 1.15)
    return float(max(value, 1.0))


def _normal_vital(rng: np.random.Generator, thresholds: dict, vital: str) -> float:
    """A value inside the normal range for this age band."""
    if vital == "spo2":
        return float(rng.uniform(96, 100))
    if vital == "temperature_c":
        return float(rng.normal(36.8, 0.3))
    if vital == "gcs":
        return 15.0
    bounds = thresholds.get(_VITAL_KEYS.get(vital, vital), {}) or {}
    low, high = bounds.get("low"), bounds.get("high")
    if low is None or high is None:
        return float("nan")
    return float(rng.uniform(low, high))


#: Normalised case mix. Sampling archetypes uniformly would produce a department
#: made mostly of strokes and infarctions; a real ED is dominated by minor trauma,
#: gastrointestinal complaints and upper respiratory infection, which is what makes
#: ESI 3 the crowded, ambiguous middle that surge triage actually struggles with.
_PREVALENCE = np.array([a.prevalence for a in ARCHETYPES], dtype=float)
_PREVALENCE = _PREVALENCE / _PREVALENCE.sum()


def generate_encounter(rng: np.random.Generator, protocol: dict) -> dict[str, Any]:
    """One synthetic encounter, with its latent truth attached."""
    archetype = ARCHETYPES[int(rng.choice(len(ARCHETYPES), p=_PREVALENCE))]

    weights = np.array(archetype.esi_weights, dtype=float)
    true_esi = int(rng.choice([1, 2, 3, 4, 5], p=weights / weights.sum()))
    severity = (5 - true_esi) / 4.0

    band = _weighted_choice(rng, archetype.band_weights)
    age_years = _sample_age(rng, band, protocol)
    band = resolve_age_band(protocol, age_years)
    thresholds = thresholds_for(protocol, band)

    is_atypical = bool(rng.random() < archetype.atypical_rate)

    # --- symptoms ---
    symptoms: set[str] = set()
    for symptom, probability in archetype.symptoms.items():
        if is_atypical and symptom in archetype.atypical_hides:
            continue
        # More severe presentations report their symptoms more reliably.
        if rng.random() < probability * (0.7 + 0.4 * severity):
            symptoms.add(symptom)

    # A hypothermic septic patient is the atypical form, not simply an afebrile one.
    if is_atypical and archetype.name == "sepsis":
        archetype_vitals = dict(archetype.vitals)
        archetype_vitals["temperature_c"] = ("down", 0.55)
    else:
        archetype_vitals = archetype.vitals

    conditions = {c for c, p in archetype.conditions.items() if rng.random() < p}

    # --- vitals ---
    vitals: dict[str, float] = {}
    for vital in ("heart_rate", "respiratory_rate", "systolic_bp", "spo2", "temperature_c", "gcs"):
        if vital in archetype_vitals:
            direction, weight = archetype_vitals[vital]
            vitals[vital] = _derange(rng, thresholds, vital, direction, weight, severity)
        else:
            vitals[vital] = _normal_vital(rng, thresholds, vital)

    if not np.isnan(vitals.get("systolic_bp", float("nan"))):
        vitals["diastolic_bp"] = float(vitals["systolic_bp"] * rng.uniform(0.55, 0.72))

    # Capillary refill lengthens with poor perfusion, and is the paediatric tell.
    vitals["capillary_refill_sec"] = float(
        np.clip(rng.normal(1.6, 0.4) + 3.2 * severity * rng.uniform(0.2, 1.0), 0.5, 7.0)
    )

    # --- pain, including deliberate under-reporting ---
    true_pain = float(np.clip(archetype.pain_at_max * severity + rng.normal(0, 1.2), 0, 10))
    under_reports = bool(rng.random() < UNDER_REPORTED_PAIN_RATE)
    reported_pain = float(np.clip(true_pain * rng.uniform(0.2, 0.45), 0, 10)) if under_reports else true_pain
    vitals["pain_score"] = round(reported_pain)

    if "diabetes" in conditions and rng.random() < 0.3:
        vitals["blood_glucose"] = float(np.clip(rng.normal(180, 90), 35, 500))

    # --- observed cues; objective distress still shows even when pain is downplayed ---
    cues: dict[str, bool] = {}
    for cue, probability in archetype.cues.items():
        cues[cue] = bool(rng.random() < probability * (0.5 + 0.7 * severity))
    if under_reports and true_pain >= 6:
        cues["guarding"] = True
        if rng.random() < 0.6:
            cues["diaphoresis"] = True

    # --- prior record and baselines ---
    has_prior_record = bool(rng.random() < PRIOR_RECORD_RATE)
    baselines: dict[str, float] = {}
    if has_prior_record:
        if "hypertension" in conditions:
            baselines["systolic_bp"] = float(rng.normal(152, 12))
        else:
            baselines["systolic_bp"] = float(rng.normal(126, 10))
        baselines["spo2"] = float(rng.normal(91, 2.5) if "copd" in conditions else rng.normal(97, 1.2))

    medications = {
        "anticoagulant": bool(
            rng.random() < (0.32 if band in ("geriatric", "advanced_geriatric") else 0.06)
        ),
        "beta_blocker": bool(rng.random() < (0.30 if "coronary_artery_disease" in conditions else 0.08)),
        "immunosuppressant": bool(rng.random() < (0.55 if "immunosuppression" in conditions else 0.02)),
    }

    # --- how much was actually measured at the moment of scoring ---
    state = str(
        rng.choice([s for s, _ in COMPLETENESS_STATES], p=[p for _, p in COMPLETENESS_STATES])
    )
    if state == "minimal":
        keep = {"pain_score"}
        if rng.random() < 0.4:
            keep.add("heart_rate")
        vitals = {k: v for k, v in vitals.items() if k in keep}
    elif state == "partial":
        for vital in list(vitals):
            if vital in ("gcs", "capillary_refill_sec", "blood_glucose", "diastolic_bp") and rng.random() < 0.6:
                vitals.pop(vital, None)
            elif rng.random() < 0.25:
                vitals.pop(vital, None)
    else:
        # Even a "full" set is missing the occasional item in a real department.
        for vital in list(vitals):
            if vital in ("blood_glucose", "gcs") and rng.random() < 0.5:
                vitals.pop(vital, None)

    via_proxy = bool(rng.random() < PROXY_HISTORY_RATE)

    return {
        "age_years": round(age_years, 3),
        "age_band": band,
        "vitals": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in vitals.items() if v == v},
        "baselines": {k: round(v, 2) for k, v in baselines.items()},
        "cues": cues,
        "symptoms": sorted(symptoms),
        "conditions": sorted(conditions),
        "medications": medications,
        "has_prior_record": has_prior_record,
        "via_proxy": via_proxy,
        "_truth": {
            "esi": true_esi,
            "archetype": archetype.name,
            "atypical": is_atypical,
            "under_reported_pain": under_reports,
            "true_pain": round(true_pain, 1),
            "completeness": state,
        },
        "_thresholds": thresholds,
    }


def generate_dataset(n: int = 12000, seed: int = 20260822) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Build a feature matrix, labels, and the raw encounters behind them."""
    rng = np.random.default_rng(seed)
    protocol = load_reference_protocol()

    encounters = [generate_encounter(rng, protocol) for _ in range(n)]
    features = np.vstack(
        [build_feature_vector(enc, enc["_thresholds"]) for enc in encounters]
    ).astype(np.float32)
    labels = np.array([enc["_truth"]["esi"] for enc in encounters], dtype=np.int32)
    return features, labels, encounters


def dataset_hash(features: np.ndarray, labels: np.ndarray) -> str:
    """Content hash of a training set, recorded in the model registry."""
    digest = hashlib.sha256()
    digest.update(np.ascontiguousarray(np.nan_to_num(features, nan=-9999.0)).tobytes())
    digest.update(np.ascontiguousarray(labels).tobytes())
    return digest.hexdigest()


def summarise(encounters: list[dict]) -> dict[str, Any]:
    """Distribution summary, written into the model registry for transparency."""
    from collections import Counter

    esi = Counter(e["_truth"]["esi"] for e in encounters)
    bands = Counter(e["age_band"] for e in encounters)
    archetypes = Counter(e["_truth"]["archetype"] for e in encounters)
    total = len(encounters)

    return {
        "rows": total,
        "esiDistribution": {str(k): esi[k] for k in sorted(esi)},
        "ageBandDistribution": dict(sorted(bands.items())),
        "archetypeDistribution": dict(sorted(archetypes.items())),
        "priorRecordRate": round(sum(e["has_prior_record"] for e in encounters) / total, 3),
        "atypicalRate": round(sum(e["_truth"]["atypical"] for e in encounters) / total, 3),
        "underReportedPainRate": round(
            sum(e["_truth"]["under_reported_pain"] for e in encounters) / total, 3
        ),
        "completeness": dict(Counter(e["_truth"]["completeness"] for e in encounters)),
    }


if __name__ == "__main__":  # pragma: no cover - manual inspection helper
    _, _, sample = generate_dataset(2000)
    print(json.dumps(summarise(sample), indent=2))
