/**
 * Live demonstration of the queue engine over a real Socket.IO connection.
 *
 * Shows the "Continuous Re-Triage" loop doing the thing it exists to do: a
 * patient triaged as stable on arrival sits in the queue, ages past their safe
 * waiting time, and is escalated by the system without anyone asking it to —
 * with the alert pushed to the dashboard the moment it happens.
 *
 * Run with the backend up (`npm run dev` in backend/), then: node scripts/liveQueueCheck.mjs
 */
import { io as ioClient } from 'socket.io-client';

const API = 'http://127.0.0.1:4000/api';

const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const get = async (path) => (await fetch(`${API}${path}`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

const received = [];
const socket = ioClient('http://127.0.0.1:4000/queue', { transports: ['websocket'] });

await new Promise((resolve, reject) => {
  socket.on('connect', resolve);
  socket.on('connect_error', reject);
  setTimeout(() => reject(new Error('socket connect timeout')), 5000);
});
console.log(`\n[${stamp()}] dashboard connected to /queue over websocket\n`);

for (const event of ['queue:patch', 'patient:alert', 'surge:state']) {
  socket.on(event, (payload) => {
    received.push({ event, payload, at: Date.now() });
    if (event === 'patient:alert') {
      const p = payload;
      if (p.kind === 'wait_breach') {
        console.log(
          `[${stamp()}]  >> PUSHED ALERT [wait breach]  ${p.displayRef}: ESI ${p.esi}, ` +
            `waited ${p.minutesWaiting}m against a ${p.safeWaitMinutes}m safe wait (audit #${p.auditSeq})`,
        );
      } else if (p.kind === 'deterioration') {
        console.log(
          `[${stamp()}]  >> PUSHED ALERT [deterioration]  ${p.displayRef}: ` +
            `re-triaged ESI ${p.fromESI} -> ${p.toESI} after ${p.minutesWaiting}m waiting`,
        );
      }
    }
    if (event === 'surge:state') {
      console.log(
        `[${stamp()}]  >> SURGE ${payload.transition.toUpperCase()} (${payload.trigger}): ` +
          `${payload.metrics.arrivalsPerHour}/hr = ${payload.metrics.multiple}x baseline, ` +
          `dashboard -> ${payload.policyApplied.dashboardMode}`,
      );
    }
  });
}

// --- a patient who looks stable on arrival -----------------------------------
const { patient } = await post('/patients', {
  displayRef: `P-${Date.now().toString().slice(-6)}`,
  hasPriorRecord: false,
});
const { encounter } = await post('/encounters', {
  patientRef: patient._id,
  ageYears: 62,
  chiefComplaint: 'abdominal pain',
  transcripts: [{ language: 'en-IN', rawText: 'stomach pain since yesterday', asrConfidence: 0.92 }],
});
await post(`/encounters/${encounter._id}/vitals`, {
  heartRate: { value: 92, source: 'measured', reliability: 1.0 },
  respiratoryRate: { value: 18, source: 'measured', reliability: 1.0 },
  systolicBP: { value: 128, source: 'measured', reliability: 1.0 },
  spo2: { value: 97, source: 'measured', reliability: 1.0 },
  temperatureC: { value: 37.1, source: 'measured', reliability: 1.0 },
  gcs: { value: 15, source: 'measured', reliability: 1.0 },
  painScore: { value: 4, source: 'patient_reported', reliability: 0.6 },
});

let { encounter: current } = await get(`/encounters/${encounter._id}`);
console.log(
  `[${stamp()}] ${current.displayRef} triaged ESI ${current.currentESI} ` +
    `(safe wait ${current.queue.safeWaitMinutes}m) — stable, joins the queue\n`,
);

// --- let the clock run --------------------------------------------------------
console.log(`[${stamp()}] simulating 20 minutes of waiting...`);
await post('/simulate/advance-time', { minutes: 20, encounterId: encounter._id });
await sleep(6000);

({ encounter: current } = await get(`/encounters/${encounter._id}`));
console.log(
  `[${stamp()}] after 20m: ${current.queue.decayStatus.toUpperCase()} ` +
    `(ratio ${current.queue.decayRatio}, priority ${current.queue.priorityScore})\n`,
);

console.log(`[${stamp()}] simulating a further 20 minutes...`);
await post('/simulate/advance-time', { minutes: 20, encounterId: encounter._id });
await sleep(7000);

({ encounter: current } = await get(`/encounters/${encounter._id}`));
console.log(
  `[${stamp()}] after 40m: ${current.queue.decayStatus.toUpperCase()} ` +
    `(ratio ${current.queue.decayRatio}, priority ${current.queue.priorityScore}), ` +
    `now ESI ${current.currentESI}, reassessed ${current.queue.reassessCount}x\n`,
);

// --- what the dashboard has been told ----------------------------------------
const patches = received.filter((r) => r.event === 'queue:patch');
const alerts = received.filter((r) => r.event === 'patient:alert');
console.log(`[${stamp()}] dashboard received ${patches.length} queue:patch and ${alerts.length} patient:alert pushes`);

const poll = await get('/queue');
console.log(`[${stamp()}] polling fallback /api/queue agrees: ${poll.count} waiting encounters`);

const verify = await get('/audit/verify');
console.log(`[${stamp()}] audit chain: ${verify.message}\n`);

socket.close();
process.exit(0);
