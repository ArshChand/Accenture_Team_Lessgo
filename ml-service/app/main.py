"""TriageHandler ML service.

Three responsibilities, kept deliberately narrow:

* ``/nlp/extract`` turns multilingual speech into the controlled symptom vocabulary
* ``/score`` returns an ESI risk distribution with real per-feature contributions
* ``/model/info`` publishes the model's provenance and its measured safety metrics

What this service does *not* do is decide anything. It has no view of the rule
engine, no access to the queue, and no authority over the final ESI. It returns a
distribution and its reasoning; the backend fuses that with the deterministic rules
through the safety ratchet and owns the number that reaches a nurse. Keeping the
model advisory rather than authoritative is what makes the hybrid safe: a model
regression can make the assistant more cautious or less useful, but it cannot
lower a floor the rules have set.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .features import HIGH_VALUE_FEATURES, feature_spec
from .nlp import LANGUAGE_COVERAGE, extract
from .protocol import load_reference_protocol, thresholds_for
from .scoring import get_model

app = FastAPI(
    title="TriageHandler ML service",
    version="1.0.0",
    description="Symptom extraction and ESI risk scoring. Advisory only — the backend owns the final score.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExtractRequest(BaseModel):
    text: str
    language: str = "en-IN"
    asrConfidence: float = Field(default=0.9, ge=0.0, le=1.0)


class ScoreRequest(BaseModel):
    age_years: float | None = None
    age_band: str = "adult"
    vitals: dict[str, Any] = Field(default_factory=dict)
    baselines: dict[str, Any] = Field(default_factory=dict)
    cues: dict[str, Any] = Field(default_factory=dict)
    symptoms: list[str] = Field(default_factory=list)
    conditions: list[str] = Field(default_factory=list)
    medications: dict[str, Any] = Field(default_factory=dict)
    has_prior_record: bool = False
    via_proxy: bool = False
    #: Age-band thresholds from the site protocol in force. Passed in rather than
    #: held here so the model normalises against the same numbers the rule engine
    #: used for the same patient.
    thresholds: dict[str, Any] | None = None
    #: Escalation threshold from the site protocol. Higher means more caution.
    escalationTau: float | None = Field(default=None, ge=0.05, le=0.95)


@app.get("/health")
def health() -> dict:
    model = get_model()
    return {
        "service": "triagehandler-ml",
        "status": "ok",
        "modelAvailable": model.available,
        "modelMode": "model" if model.available else "deterministic",
        "unavailableReason": model.unavailable_reason,
        "languages": sorted(LANGUAGE_COVERAGE.keys()),
    }


@app.get("/model/info")
def model_info() -> dict:
    """Provenance and measured safety characteristics.

    Published rather than buried: the number that governs deployment here is the
    under-triage rate, not accuracy, and the argmax baseline is included so the
    effect of the escalation-aware decision rule is checkable rather than claimed.
    """
    return {**get_model().info(), "featureSpec": feature_spec()}


@app.post("/nlp/extract")
def nlp_extract(request: ExtractRequest) -> dict:
    started = time.perf_counter()
    result = extract(request.text, request.language, request.asrConfidence)

    # The reliability the backend will attach to anything derived from this
    # utterance: how well we heard it multiplied by how well we understood it.
    derived_reliability = round(request.asrConfidence * result.extraction_confidence, 3)

    return {
        "language": result.language,
        "symptoms": result.symptoms,
        "negations": result.negations,
        "matchedTerms": result.matched_terms,
        "unmappedTerms": result.unmapped_terms,
        "severityWords": result.severity_words,
        "onsetHours": result.onset_hours,
        "extractionConfidence": result.extraction_confidence,
        "asrConfidence": request.asrConfidence,
        "derivedReliability": derived_reliability,
        "gloss": result.gloss,
        "glossNote": "Gloss built from matched terms, not a translation.",
        "languageCoverage": LANGUAGE_COVERAGE.get(result.language.split("-")[0], 0.6),
        "latencyMs": round((time.perf_counter() - started) * 1000, 2),
    }


@app.post("/score")
def score(request: ScoreRequest) -> dict:
    started = time.perf_counter()
    payload = request.model_dump()

    thresholds = request.thresholds
    if not thresholds:
        thresholds = thresholds_for(load_reference_protocol(), request.age_band)

    result = get_model().predict(payload, thresholds, request.escalationTau)

    # Which high-value observations are missing. The backend folds this into the
    # completeness component of its confidence score, so a patient nobody has
    # measured is scored more cautiously rather than more confidently.
    vitals = request.vitals or {}
    missing = [
        feature
        for feature in HIGH_VALUE_FEATURES
        if not isinstance(vitals.get(feature), (int, float))
    ]

    return {
        **result,
        "missingHighValueFeatures": missing,
        "thresholdsUsed": thresholds,
        "latencyMs": round((time.perf_counter() - started) * 1000, 2),
    }
