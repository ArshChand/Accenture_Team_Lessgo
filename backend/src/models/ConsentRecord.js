import mongoose from 'mongoose';
import { LAWFUL_BASES, LAWFUL_BASIS } from '../clinical/constants.js';

const { Schema } = mongoose;

/**
 * DPDP Act 2023 consent artifact, shaped after the ABDM consent model.
 *
 * The important design point for an emergency department: consent is not the only
 * lawful basis available. Section 7(f) permits processing for medical emergencies
 * where the data principal cannot meaningfully consent — an unconscious patient is
 * still triaged. What the Act requires is that the basis be *recorded*, so an
 * emergency-basis encounter is fully legal and fully auditable, and consent is
 * sought retrospectively once the patient is able to give it.
 */
const ConsentRecordSchema = new Schema(
  {
    patientRef: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },

    lawfulBasis: { type: String, enum: LAWFUL_BASES, default: LAWFUL_BASIS.CONSENT },

    /** Purpose limitation — processing outside these purposes is a violation. */
    purposes: {
      type: [String],
      default: ['emergency_triage', 'clinical_care', 'quality_audit'],
    },

    /** Categories of data covered. Absent categories may not be processed. */
    dataCategories: {
      type: [String],
      default: ['vitals', 'symptoms', 'medical_history', 'voice_recording'],
    },

    granted: { type: Boolean, default: true },
    grantedAt: { type: Date, default: Date.now },
    /** Set when consent is withdrawn. Withdrawal is prospective, not retroactive. */
    withdrawnAt: { type: Date },

    /** Language the notice was actually presented in — a real barrier, not a formality. */
    noticeLanguage: { type: String, default: 'en-IN' },
    noticeVersion: { type: String, default: 'v1' },

    /** Set when consent was given by an attendant for a minor or incapacitated adult. */
    grantedByProxy: { type: Boolean, default: false },
    proxyRelationship: { type: String },

    expiresAt: { type: Date },

    /**
     * True once a retrospective consent conversation has happened for an encounter
     * initially processed under the medical-emergency basis.
     */
    retrospectivelyConfirmed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

ConsentRecordSchema.virtual('isActive').get(function isActive() {
  if (this.withdrawnAt) return false;
  if (this.expiresAt && this.expiresAt.getTime() < Date.now()) return false;
  return this.granted;
});

export const ConsentRecord = mongoose.model('ConsentRecord', ConsentRecordSchema);
export default ConsentRecord;
