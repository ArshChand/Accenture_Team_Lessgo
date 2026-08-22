import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Record of the ED entering or leaving surge state, and what the system did
 * differently while it was there.
 *
 * The policy snapshot is stored per event rather than assumed from config,
 * because "what were the rules at 14:20 last Tuesday" is a question an after-action
 * review will actually ask. Note that `safeWaitMinutes` is included in the
 * snapshot specifically so a reviewer can confirm it was *not* relaxed: surge
 * changes what the system shows and how often it re-checks, never how long a
 * patient may safely wait.
 */
const SurgeEventSchema = new Schema(
  {
    state: { type: String, enum: ['entered', 'exited'], required: true },
    occurredAt: { type: Date, default: Date.now, index: true },

    trigger: {
      type: String,
      enum: ['arrival_rate', 'queue_per_nurse', 'manual', 'rate_normalised'],
      required: true,
    },

    metrics: {
      arrivalsPerHour: { type: Number },
      baselineArrivalsPerHour: { type: Number },
      multiple: { type: Number },
      queueDepth: { type: Number },
      nursesOnDuty: { type: Number },
      queuePerNurse: { type: Number },
      /**
       * Aggregate minutes by which waiting patients exceed their safe wait.
       * Surge does not hide breaches by loosening thresholds; it totals them here
       * so the cost of being over capacity stays visible to the charge nurse.
       */
      capacityDebtMinutes: { type: Number },
    },

    policyApplied: {
      escalationThreshold: { type: Number },
      esi3SubBandingEnabled: { type: Boolean },
      lowAcuityReassessIntervalMs: { type: Number },
      dashboardMode: { type: String, enum: ['full', 'action_list'] },
      /** Always the unmodified table. Present as proof of what did not change. */
      safeWaitMinutes: { type: Schema.Types.Mixed },
    },

    durationMs: { type: Number },
    notes: { type: String },
  },
  { timestamps: true },
);

export const SurgeEvent = mongoose.model('SurgeEvent', SurgeEventSchema);
export default SurgeEvent;
