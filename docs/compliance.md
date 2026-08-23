# Data protection and clinical accountability

**Assumed jurisdiction: India** — Digital Personal Data Protection Act 2023,
read with the ABDM Health Data Management Policy.

Chosen because the product is designed around Kannada and Hindi intake for
semi-urban Indian emergency departments, so DPDP plus ABDM is the regime it would
actually operate under. Equivalents under HIPAA and GDPR are mapped in §6 for
portability.

> Prototype scope. This documents how the design maps onto the obligations, not a
> legal opinion, and several controls are declared rather than implemented — those
> are marked **Design only** and listed together in §5.

---

## 1. What the system holds, and why that matters

| Category | Examples | Sensitivity |
|---|---|---|
| Identifying | name, phone, ABHA ID, next of kin | direct identifiers |
| Clinical | vitals, symptoms, history, medications, ESI | health data |
| Voice | transcripts, ASR confidence | health data, biometric-adjacent |
| Decision | model version, feature hash, explanations, confidence | inference about a person |
| Accountability | clinician identity, registration number, overrides | professional record |

Under DPDP all of this is personal data; the clinical, voice and decision
categories are the sensitive core.

---

## 2. Lawful basis

Consent is not the only available basis, and in an emergency department it is
often not the right one.

| Basis | Constant | Used for |
|---|---|---|
| Consent (s.6) | `DPDP_S6_CONSENT` | routine attendance where the patient can meaningfully consent |
| Medical emergency (s.7(f)) | `DPDP_S7F_MEDICAL_EMERGENCY` | an unconscious or incapacitated patient |
| Public health (s.7(g)) | `DPDP_S7G_PUBLIC_HEALTH` | mandated reporting |

Section 7(f) is why an unresponsive patient can still be triaged: what the Act
requires is that the basis be **recorded**, not that consent be obtained. Every
audit event carries `lawfulBasis` and `purpose`, so an emergency-basis encounter
is both fully legal and fully auditable, and consent is sought retrospectively
once the patient can give it (`retrospectivelyConfirmed`).

The consent artifact (`ConsentRecord`) records purposes, data categories, the
**language the notice was actually presented in** — a real barrier rather than a
formality when the patient speaks only Kannada — proxy consent for minors, and
withdrawal. Withdrawal is prospective: it cannot retroactively unmake a clinical
decision already recorded.

---

## 3. Minimisation, made demonstrable

The dashboard runs on pseudonymous references. A nurse ordering a queue sees
`P-2481 · 58y · adult`, never a name. Identity lives in a separate `identity`
sub-document, and revealing it is a **distinct, role-gated, audited action** that
writes an `ACCESS_PHI` event naming the fields revealed.

This is the difference between claiming minimisation and being able to show it.
The access log answers "who looked at this patient's name, when, and why" —
purpose limitation as evidence rather than policy.

`GET /api/patients` strips identity unconditionally: a list endpoint that returned
names would make the access log meaningless.

---

## 4. The audit trail

Append-only and tamper-evident. There is **no update path and no delete path** in
`auditService.js`, and no route exposes one. A mistake is corrected by appending a
`CORRECTION` event referencing the original — an audit trail that can be edited
records only what someone was last willing to admit.

### Hash chaining

```
hash = sha256( canonicalJSON(declared fields) + prevHash )
```

Each event stores its predecessor's hash, so altering any historical event
invalidates every hash after it. Sequence numbers are gap-free, so a deletion is
as visible as an edit. `GET /api/audit/verify` walks the chain and names the first
break **and its kind** — `content_altered`, `sequence_gap` or `broken_link` —
because "the log is invalid" is useless to an investigator and "event 412 was
altered" is not.

The chain covers an explicit declared field list rather than "everything except
the hash". The persistence layer normalises documents on write, so a hash taken
over the in-memory draft would not reproduce from storage and every chain would
verify as tampered. An explicit list is stable across that, and states plainly
what the chain does and does not attest to.

Appends are serialised, so two concurrent overrides cannot fork the chain.

### What an override records

Validation lives in the audit service, so a score cannot change without a trail —
the two are one operation, and there is no state where one happened and the other
did not.

