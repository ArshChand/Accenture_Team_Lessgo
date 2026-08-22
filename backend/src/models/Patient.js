import mongoose from 'mongoose';
import { LANGUAGES } from '../clinical/constants.js';

const { Schema } = mongoose;

/**
 * Identity fields are separated from clinical fields so that the dashboard can
 * operate on `displayRef` alone. Under DPDP minimisation, a triage nurse ordering
 * a queue does not need a patient's name or phone number; revealing them is a
 * separate, audited action (AUDIT_EVENT_TYPE.ACCESS_PHI).
 *
 * In production `identity` is the boundary for MongoDB client-side field level
 * encryption — the CSFLE key map is applied to this sub-document only, so the
 * rest of the record stays queryable. See docs/compliance.md.
 */
const IdentitySchema = new Schema(
  {
    fullName: { type: String },
    phone: { type: String },
    address: { type: String },
    nextOfKin: { type: String },
  },
  { _id: false },
);

/**
 * Physiological baselines from prior encounters. These are what make geriatric and
 * chronic-disease triage safe: a systolic of 108 is unremarkable in isolation and
 * is shock in a patient who normally runs 155. A patient with no prior record has
 * an empty baselines object, and the rule engine then falls back to absolute
 * thresholds while the confidence score records the gap.
 */
const BaselinesSchema = new Schema(
  {
    systolicBP: { type: Number },
    diastolicBP: { type: Number },
    heartRate: { type: Number },
    spo2: { type: Number },
    /** Baseline cognitive state, so "new confusion" is distinguishable from chronic dementia. */
    cognitiveBaseline: {
      type: String,
      enum: ['alert_oriented', 'mild_impairment', 'moderate_impairment', 'severe_impairment'],
    },
    recordedAt: { type: Date },
  },
  { _id: false },
);

const MedicationSchema = new Schema(
  {
    name: { type: String, required: true },
    /** Anticoagulation turns a minor head strike into a potential intracranial bleed. */
    isAnticoagulant: { type: Boolean, default: false },
    /** Beta blockers blunt the tachycardic response, masking shock. */
    isBetaBlocker: { type: Boolean, default: false },
    /** Immunosuppression blunts the febrile response and widens the sepsis net. */
    isImmunosuppressant: { type: Boolean, default: false },
  },
  { _id: false },
);

const PatientSchema = new Schema(
  {
    /** ABDM health account identifier, the integration point for Indian hospitals. */
    abhaId: { type: String, index: true, sparse: true },

    /**
     * Pseudonymous label shown throughout the UI, e.g. "P-2481". Stable per patient
     * so nurses can refer to someone verbally without saying their name aloud in a
     * crowded waiting room.
     */
    displayRef: { type: String, required: true, unique: true, index: true },

    identity: { type: IdentitySchema, default: () => ({}) },

    dateOfBirth: { type: Date },
    sex: { type: String, enum: ['male', 'female', 'other', 'unknown'], default: 'unknown' },
    preferredLanguage: { type: String, enum: LANGUAGES, default: 'en-IN' },

    /**
     * Roughly half of arrivals are expected to be false. Downstream this is not a
     * cosmetic flag: it drives the completeness component of the confidence score,
     * so a first-time patient is scored more cautiously by construction.
     */
    hasPriorRecord: { type: Boolean, default: false },

    baselines: { type: BaselinesSchema, default: () => ({}) },
    chronicConditions: [{ type: String }],
    medications: { type: [MedicationSchema], default: [] },
    allergies: [{ type: String }],

    /** Pointer to the governing DPDP consent artifact. */
    consentRef: { type: Schema.Types.ObjectId, ref: 'ConsentRecord' },

    /** Free-text note carried from R1 personas, e.g. "semi-urban, travels 40km to ED". */
    socialContext: { type: String },
  },
  { timestamps: true },
);

PatientSchema.virtual('ageYears').get(function computeAge() {
  if (!this.dateOfBirth) return undefined;
  return (Date.now() - this.dateOfBirth.getTime()) / (365.2425 * 24 * 60 * 60 * 1000);
});

export const Patient = mongoose.model('Patient', PatientSchema);
export default Patient;
