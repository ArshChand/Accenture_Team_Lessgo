import mongoose from 'mongoose';
import { AGE_BANDS } from '../clinical/constants.js';

const { Schema } = mongoose;

/**
 * Model provenance and published safety characteristics.
 *
 * The metric that governs deployment here is not accuracy. Accuracy averages over
 * an asymmetric cost: an under-triage (predicting a less urgent level than truth)
 * can kill, while an over-triage costs a bed and some time. So the registry
 * records the under-triage rate — overall and for the critical ESI 1-2 band — and
 * the safety case in docs/ argues from those numbers rather than from accuracy.
 *
 * Per-band metrics are stored because a model can look excellent overall while
 * being unusable on infants, who are 4% of the sample and 100% of the risk.
 */

const BandMetricsSchema = new Schema(
  {
    band: { type: String, enum: AGE_BANDS, required: true },
    support: { type: Number, required: true },
    accuracy: { type: Number },
    /** Fraction of this band predicted less urgent than ground truth. */
    underTriageRate: { type: Number },
    overTriageRate: { type: Number },
  },
  { _id: false },
);

const ModelRegistrySchema = new Schema(
  {
    modelId: { type: String, required: true, unique: true, index: true },
    version: { type: String, required: true },
    algorithm: { type: String, default: 'xgboost.XGBClassifier' },

    trainedAt: { type: Date },
    /** sha256 of the training set, so a result can be tied to the exact data. */
    trainingDataHash: { type: String },
    trainingRowCount: { type: Number },
    featureNames: [{ type: String }],

    metrics: {
      accuracy: { type: Number },
      macroF1: { type: Number },
      /** The number that matters. Lower is safer. */
      underTriageRate: { type: Number },
      /** Under-triage specifically of true ESI 1-2 patients — the lethal quadrant. */
      criticalUnderTriageRate: { type: Number },
      overTriageRate: { type: Number },
      /** Mean |predicted - actual| in ESI levels. */
      meanAbsoluteError: { type: Number },
    },

    perBandMetrics: { type: [BandMetricsSchema], default: [] },

    /**
     * Class weights used at training time to make under-triage expensive. Recorded
     * because "we biased toward escalation" is a claim that should be checkable.
     */
    asymmetricCostMatrix: { type: Schema.Types.Mixed },

    /** Known limitations, published rather than buried. */
    limitations: [{ type: String }],

    active: { type: Boolean, default: false, index: true },
    approvedAt: { type: Date },
    approvedBy: { type: String },
  },
  { timestamps: true },
);

export const ModelRegistry = mongoose.model('ModelRegistry', ModelRegistrySchema);
export default ModelRegistry;
