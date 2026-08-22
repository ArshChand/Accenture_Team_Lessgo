import cors from 'cors';
import express from 'express';
import { config } from './config/index.js';
import { getDriver, isConnected, repositories } from './db/index.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

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
