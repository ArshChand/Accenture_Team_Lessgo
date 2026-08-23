import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildExplainFlags, fuse } from '../src/clinical/fusion.js';
import { computeConfidence } from '../src/clinical/confidence.js';
import { CONFIDENCE_BAND, ESI } from '../src/clinical/constants.js';
import { getDefaultProtocol, loadProtocol } from '../src/clinical/protocol.js';
import { measured, nlpObservation, proxyReported } from '../src/clinical/observation.js';

const protocol = getDefaultProtocol();

const rules = (esi, { firedRules = [], hardRedFlag = false } = {}) => ({
  esi,
  floorImposed: esi < ESI.NON_URGENT,
  firedRules,
  hardRedFlag,
});

const model = (esi, probabilities = [0.1, 0.2, 0.4, 0.2, 0.1]) => ({
  esi,
  classProbabilities: probabilities,
  topContributions: [],
});

const confident = { score: 0.9, band: CONFIDENCE_BAND.HIGH, drivers: [] };
const unsure = { score: 0.4, band: CONFIDENCE_BAND.LOW, drivers: ['No oxygen saturation recorded'] };

describe('fusion: the escalation-only invariant', () => {
  it('never returns a less urgent score than either layer concluded', () => {
    // Exhaustive over every combination of inputs the system can produce.
    for (let ruleESI = 1; ruleESI <= 5; ruleESI += 1) {
      for (let modelESI = 1; modelESI <= 5; modelESI += 1) {
        for (const confidence of [confident, unsure]) {
          for (const surgeActive of [false, true]) {
            const result = fuse({
              ruleResult: rules(ruleESI),
              modelResult: model(modelESI),
              confidence,
              protocol,
              surgeActive,
            });

            assert.ok(
              result.finalESI <= Math.min(ruleESI, modelESI),
              `rules=${ruleESI} model=${modelESI} confidence=${confidence.score} surge=${surgeActive} ` +
                `produced ESI ${result.finalESI}, which is less urgent than min(${ruleESI}, ${modelESI})`,
            );
            assert.ok(result.finalESI >= 1 && result.finalESI <= 5);
          }
        }
      }
    }
  });

  it('takes the rule floor when the rules are more urgent than the model', () => {
    const result = fuse({
      ruleResult: rules(ESI.EMERGENT),
      modelResult: model(ESI.LESS_URGENT),
      confidence: confident,
      protocol,
    });
    assert.equal(result.finalESI, ESI.EMERGENT);
    assert.equal(result.decidedBy, 'rule_engine');
  });

  it('takes the model when the model is more urgent than the rules', () => {
    const result = fuse({
      ruleResult: rules(ESI.URGENT),
      modelResult: model(ESI.EMERGENT),
      confidence: confident,
      protocol,
    });
    assert.equal(result.finalESI, ESI.EMERGENT);
    assert.equal(result.decidedBy, 'model');
  });
});

