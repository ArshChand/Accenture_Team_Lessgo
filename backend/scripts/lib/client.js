/**
 * Shared helpers for the demo scripts.
 *
 * These drive the running system over its own HTTP API rather than reaching into
 * the database. That is deliberate on two counts: it exercises the same routes a
 * real client uses, and it works identically whether the backend is running on
 * the in-memory driver or against MongoDB — the in-memory store lives inside the
 * server process, so a script that imported the repositories directly would be
 * talking to its own empty copy.
 */

export const API = process.env.API_URL ?? 'http://127.0.0.1:4000/api';

export async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workstation': 'DEMO-CLI' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.message ?? json.error ?? `${path} failed (${response.status})`);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

export async function get(path) {
  const response = await fetch(`${API}${path}`);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message ?? json.error ?? `${path} failed (${response.status})`);
  return json;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fail fast with a useful message rather than a stack trace against a dead port. */
export async function requireBackend() {
  try {
    const health = await get('/health');
    return health;
  } catch {
    console.error(
      `\n  Cannot reach the backend at ${API}.\n` +
        '  Start it first:  npm run dev:backend   (or npm run dev for everything)\n',
    );
    process.exit(1);
  }
}

export async function warnIfMlDown() {
  try {
    const info = await get('/model/info');
    if (!info.available) {
      console.log('  note: ML service reachable but no model loaded — scoring will use rules only.\n');
    }
    return info.available;
  } catch {
    console.log(
      '  note: ML service is not running. Scoring degrades to the rule engine alone,\n' +
        '        which is a supported mode but not the full demonstration.\n' +
        '        Start it with:  npm run dev:ml\n',
    );
    return false;
  }
}

// ---------------------------------------------------------------- formatting

export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

export function esiTag(esi) {
  if (esi === 1) return c.red(`ESI ${esi}`);
  if (esi === 2) return c.yellow(`ESI ${esi}`);
  if (esi === 3) return c.cyan(`ESI ${esi}`);
  return c.dim(`ESI ${esi}`);
}

export function rule(title) {
  console.log(`\n${c.bold(title)}\n${'─'.repeat(Math.max(title.length, 60))}`);
}
