// tests/parent-notice-launch.test.ts
//
// The behavior under test is what reaches the REAL terminal, and when, while a
// spawned Claude Code owns it. Vitest replaces the worker's console and stdio,
// so an in-process assertion here would measure the harness, not the product.
// Every case therefore drives the real `launchClaude` in a plain Node process
// (tests/helpers/parent-notice-probe.ts) and asserts on the bytes that process
// actually wrote. The probe runs once per mode, in beforeAll, because a Node
// boot per assertion is the dominant cost of this file.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Kept in sync with the probe by hand: importing it would EXECUTE it here.
const NOTICE_TEXT = 'clodex: warning: probe-notice-must-reach-the-terminal';
const AFTER_EXIT_TEXT = 'clodex: warning: probe-notice-after-child-exit';
const MUTED_TEXT = 'probe-plain-write-must-stay-muted';
const CHILD_LAST = 'CHILD-LAST';

const PROBE = fileURLToPath(new URL('./helpers/parent-notice-probe.ts', import.meta.url));
const REGISTER_HOOK = fileURLToPath(
  new URL('./helpers/register-ts-resolve-hook.mjs', import.meta.url),
);
const NODE_ARGS = ['--experimental-strip-types', '--no-warnings', '--import', REGISTER_HOOK];
/** Vitest's per-test timeout cannot cancel a subprocess, so the harness owns one. */
const PROBE_TIMEOUT_MS = 25_000;

const live = new Set<ChildProcess>();

function track(child: ChildProcess): ChildProcess {
  live.add(child);
  child.on('exit', () => live.delete(child));
  return child;
}

/** Resolves when the tracked child exits, or kills it and rejects on timeout. */
function awaitExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('probe timed out'));
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve(code ?? -1); });
  });
}

