import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRuleContext, evaluateRules } from '../src/clinical/rules.js';
import { AGE_BAND, ESI, resolveAgeBand } from '../src/clinical/constants.js';
import { paediatricSystolicFloor, thresholdsFor } from '../src/clinical/ageBands.js';
import { measured, observed, selfReported } from '../src/clinical/observation.js';
import { RISK_CONDITION, SYMPTOM } from '../src/clinical/symptoms.js';

/**
 * The rule engine is the safety floor, so these tests are written as clinical
 * claims rather than as unit-test plumbing. Each one asserts something a
 * clinician could disagree with out loud — which is the point: the rules are
 * meant to be reviewable by someone who does not read the code.
 */

/** Build a rule context without going through the database. */
function ctx({
  ageYears,
  vitals = {},
  cues = {},
  symptoms = [],
  conditions = [],
  medications = [],
  baselines = {},
  hasPriorRecord = false,
  viaProxy = false,
}) {
  const band = resolveAgeBand(ageYears);
  return buildRuleContext({
    encounter: {
      age: { ageYears, band },
      intake: { extraction: { symptoms }, viaProxy },
    },
    patient: { chronicConditions: conditions, medications, baselines, hasPriorRecord },
    vitals: { ...vitals, observedCues: cues },
  });
}

const codes = (result) => result.firedRules.map((r) => r.code);

describe('age band resolution', () => {
  it('places each age in the expected band', () => {
    assert.equal(resolveAgeBand(10 / 365), AGE_BAND.NEONATE);
    assert.equal(resolveAgeBand(0.5), AGE_BAND.INFANT);
    assert.equal(resolveAgeBand(3), AGE_BAND.TODDLER);
    assert.equal(resolveAgeBand(8), AGE_BAND.CHILD);
    assert.equal(resolveAgeBand(15), AGE_BAND.ADOLESCENT);
    assert.equal(resolveAgeBand(40), AGE_BAND.ADULT);
    assert.equal(resolveAgeBand(70), AGE_BAND.GERIATRIC);
    assert.equal(resolveAgeBand(84), AGE_BAND.ADVANCED_GERIATRIC);
  });

  it('treats unknown age as adult rather than guessing', () => {
    assert.equal(resolveAgeBand(undefined), AGE_BAND.ADULT);
    assert.equal(resolveAgeBand(-1), AGE_BAND.ADULT);
  });

  it('applies the APLS systolic floor formula for children', () => {
    assert.equal(paediatricSystolicFloor(3), 76);
    assert.equal(paediatricSystolicFloor(8), 86);
    assert.equal(thresholdsFor(AGE_BAND.TODDLER, 3).systolicBP.criticalLow, 76);
  });
});

describe('the same vitals produce different verdicts by age', () => {
  it('reads HR 150 as normal in an infant and severe tachycardia in an adult', () => {
    const infant = evaluateRules(ctx({ ageYears: 0.5, vitals: { heartRate: measured(150) } }));
    const adult = evaluateRules(ctx({ ageYears: 40, vitals: { heartRate: measured(150) } }));

    assert.ok(!codes(infant).includes('SEVERE_TACHYCARDIA'), 'HR 150 is within range for an infant');
    assert.ok(codes(adult).includes('SEVERE_TACHYCARDIA'));
    assert.equal(adult.esi, ESI.EMERGENT);
  });

  it('reads RR 40 as normal in a neonate and critical in an adult', () => {
    const neonate = evaluateRules(ctx({ ageYears: 14 / 365, vitals: { respiratoryRate: measured(40) } }));
    const adult = evaluateRules(ctx({ ageYears: 40, vitals: { respiratoryRate: measured(40) } }));

    assert.ok(!codes(neonate).includes('SEVERE_TACHYPNOEA'), 'RR 40 is normal for a neonate');
    assert.ok(codes(adult).includes('SEVERE_TACHYPNOEA'));
  });

  it('reads SBP 108 as unremarkable in an adult and as shock in a hypertensive 78-year-old', () => {
    const adult = evaluateRules(ctx({ ageYears: 40, vitals: { systolicBP: measured(108) } }));
    assert.ok(!codes(adult).includes('HYPOTENSION'));
    assert.ok(!codes(adult).includes('RELATIVE_HYPOTENSION'));

    const geriatric = evaluateRules(
      ctx({
        ageYears: 78,
        vitals: { systolicBP: measured(108) },
        baselines: { systolicBP: 155 },
        hasPriorRecord: true,
      }),
    );
    assert.ok(codes(geriatric).includes('RELATIVE_HYPOTENSION'));
    assert.equal(geriatric.esi, ESI.EMERGENT);
    assert.equal(geriatric.hardRedFlag, true);
  });
});

