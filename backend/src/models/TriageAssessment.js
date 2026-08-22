import mongoose from 'mongoose';
import { ESI_LEVELS, SCORING_MODES, START_CATEGORIES, TRIAGE_TRIGGERS } from '../clinical/constants.js';
import { ConfidenceSchema, ExplainFlagSchema } from './subschemas.js';

const { Schema } = mongoose;

/**
 * An immutable record of one scoring run — the initial triage or any subsequent
 * re-triage. Never updated in place.
 *
 * This document is the reproducibility artifact. Months later, in a morbidity
 * review or a liability inquiry, it must be possible to answer: what did the
 * system see, what did each layer conclude, how sure was it, and why did the
 * final number differ from what the model alone suggested. Everything needed to
 * answer that lives here, including the feature hash that lets the exact input be
 * verified against the model version that scored it.
 */

const FiredRuleSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    /** The ESI this rule floors the assessment at. */
    impliedESI: { type: Number, enum: ESI_LEVELS, required: true },
    severity: { type: String, enum: ['critical', 'warning', 'info'], default: 'warning' },
    rationale: { type: String, required: true },
    evidence: { type: String },
    /** True when the rule exists because of the patient's age band. */
    ageBandSpecific: { type: Boolean, default: false },
    /**
     * Hard red flags cannot be downgraded by the model — only by a clinician,
     * and only with a recorded justification.
     */
    hardRedFlag: { type: Boolean, default: false },
  },
  { _id: false },
);

const ContributionSchema = new Schema(
  {
    feature: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
    /** Signed contribution toward the predicted class. */
    contribution: { type: Number, required: true },
    direction: { type: String, enum: ['toward_urgent', 'toward_non_urgent'], required: true },
  },
  { _id: false },
);

const TriageAssessmentSchema = new Schema(
  {
    encounterRef: { type: Schema.Types.ObjectId, ref: 'Encounter', required: true, index: true },
    patientRef: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },

    /** 1-based, monotonic per encounter. */
    sequence: { type: Number, required: true },
    trigger: { type: String, enum: TRIAGE_TRIGGERS, required: true },
    mode: { type: String, enum: SCORING_MODES, required: true },

    /** Exact feature vector handed to the model, nulls included. */
    featureVector: { type: Schema.Types.Mixed },
    /** sha256 of the canonicalised feature vector — proves what was actually scored. */
    featureHash: { type: String, required: true },

    modelId: { type: String },
    modelVersion: { type: String },

    ruleEngine: {
      esi: { type: Number, enum: ESI_LEVELS },
      firedRules: { type: [FiredRuleSchema], default: [] },
    },

    model: {
      esi: { type: Number, enum: ESI_LEVELS },
      /** p(ESI=1..5), index 0 is ESI 1. */
      classProbabilities: { type: [Number], default: [] },
      topContributions: { type: [ContributionSchema], default: [] },
      /** Set when the ML service was unreachable and the run degraded. */
      unavailableReason: { type: String },
    },

    /** Populated only in SCORING_MODE.START_FALLBACK. */
    startProtocol: {
      category: { type: String, enum: START_CATEGORIES },
      pathway: { type: String, enum: ['start', 'jumpstart'] },
      steps: [{ type: String }],
    },

    /**
     * How the layers were combined. The ratchet may only escalate — see
     * src/clinical/fusion.js. `escalationReason` is null when no escalation
     * beyond `min(rule, model)` was applied.
     */
    fusion: {
      finalESI: { type: Number, enum: ESI_LEVELS, required: true },
      ratchetApplied: { type: Boolean, default: false },
      escalationReason: { type: String },
      /** True when a hard red flag locked the model out of downgrading. */
      redFlagLocked: { type: Boolean, default: false },
      /** Threshold in force at scoring time — widens under surge. */
      escalationThreshold: { type: Number },
    },

    confidence: { type: ConfidenceSchema, required: true },
    explainFlags: { type: [ExplainFlagSchema], default: [] },

    /** Milliseconds from request to scored result, for the "seconds not minutes" claim. */
    latencyMs: { type: Number },

    scoredDuringSurge: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

TriageAssessmentSchema.index({ encounterRef: 1, sequence: -1 });

export const TriageAssessment = mongoose.model('TriageAssessment', TriageAssessmentSchema);
export default TriageAssessment;
