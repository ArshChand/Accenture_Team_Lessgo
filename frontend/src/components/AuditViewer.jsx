import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import './AuditViewer.css';

/**
 * The audit trail, with live chain verification.
 *
 * Showing the log is table stakes; showing that it has not been altered is the
 * point. The verify button walks the hash chain server-side and reports the first
 * break and its kind, so "the record is intact" is something a reviewer can check
 * for themselves rather than something the system asserts about itself.
 */

const EVENT_COPY = {
  TRIAGE_ASSIGNED: 'Assistant assigned severity',
  TRIAGE_REASSESSED: 'Assistant re-assessed',
  TRIAGE_OVERRIDE: 'Clinician override',
  ACCESS_PHI: 'Identifying data revealed',
  WAIT_THRESHOLD_BREACHED: 'Safe wait exceeded',
  SURGE_STATE_CHANGED: 'Surge state changed',
  CORRECTION: 'Correction',
};

export function AuditViewer({ encounterRef, refreshToken }) {
  const [events, setEvents] = useState([]);
  const [verification, setVerification] = useState(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    const { events: rows } = await api.audit({ encounterRef, limit: 60 });
    setEvents(rows);
  }, [encounterRef]);

  useEffect(() => {
    load().catch(() => setEvents([]));
  }, [load, refreshToken]);

  const verify = async () => {
    setVerifying(true);
    try {
      setVerification(await api.verifyAudit());
    } catch (error) {
      setVerification({ valid: false, message: error.message });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section className="audit">
      <header className="audit__head">
        <h3>Audit trail{encounterRef ? ' — this patient' : ''}</h3>
        <button type="button" className="btn btn--small" onClick={verify} disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify chain integrity'}
        </button>
      </header>

      {verification && (
        <p className={`audit__verdict audit__verdict--${verification.valid ? 'good' : 'bad'}`}>
          <strong>{verification.valid ? 'Chain intact.' : 'Chain broken.'}</strong> {verification.message}
        </p>
      )}

      {events.length === 0 ? (
        <p className="audit__empty">No events recorded yet.</p>
      ) : (
        <ol className="audit__list">
          {events.map((event) => (
            <li key={event.hash} className={`audit__event audit__event--${event.eventType.toLowerCase()}`}>
              <div className="audit__event-head">
                <span className="audit__seq tabular">#{event.seq}</span>
                <span className="audit__type">{EVENT_COPY[event.eventType] ?? event.eventType}</span>
                <span className="audit__when">{new Date(event.occurredAt).toLocaleTimeString()}</span>
              </div>

              <div className="audit__actor">
                {event.actor?.name}
                {event.actor?.registrationNumber && event.actor.registrationNumber !== 'SYSTEM' && (
                  <span className="audit__reg"> · {event.actor.registrationNumber}</span>
                )}
              </div>

              {event.before?.esi != null && event.after?.esi != null && (
                <div className="audit__change">
                  ESI {event.before.esi} <span className="audit__chevron">&gt;</span> {event.after.esi}
                  {event.after.direction && (
                    <span className={`audit__dir audit__dir--${event.after.direction}`}>
                      {event.after.direction === 'escalation' ? 'escalated' : 'de-escalated'}
                    </span>
                  )}
                </div>
              )}

              {event.reasonCode && <div className="audit__reason">{event.reasonCode.replace(/_/g, ' ')}</div>}
              {event.reasonText && <blockquote className="audit__quote">“{event.reasonText}”</blockquote>}

              {event.modelSnapshot?.recommendedESI != null && (
                <div className="audit__model">
                  Assistant had recommended ESI {event.modelSnapshot.recommendedESI}
                  {event.modelSnapshot.modelId && ` via ${event.modelSnapshot.modelId} v${event.modelSnapshot.modelVersion}`}
                </div>
              )}

              <div className="audit__compliance">
                {event.lawfulBasis} · {event.purpose} · retain until{' '}
                {event.retainUntil ? String(event.retainUntil).slice(0, 10) : '—'}
              </div>

              <div className="audit__hash" title={`prev ${event.prevHash}`}>
                {event.hash?.slice(0, 20)}…
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
