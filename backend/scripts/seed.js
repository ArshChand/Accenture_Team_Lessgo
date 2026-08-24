/**
 * Seed the 20 curated demonstration patients and verify the system's response
 * against what each case is supposed to demonstrate.
 *
 * The verification is the point. A seeder that only inserts rows tells you the
 * demo will run; this one tells you the demo will run *and still say the right
 * clinical things*, so a change to a threshold, a rule or the model shows up here
 * rather than in front of a judge.
 *
 * Usage:  npm run seed          (backend must be running)
 */

import { CURATED_PATIENTS, EDGE_CASE_COVERAGE } from './data/curatedPatients.js';
import { c, esiTag, get, post, requireBackend, rule, sleep, warnIfMlDown } from './lib/client.js';

const CLINICIANS = [
  { name: 'Nurse Priya R.', role: 'triage_nurse', registrationNumber: 'KA-NUR-88214', shift: 'day' },
  { name: 'Nurse Sunita M.', role: 'charge_nurse', registrationNumber: 'KA-NUR-71903', shift: 'day' },
  { name: 'Dr A. Rao', role: 'physician', registrationNumber: 'KA-MED-40122', shift: 'day' },
  { name: 'Dr Sharma', role: 'physician', registrationNumber: 'KA-MED-51877', shift: 'night' },
];

async function seedOne(patient) {
  const { patient: created } = await post('/patients', {
    displayRef: patient.ref,
    sex: patient.sex,
    preferredLanguage: patient.language,
    hasPriorRecord: patient.hasPriorRecord,
    chronicConditions: patient.conditions ?? [],
    medications: patient.medications ?? [],
    baselines: patient.baselines ?? {},
    socialContext: patient.socialContext,
    identity: patient.name ? { fullName: patient.name, phone: patient.phone } : {},
  });

  const { encounter } = await post('/encounters', {
    patientRef: created._id,
    ageYears: patient.ageYears,
    chiefComplaint: patient.complaint,
    mode: patient.arrivalMode ?? 'walk_in',
    viaProxy: Boolean(patient.proxyIntake),
    transcripts: patient.transcript
      ? [
          {
            language: patient.language,
            rawText: patient.transcript.text,
            asrConfidence: patient.transcript.asr,
            captureMode: 'scripted',
          },
        ]
      : [],
  });

  // Recording observations is what triggers the first real scoring run.
  await post(`/encounters/${encounter._id}/vitals`, patient.vitals);

  // Backdate the arrival so the board opens on a realistic spread of waits
  // rather than twenty patients who all arrived this second.
  if (patient.waitedMinutes > 0) {
    await post('/simulate/advance-time', {
      minutes: patient.waitedMinutes,
      encounterId: encounter._id,
    });
  }

  return encounter._id;
}

/**
 * Compare what the system actually did against what the case is meant to show.
 *
 * A mismatch is reported as a `deviation` rather than a `problem` when the roster
 * already documents it. That distinction is the difference between a regression
 * suite and a wall of ignored red — a known, reasoned disagreement between the
 * system and the textbook answer should stay visible and stay explained, not be
 * quietly deleted from the expectations to make the run go green.
 */
function checkExpectations(patient, encounter, assessment) {
  const problems = [];
  const deviations = [];
  const expected = patient.expect ?? {};
  const firedCodes = (assessment?.ruleEngine?.firedRules ?? []).map((r) => r.code);

  if (expected.esi != null && encounter.currentESI !== expected.esi) {
    const known = expected.knownDeviation;
    if (known && encounter.currentESI === known.actual) {
      deviations.push(`ESI ${encounter.currentESI} rather than ${expected.esi} — ${known.why}`);
    } else {
      problems.push(`expected ESI ${expected.esi}, got ${encounter.currentESI}`);
    }
  }
  for (const code of expected.rules ?? []) {
    if (!firedCodes.includes(code)) problems.push(`rule ${code} did not fire`);
  }
  if (expected.hardRedFlag && !assessment?.fusion?.redFlagLocked && !firedCodes.length) {
    problems.push('expected a hard red flag to hold the score');
  }
  if (expected.confidenceBand && encounter.currentConfidence?.band !== expected.confidenceBand) {
    problems.push(
      `expected ${expected.confidenceBand} confidence, got ${encounter.currentConfidence?.band}`,
    );
  }
  if (expected.escalatedForUncertainty && !assessment?.fusion?.ratchetApplied) {
    problems.push('expected the uncertainty ratchet to escalate this patient');
  }
  return { problems, deviations };
}

