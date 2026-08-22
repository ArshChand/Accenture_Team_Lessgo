import { SOURCE, SOURCE_RELIABILITY } from './constants.js';

/**
 * Constructors for provenance-carrying clinical values.
 *
 * Reliability is a required schema field rather than a defaulted one, and it is
 * filled here rather than by Mongoose middleware. That is deliberate: `validateSync`
 * does not run middleware, so a hook would have applied under the MongoDB driver
 * and silently not applied in memory — the two drivers would have disagreed about
 * how much a value could be trusted. Making it explicit means the rule cannot
 * drift between environments, and forgetting it is a validation error rather than
 * a quiet assumption of average trustworthiness.
 */

/**
 * @param {*} value        the measurement itself
 * @param {string} source  one of SOURCE
 * @param {object} [opts]  { unit, observedAt, note, reliability }
 */
export function observation(value, source, opts = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Object.values(SOURCE).includes(source)) {
    throw new Error(`Unknown observation source "${source}"`);
  }

  return {
    value,
    source,
    unit: opts.unit,
    observedAt: opts.observedAt ?? new Date(),
    reliability: opts.reliability ?? SOURCE_RELIABILITY[source],
    note: opts.note,
  };
}

/**
 * A value the NLP layer inferred from speech. Reliability is the product of how
 * well we heard the patient and how confidently we mapped what they said, so a
 * confident extraction from a poor Kannada transcription is still treated as weak
 * evidence — which is the behaviour that makes the low-confidence demo case
 * escalate rather than sail through.
 */
export function nlpObservation(value, { asrConfidence = 0.9, extractionConfidence = 0.9, ...opts } = {}) {
  return observation(value, SOURCE.NLP_INFERRED, {
    ...opts,
    reliability: Number((asrConfidence * extractionConfidence).toFixed(3)),
    note: opts.note ?? `asr=${asrConfidence.toFixed(2)} extraction=${extractionConfidence.toFixed(2)}`,
  });
}

/** Convenience wrappers, so call sites read clinically rather than structurally. */
export const measured = (value, opts) => observation(value, SOURCE.MEASURED, opts);
export const observed = (value, opts) => observation(value, SOURCE.CLINICIAN_OBSERVED, opts);
export const selfReported = (value, opts) => observation(value, SOURCE.PATIENT_REPORTED, opts);
export const proxyReported = (value, opts) => observation(value, SOURCE.PROXY_REPORTED, opts);
export const fromPriorRecord = (value, opts) => observation(value, SOURCE.PRIOR_RECORD, opts);

/** Unwrap an observation for arithmetic; returns undefined when it is absent. */
export const valueOf = (obs) => (obs === undefined || obs === null ? undefined : obs.value);

/** Reliability of an observation, or 0 when the value was never recorded at all. */
export const reliabilityOf = (obs) => (obs === undefined || obs === null ? 0 : (obs.reliability ?? 0));
