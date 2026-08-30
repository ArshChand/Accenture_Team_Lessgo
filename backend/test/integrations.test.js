import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MOCK_LOOKUPS, createMockHospitalSystemsAdapter } from '../src/integrations/hospitalSystems.js';

/**
 * The hospital-systems adapter.
 *
 * The claim worth testing is narrow: this boundary is read-only, it can be
 * asked to fail like a real external system, and its shape is exactly what a
 * real adapter would need to implement to swap in behind it.
 */

describe('hospitalSystems adapter', () => {
  it('finds a known patient by phone number, ignoring formatting', async () => {
    const adapter = createMockHospitalSystemsAdapter({ latencyMs: 0 });
    const known = MOCK_LOOKUPS[0];
    const record = await adapter.lookupExternalRecord({ phone: `${known.phone.slice(0, 5)}-${known.phone.slice(5)}` });
    assert.ok(record);
    assert.equal(record.displayRef, known.displayRef);
  });

  it('finds a known patient by ABHA id', async () => {
    const adapter = createMockHospitalSystemsAdapter({ latencyMs: 0 });
    const known = MOCK_LOOKUPS[1];
    const record = await adapter.lookupExternalRecord({ abhaId: known.abhaId });
    assert.equal(record.displayRef, known.displayRef);
  });

  it('returns null for a patient the hospital system has never heard of', async () => {
    const adapter = createMockHospitalSystemsAdapter({ latencyMs: 0 });
    const record = await adapter.lookupExternalRecord({ phone: '0000000000' });
    assert.equal(record, null);
  });

  it('returns null rather than throwing when given no identifier at all', async () => {
    const adapter = createMockHospitalSystemsAdapter({ latencyMs: 0 });
    const record = await adapter.lookupExternalRecord({});
    assert.equal(record, null);
  });

  it('never returns a shared reference to its internal record store', async () => {
    const adapter = createMockHospitalSystemsAdapter({ latencyMs: 0 });
    const known = MOCK_LOOKUPS[0];
    const first = await adapter.lookupExternalRecord({ abhaId: known.abhaId });
    first.fullName = 'tampered';
    const second = await adapter.lookupExternalRecord({ abhaId: known.abhaId });
    assert.notEqual(second.fullName, 'tampered');
  });

  it('reports bed availability for every department with a consistent occupied/available split', async () => {
    const adapter = createMockHospitalSystemsAdapter({ latencyMs: 0 });
    const { departments, asOf, source } = await adapter.getBedAvailability();
    assert.ok(new Date(asOf).getTime() > 0);
    assert.ok(source.length > 0);
    assert.ok(departments.length >= 3);
    for (const dept of departments) {
      assert.ok(dept.capacity > 0);
      assert.ok(dept.occupied >= 0 && dept.occupied <= dept.capacity);
      assert.equal(dept.available, dept.capacity - dept.occupied);
    }
  });

  it('drifts occupancy by at most one bed per department per call, never past capacity', async () => {
    const adapter = createMockHospitalSystemsAdapter({ latencyMs: 0 });
    const first = await adapter.getBedAvailability();
    const second = await adapter.getBedAvailability();
    for (const before of first.departments) {
      const after = second.departments.find((d) => d.name === before.name);
      assert.ok(Math.abs(after.occupied - before.occupied) <= 1);
      assert.ok(after.occupied >= 0 && after.occupied <= after.capacity);
    }
  });

  it('surfaces an unreachable hospital system as a rejected promise, not a silent null', async () => {
    const adapter = createMockHospitalSystemsAdapter({ latencyMs: 0, failureRate: 1 });
    await assert.rejects(() => adapter.getBedAvailability(), /did not respond/);
    await assert.rejects(() => adapter.lookupExternalRecord({ phone: MOCK_LOOKUPS[0].phone }), /did not respond/);
  });

  it('defaults to a working adapter with no configuration', async () => {
    const adapter = createMockHospitalSystemsAdapter();
    const record = await adapter.lookupExternalRecord({ phone: MOCK_LOOKUPS[0].phone });
    assert.ok(record);
  });
});
