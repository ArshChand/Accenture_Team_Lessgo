# TriageHandler

A zero-friction, multi-modal triage assistant for emergency departments.

**Team Lessgo** — Bhavya Bharti, Arsh Chand · IIT Guwahati
Accenture Innovation Challenge 2026 · Round 2 · *PatientTriage.ai* track

---

A patient speaks their symptoms in Kannada, Hindi or English. The system extracts
clinical indicators, scores an Emergency Severity Index with an explicit
confidence figure and an explanation a nurse can check in seconds, and then keeps
watching — recalculating risk while patients wait, and pushing an alert the moment
someone has been waiting longer than is safe for how sick they are.

The nurse decides. The assistant proposes, explains itself, and records what
happened.

> **Prototype.** Trained on synthetic data, not validated for clinical use. Every
> performance figure describes a simulation. See
> [`docs/safety-case.md`](docs/safety-case.md) for what the numbers do and do not
> establish.

---

## Run it

Needs Node 20+ and Python 3.11+. No database required — it runs on an in-process
store by default.

```bash
git clone https://github.com/ArshChand/Accenture_Team_Lessgo.git
cd Accenture_Team_Lessgo
npm install
pip install -r ml-service/requirements.txt

npm run dev        # backend :4000 · frontend :5173 · ML :8000
```

Then, in another terminal:

```bash
npm run seed       # 20 curated patients, each self-checked
```

Open **http://localhost:5173**.

To run against a real MongoDB instead, set `DB_DRIVER=mongo` and `MONGO_URI`.
Everything below behaves identically.

---

## The five-minute demo

```bash
npm run seed            # 20 patients covering every edge case in the brief
npm run demo:surge      # 3x arrival volume
npm run demo:override   # override friction and the audit trail
```

**What to look at, in order:**

1. **Triage board** — sorted by priority, coloured by how much of each patient's
   safe wait is gone. Every ESI badge shows its number *and* label; every decay
   state names itself. Nothing depends on colour alone.

2. **Click `P-2481`** — Ramesh, 58, diabetic, speaking Kannada, who never says
   "chest pain". The assistant reaches ESI 2 anyway via the atypical cardiac rule,
   and shows why. This is the Round 1 persona, running.

3. **Click `P-3310`** — a six-week-old with a fever who *looks well*. Escalated to
   ESI 2 and marked **model cannot downgrade**. Then compare `P-4102`: a
   three-year-old with a *higher* fever, correctly left at ESI 3. Over-triage is a
   real cost too.

4. **Click `P-7050`** — Kannada, speech recognition at 48%, one observation taken.
   Confidence 51%, **low**, escalated for uncertainty. The system is not saying
   she is sick; it is saying it cannot see enough to say she is not.

5. **Override someone** — escalating takes one action. Try lowering a priority
   instead: it demands a reason code, twenty characters of justification, and an
   attestation. Every refusal comes from the server, not the dialog.

5b. **Move someone to the front of the queue** — a nurse-only reordering, with
   its own reason codes and a banner that spells out what did and did not
   change: the ESI stays exactly what the assistant scored.

6. **Audit trail → Verify chain integrity** — walks every event and recomputes its
   hash.

7. **Model & protocol** — the under-triage rate and declared limitations,
   published to the person being asked to trust them.

To watch decay happen without waiting 40 real minutes:

```bash
npm run demo:decay
```

---

## What it does

**Multilingual voice intake.** Web Speech API for Kannada, Hindi and English, with
scripted transcripts as fallback. Handles both negation orders — English negates
before the symptom, Hindi and Kannada after it — and refuses to let a negation
cross a clause boundary, so "chest pain but no fever" cannot become a denial of
chest pain. Lexicon coverage for Kannada and Hindi is genuinely thinner than for
English and is reported as lower confidence rather than hidden.

**Hybrid scoring.** 36 age-banded clinical rules and an XGBoost model, fused so
the result can only ever be *more* urgent than either layer alone. Asserted as an
exhaustive property test.

**Age calibration throughout.** Every vital comparison goes through an age-band
table. HR 150 is normal in an infant and severe tachycardia in an adult; RR 40 is
normal in a neonate and critical in an adult; shock index has its own per-band
ceiling because children run fast hearts against low pressures.

**Baseline-relative reading.** A systolic of 108 is shock in someone who normally
runs 155, and 89% saturation is unremarkable in a COPD patient who lives at 90%.
Patients with no prior record fall back to absolute thresholds, and the confidence
score records the gap.

