# Safety case

**TriageHandler** · Team Lessgo · Accenture Innovation Challenge 2026, PatientTriage.ai track

> This is a prototype trained on synthetic data. Nothing here is validated for
> clinical use, and every number below describes a simulation. What the numbers
> *can* establish is whether the design does what it claims to do — and where it
> does not.

---

## 1. The claim

The system is deliberately tuned so that when it is wrong, it is wrong in the
direction that costs a bed rather than the direction that costs a life. This
document is the evidence for that claim, including the places it holds up less
well than we would like.

Two errors, two very different costs:

| Error | What it means | Cost |
|---|---|---|
| **Under-triage** | assigned less urgent than the patient really is | delayed treatment, deterioration in the waiting room, death |
| **Over-triage** | assigned more urgent than the patient really is | a bed and some clinician time used sooner than needed |

A system optimised for accuracy treats these as equal. This one does not. Every
metric below leads with under-triage, and accuracy is reported last because it is
the least informative number on the page.

---

## 2. How the assessment is assembled

Three layers, fused so that the result can only ever be *more* urgent than any
layer alone concluded.

```
 vitals + symptoms + history
            │
    ┌───────┴────────┐
    ▼                ▼
rule engine     risk model            confidence
36 rules,       XGBoost,              completeness · model margin
age-banded      point estimate +      input reliability · band support
thresholds      escalation rule
    │                │                      │
    └───────┬────────┘                      │
            ▼                               │
      min(rule, model)  ◄───────────────────┘
            │            uncertainty ratchet, floored at ESI 2
            ▼
      final ESI + confidence + explanation
```

The invariant, asserted as an exhaustive property test over all 150 combinations
of rule floor, model output, confidence band and surge state:

```
finalESI  ≤  min(ruleFloor, modelESI)
```

There is no code path that produces a less urgent result than the rules demanded.
A model regression can make the assistant noisier; it cannot lower a floor a
clinician can read in `rules.js`.

The ratchet extends across **time** as well as across layers: an automated
re-score may only raise urgency. Lowering a standing score is a clinical act and
goes through the override path, where it costs a reason code, a written
justification and an attestation.

---

## 3. Measured performance

1,500 held-out synthetic encounters (generator seed 90210, distinct from the
training seed), scored through the real rule engine, the real model over HTTP,
and the real fusion code. Reproduce with:

```bash
npm run evaluate
```

Full output in [`fusion-evaluation.json`](./fusion-evaluation.json).

| Layer | under-triage | critical under-triage | over-triage | accuracy | critical → ESI 4/5 |
|---|---|---|---|---|---|
| Rule engine alone | 41.1% | 43.0% | 20.7% | 38.2% | 26 |
| Model alone (most likely class) | 16.0% | 26.2% | 21.1% | 62.9% | 11 |
| Model alone (self-escalated) | 11.1% | 20.8% | 29.4% | 59.5% | 7 |
| **Assembled system** | **8.6%** | **15.2%** | **40.7%** | **50.7%** | **6** |

*critical under-triage* = under-triage among patients whose true severity is ESI 1
or 2. *critical → ESI 4/5* = the worst available outcome, a genuinely critical
patient sent to a low-acuity queue.

Every row is measured at the shipped escalation threshold τ = 0.40. §4 sweeps τ
for the assembled system; the two are not interchangeable, and an earlier draft of
this table quoted the self-escalated row at τ = 0.30 by mistake.

Three things this table shows that are worth reading carefully:

**The rule engine alone is a poor triage system.** 41% under-triage looks alarming
until you notice why: the rules impose *no floor at all* on most patients, by
design. A quiet rule engine means "nothing here demands escalation", not "this
patient is fine". It is a safety net, not a classifier, and it is not meant to
work alone.

**The model alone is better at ranking and worse at safety.** It is the most
accurate single layer by a wide margin (62.9%) and still misses a quarter of
critical patients.

**Neither layer is what ships.** The assembled system is not the best on any single
metric. It sits where it does deliberately.

---

## 4. The operating point, and a decision we got wrong first