describe('fusion: hard red flags outrank the model', () => {
  const redFlag = {
    code: 'INFANT_FEVER_UNDER_3_MONTHS',
    label: 'Fever in an infant under 3 months',
    impliedESI: ESI.EMERGENT,
    severity: 'critical',
    hardRedFlag: true,
    evidence: 'Temperature 38.2°C at 6 weeks',
    rationale: 'Any fever under 3 months mandates a full septic screen.',
  };

  it('holds the score at the red flag level even when the model says the patient is fine', () => {
    const result = fuse({
      ruleResult: rules(ESI.EMERGENT, { firedRules: [redFlag], hardRedFlag: true }),
      // The model, seeing a well-looking baby, says non-urgent.
      modelResult: model(ESI.NON_URGENT, [0.01, 0.04, 0.1, 0.25, 0.6]),
      confidence: confident,
      protocol,
    });

    assert.equal(result.finalESI, ESI.EMERGENT, 'the model must not be able to talk a red flag down');
    assert.equal(result.redFlagLocked, true);
    assert.deepEqual(result.hardRedFlagCodes, ['INFANT_FEVER_UNDER_3_MONTHS']);
  });

  it('still lets the model escalate past a red flag', () => {
    const result = fuse({
      ruleResult: rules(ESI.EMERGENT, { firedRules: [redFlag], hardRedFlag: true }),
      modelResult: model(ESI.RESUSCITATION, [0.7, 0.2, 0.05, 0.03, 0.02]),
      confidence: confident,
      protocol,
    });

    assert.equal(result.finalESI, ESI.RESUSCITATION, 'a red flag is a floor, not a ceiling');
    assert.equal(result.redFlagLocked, false, 'the model was more urgent, so nothing was locked out');
  });

  it('surfaces the lock to the nurse as an explicit flag', () => {
    const fusion = fuse({
      ruleResult: rules(ESI.EMERGENT, { firedRules: [redFlag], hardRedFlag: true }),
      modelResult: model(ESI.NON_URGENT, [0.01, 0.04, 0.1, 0.25, 0.6]),
      confidence: confident,
      protocol,
    });

    const flags = buildExplainFlags({
      ruleResult: rules(ESI.EMERGENT, { firedRules: [redFlag], hardRedFlag: true }),
      modelResult: model(ESI.NON_URGENT),
      confidence: confident,
      fusion,
    });

    assert.ok(flags.some((f) => f.code === 'RED_FLAG_LOCKED'));
    assert.equal(flags[0].code, 'INFANT_FEVER_UNDER_3_MONTHS', 'the red flag reads first');
  });
});

describe('fusion: uncertainty escalates', () => {
  it('escalates one level when confidence is below the threshold', () => {
    const result = fuse({
      ruleResult: rules(ESI.NON_URGENT),
      modelResult: model(ESI.URGENT),
      confidence: unsure,
      protocol,
    });

    assert.equal(result.finalESI, ESI.EMERGENT);
    assert.equal(result.ratchetApplied, true);
    assert.match(result.escalationReason, /Confidence 0\.40 is below/);
    assert.match(result.escalationReason, /No oxygen saturation recorded/);
  });

  it('never escalates uncertainty all the way to resuscitation', () => {
    for (const startingESI of [2, 3, 4, 5]) {
      const result = fuse({
        ruleResult: rules(startingESI),
        modelResult: model(startingESI),
        confidence: { score: 0.05, band: CONFIDENCE_BAND.LOW, drivers: [] },
        protocol,
      });
      assert.ok(
        result.finalESI >= ESI.EMERGENT,
        'ESI 1 must be a positive finding, never the product of not knowing',
      );
    }
  });

  it('leaves confident assessments alone', () => {
    const result = fuse({
      ruleResult: rules(ESI.LESS_URGENT),
      modelResult: model(ESI.LESS_URGENT),
      confidence: confident,
      protocol,
    });
    assert.equal(result.finalESI, ESI.LESS_URGENT);
    assert.equal(result.ratchetApplied, false);
  });

  it('widens the escalation threshold under surge', () => {
    // 0.60 clears the standard threshold of 0.55 but not the surge threshold of 0.62.
    const borderline = { score: 0.6, band: CONFIDENCE_BAND.MODERATE, drivers: [] };

    const quiet = fuse({
      ruleResult: rules(ESI.NON_URGENT),
      modelResult: model(ESI.URGENT),
      confidence: borderline,
      protocol,
      surgeActive: false,
    });
    const surge = fuse({
      ruleResult: rules(ESI.NON_URGENT),
      modelResult: model(ESI.URGENT),
      confidence: borderline,
      protocol,
      surgeActive: true,
    });

    assert.equal(quiet.ratchetApplied, false);
    assert.equal(surge.ratchetApplied, true, 'less nurse attention per patient means escalate sooner');
    assert.ok(surge.finalESI < quiet.finalESI);
  });

  it('honours a site that sets its own escalation floor', () => {
    const cautious = loadProtocol({ confidence: { escalationFloorESI: 3 } });
    const result = fuse({
      ruleResult: rules(ESI.NON_URGENT),
      modelResult: model(ESI.LESS_URGENT),
      confidence: unsure,
      protocol: cautious,
    });
    assert.ok(result.finalESI >= 3);
  });
});

