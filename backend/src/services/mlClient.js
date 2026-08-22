import { config } from '../config/index.js';
import { valueOf } from '../clinical/observation.js';
import { thresholdsWith } from '../clinical/protocol.js';

/**
 * Client for the ML service.
 *
 * The contract with the rest of the system is that this module never throws and
 * never blocks indefinitely. A triage assistant that hangs because a Python
 * process is slow is worse than one that scores on rules alone, so every call is
 * bounded by a timeout and every failure returns `null` with a stated reason.
 * Fusion treats a null model as "no constraint", not as a vote for low acuity.
 */

const REQUEST_TIMEOUT_MS = config.ml.timeoutMs;

async function post(path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.ml.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: `ML service returned ${response.status}` };
    }
    return { ok: true, data: await response.json() };
  } catch (error) {
    const reason =
      error.name === 'AbortError'
        ? `ML service did not respond within ${timeoutMs}ms`
        : `ML service unreachable: ${error.message}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flatten an encounter into the snapshot the ML service expects.
 *
 * Absent vitals are omitted rather than sent as null, so they arrive as genuine
 * NaN in the feature vector. The site's own thresholds travel with the request so
 * the model normalises against the same numbers the rule engine used for this
 * patient rather than against a table baked in at training time.
 */
export function buildScoringSnapshot({ encounter, patient = {}, vitals = {}, protocol }) {
  const band = encounter?.age?.band ?? 'adult';
  const medications = patient.medications ?? [];

  const numeric = (observation) => {
    const value = valueOf(observation);
    return Number.isFinite(value) ? value : undefined;
  };

  const vitalsPayload = {
    heart_rate: numeric(vitals.heartRate),
    respiratory_rate: numeric(vitals.respiratoryRate),
    systolic_bp: numeric(vitals.systolicBP),
    diastolic_bp: numeric(vitals.diastolicBP),
    spo2: numeric(vitals.spo2),
    temperature_c: numeric(vitals.temperatureC),
    gcs: numeric(vitals.gcs),
    pain_score: numeric(vitals.painScore),
    capillary_refill_sec: numeric(vitals.capillaryRefillSec),
    blood_glucose: numeric(vitals.bloodGlucose),
  };

  const baselines = {
    systolic_bp: patient.baselines?.systolicBP,
    spo2: patient.baselines?.spo2,
    heart_rate: patient.baselines?.heartRate,
  };

  const cues = vitals.observedCues ?? {};

  return {
    age_years: encounter?.age?.ageYears,
    age_band: band,
    // Omit rather than null: absence must survive the wire as absence.
    vitals: Object.fromEntries(Object.entries(vitalsPayload).filter(([, v]) => v !== undefined)),
    baselines: Object.fromEntries(Object.entries(baselines).filter(([, v]) => v !== undefined)),
    cues: {
      diaphoresis: Boolean(cues.diaphoresis),
      guarding: Boolean(cues.guarding),
      accessory_muscle_use: Boolean(cues.accessoryMuscleUse),
      unable_to_speak_full_sentences: Boolean(cues.unableToSpeakFullSentences),
      pallor: Boolean(cues.pallor),
      cyanosis: Boolean(cues.cyanosis),
      playful_and_consolable: Boolean(cues.playfulAndConsolable),
      lethargic: Boolean(cues.lethargic),
    },
    symptoms: encounter?.intake?.extraction?.symptoms ?? [],
    conditions: patient.chronicConditions ?? [],
    medications: {
      anticoagulant: medications.some((m) => m.isAnticoagulant),
      beta_blocker: medications.some((m) => m.isBetaBlocker),
      immunosuppressant: medications.some((m) => m.isImmunosuppressant),
    },
    has_prior_record: Boolean(patient.hasPriorRecord),
    via_proxy: Boolean(encounter?.intake?.viaProxy),
    thresholds: thresholdsWith(protocol, band, encounter?.age?.ageYears),
    escalationTau: protocol?.confidence?.escalationTau,
  };
}

/**
 * Score one encounter.
 * @returns {{ ok: true, data: object } | { ok: false, reason: string }}
 */
export async function scoreEncounter(snapshot) {
  return post('/score', snapshot);
}

/** Extract symptoms from one utterance. */
export async function extractSymptoms({ text, language, asrConfidence }) {
  return post('/nlp/extract', { text, language, asrConfidence });
}

/** Model provenance and published safety metrics. */
export async function fetchModelInfo(timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.ml.baseUrl}/model/info`, { signal: controller.signal });
    if (!response.ok) return { ok: false, reason: `ML service returned ${response.status}` };
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, reason: `ML service unreachable: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}
