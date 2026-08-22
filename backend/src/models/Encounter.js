import mongoose from 'mongoose';
import {
  ARRIVAL_MODES,
  DECAY_STATUS,
  DECAY_STATUSES,
  ENCOUNTER_STATUS,
  ENCOUNTER_STATUSES,
  ESI_LEVELS,
} from '../clinical/constants.js';
import { AgeContextSchema, ConfidenceSchema, TranscriptSchema } from './subschemas.js';

const { Schema } = mongoose;

/**
 * Live queue state. Recomputed by the TriageEngine tick; the only part of an
 * encounter that changes frequently.
 */
const QueueStateSchema = new Schema(
  {
    /** Composite ordering key. See src/queue/decay.js for the formula. */
    priorityScore: { type: Number, default: 0, index: true },
    /** minutesWaiting / safeWaitMinutes. > 1 means the safe wait has been breached. */
    decayRatio: { type: Number, default: 0 },
    decayStatus: { type: String, enum: DECAY_STATUSES, default: DECAY_STATUS.GREEN },
    /** Copied from SAFE_WAIT_MINUTES at assignment so history stays interpretable. */
    safeWaitMinutes: { type: Number },
    /** First moment the safe wait was exceeded. Never cleared — it is evidence. */
    breachedAt: { type: Date },
    reassessmentDueAt: { type: Date },
    lastReassessedAt: { type: Date },
    reassessCount: { type: Number, default: 0 },
    /** Bonus applied for infants, the very old, and unaccompanied patients. */
    vulnerabilityBonus: { type: Number, default: 0 },
    /**
     * Under surge, ESI 3 splits into 3A / 3B by deterioration risk. Null outside
     * surge. ESI 3 is roughly half of real ED volume, so it is where surge triage
     * actually breaks down — a single undifferentiated bucket is useless at 3x.
     */
    surgeSubBand: { type: String, enum: ['3A', '3B', null], default: null },
  },
  { _id: false },
);

const IntakeSchema = new Schema(
  {
    transcripts: { type: [TranscriptSchema], default: [] },
    /** Structured output of the NLP extraction step. */
    extraction: {
      symptoms: [{ type: String }],
      negations: [{ type: String }],
      onsetHours: { type: Number },
      severityWords: [{ type: String }],
      /** 0..1 confidence of the extractor itself, distinct from ASR confidence. */
      extractionConfidence: { type: Number, min: 0, max: 1 },
      /** Terms the extractor saw but could not map — surfaced to the nurse verbatim. */
      unmappedTerms: [{ type: String }],
    },
    /** True when intake was completed by an attendant rather than the patient. */
    viaProxy: { type: Boolean, default: false },
    completedAt: { type: Date },
  },
  { _id: false },
);

const EncounterSchema = new Schema(
  {
    patientRef: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    /** Denormalised for queue rendering without a join or a PHI access event. */
    displayRef: { type: String, required: true },

    arrivalAt: { type: Date, default: Date.now, index: true },
    mode: { type: String, enum: ARRIVAL_MODES, default: 'walk_in' },

    /** Age is frozen at arrival: a birthday mid-encounter must not silently re-band. */
    age: { type: AgeContextSchema, required: true },

    chiefComplaint: { type: String, required: true },
    intake: { type: IntakeSchema, default: () => ({}) },

    currentESI: { type: Number, enum: ESI_LEVELS, index: true },
    currentConfidence: { type: ConfidenceSchema },
    /** Whether the standing ESI came from the assistant or from a human override. */
    assignedBy: { type: String, enum: ['ai', 'nurse'], default: 'ai' },
    assignedAt: { type: Date },

    /** The AI's original recommendation, preserved even after an override. */
    aiRecommendedESI: { type: Number, enum: ESI_LEVELS },

    latestAssessmentRef: { type: Schema.Types.ObjectId, ref: 'TriageAssessment' },
    latestVitalsRef: { type: Schema.Types.ObjectId, ref: 'VitalsObservation' },

    status: {
      type: String,
      enum: ENCOUNTER_STATUSES,
      default: ENCOUNTER_STATUS.WAITING,
      index: true,
    },
    statusChangedAt: { type: Date, default: Date.now },

    queue: { type: QueueStateSchema, default: () => ({}) },

    /** Snapshot of ED conditions at arrival, for after-action analysis. */
    surgeContext: {
      arrivedDuringSurge: { type: Boolean, default: false },
      queueDepthAtArrival: { type: Number },
      arrivalsPerHourAtArrival: { type: Number },
    },

    /** Set when the patient uses the "I feel worse" control in the waiting area. */
    patientReportedWorseningAt: { type: Date },

    /** True for the synthetic surge cohort, so demo metrics can separate them out. */
    isSurgeCohort: { type: Boolean, default: false },

    zone: { type: String, default: 'main' },
  },
  { timestamps: true },
);

EncounterSchema.index({ status: 1, 'queue.priorityScore': -1 });
EncounterSchema.index({ status: 1, updatedAt: -1 });

export const Encounter = mongoose.model('Encounter', EncounterSchema);
export default Encounter;