The escalation threshold τ is the main safety control: the model escalates when
the cumulative probability of something worse reaches τ, capped at its most likely
class so the rule can only ever raise urgency.

| τ | under-triage | critical under-triage | over-triage | accuracy |
|---|---|---|---|---|
| 0.20 | 3.8% | 8.8% | 53.3% | 42.9% |
| 0.25 | 4.6% | 9.3% | 49.1% | 46.3% |
| 0.30 | 6.2% | 11.5% | 45.5% | 48.3% |
| **0.40 (shipped)** | **8.6%** | **15.2%** | **40.7%** | **50.7%** |
| 0.50 | 10.7% | 17.6% | 36.4% | 52.9% |
| ≥ 0.60 | 11.8% | 18.3% | 35.8% | 52.4% |

Above roughly 0.6 the rule stops firing at all and the system collapses to the
plain point estimate.

### What we got wrong

While building the 20-patient demonstration roster we noticed the model's
escalation compressing 14 of 20 patients onto ESI 2, and switched the mechanism
**off**. That looked principled at the time — escalation was arguably being
applied three times over, in the model, at the rule floor, and again in the
uncertainty ratchet.

Measuring it against 1,500 encounters instead of 20 showed the reasoning was
wrong. Turning it off took under-triage from 8.6% to 11.9% and critical
under-triage from 15.2% to 18.3% — **a third worse on the error that kills**, to
buy 5 points of over-triage.

The mistake was reaching for the on/off switch when the threshold was the real
control, on evidence from a deliberately edge-case-heavy sample of twenty. The
mechanism is back on at τ = 0.40, and `useModelEscalation` remains available for
sites running the model without the rule engine.

We record this because a safety argument that only contains the parts that went
well is not a safety argument.

### Why τ = 0.40

τ = 0.20 would take under-triage to 3.8%, and on cost asymmetry alone that is the
"safer" number. It is not shipped, because 53% over-triage means the majority of
patients are bumped up a level and the queue stops discriminating — a board where
everyone is urgent tells a nurse nothing, and the practical result is that she
stops reading it. That failure mode does not appear in any confusion matrix.

τ = 0.40 is where the marginal over-triage cost starts exceeding the marginal
under-triage benefit on this generator. **It is a capacity decision as much as a
clinical one**, which is why it lives in the site protocol rather than the code: a
department with spare beds can afford to sit lower than one already full.

---

## 5. Where the system is weakest

Published per band and per presentation, because a model can look fine overall and
be unusable on a subgroup.

**By age band** (fused, under-triage):

| Band | n | under-triage |
|---|---|---|
| neonate | 15 | 0.0% |
| adolescent | 92 | 5.4% |
| toddler | 137 | 5.8% |
| geriatric | 266 | 6.0% |
| infant | 84 | 9.5% |
| child | 144 | 9.7% |
| adult | 565 | 10.1% |
| advanced geriatric | 197 | 10.7% |

The neonatal 0% is **not** reassuring: n = 15, and the rule engine floors every
neonate at ESI 2 regardless of presentation, so the band is carried by a blunt
rule rather than by understanding. Infant coverage is thin and declared as such in
the model registry, which lowers confidence for those patients and therefore
escalates them.

**Worst presentations** (fused, under-triage): overdose/self-harm 15.4% (n=39),
obstetric 13.5% (n=52), allergic reaction 13.3% (n=60), syncope 13.3% (n=60),
stroke 13.3% (n=30), upper respiratory 11.9% (n=176).

The overdose, syncope and stroke numbers are the clinically concerning ones — all
three are presentations where the patient can look well and deteriorate, and all
three are under-represented in the generator. Upper respiratory sits high on the
same list and matters far less: its critical under-triage rate is 0%, so the misses
are ESI 4 patients scored 5.

Read one number alongside it. **Minor trauma** under-triages 11.0% overall but
42.9% of its *critical* cases, and sends 2 of the 6 critical-to-low-acuity
patients in the whole set. A presentation labelled minor that occasionally is not
is the more dangerous shape of error, and the overall column hides it.

