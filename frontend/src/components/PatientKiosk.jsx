import { useState } from 'react';
import { api } from '../api.js';
import { IntakeKiosk } from './IntakeKiosk.jsx';
import './PatientKiosk.css';

const TICKET_KEY = 'triagehandler.ticket';

function readTicket() {
  try {
    const raw = window.sessionStorage.getItem(TICKET_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeTicket(ticket) {
  try {
    if (ticket) window.sessionStorage.setItem(TICKET_KEY, JSON.stringify(ticket));
    else window.sessionStorage.removeItem(TICKET_KEY);
  } catch {
    // Storage can be unavailable (private mode); the token screen still works for this visit.
  }
}

/**
 * The patient's side of the department: register, get a token, and be able to
 * say "I feel worse". What it deliberately never shows is a severity score or
 * a queue position — both change as sicker patients arrive, and a patient who
 * watches either move the wrong way stops trusting the queue.
 */
export function PatientKiosk({ onSwitchRole }) {
  const [ticket, setTicket] = useState(readTicket);

  const issue = (encounterId, encounter) => {
    const next = { encounterId, tokenNumber: encounter?.tokenNumber ?? null, registeredAt: new Date().toISOString() };
    writeTicket(next);
    setTicket(next);
  };

  const clear = () => {
    writeTicket(null);
    setTicket(null);
  };

  return (
    <div className="patient-kiosk">
      <header className="patient-kiosk__head">
        <div className="patient-kiosk__brand">
          <span className="patient-kiosk__mark" aria-hidden="true">
            T
          </span>
          <span>TriageHandler · Emergency Department</span>
        </div>
        <button type="button" className="patient-kiosk__staff" onClick={onSwitchRole}>
          Staff? Switch
        </button>
      </header>

      <main className="patient-kiosk__main">
        {ticket ? <TokenScreen ticket={ticket} onDone={clear} /> : <IntakeKiosk mode="patient" onArrival={issue} />}
      </main>
    </div>
  );
}

function TokenScreen({ ticket, onDone }) {
  const [state, setState] = useState({ kind: 'idle' });

  const reportWorse = async () => {
    setState({ kind: 'sending' });
    try {
      await api.reportWorse(ticket.encounterId);
      setState({ kind: 'sent' });
    } catch (err) {
      if (err.status === 429) setState({ kind: 'sent', repeat: true });
      else if (err.status === 409) setState({ kind: 'seen' });
      else setState({ kind: 'error', message: err.message });
    }
  };

  return (
    <section className="token" aria-live="polite">
      <p className="token__label">Your token number</p>
      <p className="token__number tabular">{ticket.tokenNumber ?? '—'}</p>
      <p className="token__lead">Please take a seat. A nurse will call this number.</p>
      <p className="token__explain">
        Patients are seen in order of how urgent they are, not the order they arrived. You are on the list and
        the care team can see you.
      </p>

      <div className="token__worse">
        {state.kind === 'sent' ? (
          <p className="token__ack">
            <strong>A nurse has been told.</strong>{' '}
            {state.repeat ? 'We already have your message — someone is on their way.' : 'Someone will come to you shortly.'}
          </p>
        ) : state.kind === 'seen' ? (
          <p className="token__ack">
            <strong>You are already with the care team.</strong> Please speak to the nurse near you.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="token__worse-btn"
              onClick={reportWorse}
              disabled={state.kind === 'sending'}
            >
              {state.kind === 'sending' ? 'Telling the nurse…' : 'I feel worse'}
            </button>
            <p className="token__worse-hint">
              Press this if you feel worse while waiting — more pain, trouble breathing, feeling faint. If you
              cannot breathe or have collapsed, shout for help straight away.
            </p>
            {state.kind === 'error' && <p className="token__error">Could not reach the nurse station: {state.message}</p>}
          </>
        )}
      </div>

      <button type="button" className="btn token__done" onClick={onDone}>
        Register another patient
      </button>
    </section>
  );
}