describe('fusion consumes the model point estimate, not its pre-escalated answer', () => {
  /** The shape the ML service actually returns: both answers, plus probabilities. */
  const mlResponse = (escalated, mostLikely) => ({
    esi: escalated,
    mostLikelyESI: mostLikely,
    classProbabilities: [0.05, 0.25, 0.3, 0.3, 0.1],
    topContributions: [],
  });

  it('ignores the model’s own escalation by default, so escalation is not applied three times', () => {
    // The model most likely says 3 but escalated itself to 2. The rules impose no
    // floor. Fusing on the escalated answer would hand back 2 having already
    // escalated once inside the model, once here if the rules had fired, and
    // again if confidence were low — compressing the board.
    const result = fuse({
      ruleResult: rules(ESI.NON_URGENT),
      modelResult: mlResponse(ESI.EMERGENT, ESI.URGENT),
      confidence: confident,
      protocol,
    });
    assert.equal(result.finalESI, ESI.URGENT);
    assert.equal(result.modelESI, ESI.URGENT);
  });

  it('honours the model’s escalation when a site opts in', () => {
    const modelLed = loadProtocol({ confidence: { useModelEscalation: true } });
    const result = fuse({
      ruleResult: rules(ESI.NON_URGENT),
      modelResult: mlResponse(ESI.EMERGENT, ESI.URGENT),
      confidence: confident,
      protocol: modelLed,
    });
    assert.equal(result.finalESI, ESI.EMERGENT);
  });

  it('still escalates through the ratchet when confidence is low', () => {
    // Dropping the model's internal escalation must not cost the safety net that
    // this layer owns.
    const result = fuse({
      ruleResult: rules(ESI.NON_URGENT),
      modelResult: mlResponse(ESI.EMERGENT, ESI.URGENT),
      confidence: unsure,
      protocol,
    });
    assert.equal(result.finalESI, ESI.EMERGENT);
    assert.equal(result.ratchetApplied, true);
  });

  it('still floors at a hard red flag regardless of which model answer is used', () => {
    const result = fuse({
      ruleResult: rules(ESI.EMERGENT, { hardRedFlag: true, firedRules: [{ code: 'X', hardRedFlag: true }] }),
      modelResult: mlResponse(ESI.LESS_URGENT, ESI.NON_URGENT),
      confidence: confident,
      protocol,
    });
    assert.equal(result.finalESI, ESI.EMERGENT);
    assert.equal(result.redFlagLocked, true);
  });

  it('falls back to the escalated answer if a model omits the point estimate', () => {
    const result = fuse({
      ruleResult: rules(ESI.NON_URGENT),
      modelResult: { esi: ESI.URGENT, classProbabilities: [], topContributions: [] },
      confidence: confident,
      protocol,
    });
    assert.equal(result.finalESI, ESI.URGENT);
  });
});

describe('fusion: a missing model is not a vote for low acuity', () => {
  it('falls back to the rule floor when the model is unavailable', () => {
    const result = fuse({
      ruleResult: rules(ESI.EMERGENT),
      modelResult: null,
      confidence: confident,
      protocol,
    });

    assert.equal(result.finalESI, ESI.EMERGENT);
    assert.equal(result.modelESI, null);
    assert.equal(result.decidedBy, 'rules_only');
  });

  it('does not treat silence from the model as ESI 5', () => {
    const withModel = fuse({
      ruleResult: rules(ESI.URGENT),
      modelResult: model(ESI.URGENT),
      confidence: confident,
      protocol,
    });
    const withoutModel = fuse({
      ruleResult: rules(ESI.URGENT),
      modelResult: null,
      confidence: confident,
      protocol,
    });

    assert.equal(withoutModel.finalESI, withModel.finalESI);
  });
});

