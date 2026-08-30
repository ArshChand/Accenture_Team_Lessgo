import './BoardTabs.css';

/**
 * The board's own secondary tab strip.
 *
 * "Queue" is the working view — the triage table and, when a patient is
 * selected, their detail panel. Everything that used to sit permanently
 * beside it (the full metrics grid, the alert list, bed/connection status)
 * now lives behind its own tab, so the working view stays about the one
 * thing a nurse is actually doing between patients: looking at the queue.
 *
 * Nothing here unmounts on switch — see App.jsx, which keeps all four
 * sub-views mounted and toggles visibility with the `hidden` attribute. A
 * search query typed into the queue's own filter, or a promotion form
 * half-filled in the detail panel, survives a trip to another tab and back.
 *
 * Badges are the one thing this strip is not allowed to be quiet about:
 * an alert or a breach still has to be visible from every tab, or moving
 * them off the main view would have quietly made them easier to miss.
 */
const BOARD_TABS = [
  { id: 'queue', label: 'Queue' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'capacity', label: 'Capacity' },
];

export function BoardTabs({ active, onChange, alertCount = 0, breachedCount = 0 }) {
  const badgeFor = (id) => {
    if (id === 'alerts' && alertCount > 0) return alertCount;
    if (id === 'metrics' && breachedCount > 0) return breachedCount;
    return null;
  };

  return (
    <nav className="board-tabs" aria-label="Dashboard sections">
      {BOARD_TABS.map((entry) => {
        const badge = badgeFor(entry.id);
        return (
          <button
            key={entry.id}
            type="button"
            className={`board-tabs__tab ${active === entry.id ? 'is-active' : ''}`}
            onClick={() => onChange(entry.id)}
            aria-current={active === entry.id ? 'true' : undefined}
          >
            {entry.label}
            {badge != null && <span className="board-tabs__badge">{badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}
