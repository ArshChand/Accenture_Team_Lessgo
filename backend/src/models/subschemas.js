import mongoose from 'mongoose';
import { AGE_BANDS, CONFIDENCE_BAND, LANGUAGES, SOURCES } from '../clinical/constants.js';

const { Schema } = mongoose;

/**
 * Every clinical value carries its provenance. This is the core of the data
 * strategy: we never store a bare number, because "SpO2 94" measured by a pulse
 * oximeter and "SpO2 94" inferred from a patient saying they feel short of breath
 * are not the same evidence, and the confidence score has to be able to tell them
 * apart.
 *
 * A field that is simply absent is represented by omitting the observation
 * entirely — never by a zero or a sentinel. Absence is meaningful and is fed to
 * the model as a real NaN.
 */
export const ObservationSchema = new Schema(
  {
    value: { type: Schema.Types.Mixed, required: true },
    unit: { type: String },
    source: { type: String, enum: SOURCES, required: true },
    observedAt: { type: Date, default: Date.now },
    /**
     * 0..1. Required, not defaulted — build observations with the helpers in
     * src/clinical/observation.js, which derive it from `source` (and, for
     * NLP-inferred values, from ASR × extraction confidence). Requiring it means a
     * value cannot enter the system without a stated degree of trust.
     */
    reliability: { type: Number, min: 0, max: 1, required: true },
    note: { type: String },
  },
  { _id: false },
);

/**
 * The confidence object. No scoring response may omit this — see
 * `assertScored()` in src/clinical/contract.js, which is enforced at the route
 * boundary rather than left to convention.
 */
export const ConfidenceSchema = new Schema(
  {
    score: { type: Number, min: 0, max: 1, required: true },
    band: {
      type: String,
      enum: Object.values(CONFIDENCE_BAND),
      required: true,
    },
    components: {
      completeness: { type: Number, min: 0, max: 1, required: true },
      modelMargin: { type: Number, min: 0, max: 1, required: true },
      inputReliability: { type: Number, min: 0, max: 1, required: true },
      ageBandSupport: { type: Number, min: 0, max: 1, required: true },
    },
    /** Human-readable reasons the confidence is not higher, shown to the nurse. */
    drivers: [{ type: String }],
  },
  { _id: false },
);

/**
 * Nurse-facing explanation chip. `evidence` is the literal value that fired the
 * flag, so the nurse can sanity-check the machine in one glance rather than
 * trusting it.
 */
export const ExplainFlagSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    severity: {
      type: String,
      enum: ['critical', 'warning', 'info'],
      default: 'info',
    },
    evidence: { type: String },
    /** True when this flag exists only because of the patient's age band. */
    ageBandSpecific: { type: Boolean, default: false },
  },
  { _id: false },
);

export const TranscriptSchema = new Schema(
  {
    language: { type: String, enum: LANGUAGES, required: true },
    rawText: { type: String, required: true },
    translatedText: { type: String },
    /**
     * Automatic speech recognition confidence, 0..1. Propagates into the
     * reliability of every field the NLP layer extracts from this transcript.
     */
    asrConfidence: { type: Number, min: 0, max: 1, default: 0.9 },
    capturedAt: { type: Date, default: Date.now },
    /** 'web_speech' for live dictation, 'scripted' for the offline demo fallback. */
    captureMode: {
      type: String,
      enum: ['web_speech', 'scripted', 'typed'],
      default: 'typed',
    },
  },
  { _id: false },
);

export const AgeContextSchema = new Schema(
  {
    ageYears: { type: Number, required: true, min: 0 },
    band: { type: String, enum: AGE_BANDS, required: true },
  },
  { _id: false },
);
