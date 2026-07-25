import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({ root: '' }));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: () => ({
      ...actual.userInfo(),
      homedir: sandbox.root || actual.userInfo().homedir,
    }),
  };
});

const sandboxRoot = mkdtempSync(join(tmpdir(), 'clodex-vitest-sandbox-'));
const sandboxHome = join(sandboxRoot, 'clodex-home');
sandbox.root = sandboxRoot;

function establishSandboxFloor(): void {
  process.env.CLODEX_HOME = sandboxHome;
  // HOME is sandboxed too: the full suite supports this stronger floor for direct homedir() reads.
  process.env.HOME = sandboxRoot;
}

establishSandboxFloor();
beforeEach(establishSandboxFloor);
