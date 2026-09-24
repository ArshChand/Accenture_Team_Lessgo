import { hospitalSystems } from '../integrations/hospitalSystems.js';
import { RESOURCE_CATALOGUE, resourceById } from './resources.js';

/**
 * A lightweight inventory tracker for the ten forecast resources.
 *
 * Beds are not counted here. They are read live from the bed-management adapter,
 * so the Capacity and Resources views can never disagree about how many beds are
 * free. Equipment and medicines are counted by this tracker, for sites with no
 * materials-management system to read from; a site that has one replaces this
 * module with an adapter exposing the same `snapshot` shape.
 *
 * Adjustments keep a short history per item. Stock movements are not clinical
 * acts and carry no patient data, so they do not go into the hash-chained audit
 * log; what they need is to be traceable, and a per-item history does that.
 */

/** Starting stock: deliberately below par on a few items, as a real shift would be. */
const STARTING_STOCK = {
  oxygen: 6,
  cardiac_monitor: 8,
  ventilator: 2,
  nebuliser: 4,
  iv_fluids: 24,
  antibiotics: 7,
  sedation_kit: 5,
  blood_units: 3,
};

const HISTORY_LIMIT = 20;
export const MAX_ADJUSTMENT = 100;

const stock = new Map();
const history = new Map();

export function resetInventory() {
  stock.clear();
  history.clear();
  for (const item of RESOURCE_CATALOGUE) {
    if (item.source !== 'tracker') continue;
    stock.set(item.id, STARTING_STOCK[item.id] ?? item.parLevel);
    history.set(item.id, []);
  }
}
resetInventory();

function inventoryError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function trackedItem(resourceId) {
  const item = resourceById(resourceId);
  if (!item) throw inventoryError(`Unknown resource "${resourceId}".`, 404);
  if (item.source !== 'tracker') {
    throw inventoryError(
      `${item.label} is read from the bed management system and cannot be adjusted here.`,
      409,
    );
  }
  return item;
}

function record(resourceId, entry) {
  const list = history.get(resourceId);
  list.unshift({ at: new Date().toISOString(), ...entry });
  list.length = Math.min(list.length, HISTORY_LIMIT);
}

/** Use (negative) or return/receive (positive) stock. Never goes below zero. */
export function adjustStock(resourceId, delta, { reason, by } = {}) {
  const item = trackedItem(resourceId);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADJUSTMENT) {
    throw inventoryError(`delta must be a non-zero whole number between -${MAX_ADJUSTMENT} and ${MAX_ADJUSTMENT}.`, 400);
  }
  const before = stock.get(item.id);
  const after = Math.max(0, before + delta);
  stock.set(item.id, after);
  record(item.id, { kind: delta > 0 ? 'received' : 'used', delta: after - before, before, after, reason, by });
  return { resourceId: item.id, available: after };
}

/** Bring an item back up to its par level. */
export function restock(resourceId, { by } = {}) {
  const item = trackedItem(resourceId);
  const before = stock.get(item.id);
  const after = Math.max(before, item.parLevel);
  stock.set(item.id, after);
  record(item.id, { kind: 'restocked', delta: after - before, before, after, by });
  return { resourceId: item.id, available: after };
}

/**
 * Current availability of every catalogue item.
 *
 * If the bed system is unreachable the bed rows say so (`available: null`) rather
 * than reporting zero: "unknown" and "none free" call for different actions.
 */
export async function snapshot() {
  let beds = null;
  let bedError = null;
  try {
    beds = await hospitalSystems.getBedAvailability();
  } catch (error) {
    bedError = error.message;
  }

  return RESOURCE_CATALOGUE.map((item) => {
    if (item.source === 'bed_system') {
      const departments = beds?.departments.filter((dept) => item.bedDepartments.includes(dept.name)) ?? [];
      const sum = (key) => departments.reduce((total, dept) => total + dept[key], 0);
      return {
        resourceId: item.id,
        label: item.label,
        category: item.category,
        unit: item.unit,
        source: item.source,
        adjustable: false,
        available: beds ? sum('available') : null,
        capacity: beds ? sum('capacity') : null,
        sourceError: bedError,
      };
    }
    return {
      resourceId: item.id,
      label: item.label,
      category: item.category,
      unit: item.unit,
      source: item.source,
      adjustable: true,
      available: stock.get(item.id),
      parLevel: item.parLevel,
      reorderLevel: item.reorderLevel,
      recentActivity: history.get(item.id).slice(0, 5),
    };
  });
}
