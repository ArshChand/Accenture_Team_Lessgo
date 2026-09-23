/**
 * Resource forecasting: operations intelligence alongside clinical intelligence.
 *
 * The triage pipeline answers "who should be seen first". This module answers the
 * question a charge nurse asks next: "what is this waiting room about to need, and
 * do we have it?" It predicts, per patient, which of a small set of tracked
 * resources they are likely to consume, sums those likelihoods into expected
 * demand, compares demand with stock, and turns the gaps into recommendations.
 *
 * Three design commitments:
 *
 * 1. **One-way flow.** Predictions read the clinical record (ESI, fired rules,
 *    extracted symptoms, age band). Nothing here is ever read back by the scoring
 *    pipeline. A shortage of beds must never make a patient look less sick — that
 *    is the same boundary `integrations/hospitalSystems.js` draws, and a test
 *    asserts the clinical modules do not import this one.
 *
 * 2. **Explainable, not trained.** There is no usage data to train a model on, so
 *    each prediction is a documented mapping from a clinical finding to a resource
 *    with a likelihood, combined with a noisy-OR. Every predicted item carries the
 *    findings that produced it. A learned model is the upgrade once a site has
 *    real consumption records to fit it against.
 *
 * 3. **Expected demand, not headcounts.** Three patients each 60% likely to need
 *    oxygen is 1.8 cylinders of expected demand, not three and not zero. Stock is
 *    compared against that sum, so the shortage table degrades gracefully instead
 *    of flipping on a single uncertain patient.
 */

export const RESOURCE_CATEGORY = { BED: 'bed', EQUIPMENT: 'equipment', MEDICINE: 'medicine' };

/**
 * The tracked catalogue. `source: 'bed_system'` items are read live from the bed
 * management adapter and cannot be adjusted here; everything else is counted by
 * this system's own inventory tracker. `parLevel` is the restock target and
 * `reorderLevel` the point at which stock alone (before any demand) is flagged.
 */
export const RESOURCE_CATALOGUE = [
  { id: 'resus_bed', label: 'Resuscitation bed', category: RESOURCE_CATEGORY.BED, unit: 'beds', source: 'bed_system', bedDepartments: ['Resuscitation'] },
  { id: 'ed_bed', label: 'ED bed / trolley', category: RESOURCE_CATEGORY.BED, unit: 'beds', source: 'bed_system', bedDepartments: ['Majors', 'Minors', 'Paediatric bay'] },
  { id: 'oxygen', label: 'Oxygen cylinder', category: RESOURCE_CATEGORY.EQUIPMENT, unit: 'cylinders', source: 'tracker', parLevel: 12, reorderLevel: 3 },
  { id: 'cardiac_monitor', label: 'Cardiac monitor', category: RESOURCE_CATEGORY.EQUIPMENT, unit: 'units', source: 'tracker', parLevel: 16, reorderLevel: 3 },
  { id: 'ventilator', label: 'Ventilator', category: RESOURCE_CATEGORY.EQUIPMENT, unit: 'units', source: 'tracker', parLevel: 3, reorderLevel: 1 },
  { id: 'nebuliser', label: 'Nebuliser', category: RESOURCE_CATEGORY.EQUIPMENT, unit: 'units', source: 'tracker', parLevel: 6, reorderLevel: 1 },
  { id: 'iv_fluids', label: 'IV fluids (1 L saline)', category: RESOURCE_CATEGORY.MEDICINE, unit: 'bags', source: 'tracker', parLevel: 40, reorderLevel: 8 },
  { id: 'antibiotics', label: 'Broad-spectrum IV antibiotics', category: RESOURCE_CATEGORY.MEDICINE, unit: 'doses', source: 'tracker', parLevel: 20, reorderLevel: 4 },
  { id: 'sedation_kit', label: 'Anaesthesia / sedation kit', category: RESOURCE_CATEGORY.MEDICINE, unit: 'kits', source: 'tracker', parLevel: 8, reorderLevel: 2 },
  { id: 'blood_units', label: 'O-negative blood', category: RESOURCE_CATEGORY.MEDICINE, unit: 'units', source: 'tracker', parLevel: 6, reorderLevel: 2 },
];

export const RESOURCE_IDS = RESOURCE_CATALOGUE.map((item) => item.id);

