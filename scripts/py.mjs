#!/usr/bin/env node
/**
 * Cross-platform Python launcher for npm scripts.
 *
 * A stock Windows install from python.org registers `python` (and the `py`
 * launcher) but not `python3` — so a script hardcoding `python3` silently
 * fails to start on Windows while the rest of `concurrently`'s Node-based
 * processes come up fine, which looks exactly like "the ML service just
 * isn't running" with no error surfaced anywhere. This tries each candidate
 * in turn and only reports failure once none of them work.
 *
 * Windows also ships `python`/`python3` as App Execution Alias stubs even
 * when Python itself is not installed: the stub spawns fine (no ENOENT), but
 * prints a "Python was not found" message and exits with code 9009. That is
 * indistinguishable from a real command failure unless we special-case it,
 * so a 9009 exit is treated the same as "command not found" and we move on
 * to the next candidate rather than propagating that exit code as if it were
 * the script's own failure.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const candidates = ['python3', 'python', 'py'];
const WINDOWS_ALIAS_STUB_EXIT_CODE = 9009;

for (const cmd of candidates) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error && result.error.code === 'ENOENT') continue;
  if (result.status === WINDOWS_ALIAS_STUB_EXIT_CODE) continue;
  process.exit(result.status ?? 0);
}

console.error(
  `Could not find a working Python interpreter. Tried: ${candidates.join(', ')}.\n` +
    'On Windows, "python"/"python3" often resolve to a Microsoft Store shortcut even when ' +
    'Python is not actually installed. Install it from https://python.org (check "Add ' +
    'python.exe to PATH") or run "winget install Python.Python.3.12", then reopen your ' +
    'terminal — or disable the shortcut under Settings > Apps > Advanced app settings > ' +
    'App execution aliases.',
);
process.exit(1);
