# Data model

Ten collections. Mongoose schemas in `backend/src/models/` are the definition of
record for both the MongoDB and in-memory drivers.

---

## The decision that shapes everything: provenance on every value

No clinical value is stored as a bare number. Every one is an **Observation**:

```js
{ value: 94, unit: '%', source: 'measured', observedAt: Date, reliability: 1.0 }
```

"SpO₂ 94 from a pulse oximeter" and "SpO₂ 94 inferred from a patient saying they
feel breathless" are not the same evidence, and the confidence score has to be
able to tell them apart.

| `source` | `reliability` |
|---|---|
| `measured` | 1.00 |
| `clinician_observed` | 0.90 |
| `prior_record` | 0.80 |
| `patient_reported` | 0.60 |
| `proxy_reported` | 0.45 |
| `nlp_inferred` | ASR confidence × extraction confidence |

`reliability` is **required**, not defaulted. Build observations with the helpers
in `clinical/observation.js`; forgetting is a validation error rather than a quiet
assumption that a value can be trusted.

**Absence is absence.** A vital nobody measured is omitted — never zero, never a
sentinel, never imputed. It travels as omitted over the wire, arrives as `NaN` in
the feature vector, and XGBoost learns a split direction for it. Missing data
lowers confidence, which escalates the ESI. Not knowing makes the system more
cautious, never less.

---

## Collections

### `patients`

Identity is separated from clinical data so the dashboard can operate on
`displayRef` alone.

| Field | Notes |
|---|---|
| `displayRef` | pseudonymous, e.g. `P-2481`. Unique. What the UI shows. |
| `identity` | name, phone, address, next of kin. Boundary for field-level encryption; revealing it is an audited act. |
| `abhaId` | ABDM health account identifier |
| `hasPriorRecord` | ~50% false by design; drives the completeness component of confidence |
| `baselines` | `systolicBP`, `spo2`, `heartRate`, `cognitiveBaseline` |
| `chronicConditions[]` | controlled vocabulary in `clinical/symptoms.js` |
| `medications[]` | with `isAnticoagulant`, `isBetaBlocker`, `isImmunosuppressant` |
| `consentRef` | → `ConsentRecord` |

`baselines` is what makes geriatric triage safe. A systolic of 108 is
unremarkable in isolation and is shock in a patient who normally runs 155.
`cognitiveBaseline` is what distinguishes new confusion from chronic dementia.
The medication flags matter because beta blockade suppresses the tachycardic
response — a "reassuring" heart rate that removes a warning sign rather than
providing one.

### `encounters`

One ED visit. Holds live queue state.

| Field | Notes |
|---|---|
| `age` | `{ ageYears, band }` — **frozen at arrival**, so a birthday mid-encounter cannot silently re-band a patient |
| `intake.transcripts[]` | raw text, language, `asrConfidence`, capture mode |
| `intake.extraction` | symptoms, negations, onset, `extractionConfidence`, `unmappedTerms` |
| `currentESI` | the standing score |
| `aiRecommendedESI` | the assistant's current view, recorded even when not applied |
| `assignedBy` | `ai` or `nurse` |
| `queue.*` | `priorityScore`, `decayRatio`, `decayStatus`, `safeWaitMinutes`, `breachedAt`, `lastInformedAt`, `lastReassessedAt`, `surgeSubBand` |

Two fields worth separating carefully:

