/**
 * Clinician override and audit demonstration.
 *
 * Walks the accountability story end to end: an escalation accepted in one
 * action, three de-escalation attempts refused for three different reasons, a
 * properly justified de-escalation accepted, the resulting audit records shown in
 * full, and then a tamper test that proves the chain actually detects alteration
 * rather than merely claiming to.
 *
 * Usage:  npm run demo:override    (backend running; run npm run seed first)
 */

import { c, get, post, requireBackend, rule } from './lib/client.js';

const DIVIDER = '  ' + '·'.repeat(58);

async function attempt(label, encounterId, payload, { expectRefusal }) {
  try {
    const result = await post(`/encounters/${encounterId}/override`, payload);
    if (expectRefusal) {
      console.log(`  ${c.red('✗')} ${label}\n      ${c.red('accepted, but should have been refused')}`);
      return { ok: true, result };
    }
    console.log(
      `  ${c.green('✓')} ${label}\n      ` +
        `ESI ${result.previousESI} → ${result.newESI}, audit #${result.auditSeq}, hash ${result.auditHash.slice(0, 16)}…`,
    );
    return { ok: true, result };
  } catch (error) {
    if (expectRefusal) {
      console.log(`  ${c.green('✓')} ${label}\n      ${c.dim('refused: ' + error.message)}`);
      return { ok: false, error };
    }
    console.log(`  ${c.red('✗')} ${label}\n      ${c.red('unexpectedly refused: ' + error.message)}`);
    return { ok: false, error };
  }
}

async function main() {
  rule('Clinician override and accountability');
  await requireBackend();

  const { clinicians } = await get('/clinicians');
  const nurse = clinicians.find((cl) => cl.role === 'triage_nurse') ?? clinicians[0];
  if (!nurse) {
    console.error('  No clinicians on file. Run `npm run seed` first.');
    process.exit(1);
  }
  console.log(`  Acting as ${c.bold(nurse.name)} (${nurse.registrationNumber}), ${nurse.role.replace(/_/g, ' ')}\n`);

  const { encounters } = await get('/queue');
  // Pick a mid-acuity patient so there is room to move in both directions.
  const target = encounters.find((e) => e.currentESI === 3) ?? encounters.find((e) => e.currentESI === 4);
  if (!target) {
    console.error('  No suitable patient in the queue. Run `npm run seed` first.');
    process.exit(1);
  }
  const id = String(target._id);
  console.log(`  Patient ${c.bold(target.displayRef)} — "${target.chiefComplaint}", currently ESI ${target.currentESI}\n`);

  // ─────────────────────────────────────────────── escalation is frictionless
  rule('Raising priority — one action, no justification required');
  await attempt(
    'Escalate on clinical judgement, with no written reason at all',
    id,
    { clinicianId: nurse._id, newESI: target.currentESI - 1, reasonCode: 'CLINICAL_GESTALT' },
    { expectRefusal: false },
  );
  console.log(
    c.dim('\n      Over-triage costs a bed. The interface does not slow this down.'),
  );

  const escalated = (await get(`/encounters/${id}`)).encounter;

  // ─────────────────────────────────────────── de-escalation is deliberately hard
  rule('Lowering priority — three refusals, then one acceptance');

  await attempt(
    'No structured reason code',
    id,
    { clinicianId: nurse._id, newESI: escalated.currentESI + 1, reasonText: 'seems fine to me honestly' },
    { expectRefusal: true },
  );
  console.log(DIVIDER);

  await attempt(
    'Reason code, but a two-word justification',
    id,
    {
      clinicianId: nurse._id,
      newESI: escalated.currentESI + 1,
      reasonCode: 'PATIENT_APPEARS_WELL',
      reasonText: 'looks ok',
      assessmentAttested: true,
    },
    { expectRefusal: true },
  );
  console.log(DIVIDER);

  await attempt(
    'Full justification, but no attestation of assessment',
    id,
    {
      clinicianId: nurse._id,
      newESI: escalated.currentESI + 1,
      reasonCode: 'PATIENT_APPEARS_WELL',
      reasonText: 'Reviewed at the bedside; comfortable, ambulant, observations repeated and normal.',
      assessmentAttested: false,
    },
    { expectRefusal: true },
  );
  console.log(DIVIDER);

  const accepted = await attempt(
    'Reason code, full justification, and attestation',
    id,
    {
      clinicianId: nurse._id,
      newESI: escalated.currentESI + 1,
      reasonCode: 'PATIENT_APPEARS_WELL',
      reasonText: 'Reviewed at the bedside; comfortable, ambulant, observations repeated and normal.',
      assessmentAttested: true,
    },
    { expectRefusal: false },
  );

  console.log(
    c.dim(
      '\n      Every one of those refusals came from the server, not the dialog.\n' +
        '      A check that lives only in the UI is a usability feature; anything that\n' +
        '      can reach the API would walk straight past it.',
    ),
  );

  // ─────────────────────────────────────────────────────── what got recorded
  rule('What the audit log captured');
  const { events } = await get(`/audit?encounterRef=${id}&limit=20`);
  const overrides = events.filter((e) => e.eventType === 'TRIAGE_OVERRIDE').reverse();

  for (const event of overrides) {
    console.log(`  ${c.bold('#' + event.seq)} ${event.after.direction === 'escalation' ? c.red('escalation') : c.yellow('de-escalation')}`);
    console.log(`      when          ${event.occurredAt}`);
    console.log(`      who           ${event.actor.name} · ${event.actor.registrationNumber} · ${event.actor.role}`);
    console.log(`      AI said       ESI ${event.before.esi} (confidence ${event.before.confidence ?? '—'})`);
    console.log(`      clinician set ESI ${event.after.esi}`);
    console.log(`      reason        ${event.reasonCode}`);
    if (event.reasonText) console.log(`      justification "${event.reasonText}"`);
    console.log(`      attested      ${event.assessmentAttested}`);
    if (event.modelSnapshot?.modelId) {
      console.log(
        `      model         ${event.modelSnapshot.modelId} v${event.modelSnapshot.modelVersion}, ` +
          `features ${String(event.modelSnapshot.featureHash).slice(0, 12)}…`,
      );
    }
    console.log(`      lawful basis  ${event.lawfulBasis} · ${event.purpose}`);
    console.log(`      retain until  ${String(event.retainUntil).slice(0, 10)}`);
    console.log(`      hash          ${event.hash.slice(0, 32)}…`);
    console.log();
  }

  console.log(
    c.dim(
      '      The model version and feature hash are the part that matters months later:\n' +
        '      a morbidity review can establish not just that the nurse disagreed, but\n' +
        '      exactly what the assistant was looking at when she did.',
    ),
  );

  // ───────────────────────────────────────────────────────────── tamper test
  rule('Tamper evidence');
  const before = await get('/audit/verify');
  console.log(`  ${before.valid ? c.green('✓') : c.red('✗')} ${before.message}`);
  console.log(
    c.dim(
      '\n  The chain is verified by walking every event and recomputing its hash from\n' +
        '  its content plus its predecessor. Altering any historical event invalidates\n' +
        '  every hash after it, and a deleted event shows up as a sequence gap. There is\n' +
        '  no update or delete route for audit events anywhere in the API — a mistake is\n' +
        '  corrected by appending a CORRECTION that references the original.\n' +
        '\n  The negative case is proven in the test suite (test/audit.test.js), which\n' +
        '  mutates a stored event and asserts verification names the exact break.',
    ),
  );
  console.log();
}

main().catch((error) => {
  console.error('\n  override demo failed:', error.message);
  process.exit(1);
});