const byId = new Map(RESOURCE_CATALOGUE.map((item) => [item.id, item]));
export const resourceById = (id) => byId.get(id);

/**
 * Fired rule code -> resources it implies, with likelihood. Codes must exist in
 * clinical/rules.js; a test enforces that so a renamed rule cannot silently stop
 * contributing to the forecast.
 */
export const RULE_RESOURCE_MAP = {
  UNRESPONSIVE: { resus_bed: 0.95, cardiac_monitor: 0.95, oxygen: 0.9, ventilator: 0.5, sedation_kit: 0.4 },
  APNOEA_OR_BRADYPNOEA: { resus_bed: 0.9, oxygen: 0.95, ventilator: 0.7, sedation_kit: 0.5, cardiac_monitor: 0.9 },
  SEVERE_HYPOXIA: { oxygen: 0.95, cardiac_monitor: 0.8, ventilator: 0.35 },
  HYPOXIA: { oxygen: 0.85, cardiac_monitor: 0.5 },
  RESPIRATORY_DISTRESS: { oxygen: 0.8, nebuliser: 0.5, cardiac_monitor: 0.5 },
  SEVERE_TACHYPNOEA: { oxygen: 0.6, cardiac_monitor: 0.6 },
  DECOMPENSATED_SHOCK: { resus_bed: 0.8, iv_fluids: 0.95, cardiac_monitor: 0.95, blood_units: 0.3 },
  HYPOTENSION: { iv_fluids: 0.85, cardiac_monitor: 0.85 },
  RELATIVE_HYPOTENSION: { iv_fluids: 0.7, cardiac_monitor: 0.75 },
  ELEVATED_SHOCK_INDEX: { iv_fluids: 0.7, cardiac_monitor: 0.75 },
  PAEDIATRIC_COMPENSATED_SHOCK: { iv_fluids: 0.85, cardiac_monitor: 0.8 },
  BETA_BLOCKER_MASKED_SHOCK: { iv_fluids: 0.75, cardiac_monitor: 0.85 },
  SIGNIFICANT_HAEMORRHAGE: { blood_units: 0.7, iv_fluids: 0.9, cardiac_monitor: 0.7 },
  SEPSIS_SCREEN_POSITIVE: { antibiotics: 0.9, iv_fluids: 0.85, cardiac_monitor: 0.6 },
  IMMUNOSUPPRESSED_FEVER: { antibiotics: 0.85, iv_fluids: 0.5 },
  INFANT_FEVER_UNDER_3_MONTHS: { antibiotics: 0.8, iv_fluids: 0.4 },
  HIGH_RISK_CHEST_PAIN: { cardiac_monitor: 0.95, oxygen: 0.3 },
  ATYPICAL_CARDIAC_PRESENTATION: { cardiac_monitor: 0.9 },
  SEVERE_TACHYCARDIA: { cardiac_monitor: 0.9 },
  STROKE_SYMPTOMS: { cardiac_monitor: 0.7 },
  NEW_ALTERED_MENTAL_STATUS: { cardiac_monitor: 0.6 },
  ANAPHYLAXIS: { oxygen: 0.7, nebuliser: 0.5, iv_fluids: 0.7, cardiac_monitor: 0.8 },
  ANTICOAGULATED_HEAD_INJURY: { cardiac_monitor: 0.5, blood_units: 0.15 },
  DELIBERATE_SELF_HARM_OR_OVERDOSE: { cardiac_monitor: 0.8, iv_fluids: 0.5 },
  SEVERE_HYPOGLYCAEMIA: { iv_fluids: 0.7, cardiac_monitor: 0.5 },
  HYPOGLYCAEMIA: { iv_fluids: 0.5 },
  PRE_ECLAMPSIA_RISK: { cardiac_monitor: 0.7, iv_fluids: 0.4 },
};

/** Extracted symptom -> resources, for findings no rule fires on. */
export const SYMPTOM_RESOURCE_MAP = {
  wheeze: { nebuliser: 0.8, oxygen: 0.4 },
  stridor: { nebuliser: 0.6, oxygen: 0.6 },
  dyspnoea: { oxygen: 0.5 },
  seizure: { sedation_kit: 0.4, oxygen: 0.5 },
  gi_bleeding: { blood_units: 0.25, iv_fluids: 0.6 },
  haemoptysis: { blood_units: 0.2, oxygen: 0.4 },
  vaginal_bleeding: { blood_units: 0.25, iv_fluids: 0.6 },
  vomiting: { iv_fluids: 0.45 },
  diarrhoea: { iv_fluids: 0.4 },
  burn: { iv_fluids: 0.6, sedation_kit: 0.2 },
  deformity: { sedation_kit: 0.45 },
  laceration: { sedation_kit: 0.15 },
};

