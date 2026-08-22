import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGE_BAND, AGE_BANDS, ESI_LEVELS } from './constants.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Site-configurable clinical protocol.
 *
 * Hospitals differ enormously in size, specialty mix and technical maturity, so
 * the thresholds a triage assistant reasons with cannot be baked into the code. A
 * paediatric specialty hospital, a rural community health centre and a tertiary
 * trauma centre need different vital-sign bands, different safe waiting times and
 * different rule sets — but they should all run the same assistant.
 *
 * Two properties make that safe rather than merely flexible:
 *
 *   1. Sites specify *deltas*. Everything unspecified inherits from the reference
 *      protocol, so a district hospital that only wants longer ESI-4 waits writes
 *      four lines, not four hundred. Restating a whole table is how transcription
 *      errors enter a safety system.
 *
 *   2. Guardrails are not configurable. Configurability is a way to adapt a
 *      protocol to local reality; it must not become a way to switch safety off.
 *      A site cannot let an ESI-2 patient wait an hour, cannot disable a hard red
 *      flag, and cannot invert a threshold ordering. `validateProtocol` rejects
 *      those outright rather than warning and continuing.
 */

const DEFAULT_PROTOCOL = Object.freeze(
  JSON.parse(readFileSync(join(here, 'protocols', 'default.json'), 'utf8')),
);

/** The reference protocol, as loaded from disk. Never mutated. */
export const getDefaultProtocol = () => structuredClone(DEFAULT_PROTOCOL);

/**
 * Absolute bounds. These are deliberately not part of the protocol document — a
 * site cannot raise its own ceiling.
 */
export const PROTOCOL_GUARDRAILS = Object.freeze({
  /** No site may let a patient at this level wait longer than this, in minutes. */
  maxSafeWaitMinutes: { 1: 0, 2: 15, 3: 60, 4: 120, 5: 240 },
  /** Uncertainty escalation may reach ESI 2, never ESI 1, and never worse than 3. */
  escalationFloorESI: { min: 2, max: 3 },
  /** Confidence band cut points must stay inside a sane range. */
  confidenceThresholds: { min: 0.3, max: 0.95 },
  /** Rules that exist to prevent death and cannot be switched off by configuration. */
  nonDisableableRules: Object.freeze([
    'UNRESPONSIVE',
    'APNOEA_OR_BRADYPNOEA',
    'SEVERE_HYPOXIA',
    'DECOMPENSATED_SHOCK',
    'ANAPHYLAXIS',
    'SEVERE_HYPOGLYCAEMIA',
    'INFANT_FEVER_UNDER_3_MONTHS',
    'NEONATE_PRESENTATION',
    'PAEDIATRIC_COMPENSATED_SHOCK',
    'STROKE_SYMPTOMS',
    'NO_VITALS_RECORDED',
  ]),
});

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep merge where `override` wins. Arrays replace rather than concatenate. */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : structuredClone(override);
  }
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : structuredClone(value);
  }
  return out;
}

/**
 * Build a usable protocol from a site's partial overrides.
 * @param {object} [overrides] partial protocol document, e.g. a SiteProtocol row
 * @returns {object} the fully resolved protocol
 */
export function resolveProtocol(overrides = {}) {
  return deepMerge(DEFAULT_PROTOCOL, overrides ?? {});
}