**Explicit uncertainty.** No score is ever returned without a confidence object —
enforced by an assertion, not a convention. Low confidence *escalates*.

**Continuous re-triage.** A 5-second engine ages every waiting patient against the
safe window their ESI allows and pushes a breach alert instantly over a websocket,
with HTTP polling fallback for sites where websockets are unreliable.

**Surge behaviour.** At 3× volume the board collapses to an action list, ESI 3
splits into 3A/3B, low-acuity patients are rechecked *more* often, and the
escalation threshold widens. Safe waiting times are unchanged and written verbatim
into every surge audit event as evidence.

**Accountability.** Append-only, hash-chained audit log. Overrides record the
timestamp, the AI's original score, the new manual score, a structured reason, the
clinician's council registration number, and the model version and feature hash —
so a morbidity review can reconstruct what the assistant was looking at.

**Graceful degradation.** Model unreachable → rules only. Nothing measured and no
rule fires → START / JumpSTART, which needs only what a person can see in thirty
seconds. Each level declares itself rather than degrading silently.

**Site configurability.** Thresholds are data, not code. Sites specify deltas.
Guardrails — safe-wait ceilings, the escalation floor, undisablable rules — are
*not* configurable, and an invalid protocol refuses to start the service.

**Manual queue promotion.** A nurse can move a patient to the front of the queue
for something the model can never see from a snapshot — visible deterioration in
the waiting room, family or staff escalation, clinical gestalt. Promotion changes
*ordering only*: the recorded ESI, and who assigned it, never change, and the
patient detail view says so explicitly. It is promote-only (no manual demotion)
and holds until a clinician releases it, which — mirroring the override
asymmetry — requires a reason and twenty characters of justification, the same
friction a de-escalation demands.

---

## Measured performance

1,500 held-out synthetic encounters through the real pipeline:

| | under-triage | critical under-triage | over-triage | critical → ESI 4/5 |
|---|---|---|---|---|
| Rule engine alone | 41.1% | 43.0% | 20.7% | 26 |
| Model alone | 16.0% | 26.2% | 21.1% | 11 |
| **Assembled system** | **8.6%** | **15.2%** | 40.7% | **6** |

Under-triage — assigning *less* urgent than the patient really is — is the error
that kills, and it is the number this system is tuned against. Over-triage of
40.7% is the price, and it is a deliberate one.

Full analysis, including where the system is weakest and a decision we got wrong
and reversed: [`docs/safety-case.md`](docs/safety-case.md).

---

## Repository

```
backend/          Express · Socket.IO · Mongoose
  src/clinical/     rules, age bands, fusion, confidence, START, protocols
  src/queue/        decay, surge, the re-triage engine
  src/services/     triage orchestration, audit chain, ML client
  scripts/          seed, demos, fusion evaluation
ml-service/       FastAPI · XGBoost
  app/              synthetic generator, training, scoring, multilingual NLP
frontend/         React · Vite
docs/             architecture · data model · safety case · compliance
```

| Document | |
|---|---|
| [Architecture](docs/architecture.md) | services, scoring path, queue engine, degradation |
| [Data model](docs/data-model.md) | collections, provenance, confidence |
| [Safety case](docs/safety-case.md) | measured performance, operating point, limitations |
| [Compliance](docs/compliance.md) | DPDP 2023 + ABDM, with HIPAA/GDPR mapping |

---

## Tests

```bash
npm test                                          # 189 backend tests
cd ml-service && python3 -m pytest tests/ -q      # 47 tests
```

The interesting ones are written as clinical claims a reviewer could disagree
with out loud — "does not call a well toddler shocked for running a normal fast
heart", "never lets an automated re-score lower a standing score", "a negation
never reaches across a clause boundary".

`npm run seed` is also a regression suite: each of the 20 patients declares the ESI
it should reach and the rule that should get it there, and the script checks the
live system against those expectations. It caught two real defects on its first
run.

---

## Assumptions

- **Jurisdiction:** India — DPDP Act 2023 with the ABDM Health Data Management
  Policy. Equivalents under HIPAA and GDPR are mapped in the compliance doc.
- **Scale:** 100–500 visits/day; baseline 8 arrivals/hour, surge at 2× or on
  queue-per-nurse pressure.
- **Data availability:** roughly half of arrivals have a prior record.
- **Scale used:** the standard 5-level Emergency Severity Index.
