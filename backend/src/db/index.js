import mongoose from 'mongoose';
import { config } from '../config/index.js';
import * as models from '../models/index.js';
import { MemoryRepository, MongoRepository } from './repository.js';

const MODEL_KEYS = [
  'Patient',
  'Encounter',
  'VitalsObservation',
  'TriageAssessment',
  'AuditEvent',
  'Clinician',
  'ConsentRecord',
  'ModelRegistry',
  'SurgeEvent',
  'SiteProtocol',
];

/**
 * Repository registry, keyed by model name with a lowerCamelCase alias so call
 * sites read as `repositories.encounters.find(...)`.
 */
export const repositories = {};

let connected = false;
let activeDriver = null;

const alias = {
  Patient: 'patients',
  Encounter: 'encounters',
  VitalsObservation: 'vitals',
  TriageAssessment: 'assessments',
  AuditEvent: 'auditEvents',
  Clinician: 'clinicians',
  ConsentRecord: 'consents',
  ModelRegistry: 'modelRegistry',
  SurgeEvent: 'surgeEvents',
  SiteProtocol: 'siteProtocols',
};

function buildRepositories(Repo) {
  for (const key of MODEL_KEYS) {
    const Model = models[key];
    if (!Model) throw new Error(`Model ${key} is not exported from src/models/index.js`);
    const repo = new Repo(Model);
    repositories[key] = repo;
    repositories[alias[key]] = repo;
  }
}

/**
 * Bring the persistence layer up.
 *
 * `memory` never touches the network, so it is the default for tests, CI, and
 * offline demos. `mongo` requires MONGO_URI to point at a reachable server and
 * fails loudly rather than silently degrading — a triage system that quietly
 * stopped persisting would be worse than one that refused to start.
 */
export async function connectDatabase() {
  if (connected) return { driver: activeDriver };

  if (config.db.driver === 'memory') {
    buildRepositories(MemoryRepository);
    activeDriver = 'memory';
    connected = true;
    return { driver: 'memory' };
  }

  if (config.db.driver !== 'mongo') {
    throw new Error(`Unknown DB_DRIVER "${config.db.driver}". Expected "mongo" or "memory".`);
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(config.db.uri, {
    serverSelectionTimeoutMS: 8000,
  });

  buildRepositories(MongoRepository);
  activeDriver = 'mongo';
  connected = true;

  // Indexes matter here: the queue is sorted on every tick, and the audit chain
  // relies on a unique index over `seq` to reject a duplicated sequence number.
  await Promise.all(MODEL_KEYS.map((key) => models[key].createIndexes()));

  return { driver: 'mongo', uri: config.db.uri.replace(/\/\/[^@]*@/, '//***@') };
}

export async function disconnectDatabase() {
  if (activeDriver === 'mongo') await mongoose.disconnect();
  connected = false;
  activeDriver = null;
  for (const key of Object.keys(repositories)) delete repositories[key];
}

/** Wipe every collection. Used by the seeder and by tests, never by a route. */
export async function resetDatabase() {
  for (const key of MODEL_KEYS) {
    await repositories[key].deleteMany({});
  }
}

export const getDriver = () => activeDriver;

export const isConnected = () => connected;
