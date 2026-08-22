import {
  getDefaultProtocol,
  paediatricSystolicFloorWith,
  thresholdsWith,
} from './protocol.js';

/**
 * Age-band vital sign interpretation.
 *
 * The tables themselves moved into site protocols (see protocol.js and
 * protocols/*.json) so that a hospital can adapt them without a code change. What
 * stays here is the interpretation logic that is the same everywhere: how to look
 * a threshold up for a patient, and how to read a value against that patient's
 * own recorded baseline.
 *
 * The protocol argument is optional throughout. Omitting it uses the reference
 * protocol, which keeps call sites that do not care about multi-site
 * configuration readable.
 */

let cachedDefault = null;
const defaultProtocol = () => {
  cachedDefault ??= getDefaultProtocol();
  return cachedDefault;
};

/**
 * Thresholds for a patient, under a given site protocol.
 * @param {string} band     one of AGE_BAND
 * @param {number} ageYears decimal age, used by the paediatric systolic formula
 * @param {object} [protocol] resolved site protocol; defaults to the reference one
 */
export function thresholdsFor(band, ageYears, protocol = defaultProtocol()) {
  return thresholdsWith(protocol, band, ageYears);
}

/**
 * Paediatric hypotension floor for an age, under a given protocol. The reference
 * protocol implements the standard APLS 70 + (2 x age) formula for ages 1-10; a
 * site running a different paediatric standard changes the coefficients rather
 * than this function.
 */
export function paediatricSystolicFloor(ageYears, protocol = defaultProtocol()) {
  return paediatricSystolicFloorWith(protocol, ageYears);
}

/**
 * Interpret a value against this patient's own baseline where one exists.
 *
 * This is what makes a returning patient's history worth something, and it cuts
 * both ways: it catches the hypertensive 78-year-old whose 108 systolic is shock,
 * and it avoids crying wolf over the COPD patient who lives at 90% saturation.
 * Patients with no prior record get `null` here and fall back to absolute
 * thresholds, with the confidence score recording the gap.
 *
 * @returns {{ delta: number, percentChange: number, direction: string }|null}
 */
export function compareToBaseline(currentValue, baselineValue) {
  if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue) || baselineValue === 0) {
    return null;
  }
  const delta = currentValue - baselineValue;
  return {
    delta,
    percentChange: (delta / baselineValue) * 100,
    direction: delta === 0 ? 'unchanged' : delta > 0 ? 'above' : 'below',
  };
}
