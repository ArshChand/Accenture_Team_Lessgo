import mongoose from 'mongoose';

/**
 * A deliberately small MongoDB query subset, implemented for the in-memory driver.
 *
 * Scope is intentional rather than accidental: only the operators the application
 * actually uses are supported, and anything outside that set throws loudly instead
 * of silently returning wrong rows. If a future query needs an operator that isn't
 * here, the failure is a clear error at development time rather than a queue that
 * quietly drops a patient.
 *
 * Supported: implicit equality, $eq, $ne, $in, $nin, $gt, $gte, $lt, $lte,
 * $exists, $regex, $not, plus top-level $or / $and / $nor. Dotted paths resolve
 * through nested objects and match across array elements.
 */

const SUPPORTED_OPERATORS = new Set([
  '$eq',
  '$ne',
  '$in',
  '$nin',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$exists',
  '$regex',
  '$options',
  '$not',
]);

const isObjectId = (value) => value instanceof mongoose.Types.ObjectId;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !isObjectId(value);

/**
 * Equality that understands the three types Mongo compares structurally but
 * JavaScript does not: ObjectIds, Dates, and stringified ids.
 */
export function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (isObjectId(a) || isObjectId(b)) return String(a) === String(b);
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const bt = b instanceof Date ? b.getTime() : new Date(b).getTime();
    return at === bt;
  }
  return false;
}

/** Comparable scalar for ordering: Dates and ObjectIds reduce to sortable primitives. */
function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (isObjectId(value)) return String(value);
  return value;
}

function compare(a, b) {
  const ca = comparable(a);
  const cb = comparable(b);
  if (ca === cb) return 0;
  if (ca === undefined || ca === null) return -1;
  if (cb === undefined || cb === null) return 1;
  return ca < cb ? -1 : 1;
}

/**
 * Resolve a dotted path. Returns an array of candidate values, because a path
 * that crosses an array (`items.name`) matches if *any* element matches — the
 * same semantics Mongo uses.
 */
export function resolvePath(doc, path) {
  const segments = path.split('.');
  let current = [doc];

  for (const segment of segments) {
    const next = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        for (const element of node) {
          if (element !== null && typeof element === 'object' && segment in element) {
            next.push(element[segment]);
          }
        }
        continue;
      }
      if (typeof node === 'object' && segment in node) {
        next.push(node[segment]);
      }
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

function matchOperator(candidates, operator, operand, spec) {
  const present = candidates.length > 0 && candidates.some((c) => c !== undefined);

  switch (operator) {
    case '$eq':
      return candidates.some((c) => valuesEqual(c, operand));
    case '$ne':
      return !candidates.some((c) => valuesEqual(c, operand));
    case '$in':
      return candidates.some((c) => operand.some((o) => valuesEqual(c, o)));
    case '$nin':
      return !candidates.some((c) => operand.some((o) => valuesEqual(c, o)));
    case '$gt':
      return candidates.some((c) => compare(c, operand) > 0);
    case '$gte':
      return candidates.some((c) => compare(c, operand) >= 0);
    case '$lt':
      return candidates.some((c) => compare(c, operand) < 0);
    case '$lte':
      return candidates.some((c) => compare(c, operand) <= 0);
    case '$exists':
      return operand ? present : !present;
    case '$regex': {
      const re = operand instanceof RegExp ? operand : new RegExp(operand, spec.$options ?? '');
      return candidates.some((c) => typeof c === 'string' && re.test(c));
    }
    case '$options':
      // Handled alongside $regex.
      return true;
    case '$not':
      return !matchCondition(candidates, operand);
    default:
      throw new Error(`Unsupported query operator "${operator}" in the in-memory driver`);
  }
}

function matchCondition(candidates, condition) {
  if (condition instanceof RegExp) {
    return candidates.some((c) => typeof c === 'string' && condition.test(c));
  }

  if (isPlainObject(condition)) {
    const keys = Object.keys(condition);
    const operatorKeys = keys.filter((k) => k.startsWith('$'));

    if (operatorKeys.length > 0) {
      if (operatorKeys.length !== keys.length) {
        throw new Error(`Mixed operator and literal keys in condition: ${keys.join(', ')}`);
      }
      for (const key of operatorKeys) {
        if (!SUPPORTED_OPERATORS.has(key)) {
          throw new Error(`Unsupported query operator "${key}" in the in-memory driver`);
        }
      }
      return operatorKeys.every((key) => matchOperator(candidates, key, condition[key], condition));
    }
  }

  return candidates.some((c) => valuesEqual(c, condition));
}

/** True when `doc` satisfies `filter`. An empty filter matches everything. */
export function matchesFilter(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or') {
      if (!condition.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$and') {
      if (!condition.every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$nor') {
      if (condition.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key.startsWith('$')) {
      throw new Error(`Unsupported top-level query operator "${key}" in the in-memory driver`);
    }
    if (!matchCondition(resolvePath(doc, key), condition)) return false;
  }
  return true;
}

/**
 * Sort in place by a Mongo-style spec, e.g. `{ 'queue.priorityScore': -1, arrivalAt: 1 }`.
 * Later keys break ties on earlier ones, matching Mongo's behaviour.
 */
export function sortDocs(docs, sortSpec) {
  if (!sortSpec) return docs;
  const entries = Object.entries(sortSpec);
  if (entries.length === 0) return docs;

  return docs.sort((a, b) => {
    for (const [path, direction] of entries) {
      const av = resolvePath(a, path)[0];
      const bv = resolvePath(b, path)[0];
      const result = compare(av, bv);
      if (result !== 0) return direction < 0 ? -result : result;
    }
    return 0;
  });
}
