"""Export a labelled synthetic evaluation set for end-to-end fusion scoring.

The model's own metrics describe the model alone. What a safety case actually
needs is the behaviour of the whole assembled system — rule engine, model,
confidence and the escalation ratchet together — because that is what reaches a
patient. Those layers live in JavaScript, so this dumps the same generator's
encounters, with their latent ground-truth severity attached, for the Node-side
harness to score.

The rows are drawn from the held-out tail of the generator's sequence using a
different seed from training, so the fused evaluation is not being run over
examples the model was fitted on.

Usage:  python -m app.export_eval_set [n] [out.json]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from .protocol import load_reference_protocol, thresholds_for
from .synthetic import generate_encounter

EVAL_SEED = 90210  # deliberately not the training seed


def export(n: int = 1500, seed: int = EVAL_SEED) -> list[dict]:
    rng = np.random.default_rng(seed)
    protocol = load_reference_protocol()

    rows = []
    for _ in range(n):
        encounter = generate_encounter(rng, protocol)
        truth = encounter.pop("_truth")
        encounter.pop("_thresholds", None)
        rows.append(
            {
                **encounter,
                "thresholds": thresholds_for(protocol, encounter["age_band"]),
                "truthESI": truth["esi"],
                "archetype": truth["archetype"],
                "atypical": truth["atypical"],
                "underReportedPain": truth["under_reported_pain"],
                "completeness": truth["completeness"],
            }
        )
    return rows


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("models/eval_set.json")
    rows = export(n)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows))
    print(f"  wrote {len(rows)} labelled encounters to {out}")


if __name__ == "__main__":
    main()
