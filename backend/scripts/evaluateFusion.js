/**
 * End-to-end safety evaluation of the assembled system.
 *
 * The model registry publishes how the risk model behaves alone. That is not the
 * number that matters: no patient is ever scored by the model alone. What reaches
 * a nurse is the fusion of the deterministic rule engine, the model's point
 * estimate, and an escalation ratchet driven by a confidence score that also
 * accounts for what was never measured.
 *
 * This harness runs labelled synthetic encounters through exactly that path —
 * the real buildRuleContext, evaluateRules, computeConfidence and fuse, with the
 * real ML service on the wire — and reports the fused under-triage rate against
 * ground truth. It also reports each layer alone, so the contribution of each is
 * visible rather than asserted.
 *
 * Usage:
 *   cd ml-service && python -m app.export_eval_set 1500
 *   cd backend    && node scripts/evaluateFusion.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRuleContext, evaluateRules } from '../src/clinical/rules.js';
import { computeConfidence } from '../src/clinical/confidence.js';
import { fuse } from '../src/clinical/fusion.js';
import { getDefaultProtocol, loadProtocol } from '../src/clinical/protocol.js';
import { c, rule } from './lib/client.js';

const here = dirname(fileURLToPath(import.meta.url));
const EVAL_SET = join(here, '..', '..', 'ml-service', 'models', 'eval_set.json');
const ML_URL = process.env.ML_SERVICE_URL ?? 'http://127.0.0.1:8000';
const OUT = join(here, '..', '..', 'docs', 'fusion-evaluation.json');

const protocol = getDefaultProtocol();

// The alternative configuration: fusion on the model's plain point estimate, with
// its cumulative-probability escalation switched off. This was briefly the
// shipped default after it appeared to compress a 20-patient roster; measuring it
// against a representative sample is what showed that decision cost a third of
// the system's under-triage performance.
const protocolWithoutModelEscalation = loadProtocol({
  confidence: { useModelEscalation: false },
});

/** Rebuild the observation-shaped vitals the rule engine expects. */
function toObservations(row) {
  const v = row.vitals ?? {};
  const measured = (value) =>
    value === undefined || value === null ? undefined : { value, source: 'measured', reliability: 1.0 };

  return {
    heartRate: measured(v.heart_rate),
    respiratoryRate: measured(v.respiratory_rate),
    systolicBP: measured(v.systolic_bp),
    diastolicBP: measured(v.diastolic_bp),
    spo2: measured(v.spo2),
    temperatureC: measured(v.temperature_c),
    gcs: measured(v.gcs),
    capillaryRefillSec: measured(v.capillary_refill_sec),
    bloodGlucose: measured(v.blood_glucose),
    painScore:
      v.pain_score === undefined
        ? undefined
        : { value: v.pain_score, source: 'patient_reported', reliability: 0.6 },
    observedCues: Object.fromEntries(
      Object.entries(row.cues ?? {}).map(([k, val]) => [
        k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()),
        val,
      ]),
    ),
  };
}

function toEncounter(row) {
  return {
    age: { ageYears: row.age_years, band: row.age_band },
    intake: {
      extraction: { symptoms: row.symptoms ?? [], extractionConfidence: 0.9 },
      transcripts: [],
      viaProxy: Boolean(row.via_proxy),
    },
  };
}

function toPatient(row) {
  const meds = row.medications ?? {};
  return {
    hasPriorRecord: Boolean(row.has_prior_record),
    chronicConditions: row.conditions ?? [],
    baselines: {
      systolicBP: row.baselines?.systolic_bp,
      spo2: row.baselines?.spo2,
      heartRate: row.baselines?.heart_rate,
    },
    medications: [
      meds.anticoagulant && { name: 'anticoagulant', isAnticoagulant: true },
      meds.beta_blocker && { name: 'beta blocker', isBetaBlocker: true },
      meds.immunosuppressant && { name: 'immunosuppressant', isImmunosuppressant: true },
    ].filter(Boolean),
  };
}

