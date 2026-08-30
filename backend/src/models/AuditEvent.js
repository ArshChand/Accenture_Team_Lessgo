import mongoose from 'mongoose';
import {
  AUDIT_EVENT_TYPES,
  CLINICIAN_ROLES,
  LAWFUL_BASES,
  OVERRIDE_REASONS,
  PROMOTION_REASONS,
  RETENTION_CLASSES,
} from '../clinical/constants.js';

const { Schema } = mongoose;

/**
 * Append-only, tamper-evident audit log.
 *
 * Assumed jurisdiction: India — Digital Personal Data Protection Act 2023, read
 * with the ABDM Health Data Management Policy. Two consequences shape this schema:
 *
 *   1. A clinical override is a decision a licensed professional is accountable
 *      for, so the record must identify the actor by registration number, capture
 *      a structured reason, and preserve the machine recommendation that was
 *      overridden — otherwise the override cannot be reviewed, only asserted.
 *
 *   2. DPDP requires purpose limitation and demonstrable minimisation, so reading
 *      identifying data is itself an event worth logging, not only writing it.
 *
 * Tamper evidence comes from hash chaining: each event stores the hash of its
 * predecessor, so altering any historical event invalidates every hash after it.
 * The chain is verifiable via GET /api/audit/verify. There are deliberately no
 * update or delete routes for this collection — a mistake is corrected by
 * appending a CORRECTION event that references the original, never by editing it.
 */

const ActorSchema = new Schema(
  {
    clinicianRef: { type: Schema.Types.ObjectId, ref: 'Clinician' },
    name: { type: String, required: true },
    role: { type: String, enum: CLINICIAN_ROLES, required: true },
    /** State nursing/medical council registration number. Required for accountability. */
    registrationNumber: { type: String },
    sessionId: { type: String },
    workstation: { type: String },
    ipAddress: { type: String },
  },
  { _id: false },
);

const AuditEventSchema = new Schema(
  {
    /** Monotonic, gap-free within the chain. A gap is itself evidence of tampering. */
    seq: { type: Number, required: true, unique: true, index: true },

    eventType: { type: String, enum: AUDIT_EVENT_TYPES, required: true, index: true },

    actor: { type: ActorSchema, required: true },

    subject: {
      encounterRef: { type: Schema.Types.ObjectId, ref: 'Encounter', index: true },
      patientRef: { type: Schema.Types.ObjectId, ref: 'Patient', index: true },
      displayRef: { type: String },
    },

    /** Prior and resulting state. Shape varies by eventType; always a plain object. */
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },

    /**
     * Structured reason — mandatory for TRIAGE_OVERRIDE and for a queue
     * promotion. The two vocabularies stay separate because they answer
     * different questions ("why is the score wrong" vs "why is this patient
     * being seen sooner"), but they share one field so a reviewer reads one
     * trail rather than two.
     */
    reasonCode: { type: String, enum: [...OVERRIDE_REASONS, ...PROMOTION_REASONS, null] },
    reasonText: { type: String },
    /**
     * Explicit attestation that the clinician physically assessed the patient.
     * Required to de-escalate, not to escalate: the friction is deliberately
     * asymmetric because the costs of the two errors are asymmetric.
     */
    assessmentAttested: { type: Boolean, default: false },

    /**
     * Snapshot of the machine recommendation being acted on, so the decision stays
     * reproducible even if the model is retired or retrained.
     */
    modelSnapshot: {
      assessmentRef: { type: Schema.Types.ObjectId, ref: 'TriageAssessment' },
      modelId: { type: String },
      modelVersion: { type: String },
      featureHash: { type: String },
      recommendedESI: { type: Number },
      confidenceScore: { type: Number },
      confidenceBand: { type: String },
      explainFlags: { type: Schema.Types.Mixed },
    },

    /** When the act happened vs when we durably recorded it. Clock skew is auditable. */
    occurredAt: { type: Date, required: true },
    recordedAt: { type: Date, default: Date.now },

    // --- DPDP Act 2023 / ABDM fields ---
    lawfulBasis: { type: String, enum: LAWFUL_BASES, required: true },
    /** Purpose limitation: why this processing was permitted. */
    purpose: { type: String, required: true },
    consentRef: { type: Schema.Types.ObjectId, ref: 'ConsentRecord' },
    retentionClass: { type: String, enum: RETENTION_CLASSES, required: true },
    /** Computed at write time from retentionClass; supports automated purge. */
    retainUntil: { type: Date },

    // --- hash chain ---
    /** sha256 of the previous event. The genesis event uses GENESIS_HASH. */
    prevHash: { type: String, required: true },
    /** sha256(canonicalJSON(this event without `hash`) + prevHash). */
    hash: { type: String, required: true, index: true },
  },
  { timestamps: false },
);

AuditEventSchema.index({ 'subject.encounterRef': 1, seq: 1 });

export const AuditEvent = mongoose.model('AuditEvent', AuditEventSchema);
export default AuditEvent;
