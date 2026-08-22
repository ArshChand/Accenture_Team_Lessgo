import mongoose from 'mongoose';
import { CLINICIAN_ROLES, CLINICIAN_ROLE } from '../clinical/constants.js';

const { Schema } = mongoose;

/**
 * The prototype does not implement authentication — a hospital deployment would
 * federate against the existing hospital identity provider rather than hold its
 * own credentials. What matters for the accountability requirement is that every
 * override resolves to a named, registered professional, so that is what this
 * models.
 */
const ClinicianSchema = new Schema(
  {
    name: { type: String, required: true },
    role: { type: String, enum: CLINICIAN_ROLES, default: CLINICIAN_ROLE.TRIAGE_NURSE },
    /** Council registration number, written into every audit event this actor causes. */
    registrationNumber: { type: String, required: true, unique: true },
    /** Only roles with this flag may change a standing ESI. */
    canOverride: { type: Boolean, default: true },
    /** Reveal identifying patient fields — gated separately from override rights. */
    canViewIdentity: { type: Boolean, default: true },
    shift: { type: String },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Clinician = mongoose.model('Clinician', ClinicianSchema);
export default Clinician;
