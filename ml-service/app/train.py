"""Train the ESI risk model.

The training objective is not accuracy. Accuracy averages over an asymmetric cost:
sending a well patient to a resuscitation bay wastes a bed, and sending a septic
patient to the waiting room can kill them. A model tuned for average accuracy will
happily trade the second error for the first because they count the same, and the
resulting system is more dangerous than the one it replaced.

Two mechanisms bias this model toward escalation, and both are measured rather than
asserted:

1. **Asymmetric sample weights.** Training examples whose true severity is high are
   weighted up, so the loss function itself finds under-triage expensive.

2. **An escalation-aware decision rule.** At inference the predicted class is not
   ``argmax``. It is the most urgent level ``c`` for which the model's cumulative
   probability ``P(ESI <= c)`` reaches a threshold. If there is a 30% chance a
   patient is ESI 2 or worse, they are treated as ESI 2. This converts the model's
   own uncertainty into caution instead of averaging it away.

The evaluation reports both decision rules side by side so the safety claim is
checkable: what argmax would have missed, and what the escalation rule catches, at
what cost in over-triage.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier

from .features import FEATURE_NAMES, feature_spec
from .protocol import MODELS_DIR, pin_reference_protocol
from .synthetic import ARCHETYPES, dataset_hash, generate_dataset, summarise

MODEL_ID = "triagehandler-esi-xgb"
MODEL_VERSION = "1.0.0"

#: Cumulative-probability threshold for the escalation-aware decision rule.
ESCALATION_TAU = 0.30

#: Extra loss weight by true severity. Missing an ESI 1 costs far more than
#: over-calling an ESI 5, and the weights say so explicitly.
URGENCY_WEIGHTS = {1: 6.0, 2: 3.5, 3: 1.4, 4: 1.0, 5: 1.0}


def escalation_aware_predict(probabilities: np.ndarray, tau: float = ESCALATION_TAU) -> np.ndarray:
    """Most urgent ESI whose cumulative probability reaches ``tau``.

    ``probabilities`` is (n, 5) with column 0 = ESI 1.

    The result is capped at argmax so the rule can only ever escalate. Without that
    cap the rule can de-escalate: given P(ESI 1) = 0.29 and P(ESI 3) = 0.70, the
    cumulative threshold is first crossed at ESI 2 even though ESI 1 is the single
    most likely class, and the "safety" rule would have quietly moved a patient
    *down* a level. Taking the more urgent of the two closes that hole.
    """
    cumulative = np.cumsum(probabilities, axis=1)
    reached = cumulative >= tau
    argmax = probabilities.argmax(axis=1)
    indices = np.where(reached.any(axis=1), reached.argmax(axis=1), argmax)
    return (np.minimum(indices, argmax) + 1).astype(int)


def _metrics(true: np.ndarray, predicted: np.ndarray) -> dict:
    """Triage-specific metrics. Under-triage means predicted less urgent than truth."""
    under = predicted > true
    over = predicted < true
    critical = np.isin(true, [1, 2])

    return {
        "accuracy": float((predicted == true).mean()),
        "underTriageRate": float(under.mean()),
        "overTriageRate": float(over.mean()),
        "criticalUnderTriageRate": float(under[critical].mean()) if critical.any() else 0.0,
        "meanAbsoluteError": float(np.abs(predicted - true).mean()),
        "exactOrEscalated": float((predicted <= true).mean()),
        # The worst case: a genuinely critical patient sent to a low-acuity queue.
        "criticalSentToLowAcuity": int(((true <= 2) & (predicted >= 4)).sum()),
    }


def _per_band_metrics(true: np.ndarray, predicted: np.ndarray, encounters: list[dict]) -> list[dict]:
    """A model can look excellent overall and be unusable on infants."""
    buckets: dict[str, list[int]] = defaultdict(list)
    for index, encounter in enumerate(encounters):
        buckets[encounter["age_band"]].append(index)

    rows = []
    for band, indices in sorted(buckets.items()):
        idx = np.array(indices)
        band_true, band_pred = true[idx], predicted[idx]
        under = band_pred > band_true
        rows.append(
            {
                "band": band,
                "support": int(len(idx)),
                "accuracy": float((band_pred == band_true).mean()),
                "underTriageRate": float(under.mean()),
                "overTriageRate": float((band_pred < band_true).mean()),
            }
        )
    return rows


def _per_archetype_under_triage(true: np.ndarray, predicted: np.ndarray, encounters: list[dict]) -> dict:
    """Which presentations the model misses, so the blind spots are published."""
    buckets: dict[str, list[int]] = defaultdict(list)
    for index, encounter in enumerate(encounters):
        buckets[encounter["_truth"]["archetype"]].append(index)

    out = {}
    for archetype, indices in sorted(buckets.items()):
        idx = np.array(indices)
        out[archetype] = round(float((predicted[idx] > true[idx]).mean()), 4)
    return out


def train(n_rows: int = 12000, seed: int = 20260822) -> dict:
    started = time.time()
    protocol = pin_reference_protocol()

    features, labels, encounters = generate_dataset(n_rows, seed=seed)
    data_hash = dataset_hash(features, labels)

    indices = np.arange(len(labels))
    train_idx, test_idx = train_test_split(indices, test_size=0.2, random_state=seed, stratify=labels)

    x_train, x_test = features[train_idx], features[test_idx]
    y_train, y_test = labels[train_idx], labels[test_idx]
    test_encounters = [encounters[i] for i in test_idx]

    sample_weight = np.array([URGENCY_WEIGHTS[int(y)] for y in y_train], dtype=np.float32)

    model = XGBClassifier(
        n_estimators=400,
        max_depth=5,
        learning_rate=0.08,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=3,
        reg_lambda=1.5,
        objective="multi:softprob",
        num_class=5,
        tree_method="hist",
        # Absent vitals arrive as NaN and XGBoost learns a default direction for
        # them. Nothing is imputed anywhere in this pipeline.
        missing=np.nan,
        random_state=seed,
        n_jobs=4,
        eval_metric="mlogloss",
    )
    model.fit(x_train, y_train - 1, sample_weight=sample_weight, verbose=False)

    probabilities = model.predict_proba(x_test)
    argmax_pred = probabilities.argmax(axis=1) + 1
    escalated_pred = escalation_aware_predict(probabilities)

    argmax_metrics = _metrics(y_test, argmax_pred)
    escalated_metrics = _metrics(y_test, escalated_pred)

    # How the escalation threshold trades safety against crowding.
    tau_sweep = []
    for tau in (0.2, 0.25, 0.3, 0.35, 0.4, 0.5):
        swept = escalation_aware_predict(probabilities, tau)
        swept_metrics = _metrics(y_test, swept)
        tau_sweep.append(
            {
                "tau": tau,
                "underTriageRate": round(swept_metrics["underTriageRate"], 4),
                "criticalUnderTriageRate": round(swept_metrics["criticalUnderTriageRate"], 4),
                "overTriageRate": round(swept_metrics["overTriageRate"], 4),
                "accuracy": round(swept_metrics["accuracy"], 4),
            }
        )

    importances = sorted(
        zip(FEATURE_NAMES, model.feature_importances_.tolist()), key=lambda pair: -pair[1]
    )[:25]

    registry = {
        "modelId": MODEL_ID,
        "version": MODEL_VERSION,
        "algorithm": "xgboost.XGBClassifier",
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "trainingDataHash": data_hash,
        "trainingRowCount": int(len(train_idx)),
        "testRowCount": int(len(test_idx)),
        "protocolPinned": {"siteId": protocol["siteId"], "version": protocol["version"]},
        "decisionRule": {
            "name": "escalation_aware_cumulative_probability",
            "tau": ESCALATION_TAU,
            "description": (
                "Predicted ESI is the most urgent level whose cumulative probability reaches tau, "
                "rather than the most likely level. Model uncertainty becomes caution."
            ),
        },
        "asymmetricCostMatrix": {"urgencyWeights": URGENCY_WEIGHTS},
        "metrics": escalated_metrics,
        "metricsArgmaxBaseline": argmax_metrics,
        "escalationThresholdSweep": tau_sweep,
        "perBandMetrics": _per_band_metrics(y_test, escalated_pred, test_encounters),
        "underTriageByArchetype": _per_archetype_under_triage(y_test, escalated_pred, test_encounters),
        "topFeatureImportances": [{"feature": f, "gain": round(g, 5)} for f, g in importances],
        "trainingDataSummary": summarise(encounters),
        "archetypeCount": len(ARCHETYPES),
        "limitations": [
            "Trained on synthetic encounters generated from clinical archetypes, not on real patient data. "
            "Absolute metrics describe the simulation, not a real department.",
            "Normalised against the reference site protocol; a site with substantially different "
            "thresholds should retrain rather than assume calibration transfers.",
            "Neonatal and infant coverage is thin relative to adults, which is declared per band and "
            "lowers confidence for those patients rather than being hidden.",
            "The model never sees a patient's trajectory, only a snapshot. Deterioration over time is "
            "handled by the re-triage loop, not by this model.",
        ],
        "trainingDurationSeconds": round(time.time() - started, 2),
    }

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model.save_model(MODELS_DIR / "triage_model.json")
    (MODELS_DIR / "feature_spec.json").write_text(json.dumps(feature_spec(), indent=2))
    (MODELS_DIR / "model_registry.json").write_text(json.dumps(registry, indent=2))

    return registry


def _print_report(registry: dict) -> None:
    escalated = registry["metrics"]
    argmax = registry["metricsArgmaxBaseline"]

    print(f"\n  model {registry['modelId']} v{registry['version']}")
    print(f"  trained on {registry['trainingRowCount']} rows, tested on {registry['testRowCount']}")
    print(f"  duration {registry['trainingDurationSeconds']}s\n")

    print("  decision rule            argmax     escalation-aware")
    print("  " + "-" * 52)
    for key, label in [
        ("accuracy", "accuracy"),
        ("underTriageRate", "under-triage rate"),
        ("criticalUnderTriageRate", "critical under-triage"),
        ("overTriageRate", "over-triage rate"),
        ("meanAbsoluteError", "mean abs error"),
    ]:
        print(f"  {label:<24} {argmax[key]:>7.4f}     {escalated[key]:>7.4f}")
    print(
        f"  {'critical -> low acuity':<24} {argmax['criticalSentToLowAcuity']:>7}     "
        f"{escalated['criticalSentToLowAcuity']:>7}"
    )

    print("\n  per age band (escalation-aware):")
    for row in registry["perBandMetrics"]:
        print(
            f"    {row['band']:<20} n={row['support']:<5} acc={row['accuracy']:.3f}  "
            f"under={row['underTriageRate']:.3f}"
        )

    print("\n  under-triage by presentation:")
    for archetype, rate in sorted(registry["underTriageByArchetype"].items(), key=lambda p: -p[1])[:6]:
        print(f"    {archetype:<28} {rate:.3f}")

    print("\n  top features:")
    for entry in registry["topFeatureImportances"][:10]:
        print(f"    {entry['feature']:<30} {entry['gain']:.4f}")
    print()


if __name__ == "__main__":
    _print_report(train())
    print(f"  artifacts written to {Path(MODELS_DIR).resolve()}\n")
