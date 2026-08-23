import mongoose from 'mongoose';
import { matchesFilter, sortDocs } from './query.js';

/**
 * The repository layer.
 *
 * Both drivers are backed by the *same* Mongoose schemas — the schema is the
 * schema of record whether documents land in MongoDB or in a Map. The in-memory
 * driver constructs real Mongoose documents to get identical casting, defaults,
 * enum checks and required-field validation; it only differs in where the result
 * is stored.
 *
 * Contract, held by both drivers:
 *   - every method returns plain JavaScript objects, never Mongoose documents,
 *     so no lazy hydration or `.save()` can leak into application code;
 *   - reads return deep copies, so a caller mutating a result cannot corrupt the
 *     store and mask a missing write;
 *   - `updateById` revalidates the whole document against the schema.
 *
 * Why this exists: hospitals at different levels of technical maturity are a
 * stated constraint, and so is a prototype that has to run on a demo laptop with
 * no database installed. The same code path serves both.
 */

const isObjectId = (value) => value instanceof mongoose.Types.ObjectId;

/** ObjectIds are immutable, so they are shared rather than copied. */
function cloneValue(value) {
  if (value === null || value === undefined) return value;
  if (isObjectId(value)) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = cloneValue(val);
    return out;
  }
  return value;
}

function setPath(target, path, value) {
  const segments = path.split('.');
  let node = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (node[segment] === null || typeof node[segment] !== 'object' || Array.isArray(node[segment])) {
      node[segment] = {};
    }
    node = node[segment];
  }
  node[segments[segments.length - 1]] = value;
}

function getPath(target, path) {
  return path.split('.').reduce((node, segment) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    return node[segment];
  }, target);
}

/**
 * Accepts either a plain patch (`{ status: 'waiting' }`) or explicit operators,
 * and always produces operator form. Plain patches are treated as `$set`, which
 * means dotted keys do a targeted field update rather than replacing a whole
 * sub-document — the behaviour callers expect from Mongo.
 *
 * A document that mixes a plain field with an operator (`{ foo: 1, $inc: {...} }`)
 * is rejected rather than partially applied. Real MongoDB refuses this shape
 * outright ("Unknown modifier") rather than silently dropping the plain field —
 * matching that here means a mistake at the call site is a loud error during
 * development, not a decay field that quietly stops updating in production.
 */
export function normalizeUpdate(update) {
  const keys = Object.keys(update);
  const operatorKeys = keys.filter((key) => key.startsWith('$'));

  if (operatorKeys.length > 0 && operatorKeys.length !== keys.length) {
    throw new Error(
      `Cannot mix a plain field with an update operator in one call: ${keys.join(', ')}. ` +
        `Use { $set: { ... }, ${operatorKeys.join(', ')}: {...} } instead.`,
    );
  }
  if (operatorKeys.length > 0) return update;
  return { $set: update };
}

class BaseRepository {
  constructor(Model) {
    this.Model = Model;
    this.name = Model.modelName;
  }
}

export class MemoryRepository extends BaseRepository {
  constructor(Model) {
    super(Model);
    this.store = new Map();
    this.uniquePaths = Object.entries(Model.schema.paths)
      .filter(([, path]) => path.options?.unique === true)
      .map(([name]) => name);
  }