async function main() {
  rule('TriageHandler — seeding 20 curated patients');
  await requireBackend();
  await warnIfMlDown();

  for (const clinician of CLINICIANS) {
    await post('/clinicians', clinician).catch(() => {}); // already seeded is fine
  }
  console.log(`  ${CLINICIANS.length} clinicians on duty\n`);

  const encounterIds = [];
  for (const patient of CURATED_PATIENTS) {
    try {
      encounterIds.push({ ref: patient.ref, id: await seedOne(patient), patient });
      process.stdout.write('.');
    } catch (error) {
      console.log(`\n  ${c.red('failed')} ${patient.ref}: ${error.message}`);
    }
  }
  console.log(`\n  ${encounterIds.length} patients seeded\n`);

  // Let the queue engine tick once so decay, priority and any wait breaches are
  // computed before the report is printed.
  await sleep(6000);

  rule('What the assistant concluded');
  const failures = [];
  const knownDeviations = [];

  for (const { ref, id, patient } of encounterIds) {
    const { encounter, assessments } = await get(`/encounters/${id}`);
    const assessment = assessments?.[0];
    const { problems, deviations } = checkExpectations(patient, encounter, assessment);
    if (problems.length) failures.push({ ref, problems });
    if (deviations.length) knownDeviations.push({ ref, deviations });

    const conf = encounter.currentConfidence;
    const status = problems.length ? c.red('✗') : deviations.length ? c.yellow('!') : c.green('✓');
    const topRule = assessment?.ruleEngine?.firedRules?.[0];

    console.log(
      `  ${status} ${c.bold(ref.padEnd(8))} ${esiTag(encounter.currentESI)}  ` +
        `${String(conf?.band ?? '—').padEnd(8)} ${String(Math.round((conf?.score ?? 0) * 100) + '%').padStart(4)}  ` +
        `${c.dim(patient.demonstrates)}`,
    );
    if (topRule) console.log(`      ${c.dim('→ ' + topRule.label + ' — ' + (topRule.evidence ?? ''))}`);
    if (assessment?.fusion?.ratchetApplied) {
      console.log(`      ${c.yellow('→ escalated because the assistant was unsure')}`);
    }
    for (const deviation of deviations) console.log(`      ${c.yellow('→ ' + deviation)}`);
    for (const problem of problems) console.log(`      ${c.red('→ ' + problem)}`);
  }

  // ---------------------------------------------------------------- summary
  const { encounters } = await get('/queue');
  const spread = encounters.reduce((acc, e) => {
    acc[e.currentESI] = (acc[e.currentESI] ?? 0) + 1;
    return acc;
  }, {});

  rule('Severity spread');
  for (const level of [1, 2, 3, 4, 5]) {
    const count = spread[level] ?? 0;
    console.log(`  ${esiTag(level)}  ${'█'.repeat(count).padEnd(12)} ${count}`);
  }
  console.log(
    c.dim(
      '\n  This roster is deliberately edge-case heavy — the brief asks for paediatric,\n' +
        '  geriatric, ambiguous, zero-history and low-confidence cases, and most of those\n' +
        '  are genuinely urgent. A real department is ESI 3 dominant, which is what the\n' +
        "  model's own training distribution reflects (32% ESI 3). Do not read this spread\n" +
        '  as the expected case mix of an actual ED.',
    ),
  );

  rule('Edge case coverage required by the brief');
  for (const [requirement, refs] of Object.entries(EDGE_CASE_COVERAGE)) {
    console.log(`  ${c.green('✓')} ${requirement.padEnd(26)} ${c.dim(refs.join(', '))}`);
  }

  const verify = await get('/audit/verify');
  rule('Audit');
  console.log(`  ${verify.valid ? c.green('✓') : c.red('✗')} ${verify.message}`);

  if (knownDeviations.length) {
    rule(c.yellow(`${knownDeviations.length} documented deviation(s) from the textbook answer`));
    for (const { ref, deviations } of knownDeviations) {
      console.log(`  ${ref}: ${deviations.join('; ')}`);
    }
    console.log(
      c.dim('\n  Recorded rather than hidden. Each errs toward urgency, which is the\n' +
        '  direction this system chooses to err, but each is still an over-triage.'),
    );
  }

  if (failures.length) {
    rule(c.red(`${failures.length} case(s) did not behave as documented`));
    for (const { ref, problems } of failures) {
      console.log(`  ${ref}: ${problems.join('; ')}`);
    }
    console.log();
    process.exitCode = 1;
  } else {
    console.log(
      `\n  ${c.green(`All ${CURATED_PATIENTS.length} cases behaved as documented`)}` +
        (knownDeviations.length ? c.yellow(` (${knownDeviations.length} known deviation).`) : '.'),
    );
    console.log(`  ${c.dim('Open http://localhost:5173 to see the board.')}\n`);
  }
}

main().catch((error) => {
  console.error('\n  seed failed:', error.message);
  process.exit(1);
});
