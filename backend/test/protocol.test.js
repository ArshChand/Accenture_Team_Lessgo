import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PROTOCOL_GUARDRAILS,
  getDefaultProtocol,
  loadProtocol,
  paediatricSystolicFloorWith,
  resolveAgeBandWith,
  resolveProtocol,
  safeWaitMinutesWith,
  thresholdsWith,
  validateProtocol,
} from '../src/clinical/protocol.js';
import { AGE_BAND, AGE_BAND_RANGES, ESI, resolveAgeBand } from '../src/clinical/constants.js';
import { buildRuleContext, evaluateRules } from '../src/clinical/rules.js';
import { measured } from '../src/clinical/observation.js';
import { loadBundledProtocol, listBundledProtocols } from '../src/services/protocolService.js';

/**
 * Site configurability is a scalability feature and a safety risk at the same
 * time. These tests hold both sides: that a hospital really can change what the
 * assistant reasons with, and that it cannot use that freedom to switch safety off.
 */

const codes = (result) => result.firedRules.map((r) => r.code);

const ctxFor = (protocol, { ageYears, vitals = {}, symptoms = [], medications = [], conditions = [] }) =>
  buildRuleContext({
    encounter: {
      age: { ageYears, band: resolveAgeBandWith(protocol, ageYears) },
      intake: { extraction: { symptoms } },
    },
    patient: { medications, chronicConditions: conditions },
    vitals,
    protocol,
  });

describe('protocol resolution', () => {
  it('inherits everything a site does not override', () => {
    const resolved = resolveProtocol({ siteId: 'tiny', safeWaitMinutes: { 3: 45 } });

    assert.equal(resolved.safeWaitMinutes['3'], 45, 'the override applies');
    assert.equal(resolved.safeWaitMinutes['2'], 10, 'unspecified levels are inherited');
    assert.equal(
      resolved.vitalThresholds.geriatric.temperatureC.fever,
      37.8,
      'a site that says nothing about vitals still gets the reference table',
    );
  });

  it('merges deeply so a site can override a single threshold', () => {
    const resolved = resolveProtocol({
      vitalThresholds: { geriatric: { temperatureC: { fever: 37.5 } } },
    });

    assert.equal(resolved.vitalThresholds.geriatric.temperatureC.fever, 37.5);
    assert.equal(
      resolved.vitalThresholds.geriatric.temperatureC.hypothermic,
      36.0,
      'sibling thresholds survive a targeted override',
    );
    assert.equal(resolved.vitalThresholds.adult.temperatureC.fever, 38.0, 'other bands are untouched');
  });

  it('never mutates the reference protocol', () => {
    const before = getDefaultProtocol();
    resolveProtocol({ safeWaitMinutes: { 3: 5 } });
    const after = getDefaultProtocol();
    assert.deepEqual(before, after);
  });

  it('agrees with the age band table compiled into the code', () => {
    const protocol = getDefaultProtocol();
    for (const sample of [0.01, 0.5, 3, 8, 15, 40, 70, 90]) {
      assert.equal(
        resolveAgeBandWith(protocol, sample),
        resolveAgeBand(sample),
        `band disagreement at age ${sample} — the JSON protocol and the constants have drifted`,
      );
    }
    assert.equal(protocol.ageBands.length, AGE_BAND_RANGES.length);
  });
});

describe('protocol validation rejects unsafe configuration', () => {
  it('accepts every bundled protocol', () => {
    for (const name of listBundledProtocols()) {
      const document = loadBundledProtocol(name);
      const overrides = name === 'default' ? {} : document;
      assert.doesNotThrow(() => loadProtocol(overrides), `bundled protocol "${name}" should be valid`);
    }
  });

  it('refuses a safe wait longer than the guardrail allows', () => {
    const { valid, errors } = validateProtocol(resolveProtocol({ safeWaitMinutes: { 2: 60 } }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('ESI 2')));
    assert.throws(() => loadProtocol({ safeWaitMinutes: { 2: 60 } }), /ProtocolValidationError|invalid/);
  });

  it('refuses to let uncertainty escalate straight to resuscitation', () => {
    const { valid, errors } = validateProtocol(
      resolveProtocol({ confidence: { escalationFloorESI: 1 } }),
    );
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('escalationFloorESI')));
  });

  it('refuses to disable a rule that prevents a fatal miss', () => {
    for (const code of PROTOCOL_GUARDRAILS.nonDisableableRules) {
      const { valid } = validateProtocol(
        resolveProtocol({ ruleOverrides: [{ code, enabled: false }] }),
      );
      assert.equal(valid, false, `${code} must not be disableable`);
    }
  });

  it('refuses inverted threshold ordering', () => {
    const { valid, errors } = validateProtocol(
      resolveProtocol({
        vitalThresholds: { adult: { heartRate: { criticalLow: 40, low: 60, high: 50, criticalHigh: 130 } } },
      }),
    );
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('heartRate')));
  });

  it('refuses confidence weights that do not sum to 1', () => {
    const { valid, errors } = validateProtocol(
      resolveProtocol({ confidence: { weights: { completeness: 0.9, modelMargin: 0.9 } } }),
    );
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('sum to 1')));
  });

  it('refuses age bands that leave a gap a patient could fall through', () => {
    const { valid, errors } = validateProtocol(
      resolveProtocol({
        ageBands: [
          { band: AGE_BAND.ADULT, minYears: 0, maxYears: 60 },
          { band: AGE_BAND.GERIATRIC, minYears: 65, maxYears: null },
        ],
      }),
    );
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('tile without gaps')));
  });

  it('requires the oldest band to be open-ended', () => {
    const { valid, errors } = validateProtocol(
      resolveProtocol({
        ageBands: [
          { band: AGE_BAND.ADULT, minYears: 0, maxYears: 65 },
          { band: AGE_BAND.GERIATRIC, minYears: 65, maxYears: 120 },
        ],
      }),
    );
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('maxYears: null')));
  });
});