  #validated(data) {
    const doc = new this.Model(data);
    const error = doc.validateSync();
    if (error) throw error;
    return doc.toObject({ depopulate: true, virtuals: false, flattenMaps: true });
  }

  #applyTimestamps(obj, isNew) {
    const timestamps = this.Model.schema.options?.timestamps;
    if (!timestamps) return;
    const now = new Date();
    const wantsCreated = timestamps === true || timestamps?.createdAt;
    const wantsUpdated = timestamps === true || timestamps?.updatedAt;
    if (isNew && wantsCreated && !obj.createdAt) obj.createdAt = now;
    if (wantsUpdated) obj.updatedAt = now;
  }

  /**
   * Mirrors the unique indexes MongoDB would enforce. Without this the two
   * drivers would disagree about whether a duplicate audit sequence number is an
   * error, which is exactly the kind of divergence that makes a fallback driver
   * untrustworthy.
   */
  #assertUnique(candidate, ignoreId = null) {
    for (const path of this.uniquePaths) {
      const value = getPath(candidate, path);
      if (value === undefined || value === null) continue;
      for (const [id, existing] of this.store) {
        if (ignoreId && id === String(ignoreId)) continue;
        if (String(getPath(existing, path)) === String(value)) {
          const error = new Error(
            `E11000 duplicate key error: ${this.name}.${path} already has value ${String(value)}`,
          );
          error.code = 11000;
          throw error;
        }
      }
    }
  }

  async create(data) {
    const obj = this.#validated(data);
    this.#applyTimestamps(obj, true);
    this.#assertUnique(obj);
    this.store.set(String(obj._id), cloneValue(obj));
    return cloneValue(obj);
  }

  async createMany(items) {
    const created = [];
    for (const item of items) created.push(await this.create(item));
    return created;
  }

  async findById(id) {
    if (!id) return null;
    const found = this.store.get(String(id));
    return found ? cloneValue(found) : null;
  }

  async findOne(filter = {}, options = {}) {
    const [first] = await this.find(filter, { ...options, limit: 1 });
    return first ?? null;
  }

  async find(filter = {}, { sort, limit, skip = 0 } = {}) {
    let results = [];
    for (const doc of this.store.values()) {
      if (matchesFilter(doc, filter)) results.push(doc);
    }
    if (sort) results = sortDocs(results, sort);
    if (skip) results = results.slice(skip);
    if (limit !== undefined) results = results.slice(0, limit);
    return results.map(cloneValue);
  }

  async count(filter = {}) {
    let total = 0;
    for (const doc of this.store.values()) {
      if (matchesFilter(doc, filter)) total += 1;
    }
    return total;
  }

  async updateById(id, update) {
    const existing = this.store.get(String(id));
    if (!existing) return null;

    const draft = cloneValue(existing);
    const operators = normalizeUpdate(update);

    for (const [path, value] of Object.entries(operators.$set ?? {})) {
      setPath(draft, path, value);
    }
    for (const [path, delta] of Object.entries(operators.$inc ?? {})) {
      setPath(draft, path, (getPath(draft, path) ?? 0) + delta);
    }
    for (const [path, value] of Object.entries(operators.$push ?? {})) {
      const arr = getPath(draft, path);
      setPath(draft, path, Array.isArray(arr) ? [...arr, value] : [value]);
    }
    for (const [path, unset] of Object.entries(operators.$unset ?? {})) {
      if (unset) setPath(draft, path, undefined);
    }

    // Revalidate the whole document, matching `runValidators` on the Mongo side.
    const validated = this.#validated(draft);
    validated.createdAt = existing.createdAt;
    this.#applyTimestamps(validated, false);
    this.#assertUnique(validated, id);

    this.store.set(String(id), cloneValue(validated));
    return cloneValue(validated);
  }

  async deleteMany(filter = {}) {
    let deleted = 0;
    for (const [id, doc] of [...this.store]) {
      if (matchesFilter(doc, filter)) {
        this.store.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class MongoRepository extends BaseRepository {
  async create(data) {
    const doc = await this.Model.create(data);
    return doc.toObject({ depopulate: true, virtuals: false });
  }

  async createMany(items) {
    const docs = await this.Model.insertMany(items, { ordered: true });
    return docs.map((doc) => doc.toObject({ depopulate: true, virtuals: false }));
  }

  async findById(id) {
    if (!id) return null;
    return this.Model.findById(id).lean().exec();
  }

  async findOne(filter = {}, { sort } = {}) {
    return this.Model.findOne(filter).sort(sort).lean().exec();
  }

  async find(filter = {}, { sort, limit, skip = 0 } = {}) {
    let query = this.Model.find(filter);
    if (sort) query = query.sort(sort);
    if (skip) query = query.skip(skip);
    if (limit !== undefined) query = query.limit(limit);
    return query.lean().exec();
  }

  async count(filter = {}) {
    return this.Model.countDocuments(filter).exec();
  }

  async updateById(id, update) {
    return this.Model.findByIdAndUpdate(id, normalizeUpdate(update), {
      new: true,
      runValidators: true,
    })
      .lean()
      .exec();
  }

  async deleteMany(filter = {}) {
    const result = await this.Model.deleteMany(filter).exec();
    return result.deletedCount ?? 0;
  }
}
