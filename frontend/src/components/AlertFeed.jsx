import './AlertFeed.css';

/**
 * Pushed alerts.
 *
 * These arrive over the websocket the instant the engine detects them, which is
 * the point: a patient whose safe wait has just been exceeded should reach the
 * nurse's attention without her going looking for it. Dismissal is per-alert and
 * local — it clears the notification, never the underlying breach, which stays
 * on the board and in the audit log until someone acts on the patient.
 */

const ALERT_COPY = {
  wait_breach: { glyph: '▲', status: 'critical', title: 'Safe wait exceeded' },
  deterioration: { glyph: '▲', status: 'critical', title: 'Re-triaged more urgent' },
};

export function AlertFeed({ alerts, onSelect, onDismiss }) {
  if (!alerts.length) {
    return (
      <div className="alerts alerts--empty">
        <h3>Alerts</h3>
        <p>Nothing outstanding.</p>
      </div>
    );
  }

  return (
    <div className="alerts">
      <h3>
        Alerts <span className="alerts__count tabular">{alerts.length}</span>
      </h3>
      <ul>
        {alerts.map((alert, index) => {
          const copy = ALERT_COPY[alert.kind] ?? { glyph: '●', status: 'neutral', title: alert.kind };
          return (
            <li key={`${alert.encounterId}-${alert.kind}-${index}`} className={`alert alert--${copy.status}`}>
              <span className="alert__glyph" aria-hidden="true">
                {copy.glyph}
              </span>
              <button type="button" className="alert__body" onClick={() => onSelect(alert.encounterId)}>
                <span className="alert__title">{copy.title}</span>
                <span className="alert__detail">
                  <strong>{alert.displayRef}</strong>
                  {alert.kind === 'wait_breach' && (
                    <>
                      {' '}
                      · ESI {alert.esi} · waited {alert.minutesWaiting}m against a {alert.safeWaitMinutes}m
                      limit
                    </>
                  )}
                  {alert.kind === 'deterioration' && (
                    <>
                      {' '}
                      · ESI {alert.fromESI} <span className="alert__chevron">&gt;</span> {alert.toESI} after{' '}
                      {alert.minutesWaiting}m
                    </>
                  )}
                </span>
                {alert.auditSeq && <span className="alert__audit">audit #{alert.auditSeq}</span>}
              </button>
              <button
                type="button"
                className="alert__dismiss"
                onClick={() => onDismiss(index)}
                aria-label="Dismiss notification"
                title="Dismiss the notification — the patient stays on the board"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
