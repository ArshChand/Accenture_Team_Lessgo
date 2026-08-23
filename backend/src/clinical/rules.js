import { AGE_BAND, ESI, isGeriatric, isPaediatric } from './constants.js';
import { compareToBaseline } from './ageBands.js';
import { getDefaultProtocol, ruleOverrideWith, thresholdsWith } from './protocol.js';
import { valueOf } from './observation.js';
import {
  ATYPICAL_CARDIAC_SYMPTOMS,
  CARDIAC_RISK_CONDITIONS,
  INFECTION_SYMPTOMS,
  RISK_CONDITION,
  STROKE_SYMPTOMS,
  SYMPTOM,
} from './symptoms.js';

/**
 * The deterministic rule engine.
 *
 * This layer is the safety floor and it exists independently of the model on
 * purpose. Rules are auditable, reviewable by a clinician who does not read
 * Python, and stable across retraining. The model can make the assessment more
 * urgent; it can never talk the rules down.
 *
 * Two structural commitments:
 *
 *   1. A rule sets a FLOOR, expressed as the least urgent ESI it will tolerate.
 *      The engine takes the most urgent floor across everything that fired. When
 *      nothing fires the floor is 5, meaning "the rules impose no constraint" —
 *      not "this patient is non-urgent". That distinction matters because the
 *      fusion step takes min(ruleFloor, modelESI), so a quiet rule engine defers
 *      to the model rather than dragging the score down.
 *
 *   2. No rule compares a vital sign against a constant. Every comparison goes
 *      through the age-band table, and where the patient has a baseline on file it
 *      goes through that too.
 */

const CAP = {
  /**
   * Modifiers escalate by a level but never all the way to ESI 1. Resuscitation
   * must be a positive finding — something someone observed — not the sum of
   * several soft signals. Flooding the resus bay is its own safety failure, and it
   * is the failure mode that teaches staff to ignore the tool.
   */
  MODIFIER_FLOOR: ESI.EMERGENT,
};

/** Age phrased at the precision the paediatric rules actually turn on. */
function describeInfantAge(ageYears) {
  const days = ageYears * 365.25;
  if (days < 28) return `${Math.max(0, Math.round(days))} days old`;
  const weeks = Math.round(days / 7);
  if (weeks < 14) return `${weeks} weeks old`;
  const months = Math.round(ageYears * 12);
  return `${months} month${months === 1 ? '' : 's'} old`;
}

const has = (set, symptom) => set.has(symptom);
const hasAny = (set, list) => list.some((s) => set.has(s));
const countTrue = (...values) => values.filter(Boolean).length;

/**
 * Flatten an encounter, its patient record and its latest vitals into the shape
 * the rules read. Absent values stay `undefined` throughout — never coerced to 0,
 * which would read as profound bradycardia rather than as "we did not measure it".
 */
let cachedDefaultProtocol = null;
const referenceProtocol = () => {
  cachedDefaultProtocol ??= getDefaultProtocol();
  return cachedDefaultProtocol;
};

export function buildRuleContext({ encounter, patient = {}, vitals = {}, protocol }) {
  const activeProtocol = protocol ?? referenceProtocol();
  const ageYears = encounter?.age?.ageYears;
  const band = encounter?.age?.band ?? AGE_BAND.ADULT;
  const thresholds = thresholdsWith(activeProtocol, band, ageYears);

  const symptoms = new Set(encounter?.intake?.extraction?.symptoms ?? []);
  const negations = new Set(encounter?.intake?.extraction?.negations ?? []);
  const conditions = new Set(patient?.chronicConditions ?? []);
  const medications = patient?.medications ?? [];

  const hr = valueOf(vitals.heartRate);
  const sbp = valueOf(vitals.systolicBP);

  return {
    ageYears,
    band,
    thresholds,
    isPaediatric: isPaediatric(band),
    isGeriatric: isGeriatric(band),

    hr,
    rr: valueOf(vitals.respiratoryRate),
    sbp,
    dbp: valueOf(vitals.diastolicBP),
    spo2: valueOf(vitals.spo2),
    temp: valueOf(vitals.temperatureC),
    gcs: valueOf(vitals.gcs),
    avpu: valueOf(vitals.avpu),
    pain: valueOf(vitals.painScore),
    capRefill: valueOf(vitals.capillaryRefillSec),
    glucose: valueOf(vitals.bloodGlucose),

    /**
     * HR / systolic. Above the age-appropriate ceiling it suggests occult shock
     * behind a blood pressure that still looks normal on its own.
     */
    shockIndex:
      Number.isFinite(hr) && Number.isFinite(sbp) && sbp > 0
        ? Number((hr / sbp).toFixed(2))
        : undefined,
    shockIndexCeiling: activeProtocol.shockIndexCeiling?.[band] ?? 0.9,

    cues: vitals.observedCues ?? {},
    hasAnyVitals: [
      vitals.heartRate,
      vitals.respiratoryRate,
      vitals.systolicBP,
      vitals.spo2,
      vitals.temperatureC,
      vitals.gcs,
    ].some(Boolean),

    symptoms,
    negations,
    conditions,
    medications: {
      anticoagulant: medications.some((m) => m.isAnticoagulant),
      betaBlocker: medications.some((m) => m.isBetaBlocker),
      immunosuppressant: medications.some((m) => m.isImmunosuppressant),
    },

    baselines: patient?.baselines ?? {},
    hasPriorRecord: Boolean(patient?.hasPriorRecord),
    isPregnant: conditions.has(RISK_CONDITION.PREGNANCY) || symptoms.has(SYMPTOM.PREGNANCY_RELATED),
    viaProxy: Boolean(encounter?.intake?.viaProxy),

    /** Carried so evaluateRules can apply this site's rule overrides. */
    protocol: activeProtocol,
  };
}

