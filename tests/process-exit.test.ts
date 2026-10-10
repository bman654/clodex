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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'tsup';
import { createServer as createHttpServer } from 'node:http';
import { CHILD_NETWORK_ENV_VARS } from '../src/network-env.js';
import { describeActiveResources } from '../src/process-exit.js';
import { MODELS_DEV_API_URL } from '../src/registry/models-dev.js';
import { PRICING_API_URL } from '../src/registry/pricing.js';
import { tryAcquireRegistryLock } from '../src/registry/lock.js';
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

/**
 * The child environment without the ambient proxy settings, so the CLI's dispatcher is the plain
 * Agent these cases exercise and loopback fixtures are reached directly.
 */
function hermeticEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const name of CHILD_NETWORK_ENV_VARS) delete env[name];
  return env;
}

function runProbe(
  mode: string,
  extraArgs: string[] = [],
  options: { clodexHome?: string; onStderr?: (soFar: string) => void } = {},
): Promise<ProbeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, mode, ...extraArgs], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: hermeticEnv({ CLODEX_HOME: options.clodexHome ?? home, CLODEX_TRACE: '' }),
    });
    live.add(child);
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(stderr);
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

describe('the background pricing enrichment', () => {
  // Started by provider add and refresh. The interactive provider hub keeps running after it starts,
  // so its request can be established and waiting on a stalled server when the user leaves.
  it('cannot hold the process open once its request is in flight', async () => {
    const upstream = await startSilentServer();
    try {
      const run = await runProbe('pricing-in-flight', [upstream.url]);
      expect(run.stderr).toContain('FETCH-STARTED');
      expect(upstream.requests()).toBeGreaterThan(0);
      // Abandoned outright, as process.exit() would: no registry update while the process exits.
      expect(run.stderr).not.toContain('ENRICHMENT-FINISHED');
      expect(run.stderr).not.toContain('event loop still busy');
      expect(run.stderr).toContain('EXITED via=drain code=0');
    } finally {
      await new Promise<void>(resolve => upstream.server.close(() => resolve()));
    }
  }, 25_000);
});

/**
 * The enrichment's fetch has finished and it is waiting for the provider-registry lock, which
 * another clodex process holds (the test process takes the real lock lease here).
 */
