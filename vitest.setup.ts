import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach } from 'vitest';

const sandboxRoot = mkdtempSync(join(tmpdir(), 'clodex-vitest-sandbox-'));
const sandboxHome = join(sandboxRoot, 'clodex-home');

function establishSandboxFloor(): void {
  process.env.CLODEX_HOME = sandboxHome;
  // HOME is sandboxed too: the full suite supports this stronger floor for direct homedir() reads.
  process.env.HOME = sandboxRoot;
}

establishSandboxFloor();
beforeEach(establishSandboxFloor);
