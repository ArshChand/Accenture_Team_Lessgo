/**
 * A small, varied cohort for looking at the dashboard during development.
 * The full 20-patient curated set with the mandated edge cases lands in
 * scripts/seed.js; this is deliberately quick and disposable.
 */
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

const measured = (value) => ({ value, source: 'measured', reliability: 1.0 });
const reported = (value) => ({ value, source: 'patient_reported', reliability: 0.6 });

await post('/clinicians', { name: 'Priya R.', role: 'triage_nurse', registrationNumber: 'KA-NUR-88214' });
await post('/clinicians', { name: 'Dr A. Rao', role: 'physician', registrationNumber: 'KA-MED-40122' });

const cases = [
  {
    ref: 'P-2481',
    age: 58,
    complaint: 'feeling unwell, sweating',
    language: 'kn-IN',
    text: 'nanage sustu tumba ide, bevaru barutta ide, jvara illa',
    asr: 0.52,
    conditions: ['diabetes', 'hypertension'],
    baselines: { systolicBP: 152, spo2: 96 },
    prior: true,
    vitals: {
      heartRate: measured(104),
      respiratoryRate: measured(20),
      systolicBP: measured(118),
      spo2: measured(95),
      temperatureC: measured(36.4),
      painScore: reported(2),
      observedCues: { diaphoresis: true, pallor: true },
    },
    ageMinutes: 12,
  },
  {
    ref: 'P-3310',
    age: 0.115,
    complaint: 'fever, feeding poorly',
    language: 'en-IN',
    text: 'my baby has a fever and is not feeding',
    asr: 0.9,
    vitals: {
      heartRate: measured(150),
      respiratoryRate: measured(48),
      temperatureC: measured(38.2),
      spo2: measured(97),
      observedCues: { playfulAndConsolable: true },
    },
    ageMinutes: 8,
  },
  {
    ref: 'P-1902',
    age: 71,
    complaint: 'fall at home, on warfarin',
    language: 'en-IN',
    text: 'I fell and hit my head',
    asr: 0.94,
    medications: [{ name: 'warfarin', isAnticoagulant: true }],
    prior: true,
    vitals: {
      heartRate: measured(78),
      respiratoryRate: measured(16),
      systolicBP: measured(138),
      spo2: measured(97),
      gcs: measured(15),
      temperatureC: measured(36.8),
    },
    ageMinutes: 34,
  },
  {
    ref: 'P-7745',
    age: 24,
    complaint: 'sore throat',
    language: 'en-IN',
    text: 'sore throat and a bit of a cough for two days',
    asr: 0.96,
    vitals: {
      heartRate: measured(74),
      respiratoryRate: measured(15),
      systolicBP: measured(120),
      spo2: measured(99),
      temperatureC: measured(37.2),
      gcs: measured(15),
      painScore: reported(3),
    },
    ageMinutes: 52,
  },
  {
    ref: 'P-5028',
    age: 34,
    complaint: 'abdominal pain',
    language: 'hi-IN',
    text: 'pet dard hai lekin bukhar nahi hai',
    asr: 0.86,
    vitals: {
      heartRate: measured(118),
      respiratoryRate: measured(19),
      systolicBP: measured(124),
      spo2: measured(98),
      temperatureC: measured(37.0),
      painScore: reported(3),
      observedCues: { guarding: true, diaphoresis: true },
    },
    ageMinutes: 21,
  },
];

for (const c of cases) {
  const { patient } = await post('/patients', {
    displayRef: c.ref,
    preferredLanguage: c.language,
    hasPriorRecord: Boolean(c.prior),
    chronicConditions: c.conditions ?? [],
    medications: c.medications ?? [],
    baselines: c.baselines ?? {},
    identity: { fullName: `Patient ${c.ref}`, phone: '+91-98xxxxxx00' },
  });

  const { encounter } = await post('/encounters', {
    patientRef: patient._id,
    ageYears: c.age,
    chiefComplaint: c.complaint,
    transcripts: [{ language: c.language, rawText: c.text, asrConfidence: c.asr, captureMode: 'scripted' }],
  });

  await post(`/encounters/${encounter._id}/vitals`, c.vitals);
  await post('/simulate/advance-time', { minutes: c.ageMinutes, encounterId: encounter._id });
  console.log(`  seeded ${c.ref} (waiting ${c.ageMinutes}m)`);
}

console.log('\n  done — open http://localhost:5173');
