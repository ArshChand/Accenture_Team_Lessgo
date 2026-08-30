# Architecture

**TriageHandler** · three services, one scoring path.

---

## Services

| Service | Stack | Port | Responsibility |
|---|---|---|---|
| `backend/` | Node · Express · Socket.IO · Mongoose | 4000 | API, queue engine, fusion, audit chain, the final ESI |
| `ml-service/` | Python · FastAPI · XGBoost | 8000 | symptom extraction, risk scoring, explanations |
| `frontend/` | React · Vite | 5173 | nurse dashboard, intake kiosk, audit viewer |

The ML service is **advisory**. It has no view of the rule engine, no access to
the queue, and no authority over the final score. It returns a distribution and
its reasoning; the backend fuses that with the deterministic rules and owns the
number that reaches a nurse. That separation is what makes the hybrid safe — a
model regression can make the assistant noisier, but it cannot lower a floor a
clinician can read in `rules.js`.

---

## The scoring path

There is exactly one, used by initial intake, by new observations, and by the
queue engine's automated re-triage. Not three that drift.

```
POST /api/encounters/:id/vitals
            │
            ▼
   services/triageService.js  ── scoreAndPersist()
            │
   ┌────────┼─────────────────────────────┐
   │        │                             │
   ▼        ▼                             ▼
buildRule   buildScoringSnapshot     computeConfidence
Context     → POST ml:8000/score     completeness · model margin
   │             │                   input reliability · band support
   ▼             ▼                             │
evaluateRules  model result                    │
36 rules       point estimate +                │
age-banded     escalation rule                 │
   │             │                             │
   └──────┬──────┘                             │
          ▼                                    │
    clinical/fusion.js  ◄──────────────────────┘
          │   min(rule, model), then the uncertainty ratchet
          ▼
    assertScored()  ── refuses to return a score without confidence
          │
          ├──► TriageAssessment  (immutable, one row per scoring run)
          ├──► Encounter         (standing ESI — only if more urgent)
          └──► AuditEvent        (hash-chained)
```

Degradation is layered, and each level declares itself:

| Available | Mode | Behaviour |
|---|---|---|
| everything | `full` | rules + model, fused |
| model down | `rules_only` | rule floor alone; confidence drops, which escalates |
| model down, no observations, no rule floor | `start_fallback` | START / JumpSTART on what a person can see in 30 seconds |

---

## The queue engine

`queue/engine.js` ticks every 5 seconds, independent of HTTP traffic — a patient
deteriorates on the system's clock, not on the next time someone loads the
dashboard.

Each tick:

1. Measure arrival rate, queue depth, staffing → evaluate surge state
2. Recompute decay for every waiting patient
3. Trigger a re-score for anyone past the reassessment ratio
4. Emit diffs over Socket.IO
5. Write audit events for breaches and surge transitions

The engine **schedules**; it does not decide. Re-scoring calls the same
`scoreAndPersist` as everything else.

### Decay

```
decayRatio    = minutesWaiting / safeWaitMinutes
priorityScore = (6 − esi)·1000 + min(decayRatio, 2)·400 + vulnerabilityBonus
```

Safe waits: ESI 1 → 0 min, 2 → 10, 3 → 30, 4 → 60, 5 → 120.

Priority reorders **within** an ESI level, never across one: the weights are set
so a fresh ESI 2 still outranks a badly overdue ESI 4. Decay changes who is seen
first among equals; it does not change how urgent anyone is.

A nurse can also add a flat `MANUAL_PROMOTION_BONUS` (100,000) on top of
`priorityScore` — chosen to exceed the entire computed range, so a promoted
patient always sorts first regardless of anyone else's severity or wait. This
changes only where the patient sits in the queue: `currentESI` and `assignedBy`
are untouched, and the bonus is stripped the moment the promotion is released.

`minutesWaiting` is measured from `queue.lastInformedAt` — the last time something
genuinely new was learned — not from the last time the system looked. An automated
re-score triggered by decay learns nothing new, so it must not reset the clock; if
it did, a neglected patient would flip back to green the instant the system
noticed the neglect.

### Surge

Declared at 2× baseline arrivals or on queue-per-nurse pressure. Exiting requires
load to stay down across a hysteresis window, so one quiet minute after a burst
does not flap the dashboard mode under the nurse's hands.

| Under surge | Changes |
|---|---|
| Dashboard | collapses to a top-N action list |
| Escalation threshold | widens (escalate on less uncertainty — attention per patient has dropped) |
| ESI 3 | splits into 3A/3B by deterioration risk |
| Low-acuity recheck | more often, not less |
| **Safe waiting times** | **unchanged, and written verbatim into every surge audit event as evidence** |

---

## Real time, and its fallback

Socket.IO on a `/queue` namespace with per-zone rooms carries `queue:patch`,
`patient:alert` and `surge:state`.

`GET /api/queue?since=` is the polling fallback. This is not defensive
boilerplate: hospitals differ enormously in technical maturity, and a department
behind a proxy that eats websocket upgrades must still see its queue. The
frontend's `useQueue` hook treats transport as an implementation detail and
reports which one is live, because a nurse looking at a stale board needs to know.

Verified by refusing the websocket outright — the indicator flips to "Polling" and
the board keeps updating.

---

## Persistence

One set of Mongoose schemas behind a repository layer, selected by `DB_DRIVER`:

- `mongo` — real MongoDB via `MONGO_URI`
- `memory` — the same schemas, validated identically, stored in-process

The in-memory driver builds real Mongoose documents, so casting, enums,
required-field validation and unique indexes behave the same. Its query subset
throws on unsupported operators rather than silently returning wrong rows, and it
rejects a mixed plain/operator update the way MongoDB does — a divergence there
already cost us one silent bug.

Everything runs on `memory` with no database installed, which is how the demo
works on a laptop with no setup.

---

## Configuration

Clinical thresholds are **data, not code**. `clinical/protocols/*.json` holds
age-band vitals, safe waits, shock-index ceilings, confidence weights and the
escalation threshold. Sites specify deltas; everything unspecified inherits.

Guardrails in `clinical/protocol.js` are **not** configurable: safe-wait ceilings,
the floor on uncertainty escalation, threshold ordering, age-band tiling, and a
list of rules that cannot be disabled. An invalid protocol refuses to start the
service — a half-applied safety table is worse than a refused start.

Three protocols ship: the reference, a single-clinician rural centre, and a
tertiary paediatric hospital.

---

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DB_DRIVER` | `memory` | `mongo` or `memory` |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/triagehandler` | used when `DB_DRIVER=mongo` |
| `ML_SERVICE_URL` | `http://127.0.0.1:8000` | risk model |
| `ML_TIMEOUT_MS` | `4000` | past this, degrade to rules |
| `SITE_ID` | `default` | which protocol to load |
| `ENGINE_TICK_MS` | `5000` | queue engine cadence |
| `ALLOW_SIMULATION` | dev only | enables the demo time-rewind endpoint |
