"""Model loading, prediction, and per-feature explanation.

Explanations here are real SHAP contributions pulled out of the booster, not a
post-hoc story invented to look convincing. That distinction matters for the
workflow this system is built around: a nurse has seconds, and the only reason to
show her *why* a score was given is so she can disagree with it when the machine is
wrong. An explanation that does not actually reflect the computation would make
overrides harder to justify, not easier — she would be arguing with a caption
rather than with the model.

If the trained artifact is missing or XGBoost cannot be imported, scoring degrades
to a deterministic scorer rather than failing. Triage does not stop because a model
file is absent.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from .features import FEATURE_NAMES, build_feature_vector
from .protocol import MODELS_DIR

DEFAULT_ESCALATION_TAU = 0.30

#: Human-readable labels for the features a nurse might see in an explanation.
FEATURE_LABELS: dict[str, str] = {
    "heart_rate": "Heart rate",
    "respiratory_rate": "Respiratory rate",
    "systolic_bp": "Systolic blood pressure",
    "diastolic_bp": "Diastolic blood pressure",
    "spo2": "Oxygen saturation",
    "temperature_c": "Temperature",
    "gcs": "Glasgow Coma Scale",
    "pain_score": "Reported pain",
    "capillary_refill_sec": "Capillary refill",
    "blood_glucose": "Blood glucose",
    "hr_deviation": "Heart rate vs normal for age",
    "rr_deviation": "Respiratory rate vs normal for age",
    "sbp_deviation": "Blood pressure vs normal for age",
    "spo2_deviation": "Oxygen saturation vs normal for age",
    "temp_deviation": "Temperature vs normal for age",
    "shock_index": "Shock index",
    "sbp_delta_pct_vs_baseline": "Blood pressure vs patient's own baseline",
    "spo2_delta_vs_baseline": "Saturation vs patient's own baseline",
    "missing_vital_count": "Number of key vitals not yet measured",
    "has_prior_record": "Prior record available",
    "via_proxy": "History given by an attendant",
    "age_years": "Age",
    "age_band_ordinal": "Age band",
    "symptom_count": "Number of reported symptoms",
}


def _humanise(feature: str) -> str:
    if feature in FEATURE_LABELS:
        return FEATURE_LABELS[feature]
    for prefix, template in (
        ("symptom_", "Reported: {}"),
        ("condition_", "History of {}"),
        ("cue_", "Observed: {}"),
        ("med_", "On {}"),
    ):
        if feature.startswith(prefix):
            return template.format(feature[len(prefix):].replace("_", " "))
    return feature.replace("_", " ")


class TriageModel:
    """Wraps the trained booster, with a deterministic fallback path."""

    def __init__(self) -> None:
        self.model = None
        self.booster = None
        self.registry: dict[str, Any] = {}
        self.available = False
        self.unavailable_reason: str | None = None
        self._load()

    def _load(self) -> None:
        model_path = Path(MODELS_DIR) / "triage_model.json"
        registry_path = Path(MODELS_DIR) / "model_registry.json"

        if registry_path.exists():
            self.registry = json.loads(registry_path.read_text())

        if not model_path.exists():
            self.unavailable_reason = f"no trained model at {model_path}; run `python -m app.train`"
            return

        try:
            from xgboost import XGBClassifier
        except ImportError as exc:  # pragma: no cover - environment dependent
            self.unavailable_reason = f"xgboost unavailable ({exc})"
            return

        try:
            model = XGBClassifier()
            model.load_model(model_path)
            self.model = model
            self.booster = model.get_booster()
            self.available = True
        except Exception as exc:  # pragma: no cover - corrupt artifact
            self.unavailable_reason = f"failed to load model: {exc}"

    # ------------------------------------------------------------------ scoring

    def predict(self, payload: dict, thresholds: dict | None = None, tau: float | None = None) -> dict:
        """Score one encounter.

        Returns the full probability distribution, the escalation-aware decision,
        and the feature contributions behind it.
        """
        tau = DEFAULT_ESCALATION_TAU if tau is None else float(tau)
        vector = build_feature_vector(payload, thresholds)

        if not self.available:
            return self._deterministic(payload, vector, thresholds, tau)

        import xgboost as xgb

        matrix = xgb.DMatrix(vector.reshape(1, -1), feature_names=FEATURE_NAMES, missing=np.nan)
        probabilities = self.booster.predict(matrix)[0].astype(float)

        cumulative = np.cumsum(probabilities)
        reached = np.where(cumulative >= tau)[0]
        most_likely = int(probabilities.argmax() + 1)
        # Capped at the most likely class so the rule can only escalate — see
        # escalation_aware_predict in train.py for why this matters.
        threshold_choice = int(reached[0] + 1) if len(reached) else most_likely
        predicted = min(threshold_choice, most_likely)

        contributions = self._contributions(matrix, predicted - 1, vector)

        return {
            "esi": predicted,
            "mostLikelyESI": most_likely,
            "escalatedByDecisionRule": predicted < most_likely,
            "classProbabilities": [round(float(p), 5) for p in probabilities],
            "decisionRule": {"name": "escalation_aware_cumulative_probability", "tau": tau},
            "topContributions": contributions,
            "modelId": self.registry.get("modelId", "triagehandler-esi-xgb"),
            "modelVersion": self.registry.get("version", "unknown"),
            "mode": "model",
        }

    def _contributions(self, matrix, class_index: int, vector: np.ndarray, top_n: int = 8) -> list[dict]:
        """Real SHAP contributions for the predicted class."""
        try:
            raw = self.booster.predict(matrix, pred_contribs=True)
        except Exception:  # pragma: no cover - defensive
            return []

        array = np.asarray(raw)
        # Multiclass returns (n, n_class, n_features + 1); binary returns (n, n_features + 1).
        if array.ndim == 3:
            values = array[0, class_index, :-1]
        else:
            values = array[0, :-1]

        order = np.argsort(-np.abs(values))[:top_n]
        out = []
        for index in order:
            contribution = float(values[index])
            if abs(contribution) < 1e-6:
                continue
            name = FEATURE_NAMES[index]
            raw_value = float(vector[index])
            out.append(
                {
                    "feature": name,
                    "label": _humanise(name),
                    "value": None if math.isnan(raw_value) else round(raw_value, 3),
                    "missing": bool(math.isnan(raw_value)),
                    "contribution": round(contribution, 5),
                    "direction": "toward_urgent" if contribution > 0 else "toward_non_urgent",
                }
            )
        return out

    # -------------------------------------------------------------- degraded path

    def _deterministic(self, payload: dict, vector: np.ndarray, thresholds: dict | None, tau: float) -> dict:
        """Deterministic scorer used when the trained model is unavailable.

        Not a silent substitute: the response is labelled ``mode: "deterministic"``
        and carries the reason, so the backend lowers confidence and the dashboard
        can tell the nurse the assistant is running degraded. Scoring something
        badly while claiming full capability would be worse than not scoring at all.
        """
        thresholds = thresholds or {}
        vitals = payload.get("vitals") or {}
        symptoms = set(payload.get("symptoms") or [])

        score = 0.0
        reasons: list[dict] = []

        def bump(amount: float, feature: str, value) -> None:
            nonlocal score
            score += amount
            reasons.append(
                {
                    "feature": feature,
                    "label": _humanise(feature),
                    "value": value,
                    "missing": value is None,
                    "contribution": round(amount, 3),
                    "direction": "toward_urgent" if amount > 0 else "toward_non_urgent",
                }
            )

        def bound(vital: str, key: str):
            return ((thresholds or {}).get(vital) or {}).get(key)

        spo2 = vitals.get("spo2")
        if isinstance(spo2, (int, float)):
            critical = bound("spo2", "critical") or 90
            if spo2 < critical:
                bump(3.0 if spo2 < 85 else 2.0, "spo2", spo2)

        gcs = vitals.get("gcs")
        if isinstance(gcs, (int, float)) and gcs < 15:
            bump(3.0 if gcs <= 8 else 1.8, "gcs", gcs)

        hr = vitals.get("heart_rate")
        if isinstance(hr, (int, float)):
            high = bound("heartRate", "high")
            critical_high = bound("heartRate", "criticalHigh")
            if critical_high and hr > critical_high:
                bump(2.0, "heart_rate", hr)
            elif high and hr > high:
                bump(0.9, "heart_rate", hr)

        rr = vitals.get("respiratory_rate")
        if isinstance(rr, (int, float)):
            critical_high = bound("respiratoryRate", "criticalHigh")
            high = bound("respiratoryRate", "high")
            if critical_high and rr > critical_high:
                bump(2.0, "respiratory_rate", rr)
            elif high and rr > high:
                bump(0.8, "respiratory_rate", rr)

        sbp = vitals.get("systolic_bp")
        if isinstance(sbp, (int, float)):
            low = bound("systolicBP", "low")
            critical_low = bound("systolicBP", "criticalLow")
            if critical_low and sbp < critical_low:
                bump(2.5, "systolic_bp", sbp)
            elif low and sbp < low:
                bump(1.2, "systolic_bp", sbp)

        pain = vitals.get("pain_score")
        if isinstance(pain, (int, float)) and pain >= 7:
            bump(1.0, "pain_score", pain)

        high_risk = {"chest_pain", "facial_droop", "unilateral_weakness", "speech_difficulty", "seizure", "overdose"}
        for symptom in sorted(symptoms & high_risk):
            bump(1.2, f"symptom_{symptom}", 1)

        missing = int(vector[FEATURE_NAMES.index("missing_vital_count")])
        if missing >= 3:
            # Missing data pushes toward caution, never away from it.
            bump(0.8, "missing_vital_count", missing)

        if score >= 4.5:
            esi = 1
        elif score >= 2.5:
            esi = 2
        elif score >= 1.0:
            esi = 3
        elif score > 0:
            esi = 4
        else:
            esi = 4  # never 5 without a model: absence of evidence is not evidence

        distribution = [0.0] * 5
        distribution[esi - 1] = 0.6
        if esi > 1:
            distribution[esi - 2] = 0.25
        if esi < 5:
            distribution[esi] = 0.15

        reasons.sort(key=lambda r: -abs(r["contribution"]))
        return {
            "esi": esi,
            "mostLikelyESI": esi,
            "escalatedByDecisionRule": False,
            "classProbabilities": [round(p, 5) for p in distribution],
            "decisionRule": {"name": "deterministic_weighted_score", "tau": tau},
            "topContributions": reasons[:8],
            "modelId": "deterministic-fallback",
            "modelVersion": "1.0.0",
            "mode": "deterministic",
            "unavailableReason": self.unavailable_reason,
        }

    def info(self) -> dict:
        return {
            "available": self.available,
            "unavailableReason": self.unavailable_reason,
            "modelId": self.registry.get("modelId"),
            "version": self.registry.get("version"),
            "trainedAt": self.registry.get("trainedAt"),
            "trainingRowCount": self.registry.get("trainingRowCount"),
            "trainingDataHash": self.registry.get("trainingDataHash"),
            "decisionRule": self.registry.get("decisionRule"),
            "metrics": self.registry.get("metrics"),
            "metricsArgmaxBaseline": self.registry.get("metricsArgmaxBaseline"),
            "escalationThresholdSweep": self.registry.get("escalationThresholdSweep"),
            "perBandMetrics": self.registry.get("perBandMetrics"),
            "underTriageByArchetype": self.registry.get("underTriageByArchetype"),
            "limitations": self.registry.get("limitations", []),
            "featureCount": len(FEATURE_NAMES),
        }


_model: TriageModel | None = None


def get_model() -> TriageModel:
    global _model
    if _model is None:
        _model = TriageModel()
    return _model
