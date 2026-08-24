import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  ConfidenceChip,
  DecayIndicator,
  EsiBadge,
  ExplainFlags,
  formatAge,
  formatWait,
  minutesSince,
} from './clinical.jsx';
import './PatientDetail.css';

const VITAL_ROWS = [
  ['heartRate', 'Heart rate', 'bpm'],
  ['respiratoryRate', 'Respiratory rate', '/min'],
  ['systolicBP', 'Systolic BP', 'mmHg'],
  ['spo2', 'SpO₂', '%'],
  ['temperatureC', 'Temperature', '°C'],
  ['gcs', 'GCS', ''],
  ['painScore', 'Pain (reported)', '/10'],
  ['capillaryRefillSec', 'Cap refill', 's'],
];

const SOURCE_COPY = {
  measured: 'measured',
  clinician_observed: 'observed',
  prior_record: 'prior record',
  patient_reported: 'self-reported',
  proxy_reported: 'via attendant',
  nlp_inferred: 'from speech',
};

const MODE_COPY = {
  full: 'Rules + risk model',
  rules_only: 'Rules only — risk model unavailable',
  start_fallback: 'START protocol fallback — degraded',
};

export function PatientDetail({ encounterId, onOverride, onResolved, clinicians = [], refreshToken }) {
  const [data, setData] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [error, setError] = useState(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIdentity(null);
    setError(null);
    setResolving(false);
    api
      .encounter(encounterId)
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [encounterId, refreshToken]);

  if (error) return <aside className="detail detail--error">{error}</aside>;
  if (!data) return <aside className="detail detail--loading">Loading…</aside>;

  const { encounter, assessments, vitals } = data;
  const latest = assessments?.[0];
  const latestVitals = vitals?.[0];
  const waited = minutesSince(encounter.queue?.lastInformedAt ?? encounter.arrivalAt);

  const reveal = async () => {
    try {
      const clinicians = await api.clinicians();
      const result = await api.revealIdentity(encounterId, { clinicianId: clinicians.clinicians[0]?._id });
      setIdentity(result);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <aside className="detail">
      <header className="detail__head">
        <div>
          <h2 className="detail__ref">{encounter.displayRef}</h2>
          <p className="detail__meta">
            {formatAge(encounter.age?.ageYears)} ·{' '}
            <span className="detail__band">{encounter.age?.band?.replace(/_/g, ' ')}</span> · waiting{' '}
            {formatWait(waited)}
          </p>
        </div>
        <EsiBadge esi={encounter.currentESI} subBand={encounter.queue?.surgeSubBand} size="lg" />
      </header>

      <p className="detail__complaint">{encounter.chiefComplaint}</p>

      <div className="detail__row">
        <ConfidenceChip confidence={encounter.currentConfidence} showBar />
        <DecayIndicator queue={encounter.queue} />
      </div>

      {latest?.mode && latest.mode !== 'full' && (
        <p className="detail__degraded">{MODE_COPY[latest.mode]}</p>
      )}

      {/* Identity is behind a deliberate, audited action. The board runs on
          pseudonymous references so minimisation is demonstrable rather than
          promised — and revealing a name writes an ACCESS_PHI event. */}
      <section className="detail__section">
        <h3>Identity</h3>
        {identity ? (
          <div className="detail__identity">
            <div>{identity.identity?.fullName ?? '—'}</div>
            <div className="detail__muted">{identity.identity?.phone ?? ''}</div>
            <div className="detail__muted">Access logged as audit event #{identity.auditSeq}</div>
          </div>
        ) : (
          <button type="button" className="btn btn--small" onClick={reveal}>
            Reveal identifying details (logged)
          </button>
        )}
      </section>

      {encounter.intake?.transcripts?.length > 0 && (
        <section className="detail__section">
          <h3>What the patient said</h3>
          {encounter.intake.transcripts.map((t, i) => (
            <blockquote key={i} className="detail__quote">
              <span className="detail__lang">{t.language}</span>
              “{t.rawText}”
              <span className="detail__muted"> · speech recognition {Math.round((t.asrConfidence ?? 0) * 100)}%</span>
            </blockquote>
          ))}
          {encounter.intake.extraction?.symptoms?.length > 0 && (
            <p className="detail__extracted">
              Extracted: {encounter.intake.extraction.symptoms.map((s) => s.replace(/_/g, ' ')).join(', ')}
              {encounter.intake.extraction.negations?.length > 0 && (
                <>
                  {' '}
                  · ruled out:{' '}
                  {encounter.intake.extraction.negations.map((s) => s.replace(/_/g, ' ')).join(', ')}
                </>
              )}
            </p>
          )}
          {encounter.intake.extraction?.unmappedTerms?.length > 0 && (
            <p className="detail__unmapped">
              Not understood: {encounter.intake.extraction.unmappedTerms.join(', ')}
            </p>
          )}
        </section>
      )}

      <section className="detail__section">
        <h3>Why this score</h3>
        <ExplainFlags flags={latest?.explainFlags ?? []} />
        {latest?.confidence?.drivers?.length > 0 && (
          <div className="detail__drivers">
            <strong>Why the assistant is unsure:</strong>
            <ul>
              {latest.confidence.drivers.map((driver) => (
                <li key={driver}>{driver}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {latestVitals && (
        <section className="detail__section">
          <h3>Observations</h3>
          <table className="detail__vitals">
            <tbody>
              {VITAL_ROWS.map(([key, label, unit]) => {
                const obs = latestVitals[key];
                return (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    <td className="tabular">
                      {obs ? `${obs.value}${unit}` : <span className="detail__missing">not recorded</span>}
                    </td>
                    <td className="detail__muted">{obs ? SOURCE_COPY[obs.source] ?? obs.source : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="detail__section">
        <h3>Assessment history</h3>
        <ol className="detail__history">
          {(assessments ?? []).map((a) => (
            <li key={a._id}>
              <span className="tabular">ESI {a.fusion?.finalESI}</span>
              <span className="detail__muted">
                {' '}
                · {a.trigger.replace(/_/g, ' ')} · rules said {a.ruleEngine?.esi ?? '—'}, model said{' '}
                {a.model?.esi ?? 'unavailable'}
              </span>
              {a.fusion?.ratchetApplied && <span className="detail__ratchet">escalated for uncertainty</span>}
            </li>
          ))}
        </ol>
      </section>

      <div className="detail__actions">
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={() => onOverride(encounter, latest)}
        >
          Review &amp; override severity
        </button>

        {resolving ? (
          <ResolvePanel
            encounter={encounter}
            clinicians={clinicians}
            onCancel={() => setResolving(false)}
            onResolved={onResolved}
          />
        ) : (
          <button type="button" className="btn btn--block" onClick={() => setResolving(true)}>
            Resolve &amp; clear from queue
          </button>
        )}
      </div>
    </aside>
  );
}

const DISPOSITIONS = [
  {
    status: 'in_treatment',
    label: 'Seen — taken into treatment',
    detail: 'The patient is now being cared for. Removes them from the waiting board.',
  },
  {
    status: 'discharged',
    label: 'Discharged',
    detail: 'Assessment complete and the patient has gone home.',
  },
  {
    status: 'left_without_being_seen',
    label: 'Left without being seen',
    detail: 'The patient is no longer here. Always needs a note of what was attempted.',
  },
];

const MIN_REASON = 20;

/**
 * Clearing a patient off the board.
 *
 * This is a confirmation step rather than a one-click row action, and that is
 * deliberate. Removing an encounter stops the decay clock and takes the patient
 * out of the re-triage loop, so a misclick does not just tidy the screen — it
 * makes someone invisible to every safety mechanism behind it. The action is
 * therefore reached from the detail panel, where the nurse is already looking at
 * who they are about to clear.
 *
 * The reason requirement mirrors the override dialog: the client asks for what
 * the server will demand, so the nurse is not surprised by a refusal — but the
 * server is still the thing enforcing it.
 */
function ResolvePanel({ encounter, clinicians, onCancel, onResolved }) {
  const [status, setStatus] = useState('in_treatment');
  const [reasonText, setReasonText] = useState('');
  const [clinicianId, setClinicianId] = useState(clinicians[0]?._id ?? '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isHighAcuity = (encounter.currentESI ?? 5) <= 2;
  const reasonRequired =
    status === 'left_without_being_seen' || (status === 'discharged' && isHighAcuity);
  const reasonShort = reasonText.trim().length < MIN_REASON;
  const blocked = !clinicianId || (reasonRequired && reasonShort);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.disposition(String(encounter._id), { clinicianId, status, reasonText });
      await onResolved?.();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="resolve">
      <h3 className="resolve__title">Clear {encounter.displayRef} from the queue</h3>

      <div className="resolve__options" role="radiogroup" aria-label="Disposition">
        {DISPOSITIONS.map((option) => (
          <label
            key={option.status}
            className={`resolve__option ${status === option.status ? 'is-selected' : ''}`}
          >
            <input
              type="radio"
              name="disposition"
              value={option.status}
              checked={status === option.status}
              onChange={() => setStatus(option.status)}
            />
            <span>
              <span className="resolve__option-label">{option.label}</span>
              <span className="resolve__option-detail">{option.detail}</span>
            </span>
          </label>
        ))}
      </div>

      {reasonRequired && (
        <div className="resolve__reason">
          <label htmlFor="resolve-reason">
            {status === 'left_without_being_seen'
              ? 'What was attempted before they left?'
              : `Still scored ESI ${encounter.currentESI} — justify closing at this severity`}
          </label>
          <textarea
            id="resolve-reason"
            rows={3}
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder="Minimum 20 characters."
          />
          <span className={`resolve__counter ${reasonShort ? 'is-short' : ''}`}>
            {reasonText.trim().length} / {MIN_REASON}
          </span>
        </div>
      )}

      <label className="resolve__field">
        <span>Recorded by</span>
        <select value={clinicianId} onChange={(e) => setClinicianId(e.target.value)}>
          <option value="">Select clinician…</option>
          {clinicians.map((c) => (
            <option key={c._id} value={c._id}>
              {c.name} · {c.registrationNumber}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="resolve__error">{error}</p>}

      <div className="resolve__buttons">
        <button type="button" className="btn btn--ghost btn--small" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--danger btn--small"
          onClick={submit}
          disabled={blocked || busy}
        >
          {busy ? 'Clearing…' : 'Confirm & clear'}
        </button>
      </div>

      <p className="resolve__note">Recorded as an audit event against the clinician above.</p>
    </div>
  );
}