- **`lastInformedAt`** — the last time something genuinely new was learned (new
  vitals, a clinician's decision). The decay clock measures from here.
- **`lastReassessedAt`** — the last time the engine ran any scoring pass. Used
  only to throttle cadence.

Conflating them was a real bug: an automated re-score learns nothing new, so
letting it reset the decay clock made a neglected patient read as freshly seen the
instant the system noticed the neglect.

`aiRecommendedESI` exists because an automated re-score may only ever raise
urgency. When the assistant now thinks a patient is *less* urgent, that opinion is
recorded and shown, but not acted on — lowering a score is a clinical act.

### `vitalsObservations`

Append-only time series, one document per recording, never mutated. Deterioration
is detected by diffing consecutive documents, so the evidence for a re-triage
escalation is still on disk months later when someone asks why the queue
reordered itself.

Every vital is an Observation. Also carries `observedCues` — the bedside signs a
nurse can see in seconds without equipment (`diaphoresis`, `guarding`,
`accessoryMuscleUse`, `playfulAndConsolable`, `canWalk`, `hasRadialPulse`) — and
derived `shockIndex` and `ageAdjustedFlags`.

`canWalk` and `hasRadialPulse` exist for the START protocol: they are what keeps
triage running when everything else is unavailable.

### `triageAssessments`

Immutable record of every scoring run. **The reproducibility artifact.**

| Field | Notes |
|---|---|
| `sequence`, `trigger` | `initial`, `wait_decay`, `vitals_change`, `patient_request`, `surge_sweep`, `nurse_request` |
| `mode` | `full`, `rules_only`, `start_fallback` |
| `featureVector`, `featureHash` | sha256 — proves what was actually scored |
| `ruleEngine.firedRules[]` | code, label, `impliedESI`, rationale, evidence, `hardRedFlag`, `ageBandSpecific` |
| `model.*` | ESI, class probabilities, SHAP contributions, `unavailableReason` |
| `startProtocol` | category, pathway, steps — only in fallback mode |
| `fusion.*` | `finalESI`, `ratchetApplied`, `escalationReason`, `redFlagLocked`, `escalationThreshold` |
| `confidence` | score, band, four components, human-readable drivers |
| `explainFlags[]` | ordered for a nurse with seconds to read |
| `latencyMs`, `scoredDuringSurge` | |

Months later, a morbidity review must be able to answer: what did the system see,
what did each layer conclude, how sure was it, and why did the final number differ
from what the model alone suggested. Everything needed is here.

### `auditEvents`

Append-only, hash-chained. See [`compliance.md`](./compliance.md) §4.

### `siteProtocols`

A hospital's clinical protocol, stored as **overrides** against the reference
rather than a full copy. If each site held a complete table, a correction to the
reference would have to be replayed by hand into every site document and the ones
that missed it would drift silently.

Never trusted directly: merged over defaults, then validated against guardrails a
site cannot raise.

### `modelRegistry`

Model provenance and published safety characteristics — training data hash, per
band metrics, declared limitations, and **under-triage rate** rather than
accuracy, because accuracy averages over an asymmetric cost.

### `clinicians`, `consentRecords`, `surgeEvents`

Registered decision-makers with council registration numbers; DPDP consent
artifacts; and surge transitions with the policy snapshot in force — including the
safe-wait table, recorded so a reviewer can confirm it did not move.

---

## Confidence

Four components, weighted, defined in `clinical/confidence.js`:

```
0.30 · completeness      did anyone actually measure this patient?
0.35 · modelMargin       how decided is the model between levels?
0.25 · inputReliability  how trustworthy is the evidence we do have?
0.10 · ageBandSupport    has the model seen enough patients of this age?
```

Bands: **high** ≥ 0.75 · **moderate** ≥ 0.55 · **low** below.

Completeness is importance-weighted, not a count — a missing saturation costs more
than a missing allergy list. `modelMargin` blends the top-two gap with normalised
entropy, because a distribution of 30/28/22/12/8 is not confident even though one
class leads.

Confidence is an **input** to the score, not a decoration on it: below the
threshold the ESI escalates one level, floored at 2. Being unsure makes the system
more cautious.

Every assessment carries `drivers` — the reasons confidence is not higher. "Low
confidence" is not actionable; "no oxygen saturation recorded, history via an
attendant" is.

---

## Controlled vocabularies

`clinical/symptoms.js` and `ml-service/app/features.py` define the same symptom
codes, conditions and age bands in two languages. `test/vocabularyParity.test.js`
reads the Python source and fails the build if they drift.

That drift would be silent and nasty: the NLP layer extracts `chest_pain`, the
model one-hot encodes a feature nobody sets, the rule looking for chest pain never
fires, nothing errors, and the patient is scored as though they never mentioned it.
