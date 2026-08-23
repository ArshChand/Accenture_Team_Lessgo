/**
 * Surge demonstration: 3x normal arrival volume.
 *
 * Shows what changes under load and, more importantly, what does not. The brief
 * is explicit that safe waiting times must hold when the department is
 * overwhelmed — the temptation in a real system is to quietly relax them so the
 * board looks less alarming, and the whole point of the surge policy here is that
 * it changes presentation and cadence instead.
 *
 * Usage:  npm run demo:surge     (backend running; run npm run seed first)
 */

import { c, get, post, requireBackend, rule, sleep } from './lib/client.js';

const BASELINE_PER_HOUR = 8;
const SURGE_MULTIPLE = 3;
const ARRIVALS = BASELINE_PER_HOUR * SURGE_MULTIPLE;

const measured = (value) => ({ value, source: 'measured', reliability: 1.0 });
const reported = (value) => ({ value, source: 'patient_reported', reliability: 0.6 });

/**
 * A plausible spread of walk-in complaints. Data completeness varies the way it
 * does in a real rush — some people get a full set of observations, some get a
 * heart rate and a promise.
 */
const PRESENTATIONS = [
  { complaint: 'abdominal pain and vomiting', text: 'my stomach hurts and I have been vomiting', hr: 96, rr: 18, sbp: 126, spo2: 98, temp: 37.4, pain: 5 },
  { complaint: 'twisted ankle', text: 'I twisted my ankle playing football', hr: 82, rr: 15, sbp: 124, spo2: 99, temp: 36.7, pain: 4 },
  { complaint: 'fever and cough', text: 'I have had a fever and cough for three days', hr: 98, rr: 20, sbp: 118, spo2: 96, temp: 38.3, pain: 2 },
  { complaint: 'headache', text: 'bad headache since this morning', hr: 78, rr: 16, sbp: 132, spo2: 98, temp: 36.9, pain: 6 },
  { complaint: 'rash', text: 'I have come out in a rash', hr: 76, rr: 15, sbp: 120, spo2: 99, temp: 37.0, pain: 1 },
  { complaint: 'chest tightness', text: 'my chest feels tight and I am short of breath', hr: 108, rr: 22, sbp: 138, spo2: 95, temp: 36.8, pain: 5 },
  { complaint: 'cut hand', text: 'I cut my hand on a knife', hr: 84, rr: 16, sbp: 122, spo2: 99, temp: 36.8, pain: 4 },
  { complaint: 'dizzy spells', text: 'I keep feeling dizzy when I stand up', hr: 92, rr: 17, sbp: 104, spo2: 97, temp: 36.6, pain: 0 },
];

function vitalsFor(presentation, index) {
  // Roughly one arrival in four is scored before a full set exists.
  const rushed = index % 4 === 0;
  const vitals = { heartRate: measured(presentation.hr), painScore: reported(presentation.pain) };
  if (!rushed) {
    Object.assign(vitals, {
      respiratoryRate: measured(presentation.rr),
      systolicBP: measured(presentation.sbp),
      spo2: measured(presentation.spo2),
      temperatureC: measured(presentation.temp),
      gcs: measured(15),
    });
  }
  return vitals;
}

