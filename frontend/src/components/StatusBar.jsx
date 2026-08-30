import { formatWait } from './clinical.jsx';
import './StatusBar.css';

/**
 * Department-level state: the surge banner, the stat row, and the transport
 * indicator.
 *
 * These are stat tiles rather than charts on purpose. Each number answers a
 * single question a charge nurse asks between patients — how many are waiting,
 * how far behind are we, is the department surging — and a hero number answers
 * that faster than any plot of it would.
 *
 * The tiles carry status colour only when the number is actionable. A zero in
 * "safe wait exceeded" is good news and gets no colour at all: if every tile is
 * always tinted, the tint stops meaning anything, and the one tile that has gone
 * critical no longer stands out from the five that are merely reporting.
 */

const TRANSPORT_COPY = {
  websocket: { label: 'Live', detail: 'Updates pushed instantly', status: 'good' },
  polling: { label: 'Polling', detail: 'Websocket unavailable — refreshing every 5s', status: 'warning' },
  connecting: { label: 'Connecting', detail: 'Establishing live connection', status: 'neutral' },
};

export function StatusBar({ encounters, surge, transport, capacityDebtMinutes, lastUpdateAt, beds, bedsUnreachable }) {
  const waiting = encounters.length;
  const breached = encounters.filter((e) => e.queue?.decayStatus === 'red').length;
  const approaching = encounters.filter((e) => e.queue?.decayStatus === 'amber').length;
  const highAcuity = encounters.filter((e) => (e.currentESI ?? 5) <= 2).length;
  const lowConfidence = encounters.filter((e) => e.currentConfidence?.band === 'low').length;

  const conn = TRANSPORT_COPY[transport] ?? TRANSPORT_COPY.connecting;

  // Read-only context from the hospital's own bed-management system — never a
  // scoring input, so its own unreachability is reported as "unknown", not as
  // anything that touches the assistant's confidence in a triage decision.
  const bedTotals = beds?.departments?.reduce(
    (acc, dept) => ({ available: acc.available + dept.available, capacity: acc.capacity + dept.capacity }),
    { available: 0, capacity: 0 },
  );

  return (
    <div className="statusbar">
      {surge.active && (
        <div className="surge" role="status">
          <span className="surge__tag">Surge</span>
          <div className="surge__body">
            <p className="surge__lead">
              <strong>Department is surging.</strong>{' '}
              {surge.metrics && (
                <span className="surge__metrics">
                  {surge.metrics.arrivalsPerHour}/hr against a baseline of{' '}
                  {surge.metrics.baselineArrivalsPerHour} ({surge.metrics.multiple}×) ·{' '}
                  {surge.metrics.queuePerNurse} waiting per nurse
                </span>
              )}
            </p>
            <ul className="surge__policy">
              <li>Escalating on less uncertainty</li>
              <li>ESI 3 split into 3A / 3B</li>
              <li>Low-acuity re-checked more often</li>
              <li className="surge__policy-hold">Safe waiting times unchanged</li>
            </ul>
          </div>
        </div>
      )}

      <div className="stats">
        <Stat label="Waiting" value={waiting} hint="Currently on the board" />
        {/*
          The bento grid's one adaptive cell: this tile grows and takes the glow
          only once there is something in it to be urgent about. A dashboard that
          is always dramatic stops reading as dramatic — the emphasis has to be
          earned by the number, not applied by the layout.
        */}
        <Stat
          label="Safe wait exceeded"
          value={breached}
          status={breached > 0 ? 'critical' : 'neutral'}
          hero={breached > 0}
          hint={breached > 0 ? 'Needs attention now' : 'All within limits'}
        />
        <Stat
          label="Approaching limit"
          value={approaching}
          status={approaching > 0 ? 'warning' : 'neutral'}
          hint={approaching > 0 ? 'Past 60% of safe wait' : 'None near a limit'}
        />
        <Stat
          label="High acuity"
          value={highAcuity}
          status={highAcuity > 0 ? 'serious' : 'neutral'}
          hint="ESI 1–2"
        />
        <Stat
          label="Low confidence"
          value={lowConfidence}
          status={lowConfidence > 0 ? 'warning' : 'neutral'}
          hint="Assistant unsure — already escalated"
        />
        <Stat
          label="Capacity debt"
          value={formatWait(capacityDebtMinutes)}
          status={capacityDebtMinutes > 0 ? 'warning' : 'neutral'}
          hint="Minutes owed past safe waits"
        />
      </div>

      <div className="stats stats--context">
        <div className={`stat stat--conn stat--${conn.status}`}>
          <div className="stat__label">Connection</div>
          <div className="stat__value stat__value--sm">
            <span className={`stat__pulse stat__pulse--${conn.status}`} aria-hidden="true" />
            {conn.label}
          </div>
          <div className="stat__hint">
            {conn.detail}
            {lastUpdateAt && ` · ${new Date(lastUpdateAt).toLocaleTimeString()}`}
          </div>
        </div>

        {/*
          Read-only situational awareness from the hospital's own bed-
          management system (backend/src/integrations/) — never a scoring
          input, so its own unreachability degrades to "figure unknown"
          rather than to anything touching a triage decision.
        */}
        <div className="stat stat--conn">
          <div className="stat__label">Beds available</div>
          <div className="stat__value stat__value--sm">
            {bedsUnreachable ? '—' : bedTotals ? `${bedTotals.available}/${bedTotals.capacity}` : '…'}
          </div>
          <div className="stat__hint">
            {bedsUnreachable ? 'Bed system unreachable' : 'Across all departments'}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * `value` deliberately does not use tabular figures: at 30px, tabular gives every
 * digit the width of a zero and a number like 24 reads loose and misaligned with
 * its own label.
 */
function Stat({ label, value, status = 'neutral', hint, hero = false }) {
  return (
    <div className={`stat stat--${status} ${hero ? 'stat--hero' : ''}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}
