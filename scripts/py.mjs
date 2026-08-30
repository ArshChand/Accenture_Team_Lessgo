#!/usr/bin/env node
/**
 * Cross-platform Python launcher for npm scripts.
 *
 * A stock Windows install from python.org registers `python` (and the `py`
 * launcher) but not `python3` — so a script hardcoding `python3` silently
 * fails to start on Windows while the rest of `concurrently`'s Node-based
 * processes come up fine, which looks exactly like "the ML service just
 * isn't running" with no error surfaced anywhere. This tries each candidate
 * in turn and only reports failure once none of them exist.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const candidates = ['python3', 'python'];

for (const cmd of candidates) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error && result.error.code === 'ENOENT') continue;
  process.exit(result.status ?? 0);
}

console.error(
  `Could not find a Python interpreter. Tried: ${candidates.join(', ')}. Install Python 3.11+ and ensure it is on PATH.`,
);
process.exit(1);
