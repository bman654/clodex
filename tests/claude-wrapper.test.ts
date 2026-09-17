import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'tsup';
import {
  createPatchedWrapperFixture,
  runBuiltWrapper,
  runBuiltWrapperWithClosedStderr,
  type WrapperResult,
} from './helpers/patched-wrapper-fixture.js';

const patchFixture = vi.hoisted(() => ({
  sentinel: '\n#__CLAUDE_BUNDLE__\n',
}));

vi.mock('tweakcc', () => ({
  tryDetectInstallation: async ({ path }: { path?: string }) => {
    if (!path || !existsSync(path)) throw new Error(`no installation at ${path}`);
    return { path, version: 'fake', kind: 'native' as const };
  },
  readContent: async (installation: { path: string }) => {
    const raw = readFileSync(installation.path, 'utf8');
    const index = raw.indexOf(patchFixture.sentinel);
    if (index === -1) throw new Error('missing fake Claude bundle');
    return raw.slice(index + patchFixture.sentinel.length);
  },
  writeContent: async (installation: { path: string }, content: string) => {
    const raw = readFileSync(installation.path, 'utf8');
    const head = raw.slice(0, raw.indexOf(patchFixture.sentinel));
    writeFileSync(installation.path, head + patchFixture.sentinel + content, { mode: 0o755 });
    chmodSync(installation.path, 0o755);
  },
}));

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let buildRoot: string;
let wrapperPath: string;
let testRoot: string;
let clodexHome: string;
let helperPath: string;
let launchMarker: string;
let caPath: string;

const runWrapper = (args: string[], envOverrides: NodeJS.ProcessEnv = {}) =>
  runBuiltWrapper({ wrapperPath, clodexHome, args, envOverrides });
const runWrapperWithClosedStderr = (args: string[], envOverrides: NodeJS.ProcessEnv = {}) =>
  runBuiltWrapperWithClosedStderr({ wrapperPath, clodexHome, args, envOverrides });

async function openLoopbackServer(
  host = '127.0.0.1',
  ipv6Only = false,
): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen({ port: 0, host, ipv6Only }, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('expected a TCP address for the wrapper test server');
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}

async function openRefusingIpv4Reservations(
  count: number,
): Promise<Array<{ server: Server; port: number }>> {
  return Promise.all(
    Array.from({ length: count }, () => openLoopbackServer('::1', true)),
  );
}

interface AdvertisedServer {
  mode: 'endpoint' | 'proxy';
  port: number;
  pid: number;
  caPath?: string;
  startedAt: string;
}

function advertiseServers(records: AdvertisedServer[]): void {
  mkdirSync(clodexHome, { recursive: true });
  writeFileSync(
    join(clodexHome, 'server-runtime.json'),
    `${JSON.stringify(records)}\n`,
  );
}

function advertiseEndpoint(port: number, pid = process.pid): void {
  advertiseServers([
    {
      mode: 'endpoint',
      port,
      pid,
      startedAt: new Date().toISOString(),
    },
  ]);
}

function advertiseProxy(port: number, pid = process.pid): void {
  advertiseServers([
    {
      mode: 'proxy',
      port,
      pid,
      caPath,
      startedAt: new Date().toISOString(),
    },
  ]);
}

function claudeInvocation(exitCode = 0): string[] {
  return [process.execPath, helperPath, launchMarker, String(exitCode)];
}

function readLaunchEnv(): { baseUrl: string | null; httpProxy: string | null } {
  return JSON.parse(readFileSync(launchMarker, 'utf8')) as {
    baseUrl: string | null;
    httpProxy: string | null;
  };
}

beforeAll(async () => {
  buildRoot = mkdtempSync(join(tmpdir(), 'clodex-wrapper-build-'));
  await build({
    entry: [join(projectRoot, 'src', 'claude-wrapper.ts')],
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    outDir: buildRoot,
    outExtension: () => ({ js: '.mjs' }),
    clean: true,
    dts: false,
    minify: false,
    silent: true,
    sourcemap: false,
    splitting: false,
  });
  wrapperPath = join(buildRoot, 'claude-wrapper.mjs');
  expect(existsSync(wrapperPath)).toBe(true);
});

