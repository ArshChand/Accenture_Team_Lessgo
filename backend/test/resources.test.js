import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import { SYMPTOM } from '../src/clinical/symptoms.js';
import {
  DISPLAY_FLOOR,
  RECOMMENDATION_KIND,
  RESOURCE_CATALOGUE,
  RULE_RESOURCE_MAP,
  SHORTAGE_STATUS,
  SPECIALIST_BY_RULE,
  SYMPTOM_RESOURCE_MAP,
  buildRecommendations,
  buildShortageTable,
  forecastDemand,
  predictResources,
} from '../src/operations/resources.js';
import { adjustStock, resetInventory, restock, snapshot } from '../src/operations/inventory.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const likelihoodOf = (predictions, id) => predictions.find((p) => p.resourceId === id)?.likelihood ?? 0;

describe('resource prediction', () => {
  it('only references rule codes and symptoms that actually exist', () => {
    const rulesSource = readFileSync(join(SRC, 'clinical', 'rules.js'), 'utf8');
    const ruleCodes = new Set([...rulesSource.matchAll(/code: '([A-Z_0-9]+)'/g)].map((m) => m[1]));
    for (const code of [...Object.keys(RULE_RESOURCE_MAP), ...Object.keys(SPECIALIST_BY_RULE)]) {
      assert.ok(ruleCodes.has(code), `unknown rule code ${code}`);
    }
    const symptoms = new Set(Object.values(SYMPTOM));
    for (const symptom of Object.keys(SYMPTOM_RESOURCE_MAP)) {
      assert.ok(symptoms.has(symptom), `unknown symptom ${symptom}`);
    }
  });

  it('predicts oxygen for severe hypoxia and says why', () => {
    const predictions = predictResources({
      esi: 2,
      firedRules: [{ code: 'SEVERE_HYPOXIA', label: 'Severe hypoxia' }],
    });
    const oxygen = predictions.find((p) => p.resourceId === 'oxygen');
    assert.ok(oxygen.likelihood >= 0.9);
    assert.ok(oxygen.reasons.includes('Severe hypoxia'));
  });

  it('combines independent reasons without exceeding 1', () => {
    const one = predictResources({ esi: 3, firedRules: [{ code: 'HYPOTENSION' }] });
    const two = predictResources({
      esi: 3,
      firedRules: [{ code: 'HYPOTENSION' }, { code: 'SEPSIS_SCREEN_POSITIVE' }],
    });
    assert.ok(likelihoodOf(two, 'iv_fluids') > likelihoodOf(one, 'iv_fluids'));
    for (const prediction of two) assert.ok(prediction.likelihood > 0 && prediction.likelihood <= 1);
  });

  it('never claims certainty, however many findings agree', () => {
    const predictions = predictResources({
      esi: 1,
      firedRules: [{ code: 'UNRESPONSIVE' }, { code: 'APNOEA_OR_BRADYPNOEA' }, { code: 'SEVERE_HYPOXIA' }],
    });
    for (const prediction of predictions) assert.ok(prediction.likelihood <= 0.99);
  });

  it('sends ESI 1 to a resus bed and never double-counts a bed', () => {
    for (const esi of [1, 2, 3, 4, 5]) {
      const predictions = predictResources({ esi });
      const beds = likelihoodOf(predictions, 'resus_bed') + likelihoodOf(predictions, 'ed_bed');
      assert.ok(beds <= 1.0001, `ESI ${esi} bed likelihoods sum to ${beds}`);
    }
    const critical = predictResources({ esi: 1 });
    assert.ok(likelihoodOf(critical, 'resus_bed') > likelihoodOf(critical, 'ed_bed'));
  });

  it('predicts almost nothing for an ESI 5 patient with no findings', () => {
    const predictions = predictResources({ esi: 5 }).filter((p) => p.likelihood >= DISPLAY_FLOOR);
    assert.equal(predictions.length, 0);
  });

  it('sums likelihoods into expected demand and lists the likely patients', () => {
    const forecast = forecastDemand([
      { displayRef: 'P-1', predictions: [{ resourceId: 'oxygen', likelihood: 0.6 }] },
      { displayRef: 'P-2', predictions: [{ resourceId: 'oxygen', likelihood: 0.6 }] },
      { displayRef: 'P-3', predictions: [{ resourceId: 'oxygen', likelihood: 0.4 }] },
    ]);
    const oxygen = forecast.find((row) => row.resourceId === 'oxygen');
    assert.equal(oxygen.expectedDemand, 1.6);
    assert.deepEqual(oxygen.likelyPatients, ['P-1', 'P-2']);
    assert.equal(forecast.length, RESOURCE_CATALOGUE.length);
  });
});

describe('shortage table', () => {
  const forecastWith = (demand) =>
    RESOURCE_CATALOGUE.map((item) => ({ resourceId: item.id, expectedDemand: demand[item.id] ?? 0 }));

  it('marks short, tight, ok and unknown correctly', () => {
    const table = buildShortageTable(
      [
        { resourceId: 'oxygen', available: 2 },
        { resourceId: 'cardiac_monitor', available: 8 },
        { resourceId: 'iv_fluids', available: 30 },
        { resourceId: 'resus_bed', available: null },
      ],
      forecastWith({ oxygen: 3.4, cardiac_monitor: 6.5, iv_fluids: 4, resus_bed: 2 }),
    );
    const status = Object.fromEntries(table.map((row) => [row.resourceId, row.status]));
    assert.equal(status.oxygen, SHORTAGE_STATUS.SHORT);
    assert.equal(status.cardiac_monitor, SHORTAGE_STATUS.TIGHT);
    assert.equal(status.iv_fluids, SHORTAGE_STATUS.OK);
    assert.equal(status.resus_bed, SHORTAGE_STATUS.UNKNOWN);
    assert.equal(table.find((row) => row.resourceId === 'oxygen').gap, 1.4);
  });

  it('does not call a fraction of a unit over a shortage', () => {
    const [row] = buildShortageTable([{ resourceId: 'ed_bed', available: 13 }], forecastWith({ ed_bed: 13.22 }));
    assert.equal(row.status, SHORTAGE_STATUS.TIGHT);
    assert.equal(row.gap, 0.22);
  });

  it('flags stock at its reorder level even with no demand', () => {
    const [row] = buildShortageTable([{ resourceId: 'ventilator', available: 1 }], forecastWith({}));
    assert.equal(row.status, SHORTAGE_STATUS.TIGHT);
  });
});

