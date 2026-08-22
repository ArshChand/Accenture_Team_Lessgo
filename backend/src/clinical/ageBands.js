import { AGE_BAND } from './constants.js';

/**
 * Age-band calibrated vital sign thresholds.
 *
 * This table is the direct answer to the brief's central safety point: a single
 * adult-calibrated scoring model applied across all ages introduces silent risk.
 * A heart rate of 150 is an emergency in a 40-year-old and unremarkable in a
 * 6-month-old; a respiratory rate of 40 is alarming in an adult and normal in a
 * neonate. Nothing downstream may compare a vital sign against a constant — every
 * comparison goes through this table.
 *
 * For each vital:
 *   criticalLow / criticalHigh — outside this is immediately life-threatening
 *   low / high                 — outside this is abnormal and worth escalating
 *
 * Sources are the standard paediatric (PALS/APLS) and adult reference ranges used
 * in emergency triage. They are illustrative and calibrated for a prototype, not a
 * substitute for a hospital's own validated protocol — a real deployment would
 * load a site-specific table here, which is also how the same assistant flexes
 * across hospitals of different specialty mix.
 */
export const VITAL_THRESHOLDS = {
  [AGE_BAND.NEONATE]: {
    heartRate: { criticalLow: 80, low: 100, high: 180, criticalHigh: 200 },
    respiratoryRate: { criticalLow: 20, low: 30, high: 60, criticalHigh: 70 },
    systolicBP: { criticalLow: 60, low: 65 },
    spo2: { critical: 88, low: 94 },
    // Neonates cannot mount a reliable fever, and hypothermia is the more ominous
    // sign. Any temperature derangement in this band is treated as serious.
    temperatureC: { hypothermic: 36.5, fever: 38.0, highFever: 39.0 },
    capillaryRefillSec: { high: 3 },
  },
  [AGE_BAND.INFANT]: {
    heartRate: { criticalLow: 80, low: 100, high: 160, criticalHigh: 190 },
    respiratoryRate: { criticalLow: 20, low: 24, high: 53, criticalHigh: 65 },
    systolicBP: { criticalLow: 70, low: 75 },
    spo2: { critical: 90, low: 94 },
    temperatureC: { hypothermic: 36.0, fever: 38.0, highFever: 39.5 },
    capillaryRefillSec: { high: 3 },
  },
  [AGE_BAND.TODDLER]: {
    heartRate: { criticalLow: 70, low: 90, high: 150, criticalHigh: 180 },
    respiratoryRate: { criticalLow: 18, low: 20, high: 37, criticalHigh: 50 },
    // Overridden per-year by paediatricSystolicFloor(); these are the fallbacks.
    systolicBP: { criticalLow: 72, low: 80 },
    spo2: { critical: 90, low: 94 },
    temperatureC: { hypothermic: 36.0, fever: 38.0, highFever: 39.5 },
    capillaryRefillSec: { high: 3 },
  },
  [AGE_BAND.CHILD]: {
    heartRate: { criticalLow: 60, low: 70, high: 120, criticalHigh: 160 },
    respiratoryRate: { criticalLow: 14, low: 18, high: 25, criticalHigh: 35 },
    systolicBP: { criticalLow: 80, low: 90 },
    spo2: { critical: 90, low: 94 },
    temperatureC: { hypothermic: 36.0, fever: 38.0, highFever: 40.0 },
    capillaryRefillSec: { high: 3 },
  },
  [AGE_BAND.ADOLESCENT]: {
    heartRate: { criticalLow: 50, low: 60, high: 100, criticalHigh: 140 },
    respiratoryRate: { criticalLow: 10, low: 12, high: 20, criticalHigh: 30 },
    systolicBP: { criticalLow: 90, low: 100 },
    spo2: { critical: 90, low: 94 },
    temperatureC: { hypothermic: 36.0, fever: 38.0, highFever: 40.0 },
    capillaryRefillSec: { high: 3 },
  },
  [AGE_BAND.ADULT]: {
    heartRate: { criticalLow: 40, low: 60, high: 100, criticalHigh: 130 },
    respiratoryRate: { criticalLow: 8, low: 12, high: 20, criticalHigh: 30 },
    systolicBP: { criticalLow: 90, low: 100 },
    spo2: { critical: 90, low: 94 },
    temperatureC: { hypothermic: 36.0, fever: 38.0, highFever: 40.0 },
    capillaryRefillSec: { high: 3 },
  },
  [AGE_BAND.GERIATRIC]: {
    // Reduced physiological reserve: a rate an adult tolerates is decompensation here.
    heartRate: { criticalLow: 40, low: 60, high: 100, criticalHigh: 120 },
    respiratoryRate: { criticalLow: 8, low: 12, high: 20, criticalHigh: 28 },
    // Relative hypotension: many geriatric patients are chronically hypertensive, so
    // a "normal" 105 can represent a 50-point drop. The absolute floor is raised, and
    // the baseline-comparison rule catches the rest.
    systolicBP: { criticalLow: 100, low: 110 },
    // Chronic lung disease is common; the baseline-comparison rule handles patients
    // who live at 90%, so this stays a genuine alarm rather than constant noise.
    spo2: { critical: 90, low: 92 },
    // Blunted febrile response: a lower fever threshold, and hypothermia is read as
    // a sepsis flag rather than as reassurance.
    temperatureC: { hypothermic: 36.0, fever: 37.8, highFever: 39.0 },
    capillaryRefillSec: { high: 3 },
  },
  [AGE_BAND.ADVANCED_GERIATRIC]: {
    heartRate: { criticalLow: 40, low: 60, high: 100, criticalHigh: 115 },
    respiratoryRate: { criticalLow: 8, low: 12, high: 20, criticalHigh: 26 },
    systolicBP: { criticalLow: 100, low: 110 },
    spo2: { critical: 90, low: 92 },
    temperatureC: { hypothermic: 36.0, fever: 37.8, highFever: 39.0 },
    capillaryRefillSec: { high: 3 },
  },
};

/**
 * Paediatric hypotension floor: 70 + (2 x age in years), the standard APLS formula
 * for children aged 1-10. Below this is hypotension regardless of what a fixed
 * table would say.
 */
export function paediatricSystolicFloor(ageYears) {
  if (ageYears < 1) return 70;
  if (ageYears > 10) return 90;
  return 70 + 2 * ageYears;
}

/**
 * Thresholds for a specific patient: the band table, with the paediatric systolic
 * floor substituted in where the formula is more precise than the band default.
 */
export function thresholdsFor(band, ageYears) {
  const base = VITAL_THRESHOLDS[band] ?? VITAL_THRESHOLDS[AGE_BAND.ADULT];

  if (
    (band === AGE_BAND.TODDLER || band === AGE_BAND.CHILD) &&
    Number.isFinite(ageYears)
  ) {
    const floor = paediatricSystolicFloor(ageYears);
    return {
      ...base,
      systolicBP: { criticalLow: floor, low: floor + 10 },
    };
  }

  return base;
}

/**
 * Interpret a value against this patient's own baseline where one exists.
 *
 * This is what makes a returning patient's rich history actually worth something,
 * and it cuts both ways: it catches the hypertensive 78-year-old whose 108 is
 * shock, and it avoids crying wolf over the COPD patient who lives at 90% oxygen
 * saturation. Patients with no prior record simply get `null` here and fall back
 * to absolute thresholds, with the confidence score recording the gap.
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
