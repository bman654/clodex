import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';
import { RUN_ROOT_ENV_VAR } from './vitest.global-setup.js';

// Vitest evaluates this setup file once per test file, so `sandboxRoot` is private to the test
// file currently running - no other worker or test file ever reads or writes it. That is what
// makes it safe to delete the whole tree from this file's own `afterAll`.
const sandboxParent = process.env[RUN_ROOT_ENV_VAR] ?? tmpdir();
const sandboxRoot = mkdtempSync(join(sandboxParent, 'clodex-vitest-sandbox-'));
const sandboxHome = join(sandboxRoot, 'clodex-home');

function establishSandboxFloor(): void {
  process.env.CLODEX_HOME = sandboxHome;
  // HOME is sandboxed too: the full suite supports this stronger floor for direct homedir() reads.
  process.env.HOME = sandboxRoot;
}

// Runs after every test in this file, including when tests fail or throw. Recursive because
// suites write real files under the sandbox home; `force` so a missing or already-removed tree
// never turns a green run red. Anything this misses is swept by the run-root teardown in
// vitest.global-setup.ts.
afterAll(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

establishSandboxFloor();
beforeEach(establishSandboxFloor);