describe('recommendations', () => {
  const quietLoad = { queueDepth: 4, nursesOnDuty: 2, queuePerNurseThreshold: 6, surgeConditions: false };
  const resusShort = [{ resourceId: 'resus_bed', category: 'bed', status: 'short', expectedDemand: 3, available: 1 }];

  it('asks for more nurses when the queue exceeds the site ratio', () => {
    const recs = buildRecommendations({
      shortages: [],
      patients: [],
      load: { queueDepth: 21, nursesOnDuty: 2, queuePerNurseThreshold: 6, surgeConditions: true },
    });
    const staffing = recs.find((r) => r.kind === RECOMMENDATION_KIND.STAFFING);
    assert.match(staffing.title, /Deploy 2 additional nurses/);
  });

  it('suggests diversion only when resus is short and the department is in surge', () => {
    const quiet = buildRecommendations({ shortages: resusShort, patients: [], load: quietLoad });
    assert.ok(!quiet.some((r) => r.kind === RECOMMENDATION_KIND.DIVERSION));
    assert.ok(quiet.some((r) => r.kind === RECOMMENDATION_KIND.BEDS));

    const surging = buildRecommendations({
      shortages: resusShort,
      patients: [],
      load: { ...quietLoad, surgeConditions: true },
    });
    assert.ok(surging.some((r) => r.kind === RECOMMENDATION_KIND.DIVERSION));
  });

  it('groups specialist alerts by team', () => {
    const recs = buildRecommendations({
      shortages: [],
      patients: [
        { displayRef: 'P-1', firedRules: [{ code: 'STROKE_SYMPTOMS' }] },
        { displayRef: 'P-2', firedRules: [{ code: 'STROKE_SYMPTOMS' }] },
        { displayRef: 'P-3', firedRules: [{ code: 'HIGH_RISK_CHEST_PAIN' }] },
      ],
      load: quietLoad,
    });
    const stroke = recs.find((r) => r.title.includes('neurology'));
    assert.match(stroke.detail, /2 waiting patients: P-1, P-2/);
    assert.ok(recs.some((r) => r.title === 'Alert Cardiology'));
  });

  it('never recommends anything from a bed count it could not read', () => {
    const recs = buildRecommendations({
      shortages: [{ resourceId: 'resus_bed', category: 'bed', status: 'unknown', available: null }],
      patients: [],
      load: { ...quietLoad, surgeConditions: true },
    });
    assert.equal(recs.length, 0);
  });

  it('asks for a restock of a short supply, sized to demand', () => {
    const recs = buildRecommendations({
      shortages: [{ resourceId: 'oxygen', category: 'equipment', status: 'short', available: 2, expectedDemand: 5.3 }],
      patients: [],
      load: quietLoad,
    });
    const supply = recs.find((r) => r.kind === RECOMMENDATION_KIND.SUPPLY);
    assert.match(supply.detail, /Request 10 from central store/); // par 12 - 2 available
    assert.equal(supply.severity, 'critical');
  });
});

describe('inventory tracker', () => {
  beforeEach(() => resetInventory());

  it('never lets stock go below zero', () => {
    adjustStock('oxygen', -100);
    const { available } = adjustStock('oxygen', 1);
    assert.equal(available, 1);
  });

  it('refuses to adjust beds, which belong to the bed system', () => {
    assert.throws(() => adjustStock('resus_bed', -1), (error) => error.status === 409);
  });

  it('rejects a non-integer or zero adjustment', () => {
    assert.throws(() => adjustStock('oxygen', 0.5), (error) => error.status === 400);
    assert.throws(() => adjustStock('oxygen', 0), (error) => error.status === 400);
  });

  it('restocks to par and records the movement', async () => {
    restock('oxygen');
    const rows = await snapshot();
    const oxygen = rows.find((row) => row.resourceId === 'oxygen');
    assert.equal(oxygen.available, oxygen.parLevel);
    assert.equal(oxygen.recentActivity[0].kind, 'restocked');
  });

  it('reads bed availability from the bed system rather than counting it', async () => {
    const rows = await snapshot();
    const beds = rows.filter((row) => row.category === 'bed');
    assert.equal(beds.length, 2);
    for (const bed of beds) {
      assert.equal(bed.adjustable, false);
      assert.ok(bed.available >= 0 && bed.available <= bed.capacity);
    }
  });
});

describe('clinical / operations boundary', () => {
  it('no clinical or scoring module imports the operations layer', () => {
    const files = [
      ...readdirSync(join(SRC, 'clinical')).filter((f) => f.endsWith('.js')).map((f) => join(SRC, 'clinical', f)),
      join(SRC, 'services', 'triageService.js'),
      join(SRC, 'services', 'mlClient.js'),
      join(SRC, 'queue', 'engine.js'),
      join(SRC, 'queue', 'decay.js'),
    ];
    for (const file of files) {
      assert.ok(!/from ['"][./]*operations\//.test(readFileSync(file, 'utf8')), `${file} imports operations/`);
    }
  });
});