async function scoreBatch(rows) {
  const results = [];
  let mlFailures = 0;

  for (const row of rows) {
    const encounter = toEncounter(row);
    const patient = toPatient(row);
    const vitals = toObservations(row);

    const context = buildRuleContext({ encounter, patient, vitals, protocol });
    const ruleResult = evaluateRules(context);

    let modelResult = null;
    try {
      const response = await fetch(`${ML_URL}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          age_years: row.age_years,
          age_band: row.age_band,
          vitals: row.vitals,
          baselines: row.baselines,
          cues: row.cues,
          symptoms: row.symptoms,
          conditions: row.conditions,
          medications: row.medications,
          has_prior_record: row.has_prior_record,
          via_proxy: row.via_proxy,
          thresholds: row.thresholds,
          // Must be sent, exactly as mlClient.js does. Omitting it lets the ML
          // service fall back to its own internal default, and the harness then
          // silently measures a threshold the deployed system does not use.
          escalationTau: protocol.confidence?.escalationTau,
        }),
      });
      if (response.ok) modelResult = await response.json();
      else mlFailures += 1;
    } catch {
      mlFailures += 1;
    }

    const confidence = computeConfidence({
      protocol,
      encounter,
      patient,
      vitals,
      classProbabilities: modelResult?.classProbabilities,
      modelUnavailable: !modelResult,
      ageBand: row.age_band,
    });

    const fusion = fuse({ ruleResult, modelResult, confidence, protocol });
    const fusionPointOnly = fuse({
      ruleResult,
      modelResult,
      confidence,
      protocol: protocolWithoutModelEscalation,
    });

    results.push({
      truth: row.truthESI,
      archetype: row.archetype,
      band: row.age_band,
      completeness: row.completeness,
      ruleFloor: ruleResult.esi,
      modelPoint: modelResult?.mostLikelyESI ?? null,
      modelEscalated: modelResult?.esi ?? null,
      fused: fusion.finalESI,
      fusedPointOnly: fusionPointOnly.finalESI,
      ratchetApplied: fusion.ratchetApplied,
      confidence: confidence.score,
      confidenceBand: confidence.band,
      // Kept so the escalation threshold can be swept offline: the decision rule
      // is a pure function of these, so there is no need to re-query the model
      // once per candidate threshold.
      probabilities: modelResult?.classProbabilities ?? null,
    });

    if (results.length % 100 === 0) process.stdout.write('.');
  }
  return { results, mlFailures };
}

function metrics(pairs) {
  const n = pairs.length;
  if (!n) return null;
  const under = pairs.filter(([truth, pred]) => pred > truth);
  const over = pairs.filter(([truth, pred]) => pred < truth);
  const critical = pairs.filter(([truth]) => truth <= 2);
  const criticalUnder = critical.filter(([truth, pred]) => pred > truth);

  return {
    n,
    accuracy: pairs.filter(([t, p]) => t === p).length / n,
    underTriageRate: under.length / n,
    overTriageRate: over.length / n,
    criticalUnderTriageRate: critical.length ? criticalUnder.length / critical.length : 0,
    criticalSentToLowAcuity: pairs.filter(([t, p]) => t <= 2 && p >= 4).length,
    meanAbsoluteError: pairs.reduce((sum, [t, p]) => sum + Math.abs(t - p), 0) / n,
  };
}

/**
 * The model's escalation-aware decision rule, recomputed locally.
 *
 * Mirrors escalation_aware_predict in ml-service/app/train.py: the most urgent
 * level whose cumulative probability reaches `tau`, capped at the most likely
 * class so the rule can only ever escalate.
 */
function escalationAware(probabilities, tau) {
  if (!probabilities?.length) return null;
  let cumulative = 0;
  let argmax = 0;
  for (let i = 1; i < probabilities.length; i += 1) {
    if (probabilities[i] > probabilities[argmax]) argmax = i;
  }
  for (let i = 0; i < probabilities.length; i += 1) {
    cumulative += probabilities[i];
    if (cumulative >= tau) return Math.min(i, argmax) + 1;
  }
  return argmax + 1;
}

function row(label, m) {
  if (!m) return;
  const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%';
  console.log(
    `  ${label.padEnd(30)} ${pct(m.underTriageRate)}  ${pct(m.criticalUnderTriageRate)}  ` +
      `${pct(m.overTriageRate)}  ${pct(m.accuracy)}  ${String(m.criticalSentToLowAcuity).padStart(4)}`,
  );
}

async function main() {
  let rows;
  try {
    rows = JSON.parse(readFileSync(EVAL_SET, 'utf8'));
  } catch {
    console.error(
      `\n  No evaluation set at ${EVAL_SET}.\n` +
        '  Generate one first:  cd ml-service && python3 -m app.export_eval_set 1500\n',
    );
    process.exit(1);
  }

  rule(`Fused safety evaluation — ${rows.length} held-out synthetic encounters`);
  console.log(c.dim('  scoring through the real rule engine, model and fusion...'));

  const { results, mlFailures } = await scoreBatch(rows);
  console.log('\n');

  if (mlFailures) {
    console.log(c.yellow(`  ${mlFailures} encounters scored without the model (service unreachable).\n`));
  }

  // Each layer alone, then the assembled system.
  const ruleOnly = metrics(results.map((r) => [r.truth, r.ruleFloor]));
  const modelPoint = metrics(
    results.filter((r) => r.modelPoint != null).map((r) => [r.truth, r.modelPoint]),
  );
  const modelEscalated = metrics(
    results.filter((r) => r.modelEscalated != null).map((r) => [r.truth, r.modelEscalated]),
  );
  const fused = metrics(results.map((r) => [r.truth, r.fused]));
  const fusedPointOnly = metrics(results.map((r) => [r.truth, r.fusedPointOnly]));

  console.log(`  ${'layer'.padEnd(30)} ${'under'.padStart(6)} ${'crit-u'.padStart(6)} ${'over'.padStart(6)} ${'acc'.padStart(6)} ${'c→low'.padStart(5)}`);
  console.log('  ' + '─'.repeat(66));
  row('rule engine alone', ruleOnly);
  row('model alone (most likely)', modelPoint);
  row('model alone (self-escalated)', modelEscalated);
  console.log('  ' + '─'.repeat(66));
  row(c.bold('FUSED (shipped default)'), fused);
  row('FUSED without model escalation', fusedPointOnly);

  console.log(
    c.dim(
      '\n  under  = predicted less urgent than truth · the error that kills\n' +
        '  crit-u = under-triage among truly ESI 1-2 patients\n' +
        '  c→low  = truly critical patients sent to ESI 4 or 5',
    ),
  );

  // ------------------------------------------------------------ where it fails
  const byBand = {};
  const byArchetype = {};
  for (const r of results) {
    (byBand[r.band] ??= []).push([r.truth, r.fused]);
    (byArchetype[r.archetype] ??= []).push([r.truth, r.fused]);
  }

  // ------------------------------------------------- choosing the operating point
  //
  // Switching the model's escalation off entirely was too blunt: it halves
  // over-triage but nearly doubles under-triage, which is the wrong direction for
  // the error that kills. The threshold is the real control, so sweep it.
  rule('Escalation threshold sweep (fusion with model escalation on)');
  console.log(`  ${'tau'.padStart(5)}  ${'under'.padStart(6)} ${'crit-u'.padStart(6)} ${'over'.padStart(6)} ${'acc'.padStart(6)} ${'c→low'.padStart(5)}`);
  console.log('  ' + '─'.repeat(46));

  const sweep = [];
  for (const tau of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7]) {
    const pairs = results.map((r) => {
      if (!r.probabilities) return [r.truth, r.fused];
      const modelEsi = escalationAware(r.probabilities, tau);
      const fusion = fuse({
        ruleResult: { esi: r.ruleFloor, firedRules: [] },
        modelResult: { esi: modelEsi, mostLikelyESI: modelEsi, classProbabilities: r.probabilities },
        confidence: { score: r.confidence, band: r.confidenceBand, drivers: [] },
        protocol,
      });
      return [r.truth, fusion.finalESI];
    });
    const m = metrics(pairs);
    sweep.push({ tau, ...m });
    const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%';
    console.log(
      `  ${String(tau).padStart(5)}  ${pct(m.underTriageRate)} ${pct(m.criticalUnderTriageRate)} ` +
        `${pct(m.overTriageRate)} ${pct(m.accuracy)} ${String(m.criticalSentToLowAcuity).padStart(5)}`,
    );
  }
  console.log(
    c.dim(
      '\n  A lower threshold escalates more readily. The choice is a capacity decision\n' +
        '  as much as a clinical one, which is why it belongs in the site protocol:\n' +
        '  a department with spare beds can afford to sit further left than one that\n' +
        '  is already full.',
    ),
  );

  rule('Fused under-triage by age band');
  for (const [band, pairs] of Object.entries(byBand).sort()) {
    const m = metrics(pairs);
    const flag = m.underTriageRate > (fused.underTriageRate + 0.05) ? c.yellow('  ← worse than overall') : '';
    console.log(`  ${band.padEnd(20)} n=${String(m.n).padStart(4)}  under ${(m.underTriageRate * 100).toFixed(1).padStart(5)}%${flag}`);
  }

  rule('Worst presentations (fused)');
  const worst = Object.entries(byArchetype)
    .map(([name, pairs]) => [name, metrics(pairs)])
    .filter(([, m]) => m.n >= 15)
    .sort((a, b) => b[1].underTriageRate - a[1].underTriageRate)
    .slice(0, 6);
  for (const [name, m] of worst) {
    console.log(`  ${name.padEnd(28)} n=${String(m.n).padStart(4)}  under ${(m.underTriageRate * 100).toFixed(1).padStart(5)}%`);
  }

  rule('Contribution of the uncertainty ratchet');
  const ratcheted = results.filter((r) => r.ratchetApplied);
  const withoutRatchet = metrics(results.map((r) => [r.truth, r.ratchetApplied ? r.fused + 1 : r.fused]));
  console.log(`  Ratchet fired on ${ratcheted.length} of ${results.length} encounters (${((ratcheted.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`  Under-triage without it would be ${(withoutRatchet.underTriageRate * 100).toFixed(1)}%, with it ${(fused.underTriageRate * 100).toFixed(1)}%`);

  const report = {
    generatedAt: new Date().toISOString(),
    evaluationSet: { rows: results.length, source: 'synthetic, held-out seed 90210' },
    layers: {
      ruleEngineAlone: ruleOnly,
      modelAloneMostLikely: modelPoint,
      modelAloneSelfEscalated: modelEscalated,
      fusedShippedDefault: fused,
      fusedWithoutModelEscalation: fusedPointOnly,
    },
    fusedByBand: Object.fromEntries(Object.entries(byBand).map(([k, v]) => [k, metrics(v)])),
    fusedByArchetype: Object.fromEntries(Object.entries(byArchetype).map(([k, v]) => [k, metrics(v)])),
    ratchet: { firedCount: ratcheted.length, underTriageWithout: withoutRatchet.underTriageRate },
    escalationThresholdSweep: sweep,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(c.dim(`\n  Full report written to docs/fusion-evaluation.json\n`));
}

main().catch((error) => {
  console.error('\n  evaluation failed:', error.message);
  process.exit(1);
});