describe('parent notices while Claude Code owns the terminal', () => {
  let root: string;
  let plain: { output: string; code: number; dir: string };
  let traced: { output: string; code: number; dir: string };
  let signalled: { output: string; code: number; dir: string };
  let flooded: { output: string; code: number; dir: string };
  let epipeStatus: string;

  function scratchFor(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Runs the probe with stdout and stderr merged into one file, preserving order. */
  async function runProbeMerged(
    name: string,
    mode?: string,
  ): Promise<{ output: string; code: number; dir: string }> {
    const dir = scratchFor(name);
    const outputPath = join(dir, 'merged.out');
    const fd = openSync(outputPath, 'w');
    try {
      const child = track(spawn(
        process.execPath,
        [...NODE_ARGS, PROBE, dir, ...(mode ? [mode] : [])],
        { stdio: ['ignore', fd, fd], env: { ...process.env, CLODEX_HOME: join(dir, 'home') } },
      ));
      const code = await awaitExit(child);
      return { output: readFileSync(outputPath, 'utf8'), code, dir };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * `clodex claude 2>&1 | head -n 1` is ordinary usage. The child's first line
   * satisfies head, which exits and closes the pipe; the deferred flush then
   * writes into a dead fd. Returns the probe's own exit status, captured on fd 3
   * so the closed pipe cannot swallow it.
   */
  async function runProbeUnderClosedPipe(): Promise<string> {
    const dir = scratchFor('epipe');
    const statusPath = join(dir, 'probe-status');
    const quoted = [process.execPath, ...NODE_ARGS, PROBE, dir, '--epipe']
      .map(part => `"${part}"`).join(' ');
    const script = `{ ${quoted}; echo "$?" >&3; } 3>"${statusPath}" 2>&1 | head -n 1`;
    const child = track(spawn('/bin/sh', ['-c', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CLODEX_HOME: join(dir, 'home') },
    }));
    await awaitExit(child);
    return readFileSync(statusPath, 'utf8').trim();
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'clodex-parent-notice-'));
    [plain, traced, signalled, flooded, epipeStatus] = await Promise.all([
      runProbeMerged('plain'),
      runProbeMerged('traced', '--with-debug-file'),
      runProbeMerged('signalled', '--signal'),
      runProbeMerged('flooded', '--flood'),
      runProbeUnderClosedPipe(),
    ]);
  }, 120_000);

  afterAll(() => {
    // Kill anything still alive BEFORE removing the scratch tree: the fake claude
    // polls for a release file inside it, so deleting first would strand it.
    for (const child of live) child.kill('SIGKILL');
    live.clear();
    rmSync(root, { recursive: true, force: true });
  });

  it('holds a notice until the child has exited, then delivers it', () => {
    expect(plain.code).toBe(0);
    expect(plain.output).toContain(NOTICE_TEXT);
    // THE invariant: nothing clodex writes may land inside the child's output.
    // A live write shows up between the child's first and last line — where, on
    // a real TUI, it paints into a half-drawn frame or onto the prompt.
    expect(plain.output.indexOf(NOTICE_TEXT)).toBeGreaterThan(plain.output.indexOf(CHILD_LAST));
    expect(plain.output).toContain('probe-done exit=0');
  });

  it('never lets an ordinary parent write reach the terminal at all', () => {
    // The mute's original purpose: only opted-in notices are deferred-and-shown;
    // everything else stays swallowed exactly as before.
    expect(plain.output).not.toContain(MUTED_TEXT);
  });

  it('releases the sink at exit so later notices are no longer deferred', () => {
    // Emitted after launchClaude resolved. Without the release it would be
    // queued into a launch that is over and never flushed at all.
    expect(plain.output).toContain(AFTER_EXIT_TEXT);
    expect(plain.output.indexOf(AFTER_EXIT_TEXT))
      .toBeGreaterThan(plain.output.indexOf(CHILD_LAST));
  });

  it('emits the notice as exactly one newline-terminated line', () => {
    expect(plain.output.split('\n').filter(line => line.includes(NOTICE_TEXT)))
      .toEqual([NOTICE_TEXT]);
  });

  it('flushes the queue when the child is torn down by a forwarded signal', () => {
    // SIGINT reaches restore() through the child's exit, not through a separate
    // path, so a flush that only ran on a clean exit would lose this one.
    expect(signalled.code).toBe(0);
    expect(signalled.output).toContain('CHILD-SIGINT');
    expect(signalled.output).toContain(NOTICE_TEXT);
    expect(signalled.output.indexOf(NOTICE_TEXT))
      .toBeGreaterThan(signalled.output.indexOf('CHILD-SIGINT'));
    expect(signalled.output).toContain('probe-done exit=130');
  });

  it('bounds the queue and reports the overflow instead of growing', () => {
    // 56 notices raised behind a 50-line queue (one slot is the first warning).
    // Holding notices must not turn a looping producer into unbounded memory in
    // a process that still has to serve requests.
    const flood = flooded.output.split('\n').filter(line => line.startsWith('clodex: flood-'));

    expect(flood).toHaveLength(49);
    // Nothing is silently discarded: the overflow is counted and reported.
    expect(flooded.output).toContain('and 6 further notices suppressed');
  });

  it('still copies both notices and muted writes into the --debug-file log', () => {
    const debugLog = readFileSync(join(traced.dir, 'debug.log'), 'utf8');

    // The debug-file copy is immediate and unchanged; only the terminal write is
    // deferred. The muted write's copy is the pre-existing behavior.
    expect(traced.output).toContain(NOTICE_TEXT);
    expect(debugLog).toContain(`[parent] ${NOTICE_TEXT}`);
    expect(debugLog).toContain(`[parent] ${MUTED_TEXT}`);
    // The launch's log must not keep growing after the launch is over.
    expect(debugLog).not.toContain(AFTER_EXIT_TEXT);
  });

  it('survives a terminal that closed while the child was running', () => {
    // EPIPE arrives asynchronously through the stream's error event, so an
    // unguarded write kills clodex — with the in-process gateway inside it.
    expect(epipeStatus).toBe('0');
  });
});