/**
 * Chance a patient at each ESI needs *a bed of some kind*. Split between resus and
 * ED beds below: a patient takes one or the other, never both.
 */
const BED_NEED_BY_ESI = { 1: 1.0, 2: 0.95, 3: 0.75, 4: 0.35, 5: 0.1 };
const RESUS_BY_ESI = { 1: 0.9, 2: 0.2 };

/** Baseline needs implied by acuity alone, before any specific finding. */
const ESI_BASELINE = {
  1: { cardiac_monitor: 0.9, iv_fluids: 0.8, oxygen: 0.7 },
  2: { cardiac_monitor: 0.6, iv_fluids: 0.5 },
  3: { iv_fluids: 0.35 },
};

/** Predictions below this are noise and are not shown per patient. */
export const DISPLAY_FLOOR = 0.15;
export const MAX_LIKELIHOOD = 0.99;

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Likely resources for one patient.
 *
 * Contributions to the same resource combine as a noisy-OR — each finding is an
 * independent chance of needing it — so two moderate reasons raise the
 * likelihood without it ever exceeding 1.
 *
 * @param {object} args
 * @param {number} args.esi
 * @param {{code: string, label?: string}[]} [args.firedRules]
 * @param {string[]} [args.symptoms]
 * @returns {{resourceId: string, label: string, category: string, likelihood: number, reasons: string[]}[]}
 */
export function predictResources({ esi, firedRules = [], symptoms = [] }) {
  const contributions = new Map(); // resourceId -> [{ p, reason }]
  const add = (resourceId, p, reason) => {
    if (!byId.has(resourceId) || !(p > 0)) return;
    if (!contributions.has(resourceId)) contributions.set(resourceId, []);
    contributions.get(resourceId).push({ p, reason });
  };

  const level = Number.isFinite(esi) ? esi : 3;

  for (const [resourceId, p] of Object.entries(ESI_BASELINE[level] ?? {})) {
    add(resourceId, p, `ESI ${level} acuity`);
  }
  for (const rule of firedRules) {
    const mapping = RULE_RESOURCE_MAP[rule.code];
    if (!mapping) continue;
    const reason = rule.label ?? rule.code.toLowerCase().replace(/_/g, ' ');
    for (const [resourceId, p] of Object.entries(mapping)) add(resourceId, p, reason);
  }
  for (const symptom of new Set(symptoms)) {
    const mapping = SYMPTOM_RESOURCE_MAP[symptom];
    if (!mapping) continue;
    const reason = `reported ${symptom.replace(/_/g, ' ')}`;
    for (const [resourceId, p] of Object.entries(mapping)) add(resourceId, p, reason);
  }

  // Resus bed: acuity baseline plus any finding that demands one.
  if (RESUS_BY_ESI[level]) add('resus_bed', RESUS_BY_ESI[level], `ESI ${level} acuity`);

  const combined = new Map();
  for (const [resourceId, parts] of contributions) {
    // Capped below certainty: a forecast that shows "100%" is claiming more than
    // a mapping from findings to resources can know.
    const likelihood = Math.min(MAX_LIKELIHOOD, 1 - parts.reduce((keep, { p }) => keep * (1 - p), 1));
    const reasons = [...new Set(parts.sort((a, b) => b.p - a.p).map(({ reason }) => reason))];
    combined.set(resourceId, { likelihood, reasons });
  }

  // ED bed is whatever bed need is left once resus has taken its share.
  const resus = combined.get('resus_bed')?.likelihood ?? 0;
  const edBed = Math.min(MAX_LIKELIHOOD, (BED_NEED_BY_ESI[level] ?? 0.5) * (1 - resus));
  if (edBed > 0) combined.set('ed_bed', { likelihood: edBed, reasons: [`ESI ${level} acuity`] });

  return [...combined.entries()]
    .map(([resourceId, { likelihood, reasons }]) => {
      const item = byId.get(resourceId);
      return { resourceId, label: item.label, category: item.category, likelihood: round2(likelihood), reasons };
    })
    .sort((a, b) => b.likelihood - a.likelihood);
}

