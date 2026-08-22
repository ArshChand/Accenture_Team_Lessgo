import mongoose from 'mongoose';
import { ObservationSchema } from './subschemas.js';

const { Schema } = mongoose;

/**
 * Append-only vital-sign time series: one document per recording event, never
 * mutated. Deterioration is detected by diffing consecutive documents, which means
 * the evidence for a re-triage escalation is still on disk months later when
 * someone asks why the queue reordered itself.
 *
 * Every vital is an Observation, so "HR 120 measured by monitor" and "HR 120 the
 * attendant thinks" are distinguishable. Absent vitals are absent, not zero.
 */
const VitalsObservationSchema = new Schema(
  {
    encounterRef: { type: Schema.Types.ObjectId, ref: 'Encounter', required: true, index: true },
    patientRef: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },

    recordedAt: { type: Date, default: Date.now, index: true },
    recordedBy: { type: String },

    heartRate: { type: ObservationSchema },
    respiratoryRate: { type: ObservationSchema },
    systolicBP: { type: ObservationSchema },
    diastolicBP: { type: ObservationSchema },
    spo2: { type: ObservationSchema },
    temperatureC: { type: ObservationSchema },
    /** Glasgow Coma Scale 3..15. */
    gcs: { type: ObservationSchema },
    /** AVPU is often all that is available at the door; kept alongside GCS. */
    avpu: { type: ObservationSchema },
    /** Self-reported 0..10. Deliberately low-reliability — see the discordance rule. */
    painScore: { type: ObservationSchema },
    capillaryRefillSec: { type: ObservationSchema },
    bloodGlucose: { type: ObservationSchema },

    /**
     * Objective distress cues a nurse can observe in seconds without equipment.
     * These are what let the system catch a patient who under-reports pain.
     */
    observedCues: {
      diaphoresis: { type: Boolean },
      guarding: { type: Boolean },
      accessoryMuscleUse: { type: Boolean },
      unableToSpeakFullSentences: { type: Boolean },
      pallor: { type: Boolean },
      cyanosis: { type: Boolean },
      /** Paediatric: alert, engaged, consolable — the "does the child look well" gestalt. */
      playfulAndConsolable: { type: Boolean },
      lethargic: { type: Boolean },
    },

    /** Derived at write time so re-triage comparisons are cheap and reproducible. */
    derived: {
      /** HR / systolic BP. > 0.9 suggests occult shock even with a "normal" BP. */
      shockIndex: { type: Number },
      /** NEWS2-style aggregate, age-band calibrated. Not a substitute for the rules. */
      newsLikeScore: { type: Number },
      /** Threshold breaches named against this patient's age band, not adult norms. */
      ageAdjustedFlags: [{ type: String }],
    },

    /** Set when this reading was taken because the queue engine asked for it. */
    triggeredByReassessment: { type: Boolean, default: false },
  },
  { timestamps: true },
);

VitalsObservationSchema.index({ encounterRef: 1, recordedAt: -1 });

export const VitalsObservation = mongoose.model('VitalsObservation', VitalsObservationSchema);
export default VitalsObservation;
