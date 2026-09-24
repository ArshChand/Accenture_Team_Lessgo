import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { connectDatabase, disconnectDatabase, repositories, resetDatabase } from '../src/db/index.js';
import { AGE_BAND, AUDIT_EVENT_TYPE, ENCOUNTER_STATUS } from '../src/clinical/constants.js';
import { WORSENING_COOLDOWN_MS, nextTokenNumber, reportWorsening } from '../src/services/patientFacing.js';
import { verifyAuditChain } from '../src/services/auditService.js';
import { createApp } from '../src/app.js';

before(async () => connectDatabase());
after(async () => disconnectDatabase());
beforeEach(async () => resetDatabase());

async function seedEncounter({ status = ENCOUNTER_STATUS.WAITING, minutesAgo = 25 } = {}) {
  const patient = await repositories.patients.create({
    displayRef: `P-${Math.floor(Math.random() * 9000) + 1000}`,
    sex: 'male',
    preferredLanguage: 'kn-IN',
    hasPriorRecord: false,
  });
  return repositories.encounters.create({
    patientRef: patient._id,
    displayRef: patient.displayRef,
    age: { ageYears: 58, band: AGE_BAND.ADULT },
    chiefComplaint: 'stomach pain',
    currentESI: 4,
    assignedBy: 'ai',
    status,
    tokenNumber: 14,
    arrivalAt: new Date(Date.now() - minutesAgo * 60000),
    queue: { safeWaitMinutes: 60, lastInformedAt: new Date(Date.now() - minutesAgo * 60000) },
  });
}

describe('token numbers', () => {
  it('never hands two simultaneous arrivals the same number', async () => {
    const tokens = await Promise.all(Array.from({ length: 8 }, () => nextTokenNumber()));
    assert.equal(new Set(tokens).size, tokens.length);
  });

  it('continues past the highest number already on record', async () => {
    const encounter = await seedEncounter();
    await repositories.encounters.updateById(encounter._id, { tokenNumber: 500 });
    assert.ok((await nextTokenNumber()) > 500);
  });
});

describe('"I feel worse"', () => {
  it('records the report, audits it, and returns an alert for the dashboard', async () => {
    const encounter = await seedEncounter();
    const { encounter: updated, alert, auditEvent } = await reportWorsening({ encounterId: encounter._id });

    assert.ok(updated.patientReportedWorseningAt);
    assert.equal(alert.kind, 'patient_reported_worse');
    assert.equal(alert.tokenNumber, 14);
    assert.equal(auditEvent.eventType, AUDIT_EVENT_TYPE.PATIENT_REPORTED_WORSENING);
    assert.equal((await verifyAuditChain()).valid, true);
  });

  it('does not reset the wait clock — an unseen patient has still waited', async () => {
    const encounter = await seedEncounter({ minutesAgo: 25 });
    const before = new Date(encounter.queue.lastInformedAt).getTime();
    const { encounter: updated } = await reportWorsening({ encounterId: encounter._id });
    assert.equal(new Date(updated.queue.lastInformedAt).getTime(), before);
  });

  it('does not page the nurse twice inside the cooldown', async () => {
    const encounter = await seedEncounter();
    await reportWorsening({ encounterId: encounter._id });
    await assert.rejects(reportWorsening({ encounterId: encounter._id }), (error) => error.status === 429);
    const later = new Date(Date.now() + WORSENING_COOLDOWN_MS + 1000);
    await reportWorsening({ encounterId: encounter._id, now: later });
  });

  it('refuses once the patient is already with the care team', async () => {
    const encounter = await seedEncounter({ status: ENCOUNTER_STATUS.IN_TREATMENT });
    await assert.rejects(reportWorsening({ encounterId: encounter._id }), (error) => error.status === 409);
  });
});

describe('staff session', () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer(createApp());
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  const attempt = (body) =>
    fetch(`${base}/staff/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('opens the nurse view with the right PIN', async () => {
    const response = await attempt({ role: 'nurse', pin: '1234' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).role, 'nurse');
  });

  it('refuses a wrong PIN and an unknown role', async () => {
    assert.equal((await attempt({ role: 'ed_head', pin: '1234' })).status, 401);
    assert.equal((await attempt({ role: 'superuser', pin: '1234' })).status, 400);
  });
});