/**
 * Check a resolved protocol against structural sanity and the guardrails.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateProtocol(protocol) {
  const errors = [];

  // --- age bands must tile the whole range without gaps or overlaps ---
  const bands = protocol.ageBands ?? [];
  if (bands.length === 0) errors.push('ageBands must not be empty');
  bands.forEach((band, index) => {
    if (!AGE_BANDS.includes(band.band)) errors.push(`unknown age band "${band.band}"`);
    const max = band.maxYears ?? Infinity;
    if (max <= band.minYears) {
      errors.push(`age band "${band.band}" has maxYears <= minYears`);
    }
    if (index > 0) {
      const previousMax = bands[index - 1].maxYears ?? Infinity;
      if (Math.abs(previousMax - band.minYears) > 1e-9) {
        errors.push(
          `age bands must tile without gaps: "${bands[index - 1].band}" ends at ${previousMax} but "${band.band}" starts at ${band.minYears}`,
        );
      }
    }
  });
  if (bands.length > 0 && bands[bands.length - 1].maxYears !== null) {
    errors.push('the oldest age band must have maxYears: null so no patient falls outside every band');
  }

  // --- thresholds must be internally ordered ---
  for (const [band, vitals] of Object.entries(protocol.vitalThresholds ?? {})) {
    if (!AGE_BANDS.includes(band)) errors.push(`vitalThresholds contains unknown band "${band}"`);
    for (const [vital, bounds] of Object.entries(vitals)) {
      const ordered = ['criticalLow', 'low', 'high', 'criticalHigh']
        .filter((key) => Number.isFinite(bounds[key]))
        .map((key) => [key, bounds[key]]);
      for (let i = 1; i < ordered.length; i += 1) {
        if (ordered[i][1] < ordered[i - 1][1]) {
          errors.push(
            `${band}.${vital}: ${ordered[i][0]} (${ordered[i][1]}) must not be below ${ordered[i - 1][0]} (${ordered[i - 1][1]})`,
          );
        }
      }
      if (Number.isFinite(bounds.hypothermic) && Number.isFinite(bounds.fever) && bounds.hypothermic >= bounds.fever) {
        errors.push(`${band}.${vital}: hypothermic must be below fever`);
      }
      if (Number.isFinite(bounds.fever) && Number.isFinite(bounds.highFever) && bounds.fever >= bounds.highFever) {
        errors.push(`${band}.${vital}: fever must be below highFever`);
      }
    }
  }

  // --- guardrail: safe waits ---
  for (const level of ESI_LEVELS) {
    const configured = protocol.safeWaitMinutes?.[String(level)];
    if (!Number.isFinite(configured)) {
      errors.push(`safeWaitMinutes is missing a value for ESI ${level}`);
      continue;
    }
    const ceiling = PROTOCOL_GUARDRAILS.maxSafeWaitMinutes[level];
    if (configured > ceiling) {
      errors.push(
        `safeWaitMinutes for ESI ${level} is ${configured} but may not exceed ${ceiling} — a site cannot configure away a safe waiting time`,
      );
    }
    if (configured < 0) errors.push(`safeWaitMinutes for ESI ${level} must not be negative`);
  }

  // --- guardrail: escalation floor ---
  const floor = protocol.confidence?.escalationFloorESI;
  const { min, max } = PROTOCOL_GUARDRAILS.escalationFloorESI;
  if (!Number.isFinite(floor) || floor < min || floor > max) {
    errors.push(
      `confidence.escalationFloorESI must be between ${min} and ${max} — uncertainty must escalate, but never straight to resuscitation`,
    );
  }

  // --- guardrail: confidence weights and cut points ---
  const weights = protocol.confidence?.weights ?? {};
  const weightSum = Object.values(weights).reduce((sum, w) => sum + (Number(w) || 0), 0);
  if (Math.abs(weightSum - 1) > 0.001) {
    errors.push(`confidence.weights must sum to 1, got ${weightSum.toFixed(3)}`);
  }
  const { high, moderate } = protocol.confidence?.thresholds ?? {};
  if (!(moderate < high)) errors.push('confidence.thresholds.moderate must be below .high');
  for (const [name, value] of Object.entries({ high, moderate })) {
    if (
      !Number.isFinite(value) ||
      value < PROTOCOL_GUARDRAILS.confidenceThresholds.min ||
      value > PROTOCOL_GUARDRAILS.confidenceThresholds.max
    ) {
      errors.push(`confidence.thresholds.${name} is outside the permitted range`);
    }
  }

  // --- guardrail: rules that may not be disabled ---
  for (const override of protocol.ruleOverrides ?? []) {
    if (!override?.code) {
      errors.push('every ruleOverride needs a code');
      continue;
    }
    if (override.enabled === false && PROTOCOL_GUARDRAILS.nonDisableableRules.includes(override.code)) {
      errors.push(`rule "${override.code}" protects against a fatal miss and cannot be disabled by site configuration`);
    }
    if (override.impliedESI !== undefined && !ESI_LEVELS.includes(override.impliedESI)) {
      errors.push(`ruleOverride "${override.code}" has an out-of-range impliedESI`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Resolve and validate in one step, throwing on an unsafe configuration. */
export function loadProtocol(overrides = {}) {
  const protocol = resolveProtocol(overrides);
  const { valid, errors } = validateProtocol(protocol);
  if (!valid) {
    const error = new Error(
      `Site protocol "${protocol.siteId ?? 'unknown'}" is invalid:\n  - ${errors.join('\n  - ')}`,
    );
    error.name = 'ProtocolValidationError';
    error.errors = errors;
    throw error;
  }
  return protocol;
}

/** Resolve an age in years to a band using this protocol's own band table. */
export function resolveAgeBandWith(protocol, ageYears) {
  if (!Number.isFinite(ageYears) || ageYears < 0) return AGE_BAND.ADULT;
  const match = (protocol.ageBands ?? []).find(
    (band) => ageYears >= band.minYears && (band.maxYears === null || ageYears < band.maxYears),
  );
  return match ? match.band : AGE_BAND.ADULT;
}

/**
 * Paediatric hypotension floor from this protocol's formula, rather than a
 * hardcoded one. Sites running a different paediatric standard change the
 * coefficients instead of the code.
 */
export function paediatricSystolicFloorWith(protocol, ageYears) {
  const formula = protocol.paediatricSystolicFormula ?? {};
  if (!formula.enabled) return null;
  if (ageYears < formula.minAgeYears) return formula.belowMinAgeFloor;
  if (ageYears > formula.maxAgeYears) return formula.aboveMaxAgeFloor;
  return formula.intercept + formula.slopePerYear * ageYears;
}

/**
 * Thresholds for one patient: the band table for this site, with the paediatric
 * systolic formula substituted where it is more precise than a band constant.
 */
export function thresholdsWith(protocol, band, ageYears) {
  const table = protocol.vitalThresholds ?? {};
  const base = table[band] ?? table[AGE_BAND.ADULT];
  const formula = protocol.paediatricSystolicFormula ?? {};

  if (formula.enabled && (formula.appliesToBands ?? []).includes(band) && Number.isFinite(ageYears)) {
    const floor = paediatricSystolicFloorWith(protocol, ageYears);
    if (Number.isFinite(floor)) {
      return { ...base, systolicBP: { criticalLow: floor, low: floor + (formula.lowOffset ?? 10) } };
    }
  }
  return base;
}

/** Safe maximum wait in minutes for an ESI level under this protocol. */
export function safeWaitMinutesWith(protocol, esi) {
  return protocol.safeWaitMinutes?.[String(esi)] ?? 0;
}

/** A site's override for one rule, if any. */
export function ruleOverrideWith(protocol, code) {
  return (protocol.ruleOverrides ?? []).find((override) => override.code === code) ?? null;
}

/** Declared training coverage for an age band, used by the confidence score. */
export function modelSupportWith(protocol, band) {
  return protocol.modelSupportByBand?.[band] ?? 0.5;
}