| Field | Why |
|---|---|
| `occurredAt` / `recordedAt` | act time vs durable record time; clock skew is auditable |
| `actor.name`, `.role`, `.registrationNumber` | an identifiable, licensed decision-maker |
| `before.esi`, `.confidence` | what the machine said |
| `after.esi`, `.direction` | what the human decided |
| `reasonCode` | structured, so a department can measure *where* the assistant is wrong |
| `reasonText` | free text, mandatory for de-escalation |
| `assessmentAttested` | explicit confirmation the patient was assessed |
| `modelSnapshot.modelId`, `.modelVersion`, `.featureHash` | reconstruct what the AI saw, months later |
| `lawfulBasis`, `purpose`, `consentRef`, `retentionClass` | DPDP |

The model version and feature hash are the part that matters in a morbidity
review: they let someone establish not just that the nurse disagreed, but exactly
what the assistant was looking at when she did.

### Asymmetric friction, enforced server-side

| Direction | Requires |
|---|---|
| **Escalation** | a reason code. Nothing else. One action. |
| **De-escalation** | reason code **+** ≥20 characters of justification **+** attestation of assessment |

Enforced in `auditService.js`, not the dialog. A check that lives only in the UI
is a usability feature — anything that can reach the API walks straight past it.
`npm run demo:override` shows three de-escalations refused for three different
reasons, all from the server.

---

## 5. Retention

| Class | Contents | Retention |
|---|---|---|
| `clinical_audit` | triage decisions, overrides, corrections | 7 years (configurable) |
| `access_log` | who viewed identifying data | 3 years |
| `operational` | surge transitions, wait breaches | 1 year |

Every event carries `retainUntil`, computed at write time, so automated purge is
possible without re-deriving policy.

### Design only — declared, not implemented

Named here rather than left implicit, because a compliance section that quietly
lists aspirations as controls is worse than one that admits the gap.

- **Encryption at rest.** The `identity` sub-document is the boundary for MongoDB
  client-side field level encryption. The boundary exists; the CSFLE key map is
  not wired up.
- **Authentication.** No auth. A deployment would federate against the hospital
  identity provider; clinicians are selected from a list, and `actor` is trusted
  from the request.
- **Automated purge.** `retainUntil` is written; nothing sweeps it.
- **ABHA integration.** The field exists; there is no ABDM gateway call.
- **Consent UI.** `ConsentRecord` is modelled and seeded but there is no capture
  flow.
- **Data principal rights.** Access and correction are supported in structure
  (append-only correction, exportable audit) but there is no self-service portal.
- **Encryption in transit.** Plain HTTP between services in development.

---

## 6. Mapping to other regimes

The same controls under the two regimes a judge is most likely to know.

| Control | DPDP 2023 / ABDM | HIPAA | GDPR |
|---|---|---|---|
| Lawful basis recorded per event | s.4, s.6, s.7 | §164.506 | Art. 6, Art. 9(2)(h) |
| Purpose limitation | s.8(1) | minimum necessary §164.502(b) | Art. 5(1)(b) |
| Minimisation / pseudonymous board | s.8(3) | §164.514 de-identification | Art. 5(1)(c), Art. 25 |
| Access logging (`ACCESS_PHI`) | s.8(4) | audit controls §164.312(b) | Art. 30 |
| Tamper-evident audit chain | s.8(5) | integrity §164.312(c)(1) | Art. 32(1)(b) |
| Retention limits | s.8(7) | §164.316(b)(2) | Art. 5(1)(e) |
| Consent artifact + withdrawal | s.6(4)–(6) | §164.508 | Art. 7 |
| Breach notification | s.8(6) | §164.400–414 | Art. 33–34 |
| Human review of automated decisions | — | — | Art. 22 |

GDPR Article 22 has no direct DPDP equivalent, but the design satisfies it anyway:
every score is advisory, every score carries an explanation and a confidence
figure, and a licensed clinician can override any of them with the override
recorded against their registration number.

---

## 7. Model governance

`ModelRegistry` records the training data hash, row count, per-band metrics,
declared limitations, and the **under-triage rate** rather than accuracy — because
accuracy averages over an asymmetric cost and is the wrong number to govern on.

Every `TriageAssessment` stores the model id, version and feature hash, so any
historical decision can be tied to the exact model and the exact inputs that
produced it. `GET /api/model/info` publishes all of it to the interface, so the
numbers a nurse is asked to trust are inspectable by the person relying on them.

See [`safety-case.md`](./safety-case.md) for measured performance, including
where it is weakest.
