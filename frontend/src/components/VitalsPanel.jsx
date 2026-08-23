import { useState } from 'react';
import { api } from '../api.js';
import './VitalsPanel.css';

/**
 * Recording observations.
 *
 * Every field is optional on purpose. A patient nobody has fully measured is the
 * normal case at triage, not an error state, and forcing a nurse to invent a
 * number to get past a form is precisely how bad data enters a clinical system.
 * Blank means absent all the way down: it is never sent, never imputed, and the
 * assistant lowers its own confidence accordingly.
 *
 * Saving triggers a re-score through the real pipeline, so new observations are a
 * re-triage trigger — this is how deterioration in the waiting room gets caught.
 */

const FIELDS = [
  ['heartRate', 'Heart rate', 'bpm'],
  ['respiratoryRate', 'Resp rate', '/min'],
  ['systolicBP', 'Systolic BP', 'mmHg'],
  ['diastolicBP', 'Diastolic BP', 'mmHg'],
  ['spo2', 'SpO₂', '%'],
  ['temperatureC', 'Temperature', '°C'],
  ['gcs', 'GCS', '3–15'],
  ['capillaryRefillSec', 'Cap refill', 's'],
];

const CUES = [
  ['diaphoresis', 'Sweating'],
  ['pallor', 'Pale'],
  ['guarding', 'Guarding'],
  ['accessoryMuscleUse', 'Accessory muscles'],
  ['unableToSpeakFullSentences', 'Cannot finish sentences'],
  ['cyanosis', 'Cyanosis'],
  ['lethargic', 'Lethargic'],
  ['playfulAndConsolable', 'Playful / consolable'],
];

export function VitalsPanel({ encounterId, onSaved }) {
  const [values, setValues] = useState({});
  const [pain, setPain] = useState('');
  const [cues, setCues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key, value) => setValues((prior) => ({ ...prior, [key]: value }));

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const payload = { observedCues: cues };
      for (const [key] of FIELDS) {
        const raw = values[key];
        if (raw === undefined || raw === '') continue; // absent stays absent
        payload[key] = { value: Number(raw), source: 'measured', reliability: 1.0 };
      }
      if (pain !== '') {
        // Self-reported, and weighted as such: the discordance rule exists because
        // people under-report, so this cannot be trusted like a monitor reading.
        payload.painScore = { value: Number(pain), source: 'patient_reported', reliability: 0.6 };
      }

      const result = await api.recordVitals(encounterId, payload);
      onSaved?.(result);
      setValues({});
      setPain('');
      setCues({});
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Collapsed by default. Reading the queue is the common act and recording a set
   * of observations is the occasional one, so the form should not permanently cost
   * the board four rows of height to sit open on a patient nobody is measuring.
   */
  return (
    <details className="vitals">
      <summary className="vitals__summary">
        <span className="vitals__summary-title">Record observations</span>
        <span className="vitals__summary-hint">
          Vitals, bedside cues — saving re-scores the patient
        </span>
      </summary>

      <form className="vitals__form" onSubmit={save}>
        <p className="vitals__note">
          Leave anything unmeasured blank — the assistant accounts for what is missing.
        </p>

        <div className="vitals__grid">
          {FIELDS.map(([key, label, unit]) => (
            <label key={key} className="vitals__field">
              <span>
                {label} <em>{unit}</em>
              </span>
              <input
                type="number"
                step="any"
                value={values[key] ?? ''}
                onChange={(e) => set(key, e.target.value)}
              />
            </label>
          ))}
          <label className="vitals__field">
            <span>
              Pain <em>0–10, self-reported</em>
            </span>
            <input type="number" min="0" max="10" value={pain} onChange={(e) => setPain(e.target.value)} />
          </label>
        </div>

        <fieldset className="vitals__cues">
          <legend>Observed at the bedside</legend>
          {CUES.map(([key, label]) => (
            <label key={key} className={`vitals__cue ${cues[key] ? 'is-on' : ''}`}>
              <input
                type="checkbox"
                checked={Boolean(cues[key])}
                onChange={(e) => setCues((prior) => ({ ...prior, [key]: e.target.checked }))}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {error && <p className="vitals__error">{error}</p>}

        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Scoring…' : 'Save and re-score'}
        </button>
      </form>
    </details>
  );
}