afterAll(() => {
  rmSync(buildRoot, { recursive: true, force: true });
});

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'clodex-wrapper-test-'));
  clodexHome = join(testRoot, 'clodex-home');
  helperPath = join(testRoot, 'fake-claude.mjs');
  launchMarker = join(testRoot, 'claude-launched');
  caPath = join(testRoot, 'proxy-ca.pem');
  writeFileSync(caPath, `${rootCertificates[0]}\n`);
  writeFileSync(
    helperPath,
    [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.argv[2], JSON.stringify({',
      '  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,',
      '  httpProxy: process.env.HTTP_PROXY ?? null,',
      '}));',
      "process.stdout.write('fake-claude-launched\\n');",
      'process.exit(Number(process.argv[3]));',
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// Windows and Node older than 22.15 keep the spawn fallback, which cannot
// preserve the pid.
const execReplacesProcessImage =
  process.platform !== 'win32' && typeof process.execve === 'function';

describe('clodex-claude process wrapper', () => {
  it('reports an unlaunchable Claude binary instead of aborting the exec', async () => {
    // execve aborts the process (exit 134, native crash dump) when the syscall
    // fails, so an unusable binary has to be caught before the call and left to
    // the spawn path. Existing but not executable reproduces that deterministically.
    const unusable = join(testRoot, 'not-executable-claude');
    writeFileSync(unusable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });

    const result = await runWrapper([], { CLODEX_CLAUDE_PATH: unusable });

    expect(result).toMatchObject({ code: 127, signal: null });
    expect(result.stderr).toContain('failed to launch');
  });

  it.skipIf(!execReplacesProcessImage)(
    'replaces its process image so Claude keeps the wrapper pid and leads its process group',
    async () => {
      const identityMarker = join(testRoot, 'claude-identity.json');
      const identityHelper = join(testRoot, 'identity-claude.mjs');
      writeFileSync(
        identityHelper,
        [
          "import { execFileSync } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          "const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {",
          "  encoding: 'utf8',",
          '}).trim();',
          `writeFileSync(${JSON.stringify(identityMarker)}, JSON.stringify({`,
          '  pid: process.pid,',
          '  pgid: Number(pgid),',
          '}));',
          '',
        ].join('\n'),
      );

      const env: NodeJS.ProcessEnv = { ...process.env, CLODEX_HOME: clodexHome };
      delete env['CLODEX_REQUIRE_SERVER'];
      // detached mirrors how Claude Code starts a background pty host: the
      // process it spawns is meant to lead its own group so that the resize
      // signal `kill(-pid, 'SIGWINCH')` reaches Claude.
      const child = spawn(process.execPath, [wrapperPath, process.execPath, identityHelper], {
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      });
      const wrapperPid = child.pid;
      await new Promise<void>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', () => resolveExit());
      });

      const identity = JSON.parse(readFileSync(identityMarker, 'utf8')) as {
        pid: number;
        pgid: number;
      };
      // Same pid: Claude replaced the wrapper rather than running under it.
      expect(identity.pid).toBe(wrapperPid);
      // Group leader: `process.kill(-pid, 'SIGWINCH')` resolves to this process
      // instead of failing with ESRCH.
      expect(identity.pgid).toBe(identity.pid);
    },
  );

  it('--check exits 0 only for an advertised server with a live TCP port', async () => {
    const { server, port } = await openLoopbackServer();
    try {
      expect((await runWrapper(['--check'])).code).toBe(1);

      advertiseEndpoint(port, Number.MAX_SAFE_INTEGER);
      expect((await runWrapper(['--check'])).code).toBe(1);

      advertiseEndpoint(port);
      expect((await runWrapper(['--check'])).code).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('--check exits 1 without launching Claude when no server exists', async () => {
    const result = await runWrapper(['--check', ...claudeInvocation()]);

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(existsSync(launchMarker)).toBe(false);
  });

  it('CLODEX_REQUIRE_SERVER=1 fails closed without launching Claude', async () => {
    const result = await runWrapper(claudeInvocation(), { CLODEX_REQUIRE_SERVER: '1' });

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.stderr).toContain('no live clodex server is available');
    expect(existsSync(launchMarker)).toBe(false);
  });

  it('default mode remains fail-open when no server exists', async () => {
    const result = await runWrapper(claudeInvocation(23));

    expect(result).toMatchObject({ code: 23, signal: null });
    expect(result.stdout).toBe('fake-claude-launched\n');
    expect(existsSync(launchMarker)).toBe(true);
  });

  it('warns and launches when a standalone server cannot apply an account override', async () => {
    const endpoint = await openLoopbackServer();
    advertiseEndpoint(endpoint.port);
    try {
      const result = await runWrapper(claudeInvocation(), { CLODEX_OAUTH_ACCOUNT: 'work' });

      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stderr).toContain('CLODEX_OAUTH_ACCOUNT is ignored');
      expect(result.stderr).toContain('restart that server with the override');
      expect(existsSync(launchMarker)).toBe(true);
    } finally {
      await closeServer(endpoint.server);
    }
  });

  it('warns without exposing a provider key and still launches through the server', async () => {
    const endpoint = await openLoopbackServer();
    advertiseEndpoint(endpoint.port);
    try {
      const result = await runWrapper(claudeInvocation(), {
        CLODEX_KEY_OPENAI_OAUTH: 'temporary-provider-token',
      });

      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stderr).toContain('CLODEX_KEY_OPENAI_OAUTH is ignored');
      expect(result.stderr).toContain('save that credential as a provider or account');
      expect(result.stderr).not.toContain('temporary-provider-token');
      expect(existsSync(launchMarker)).toBe(true);
    } finally {
      await closeServer(endpoint.server);
    }
  });

  it('does not block launch for an unrelated provider key', async () => {
    const endpoint = await openLoopbackServer();
    advertiseEndpoint(endpoint.port);
    try {
      const result = await runWrapper(claudeInvocation(), {
        CLODEX_KEY_UNRELATED: 'temporary-unrelated-token',
      });

      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stderr).toContain('CLODEX_KEY_UNRELATED is ignored');
      expect(result.stderr).not.toContain('temporary-unrelated-token');
      expect(existsSync(launchMarker)).toBe(true);
    } finally {
      await closeServer(endpoint.server);
    }
  });

  it('ignores a blank provider key when selecting a standalone server', async () => {
    const endpoint = await openLoopbackServer();
    advertiseEndpoint(endpoint.port);
    try {
      const result = await runWrapper(claudeInvocation(), {
        CLODEX_KEY_OPENAI_OAUTH: '   ',
      });

      expect(result).toMatchObject({ code: 0, signal: null });
      expect(existsSync(launchMarker)).toBe(true);
    } finally {
      await closeServer(endpoint.server);
    }
  });

  it('uses a live endpoint when the preferred proxy record is stale', async () => {
    const endpoint = await openLoopbackServer();
    const [staleProxyReservation] = await openRefusingIpv4Reservations(1);
    advertiseServers([
      {
        mode: 'proxy',
        port: staleProxyReservation!.port,
        pid: process.pid,
        caPath,
        startedAt: '2026-07-24T12:00:00.000Z',
      },
      {
        mode: 'endpoint',
        port: endpoint.port,
        pid: process.pid,
        startedAt: '2026-07-24T13:00:00.000Z',
      },
    ]);

    try {
      const result = await runWrapper(claudeInvocation());

      expect(result).toMatchObject({ code: 0, signal: null });
      expect(readLaunchEnv()).toEqual({
        baseUrl: `http://127.0.0.1:${endpoint.port}/anthropic`,
        httpProxy: null,
      });
    } finally {
      await Promise.all([
        closeServer(staleProxyReservation!.server),
        closeServer(endpoint.server),
      ]);
    }
  });

  it('probes all live candidates once and preserves proxy-first ordering', async () => {
    const proxy = await openLoopbackServer();
    const endpoint = await openLoopbackServer();
    let proxyConnections = 0;
    let endpointConnections = 0;
    proxy.server.on('connection', () => {
      proxyConnections += 1;
    });
    endpoint.server.on('connection', () => {
      endpointConnections += 1;
    });
    advertiseServers([
      {
        mode: 'endpoint',
        port: endpoint.port,
        pid: process.pid,
        startedAt: '2026-07-24T13:00:00.000Z',
      },
      {
        mode: 'proxy',
        port: proxy.port,
        pid: process.pid,
        caPath,
        startedAt: '2026-07-24T12:00:00.000Z',
      },
    ]);

    try {
      const result = await runWrapper(claudeInvocation());

      expect(result).toMatchObject({ code: 0, signal: null });
      expect(readLaunchEnv()).toEqual({
        baseUrl: null,
        httpProxy: `http://127.0.0.1:${proxy.port}`,
      });
      expect(proxyConnections).toBe(1);
      expect(endpointConnections).toBe(1);
    } finally {
      await Promise.all([
        closeServer(proxy.server),
        closeServer(endpoint.server),
      ]);
    }
  });

  it('reports unavailable when every candidate refuses connections', async () => {
    const [newestProxy, olderProxy, endpoint] =
      await openRefusingIpv4Reservations(3);
    advertiseServers([
      {
        mode: 'proxy',
        port: newestProxy!.port,
        pid: process.pid,
        caPath,
        startedAt: '2026-07-24T14:00:00.000Z',
      },
      {
        mode: 'proxy',
        port: olderProxy!.port,
        pid: process.pid,
        caPath,
        startedAt: '2026-07-24T13:00:00.000Z',
      },
      {
        mode: 'endpoint',
        port: endpoint!.port,
        pid: process.pid,
        startedAt: '2026-07-24T12:00:00.000Z',
      },
    ]);

    try {
      const startedAt = process.hrtime.bigint();
      const result = await runWrapper(['--check']);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      expect(result).toMatchObject({ code: 1, signal: null });
      expect(elapsedMs).toBeLessThan(400);
    } finally {
      await Promise.all([
        closeServer(newestProxy!.server),
        closeServer(olderProxy!.server),
        closeServer(endpoint!.server),
      ]);
    }
  });
});

describe('clodex-claude VS Code patched-install selection', () => {
  it('runs the real patch command output with exact argv, bridge env, stdout, and exit code', async () => {
    const proxy = await openLoopbackServer();
    advertiseProxy(proxy.port);
    try {
      const fixture = await createPatchedWrapperFixture({ testRoot, clodexHome, sentinel: patchFixture.sentinel });
      const args = ['--input-format', 'stream-json', '--flag', 'two words', 'double"quote', "single'quote", ''];
      const result = await runWrapper([fixture.handedInPath, ...args], {
        CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
        FAKE_EXIT_CODE: '37',
      });
      const launched = JSON.parse(readFileSync(fixture.markerPath, 'utf8')) as { pid: number };
      const expected = {
        identity: 'patched-install',
        pid: launched.pid,
        args,
        baseUrl: null,
        httpProxy: `http://127.0.0.1:${proxy.port}`,
        httpsProxy: `http://127.0.0.1:${proxy.port}`,
        caPath,
      };

      expect(result).toMatchObject({ code: 37, signal: null, stderr: '' });
      expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(launched).toEqual(expected);
      if (execReplacesProcessImage) expect(launched.pid).toBe(result.pid);
    } finally {
      await closeServer(proxy.server);
    }
  });

  it('notices a refused chat spawn but keeps a refused helper spawn silent', async () => {
    const proxy = await openLoopbackServer();
    advertiseProxy(proxy.port);
    try {
      const fixture = await createPatchedWrapperFixture({ testRoot, clodexHome, sentinel: patchFixture.sentinel });
      const original = readFileSync(fixture.handedInPath, 'utf8');
      writeFileSync(fixture.handedInPath, original.replace('Defaults to inherit.', 'Defaults to another.'), {
        mode: 0o755,
      });
      chmodSync(fixture.handedInPath, 0o755);
      const args = ['--output-format', 'stream-json', 'space value', '"quoted"', ''];
      const result = await runWrapper([fixture.handedInPath, ...args], {
        CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
        FAKE_EXIT_CODE: '29',
      });
      const expected = {
        identity: 'extension-bundle',
        pid: result.pid,
        args,
        baseUrl: null,
        httpProxy: `http://127.0.0.1:${proxy.port}`,
        httpsProxy: `http://127.0.0.1:${proxy.port}`,
        caPath,
      };

      expect(result).toMatchObject({ code: 29, signal: null });
      expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(result.stdout).not.toContain('clodex-claude:');
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain(`running ${JSON.stringify(fixture.handedInPath)}`);
      expect(result.stderr).toContain('bytes do not match the pristine source');
      expect(result.stderr).toContain(JSON.stringify(join(clodexHome, 'patch-state.json')));

      const helperInvocations = [
        ['auth', 'status', '--json'],
        ['--output-format', 'stream-json', '--no-session-persistence', '-p', 'suggest'],
      ];
      for (const helperArgs of helperInvocations) {
        const helper = await runWrapper([fixture.handedInPath, ...helperArgs], {
          CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
          FAKE_EXIT_CODE: '43',
        });
        expect(helper).toMatchObject({ code: 43, signal: null, stderr: '' });
        expect(JSON.parse(helper.stdout)).toMatchObject({
          identity: 'extension-bundle',
          args: helperArgs,
        });
      }
    } finally {
      await closeServer(proxy.server);
    }
  });

  it('survives a closed stderr pipe while falling back', async () => {
    const proxy = await openLoopbackServer();
    advertiseProxy(proxy.port);
    try {
      const fixture = await createPatchedWrapperFixture({ testRoot, clodexHome, sentinel: patchFixture.sentinel });
      const original = readFileSync(fixture.handedInPath, 'utf8');
      writeFileSync(fixture.handedInPath, `${original}\n# same-version local change\n`, { mode: 0o755 });
      const chatArgs = ['--output-format', 'stream-json', '--closed-stderr'];
      const result = await runWrapperWithClosedStderr([fixture.handedInPath, ...chatArgs], {
        CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
        FAKE_EXIT_CODE: '41',
      });

      expect(result).toMatchObject({ code: 41, signal: null });
      expect(JSON.parse(result.stdout)).toMatchObject({
        identity: 'extension-bundle',
        args: chatArgs,
      });
    } finally {
      await closeServer(proxy.server);
    }
  });

  it('--check keeps its no-launch behavior when patch selection state exists', async () => {
    const proxy = await openLoopbackServer();
    advertiseProxy(proxy.port);
    try {
      const fixture = await createPatchedWrapperFixture({ testRoot, clodexHome, sentinel: patchFixture.sentinel });
      const result = await runWrapper(['--check', fixture.handedInPath], {
        CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      });

      expect(result).toMatchObject({ code: 0, signal: null, stdout: '', stderr: '' });
      expect(existsSync(fixture.markerPath)).toBe(false);
    } finally {
      await closeServer(proxy.server);
    }
  });

  it('does not substitute for endpoint mode', async () => {
    const endpoint = await openLoopbackServer();
    advertiseEndpoint(endpoint.port);
    try {
      const fixture = await createPatchedWrapperFixture({ testRoot, clodexHome, sentinel: patchFixture.sentinel });
      const result = await runWrapper([fixture.handedInPath, '--endpoint-row'], {
        CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      });
      const launched = JSON.parse(result.stdout) as { identity: string; baseUrl: string };

      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(launched).toMatchObject({
        identity: 'extension-bundle',
        baseUrl: `http://127.0.0.1:${endpoint.port}/anthropic`,
      });
    } finally {
      await closeServer(endpoint.server);
    }
  });

  it('does not substitute without a live server', async () => {
    const fixture = await createPatchedWrapperFixture({ testRoot, clodexHome, sentinel: patchFixture.sentinel });
    const result = await runWrapper([fixture.handedInPath, '--no-server-row'], {
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
    });

    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      identity: 'extension-bundle',
      baseUrl: null,
    });
  });

  it('never discovers another Claude install for a missing VS Code path', async () => {
    const fixture = await createPatchedWrapperFixture({
      testRoot,
      clodexHome,
      sentinel: patchFixture.sentinel,
    });
    rmSync(fixture.handedInPath);
    const result = await runWrapper([fixture.handedInPath, '--must-not-forward'], {
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      CLODEX_CLAUDE_PATH: fixture.patchedPath,
    });

    expect(result).toMatchObject({ code: 127, signal: null, stdout: '' });
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain(`failed to launch ${fixture.handedInPath}`);
    expect(existsSync(fixture.markerPath)).toBe(false);
  });

  it.each(['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE'] as const)(
    'keeps direct discovery for an absolute child argument marked by %s',
    async (marker) => {
      const fixture = await createPatchedWrapperFixture({
        testRoot,
        clodexHome,
        sentinel: patchFixture.sentinel,
      });
      const absoluteArgument = join(testRoot, 'missing-child-argument');
      const result = await runWrapper([absoluteArgument, '--nested-direct'], {
        CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
        CLODEX_CLAUDE_PATH: fixture.handedInPath,
        [marker]: '1',
      });

      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({
        identity: 'extension-bundle',
        args: [absoluteArgument, '--nested-direct'],
      });
    },
  );

  it.each([
    ['CLAUDE_CODE_CHILD_SESSION', { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_CODE_CHILD_SESSION: '1' }],
    ['CLAUDECODE', { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDECODE: '1' }],
    ['no VS Code entrypoint', {}],
  ] as const)('does not substitute a child/background process with %s', async (_label, env) => {
    const proxy = await openLoopbackServer();
    advertiseProxy(proxy.port);
    try {
      const fixture = await createPatchedWrapperFixture({
        testRoot,
        clodexHome,
        sentinel: patchFixture.sentinel,
      });
      const result = await runWrapper(
        [fixture.handedInPath, '--background-row'],
        env,
      );

      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({
        identity: 'extension-bundle',
        args: ['--background-row'],
      });
    } finally {
      await closeServer(proxy.server);
    }
  });

  it('does not substitute direct discovery or a non-VS-Code process wrapper', async () => {
    const proxy = await openLoopbackServer();
    advertiseProxy(proxy.port);
    try {
      const fixture = await createPatchedWrapperFixture({ testRoot, clodexHome, sentinel: patchFixture.sentinel });
      const direct = await runWrapper(['--direct-row', ''], {
        CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
        CLODEX_CLAUDE_PATH: fixture.handedInPath,
      });
      const generic = await runWrapper([fixture.handedInPath, '--generic-row'], {
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      });

      expect(JSON.parse(direct.stdout)).toMatchObject({
        identity: 'extension-bundle',
        args: ['--direct-row', ''],
      });
      expect(JSON.parse(generic.stdout)).toMatchObject({
        identity: 'extension-bundle',
        args: ['--generic-row'],
      });
      expect(direct.stderr).toBe('');
      expect(generic.stderr).toBe('');
    } finally {
      await closeServer(proxy.server);
    }
  });
});
