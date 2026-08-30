import cors from 'cors';
import express from 'express';
import { config } from './config/index.js';
import { getDriver, isConnected, repositories } from './db/index.js';
import { PROTOCOL_GUARDRAILS, validateProtocol } from './clinical/protocol.js';
import {
  getActiveProtocol,
  getActiveSiteId,
  listBundledProtocols,
  loadBundledProtocol,
} from './services/protocolService.js';
import { triageRoutes } from './routes/triage.js';
import { queueRoutes } from './routes/queue.js';
import { simulationRoutes } from './routes/simulation.js';
import { integrationsRoutes } from './routes/integrations.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  /**
   * The clinical protocol in force, exposed so a nurse or auditor can see exactly
   * which thresholds produced a score. A safety table that cannot be inspected at
   * run time is not really reviewable.
   */
  app.get('/api/protocol', (req, res) => {
    const protocol = getActiveProtocol();
    res.json({
      siteId: getActiveSiteId(),
      siteName: protocol.siteName,
      siteType: protocol.siteType,
      version: protocol.version,
      description: protocol.description,
      protocol,
      guardrails: PROTOCOL_GUARDRAILS,
      availableSites: listBundledProtocols(),
    });
  });

  /**
   * Dry-run a protocol change. A hospital can see what its overrides would be
   * rejected for before anything is activated, rather than discovering a bad
   * threshold at the bedside.
   */
  app.post('/api/protocol/validate', (req, res) => {
    const overrides = req.body?.overrides ?? {};
    const { valid, errors } = validateProtocol({ ...getActiveProtocol(), ...overrides });
    res.status(valid ? 200 : 422).json({ valid, errors });
  });

  app.get('/api/protocol/:siteId', (req, res) => {
    const { siteId } = req.params;
    if (!listBundledProtocols().includes(siteId)) {
      return res.status(404).json({ error: 'unknown_site', siteId });
    }
    return res.json(loadBundledProtocol(siteId));
  });

  app.get('/api/health', async (req, res) => {
    const payload = {
      service: 'triagehandler-backend',
      status: isConnected() ? 'ok' : 'degraded',
      driver: getDriver(),
      jurisdiction: config.compliance.jurisdiction,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    if (isConnected()) {
      payload.counts = {
        patients: await repositories.patients.count(),
        encounters: await repositories.encounters.count(),
        assessments: await repositories.assessments.count(),
        auditEvents: await repositories.auditEvents.count(),
      };
    }

    res.status(isConnected() ? 200 : 503).json(payload);
  });

  app.use('/api', triageRoutes());
  app.use('/api', queueRoutes());
  app.use('/api', simulationRoutes({ enabled: config.simulation.enabled }));
  app.use('/api', integrationsRoutes());

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Errors are logged server-side and summarised to the client. A triage UI should
  // never render a stack trace to a nurse mid-shift.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? (err.name === 'ValidationError' ? 400 : 500);
    console.error(`[${req.method} ${req.path}]`, err);
    return res.status(status).json({
      error: err.name === 'ValidationError' ? 'validation_error' : 'internal_error',
      message: err.message,
    });
  });

  return app;
}

export default createApp;