describe('confidence composite', () => {
  const fullVitals = {
    heartRate: measured(78),
    respiratoryRate: measured(16),
    systolicBP: measured(124),
    spo2: measured(98),
    temperatureC: measured(36.8),
    gcs: measured(15),
  };

  const encounterWith = (symptoms = ['chest_pain']) => ({
    age: { ageYears: 45, band: 'adult' },
    intake: { extraction: { symptoms, extractionConfidence: 0.9 }, transcripts: [] },
  });

  it('scores a fully measured patient with a decisive model as high confidence', () => {
    const result = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: true, baselines: { systolicBP: 130 } },
      vitals: fullVitals,
      classProbabilities: [0.02, 0.9, 0.05, 0.02, 0.01],
      ageBand: 'adult',
    });

    assert.equal(result.band, CONFIDENCE_BAND.HIGH);
    assert.ok(result.score > 0.75);
    assert.deepEqual(result.drivers, [], 'nothing to explain when everything is present');
  });

  it('drops confidence when nothing has been measured, and says why', () => {
    const result = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: false },
      vitals: {},
      classProbabilities: [0.2, 0.2, 0.25, 0.2, 0.15],
      ageBand: 'adult',
    });

    assert.equal(result.band, CONFIDENCE_BAND.LOW);
    assert.ok(result.drivers.some((d) => d.includes('oxygen saturation')));
    assert.ok(result.drivers.some((d) => d.includes('prior medical record')));
  });

  it('penalises an indecisive model even with complete data', () => {
    const decisive = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: true, baselines: { systolicBP: 130 } },
      vitals: fullVitals,
      classProbabilities: [0.02, 0.92, 0.03, 0.02, 0.01],
      ageBand: 'adult',
    });
    const undecided = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: true, baselines: { systolicBP: 130 } },
      vitals: fullVitals,
      classProbabilities: [0.19, 0.21, 0.2, 0.2, 0.2],
      ageBand: 'adult',
    });

    assert.ok(undecided.score < decisive.score);
    assert.ok(undecided.drivers.some((d) => d.includes('undecided')));
  });

  it('weighs provenance: the same numbers relayed by an attendant are trusted less', () => {
    const measuredVitals = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: true, baselines: { systolicBP: 130 } },
      vitals: fullVitals,
      classProbabilities: [0.02, 0.9, 0.05, 0.02, 0.01],
      ageBand: 'adult',
    });

    const relayed = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: true, baselines: { systolicBP: 130 } },
      vitals: {
        heartRate: proxyReported(78),
        respiratoryRate: proxyReported(16),
        systolicBP: proxyReported(124),
        spo2: proxyReported(98),
        temperatureC: proxyReported(36.8),
        gcs: proxyReported(15),
      },
      classProbabilities: [0.02, 0.9, 0.05, 0.02, 0.01],
      ageBand: 'adult',
    });

    assert.ok(
      relayed.score < measuredVitals.score,
      'identical numbers, weaker provenance, lower confidence',
    );
    assert.ok(relayed.drivers.some((d) => d.startsWith('Low reliability')));
  });

  it('propagates poor speech recognition into low confidence', () => {
    const result = computeConfidence({
      protocol,
      encounter: {
        age: { ageYears: 60, band: 'adult' },
        intake: {
          extraction: { symptoms: ['abdominal_pain'], extractionConfidence: 0.63 },
          transcripts: [{ language: 'kn-IN', rawText: 'hotte novu', asrConfidence: 0.48 }],
        },
      },
      patient: { hasPriorRecord: false },
      vitals: { heartRate: measured(96), spo2: nlpObservation(97, { asrConfidence: 0.48, extractionConfidence: 0.63 }) },
      classProbabilities: [0.05, 0.25, 0.35, 0.25, 0.1],
      ageBand: 'adult',
    });

    assert.equal(result.band, CONFIDENCE_BAND.LOW);
    assert.ok(result.drivers.some((d) => d.includes('what the patient said')));
  });

  it('reports thin training coverage for an age band honestly', () => {
    const adult = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: true, baselines: { systolicBP: 130 } },
      vitals: fullVitals,
      classProbabilities: [0.02, 0.9, 0.05, 0.02, 0.01],
      ageBand: 'adult',
    });
    const neonate = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: true, baselines: { systolicBP: 130 } },
      vitals: fullVitals,
      classProbabilities: [0.02, 0.9, 0.05, 0.02, 0.01],
      ageBand: 'neonate',
    });

    assert.ok(neonate.score < adult.score);
    assert.ok(neonate.drivers.some((d) => d.includes('neonate')));
  });

  it('lowers confidence when the model is unavailable rather than pretending', () => {
    const result = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: { hasPriorRecord: true, baselines: { systolicBP: 130 } },
      vitals: fullVitals,
      modelUnavailable: true,
      ageBand: 'adult',
    });
    assert.ok(result.drivers.some((d) => d.includes('Risk model unavailable')));
  });

  it('always returns every component, so the score can be explained', () => {
    const result = computeConfidence({
      protocol,
      encounter: encounterWith(),
      patient: {},
      vitals: {},
      ageBand: 'adult',
    });

    for (const key of ['completeness', 'modelMargin', 'inputReliability', 'ageBandSupport']) {
      assert.ok(Number.isFinite(result.components[key]), `${key} must always be present`);
    }
  });
});

