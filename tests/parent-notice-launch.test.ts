// tests/parent-notice-launch.test.ts
//
// The behavior under test is what reaches the REAL file descriptor 2 while a
// spawned Claude Code owns the terminal. Vitest replaces the worker's console
// and stdio, so an in-process assertion here would measure the harness, not the
// product. Every case therefore spawns a plain Node process that drives the real
// `launchClaude` (tests/helpers/parent-notice-probe.ts) and asserts on the bytes
// that process actually wrote.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Kept in sync with the probe by hand: importing it would EXECUTE it here.
const NOTICE_TEXT = 'clodex: warning: probe-notice-must-reach-the-terminal';
const MUTED_TEXT = 'probe-plain-write-must-stay-muted';

const PROBE = fileURLToPath(new URL('./helpers/parent-notice-probe.ts', import.meta.url));
const REGISTER_HOOK = fileURLToPath(
  new URL('./helpers/register-ts-resolve-hook.mjs', import.meta.url),
);

function runProbe(scratch: string, extra: string[] = []): Promise<{ stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--import', REGISTER_HOOK, PROBE, scratch, ...extra],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLODEX_HOME: join(scratch, 'home') } },
    );
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdout.on('data', () => { /* the fake claude prints nothing */ });
    child.on('error', reject);
    child.on('exit', code => resolve({ stderr, code: code ?? -1 }));
  });
}

describe('parent notices while Claude Code owns the terminal', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'clodex-parent-notice-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('delivers an emitted notice to the real stderr while the child is running', async () => {
    const { stderr, code } = await runProbe(scratch);

    expect(code).toBe(0);
    expect(stderr).toContain('probe-done exit=0');
    expect(stderr).toContain(NOTICE_TEXT);
  }, 30_000);

  it('still mutes ordinary parent writes so the child TUI is protected', async () => {
    const { stderr } = await runProbe(scratch);

    expect(stderr).toContain(NOTICE_TEXT);
    expect(stderr).not.toContain(MUTED_TEXT);
  }, 30_000);

  it('emits the notice as exactly one newline-terminated line', async () => {
    const { stderr } = await runProbe(scratch);

    expect(stderr.split('\n').filter(line => line.includes(NOTICE_TEXT))).toEqual([NOTICE_TEXT]);
  }, 30_000);

  it('still copies both notices and muted writes into the --debug-file log', async () => {
    const { stderr } = await runProbe(scratch, ['--with-debug-file']);
    const debugLog = readFileSync(join(scratch, 'debug.log'), 'utf8');

    // The notice reaches the terminal AND the traced launch's log, and the
    // pre-existing copy of ordinary muted writes is unchanged.
    expect(stderr).toContain(NOTICE_TEXT);
    expect(debugLog).toContain(`[parent] ${NOTICE_TEXT}`);
    expect(debugLog).toContain(`[parent] ${MUTED_TEXT}`);
  }, 30_000);
});
