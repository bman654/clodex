import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterEach, describe, expect, it } from 'vitest';

interface WorkerProcess {
  child: ChildProcess;
  ready: Promise<void>;
  exit: Promise<{ code: number | null; stderr: string }>;
}

const roots: string[] = [];
const workers = new Set<WorkerProcess>();

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'config-concurrency-'));
  roots.push(root);
  return root;
}

async function buildWorker(root: string): Promise<string> {
  const outDir = join(root, 'worker-build');
  await build({
    entry: [
      fileURLToPath(
        new URL('./fixtures/config-write-worker.ts', import.meta.url),
      ),
    ],
    outDir,
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    sourcemap: false,
    external: ['@napi-rs/keyring'],
    clean: false,
    silent: true,
    config: false,
  });
  return join(outDir, 'config-write-worker.mjs');
}

function workerEnvironment(
  configHome: string,
  workerId: string,
  writeCount: number,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CLODEX_HOME: configHome,
    CONFIG_WRITE_WORKER_ID: workerId,
    CONFIG_WRITE_COUNT: String(writeCount),
  };
  for (const key of [
    'HOME',
    'PATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function spawnWorker(
  workerPath: string,
  configHome: string,
  workerId: string,
  writeCount: number,
): WorkerProcess {
  const child = spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: workerEnvironment(configHome, workerId, writeCount),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for worker ${workerId}`)),
      5_000,
    );
    const checkReady = (): void => {
      if (!stdout.includes('READY\n')) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout?.on('data', checkReady);
    child.once('error', reject);
    checkReady();
  });
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
  const worker = { child, ready, exit };
  workers.add(worker);
  void exit.then(
    () => workers.delete(worker),
    () => workers.delete(worker),
  );
  return worker;
}

async function observeJsonUntil(
  path: string,
  done: Promise<unknown>,
): Promise<string[]> {
  let finished = false;
  void done.finally(() => {
    finished = true;
  });
  const malformed: string[] = [];
  while (!finished) {
    if (existsSync(path)) {
      try {
        JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          malformed.push(String(error));
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return malformed;
}

afterEach(async () => {
  for (const worker of workers) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGTERM');
    }
  }
  await Promise.allSettled([...workers].map(worker => worker.exit));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('preference write concurrency', () => {
  it('preserves every concurrent update and never exposes malformed JSON', async () => {
    const root = temporaryRoot();
    const configHome = join(root, 'clodex-home');
    const configPath = join(configHome, 'config.json');
    const workerPath = await buildWorker(root);
    const workerCount = 8;
    const writesPerWorker = 4;
    const spawned = Array.from({ length: workerCount }, (_, index) =>
      spawnWorker(workerPath, configHome, `worker-${index}`, writesPerWorker),
    );

    await Promise.all(spawned.map(worker => worker.ready));
    const exits = Promise.all(spawned.map(worker => worker.exit));
    const malformed = observeJsonUntil(configPath, exits);
    for (const worker of spawned) worker.child.stdin?.end('START\n');

    const results = await exits;
    expect(results).toEqual(
      Array.from({ length: workerCount }, () => ({ code: 0, stderr: '' })),
    );
    expect(await malformed).toEqual([]);

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      appPathOverrides?: Record<string, string>;
    };
    const expected = Object.fromEntries(
      Array.from({ length: workerCount }, (_, workerIndex) =>
        Array.from({ length: writesPerWorker }, (_, writeIndex) => {
          const key = `worker-${workerIndex}-${writeIndex}`;
          return [key, `/tmp/${key}`];
        }),
      ).flat(),
    );
    expect(config.appPathOverrides).toEqual(expected);
  }, 30_000);
});
