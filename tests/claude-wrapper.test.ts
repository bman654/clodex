import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

async function openLoopbackServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
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

function advertiseEndpoint(port: number, pid = process.pid): void {
  mkdirSync(clodexHome, { recursive: true });
  writeFileSync(
    join(clodexHome, 'server-runtime.json'),
    `${JSON.stringify([
      {
        mode: 'endpoint',
        port,
        pid,
        startedAt: new Date().toISOString(),
      },
    ])}\n`,
  );
}

function claudeInvocation(exitCode = 0): string[] {
  return [process.execPath, helperPath, launchMarker, String(exitCode)];
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
  writeFileSync(
    helperPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.argv[2], 'launched\\n');",
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
});
