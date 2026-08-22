import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { useQueue } from './hooks/useQueue.js';
import { QueueBoard } from './components/QueueBoard.jsx';
import { PatientDetail } from './components/PatientDetail.jsx';
import { OverrideModal } from './components/OverrideModal.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { AlertFeed } from './components/AlertFeed.jsx';
import { AuditViewer } from './components/AuditViewer.jsx';
import { IntakeKiosk } from './components/IntakeKiosk.jsx';
import { VitalsPanel } from './components/VitalsPanel.jsx';
import './App.css';

const TABS = [
  { id: 'board', label: 'Triage board' },
  { id: 'intake', label: 'Patient intake' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'model', label: 'Model & protocol' },
];

export default function App() {
  const queue = useQueue();
  const [tab, setTab] = useState('board');
  const [selectedId, setSelectedId] = useState(null);
  const [clinicians, setClinicians] = useState([]);
  const [overrideTarget, setOverrideTarget] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [theme, setTheme] = useState('system');

  const bumpRefresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    api
      .clinicians()
      .then(({ clinicians: rows }) => setClinicians(rows))
      .catch(() => setClinicians([]));
  }, []);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Keep a selection alive as the queue reorders, but drop it if the patient
  // leaves the board entirely.
  useEffect(() => {
    if (!selectedId) return;
    if (!queue.encounters.some((e) => String(e._id) === selectedId)) setSelectedId(null);
  }, [queue.encounters, selectedId]);

  const openOverride = (encounter, assessment) => setOverrideTarget({ encounter, assessment });

  const submitOverride = async (payload) => {
    await api.override(String(overrideTarget.encounter._id), payload);
    await queue.refresh();
    bumpRefresh();
  };

  const selectFromAlert = (encounterId) => {
    setTab('board');
    setSelectedId(encounterId);
  };

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <h1>TriageHandler</h1>
          <span className="app__sub">Emergency Department · Team Lessgo</span>
        </div>

        <nav className="app__tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`app__tab ${tab === entry.id ? 'is-active' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="app__theme">
          <label className="visually-hidden" htmlFor="theme">
            Theme
          </label>
          <select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="system">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </header>

      <main className="app__main">
        {tab === 'board' && (
          <>
            <StatusBar
              encounters={queue.encounters}
              surge={queue.surge}
              transport={queue.transport}
              capacityDebtMinutes={queue.capacityDebtMinutes}
              lastUpdateAt={queue.lastUpdateAt}
            />

            <div className="app__board-layout">
              <div className="app__board-main">
                <QueueBoard
                  encounters={queue.encounters}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  surgeActive={queue.surge.active}
                />
                {selectedId && <VitalsPanel encounterId={selectedId} onSaved={() => { queue.refresh(); bumpRefresh(); }} />}
              </div>

              <div className="app__board-side">
                <AlertFeed alerts={queue.alerts} onSelect={selectFromAlert} onDismiss={queue.dismissAlert} />
                {selectedId ? (
                  <PatientDetail encounterId={selectedId} onOverride={openOverride} refreshToken={refreshToken} />
                ) : (
                  <div className="app__placeholder">Select a patient to see why the assistant scored them.</div>
                )}
              </div>
            </div>
          </>
        )}

        {tab === 'intake' && <IntakeKiosk onArrival={() => queue.refresh()} />}

        {tab === 'audit' && <AuditViewer refreshToken={refreshToken} />}

        {tab === 'model' && <ModelPanel />}
      </main>

      {overrideTarget && (
        <OverrideModal
          encounter={overrideTarget.encounter}
          assessment={overrideTarget.assessment}
          clinicians={clinicians}
          onClose={() => setOverrideTarget(null)}
          onSubmit={submitOverride}
        />
      )}
    </div>
  );
}

/**
 * Model provenance and the clinical protocol in force.
 *
 * Both are published in the interface rather than buried in a config file,
 * because the numbers a nurse is being asked to trust — the under-triage rate,
 * the thresholds that produced a score — should be inspectable by the person
 * relying on them.
 */
function ModelPanel() {
  const [model, setModel] = useState(null);
  const [protocol, setProtocol] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.modelInfo().then(setModel).catch((e) => setError(e.message));
    api.protocol().then(setProtocol).catch(() => {});
  }, []);

  return (
    <div className="model-panel">
      <section className="model-card">
        <h2>Clinical protocol in force</h2>
        {protocol ? (
          <>
            <p className="model-card__lead">
              <strong>{protocol.siteName}</strong> · v{protocol.version}
            </p>
            <p className="model-card__desc">{protocol.description}</p>
            <table className="model-table">
              <thead>
                <tr>
                  <th>ESI</th>
                  <th>Safe wait</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(protocol.protocol?.safeWaitMinutes ?? {}).map(([level, minutes]) => (
                  <tr key={level}>
                    <td className="tabular">{level}</td>
                    <td className="tabular">{minutes === 0 ? 'immediate' : `${minutes} min`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="model-card__note">
              These are never relaxed under surge. Guardrails prevent any site configuring them beyond
              safe ceilings.
            </p>
          </>
        ) : (
          <p className="model-card__desc">Loading…</p>
        )}
      </section>

      <section className="model-card">
        <h2>Risk model</h2>
        {error && <p className="model-card__error">Model service unavailable: {error}</p>}
        {model && (
          <>
            <p className="model-card__lead">
              <strong>{model.modelId}</strong> v{model.version} · trained on{' '}
              <span className="tabular">{model.trainingRowCount?.toLocaleString()}</span> synthetic encounters
            </p>

            <h3>Measured safety</h3>
            <table className="model-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Most-likely</th>
                  <th>With escalation rule</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Under-triage rate', 'underTriageRate'],
                  ['Critical under-triage', 'criticalUnderTriageRate'],
                  ['Over-triage rate', 'overTriageRate'],
                  ['Accuracy', 'accuracy'],
                ].map(([label, key]) => (
                  <tr key={key}>
                    <td>{label}</td>
                    <td className="tabular">{model.metricsArgmaxBaseline?.[key]?.toFixed(3)}</td>
                    <td className="tabular">
                      <strong>{model.metrics?.[key]?.toFixed(3)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="model-card__note">
              Under-triage, not accuracy, is the governing metric: the two errors do not cost the same.
              The escalation rule trades accuracy for a halved under-triage rate deliberately.
            </p>

            {model.limitations?.length > 0 && (
              <>
                <h3>Declared limitations</h3>
                <ul className="model-limits">
                  {model.limitations.map((limit) => (
                    <li key={limit}>{limit}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