describe('explain flags are ordered for a nurse with seconds to read', () => {
  it('puts hard red flags first and model contributions last', () => {
    const ruleResult = rules(ESI.EMERGENT, {
      hardRedFlag: true,
      firedRules: [
        {
          code: 'FEVER_PRESENT',
          label: 'Fever',
          impliedESI: 3,
          severity: 'info',
          hardRedFlag: false,
          evidence: '38.2°C',
          rationale: 'Fever against the threshold for this age band.',
        },
        {
          code: 'INFANT_FEVER_UNDER_3_MONTHS',
          label: 'Fever in an infant under 3 months',
          impliedESI: 2,
          severity: 'critical',
          hardRedFlag: true,
          evidence: '38.2°C at 6 weeks',
          rationale: 'Mandates a full septic screen.',
        },
      ],
    });

    const modelResult = {
      esi: 3,
      classProbabilities: [0.05, 0.3, 0.4, 0.2, 0.05],
      topContributions: [
        { feature: 'temperature_c', label: 'Temperature', value: 38.2, contribution: 0.3, direction: 'toward_urgent' },
        { feature: 'age_years', label: 'Age', value: 0.11, contribution: -0.1, direction: 'toward_non_urgent' },
      ],
    };

    const fusion = fuse({ ruleResult, modelResult, confidence: unsure, protocol });
    const flags = buildExplainFlags({ ruleResult, modelResult, confidence: unsure, fusion });

    assert.equal(flags[0].code, 'INFANT_FEVER_UNDER_3_MONTHS');
    assert.ok(flags.findIndex((f) => f.source === 'rule') < flags.findIndex((f) => f.source === 'model'));
    assert.ok(!flags.some((f) => f.code === 'MODEL_AGE_YEARS'), 'reassuring contributions are not flags');
    assert.ok(flags.some((f) => f.code === 'LOW_CONFIDENCE'));
  });

  it('marks age-specific reasoning so a nurse can see why age changed the answer', () => {
    const ruleResult = rules(ESI.EMERGENT, {
      hardRedFlag: true,
      firedRules: [
        {
          code: 'PAEDIATRIC_COMPENSATED_SHOCK',
          label: 'Paediatric compensated shock',
          impliedESI: 2,
          severity: 'critical',
          hardRedFlag: true,
          ageBandSpecific: true,
          evidence: 'Cap refill 4s with HR 165',
          rationale: 'Children maintain blood pressure until they crash.',
        },
      ],
    });

    const flags = buildExplainFlags({
      ruleResult,
      modelResult: model(3),
      confidence: confident,
      fusion: fuse({ ruleResult, modelResult: model(3), confidence: confident, protocol }),
    });

    assert.equal(flags[0].ageBandSpecific, true);
  });
});