/**
 * Sum per-patient likelihoods into expected demand per resource.
 *
 * @param {{displayRef: string, predictions: ReturnType<typeof predictResources>}[]} patients
 */
export function forecastDemand(patients) {
  const totals = new Map(RESOURCE_IDS.map((id) => [id, { expected: 0, likelyPatients: [] }]));
  for (const { displayRef, predictions } of patients) {
    for (const { resourceId, likelihood } of predictions) {
      const entry = totals.get(resourceId);
      entry.expected += likelihood;
      if (likelihood >= 0.5) entry.likelyPatients.push(displayRef);
    }
  }
  return RESOURCE_CATALOGUE.map((item) => {
    const { expected, likelyPatients } = totals.get(item.id);
    return { resourceId: item.id, label: item.label, category: item.category, expectedDemand: round2(expected), likelyPatients };
  });
}

export const SHORTAGE_STATUS = { OK: 'ok', TIGHT: 'tight', SHORT: 'short', UNKNOWN: 'unknown' };

const SHORT_MARGIN = 0.5;

/**
 * Compare stock with expected demand.
 *
 * Short: demand exceeds what is available by at least half a unit — expected
 * demand is fractional, and a quarter of a bed over is not a shortage anyone can
 * act on. Tight: demand would use three quarters of stock, or stock is already at
 * the reorder level with no demand at all.
 *
 * @param {{resourceId: string, available: number}[]} inventory
 * @param {ReturnType<typeof forecastDemand>} forecast
 */
export function buildShortageTable(inventory, forecast) {
  const demandById = new Map(forecast.map((row) => [row.resourceId, row]));
  return inventory.map((stock) => {
    const item = byId.get(stock.resourceId);
    const demand = demandById.get(stock.resourceId)?.expectedDemand ?? 0;
    const available = stock.available;
    const row = { resourceId: stock.resourceId, label: item.label, unit: item.unit, category: item.category };

    // An unreachable source is "unknown", never zero: none free and not known
    // call for different actions.
    if (available == null) {
      return { ...row, available: null, expectedDemand: demand, gap: null, status: SHORTAGE_STATUS.UNKNOWN };
    }
    const gap = round2(Math.max(0, demand - available));

    let status = SHORTAGE_STATUS.OK;
    if (demand - available >= SHORT_MARGIN) status = SHORTAGE_STATUS.SHORT;
    else if ((available > 0 && demand >= 0.75 * available) || (item.reorderLevel != null && available <= item.reorderLevel)) {
      status = SHORTAGE_STATUS.TIGHT;
    }

    return { ...row, available, expectedDemand: demand, gap, status };
  });
}

/** Fired rule code -> the specialist team a charge nurse would page. */
export const SPECIALIST_BY_RULE = {
  STROKE_SYMPTOMS: 'Stroke / neurology team',
  HIGH_RISK_CHEST_PAIN: 'Cardiology',
  ATYPICAL_CARDIAC_PRESENTATION: 'Cardiology',
  SEPSIS_SCREEN_POSITIVE: 'Physician on call (sepsis)',
  INFANT_FEVER_UNDER_3_MONTHS: 'Paediatrician',
  NEONATE_PRESENTATION: 'Paediatrician',
  PRE_ECLAMPSIA_RISK: 'Obstetrics',
  DELIBERATE_SELF_HARM_OR_OVERDOSE: 'Toxicology / psychiatry liaison',
  ANTICOAGULATED_HEAD_INJURY: 'Neurosurgery / CT on standby',
  SIGNIFICANT_HAEMORRHAGE: 'Surgical team',
};

export const RECOMMENDATION_KIND = {
  STAFFING: 'staffing',
  BEDS: 'beds',
  SPECIALIST: 'specialist',
  SUPPLY: 'supply',
  DIVERSION: 'diversion',
};

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * Turn shortages and staffing load into suggestions for the charge nurse.
 *
 * Advisory only: nothing here acts. Each recommendation names what it is based on
 * so it can be checked and ignored, the same standard every triage score is held to.
 *
 * @param {object} args
 * @param {ReturnType<typeof buildShortageTable>} args.shortages
 * @param {{displayRef: string, firedRules: {code: string}[]}[]} args.patients waiting patients
 * @param {{queueDepth: number, nursesOnDuty: number, queuePerNurseThreshold: number, surgeConditions: boolean}} args.load
 */