/**
 * Rule definitions.
 *
 * `kind: 'floor'` (default) constrains the assessment to at least `impliedESI`.
 * `kind: 'modifier'` escalates the result by `escalateBy` after floors resolve.
 * `hardRedFlag: true` additionally locks the model out of downgrading the result.
 * `ageBandSpecific: true` marks a rule that exists only because of the patient's
 * age — these are surfaced separately in the UI so a nurse can see the paediatric
 * or geriatric reasoning rather than a generic score.
 */
export const RULES = [
  // ---------------------------------------------------------------- ESI 1
  {
    code: 'UNRESPONSIVE',
    label: 'Unresponsive / severe depression of consciousness',
    impliedESI: ESI.RESUSCITATION,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) => {
      if (Number.isFinite(c.gcs) && c.gcs <= 8) {
        return { evidence: `GCS ${c.gcs}`, rationale: 'GCS 8 or below cannot protect an airway.' };
      }
      if (c.avpu === 'U') {
        return { evidence: 'AVPU: Unresponsive', rationale: 'Unresponsive to voice and pain.' };
      }
      return null;
    },
  },
  {
    code: 'APNOEA_OR_BRADYPNOEA',
    label: 'Absent or critically slow breathing',
    impliedESI: ESI.RESUSCITATION,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) => {
      if (!Number.isFinite(c.rr)) return null;
      const floor = c.thresholds.respiratoryRate.criticalLow;
      if (c.rr <= floor) {
        return {
          evidence: `RR ${c.rr}/min (critical floor ${floor} for ${c.band})`,
          rationale: 'Respiratory rate at or below the critical floor for this age band.',
        };
      }
      return null;
    },
  },
  {
    code: 'SEVERE_HYPOXIA',
    label: 'Severe hypoxia',
    impliedESI: ESI.RESUSCITATION,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) =>
      Number.isFinite(c.spo2) && c.spo2 < 85
        ? { evidence: `SpO2 ${c.spo2}%`, rationale: 'Saturation below 85% requires immediate intervention.' }
        : null,
  },
  {
    code: 'DECOMPENSATED_SHOCK',
    label: 'Decompensated shock',
    impliedESI: ESI.RESUSCITATION,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) => {
      if (!Number.isFinite(c.sbp)) return null;
      const floor = c.thresholds.systolicBP.criticalLow;
      if (c.sbp >= floor) return null;

      const perfusionFailure =
        (Number.isFinite(c.hr) && c.hr > c.thresholds.heartRate.high) ||
        (Number.isFinite(c.gcs) && c.gcs < 15) ||
        (Number.isFinite(c.capRefill) && c.capRefill > c.thresholds.capillaryRefillSec.high);

      return perfusionFailure
        ? {
            evidence: `SBP ${c.sbp} mmHg (critical floor ${floor}) with end-organ signs`,
            rationale: 'Hypotension below the age-band floor together with signs of failing perfusion.',
          }
        : null;
    },
  },
  {
    code: 'ANAPHYLAXIS',
    label: 'Possible anaphylaxis',
    impliedESI: ESI.RESUSCITATION,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) =>
      has(c.symptoms, SYMPTOM.ALLERGIC_REACTION) &&
      hasAny(c.symptoms, [SYMPTOM.DYSPNOEA, SYMPTOM.STRIDOR, SYMPTOM.WHEEZE])
        ? {
            evidence: 'Allergic reaction with airway or breathing involvement',
            rationale: 'Allergic reaction plus respiratory compromise is anaphylaxis until disproved.',
          }
        : null,
  },
  {
    code: 'SEVERE_HYPOGLYCAEMIA',
    label: 'Severe hypoglycaemia',
    impliedESI: ESI.RESUSCITATION,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) =>
      Number.isFinite(c.glucose) && c.glucose < 40
        ? { evidence: `Glucose ${c.glucose} mg/dL`, rationale: 'Immediately reversible cause of coma.' }
        : null,
  },

  // ---------------------------------------------------------------- ESI 2
  {
    code: 'HYPOXIA',
    label: 'Hypoxia',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      if (!Number.isFinite(c.spo2)) return null;
      const { critical, low } = c.thresholds.spo2;

      // A COPD patient who lives at 90% is not desaturating at 90%. Where a baseline
      // exists, judge the change; where it does not, judge the absolute value.
      const vsBaseline = compareToBaseline(c.spo2, c.baselines.spo2);
      if (vsBaseline && c.spo2 >= c.baselines.spo2 - 2) {
        return c.spo2 < critical
          ? {
              impliedESI: ESI.URGENT,
              evidence: `SpO2 ${c.spo2}% against a recorded baseline of ${c.baselines.spo2}%`,
              rationale:
                'Low absolute saturation but consistent with this patient’s own baseline, so treated as urgent rather than emergent.',
            }
          : null;
      }

      if (c.spo2 < critical) {
        return {
          evidence: `SpO2 ${c.spo2}%${vsBaseline ? ` (baseline ${c.baselines.spo2}%)` : ' (no baseline on file)'}`,
          rationale: 'Saturation below the critical threshold for this age band.',
        };
      }
      if (c.spo2 < low) {
        return {
          impliedESI: ESI.URGENT,
          evidence: `SpO2 ${c.spo2}%`,
          rationale: 'Saturation below the normal range for this age band.',
        };
      }
      return null;
    },
  },
  {
    code: 'SEVERE_TACHYPNOEA',
    label: 'Severe tachypnoea',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      if (!Number.isFinite(c.rr)) return null;
      const ceiling = c.thresholds.respiratoryRate.criticalHigh;
      return c.rr > ceiling
        ? {
            evidence: `RR ${c.rr}/min (critical ceiling ${ceiling} for ${c.band})`,
            rationale: 'Respiratory rate above the critical ceiling for this age band.',
          }
        : null;
    },
  },
  {
    code: 'SEVERE_TACHYCARDIA',
    label: 'Severe tachycardia',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      if (!Number.isFinite(c.hr)) return null;
      const ceiling = c.thresholds.heartRate.criticalHigh;
      return c.hr > ceiling
        ? {
            evidence: `HR ${c.hr} bpm (critical ceiling ${ceiling} for ${c.band})`,
            rationale: 'Heart rate above the critical ceiling for this age band.',
          }
        : null;
    },
  },
  {
    code: 'HYPOTENSION',
    label: 'Hypotension',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      if (!Number.isFinite(c.sbp)) return null;
      const { low } = c.thresholds.systolicBP;
      return c.sbp < low
        ? {
            evidence: `SBP ${c.sbp} mmHg (threshold ${low} for ${c.band})`,
            rationale: 'Systolic pressure below the acceptable floor for this age band.',
          }
        : null;
    },
  },
  {
    code: 'RELATIVE_HYPOTENSION',
    label: 'Relative hypotension against patient baseline',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    ageBandSpecific: true,
    hardRedFlag: true,
    evaluate: (c) => {
      if (!c.isGeriatric || !Number.isFinite(c.sbp)) return null;
      const vsBaseline = compareToBaseline(c.sbp, c.baselines.systolicBP);
      if (!vsBaseline || vsBaseline.percentChange > -25) return null;
      return {
        evidence: `SBP ${c.sbp} mmHg vs baseline ${c.baselines.systolicBP} (${vsBaseline.percentChange.toFixed(0)}%)`,
        rationale:
          'A pressure that looks normal in isolation is a large drop from this patient’s own baseline — occult shock in a chronically hypertensive patient.',
      };
    },
  },
  {
    code: 'NEW_ALTERED_MENTAL_STATUS',
    label: 'New altered mental status',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) => {
      if (Number.isFinite(c.gcs) && c.gcs >= 9 && c.gcs < 15) {
        return { evidence: `GCS ${c.gcs}`, rationale: 'Reduced consciousness short of airway compromise.' };
      }
      if (has(c.symptoms, SYMPTOM.CONFUSION)) {
        // Chronic dementia is not new confusion. Distinguishing the two is exactly
        // what the cognitive baseline is for.
        const chronic =
          c.conditions.has(RISK_CONDITION.DEMENTIA) &&
          c.baselines.cognitiveBaseline &&
          c.baselines.cognitiveBaseline !== 'alert_oriented';
        if (chronic) return null;
        return {
          evidence: c.baselines.cognitiveBaseline
            ? `Confusion reported; baseline recorded as "${c.baselines.cognitiveBaseline}"`
            : 'Confusion reported; no cognitive baseline on file',
          rationale:
            'New confusion is a presenting sign of sepsis, stroke, hypoglycaemia and intracranial bleeding.',
        };
      }
      return null;
    },
  },
  {
    code: 'STROKE_SYMPTOMS',
    label: 'Possible stroke (FAST positive)',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) =>
      hasAny(c.symptoms, STROKE_SYMPTOMS)
        ? {
            evidence: [...c.symptoms].filter((s) => STROKE_SYMPTOMS.includes(s)).join(', '),
            rationale: 'Time-critical: thrombolysis window is measured in minutes.',
          }
        : null,
  },
  {
    code: 'RESPIRATORY_DISTRESS',
    label: 'Visible respiratory distress',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      const signs = [];
      if (c.cues.accessoryMuscleUse) signs.push('accessory muscle use');
      if (c.cues.unableToSpeakFullSentences) signs.push('unable to speak full sentences');
      if (c.cues.cyanosis) signs.push('cyanosis');
      if (has(c.symptoms, SYMPTOM.STRIDOR)) signs.push('stridor');
      return signs.length > 0
        ? {
            evidence: signs.join(', '),
            rationale: 'Work of breathing is a bedside sign that precedes measurable desaturation.',
          }
        : null;
    },
  },
  {
    code: 'HIGH_RISK_CHEST_PAIN',
    label: 'Chest pain with cardiac risk',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      if (!has(c.symptoms, SYMPTOM.CHEST_PAIN)) return null;
      const riskFactors = [...c.conditions].filter((cond) => CARDIAC_RISK_CONDITIONS.includes(cond));
      const ageRisk = Number.isFinite(c.ageYears) && c.ageYears >= 40;
      if (!ageRisk && riskFactors.length === 0) return null;
      return {
        evidence: `Chest pain${has(c.symptoms, SYMPTOM.RADIATING_PAIN) ? ' with radiation' : ''}${
          riskFactors.length ? `; history of ${riskFactors.join(', ')}` : ''
        }${ageRisk ? `; age ${Math.round(c.ageYears)}` : ''}`,
        rationale: 'Acute coronary syndrome must be excluded before any other explanation.',
      };
    },
  },
  {
    code: 'ATYPICAL_CARDIAC_PRESENTATION',
    label: 'Atypical cardiac presentation',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    ageBandSpecific: true,
    evaluate: (c) => {
      if (has(c.symptoms, SYMPTOM.CHEST_PAIN)) return null; // covered by the rule above
      const susceptible = c.isGeriatric || c.conditions.has(RISK_CONDITION.DIABETES);
      if (!susceptible) return null;
      if (!Number.isFinite(c.ageYears) || c.ageYears < 40) return null;

      const present = [...c.symptoms].filter((s) => ATYPICAL_CARDIAC_SYMPTOMS.includes(s));
      if (present.length === 0) return null;

      return {
        evidence: `${present.join(', ')} without chest pain${
          c.conditions.has(RISK_CONDITION.DIABETES) ? '; diabetic' : ''
        }${c.isGeriatric ? '; geriatric' : ''}`,
        rationale:
          'Diabetic and elderly patients infarct without chest pain. Treating "no chest pain" as reassurance is a classic under-triage.',
      };
    },
  },
  {
    code: 'NEONATE_PRESENTATION',
    label: 'Neonate presenting to the emergency department',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    ageBandSpecific: true,
    hardRedFlag: true,
    evaluate: (c) =>
      c.band === AGE_BAND.NEONATE
        ? {
            evidence: `Age ${Math.round((c.ageYears ?? 0) * 365)} days`,
            rationale:
              'Neonates decompensate without warning and localise infection poorly. No neonate waits in a general queue.',
          }
        : null,
  },
  {
    code: 'INFANT_FEVER_UNDER_3_MONTHS',
    label: 'Fever in an infant under 3 months',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    ageBandSpecific: true,
    hardRedFlag: true,
    evaluate: (c) => {
      if (!Number.isFinite(c.ageYears) || c.ageYears >= 0.25) return null;
      if (!Number.isFinite(c.temp) || c.temp < 38.0) return null;
      return {
        // Reported in weeks below three months: this rule turns on exactly how
        // young the infant is, so rounding a six-week-old to "1 months" both
        // reads wrong and hides the margin the nurse is checking.
        evidence: `Temperature ${c.temp}°C at ${describeInfantAge(c.ageYears)}`,
        rationale:
          'Any fever under 3 months mandates a full septic screen regardless of how well the infant appears. Appearance is not a reliable discriminator at this age.',
      };
    },
  },
  {
    code: 'PAEDIATRIC_COMPENSATED_SHOCK',
    label: 'Paediatric compensated shock',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    ageBandSpecific: true,
    hardRedFlag: true,
    evaluate: (c) => {
      if (!c.isPaediatric) return null;
      const delayedRefill =
        Number.isFinite(c.capRefill) && c.capRefill > c.thresholds.capillaryRefillSec.high;
      const tachycardic = Number.isFinite(c.hr) && c.hr > c.thresholds.heartRate.high;
      if (!delayedRefill || !tachycardic) return null;

      return {
        evidence: `Cap refill ${c.capRefill}s with HR ${c.hr} bpm${
          Number.isFinite(c.sbp) ? `, SBP ${c.sbp} mmHg` : ''
        }`,
        rationale:
          'Children maintain blood pressure until they crash. Waiting for hypotension in a child is waiting too long.',
      };
    },
  },
  {
    code: 'GERIATRIC_HYPOTHERMIA',
    label: 'Hypothermia in an older patient',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    ageBandSpecific: true,
    hardRedFlag: true,
    evaluate: (c) => {
      if (!c.isGeriatric || !Number.isFinite(c.temp)) return null;
      return c.temp < c.thresholds.temperatureC.hypothermic
        ? {
            evidence: `Temperature ${c.temp}°C`,
            rationale:
              'Older patients mount a blunted febrile response; hypothermia rather than fever is a common presentation of sepsis. Absence of fever is not reassurance.',
          }
        : null;
    },
  },
  {
    code: 'ANTICOAGULATED_HEAD_INJURY',
    label: 'Head injury on anticoagulation',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    ageBandSpecific: true,
    hardRedFlag: true,
    evaluate: (c) => {
      if (!c.medications.anticoagulant) return null;
      if (!hasAny(c.symptoms, [SYMPTOM.HEAD_INJURY, SYMPTOM.FALL])) return null;
      return {
        evidence: 'Head strike or fall while anticoagulated',
        rationale:
          'Intracranial haemorrhage can develop hours later and with a normal GCS at presentation. A reassuring initial exam does not exclude it.',
      };
    },
  },
  {
    code: 'IMMUNOSUPPRESSED_FEVER',
    label: 'Fever in an immunosuppressed patient',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      const immunosuppressed =
        c.medications.immunosuppressant ||
        c.conditions.has(RISK_CONDITION.IMMUNOSUPPRESSION) ||
        c.conditions.has(RISK_CONDITION.MALIGNANCY);
      if (!immunosuppressed) return null;
      if (!Number.isFinite(c.temp) || c.temp < c.thresholds.temperatureC.fever) return null;
      return {
        evidence: `Temperature ${c.temp}°C in an immunosuppressed patient`,
        rationale: 'Neutropenic sepsis is time-critical and presents with few localising signs.',
      };
    },
  },
  {
    code: 'SEPSIS_SCREEN_POSITIVE',
    label: 'Sepsis screen positive',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      if (!hasAny(c.symptoms, INFECTION_SYMPTOMS)) return null;

      const t = c.thresholds;
      const criteria = [];
      if (Number.isFinite(c.temp) && (c.temp >= t.temperatureC.fever || c.temp < t.temperatureC.hypothermic)) {
        criteria.push(`temperature ${c.temp}°C`);
      }
      if (Number.isFinite(c.hr) && c.hr > t.heartRate.high) criteria.push(`HR ${c.hr}`);
      if (Number.isFinite(c.rr) && c.rr > t.respiratoryRate.high) criteria.push(`RR ${c.rr}`);
      if (Number.isFinite(c.sbp) && c.sbp < t.systolicBP.low) criteria.push(`SBP ${c.sbp}`);

      if (criteria.length < 2) return null;
      return {
        evidence: `Infective symptoms with ${criteria.join(', ')}`,
        rationale: 'Two or more age-adjusted physiological criteria plus a plausible source.',
      };
    },
  },
  {
    code: 'PRE_ECLAMPSIA_RISK',
    label: 'Possible pre-eclampsia',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) => {
      if (!c.isPregnant) return null;
      const hypertensive =
        (Number.isFinite(c.sbp) && c.sbp >= 140) || (Number.isFinite(c.dbp) && c.dbp >= 90);
      if (!hypertensive) return null;
      if (!hasAny(c.symptoms, [SYMPTOM.HEADACHE, SYMPTOM.VISUAL_DISTURBANCE, SYMPTOM.ABDOMINAL_PAIN])) {
        return null;
      }
      return {
        evidence: `BP ${c.sbp ?? '?'}/${c.dbp ?? '?'} mmHg in pregnancy with neurological or abdominal symptoms`,
        rationale: 'Pre-eclampsia can progress to eclampsia and is an obstetric emergency.',
      };
    },
  },
  {
    code: 'ELEVATED_SHOCK_INDEX',
    label: 'Elevated shock index',
    impliedESI: ESI.EMERGENT,
    severity: 'warning',
    ageBandSpecific: true,
    evaluate: (c) => {
      if (!Number.isFinite(c.shockIndex)) return null;
      // Age-adjusted, like every other threshold in this engine. A single adult
      // ceiling of 0.9 would call every healthy child shocked: children run fast
      // hearts against low pressures, so the ratio is high in health.
      const ceiling = c.shockIndexCeiling;
      if (!Number.isFinite(ceiling) || c.shockIndex <= ceiling) return null;
      return {
        evidence: `Shock index ${c.shockIndex} (HR ${c.hr} / SBP ${c.sbp}); ceiling ${ceiling} for ${c.band}`,
        rationale:
          'The ratio detects compensated shock while heart rate and blood pressure are each still individually within range.',
      };
    },
  },
  {
    code: 'BETA_BLOCKER_MASKED_SHOCK',
    label: 'Hypotension without compensatory tachycardia (beta blockade)',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) => {
      if (!c.medications.betaBlocker) return null;
      if (!Number.isFinite(c.sbp) || c.sbp >= c.thresholds.systolicBP.low) return null;
      if (!Number.isFinite(c.hr) || c.hr > c.thresholds.heartRate.high) return null;
      return {
        evidence: `SBP ${c.sbp} mmHg with HR only ${c.hr} bpm on a beta blocker`,
        rationale:
          'Beta blockade suppresses the tachycardic response, so a "reassuring" heart rate here removes a warning sign rather than providing one.',
      };
    },
  },
  {
    code: 'HYPOGLYCAEMIA',
    label: 'Hypoglycaemia',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) =>
      Number.isFinite(c.glucose) && c.glucose >= 40 && c.glucose < 54
        ? { evidence: `Glucose ${c.glucose} mg/dL`, rationale: 'Symptomatic hypoglycaemia needs prompt correction.' }
        : null,
  },
  {
    code: 'HYPERPYREXIA',
    label: 'Very high fever',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) =>
      Number.isFinite(c.temp) && c.temp >= c.thresholds.temperatureC.highFever
        ? {
            evidence: `Temperature ${c.temp}°C (threshold ${c.thresholds.temperatureC.highFever} for ${c.band})`,
            rationale: 'Temperature above the high-fever threshold for this age band.',
          }
        : null,
  },
  {
    code: 'SEVERE_PAIN',
    label: 'Severe pain',
    impliedESI: ESI.EMERGENT,
    severity: 'warning',
    evaluate: (c) =>
      Number.isFinite(c.pain) && c.pain >= 7
        ? { evidence: `Self-reported pain ${c.pain}/10`, rationale: 'Severe pain warrants rapid assessment.' }
        : null,
  },
  {
    code: 'DELIBERATE_SELF_HARM_OR_OVERDOSE',
    label: 'Overdose or self-harm',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    hardRedFlag: true,
    evaluate: (c) =>
      hasAny(c.symptoms, [SYMPTOM.OVERDOSE, SYMPTOM.SELF_HARM])
        ? {
            evidence: 'Overdose or self-harm reported',
            rationale:
              'Requires both medical assessment and continuous observation for safety; toxic effects are often delayed.',
          }
        : null,
  },
  {
    code: 'SIGNIFICANT_HAEMORRHAGE',
    label: 'Bleeding with haemodynamic change',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    evaluate: (c) => {
      if (!hasAny(c.symptoms, [SYMPTOM.GI_BLEEDING, SYMPTOM.VAGINAL_BLEEDING, SYMPTOM.BLEEDING])) {
        return null;
      }
      const tachycardic = Number.isFinite(c.hr) && c.hr > c.thresholds.heartRate.high;
      const hypotensive = Number.isFinite(c.sbp) && c.sbp < c.thresholds.systolicBP.low;
      if (!tachycardic && !hypotensive) return null;
      return {
        evidence: `Bleeding with ${tachycardic ? `HR ${c.hr}` : ''}${tachycardic && hypotensive ? ', ' : ''}${
          hypotensive ? `SBP ${c.sbp}` : ''
        }`,
        rationale: 'Ongoing blood loss with a measurable circulatory response.',
      };
    },
  },

  // ---------------------------------------------------------------- ESI 3
  {
    code: 'NO_VITALS_RECORDED',
    label: 'No vital signs recorded',
    impliedESI: ESI.URGENT,
    severity: 'warning',
    evaluate: (c) =>
      c.hasAnyVitals
        ? null
        : {
            evidence: 'No vital signs on file for this encounter',
            rationale:
              'A patient who has not been measured cannot be cleared. The floor stays at urgent until someone takes observations.',
          },
  },
  {
    code: 'MODERATE_PAIN',
    label: 'Moderate pain',
    impliedESI: ESI.URGENT,
    severity: 'info',
    evaluate: (c) =>
      Number.isFinite(c.pain) && c.pain >= 4 && c.pain < 7
        ? { evidence: `Self-reported pain ${c.pain}/10`, rationale: 'Moderate pain usually needs analgesia and assessment.' }
        : null,
  },
  {
    code: 'FEVER_PRESENT',
    label: 'Fever',
    impliedESI: ESI.URGENT,
    severity: 'info',
    evaluate: (c) => {
      if (!Number.isFinite(c.temp)) return null;
      const { fever, highFever } = c.thresholds.temperatureC;
      return c.temp >= fever && c.temp < highFever
        ? {
            evidence: `Temperature ${c.temp}°C (fever threshold ${fever} for ${c.band})`,
            rationale: 'Fever against the threshold for this age band.',
          }
        : null;
    },
  },
  {
    code: 'ABNORMAL_VITAL_SIGN',
    label: 'Vital sign outside the normal range for age',
    impliedESI: ESI.URGENT,
    severity: 'warning',
    evaluate: (c) => {
      const t = c.thresholds;
      const abnormal = [];
      if (Number.isFinite(c.hr) && (c.hr < t.heartRate.low || c.hr > t.heartRate.high)) {
        abnormal.push(`HR ${c.hr} (normal ${t.heartRate.low}-${t.heartRate.high})`);
      }
      if (
        Number.isFinite(c.rr) &&
        (c.rr < t.respiratoryRate.low || c.rr > t.respiratoryRate.high)
      ) {
        abnormal.push(`RR ${c.rr} (normal ${t.respiratoryRate.low}-${t.respiratoryRate.high})`);
      }
      if (Number.isFinite(c.capRefill) && c.capRefill > t.capillaryRefillSec.high) {
        abnormal.push(`cap refill ${c.capRefill}s`);
      }
      return abnormal.length > 0
        ? {
            evidence: abnormal.join('; '),
            rationale: `Outside the reference range for the ${c.band} band, though not yet critical.`,
          }
        : null;
    },
  },

  // ------------------------------------------------------------- MODIFIERS
  {
    code: 'PAIN_DISCORDANCE',
    label: 'Reported pain contradicts observed distress',
    kind: 'modifier',
    escalateBy: 1,
    severity: 'warning',
    evaluate: (c) => {
      if (!Number.isFinite(c.pain) || c.pain > 3) return null;

      const objective = [];
      if (c.cues.diaphoresis) objective.push('diaphoresis');
      if (c.cues.guarding) objective.push('guarding');
      if (c.cues.pallor) objective.push('pallor');
      if (Number.isFinite(c.hr) && c.hr > c.thresholds.heartRate.high) objective.push(`HR ${c.hr}`);

      if (objective.length < 2) return null;
      return {
        evidence: `Pain reported ${c.pain}/10 but ${objective.join(', ')}`,
        rationale:
          'Stoicism, language barriers and cultural norms all cause under-reporting. Where the body and the words disagree, the system weighs the body.',
      };
    },
  },
  {
    code: 'UNRELIABLE_HISTORY',
    label: 'History obtained through a proxy',
    kind: 'modifier',
    escalateBy: 1,
    severity: 'info',
    evaluate: (c) => {
      if (!c.viaProxy) return null;
      // Only escalates when the proxy history is the *only* thing we have.
      if (c.hasAnyVitals) return null;
      return {
        evidence: 'Symptoms reported by an attendant, with no measured observations',
        rationale: 'Second-hand history with nothing measured is the weakest evidence state.',
      };
    },
  },
];

