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
 * The list scrolls inside a fixed frame rather than growing the page. Two reasons:
 * the department stats and the alert feed must stay on screen when the queue is
 * longest, and a sticky header means row four hundred is still readable as data
 * rather than as six unlabelled columns.
 */
export function QueueBoard({ encounters, selectedId, onSelect, surgeActive, actionListSize = 8 }) {
  const visible = surgeActive ? encounters.slice(0, actionListSize) : encounters;
  const hidden = encounters.length - visible.length;

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
        {surgeActive && (
          <p className="board__mode">
            <span className="board__mode-tag">Surge</span>
            Highest-priority {visible.length} shown
            {hidden > 0 && ` · ${hidden} others still monitored and still decaying`}
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
                    <div className="board__ref">{encounter.displayRef}</div>
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
