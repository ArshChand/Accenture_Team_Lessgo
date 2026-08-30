/**
 * The boundary between TriageHandler and the rest of a hospital's IT estate.
 *
 * The brief calls out integration with existing hospital systems — patient
 * records, bed management, staff rosters — as a real-world complexity, and one
 * that varies enormously in maturity from one site to another. Wiring that
 * directly into the scoring pipeline would repeat a mistake this codebase
 * already refuses to make elsewhere: an ESI has to be an auditable, testable
 * function of clinical evidence, not of a bed count that might be five minutes
 * stale by the time it reaches a nurse. So this module is a strict read-only
 * boundary, not a scoring input. Nothing it returns ever reaches `fusion.js`.
 *
 * The interface is two methods, each independently swappable:
 *
 *   lookupExternalRecord({ phone, abhaId })  — pull a summary from the
 *     hospital's EHR/HIS (or, in India, an ABDM-linked bridge) for a patient
 *     who has no local record yet. Read-only: it informs intake, it never
 *     writes anything back.
 *
 *   getBedAvailability()  — read-only department capacity, surfaced to staff
 *     as situational awareness alongside the queue, the way a real charge
 *     nurse already glances at the bed board while triaging.
 *
 * A hospital wiring this to its real HIS bridge and its real bed-management
 * system replaces `createMockHospitalSystemsAdapter`'s return value with an
 * object implementing the same two methods; nothing upstream — the routes,
 * the intake flow, the dashboard — changes. `createMockHospitalSystemsAdapter`
 * is that object for the prototype: canned data, simulated latency, and an
 * injectable failure mode, because "the hospital's other system is down" is a
 * normal case in production and this forces every caller to handle it as one
 * rather than as an afterthought.
 *
 * Staff rostering is deliberately not re-implemented here: the queue engine
 * already reads live nurse counts from the `clinicians` collection
 * (`queue/engine.js`'s `gatherSurgeMetrics`), and in a real deployment that
 * collection is exactly what a nightly or real-time sync from the hospital's
 * HR/roster system would populate. Duplicating that as a second, disconnected
 * mock roster here would demonstrate nothing that isn't already true of the
 * existing integration point.
 */

const MOCK_EXTERNAL_RECORDS = [
  {
    phone: '9845011234',
    abhaId: '91-2345-6789-0123',
    displayRef: 'EXT-4471',
    fullName: 'Suresh Rao',
    ageYears: 67,
    sex: 'male',
    baselineSBP: 148,
    baselineSpO2: 93,
    baselineHR: 78,
    chronicConditions: ['COPD', 'hypertension'],
    allergies: ['penicillin'],
    medications: [{ name: 'amlodipine', isAnticoagulant: false, isBetaBlocker: false }],
    lastVisit: '2026-06-14',
    source: 'Regional HIS bridge (mock)',
  },
  {
    phone: '9900188213',
    abhaId: '91-8812-4400-7765',
    displayRef: 'EXT-2290',
    fullName: 'Lakshmi Devi',
    ageYears: 74,
    sex: 'female',
    baselineSBP: 110,
    baselineSpO2: 97,
    baselineHR: 82,
    chronicConditions: ['type 2 diabetes', 'atrial fibrillation'],
    allergies: [],
    medications: [{ name: 'warfarin', isAnticoagulant: true, isBetaBlocker: false }],
    lastVisit: '2026-07-02',
    source: 'Regional HIS bridge (mock)',
  },
];

const BED_DEPARTMENTS = [
  { name: 'Resuscitation', capacity: 4 },
  { name: 'Majors', capacity: 18 },
  { name: 'Minors', capacity: 12 },
  { name: 'Paediatric bay', capacity: 6 },
];

const normalisePhone = (value) => String(value ?? '').replace(/\D/g, '');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {object} HospitalSystemsAdapter
 * @property {(identifier: {phone?: string, abhaId?: string}) => Promise<object|null>} lookupExternalRecord
 * @property {() => Promise<{asOf: string, departments: object[], source: string}>} getBedAvailability
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.latencyMs] simulated round-trip time to the hospital's system
 * @param {number} [opts.failureRate] 0–1, chance any call throws `hospital_system_unreachable`
 * @returns {HospitalSystemsAdapter}
 */
export function createMockHospitalSystemsAdapter({ latencyMs = 120, failureRate = 0 } = {}) {
  // A slowly-drifting baseline per department, seeded once at adapter
  // creation. Bed occupancy that never moves reads as an obviously fake demo;
  // occupancy that jumps randomly on every poll reads as broken. A small
  // random walk, clamped to capacity, gives a live-looking board without
  // either failure mode.
  const occupancy = new Map(
    BED_DEPARTMENTS.map((dept) => [dept.name, Math.round(dept.capacity * (0.55 + Math.random() * 0.25))]),
  );

  const maybeFail = async () => {
    if (latencyMs > 0) await wait(latencyMs);
    if (failureRate > 0 && Math.random() < failureRate) {
      const error = new Error('The hospital system did not respond.');
      error.code = 'HOSPITAL_SYSTEM_UNREACHABLE';
      throw error;
    }
  };

  return {
    async lookupExternalRecord({ phone, abhaId } = {}) {
      await maybeFail();
      if (!phone && !abhaId) return null;
      const match = MOCK_EXTERNAL_RECORDS.find(
        (record) =>
          (phone && normalisePhone(record.phone) === normalisePhone(phone)) ||
          (abhaId && record.abhaId === abhaId),
      );
      return match ? { ...match } : null;
    },

    async getBedAvailability() {
      await maybeFail();
      const departments = BED_DEPARTMENTS.map((dept) => {
        const step = Math.round(Math.random() * 2) - 1; // -1, 0, or 1
        const occupied = Math.max(0, Math.min(dept.capacity, occupancy.get(dept.name) + step));
        occupancy.set(dept.name, occupied);
        return { name: dept.name, capacity: dept.capacity, occupied, available: dept.capacity - occupied };
      });
      return { asOf: new Date().toISOString(), departments, source: 'Bed management system (mock)' };
    },
  };
}

/** The instance every route and demo script shares — swap this line in a real deployment. */
export const hospitalSystems = createMockHospitalSystemsAdapter();

/** Exported for tests and demos that want a known phone/ABHA id to look up. */
export const MOCK_LOOKUPS = MOCK_EXTERNAL_RECORDS.map(({ phone, abhaId, displayRef }) => ({
  phone,
  abhaId,
  displayRef,
}));