**Contribution of the uncertainty ratchet:** fires on 8.0% of encounters and moves
under-triage by roughly 0.6 points. Modest, and it is not trying to be the main
safety mechanism — it exists for the specific case where evidence is too thin to
judge, which the model's own probabilities cannot detect because they are
conditioned on the features that *are* present.

---

## 6. Safety properties not captured by any metric

Things the confusion matrix cannot see, verified by test.

| Property | Where enforced | Test |
|---|---|---|
| Fusion can only escalate, never de-escalate | `clinical/fusion.js` | exhaustive over all 150 input combinations |
| Automated re-scores cannot lower a standing score | `services/triageService.js` | `engine.test.js` |
| Hard red flags lock the model out of downgrading | `clinical/fusion.js` | `fusion.test.js` |
| Uncertainty never escalates to ESI 1 | `clinical/fusion.js` | ESI 1 must be a positive finding |
| No score is returned without confidence | `services/triageService.js` | `assertScored` throws |
| Missing vitals are NaN, never imputed | `ml-service/app/features.py` | `test_scoring.py` |
| Decay clock is not reset by the system re-reading stale data | `queue/decay.js` | `decay.test.js` |
| Safe waiting times cannot be relaxed, including under surge | `clinical/protocol.js` guardrails | `protocol.test.js`, `surge.test.js` |
| A site cannot disable a rule that prevents a fatal miss | `PROTOCOL_GUARDRAILS` | `protocol.test.js` |
| Audit chain detects alteration, deletion and re-linking | `services/auditService.js` | `audit.test.js` |
| Triage continues when the model is unreachable | START/JumpSTART fallback | `fusion.test.js` |

The last one matters for the failure mode nobody plans for: with no model, no
observations and nothing for the rules to act on, the system falls back to a
protocol needing only what a person can see in thirty seconds.

---

## 7. Age calibration, and a bug it caught

The brief's central safety point is that one adult-calibrated model across all
ages creates silent risk. Every vital comparison in the engine goes through an
age-band table — and building the demonstration roster caught a place where one
did not.

`ELEVATED_SHOCK_INDEX` compared heart rate over systolic pressure against a bare
constant of 0.9. Shock index runs high in children by construction, so a
completely well three-year-old at HR 120 / SBP 96 scores 1.25 and was being
flagged as shocked. Ceilings are now per band (2.0 neonate → 0.9 adult); a
genuinely shocked toddler at HR 170 / SBP 78 still fires.

It is worth being blunt about this: the exact failure the project exists to
prevent was sitting in our own rule engine, and it took an automated check over
twenty patients to find it. That is an argument for the check, not for our
carefulness.

---

## 8. Honest limitations

1. **Synthetic data throughout.** Absolute rates describe the generator, not a
   department. The *relative* comparisons — layer against layer, τ against τ —
   are the defensible part.
2. **Ground truth is generated, not adjudicated.** The generator assigns a latent
   severity and derives findings from it. Real triage labels come from clinicians
   who disagree with each other.
3. **Over-triage is high in absolute terms.** 40.7% at the shipped operating
   point. In a real department that is a capacity problem, and the right τ would
   be chosen against real volumes.
4. **The model sees a snapshot, never a trajectory.** Deterioration over time is
   handled by the re-triage loop, not the model.
5. **Thin coverage in the paediatric bands**, declared per band; those patients
   get lower confidence and are escalated more readily as a result.
6. **No real-world validation of the NLP layer.** Lexicon coverage for Kannada
   and Hindi is genuinely thinner than for English and is reported as lower
   confidence rather than hidden.
7. **The 20-patient roster is not a case mix.** It over-represents edge cases
   because the brief asks for them; a real ED is ESI 3 dominant.

---

## 9. Reproducing everything here

```bash
npm install
npm run dev                    # backend :4000, frontend :5173, ML :8000

npm test                       # 198 backend tests
npm run test:ml                # 47 ML-service tests

npm run seed                   # 20 curated patients, self-checked
npm run demo:surge             # 3x volume
npm run demo:override          # override friction and audit

cd ml-service && python3 -m app.export_eval_set 1500
cd backend    && node scripts/evaluateFusion.js  # this document's table 3
```