/**
 * Run every rule against the context.
 *
 * @returns {{ esi: number, floorImposed: boolean, firedRules: Array, hardRedFlag: boolean }}
 *   `esi` is the floor the rules impose. 5 means "no constraint", which is why
 *   `floorImposed` is reported separately — the caller must not read a 5 here as a
 *   positive judgement that the patient is non-urgent.
 */
export function evaluateRules(context) {
  const protocol = context.protocol ?? referenceProtocol();
  const fired = [];
  let floor = ESI.NON_URGENT;
  let hardRedFlag = false;

  /**
   * Apply a site's override for one rule.
   *
   * An override may only make a rule MORE urgent — the result is the most urgent
   * of the rule's own conclusion and the site's configured level. Site
   * configuration exists to let a hospital adapt to local reality (no ventilator,
   * a 90-minute transfer, a single clinician overnight); it must not become a way
   * to quietly soften a safety rule. Disabling a rule outright is possible, but
   * `validateProtocol` refuses it for the rules that prevent a fatal miss.
   */
  const applyOverride = (code, impliedESI) => {
    const override = ruleOverrideWith(protocol, code);
    if (!override) return { skip: false, impliedESI };
    if (override.enabled === false) return { skip: true, impliedESI };
    return {
      skip: false,
      impliedESI: Math.min(impliedESI, override.impliedESI ?? ESI.NON_URGENT),
    };
  };

  for (const rule of RULES) {
    if ((rule.kind ?? 'floor') !== 'floor') continue;

    const result = rule.evaluate(context);
    if (!result) continue;

    const decided = applyOverride(rule.code, result.impliedESI ?? rule.impliedESI);
    if (decided.skip) continue;
    const impliedESI = decided.impliedESI;

    fired.push({
      code: rule.code,
      label: rule.label,
      impliedESI,
      severity: rule.severity ?? 'warning',
      rationale: result.rationale,
      evidence: result.evidence,
      ageBandSpecific: Boolean(rule.ageBandSpecific),
      hardRedFlag: Boolean(rule.hardRedFlag),
    });

    if (impliedESI < floor) floor = impliedESI;
    if (rule.hardRedFlag) hardRedFlag = true;
  }

  // Modifiers apply after floors resolve, and cannot reach ESI 1.
  const modifierFloor = protocol.confidence?.escalationFloorESI ?? CAP.MODIFIER_FLOOR;

  for (const rule of RULES) {
    if (rule.kind !== 'modifier') continue;
    if (ruleOverrideWith(protocol, rule.code)?.enabled === false) continue;

    const result = rule.evaluate(context);
    if (!result) continue;

    const escalated = Math.max(modifierFloor, floor - (rule.escalateBy ?? 1));
    fired.push({
      code: rule.code,
      label: rule.label,
      impliedESI: escalated,
      severity: rule.severity ?? 'warning',
      rationale: result.rationale,
      evidence: result.evidence,
      ageBandSpecific: Boolean(rule.ageBandSpecific),
      hardRedFlag: false,
    });
    floor = escalated;
  }

  return {
    esi: floor,
    floorImposed: floor < ESI.NON_URGENT,
    firedRules: fired.sort((a, b) => a.impliedESI - b.impliedESI),
    hardRedFlag,
  };
}
