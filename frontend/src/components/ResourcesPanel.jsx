import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import './ResourcesPanel.css';

const POLL_MS = 10000;

const STATUS_COPY = {
  short: { label: 'Short', tone: 'critical' },
  tight: { label: 'Tight', tone: 'warning' },
  ok: { label: 'OK', tone: 'good' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const STATUS_RANK = { short: 0, tight: 1, unknown: 2, ok: 3 };

const KIND_LABEL = {
  staffing: 'Staffing',
  beds: 'Beds',
  diversion: 'Diversion',
  specialist: 'Specialist',
  supply: 'Supply',
};

/**
 * Operations intelligence: what the waiting room is about to need, and whether
 * the department has it.
 *
 * Everything shown here is derived from the queue, never fed back into it — a
 * shortage never changes anyone's score. The copy says so on screen, because a
 * nurse seeing "resus beds: short" beside a queue needs to know the queue did not
 * quietly reorder itself around the bed count.
 */
export function ResourcesPanel({ onSummary }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.resourceOverview();
      setOverview(data);
      setError(null);
      onSummary?.({ shortCount: data.shortages.filter((row) => row.status === 'short').length });
    } catch (err) {
      setError(err.message);
    }
  }, [onSummary]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (resourceId, action) => {
    setPending(resourceId);
    try {
      if (action === 'restock') await api.restock(resourceId);
      else await api.adjustStock(resourceId, action);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(null);
    }
  };

  if (!overview) {
    return <div className="resources resources--empty">{error ? `Could not load resources: ${error}` : 'Loading resources…'}</div>;
  }

  const { basis, recommendations, shortages, inventory, forecast } = overview;
  const demandById = Object.fromEntries(forecast.map((row) => [row.resourceId, row]));
  const statusById = Object.fromEntries(shortages.map((row) => [row.resourceId, row.status]));
  // Specialist pages are many and small; one grouped card keeps them from
  // burying the staffing, bed and supply calls that need a decision.
  const specialists = recommendations.filter((rec) => rec.kind === 'specialist');
  const operational = recommendations.filter((rec) => rec.kind !== 'specialist');
  const flagged = shortages
    .filter((row) => row.status === 'short' || row.status === 'tight')
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.gap ?? 0) - (a.gap ?? 0));

  return (
    <div className="resources">
      <p className="resources__basis">
        Forecast from <strong>{basis.waitingPatients}</strong> waiting patient{basis.waitingPatients === 1 ? '' : 's'} ·{' '}
        {basis.nursesOnDuty} nurse{basis.nursesOnDuty === 1 ? '' : 's'} on duty
        {basis.surgeConditions && <span className="resources__surge">surge conditions</span>}
        <span className="resources__note">Advisory only — resources never change a patient's score.</span>
      </p>
      {error && <p className="resources__error">{error}</p>}

      <div className="resources__grid">
        <section className="resources__card">
          <h3>Recommendations</h3>
          {recommendations.length === 0 ? (
            <p className="resources__quiet">Nothing needs attention right now.</p>
          ) : (
            <ul className="resources__recs">
              {operational.map((rec) => (
                <li key={`${rec.kind}-${rec.title}`} className={`rec rec--${rec.severity}`}>
                  <span className="rec__kind">{KIND_LABEL[rec.kind] ?? rec.kind}</span>
                  <div>
                    <div className="rec__title">{rec.title}</div>
                    <div className="rec__detail">{rec.detail}</div>
                  </div>
                </li>
              ))}
              {specialists.length > 0 && (
                <li className="rec rec--warning">
                  <span className="rec__kind">{KIND_LABEL.specialist}</span>
                  <div>
                    <div className="rec__title">Alert specialist teams</div>
                    <ul className="rec__list">
                      {specialists.map((rec) => (
                        <li key={rec.title}>
                          <strong>{rec.title.replace(/^Alert /, '')}</strong> — {rec.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              )}
            </ul>
          )}
        </section>

        <section className="resources__card">
          <h3>Shortages</h3>
          {flagged.length === 0 ? (
            <p className="resources__quiet">Stock covers the expected demand of everyone waiting.</p>
          ) : (
            <table className="resources__table">
              <thead>
                <tr>
                  <th scope="col">Resource</th>
                  <th scope="col">Available</th>
                  <th scope="col">Expected need</th>
                  <th scope="col">Gap</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {flagged.map((row) => (
                  <tr key={row.resourceId}>
                    <td>{row.label}</td>
                    <td className="tabular">{row.available}</td>
                    <td className="tabular">{row.expectedDemand}</td>
                    <td className="tabular">{row.gap > 0 ? `${row.gap} ${row.unit}` : '—'}</td>
                    <td>
                      <StatusChip status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="resources__card">
        <h3>Inventory &amp; predicted usage</h3>
        <table className="resources__table resources__table--inventory">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">In stock</th>
              <th scope="col">Predicted need</th>
              <th scope="col">Likely patients</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {inventory.map((item) => {
              const demand = demandById[item.resourceId];
              const likely = demand?.likelyPatients ?? [];
              return (
                <tr key={item.resourceId}>
                  <td>
                    <div className="inv__label">{item.label}</div>
                    <div className="inv__meta">
                      {item.category.charAt(0).toUpperCase() + item.category.slice(1)}
                      {item.adjustable ? ` · par ${item.parLevel}` : ' · from bed system'}
                    </div>
                  </td>
                  <td className="tabular">
                    {item.available == null ? '—' : item.available}
                    {item.capacity != null && <span className="inv__of"> / {item.capacity}</span>}
                  </td>
                  <td className="tabular">{demand?.expectedDemand ?? 0}</td>
                  <td className="inv__patients">
                    {likely.length === 0 ? '—' : `${likely.slice(0, 3).join(', ')}${likely.length > 3 ? ` +${likely.length - 3}` : ''}`}
                  </td>
                  <td>
                    <StatusChip status={statusById[item.resourceId]} />
                  </td>
                  <td className="inv__actions">
                    {item.adjustable && (
                      <>
                        <button
                          type="button"
                          onClick={() => act(item.resourceId, -1)}
                          disabled={pending === item.resourceId || item.available === 0}
                          aria-label={`Use one ${item.label}`}
                        >
                          −1
                        </button>
                        <button
                          type="button"
                          onClick={() => act(item.resourceId, 1)}
                          disabled={pending === item.resourceId}
                          aria-label={`Add one ${item.label}`}
                        >
                          +1
                        </button>
                        <button
                          type="button"
                          className="inv__restock"
                          onClick={() => act(item.resourceId, 'restock')}
                          disabled={pending === item.resourceId || item.available >= item.parLevel}
                        >
                          Restock
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="resources__source">
          Predicted need is the sum of each waiting patient's likelihood of using the item, from their ESI, fired
          rules and reported symptoms. Beds are read from the bed management system.
        </p>
      </section>
    </div>
  );
}

function StatusChip({ status }) {
  const copy = STATUS_COPY[status] ?? STATUS_COPY.unknown;
  return <span className={`res-chip res-chip--${copy.tone}`}>{copy.label}</span>;
}