describe('the background pricing enrichment waiting on a held registry lock', () => {
  async function runWithLockHeld(release: 'never' | 'soon-after-exit') {
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-lock-'));
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/pricing`;
    const lease = tryAcquireRegistryLock(join(scratch, 'providers.json.lock'));
    expect(lease).not.toBeNull();
    let releaseTimer: NodeJS.Timeout | undefined;
    try {
      return await runProbe('pricing-lock-contended', [url], {
        clodexHome: scratch,
        onStderr: soFar => {
          if (release === 'soon-after-exit' && !releaseTimer && soFar.includes('EXIT-REQUESTED')) {
            releaseTimer = setTimeout(() => lease!.release(), 200);
          }
        },
      });
    } finally {
      clearTimeout(releaseTimer);
      lease!.release();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('stops waiting for the lock when the exit is requested', async () => {
    const run = await runWithLockHeld('never');
    expect(run.stderr).toContain('FETCH-ANSWERED');
    // The lock is still held when the probe ends: only an abandoned wait lets it drain.
    expect(run.stderr).not.toContain('event loop still busy');
    expect(run.stderr).toContain('EXITED via=drain code=0');
    expect(run.stderr).not.toContain('ENRICHMENT-FINISHED');
  }, 25_000);

  it('does not update the registry once the lock comes free after the exit', async () => {
    const run = await runWithLockHeld('soon-after-exit');
    expect(run.stderr).toContain('FETCH-ANSWERED');
    expect(run.stderr).not.toContain('ENRICHMENT-FINISHED');
    expect(run.stderr).not.toContain('event loop still busy');
    expect(run.stderr).toContain('EXITED via=drain code=0');
  }, 25_000);
});

describe('outbound connections still opening at exit', () => {
  it('fail the fetch that opened them, so its own timeout cannot hold the exit', async () => {
    const upstream = await startSilentServer();
    try {
      // https against a server that never completes TLS: the connection is still opening.
      const run = await runProbe('unowned-fetch-connecting', [upstream.url.replace('http:', 'https:')]);
      expect(run.stderr).toContain('FETCH-STARTED');
      expect(upstream.requests()).toBeGreaterThan(0);
      // A connection destroyed without an error strands the fetch: it never settles and its 15 s
      // timer holds the loop until the 10 s fallback.
      expect(run.stderr).toContain('FETCH-SETTLED null');
      expect(run.stderr).not.toContain('event loop still busy');
      expect(run.stderr).toContain('EXITED via=drain code=0');
    } finally {
      await new Promise<void>(resolve => upstream.server.close(() => resolve()));
    }
  }, 25_000);
});

/**
 * `clodex providers refresh-models` on a loopback custom-openai provider: the real successful
 * refresh path, which ends by starting the background pricing enrichment that nothing awaits.
 * A preload points the two public metadata URLs (pricing, models.dev) at the same loopback server.
 */
describe('clodex providers refresh-models', () => {
  async function refreshAgainstLoopback() {
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-refresh-'));
    const hits: string[] = [];
    const server = createHttpServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'loop-model', object: 'model' }] }));
      } else if (req.url === '/pricing') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      const clodexHome = join(scratch, 'home');
      mkdirSync(clodexHome);
      writeFileSync(join(clodexHome, 'providers.json'), JSON.stringify({
        schemaVersion: 1,
        providers: [{
          id: 'loop', templateId: 'custom-openai', name: 'Loop', enabled: true,
          authRef: 'none:anonymous', authType: 'none',
          api: { npm: '@ai-sdk/openai-compatible', url: `${url}/v1` },
          addedAt: '2026-10-10T00:00:00.000Z',
        }],
      }));
      const redirect = join(scratch, 'redirect-metadata.mjs');
      writeFileSync(redirect, [
        'const realFetch = globalThis.fetch;',
        'const routes = {',
        `  ${JSON.stringify(PRICING_API_URL)}: '/pricing',`,
        `  ${JSON.stringify(MODELS_DEV_API_URL)}: '/models-dev',`,
        '};',
        'globalThis.fetch = (input, init) => {',
        '  const path = routes[String(input)];',
        `  return realFetch(path ? ${JSON.stringify(url)} + path : input, init);`,
        '};',
        '',
      ].join('\n'));
      const child = spawn(process.execPath, [
        '--import', writeExitWitness(scratch), '--import', redirect,
        BUILT_CLI, 'providers', 'refresh-models', 'loop',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: hermeticEnv({ CLODEX_HOME: clodexHome, HOME: scratch, CLODEX_TRACE: '1' }),
      });
      live.add(child);
      let output = '';
      child.stdout!.on('data', chunk => { output += String(chunk); });
      child.stderr!.on('data', chunk => { output += String(chunk); });
      const killer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
      const status = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
      clearTimeout(killer);
      live.delete(child);
      return { status, output, hits };
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('drains naturally right after starting the pricing enrichment', async () => {
    const run = await refreshAgainstLoopback();
    expect(run.hits).toContain('/v1/models');
    expect(run.output).not.toContain('event loop still busy');
    expect(run.output).toContain('EXIT-WITNESS drained(0)');
    expect(run.status).toBe(0);
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
        env: hermeticEnv({
          CLODEX_HOME: join(scratch, 'home'),
          HOME: scratch,
          CLODEX_TRACE: '',
          CLODEX_CLAUDE_PATH: '',
          PATH: '/usr/bin:/bin',
          ...env,
        }),
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

  it.skipIf(process.platform === 'win32')('clodex-claude keeps its 127 when nobody is reading its stderr', async () => {
    // `clodex-claude … 2>&1 | true`: the reader is gone before the diagnostic is written. The
    // write fails with EPIPE asynchronously, after the exit was requested; process.exit() used to
    // end the process first, and an unhandled stream error would now turn 127 into 1.
    const scratch = mkdtempSync(join(tmpdir(), 'clodex-exit-epipe-'));
    try {
      const child = spawn(process.execPath, [BUILT_WRAPPER, '-p', 'hi'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: hermeticEnv({
          CLODEX_HOME: join(scratch, 'home'),
          HOME: scratch,
          CLODEX_CLAUDE_PATH: '',
          PATH: '/usr/bin:/bin',
        }),
      });
      live.add(child);
      child.stderr!.destroy();
      const killer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
      const status = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
      clearTimeout(killer);
      live.delete(child);
      expect(status).toBe(127);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
