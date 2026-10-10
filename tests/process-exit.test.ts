// tests/process-exit.test.ts
//
// How clodex and clodex-claude end the process. process.exit() can deadlock on Node 24
// (https://github.com/nodejs/node/issues/64274), so both bins request an exit and let the event
// loop drain instead, falling back to process.exit() only if something still holds the loop.
//
// Whether a process drained or was cut off is a property of a real process, so every case runs
// tests/helpers/exit-probe.ts in a plain Node process, bundled with tsup as
// tests/parent-notice-launch.test.ts does, and asserts on how it reported its own end.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'tsup';
import { describeActiveResources } from '../src/process-exit.js';
import { BOUNDED_NODE_CHILD } from './helpers/bounded-child.js';

const PROBE_SOURCE = fileURLToPath(new URL('./helpers/exit-probe.ts', import.meta.url));
const PROBE_BUILD_NAME = 'exit-probe.built';
const PROBE = join(dirname(PROBE_SOURCE), `${PROBE_BUILD_NAME}.mjs`);
const PROJECT_ROOT = join(dirname(PROBE_SOURCE), '..', '..');
/** The two shipped bins, built next to the probe so bare imports resolve to the repo's node_modules. */
const BUILT_CLI = join(dirname(PROBE_SOURCE), 'cli.built.mjs');
const BUILT_WRAPPER = join(dirname(PROBE_SOURCE), 'claude-wrapper.built.mjs');
/** Vitest's per-test timeout cannot cancel a subprocess, so the harness owns one. */
const PROBE_TIMEOUT_MS = 30_000;

interface ProbeRun {
  code: number | null;
  stderr: string;
}

/** Milliseconds from the exit request to the exit, as the probe itself measured them. */
function afterRequestMs(run: ProbeRun): number {
  const match = /EXITED via=\S+ code=\S+ afterRequestMs=(\d+)/.exec(run.stderr);
  if (!match) throw new Error(`probe did not report its exit:\n${run.stderr}`);
  return Number(match[1]);
}

const live = new Set<ChildProcess>();
let home: string;

function runProbe(mode: string, extraArgs: string[] = []): Promise<ProbeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, mode, ...extraArgs], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CLODEX_HOME: home, CLODEX_TRACE: '' },
    });
    live.add(child);
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`exit probe "${mode}" did not end within ${PROBE_TIMEOUT_MS}ms:\n${stderr}`));
    }, PROBE_TIMEOUT_MS);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      live.delete(child);
      resolve({ code, stderr });
    });
  });
}

