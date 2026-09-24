import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './RoleSelect.css';

const ROLES = [
  {
    id: 'patient',
    title: "I'm a patient",
    subtitle: 'or here with one',
    description: 'Tell us what is wrong in Kannada, Hindi or English and get a token number.',
    access: 'No sign-in needed',
    needsPin: false,
  },
  {
    id: 'nurse',
    title: 'Nurse / triage staff',
    subtitle: 'on shift in the department',
    description: 'The live triage queue, patient intake, alerts and the audit trail.',
    access: 'Staff PIN',
    needsPin: true,
  },
  {
    id: 'ed_head',
    title: 'ED head',
    subtitle: 'running the department',
    description: 'Command centre: resources, capacity, surge and department metrics.',
    access: 'Staff PIN',
    needsPin: true,
  },
];

const PIN_LENGTH = 4;

/**
 * The first screen: who is using this device.
 *
 * A patient is never asked to sign in — in an emergency department, a login
 * screen between a frightened person and "tell us what is wrong" is the wrong
 * design. Staff views sit behind a short PIN, the prototype's stand-in for the
 * badge tap a real deployment would use.
 */
export function RoleSelect({ onChoose }) {
  const [pinFor, setPinFor] = useState(null);

  const pick = (role) => {
    if (role.needsPin) setPinFor(role);
    else onChoose(role.id);
  };

  return (
    <div className="role-select">
      <div className="role-select__inner">
        <header className="role-select__brand">
          <span className="role-select__mark" aria-hidden="true">
            T
          </span>
          <div>
            <h1>TriageHandler</h1>
            <p>Emergency Department · Team Lessgo</p>
          </div>
        </header>

        <h2 className="role-select__question">Who is using this screen?</h2>

        <div className="role-select__grid">
          {ROLES.map((role) => (
            <button
              key={role.id}
              type="button"
              className={`role-card role-card--${role.id}`}
              onClick={() => pick(role)}
            >
              <span className={`role-card__access ${role.needsPin ? '' : 'role-card__access--open'}`}>
                {role.access}
              </span>
              <span className="role-card__title">{role.title}</span>
              <span className="role-card__subtitle">{role.subtitle}</span>
              <span className="role-card__desc">{role.description}</span>
              <span className="role-card__go" aria-hidden="true">
                Continue &gt;
              </span>
            </button>
          ))}
        </div>

        <p className="role-select__note">
          Patients never need to sign in. If you are unwell and alone, choose the first option — a nurse reviews
          every entry.
        </p>
      </div>

      {pinFor && (
        <PinDialog
          role={pinFor}
          onCancel={() => setPinFor(null)}
          onSuccess={() => {
            const chosen = pinFor.id;
            setPinFor(null);
            onChoose(chosen);
          }}
        />
      )}
    </div>
  );
}

function PinDialog({ role, onCancel, onSuccess }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (pin.length !== PIN_LENGTH) return;
    let cancelled = false;
    setChecking(true);
    api
      .staffSession(role.id, pin)
      .then(() => !cancelled && onSuccess())
      .catch((err) => {
        if (cancelled) return;
        setError(err.status === 401 ? 'That PIN is not right. Try again.' : err.message);
        setPin('');
      })
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, [pin, role.id, onSuccess]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onCancel();
      else if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') setPin((current) => current.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const press = (digit) => {
    if (checking) return;
    setError(null);
    setPin((current) => (current.length < PIN_LENGTH ? current + digit : current));
  };

  return (
    <div className="pin-dialog__backdrop" role="presentation" onClick={onCancel}>
      <div
        className="pin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="pin-title">{role.title}</h3>
        <p className="pin-dialog__hint">Enter your 4-digit staff PIN</p>

        <div className={`pin-dialog__dots ${error ? 'is-error' : ''}`} aria-live="polite" aria-label={`${pin.length} of ${PIN_LENGTH} digits entered`}>
          {Array.from({ length: PIN_LENGTH }, (_, index) => (
            <span key={index} className={`pin-dialog__dot ${index < pin.length ? 'is-filled' : ''}`} />
          ))}
        </div>
        <p className="pin-dialog__error" role="alert">
          {error ?? (checking ? 'Checking…' : ' ')}
        </p>

        <div className="pin-dialog__pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button key={digit} type="button" onClick={() => press(digit)} disabled={checking}>
              {digit}
            </button>
          ))}
          <button type="button" className="pin-dialog__aux" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => press('0')} disabled={checking}>
            0
          </button>
          <button
            type="button"
            className="pin-dialog__aux"
            onClick={() => setPin((current) => current.slice(0, -1))}
            disabled={checking || pin.length === 0}
            aria-label="Delete last digit"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