describe('paediatric safety rules', () => {
  it('escalates any fever under 3 months even when the infant looks well', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 6 / 52,
        vitals: { temperatureC: measured(38.2), heartRate: measured(150) },
        cues: { playfulAndConsolable: true },
        symptoms: [SYMPTOM.FEVER, SYMPTOM.POOR_FEEDING],
      }),
    );

    assert.ok(codes(result).includes('INFANT_FEVER_UNDER_3_MONTHS'));
    assert.equal(result.esi, ESI.EMERGENT);
    assert.equal(result.hardRedFlag, true, 'the model must not be able to talk this down');
  });

  it('does not over-call a well, well-perfused 3-year-old with the same fever', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 3,
        vitals: {
          temperatureC: measured(38.5),
          heartRate: measured(120),
          respiratoryRate: measured(28),
          capillaryRefillSec: measured(2),
        },
        cues: { playfulAndConsolable: true },
        symptoms: [SYMPTOM.FEVER],
      }),
    );

    assert.equal(result.esi, ESI.URGENT, 'fever alone in a well toddler is urgent, not emergent');
    assert.ok(!codes(result).includes('INFANT_FEVER_UNDER_3_MONTHS'));
  });

  it('catches compensated shock in a child whose blood pressure is still normal', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 3,
        vitals: {
          heartRate: measured(165),
          systolicBP: measured(95),
          capillaryRefillSec: measured(4),
        },
      }),
    );

    assert.ok(codes(result).includes('PAEDIATRIC_COMPENSATED_SHOCK'));
    assert.ok(!codes(result).includes('HYPOTENSION'), 'BP is still normal — that is the point');
    assert.equal(result.esi, ESI.EMERGENT);
  });

  it('floors every neonate at emergent regardless of presentation', () => {
    const result = evaluateRules(
      ctx({ ageYears: 10 / 365, vitals: { heartRate: measured(140), temperatureC: measured(37.0) } }),
    );
    assert.ok(codes(result).includes('NEONATE_PRESENTATION'));
    assert.equal(result.esi, ESI.EMERGENT);
  });
});

describe('geriatric safety rules', () => {
  it('treats hypothermia as a sepsis flag rather than as reassurance', () => {
    const result = evaluateRules(
      ctx({ ageYears: 79, vitals: { temperatureC: measured(35.6) }, symptoms: [SYMPTOM.MALAISE] }),
    );
    assert.ok(codes(result).includes('GERIATRIC_HYPOTHERMIA'));
    assert.equal(result.esi, ESI.EMERGENT);
  });

  it('escalates a fall on anticoagulation despite a normal conscious level', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 71,
        vitals: { gcs: measured(15), heartRate: measured(78), systolicBP: measured(138) },
        symptoms: [SYMPTOM.FALL, SYMPTOM.HEAD_INJURY],
        medications: [{ name: 'warfarin', isAnticoagulant: true }],
      }),
    );

    assert.ok(codes(result).includes('ANTICOAGULATED_HEAD_INJURY'));
    assert.equal(result.esi, ESI.EMERGENT);
    assert.equal(result.hardRedFlag, true);
  });

  it('escalates an atypical cardiac presentation in a diabetic with no chest pain', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 52,
        vitals: { heartRate: measured(92), systolicBP: measured(142) },
        symptoms: [SYMPTOM.INDIGESTION, SYMPTOM.SWEATING, SYMPTOM.NAUSEA],
        conditions: [RISK_CONDITION.DIABETES],
      }),
    );

    assert.ok(codes(result).includes('ATYPICAL_CARDIAC_PRESENTATION'));
    assert.equal(result.esi, ESI.EMERGENT);
  });

  it('does not fire the atypical cardiac rule for a young patient without risk factors', () => {
    const result = evaluateRules(
      ctx({ ageYears: 22, symptoms: [SYMPTOM.FATIGUE, SYMPTOM.NAUSEA] }),
    );
    assert.ok(!codes(result).includes('ATYPICAL_CARDIAC_PRESENTATION'));
  });

  it('flags hypotension without tachycardia in a beta-blocked patient', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 68,
        vitals: { systolicBP: measured(96), heartRate: measured(72) },
        medications: [{ name: 'metoprolol', isBetaBlocker: true }],
      }),
    );

    assert.ok(codes(result).includes('BETA_BLOCKER_MASKED_SHOCK'));
    assert.equal(result.hardRedFlag, true);
  });
});

describe('baseline-aware interpretation', () => {
  it('does not cry wolf over a COPD patient sitting at their own baseline saturation', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 67,
        vitals: { spo2: measured(89) },
        baselines: { spo2: 90 },
        hasPriorRecord: true,
        conditions: [RISK_CONDITION.COPD],
      }),
    );

    const hypoxia = result.firedRules.find((r) => r.code === 'HYPOXIA');
    assert.ok(hypoxia, 'it should still be noted');
    assert.equal(hypoxia.impliedESI, ESI.URGENT, 'but not treated as emergent');
  });

  it('treats the same saturation as emergent when no baseline is on file', () => {
    const result = evaluateRules(ctx({ ageYears: 67, vitals: { spo2: measured(89) } }));
    const hypoxia = result.firedRules.find((r) => r.code === 'HYPOXIA');
    assert.equal(hypoxia.impliedESI, ESI.EMERGENT);
  });
});