async function snapshot(label) {
  const queue = await get('/queue');
  const breached = queue.encounters.filter((e) => e.queue?.decayStatus === 'red').length;
  const spread = queue.encounters.reduce((acc, e) => {
    acc[e.currentESI] = (acc[e.currentESI] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  ${label.padEnd(22)} waiting ${String(queue.count).padStart(3)}  ` +
      `breached ${String(breached).padStart(3)}  ` +
      `capacity debt ${String(queue.capacityDebtMinutes ?? 0).padStart(4)}m  ` +
      c.dim(`[${[1, 2, 3, 4, 5].map((l) => `${l}:${spread[l] ?? 0}`).join(' ')}]`),
  );
  return queue;
}

async function main() {
  rule(`Surge demonstration — ${SURGE_MULTIPLE}x normal volume`);
  await requireBackend();

  const before = await get('/protocol');
  const safeWaitsBefore = JSON.stringify(before.protocol.safeWaitMinutes);

  console.log(
    `  Baseline is ${BASELINE_PER_HOUR} arrivals/hour. Injecting ${ARRIVALS} to reach ${SURGE_MULTIPLE}x.\n`,
  );

  await snapshot('before surge');

  for (let i = 0; i < ARRIVALS; i += 1) {
    const presentation = PRESENTATIONS[i % PRESENTATIONS.length];
    const { patient } = await post('/patients', {
      displayRef: `SRG-${String(i).padStart(2, '0')}`,
      sex: i % 2 ? 'male' : 'female',
      preferredLanguage: 'en-IN',
      hasPriorRecord: i % 3 === 0,
    });
    const { encounter } = await post('/encounters', {
      patientRef: patient._id,
      ageYears: 22 + ((i * 7) % 55),
      chiefComplaint: presentation.complaint,
      transcripts: [{ language: 'en-IN', rawText: presentation.text, asrConfidence: 0.9, captureMode: 'scripted' }],
    });
    await post(`/encounters/${encounter._id}/vitals`, vitalsFor(presentation, i));
    process.stdout.write('.');
  }
  console.log(`\n  ${ARRIVALS} arrivals injected\n`);

  console.log('  waiting for the engine to detect surge...\n');
  await sleep(7000);
  await snapshot('after surge');

  // ---------------------------------------------------------------- policy
  const during = await get('/protocol');
  const surgeEvents = await get('/audit?eventType=SURGE_STATE_CHANGED&limit=5');
  const entered = surgeEvents.events.find((e) => e.after?.state === 'entered');

  rule('What changed');
  if (!entered) {
    console.log(c.yellow('  Surge was not declared. Check the arrival rate against the site protocol.'));
  } else {
    const policy = entered.after.policyApplied;
    const metrics = entered.after.metrics;
    console.log(`  Arrival rate           ${metrics.arrivalsPerHour}/hr = ${c.bold(metrics.multiple + '×')} baseline`);
    console.log(`  Queue per nurse        ${c.bold(metrics.queuePerNurse)}`);
    if (metrics.multiple < SURGE_MULTIPLE) {
      // The engine measures a rolling hour of real arrival timestamps. Seeded
      // patients were backdated to create a spread of waits, so some of them sit
      // outside that window and the measured multiple lands below the injected
      // one. Reported rather than glossed: the figure on screen is the one the
      // engine actually acted on.
      console.log(
        c.dim(
          `                         ${ARRIVALS} were injected; the measured rate is lower because\n` +
            '                         seeded arrivals backdated past the rolling hour fall outside it.',
        ),
      );
    }
    console.log(`  Dashboard mode         ${c.bold(policy.dashboardMode)}  ${c.dim('(collapses to a top-N action list)')}`);
    console.log(`  Escalation threshold   ${c.bold(policy.escalationThreshold)}  ${c.dim('(widened — escalate on less uncertainty)')}`);
    console.log(`  ESI 3 sub-banding      ${c.bold(String(policy.esi3SubBandingEnabled))}  ${c.dim('(3A/3B by deterioration risk)')}`);
    console.log(
      `  Low-acuity recheck     every ${policy.lowAcuityReassessIntervalMs / 60000} min  ${c.dim('(more often, not less)')}`,
    );
  }

  rule('What did NOT change');
  const safeWaitsAfter = JSON.stringify(during.protocol.safeWaitMinutes);
  const unchanged = safeWaitsBefore === safeWaitsAfter;
  console.log(
    `  ${unchanged ? c.green('✓') : c.red('✗')} Safe waiting times are ${unchanged ? 'identical' : c.red('DIFFERENT')} to before surge`,
  );
  console.log(`    ${c.dim(safeWaitsAfter)}`);
  console.log(
    c.dim(
      '\n    A system under pressure has every incentive to relax these so the board\n' +
        '    looks calmer. Guardrails in the protocol layer make that impossible, and\n' +
        '    the table is written verbatim into every surge audit event as evidence.',
    ),
  );

  // -------------------------------------------------------------- sub-bands
  const queue = await get('/queue');
  const esi3 = queue.encounters.filter((e) => e.currentESI === 3);
  const banded = esi3.filter((e) => e.queue?.surgeSubBand);
  rule('ESI 3 sub-banding');
  console.log(
    `  ${esi3.length} patients at ESI 3, ${banded.length} sub-banded  ` +
      c.dim(`(${banded.filter((e) => e.queue.surgeSubBand === '3A').length} × 3A, ${banded.filter((e) => e.queue.surgeSubBand === '3B').length} × 3B)`),
  );
  console.log(
    c.dim(
      '  ESI 3 is around half of real ED volume, so one undifferentiated bucket is\n' +
        '  where surge triage actually breaks down. 3A is closer to breach or less certain.',
    ),
  );

  const verify = await get('/audit/verify');
  rule('Audit');
  console.log(`  ${verify.valid ? c.green('✓') : c.red('✗')} ${verify.message}`);
  console.log(`\n  ${c.dim('Open http://localhost:5173 — the board is now in action-list mode.')}\n`);
}

main().catch((error) => {
  console.error('\n  surge demo failed:', error.message);
  process.exit(1);
});
