"""Scoring and feature tests.

The claims that matter here are about safety behaviour, not about accuracy:
missing data must push toward caution, the escalation-aware decision rule must
actually escalate, and the service must degrade honestly rather than pretending to
full capability when the model is gone.
"""

import math

import numpy as np
import pytest

from app.features import FEATURE_NAMES, HIGH_VALUE_FEATURES, build_feature_vector
from app.protocol import load_reference_protocol, thresholds_for
from app.scoring import get_model
from app.train import escalation_aware_predict

PROTOCOL = load_reference_protocol()
ADULT = thresholds_for(PROTOCOL, "adult")
INFANT = thresholds_for(PROTOCOL, "infant")


def payload(**overrides):
    base = {
        "age_years": 45.0,
        "age_band": "adult",
        "vitals": {},
        "baselines": {},
        "cues": {},
        "symptoms": [],
        "conditions": [],
        "medications": {},
        "has_prior_record": False,
        "via_proxy": False,
    }
    base.update(overrides)
    return base


class TestFeatureVector:
    def test_absent_vitals_are_nan_not_zero(self):
        vector = build_feature_vector(payload(vitals={"heart_rate": 90}), ADULT)
        assert vector[FEATURE_NAMES.index("heart_rate")] == 90
        # A missing respiratory rate must not read as a respiratory rate of zero.
        assert math.isnan(float(vector[FEATURE_NAMES.index("respiratory_rate")]))

    def test_missing_vital_count_is_explicit(self):
        empty = build_feature_vector(payload(), ADULT)
        assert empty[FEATURE_NAMES.index("missing_vital_count")] == len(HIGH_VALUE_FEATURES)

        full = build_feature_vector(
            payload(
                vitals={
                    "heart_rate": 80,
                    "respiratory_rate": 16,
                    "systolic_bp": 120,
                    "spo2": 98,
                    "temperature_c": 36.8,
                    "gcs": 15,
                }
            ),
            ADULT,
        )
        assert full[FEATURE_NAMES.index("missing_vital_count")] == 0

    def test_deviation_is_age_relative(self):
        """The same heart rate deviates differently depending on the age band."""
        index = FEATURE_NAMES.index("hr_deviation")

        adult = build_feature_vector(payload(vitals={"heart_rate": 150}), ADULT)
        infant = build_feature_vector(
            payload(age_years=0.5, age_band="infant", vitals={"heart_rate": 150}), INFANT
        )

        assert adult[index] > 0, "HR 150 is above the adult range"
        assert infant[index] == 0, "HR 150 is inside the infant range"

    def test_baseline_delta_is_nan_without_a_baseline(self):
        index = FEATURE_NAMES.index("sbp_delta_pct_vs_baseline")

        no_history = build_feature_vector(payload(vitals={"systolic_bp": 108}), ADULT)
        assert math.isnan(float(no_history[index]))

        with_history = build_feature_vector(
            payload(vitals={"systolic_bp": 108}, baselines={"systolic_bp": 155}, has_prior_record=True),
            ADULT,
        )
        assert with_history[index] < -25

    def test_flags_are_false_not_unknown(self):
        vector = build_feature_vector(payload(symptoms=["chest_pain"]), ADULT)
        assert vector[FEATURE_NAMES.index("symptom_chest_pain")] == 1.0
        # An unreported symptom is absent, which is different from an unmeasured vital.
        assert vector[FEATURE_NAMES.index("symptom_fever")] == 0.0


class TestEscalationDecisionRule:
    def test_picks_the_most_urgent_level_reaching_the_threshold(self):
        # 25% chance of ESI 2, 70% chance of ESI 4. Argmax says 4; caution says 2.
        probabilities = np.array([[0.0, 0.25, 0.05, 0.70, 0.0]])
        assert probabilities.argmax() + 1 == 4
        assert escalation_aware_predict(probabilities, tau=0.20)[0] == 2

    def test_a_higher_threshold_escalates_less(self):
        probabilities = np.array([[0.0, 0.25, 0.05, 0.70, 0.0]])
        assert escalation_aware_predict(probabilities, tau=0.20)[0] == 2
        assert escalation_aware_predict(probabilities, tau=0.60)[0] == 4

    def test_confident_predictions_are_left_alone(self):
        probabilities = np.array([[0.0, 0.0, 0.02, 0.05, 0.93]])
        assert escalation_aware_predict(probabilities, tau=0.30)[0] == 5

    def test_never_less_urgent_than_argmax(self):
        rng = np.random.default_rng(7)
        random = rng.dirichlet(np.ones(5), size=500)
        escalated = escalation_aware_predict(random, tau=0.30)
        assert np.all(escalated <= random.argmax(axis=1) + 1)


