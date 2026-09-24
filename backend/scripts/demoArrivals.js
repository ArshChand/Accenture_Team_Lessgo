/**
 * Staggered arrivals: watch the resource forecast move one real patient at a time.
 *
 * Five patients arrive a minute apart, ordered from minor to critical (ESI 5 up
 * to ESI 1), so each arrival visibly adds to the Resources view: a sore throat
 * adds almost nothing, a sepsis case adds antibiotics, fluids and a monitor, and new recommendations
 * appear as the findings that justify them arrive. Run it against a freshly
 * started backend with no seed and the numbers climb from zero; run it after
 * `npm run seed` and they climb from a busy department.
 *
 * Usage:  npm run demo:arrivals                    (one patient a minute)
 *         npm run demo:arrivals -- --interval 20   (seconds between arrivals)
 *         npm run demo:arrivals -- --count 3       (first three patients only)
 */

import { CLINICIANS } from './data/clinicians.js';
import { c, esiTag, get, post, requireBackend, rule, sleep, warnIfMlDown } from './lib/client.js';

const measured = (value) => ({ value, source: 'measured', reliability: 1.0 });
const reported = (value) => ({ value, source: 'patient_reported', reliability: 0.6 });

const ARRIVALS = [
  {
    story: 'Minor: sore throat, well',
    ageYears: 22,
    sex: 'female',
    text: 'I have had a sore throat for two days',
    vitals: { heartRate: 78, respiratoryRate: 14, systolicBP: 118, spo2: 99, temperatureC: 37.2, pain: 2 },
  },
  {
    story: 'Wound: deep cut that needs stitches',
    ageYears: 28,
    sex: 'male',
    text: 'I cut my hand on a kitchen knife and it needs stitches',
    vitals: { heartRate: 88, respiratoryRate: 16, systolicBP: 126, spo2: 98, temperatureC: 36.8, pain: 5 },
  },
  {
    story: 'Cardiac: chest pain radiating, sweating',
    ageYears: 62,
    sex: 'male',
    text: 'I have chest pain radiating to my left arm and I am sweating',
    conditions: ['hypertension', 'diabetes'],
    vitals: { heartRate: 104, respiratoryRate: 20, systolicBP: 150, spo2: 96, temperatureC: 36.9, pain: 7 },
  },
  {
    story: 'Respiratory: asthma attack, low oxygen',
    ageYears: 45,
    sex: 'female',
    text: 'I am wheezing and I cannot breathe properly',
    conditions: ['asthma'],
    vitals: { heartRate: 118, respiratoryRate: 30, systolicBP: 128, spo2: 88, temperatureC: 37.0, pain: 3 },
  },
  {
    story: 'Sepsis: fever, confused, low blood pressure',
    ageYears: 71,
    sex: 'female',
    text: 'my mother has fever and she is confused since morning',
    viaProxy: true,
    conditions: ['diabetes'],
    vitals: { heartRate: 124, respiratoryRate: 26, systolicBP: 86, spo2: 93, temperatureC: 39.1, pain: 4 },
  },
];

const WATCHED = ['resus_bed', 'ed_bed', 'oxygen', 'cardiac_monitor', 'nebuliser', 'iv_fluids', 'antibiotics', 'sedation_kit'];