export function buildRecommendations({ shortages, patients, load }) {
  const recommendations = [];
  const shortageOf = (id) => shortages.find((row) => row.resourceId === id);

  // Staffing: how many more nurses bring the queue back under the site's ratio.
  const { queueDepth, nursesOnDuty, queuePerNurseThreshold } = load;
  const nurses = Math.max(1, nursesOnDuty);
  if (queuePerNurseThreshold > 0 && queueDepth / nurses >= queuePerNurseThreshold) {
    const needed = Math.floor(queueDepth / queuePerNurseThreshold) + 1;
    const extra = Math.max(1, needed - nurses);
    recommendations.push({
      kind: RECOMMENDATION_KIND.STAFFING,
      severity: 'critical',
      title: `Deploy ${extra} additional nurse${extra === 1 ? '' : 's'}`,
      detail: `${queueDepth} waiting for ${nurses} nurse${nurses === 1 ? '' : 's'} (${(queueDepth / nurses).toFixed(1)} per nurse, site limit ${queuePerNurseThreshold}).`,
    });
  }

  // Beds.
  const resus = shortageOf('resus_bed');
  if (resus?.status === SHORTAGE_STATUS.SHORT) {
    recommendations.push({
      kind: RECOMMENDATION_KIND.BEDS,
      severity: 'critical',
      title: 'Open overflow resuscitation space',
      detail: `Expected need ${resus.expectedDemand} resus beds, ${resus.available} free. Move stabilised patients out of resus or convert a majors bay.`,
    });
  }
  const edBed = shortageOf('ed_bed');
  if (edBed?.status === SHORTAGE_STATUS.SHORT) {
    recommendations.push({
      kind: RECOMMENDATION_KIND.BEDS,
      severity: 'warning',
      title: 'Expedite discharges and open ED expansion area',
      detail: `Expected need ${edBed.expectedDemand} ED beds, ${edBed.available} free.`,
    });
  }

  // Diversion is the last resort: only when resus is short and the department is
  // already in surge conditions, so a single busy moment never suggests it.
  if (resus?.status === SHORTAGE_STATUS.SHORT && load.surgeConditions) {
    recommendations.push({
      kind: RECOMMENDATION_KIND.DIVERSION,
      severity: 'critical',
      title: 'Consider diverting incoming ambulances',
      detail: 'Resuscitation capacity is short while the department is in surge. Notify the nearest receiving hospital.',
    });
  }

  // Specialists, grouped by team.
  const byTeam = new Map();
  for (const { displayRef, firedRules = [] } of patients) {
    const teams = new Set(firedRules.map((rule) => SPECIALIST_BY_RULE[rule.code]).filter(Boolean));
    for (const team of teams) {
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team).push(displayRef);
    }
  }
  for (const [team, refs] of byTeam) {
    recommendations.push({
      kind: RECOMMENDATION_KIND.SPECIALIST,
      severity: 'warning',
      title: `Alert ${team}`,
      detail: `${refs.length} waiting patient${refs.length === 1 ? '' : 's'}: ${refs.slice(0, 4).join(', ')}${refs.length > 4 ? '…' : ''}`,
    });
  }

  // Supplies tracked here (beds are handled above).
  for (const row of shortages) {
    if (row.category === RESOURCE_CATEGORY.BED) continue;
    if (row.status !== SHORTAGE_STATUS.SHORT && row.status !== SHORTAGE_STATUS.TIGHT) continue;
    const item = byId.get(row.resourceId);
    const target = Math.max(item.parLevel ?? 0, Math.ceil(row.expectedDemand));
    const toRequest = Math.max(1, target - row.available);
    recommendations.push({
      kind: RECOMMENDATION_KIND.SUPPLY,
      severity: row.status === SHORTAGE_STATUS.SHORT ? 'critical' : 'info',
      title: `Restock ${item.label.toLowerCase()}`,
      detail: `${row.available} ${item.unit} available, expected demand ${row.expectedDemand}. Request ${toRequest} from central store.`,
    });
  }

  return recommendations.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
