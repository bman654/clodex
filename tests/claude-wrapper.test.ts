import { spawn } from 'node:child_process';
import {
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'tsup';

interface WrapperResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let buildRoot: string;
let wrapperPath: string;
let testRoot: string;
let clodexHome: string;
let helperPath: string;
let launchMarker: string;
let caPath: string;

async function runWrapper(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<WrapperResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLODEX_HOME: clodexHome,
    ...envOverrides,
  };
  if (!Object.hasOwn(envOverrides, 'CLODEX_REQUIRE_SERVER')) {
    delete env['CLODEX_REQUIRE_SERVER'];
  }

  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`wrapper timed out for arguments: ${args.join(' ')}`));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

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

describe('clodex-claude process wrapper', () => {
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