describe('under-reporting and ambiguity', () => {
  it('escalates when reported pain contradicts observed distress', () => {
    const withoutCues = evaluateRules(
      ctx({ ageYears: 34, vitals: { painScore: selfReported(3), heartRate: measured(118) } }),
    );

    const withCues = evaluateRules(
      ctx({
        ageYears: 34,
        vitals: { painScore: selfReported(3), heartRate: measured(118) },
        cues: { guarding: true, diaphoresis: true },
        symptoms: [SYMPTOM.ABDOMINAL_PAIN],
      }),
    );

    assert.ok(!codes(withoutCues).includes('PAIN_DISCORDANCE'));
    assert.ok(codes(withCues).includes('PAIN_DISCORDANCE'));
    assert.ok(withCues.esi < withoutCues.esi, 'the discordance should make it more urgent');
  });

  it('never lets a modifier escalate all the way to resuscitation', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 34,
        vitals: { painScore: selfReported(2), heartRate: measured(140) },
        cues: { guarding: true, diaphoresis: true, pallor: true },
      }),
    );

    assert.ok(result.esi >= ESI.EMERGENT, 'ESI 1 must be a positive finding, not a sum of soft signals');
  });
});

describe('missing data behaves conservatively', () => {
  it('refuses to clear a patient with no vitals recorded', () => {
    const result = evaluateRules(ctx({ ageYears: 30, symptoms: [SYMPTOM.SORE_THROAT] }));
    assert.ok(codes(result).includes('NO_VITALS_RECORDED'));
    assert.equal(result.esi, ESI.URGENT);
  });

  it('imposes no floor when nothing fires, rather than asserting non-urgency', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 19,
        vitals: {
          heartRate: measured(72),
          respiratoryRate: measured(16),
          systolicBP: measured(118),
          spo2: measured(99),
          temperatureC: measured(36.8),
          painScore: selfReported(2),
        },
        symptoms: [SYMPTOM.SORE_THROAT],
      }),
    );

    assert.equal(result.esi, ESI.NON_URGENT);
    assert.equal(result.floorImposed, false, 'a floor of 5 means "no constraint", not "non-urgent"');
    assert.equal(result.firedRules.length, 0);
  });

  it('escalates proxy-only history with nothing measured', () => {
    const result = evaluateRules(
      ctx({ ageYears: 84, symptoms: [SYMPTOM.CONFUSION], viaProxy: true }),
    );
    assert.ok(codes(result).includes('UNRELIABLE_HISTORY'));
  });
});

describe('critical presentations reach resuscitation', () => {
  it('flags an unresponsive patient with a depressed respiratory rate', () => {
    const result = evaluateRules(
      ctx({ ageYears: 38, vitals: { gcs: measured(6), respiratoryRate: measured(7) } }),
    );

    assert.equal(result.esi, ESI.RESUSCITATION);
    assert.ok(codes(result).includes('UNRESPONSIVE'));
    assert.ok(codes(result).includes('APNOEA_OR_BRADYPNOEA'));
    assert.equal(result.hardRedFlag, true);
  });

  it('flags severe hypoxia', () => {
    const result = evaluateRules(ctx({ ageYears: 55, vitals: { spo2: measured(82) } }));
    assert.equal(result.esi, ESI.RESUSCITATION);
  });

  it('sorts fired rules most urgent first so the nurse reads the worst thing first', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 60,
        vitals: { spo2: measured(83), temperatureC: measured(38.3) },
        symptoms: [SYMPTOM.FEVER, SYMPTOM.COUGH],
      }),
    );

    assert.equal(result.firedRules[0].impliedESI, ESI.RESUSCITATION);
    assert.ok(result.firedRules.length > 1);
  });
});

describe('stroke and time-critical presentations', () => {
  it('escalates FAST-positive symptoms even with normal vitals', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 66,
        vitals: {
          heartRate: measured(82),
          systolicBP: measured(140),
          spo2: measured(97),
          gcs: measured(15),
        },
        symptoms: [SYMPTOM.FACIAL_DROOP, SYMPTOM.SPEECH_DIFFICULTY],
      }),
    );

    assert.ok(codes(result).includes('STROKE_SYMPTOMS'));
    assert.equal(result.esi, ESI.EMERGENT);
    assert.equal(result.hardRedFlag, true);
  });
});

describe('every fired rule explains itself', () => {
  it('carries a rationale and evidence a nurse can check at a glance', () => {
    const result = evaluateRules(
      ctx({
        ageYears: 78,
        vitals: { systolicBP: measured(108), heartRate: measured(96), temperatureC: measured(36.1) },
        baselines: { systolicBP: 155 },
        hasPriorRecord: true,
        symptoms: [SYMPTOM.MALAISE],
      }),
    );

    assert.ok(result.firedRules.length > 0);
    for (const rule of result.firedRules) {
      assert.ok(rule.rationale?.length > 10, `${rule.code} needs a rationale`);
      assert.ok(rule.evidence?.length > 0, `${rule.code} needs evidence`);
      assert.ok(rule.label?.length > 0, `${rule.code} needs a label`);
    }
  });
});
