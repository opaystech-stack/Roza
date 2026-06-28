/**
 * Entrypoint — Req 1.3, 1.4.
 *
 * Thin module that delegates to {@link start} (the fail-fast startup sequence in
 * `bootstrap.ts`). The call is guarded so it only runs when this file is the
 * process entrypoint (e.g. `node dist/index.js`), keeping the module
 * import-safe: tooling and tests can import it without triggering a real
 * startup, a real database open, or a `process.exit`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { start } from './bootstrap.js';

/** True when this module is the file Node was invoked with directly. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  start();
}
