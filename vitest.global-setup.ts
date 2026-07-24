import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RUN_ROOT_ENV_VAR = 'CLODEX_VITEST_RUN_ROOT';

/**
 * Creates one temp root per `vitest` run and removes it (with everything under it) when the run
 * ends. `vitest.setup.ts` nests each test file's sandbox inside this root, so a per-file sandbox
 * that never got to clean itself up - an import-time collection error kills the worker before any
 * `afterAll` runs - is still swept away here. The env var is read by workers, which are forked
 * after this hook and therefore inherit it.
 */
export default function setup(): () => void {
  const runRoot = mkdtempSync(join(tmpdir(), 'clodex-vitest-run-'));
  process.env[RUN_ROOT_ENV_VAR] = runRoot;

  return () => {
    delete process.env[RUN_ROOT_ENV_VAR];
    rmSync(runRoot, { recursive: true, force: true });
  };
}
