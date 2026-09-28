import { repositories } from '../db/index.js';
import { TRIAGE_TRIGGER } from '../clinical/constants.js';
import { recordPatientReportedWorsening } from './auditService.js';
import { WAITING_STATUSES, scoreAndPersist } from './triageService.js';

/**
 * The two things the waiting-area kiosk can do after registration: hand out a
 * token number, and let a patient say they feel worse.
 */

// Allocation is serialised and remembers the last number it handed out, so two
// arrivals registering at the same moment can never share a token even before
// either encounter is saved. The database maximum is still consulted so
// numbering carries on correctly after a restart.
let allocation = Promise.resolve();
let lastIssued = 0;

export function nextTokenNumber() {
  const next = allocation.then(async () => {
    const [last] = await repositories.encounters.find(
      { tokenNumber: { $gt: 0 } },
      { sort: { tokenNumber: -1 }, limit: 1 },
    );
    lastIssued = Math.max(lastIssued, last?.tokenNumber ?? 0) + 1;
    return lastIssued;
  });
  allocation = next.catch(() => {});
  return next;
}

/** One report per window: a second press should not page the nurse again. */
export const WORSENING_COOLDOWN_MS = 2 * 60 * 1000;

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * A patient pressing "I feel worse".
 *
 * Three effects, none of which touch the ESI directly: the report is written to
 * the audit chain, the patient is re-scored on the spot with everything already
 * known, and an alert is returned for the caller to push to every dashboard.
 * The wait clock is not reset — a self-report is not a clinician's assessment,
 * and resetting it would make an unseen patient's wait look shorter than it is.
 * Whether they are actually sicker is the nurse's call once she has seen them.
 */
export async function reportWorsening({ encounterId, now = new Date() }) {
  const encounter = await repositories.encounters.findById(encounterId);
  if (!encounter) throw httpError('Encounter not found', 404);
  if (!WAITING_STATUSES.includes(encounter.status)) {
    throw httpError('This patient is already with the care team.', 409);
  }

  const last = encounter.patientReportedWorseningAt ? new Date(encounter.patientReportedWorseningAt) : null;
  if (last && now.getTime() - last.getTime() < WORSENING_COOLDOWN_MS) {
    const error = httpError('The nurse has already been told. Someone will come to you shortly.', 429);
    error.alreadyReportedAt = last.toISOString();
    throw error;
  }

  const waitedMinutes =
    (now.getTime() - new Date(encounter.queue?.lastInformedAt ?? encounter.arrivalAt).getTime()) / 60000;

  // Audit before state, so the report exists even if the re-score fails.
  const auditEvent = await recordPatientReportedWorsening({ encounter, waitedMinutes });
  let updated = await repositories.encounters.updateById(encounter._id, { patientReportedWorseningAt: now });

  try {
    const scored = await scoreAndPersist({ encounter: updated, trigger: TRIAGE_TRIGGER.PATIENT_REQUEST });
    updated = scored.encounter;
  } catch (error) {
    console.error(`[kiosk] re-score after worsening report failed for ${encounter.displayRef}:`, error.message);
  }

  return {
    encounter: updated,
    auditEvent,
    alert: {
      kind: 'patient_reported_worse',
      encounterId: String(encounter._id),
      displayRef: encounter.displayRef,
      tokenNumber: encounter.tokenNumber ?? null,
      esi: updated.currentESI,
      minutesWaiting: Math.round(waitedMinutes),
      auditSeq: auditEvent.seq,
    },
  };
}
