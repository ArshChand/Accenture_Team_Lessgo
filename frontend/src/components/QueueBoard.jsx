import { useMemo, useState } from 'react';
import { ConfidenceChip, DecayIndicator, EsiBadge, formatAge, formatWait, minutesSince } from './clinical.jsx';
import './QueueBoard.css';

/**
 * The queue board — what a triage nurse looks at between patients.
 *
 * Ordering comes from the backend's priority score, not from anything computed
 * here, so the board and the engine can never disagree about who is next. Under
 * surge the board collapses to a top-N action list: at 3x volume a nurse cannot
 * read forty rows, and showing her forty is the same as showing her none.
 *
 * "Not shown" does not mean "not on the board" — every waiting patient is still
 * decaying and still re-triaged on the engine's own clock regardless of surge
 * collapse. The search below is the deliberate escape hatch: it always searches
 * every waiting patient, collapsed view or not, so a nurse who needs patient #15
 * specifically is never stuck scrolling a list that was deliberately shortened.
 *
 * The list scrolls inside a fixed frame rather than growing the page. Two reasons:
 * the department stats and the alert feed must stay on screen when the queue is
 * longest, and a sticky header means row four hundred is still readable as data
 * rather than as six unlabelled columns.
 */
export function QueueBoard({ encounters, selectedId, onSelect, surgeActive, actionListSize = 8 }) {
  const [query, setQuery] = useState('');
  const visible = surgeActive ? encounters.slice(0, actionListSize) : encounters;
  const hidden = encounters.length - visible.length;

  const trimmedQuery = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!trimmedQuery) return [];
    return encounters
      .filter(
        (e) =>
          e.displayRef?.toLowerCase().includes(trimmedQuery) ||
          e.chiefComplaint?.toLowerCase().includes(trimmedQuery),
      )
      .slice(0, 6);
  }, [encounters, trimmedQuery]);

  const selectFromSearch = (encounter) => {
    onSelect(String(encounter._id));
    setQuery('');
  };

  if (!encounters.length) {
    return (
      <div className="board board--empty">
        <p className="board__empty-title">No patients waiting</p>
        <p className="board__hint">Arrivals appear here automatically as they are triaged.</p>
      </div>
    );
  }

  return (
    <section className="board" aria-label="Triage queue">
      <header className="board__head">
        <h2 className="board__title">Triage queue</h2>
        <span className="board__count tabular">
          {visible.length}
          {hidden > 0 && <span className="board__count-of"> of {encounters.length}</span>}
        </span>

        <div className="board__search">
          <input
            type="search"
            className="board__search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a patient by ID or complaint…"
            aria-label="Find a patient, including those not currently shown"
          />
          {searchResults.length > 0 && (
            <ul className="board__search-results" role="listbox">
              {searchResults.map((encounter) => {
                const offScreen = !visible.some((v) => String(v._id) === String(encounter._id));
                return (
                  <li key={encounter._id}>
                    <button
                      type="button"
                      className="board__search-result"
                      onClick={() => selectFromSearch(encounter)}
                    >
                      <span className="board__search-result-head">
                        <EsiBadge esi={encounter.currentESI} />
                        <span className="board__search-ref">{encounter.displayRef}</span>
                        {offScreen && <span className="board__search-offscreen">not shown</span>}
                      </span>
                      <span className="board__search-complaint">{encounter.chiefComplaint}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {surgeActive && (
          <p className="board__mode">
            <span className="board__mode-tag">Surge</span>
            Highest-priority {visible.length} shown
            {hidden > 0 && ` · ${hidden} others still monitored and still decaying — search above to open one`}
          </p>
        )}
      </header>

      <div className="board__scroll scroll-area">
        <table className="board__table">
          <thead>
            <tr>
              <th scope="col">Patient</th>
              <th scope="col">Severity</th>
              <th scope="col">Waiting</th>
              <th scope="col">Safe wait</th>
              <th scope="col">Assistant confidence</th>
              <th scope="col">Assigned by</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((encounter) => {
              const waited = minutesSince(encounter.queue?.lastInformedAt ?? encounter.arrivalAt);
              const status = encounter.queue?.decayStatus ?? 'green';
              const isSelected = String(encounter._id) === selectedId;

              return (
                <tr
                  key={encounter._id}
                  className={`board__row board__row--${status} ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => onSelect(String(encounter._id))}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(String(encounter._id));
                    }
                  }}
                  aria-selected={isSelected}
                >
                  <td>
                    <div className="board__ref">
                      {encounter.displayRef}
                      {/* A hand-reordered queue has to declare itself, or the next
                          nurse on shift reads an order she cannot account for. */}
                      {encounter.queue?.manualPromotion && (
                        <span
                          className="board__promoted"
                          title={`Moved up by ${encounter.queue.manualPromotion.clinicianName}`}
                        >
                          Nurse-moved
                        </span>
                      )}
                    </div>
                    <div className="board__complaint">{encounter.chiefComplaint}</div>
                    <div className="board__age">
                      {formatAge(encounter.age?.ageYears)}
                      <span className="board__dot" aria-hidden="true" />
                      <span className="board__band">{encounter.age?.band?.replace(/_/g, ' ')}</span>
                    </div>
                  </td>
                  <td>
                    <EsiBadge esi={encounter.currentESI} subBand={encounter.queue?.surgeSubBand} />
                    {/* The assistant's current opinion, shown when it differs from the
                        standing score — never applied automatically if it is less
                        urgent, but always visible so a nurse can act on it. */}
                    {encounter.aiRecommendedESI != null &&
                      encounter.aiRecommendedESI !== encounter.currentESI && (
                        <div className="board__suggestion">
                          Assistant now suggests ESI {encounter.aiRecommendedESI}
                        </div>
                      )}
                  </td>
                  <td className="board__wait tabular">{formatWait(waited)}</td>
                  <td>
                    <DecayIndicator queue={encounter.queue} />
                  </td>
                  <td>
                    <ConfidenceChip confidence={encounter.currentConfidence} />
                  </td>
                  <td>
                    <span className={`board__by board__by--${encounter.assignedBy}`}>
                      {encounter.assignedBy === 'nurse' ? 'Nurse' : 'Assistant'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
