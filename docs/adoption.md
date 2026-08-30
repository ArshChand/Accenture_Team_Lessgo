# Adoption

A triage assistant that is clinically sound and still gets worked around by
the second week has not actually shipped. This is not a training-material
problem to solve later; every claim below is a design decision already made
elsewhere in this codebase, restated here as an explicit answer to "why would
a fatigued, time-pressured nurse actually use this instead of routing around
it".

## The nurse is never blocked

No route in this system can refuse to let a clinician act on a patient. The
assistant proposes an ESI; the nurse's own judgment — entered as an override —
always wins, immediately, with no queue or approval step (`docs/compliance.md`,
"Asymmetric friction, enforced server-side"; `triageService.js`'s
`applyOverride`). A tool that can be silently
outvoted is a tool that gets its recommendation read and then ignored anyway;
one whose worst case is "the nurse types a reason and moves on" is a tool
whose recommendation is worth reading in the first place.

## Friction is asymmetric on purpose, and only in the safe direction

Escalating a patient's priority — either an ESI override upward, or a manual
queue promotion — takes one click and no justification. Only the actions this
system needs to slow down are slowed down: de-escalating an ESI, or releasing
a manual promotion, requires a reason code and twenty characters of written
justification (`PROMOTION_MIN_REASON_LENGTH`, `OVERRIDE_REASON`). A nurse
who thinks the assistant is being too cautious never fights the tool to say
so; a nurse who wants to override it toward *less* urgency has to mean it.
That asymmetry is what keeps "just click past it" from ever becoming the path
of least resistance in the wrong direction.

## Manual queue promotion exists because the brief is right that AI cannot see the waiting room

This system does not claim to catch everything. A patient who visibly
deteriorates while waiting, a family member who says something a form cannot
capture, a nurse's own gestalt after twenty years — none of that reaches a
model scoring a snapshot at arrival. Queue promotion
(`backend/src/services/triageService.js`'s `applyQueuePromotion`) is the
explicit acknowledgment of that: a nurse can move anyone to the front of the
queue for a reason the assistant could never have scored, and the system
records that this was a human call, not a rescoring. A staff member who
believes the tool "doesn't understand the real ED" has a real lever to pull
instead of a reason to stop trusting the board.

## The reasoning is inspectable, not asserted

Every score ships with which rules fired, the model's top feature
contributions, and a confidence figure — visible in the same view a nurse
already uses to decide, not in a separate audit screen (the "Why this score"
panel in `PatientDetail.jsx`; the underlying figures in `docs/data-model.md`,
"Confidence"). Trust that has to be taken on faith erodes
the first time the tool is visibly wrong about something small; trust that
can be checked in the same three seconds it takes to glance at a queue row
survives that same moment, because the nurse can see *why* and agree or
disagree on the spot.

## The published error rate is not flattering, on purpose

`docs/safety-case.md` states the assembled system's own measured 40.7%
over-triage rate, not just its 8.6% under-triage rate, and documents a design
decision the team reversed after measuring it was wrong (§4, "What we got
wrong"). `npm run seed` goes further at the level of individual patients:
its own console output names every seeded case where the system's documented
behaviour is not the textbook answer, and states why in one line, every run —
not something a demo audience has to be told about separately. A tool that
only ever surfaces numbers that make it look good trains staff to distrust
the numbers it publishes. One that states
its own cost plainly is one whose good numbers are worth believing too.

## It keeps working when its own parts fail

Model unreachable → rules alone. Rules engine unusable → START/JumpSTART, the
same protocol paper triage already uses, needing only what a person can see
in thirty seconds. Websocket unavailable → HTTP polling, automatically, with
no user action (`docs/architecture.md`, "The scoring path" and "Real time,
and its fallback"). None
of these degrade silently — each one names itself on the dashboard — but none
of them stop the department, either. A tool that becomes the reason triage
stopped during an outage gets uninstalled the next morning; one that quietly
gets less clever and keeps functioning does not.

## What is not solved here

This is a design stance, not a training program. It does not cover shift
handoff, how a charge nurse would be trained on the override UI, or how
adoption would be measured post-deployment (e.g. override rate over time as a
proxy for trust). Those are legitimate open questions for a real rollout; the
claim this document makes is narrower — that the prototype's own interaction
design does not manufacture the workaround pressure it would otherwise have
to train staff out of.