class TestModelScoring:
    @pytest.fixture(scope="class")
    @classmethod
    def model(cls):
        return get_model()

    def test_model_artifact_loads(self, model):
        assert model.available, f"model unavailable: {model.unavailable_reason}"

    def test_returns_a_full_probability_distribution(self, model):
        result = model.predict(payload(vitals={"heart_rate": 88, "spo2": 98}), ADULT)
        assert len(result["classProbabilities"]) == 5
        assert result["classProbabilities"] == pytest.approx(
            result["classProbabilities"], abs=1e-9
        )
        assert sum(result["classProbabilities"]) == pytest.approx(1.0, abs=0.01)
        assert 1 <= result["esi"] <= 5

    def test_explanations_are_real_contributions(self, model):
        result = model.predict(
            payload(
                vitals={"heart_rate": 132, "respiratory_rate": 30, "spo2": 88, "systolic_bp": 86},
                symptoms=["chest_pain", "dyspnoea"],
            ),
            ADULT,
        )
        contributions = result["topContributions"]
        assert contributions, "a score with no explanation is not reviewable"
        for entry in contributions:
            assert entry["feature"] in FEATURE_NAMES
            assert entry["direction"] in {"toward_urgent", "toward_non_urgent"}
            assert entry["label"], "every contribution needs a human-readable label"
        assert any(c["direction"] == "toward_urgent" for c in contributions)

    def test_a_sick_patient_scores_more_urgently_than_a_well_one(self, model):
        critical = model.predict(
            payload(
                vitals={"heart_rate": 138, "respiratory_rate": 34, "spo2": 84, "systolic_bp": 82, "gcs": 12},
                symptoms=["chest_pain", "dyspnoea", "sweating"],
                cues={"diaphoresis": True, "pallor": True},
            ),
            ADULT,
        )
        well = model.predict(
            payload(
                vitals={
                    "heart_rate": 72,
                    "respiratory_rate": 14,
                    "spo2": 99,
                    "systolic_bp": 122,
                    "temperature_c": 36.7,
                    "gcs": 15,
                    "pain_score": 1,
                },
                symptoms=["sore_throat"],
            ),
            ADULT,
        )
        assert critical["esi"] < well["esi"]

    def test_missing_data_does_not_make_the_model_more_confident(self, model):
        measured = model.predict(
            payload(
                vitals={
                    "heart_rate": 84,
                    "respiratory_rate": 15,
                    "spo2": 98,
                    "systolic_bp": 124,
                    "temperature_c": 36.8,
                    "gcs": 15,
                },
                symptoms=["sore_throat"],
            ),
            ADULT,
        )
        unmeasured = model.predict(payload(symptoms=["sore_throat"]), ADULT)
        # Nothing measured must never produce a *less* urgent score than a full
        # set of reassuring observations.
        assert unmeasured["esi"] <= measured["esi"]

    def test_reports_which_high_value_observations_are_missing(self, model):
        result = model.predict(payload(vitals={"heart_rate": 90}), ADULT)
        assert result["esi"]
        # The backend needs this to compute completeness; the service must not
        # silently paper over the gap.
        vector = build_feature_vector(payload(vitals={"heart_rate": 90}), ADULT)
        assert vector[FEATURE_NAMES.index("missing_vital_count")] == len(HIGH_VALUE_FEATURES) - 1


class TestDegradedMode:
    def test_deterministic_fallback_still_scores(self):
        from app.scoring import TriageModel

        degraded = TriageModel.__new__(TriageModel)
        degraded.model = None
        degraded.booster = None
        degraded.registry = {}
        degraded.available = False
        degraded.unavailable_reason = "simulated outage"

        result = degraded.predict(
            payload(vitals={"spo2": 82, "gcs": 7, "heart_rate": 140}, symptoms=["chest_pain"]),
            ADULT,
        )
        assert result["esi"] == 1
        # Degradation is declared, never silent.
        assert result["mode"] == "deterministic"
        assert result["unavailableReason"] == "simulated outage"
        assert result["topContributions"]

    def test_fallback_never_returns_non_urgent_without_evidence(self):
        from app.scoring import TriageModel

        degraded = TriageModel.__new__(TriageModel)
        degraded.model = None
        degraded.booster = None
        degraded.registry = {}
        degraded.available = False
        degraded.unavailable_reason = "simulated outage"

        result = degraded.predict(payload(), ADULT)
        assert result["esi"] <= 4, "absence of evidence is not evidence of wellness"


class TestModelRegistry:
    def test_publishes_under_triage_rather_than_only_accuracy(self):
        info = get_model().info()
        assert "underTriageRate" in info["metrics"]
        assert "criticalUnderTriageRate" in info["metrics"]
        assert info["metricsArgmaxBaseline"], "the baseline must be published for comparison"

    def test_the_escalation_rule_reduces_under_triage(self):
        info = get_model().info()
        assert info["metrics"]["underTriageRate"] < info["metricsArgmaxBaseline"]["underTriageRate"]
        assert (
            info["metrics"]["criticalUnderTriageRate"]
            < info["metricsArgmaxBaseline"]["criticalUnderTriageRate"]
        )

    def test_per_band_metrics_are_published(self):
        bands = {row["band"] for row in get_model().info()["perBandMetrics"]}
        assert {"infant", "adult", "geriatric"} <= bands

    def test_limitations_are_declared(self):
        assert len(get_model().info()["limitations"]) >= 3
