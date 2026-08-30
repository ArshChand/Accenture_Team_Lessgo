import dotenv from 'dotenv';

dotenv.config();

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const num = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * `DB_DRIVER` selects the persistence backend behind the repository layer.
 *
 *   mongo  — real MongoDB via Mongoose (Atlas or local mongod). Set MONGO_URI.
 *   memory — the same Mongoose schemas, validated and cast identically, but stored
 *            in-process. Used for CI, offline demos, and sandboxes where no mongod
 *            binary is reachable. Data does not survive a restart.
 *
 * Both drivers share one set of Mongoose schemas, so the schema is the schema of
 * record regardless of where documents land.
 */
export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 4000),

  db: {
    driver: process.env.DB_DRIVER ?? 'memory',
    uri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/triagehandler',
  },

  ml: {
    baseUrl: process.env.ML_SERVICE_URL ?? 'http://127.0.0.1:8000',
    timeoutMs: int(process.env.ML_TIMEOUT_MS, 4000),
  },

  /**
   * Queue engine cadence. The tick recomputes wait decay for every waiting
   * encounter and emits diffs; it does not re-score unless a trigger fires.
   */
  engine: {
    tickMs: int(process.env.ENGINE_TICK_MS, 5000),
    enabled: process.env.ENGINE_ENABLED !== 'false',
  },

  /**
   * Surge detection. Baseline arrival rate is a rolling average; surge is declared
   * when arrivals exceed `surgeMultiplier` times baseline, or when the waiting queue
   * per available nurse crosses `queuePerNurseThreshold`.
   */
  surge: {
    baselineArrivalsPerHour: num(process.env.BASELINE_ARRIVALS_PER_HOUR, 8),
    surgeMultiplier: num(process.env.SURGE_MULTIPLIER, 2),
    queuePerNurseThreshold: num(process.env.QUEUE_PER_NURSE_THRESHOLD, 6),
    exitHysteresisMs: int(process.env.SURGE_EXIT_HYSTERESIS_MS, 5 * 60 * 1000),
  },

  /**
   * Demo-only time control (see routes/simulation.js). Enabled by default in
   * development so the queue-decay demo is watchable; a production deployment
   * sets ALLOW_SIMULATION=false or runs with NODE_ENV=production.
   */
  simulation: {
    enabled: process.env.ALLOW_SIMULATION
      ? process.env.ALLOW_SIMULATION === 'true'
      : (process.env.NODE_ENV ?? 'development') !== 'production',
  },

  /**
   * Assumed regulatory jurisdiction. Drives audit event required fields, consent
   * artifact shape, and retention classes. See docs/compliance.md.
   */
  compliance: {
    jurisdiction: process.env.JURISDICTION ?? 'IN_DPDP_2023_ABDM',
    auditRetentionYears: int(process.env.AUDIT_RETENTION_YEARS, 7),
  },
};