/** A server that accepts connections and reads requests but never answers them. */
function startSilentServer(): Promise<{ server: Server; url: string; requests: () => number; open: () => number }> {
  return new Promise(resolve => {
    const sockets = new Set<Socket>();
    let requests = 0;
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('data', () => { requests += 1; });
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/api.json`,
        requests: () => requests,
        open: () => sockets.size,
      });
    });
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'clodex-exit-probe-'));
  await build({
    entry: {
      [PROBE_BUILD_NAME]: PROBE_SOURCE,
      'cli.built': join(PROJECT_ROOT, 'src', 'cli.ts'),
      'claude-wrapper.built': join(PROJECT_ROOT, 'src', 'claude-wrapper.ts'),
    },
    outDir: dirname(PROBE_SOURCE),
    format: ['esm'],
    target: 'node22',
    splitting: false,
    sourcemap: false,
    clean: false,
    silent: true,
    config: false,
    dts: false,
    shims: false,
    skipNodeModulesBundle: true,
    outExtension: () => ({ js: '.mjs' }),
  });
}, 120_000);

afterAll(() => {
  for (const child of live) child.kill('SIGKILL');
  live.clear();
  rmSync(home, { recursive: true, force: true });
  for (const built of [PROBE, BUILT_CLI, BUILT_WRAPPER]) rmSync(built, { force: true });
});

describe('exitAfterDrain', () => {
  it('ends the process with the requested code by draining, not through process.exit', async () => {
    const run = await runProbe('drain');
    expect(run.code).toBe(7);
    expect(run.stderr).toContain('EXITED via=drain code=7 ');
    expect(run.stderr).not.toContain('via=process.exit');
  });

  it('falls back to process.exit with the same code when something holds the loop', async () => {
    const run = await runProbe('held');
    expect(run.code).toBe(4);
    expect(run.stderr).toContain('EXITED via=process.exit code=4');
    // The fallback waits out its 300 ms grace period first: it is a backstop, not a race.
    expect(afterRequestMs(run)).toBeGreaterThanOrEqual(290);
  });

  it('stays silent about the fallback unless tracing', async () => {
    const run = await runProbe('held');
    expect(run.stderr).not.toContain('event loop still busy');
  });

  it('names what still held the loop when tracing', async () => {
    const run = await runProbe('held-traced');
    expect(run.code).toBe(4);
    expect(run.stderr).toMatch(
      /clodex: event loop still busy 300ms after exit was requested; exiting with process\.exit\(4\)\. Still active: [^\n]*Timeout/,
    );
  });

  it('runs registered cancellers so the work they guard cannot hold the exit', async () => {
    const run = await runProbe('cancelled');
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('EXITED via=drain code=0');
  });

  it('does not run a canceller whose work already finished', async () => {
    const run = await runProbe('unregistered');
    expect(run.stderr).not.toContain('CANCELLER-RAN');
    expect(run.stderr).toContain('EXITED via=drain code=0');
  });

  it('cancels work registered after the exit was already requested', async () => {
    const run = await runProbe('cancel-after-exit');
    expect(run.stderr).toContain('EXITED via=drain code=0');
  });

  it('keeps the first requested code, as process.exit did', async () => {
    const run = await runProbe('first-wins');
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('EXITED via=drain code=3');
  });
});

describe('the background models.dev refresh', () => {
  it('never starts when the command finishes first', async () => {
    const run = await runProbe('models-dev-quick');
    expect(run.stderr).not.toContain('FETCH-STARTED');
    expect(run.stderr).toContain('EXITED via=drain code=0');
  });

  it('cannot hold the process open once the download is in flight', async () => {
    const upstream = await startSilentServer();
    try {
      const run = await runProbe('models-dev-in-flight', [upstream.url]);
      // The download really was in flight against a server that never answers...
      expect(run.stderr).toContain('FETCH-STARTED');
      expect(upstream.requests()).toBeGreaterThan(0);
      // ...and the process still ended by draining, not by the 10 s fallback.
      expect(run.stderr).not.toContain('event loop still busy');
      expect(run.stderr).toContain('EXITED via=drain code=0');
      expect(run.code).toBe(0);
    } finally {
      await new Promise<void>(resolve => upstream.server.close(() => resolve()));
    }
  }, 25_000);

  it('cannot hold the process open while its TLS handshake is stalled', async () => {
    const upstream = await startSilentServer();
    try {
      const run = await runProbe('models-dev-in-flight', [upstream.url.replace('http:', 'https:')]);
      // The connection really was opening, against a server that never completes TLS...
      expect(run.stderr).toContain('FETCH-STARTED');
      expect(upstream.requests()).toBeGreaterThan(0);
      // ...and the process still ended by draining, not by the 10 s fallback.
      expect(run.stderr).not.toContain('event loop still busy');
      expect(run.stderr).toContain('EXITED via=drain code=0');
      expect(run.code).toBe(0);
    } finally {
      await new Promise<void>(resolve => upstream.server.close(() => resolve()));
    }
  }, 25_000);
});

describe('describeActiveResources', () => {
  it('groups resources by type with counts', () => {
    expect(describeActiveResources(['TCPSocketWrap', 'Timeout', 'TCPSocketWrap'])).toBe('TCPSocketWrap x2, Timeout');
  });

  it('says so when nothing is reported', () => {
    expect(describeActiveResources([])).toBe('nothing reported');
  });
});

/**
 * Preload that records how a bin ended: `EXIT-WITNESS process.exit(N)` if anything called
 * process.exit, else `EXIT-WITNESS drained(N)`. With WITNESS_NO_EXECVE=1 it also removes
 * process.execve, forcing clodex-claude onto the spawn path Windows and Node < 22.15 take.
 */
function writeExitWitness(dir: string): string {
  const path = join(dir, 'exit-witness.mjs');
  writeFileSync(path, [
    "if (process.env.WITNESS_NO_EXECVE === '1') delete process.execve;",
    'let viaExit = false;',
    'const realExit = process.exit.bind(process);',
    'process.exit = (code) => {',
    '  viaExit = true;',
    '  process.stderr.write(`EXIT-WITNESS process.exit(${code})\\n`);',
    '  return realExit(code);',
    '};',
    "process.on('exit', (code) => {",
    '  if (!viaExit) process.stderr.write(`EXIT-WITNESS drained(${code})\\n`);',
    '});',
    '',
  ].join('\n'));
  return path;
}

describe('both bins end by draining the event loop', () => {
  function runBin(bin: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-bin-'));
    try {
      const witness = writeExitWitness(scratch);
      const run = spawnSync(process.execPath, ['--import', witness, bin, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CLODEX_HOME: join(scratch, 'home'),
          HOME: scratch,
          CLODEX_TRACE: '',
          CLODEX_CLAUDE_PATH: '',
          PATH: '/usr/bin:/bin',
          ...env,
        },
        ...BOUNDED_NODE_CHILD,
      });
      return { status: run.status, stderr: run.stderr, error: run.error, scratch };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it.each([
    { args: ['--version'], status: 0 },
    { args: ['--help'], status: 0 },
    { args: ['models', '--list'], status: 0 },
    { args: ['--no-such-flag'], status: 1 },
  ])('clodex $args', ({ args, status }) => {
    const run = runBin(BUILT_CLI, args);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(status);
    expect(run.stderr).toContain(`EXIT-WITNESS drained(${status})`);
    expect(run.stderr).not.toContain('EXIT-WITNESS process.exit');
  });

  it('clodex when a command fails with an unexpected error', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-error-'));
    try {
      // A clodex home that cannot be created makes the server's log setup throw out of main().
      const notADirectory = join(scratch, 'file');
      writeFileSync(notADirectory, '');
      const run = runBin(BUILT_CLI, ['server', '--proxy', '--no-discovery'], {
        CLODEX_HOME: join(notADirectory, 'home'),
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Unexpected error');
      expect(run.stderr).toContain('EXIT-WITNESS drained(1)');
      expect(run.stderr).not.toContain('EXIT-WITNESS process.exit');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('clodex-claude --check with no server', () => {
    const run = runBin(BUILT_WRAPPER, ['--check']);
    expect(run.status).toBe(1);
    // Nothing else: the check must stop here rather than carry on toward a launch.
    expect(run.stderr.trim()).toBe('EXIT-WITNESS drained(1)');
  });

  it.skipIf(process.platform === 'win32')('clodex-claude when claude cannot be found', () => {
    const run = runBin(BUILT_WRAPPER, ['-p', 'hi']);
    expect(run.status).toBe(127);
    expect(run.stderr.trim().split('\n')).toEqual([
      'clodex-claude: could not find the claude binary (set CLODEX_CLAUDE_PATH)',
      'EXIT-WITNESS drained(127)',
    ]);
  });

  it.skipIf(process.platform === 'win32')('clodex-claude when a server is required and none is live', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-claude-'));
    try {
      const launched = join(scratch, 'launched');
      const fakeClaude = join(scratch, 'claude');
      writeFileSync(fakeClaude, `#!/bin/sh\ntouch "${launched}"\n`);
      chmodSync(fakeClaude, 0o755);
      const run = runBin(BUILT_WRAPPER, [fakeClaude], { CLODEX_REQUIRE_SERVER: '1', WITNESS_NO_EXECVE: '1' });
      expect(run.status).toBe(1);
      expect(run.stderr.trim().split('\n')).toEqual([
        'clodex-claude: no live clodex server is available',
        'EXIT-WITNESS drained(1)',
      ]);
      // Requesting the exit must also stop the launch that would otherwise follow.
      expect(existsSync(launched)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('clodex-claude on the spawn path, passing on claude\'s exit code', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-claude-'));
    try {
      const fakeClaude = join(scratch, 'claude');
      writeFileSync(fakeClaude, '#!/bin/sh\nexit 3\n');
      chmodSync(fakeClaude, 0o755);
      const run = runBin(BUILT_WRAPPER, [fakeClaude], { WITNESS_NO_EXECVE: '1' });
      expect(run.status).toBe(3);
      expect(run.stderr).toContain('EXIT-WITNESS drained(3)');
      expect(run.stderr).not.toContain('EXIT-WITNESS process.exit');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('clodex-claude on the spawn path when claude dies from a signal', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-claude-'));
    try {
      const fakeClaude = join(scratch, 'claude');
      writeFileSync(fakeClaude, '#!/bin/sh\nkill -TERM $$\n');
      chmodSync(fakeClaude, 0o755);
      const run = runBin(BUILT_WRAPPER, [fakeClaude], { WITNESS_NO_EXECVE: '1' });
      expect(run.status).toBe(128 + 15);
      expect(run.stderr).toContain(`EXIT-WITNESS drained(${128 + 15})`);
      expect(run.stderr).not.toContain('EXIT-WITNESS process.exit');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('clodex-claude when the spawn itself fails', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-claude-'));
    try {
      const unusable = join(scratch, 'claude');
      writeFileSync(unusable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      const run = runBin(BUILT_WRAPPER, [], { CLODEX_CLAUDE_PATH: unusable });
      expect(run.status).toBe(127);
      expect(run.stderr).toContain('failed to launch');
      expect(run.stderr).toContain('EXIT-WITNESS drained(127)');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
