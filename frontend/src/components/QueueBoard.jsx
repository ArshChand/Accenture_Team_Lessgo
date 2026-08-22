import { ConfidenceChip, DecayIndicator, EsiBadge, formatAge, formatWait, minutesSince } from './clinical.jsx';
import './QueueBoard.css';

/**
 * The queue board — what a triage nurse looks at between patients.
 *
 * Ordering comes from the backend's priority score, not from anything computed
 * here, so the board and the engine can never disagree about who is next. Under
 * surge the board collapses to a top-N action list: at 3x volume a nurse cannot
 * read forty rows, and showing her forty is the same as showing her none.
 */
export function QueueBoard({ encounters, selectedId, onSelect, surgeActive, actionListSize = 8 }) {
  const visible = surgeActive ? encounters.slice(0, actionListSize) : encounters;
  const hidden = encounters.length - visible.length;

  if (!encounters.length) {
    return (
      <div className="board board--empty">
        <p>No patients waiting.</p>
        <p className="board__hint">Arrivals appear here automatically as they are triaged.</p>
      </div>
    );
  }

  return (
    <div className="board">
      {surgeActive && (
        <p className="board__mode">
          Surge mode — showing the {visible.length} highest-priority patients.
          {hidden > 0 && ` ${hidden} others are still monitored and still decaying.`}
        </p>
      )}

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
                    {formatAge(encounter.age?.ageYears)} ·{' '}
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
                <td className="tabular">{formatWait(waited)}</td>
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
  );
}