describe('sites really do behave differently', () => {
  const reference = loadProtocol({});
  const rural = loadProtocol(loadBundledProtocol('rural-chc'));
  const paediatric = loadProtocol(loadBundledProtocol('paediatric-tertiary'));

  it('gives the same ESI 3 patient different safe waits by site', () => {
    assert.equal(safeWaitMinutesWith(reference, ESI.URGENT), 30);
    assert.equal(safeWaitMinutesWith(rural, ESI.URGENT), 45);
    assert.equal(safeWaitMinutesWith(paediatric, ESI.URGENT), 20);
  });

  it('escalates a deranged vital sign at the rural centre that the reference site calls urgent', () => {
    const patient = { ageYears: 45, vitals: { heartRate: measured(112) } };

    const atReference = evaluateRules(ctxFor(reference, patient));
    const atRural = evaluateRules(ctxFor(rural, patient));

    const refRule = atReference.firedRules.find((r) => r.code === 'ABNORMAL_VITAL_SIGN');
    const ruralRule = atRural.firedRules.find((r) => r.code === 'ABNORMAL_VITAL_SIGN');

    assert.equal(refRule.impliedESI, ESI.URGENT);
    assert.equal(ruralRule.impliedESI, ESI.EMERGENT, 'one clinician, no monitoring bay');
    assert.ok(atRural.esi < atReference.esi);
  });

  it('lets a site disable a rule that is out of scope for its specialty', () => {
    const patient = {
      ageYears: 52,
      vitals: { heartRate: measured(92) },
      symptoms: ['indigestion', 'sweating'],
      conditions: ['diabetes'],
    };

    // The paediatric hospital disables the adult ischaemia rule; the reference does not.
    assert.ok(codes(evaluateRules(ctxFor(reference, patient))).includes('ATYPICAL_CARDIAC_PRESENTATION'));
    assert.ok(!codes(evaluateRules(ctxFor(paediatric, patient))).includes('ATYPICAL_CARDIAC_PRESENTATION'));
  });

  it('applies a site override even when the rule reached a milder conclusion itself', () => {
    // A COPD-style saturation the reference protocol would call urgent. The rural
    // centre has no ventilator and a 90-minute transfer, so it escalates anyway.
    const patient = { ageYears: 67, vitals: { spo2: measured(89) } };

    const refHypoxia = evaluateRules(ctxFor(reference, patient)).firedRules.find((r) => r.code === 'HYPOXIA');
    const ruralHypoxia = evaluateRules(ctxFor(rural, patient)).firedRules.find((r) => r.code === 'HYPOXIA');

    assert.equal(refHypoxia.impliedESI, ESI.EMERGENT);
    assert.equal(ruralHypoxia.impliedESI, ESI.EMERGENT);
  });

  it('reports thinner model coverage where a site has less local data', () => {
    assert.ok(rural.modelSupportByBand.adult < reference.modelSupportByBand.adult);
    assert.ok(paediatric.modelSupportByBand.toddler > reference.modelSupportByBand.toddler);
    assert.ok(paediatric.modelSupportByBand.geriatric < reference.modelSupportByBand.geriatric);
  });
});

describe('site overrides may escalate but never soften', () => {
  it('takes the more urgent of the rule and the site override', () => {
    const softened = loadProtocol({
      ruleOverrides: [{ code: 'SEVERE_PAIN', impliedESI: ESI.NON_URGENT }],
    });

    const result = evaluateRules(
      ctxFor(softened, { ageYears: 40, vitals: { painScore: { value: 9, source: 'patient_reported', reliability: 0.6 } } }),
    );

    const rule = result.firedRules.find((r) => r.code === 'SEVERE_PAIN');
    assert.equal(
      rule.impliedESI,
      ESI.EMERGENT,
      'an attempt to soften a rule through configuration has no effect',
    );
  });

  it('honours an override that makes a rule more urgent', () => {
    const strengthened = loadProtocol({
      ruleOverrides: [{ code: 'MODERATE_PAIN', impliedESI: ESI.EMERGENT }],
    });

    const result = evaluateRules(
      ctxFor(strengthened, { ageYears: 40, vitals: { painScore: { value: 5, source: 'patient_reported', reliability: 0.6 } } }),
    );

    assert.equal(result.firedRules.find((r) => r.code === 'MODERATE_PAIN').impliedESI, ESI.EMERGENT);
  });
});

describe('protocol-driven paediatric thresholds', () => {
  it('computes the systolic floor from the configured formula', () => {
    const protocol = getDefaultProtocol();
    assert.equal(paediatricSystolicFloorWith(protocol, 3), 76);
    assert.equal(thresholdsWith(protocol, AGE_BAND.TODDLER, 3).systolicBP.criticalLow, 76);
  });

  it('lets a site change the formula coefficients rather than the code', () => {
    const custom = loadProtocol({
      paediatricSystolicFormula: { intercept: 75, slopePerYear: 2.5 },
    });
    assert.equal(paediatricSystolicFloorWith(custom, 4), 85);
  });

  it('falls back to the band table when the formula is switched off', () => {
    const noFormula = loadProtocol({ paediatricSystolicFormula: { enabled: false } });
    assert.equal(thresholdsWith(noFormula, AGE_BAND.TODDLER, 3).systolicBP.criticalLow, 72);
  });
});
