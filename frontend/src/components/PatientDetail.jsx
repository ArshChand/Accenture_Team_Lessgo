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

export function PatientDetail({ encounterId, onOverride, refreshToken }) {
  const [data, setData] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setIdentity(null);
    setError(null);
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

      <button type="button" className="btn btn--primary detail__override" onClick={() => onOverride(encounter, latest)}>
        Review &amp; override severity
      </button>
    </aside>
  );
}