/** Accepts `--interval 20` and `--interval=20`. */
function argValue(flag, fallback) {
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  const index = args.indexOf(flag);
  const raw = inline ? inline.slice(flag.length + 1) : index === -1 ? undefined : args[index + 1];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const pct = (p) => `${Math.round(p * 100)}%`;

async function admit(arrival) {
  const { patient } = await post('/patients', {
    displayRef: `P-${Math.floor(1000 + Math.random() * 8999)}`,
    sex: arrival.sex,
    preferredLanguage: 'en-IN',
    hasPriorRecord: Boolean(arrival.conditions),
    chronicConditions: arrival.conditions ?? [],
  });
  const { encounter } = await post('/encounters', {
    patientRef: patient._id,
    ageYears: arrival.ageYears,
    chiefComplaint: arrival.text,
    mode: 'walk_in',
    viaProxy: Boolean(arrival.viaProxy),
    transcripts: [{ language: 'en-IN', rawText: arrival.text, asrConfidence: 0.92, captureMode: 'scripted' }],
  });
  const v = arrival.vitals;
  await post(`/encounters/${encounter._id}/vitals`, {
    heartRate: measured(v.heartRate),
    respiratoryRate: measured(v.respiratoryRate),
    systolicBP: measured(v.systolicBP),
    spo2: measured(v.spo2),
    temperatureC: measured(v.temperatureC),
    gcs: measured(15),
    painScore: reported(v.pain),
  });
  return get(`/encounters/${encounter._id}`);
}

function describeForecast(overview) {
  const byId = Object.fromEntries(overview.shortages.map((row) => [row.resourceId, row]));
  return WATCHED.map((id) => byId[id])
    .filter(Boolean)
    .map((row) => {
      const text = `${row.label.split(' (')[0]} ${row.expectedDemand}/${row.available ?? '?'}`;
      if (row.status === 'short') return c.red(text);
      if (row.status === 'tight') return c.yellow(text);
      return text;
    })
    .join('  ·  ');
}

async function main() {
  const intervalSeconds = argValue('--interval', 60);
  const count = Math.min(ARRIVALS.length, argValue('--count', ARRIVALS.length));

  rule(`TriageHandler: ${count} arrivals, one every ${intervalSeconds}s`);
  await requireBackend();
  await warnIfMlDown();

  // A department started from scratch still has a shift on duty; without one the
  // board has nobody to record an override or a disposition against.
  for (const clinician of CLINICIANS) {
    await post('/clinicians', clinician).catch(() => {}); // already on duty is fine
  }

  const start = await get('/resources/overview');
  const seen = new Set(start.recommendations.map((rec) => rec.title));
  console.log(
    `  Starting from ${start.basis.waitingPatients} waiting patient${start.basis.waitingPatients === 1 ? '' : 's'}.` +
      ' Open the ED head view (Resources) to watch it change.\n',
  );
  console.log(`  ${c.dim('forecast (expected need / available):')} ${describeForecast(start)}\n`);

  for (let i = 0; i < count; i += 1) {
    const arrival = ARRIVALS[i];
    const { encounter, predictedResources } = await admit(arrival);
    const conf = encounter.currentConfidence;

    console.log(
      `${c.bold(`[${stamp()}] Arrival ${i + 1}/${count}`)}  ${c.bold(encounter.displayRef)} · token ${encounter.tokenNumber} · ${arrival.ageYears}y · ${arrival.story}`,
    );
    console.log(`    "${arrival.text}"`);
    console.log(
      `    triaged ${esiTag(encounter.currentESI)}  ${c.dim(`(${conf?.band ?? '—'} confidence ${pct(conf?.score ?? 0)})`)}`,
    );
    const likely = predictedResources.slice(0, 4).map((r) => `${r.label.split(' (')[0].toLowerCase()} ${pct(r.likelihood)}`);
    console.log(`    likely to need: ${likely.length ? likely.join(' · ') : c.dim('nothing beyond a quick assessment')}`);

    const overview = await get('/resources/overview');
    console.log(`    department now: ${describeForecast(overview)}`);
    const fresh = overview.recommendations.filter((rec) => !seen.has(rec.title));
    for (const rec of fresh) {
      seen.add(rec.title);
      const tone = rec.severity === 'critical' ? c.red : c.yellow;
      console.log(`    ${tone('+ new recommendation:')} ${rec.title} ${c.dim(`— ${rec.detail}`)}`);
    }
    console.log('');

    if (i < count - 1) {
      console.log(c.dim(`    next arrival in ${intervalSeconds}s…\n`));
      await sleep(intervalSeconds * 1000);
    }
  }

  rule('Done');
  console.log('  Every change above came from a patient: bed counts hold still unless MOCK_BED_DRIFT=true.\n');
}

main().catch((error) => {
  console.error(`\n  demo failed: ${error.message}\n`);
  process.exit(1);
});
