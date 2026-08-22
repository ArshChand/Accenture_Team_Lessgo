"""Access to the clinical protocol from the Python side.

The backend owns the protocol: it is authored, validated and guarded there. The ML
service needs the same age-band tables to normalise features, so rather than
keeping a second hand-maintained copy, training reads the backend's document and
pins a copy next to the model artifact.

That pinned copy is deliberate. A model is only interpretable against the
thresholds it was normalised with, so the copy records what the model was actually
trained on. At inference the caller passes the thresholds in force for that
patient, which is normally the same table, and any drift between the two is a
declared limitation rather than a silent one.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
MODELS_DIR = _HERE.parent / "models"

# Where the backend keeps the authoritative document in the monorepo.
_BACKEND_PROTOCOL = (
    _HERE.parent.parent / "backend" / "src" / "clinical" / "protocols" / "default.json"
)
# The copy pinned beside the model at training time.
_PINNED_PROTOCOL = MODELS_DIR / "reference_protocol.json"


def load_reference_protocol() -> dict[str, Any]:
    """Reference protocol, preferring the pinned copy for reproducibility."""
    for candidate in (_PINNED_PROTOCOL, _BACKEND_PROTOCOL):
        if candidate.exists():
            return json.loads(candidate.read_text())
    raise FileNotFoundError(
        "No reference protocol found. Expected either "
        f"{_PINNED_PROTOCOL} (pinned at training time) or {_BACKEND_PROTOCOL} (monorepo source)."
    )


def pin_reference_protocol() -> dict[str, Any]:
    """Copy the backend's protocol beside the model so the training run is reproducible."""
    protocol = json.loads(_BACKEND_PROTOCOL.read_text())
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    _PINNED_PROTOCOL.write_text(json.dumps(protocol, indent=2))
    return protocol


def thresholds_for(protocol: dict[str, Any], band: str) -> dict[str, Any]:
    table = protocol.get("vitalThresholds", {})
    return table.get(band) or table.get("adult") or {}


def age_bands(protocol: dict[str, Any]) -> list[dict[str, Any]]:
    return protocol.get("ageBands", [])


def resolve_age_band(protocol: dict[str, Any], age_years: float) -> str:
    for band in age_bands(protocol):
        upper = band.get("maxYears")
        if age_years >= band["minYears"] and (upper is None or age_years < upper):
            return band["band"]
    return "adult"
