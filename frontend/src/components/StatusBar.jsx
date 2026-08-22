import { formatWait } from './clinical.jsx';
import './StatusBar.css';

/**
 * Department-level state: the stat row, the surge banner, and the transport
 * indicator.
 *
 * These are stat tiles rather than charts on purpose. Each number answers a
 * single question a charge nurse asks between patients — how many are waiting,
 * how far behind are we, is the department surging — and a hero number answers
 * that faster than any plot of it would.
 */

const TRANSPORT_COPY = {
  websocket: { label: 'Live', detail: 'Updates pushed instantly', status: 'good' },
  polling: { label: 'Polling', detail: 'Websocket unavailable — refreshing every 5s', status: 'warning' },
  connecting: { label: 'Connecting', detail: 'Establishing live connection', status: 'neutral' },
};

export function StatusBar({ encounters, surge, transport, capacityDebtMinutes, lastUpdateAt }) {
  const waiting = encounters.length;
  const breached = encounters.filter((e) => e.queue?.decayStatus === 'red').length;
  const approaching = encounters.filter((e) => e.queue?.decayStatus === 'amber').length;
  const highAcuity = encounters.filter((e) => (e.currentESI ?? 5) <= 2).length;
  const lowConfidence = encounters.filter((e) => e.currentConfidence?.band === 'low').length;

  const conn = TRANSPORT_COPY[transport] ?? TRANSPORT_COPY.connecting;

  return (
    <div className="statusbar">
      {surge.active && (
        <div className="surge" role="status">
          <span className="surge__tag">SURGE</span>
          <div className="surge__body">
            <strong>Department is surging.</strong>{' '}
            {surge.metrics && (
              <>
                {surge.metrics.arrivalsPerHour}/hr against a baseline of {surge.metrics.baselineArrivalsPerHour} (
                {surge.metrics.multiple}×), {surge.metrics.queuePerNurse} waiting per nurse.
              </>
            )}
            <div className="surge__policy">
              Escalating on less uncertainty · ESI 3 split into 3A/3B · low-acuity re-checked more often ·{' '}
              <strong>safe waiting times unchanged</strong>
            </div>
          </div>
        </div>
      )}

      <div className="stats">
        <Stat label="Waiting" value={waiting} />
        <Stat
          label="Safe wait exceeded"
          value={breached}
          status={breached > 0 ? 'critical' : 'good'}
          hint={breached > 0 ? 'Needs attention now' : 'All within limits'}
        />
        <Stat
          label="Approaching limit"
          value={approaching}
          status={approaching > 0 ? 'warning' : 'good'}
        />
        <Stat label="High acuity (ESI 1–2)" value={highAcuity} status={highAcuity > 0 ? 'serious' : 'good'} />
        <Stat
          label="Low confidence"
          value={lowConfidence}
          status={lowConfidence > 0 ? 'warning' : 'good'}
          hint="Assistant is unsure — already escalated"
        />
        <Stat
          label="Capacity debt"
          value={formatWait(capacityDebtMinutes)}
          status={capacityDebtMinutes > 0 ? 'warning' : 'good'}
          hint="Total minutes owed past safe waits"
        />

        <div className={`stat stat--conn stat--${conn.status}`}>
          <div className="stat__label">Connection</div>
          <div className="stat__value stat__value--sm">{conn.label}</div>
          <div className="stat__hint">
            {conn.detail}
            {lastUpdateAt && ` · ${new Date(lastUpdateAt).toLocaleTimeString()}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, status = 'neutral', hint }) {
  return (
    <div className={`stat stat--${status}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value tabular">{value}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}
