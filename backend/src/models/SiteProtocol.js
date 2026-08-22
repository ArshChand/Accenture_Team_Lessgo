import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * A hospital's clinical protocol, stored as *overrides* against the reference
 * protocol rather than as a complete table.
 *
 * Storing deltas is a safety decision as much as an ergonomic one. If each site
 * held a full copy of every threshold, a fix to the reference protocol would have
 * to be replayed by hand into every site document, and the sites that missed it
 * would drift silently. Here a site document says only what that hospital does
 * differently, and everything else tracks the reference.
 *
 * The stored document is never trusted directly: it is merged over the defaults
 * and then run through `validateProtocol`, which enforces guardrails a site
 * cannot raise — maximum safe waiting times, the floor on uncertainty escalation,
 * threshold ordering, and the set of rules that may not be switched off.
 */
const SiteProtocolSchema = new Schema(
  {
    siteId: { type: String, required: true, unique: true, index: true },
    siteName: { type: String, required: true },
    siteType: {
      type: String,
      enum: [
        'reference',
        'tertiary_trauma',
        'district_hospital',
        'rural_chc',
        'specialty_paediatric',
        'specialty_cardiac',
        'other',
      ],
      default: 'other',
    },
    version: { type: String, default: '1.0.0' },
    description: { type: String },

    /**
     * Partial protocol document. Deep-merged over the reference protocol at load
     * time; anything absent is inherited.
     */
    overrides: { type: Schema.Types.Mixed, default: () => ({}) },

    /** Only one protocol per site is active at a time. */
    active: { type: Boolean, default: false, index: true },

    /**
     * A clinical protocol is a medical governance artifact, not a settings page.
     * Recording who approved it, and when, is what makes a threshold change
     * reviewable after an incident.
     */
    approvedBy: { type: String },
    approvedByRegistration: { type: String },
    approvedAt: { type: Date },

    /** Result of the last validation run, so an invalid draft cannot be activated unnoticed. */
    lastValidation: {
      valid: { type: Boolean },
      errors: [{ type: String }],
      checkedAt: { type: Date },
    },
  },
  { timestamps: true },
);

export const SiteProtocol = mongoose.model('SiteProtocol', SiteProtocolSchema);
export default SiteProtocol;
