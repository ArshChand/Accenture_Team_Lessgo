import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositories } from '../db/index.js';
import { getDefaultProtocol, loadProtocol, validateProtocol } from '../clinical/protocol.js';

const protocolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'clinical', 'protocols');

/**
 * Resolves which clinical protocol the running instance is operating under.
 *
 * The protocol is read once and cached, because it is consulted on every scoring
 * run and every queue tick. It is deliberately not hot-reloaded on a timer: a
 * threshold silently changing underneath a nurse mid-shift would make the
 * assistant's behaviour unexplainable. Changing the active protocol is an
 * explicit act that invalidates the cache and is worth an audit event.
 */

let cached = null;
let cachedSiteId = null;

/** Read one of the protocol documents bundled with the source. */
export function loadBundledProtocol(name) {
  return JSON.parse(readFileSync(join(protocolsDir, `${name}.json`), 'utf8'));
}

/** Names of every bundled protocol, without the .json extension. */
export function listBundledProtocols() {
  return readdirSync(protocolsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''));
}

/**
 * Load and activate a site's protocol.
 *
 * Resolution order: the SiteProtocol row for `siteId`, else a bundled document of
 * that name, else the reference protocol. Whatever is found is merged over the
 * defaults and validated; an invalid protocol throws rather than being silently
 * partially applied, because a half-applied safety table is worse than a refused
 * start.
 */
export async function activateProtocol(siteId = 'default') {
  let overrides = {};
  let source = 'reference';

  const stored = await repositories.siteProtocols?.findOne({ siteId });
  if (stored) {
    overrides = stored.overrides ?? {};
    source = 'database';
  } else if (siteId !== 'default' && listBundledProtocols().includes(siteId)) {
    overrides = loadBundledProtocol(siteId);
    source = 'bundled';
  }

  const protocol = loadProtocol(overrides);
  cached = protocol;
  cachedSiteId = siteId;
  return { protocol, source, siteId };
}

/**
 * The protocol in force. Falls back to the reference protocol when nothing has
 * been activated yet, so pure functions and tests do not need to bootstrap.
 */
export function getActiveProtocol() {
  cached ??= getDefaultProtocol();
  return cached;
}

export const getActiveSiteId = () => cachedSiteId ?? 'default';

/** Drop the cache. Used by tests and after a protocol is changed. */
export function clearProtocolCache() {
  cached = null;
  cachedSiteId = null;
}

/**
 * Write the bundled protocol documents into the database so a deployment starts
 * with the reference protocol plus the two illustrative site configurations. Each
 * is validated before it is stored — an invalid document is recorded as invalid
 * rather than being quietly accepted and failing later at the bedside.
 */
export async function seedBundledProtocols({ activeSiteId = 'default' } = {}) {
  const results = [];

  for (const name of listBundledProtocols()) {
    const document = loadBundledProtocol(name);
    const { valid, errors } = validateProtocol(
      name === 'default' ? document : { ...getDefaultProtocol(), ...document },
    );

    const existing = await repositories.siteProtocols.findOne({ siteId: document.siteId });
    const payload = {
      siteId: document.siteId,
      siteName: document.siteName,
      siteType: document.siteType,
      version: document.version,
      description: document.description,
      overrides: name === 'default' ? {} : document,
      active: document.siteId === activeSiteId,
      lastValidation: { valid, errors, checkedAt: new Date() },
    };

    if (existing) {
      await repositories.siteProtocols.updateById(existing._id, payload);
    } else {
      await repositories.siteProtocols.create(payload);
    }
    results.push({ siteId: document.siteId, valid, errors });
  }

  return results;
}
