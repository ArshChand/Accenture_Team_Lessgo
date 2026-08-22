import { useEffect, useMemo, useState } from 'react';
import { ESI_LABELS, EsiBadge } from './clinical.jsx';
import './OverrideModal.css';

const REASON_COPY = {
  CLINICAL_GESTALT: 'Clinical judgement — the patient does not look like the score',
  VITALS_UNRELIABLE: 'Vitals unreliable or since repeated',
  ADDITIONAL_HISTORY_OBTAINED: 'Additional history obtained',
  MODEL_MISSED_RED_FLAG: 'Assistant missed a red flag',
  PATIENT_APPEARS_WELL: 'Patient appears well on assessment',
  RESOURCE_CONSTRAINT: 'Resource or capacity constraint',
  OTHER: 'Other',
};

const MIN_REASON_LENGTH = 20;

/**
 * The override dialog.
 *
 * The interface makes the asymmetry of the two errors visible. Raising a
 * patient's priority is one click and asks for nothing: over-triage costs a bed.
 * Lowering it demands a reason code, a written justification, and an explicit
 * attestation that the clinician has actually assessed the patient — because
 * under-triage can kill, and the friction should reflect that.
 *
 * None of these constraints are enforced here. The server rejects an
 * insufficient override regardless of what this form allows, because a check
 * that lives only in the dialog is a usability feature rather than a safeguard.
 * What the form does is explain the rule *before* the nurse hits a wall, and
 * surface the server's refusal verbatim if she does.
 */
export function OverrideModal({ encounter, assessment, clinicians, onClose, onSubmit }) {
  const [newESI, setNewESI] = useState(encounter.currentESI);
  const [clinicianId, setClinicianId] = useState(clinicians[0]?._id ?? '');
  const [reasonCode, setReasonCode] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [attested, setAttested] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);

  const currentESI = encounter.currentESI;
  const isDeEscalation = newESI > currentESI;
  const isEscalation = newESI < currentESI;
  const unchanged = newESI === currentESI;

  // Switching direction invalidates the attestation: it was given for a
  // particular decision, not as a standing permission.
  useEffect(() => {
    if (!isDeEscalation) setAttested(false);
  }, [isDeEscalation]);

  const blockers = useMemo(() => {
    const issues = [];
    if (unchanged) issues.push('Choose a different severity level.');
    if (!clinicianId) issues.push('Select the clinician making this decision.');
    if (!reasonCode) issues.push('Select a reason.');
    if (isDeEscalation) {
      if (reasonText.trim().length < MIN_REASON_LENGTH) {
        issues.push(
          `Lowering priority needs at least ${MIN_REASON_LENGTH} characters of justification (${reasonText.trim().length} so far).`,
        );
      }
      if (!attested) issues.push('Confirm you have assessed this patient.');
    }
    return issues;
  }, [unchanged, clinicianId, reasonCode, isDeEscalation, reasonText, attested]);

  const submit = async (event) => {
    event.preventDefault();
    if (blockers.length) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await onSubmit({
        clinicianId,
        newESI,
        reasonCode,
        reasonText: reasonText.trim() || undefined,
        assessmentAttested: attested,
      });
      onClose();
    } catch (error) {
      // The server's own words: it explains exactly which safeguard refused.
      setServerError(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="override-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="override-title">Override severity — {encounter.displayRef}</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <form onSubmit={submit} className="modal__body">
          <div className="override__current">
            <span className="override__current-label">Assistant assigned</span>
            <EsiBadge esi={currentESI} />
            {assessment?.confidence && (
              <span className="override__conf">
                confidence {Math.round(assessment.confidence.score * 100)}% ({assessment.confidence.band})
              </span>
            )}
          </div>

          <fieldset className="override__levels">
            <legend>New severity</legend>
            <div className="override__level-grid">
              {[1, 2, 3, 4, 5].map((level) => (
                <label
                  key={level}
                  className={`override__level ${newESI === level ? 'is-active' : ''} ${
                    level < currentESI ? 'is-escalation' : level > currentESI ? 'is-deescalation' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="esi"
                    value={level}
                    checked={newESI === level}
                    onChange={() => setNewESI(level)}
                  />
                  <strong className="tabular">{level}</strong>
                  <span>{ESI_LABELS[level]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {isEscalation && (
            <p className="override__notice override__notice--fast">
              Raising priority. This is applied immediately and needs no written justification.
            </p>
          )}
          {isDeEscalation && (
            <p className="override__notice override__notice--slow">
              Lowering priority. Under-triage carries a far higher cost than over-triage, so this
              requires a written justification and your confirmation that you have assessed the patient.
            </p>
          )}

          <label className="field">
            <span className="field__label">Clinician</span>
            <select value={clinicianId} onChange={(e) => setClinicianId(e.target.value)}>
              <option value="">Select…</option>
              {clinicians.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name} — {c.registrationNumber}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Reason</span>
            <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">Select a reason…</option>
              {Object.entries(REASON_COPY).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            <span className="field__hint">
              A structured reason lets the department measure where the assistant is wrong, which free
              text alone cannot.
            </span>
          </label>

          <label className="field">
            <span className="field__label">
              Justification {isDeEscalation ? <strong>(required)</strong> : '(optional)'}
            </span>
            <textarea
              rows={3}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder={
                isDeEscalation
                  ? 'What did you find on assessment that the assistant did not have?'
                  : 'Optional note'
              }
            />
            {isDeEscalation && (
              <span className="field__hint tabular">
                {reasonText.trim().length} / {MIN_REASON_LENGTH} characters
              </span>
            )}
          </label>

          {isDeEscalation && (
            <label className="attest">
              <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
              <span>I have physically assessed this patient.</span>
            </label>
          )}

          {blockers.length > 0 && (
            <ul className="override__blockers">
              {blockers.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}

          {serverError && (
            <p className="override__server-error">
              <strong>Refused by the server:</strong> {serverError}
            </p>
          )}

          <footer className="modal__foot">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={`btn btn--primary ${isDeEscalation ? 'btn--caution' : ''}`}
              disabled={blockers.length > 0 || submitting}
            >
              {submitting ? 'Recording…' : isDeEscalation ? 'Lower priority' : 'Apply override'}
            </button>
          </footer>

          <p className="override__audit-note">
            This decision is written to a tamper-evident audit log with your name, registration number,
            the assistant's original score, and the model version behind it.
          </p>
        </form>
      </div>
    </div>
  );
}
