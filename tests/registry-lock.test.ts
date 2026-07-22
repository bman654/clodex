import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RegistryLockLostError,
  getCredentialLockRoot,
  getCredentialMutationLockPath,
  getCredentialStateRoot,
  tryAcquireRegistryLock,
  withCredentialMutationLock,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from '../src/registry/lock.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';

const roots: string[] = [];
const workers = new Set<WorkerProcess>();

type WorkerRole =
  | 'holder'
  | 'contender'
  | 'lease-loss'
  | 'atomic-acquire'
  | 'credential-holder'
  | 'credential-contender';

interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface WorkerProcess {
  child: ChildProcess;
  exit: Promise<WorkerExit>;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'registry-lock-'));
  roots.push(root);
  return root;
}

function temporaryLockPath(): string {
  return join(temporaryRoot(), 'providers.lock');
}

function workerEnvironment(
  root: string,
  role: WorkerRole,
  options: {
    clodexHome?: string;
    overrides?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CLODEX_HOME: options.clodexHome ?? root,
    REGISTRY_LOCK_WORKER_ROOT: root,
    REGISTRY_LOCK_WORKER_ROLE: role,
  };
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, options.overrides);
  return environment;
}

function spawnWorker(
  workerPath: string,
  root: string,
  role: WorkerRole,
  options: {
    clodexHome?: string;
    overrides?: NodeJS.ProcessEnv;
  } = {},
): WorkerProcess {
  const child = spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: workerEnvironment(root, role, options),
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const exit = new Promise<WorkerExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  const worker = { child, exit };
  workers.add(worker);
  void exit.then(
    () => workers.delete(worker),
    () => workers.delete(worker),
  );
  return worker;
}

async function buildWorker(root: string): Promise<string> {
  const outDir = join(root, 'worker-build');
  await build({
    entry: [fileURLToPath(new URL('./fixtures/registry-lock-worker.ts', import.meta.url))],
    outDir,
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    sourcemap: false,
    clean: false,
    silent: true,
    config: false,
  });
  return join(outDir, 'registry-lock-worker.mjs');
}

async function waitForJson<T>(path: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
      } catch {
        // Retry while the creating process finishes its synchronous write.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for JSON result: ${path}`);
}

function lockArtifacts(root: string): string[] {
  return readdirSync(root)
    .filter(name => name.includes('.lock') || name.endsWith('.tmp'))
    .sort();
}

afterEach(async () => {
  for (const worker of workers) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGTERM');
    }
  }
  await Promise.allSettled([...workers].map(worker => worker.exit));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider registry lock', () => {
  it('allows only one owner until the matching release runs', () => {
    const lockPath = temporaryLockPath();
    const lease = tryAcquireRegistryLock(lockPath);
    expect(lease).toMatchObject({ active: true });
    expect(tryAcquireRegistryLock(lockPath)).toBeNull();

    lease?.release();
    const nextLease = tryAcquireRegistryLock(lockPath);
    expect(nextLease).toMatchObject({ active: true });
    nextLease?.release();
  });

  it('retains a fresh lock owned by a live process and reaps a dead owner', () => {
    const lockPath = temporaryLockPath();
    const now = Date.now();
    writeFileSync(lockPath, JSON.stringify({ pid: 1234, startedAt: now, token: 'first-owner' }));

    expect(tryAcquireRegistryLock(lockPath, { now: () => now, isAlive: () => true })).toBeNull();
    const lease = tryAcquireRegistryLock(lockPath, {
      now: () => now,
      isAlive: () => false,
    });
    expect(lease).toMatchObject({ active: true });
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).not.toBe('first-owner');
    lease?.release();
  });

  it('retains a lock whose owner remains alive regardless of age', () => {
    const lockPath = temporaryLockPath();
    const now = Date.now();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1234,
        startedAt: now - 10 * 60 * 1000,
        token: 'expired-owner',
      }),
    );

    expect(
      tryAcquireRegistryLock(lockPath, {
        now: () => now,
        isAlive: () => true,
      }),
    ).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe('expired-owner');
  });

  it('does not remove a replacement created during stale-lock reclamation', () => {
    const lockPath = temporaryLockPath();
    const stalePid = 1234;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: stalePid,
        startedAt: Date.now() - 60_000,
        token: 'stale-owner',
      }),
    );

    let competingLease: ReturnType<typeof tryAcquireRegistryLock> = null;
    let interleaved = false;
    const lease = tryAcquireRegistryLock(lockPath, {
      isAlive: pid => {
        if (pid === stalePid && !interleaved) {
          interleaved = true;
          competingLease = tryAcquireRegistryLock(lockPath, {
            isAlive: () => false,
          });
        }
        return pid !== stalePid;
      },
    });

    try {
      expect(competingLease).toMatchObject({ active: true });
      expect(lease).toBeNull();
    } finally {
      lease?.release();
      competingLease?.release();
    }
  });

  it('serializes stale reclamation through a separate reaper guard', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1234,
        startedAt: Date.now() - 60_000,
        token: 'stale-owner',
      }),
    );
    writeFileSync(
      `${lockPath}.reap`,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        token: 'active-reaper',
      }),
    );

    expect(
      tryAcquireRegistryLock(lockPath, {
        isAlive: pid => pid === process.pid,
      }),
    ).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe('stale-owner');
  });

  it('recovers when a dead process leaves the reaper guard behind', () => {
    const lockPath = temporaryLockPath();
    const deadOwner = {
      pid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      token: 'dead-owner',
    };
    writeFileSync(lockPath, JSON.stringify(deadOwner));
    writeFileSync(`${lockPath}.reap`, JSON.stringify(deadOwner));

    const lease = tryAcquireRegistryLock(lockPath, { isAlive: () => false });

    expect(lease).toMatchObject({ active: true });
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).not.toBe('dead-owner');
    lease?.release();
  });

  it('acquires nested locks when their paths differ', async () => {
    const firstPath = temporaryLockPath();
    const secondPath = temporaryLockPath();

    await withRegistryWriteLock(
      async () => {
        await withRegistryWriteLock(
          () => {
            expect(tryAcquireRegistryLock(secondPath)).toBeNull();
          },
          { lockPath: secondPath },
        );
      },
      { lockPath: firstPath },
    );

    const lease = tryAcquireRegistryLock(secondPath);
    expect(lease).toMatchObject({ active: true });
    lease?.release();
  });

  it('serializes independent asynchronous callers', async () => {
    const lockPath = temporaryLockPath();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = withRegistryWriteLock(
      async () => {
        events.push('first-enter');
        await firstGate;
        events.push('first-exit');
      },
      { lockPath, waitMs: 1_000, retryMs: 5 },
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = withRegistryWriteLock(
      () => {
        events.push('second-enter');
      },
      { lockPath, waitMs: 1_000, retryMs: 5 },
    );
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(events).toEqual(['first-enter']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });

  it('serializes mutations for the same credential reference', async () => {
    const home = dirname(temporaryLockPath());
    const previousHome = process.env.CLODEX_HOME;
    process.env.CLODEX_HOME = home;
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    try {
      const first = withCredentialMutationLock(
        'keyring:provider:openai',
        async () => {
          events.push('first-enter');
          await firstGate;
          events.push('first-exit');
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = withCredentialMutationLock('keyring:provider:openai', () => {
          events.push('second-enter');
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(events).toEqual(['first-enter']);
      expect(getCredentialMutationLockPath('keyring:provider:openai')).not.toContain(
        'provider:openai',
      );
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
    } finally {
      if (previousHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousHome;
    }
  });

  it('keeps credential lock paths independent of process environment homes', () => {
    const keys = [
      'CLODEX_HOME',
      'HOME',
      'USERPROFILE',
      'XDG_RUNTIME_DIR',
      'TMPDIR',
      'TEMP',
      'TMP',
    ] as const;
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    const authRef = `keyring:test:${randomUUID()}`;

    try {
      for (const key of keys) process.env[key] = `/tmp/credential-lock-a/${key}`;
      const first = getCredentialMutationLockPath(authRef);
      for (const key of keys) process.env[key] = `/tmp/credential-lock-b/${key}`;
      const second = getCredentialMutationLockPath(authRef);

      expect(second).toBe(first);
      expect(dirname(first)).toBe(getCredentialLockRoot());
      expect(first).not.toContain(authRef);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('waits for a credential mutation holder through the refresh budget', async () => {
    vi.useFakeTimers();
    const home = dirname(temporaryLockPath());
    const previousHome = process.env.CLODEX_HOME;
    process.env.CLODEX_HOME = home;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;

    try {
      first = withCredentialMutationLock(
        'keyring:oauth:provider:openai-oauth',
        () => firstGate,
      );
      let outcome: 'pending' | 'acquired' | 'rejected' = 'pending';
      second = withCredentialMutationLock(
        'keyring:oauth:provider:openai-oauth',
        () => {
          outcome = 'acquired';
        },
        { retryMs: 30_000 },
      ).catch(() => {
        outcome = 'rejected';
      });

      await vi.advanceTimersByTimeAsync(149_999);
      expect(outcome).toBe('pending');
      releaseFirst();
      await first;
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(outcome).toBe('acquired');
    } finally {
      releaseFirst();
      await vi.runOnlyPendingTimersAsync();
      await Promise.allSettled([first, second].filter(
        (operation): operation is Promise<void> => operation !== undefined,
      ));
      vi.useRealTimers();
      if (previousHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousHome;
    }
  });

  it('invalidates inherited asynchronous ownership after releasing the lock', async () => {
    const lockPath = temporaryLockPath();
    const events: string[] = [];
    let startDetached!: () => void;
    const detachedGate = new Promise<void>(resolve => {
      startDetached = resolve;
    });
    let detached: Promise<void> | undefined;

    await withRegistryWriteLock(
      () => {
        detached = (async () => {
          await detachedGate;
          await withRegistryWriteLock(
            () => {
              events.push('detached-enter');
            },
            { lockPath, waitMs: 1_000, retryMs: 5 },
          );
        })();
      },
      { lockPath, waitMs: 1_000, retryMs: 5 },
    );

    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    let markSecondEntered!: () => void;
    const secondEntered = new Promise<void>(resolve => {
      markSecondEntered = resolve;
    });
    const second = withRegistryWriteLock(
      async () => {
        events.push('second-enter');
        markSecondEntered();
        await secondGate;
        events.push('second-exit');
      },
      { lockPath, waitMs: 1_000, retryMs: 5 },
    );

    await secondEntered;
    startDetached();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events).toEqual(['second-enter']);

    releaseSecond();
    await Promise.all([second, detached]);
    expect(events).toEqual(['second-enter', 'second-exit', 'detached-enter']);
  });

  it('invalidates inherited synchronous ownership after releasing the lock', async () => {
    const lockPath = temporaryLockPath();
    const events: string[] = [];
    let detachedError: unknown;
    let finishDetached!: () => void;
    const detachedFinished = new Promise<void>(resolve => {
      finishDetached = resolve;
    });

    withRegistryWriteLockSync(
      () => {
        setImmediate(() => {
          try {
            withRegistryWriteLockSync(
              () => {
                events.push('detached-enter');
              },
              { lockPath, waitMs: 0 },
            );
          } catch (error) {
            detachedError = error;
          } finally {
            finishDetached();
          }
        });
      },
      { lockPath },
    );

    const lease = tryAcquireRegistryLock(lockPath);
    expect(lease).toMatchObject({ active: true });
    try {
      await detachedFinished;
    } finally {
      lease?.release();
    }

    expect(events).toEqual([]);
    expect(detachedError).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Timed out after 0ms'),
      }),
    );
  });

  it('reclaims an incomplete lock without waiting for the normal timeout', () => {
    const lockPath = temporaryLockPath();
    writeFileSync(lockPath, '');

    const lease = tryAcquireRegistryLock(lockPath, {
      isAlive: () => true,
    });

    expect(lease).toMatchObject({ active: true });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(
      expect.objectContaining({
        pid: process.pid,
        token: expect.any(String),
      }),
    );
    lease?.release();
  });

  it('rejects registry writes without an active matching lease', () => {
    const registryPath = temporaryLockPath().replace(/\.lock$/, '');

    expect(() => saveRegistry(emptyRegistry(), registryPath)).toThrow(RegistryLockLostError);
  });

  it('does not use a lease to authorize a different registry path', () => {
    const lockPath = temporaryLockPath();
    const otherRegistryPath = temporaryLockPath().replace(/\.lock$/, '');

    withRegistryWriteLockSync(
      () => {
        expect(() => saveRegistry(emptyRegistry(), otherRegistryPath)).toThrow(
          RegistryLockLostError,
        );
      },
      { lockPath },
    );
  });

  it('does not age-evict a live owner across processes', async () => {
    const root = temporaryRoot();
    const workerPath = await buildWorker(root);
    const registryPath = join(root, 'providers.json');
    const lockPath = `${registryPath}.lock`;
    const releasePath = join(root, 'release-holder');
    const holder = spawnWorker(workerPath, root, 'holder');

    try {
      const ready = await waitForJson<{ pid: number; token: string }>(
        join(root, 'holder-ready.json'),
      );
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        pid: number;
        startedAt: number;
        token: string;
      };
      expect(owner).toMatchObject(ready);
      writeFileSync(
        lockPath,
        JSON.stringify({
          ...owner,
          startedAt: Date.now() - 11 * 60 * 1000,
        }),
      );

      const contender = spawnWorker(workerPath, root, 'contender');
      const contenderExit = await contender.exit;
      expect(
        contenderExit.code,
        `contender stderr:\n${contenderExit.stderr}\nstdout:\n${contenderExit.stdout}`,
      ).toBe(0);
      const contenderResult = await waitForJson<{
        acquired: boolean;
        error?: string;
      }>(join(root, 'contender-result.json'));
      expect(contenderResult.acquired).toBe(false);
      expect(contenderResult.error).toContain('Timed out after 250ms waiting for lock');
      expect(contenderResult.error).toContain(String(ready.pid));

      const retainedOwner = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        pid: number;
        token: string;
      };
      expect(retainedOwner).toMatchObject(ready);
      expect(JSON.parse(readFileSync(registryPath, 'utf8')).importedAt).toBe('holder-initial');

      writeFileSync(releasePath, 'release\n');
      const holderExit = await holder.exit;
      expect(
        holderExit.code,
        `holder stderr:\n${holderExit.stderr}\nstdout:\n${holderExit.stdout}`,
      ).toBe(0);
      expect(await waitForJson(join(root, 'holder-result.json'))).toEqual({
        ok: true,
      });
      expect(JSON.parse(readFileSync(registryPath, 'utf8')).importedAt).toBe('holder-final');
      expect(lockArtifacts(root)).toEqual([]);
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, 'release\n');
      if (holder.child.exitCode === null && holder.child.signalCode === null) {
        await holder.exit;
      }
    }
  }, 15_000);

  it('prepares the complete lock record before publishing its path', async () => {
    const root = temporaryRoot();
    const workerPath = await buildWorker(root);
    const lockPath = join(root, 'providers.json.lock');
    const releasePath = join(root, 'release-atomic-acquire');
    const worker = spawnWorker(workerPath, root, 'atomic-acquire');

    try {
      const ready = await waitForJson<{
        candidatePath: string;
        pid: number;
      }>(join(root, 'atomic-acquire-ready.json'));
      expect(ready.candidatePath).not.toBe(lockPath);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(ready.candidatePath)).toBe(true);
      expect(statSync(ready.candidatePath).size).toBe(0);

      writeFileSync(releasePath, 'release\n');
      const workerExit = await worker.exit;
      expect(
        workerExit.code,
        `worker stderr:\n${workerExit.stderr}\nstdout:\n${workerExit.stdout}`,
      ).toBe(0);
      expect(await waitForJson(join(root, 'atomic-acquire-result.json'))).toEqual({
        acquired: true,
        ownerPid: ready.pid,
        ownerToken: expect.any(String),
      });
      expect(lockArtifacts(root)).toEqual([]);
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, 'release\n');
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        await worker.exit;
      }
    }
  }, 10_000);

  it('serializes a credential across processes with different environment homes', async () => {
    const root = temporaryRoot();
    const holderHome = temporaryRoot();
    const contenderHome = temporaryRoot();
    const holderRuntime = temporaryRoot();
    const contenderRuntime = temporaryRoot();
    const credentialRef = `keyring:test:${randomUUID()}`;
    const workerPath = await buildWorker(root);
    const releasePath = join(root, 'release-credential-holder');
    const enteredPath = join(root, 'credential-contender-entered.json');
    const holder = spawnWorker(workerPath, root, 'credential-holder', {
      clodexHome: holderHome,
      overrides: {
        HOME: holderHome,
        XDG_RUNTIME_DIR: holderRuntime,
        TMPDIR: holderRuntime,
        REGISTRY_LOCK_CREDENTIAL_REF: credentialRef,
      },
    });
    let contender: WorkerProcess | undefined;

    try {
      const holderReady = await waitForJson<{
        pid: number;
        lockPath: string;
        stateRoot: string;
      }>(join(root, 'credential-holder-ready.json'));
      expect(existsSync(holderReady.lockPath)).toBe(true);

      contender = spawnWorker(workerPath, root, 'credential-contender', {
        clodexHome: contenderHome,
        overrides: {
          HOME: contenderHome,
          XDG_RUNTIME_DIR: contenderRuntime,
          TMPDIR: contenderRuntime,
          REGISTRY_LOCK_CREDENTIAL_REF: credentialRef,
        },
      });
      const contenderReady = await waitForJson<{
        pid: number;
        lockPath: string;
        stateRoot: string;
      }>(join(root, 'credential-contender-ready.json'));
      expect(contenderReady.lockPath).toBe(holderReady.lockPath);
      expect(contenderReady.stateRoot).toBe(holderReady.stateRoot);
      expect(contenderReady.stateRoot).toBe(getCredentialStateRoot());
      await new Promise(resolve => setTimeout(resolve, 125));
      expect(existsSync(enteredPath)).toBe(false);
      expect(contender.child.exitCode).toBeNull();

      writeFileSync(releasePath, 'release\n');
      const [holderExit, contenderExit] = await Promise.all([holder.exit, contender.exit]);
      expect(
        holderExit.code,
        `holder stderr:\n${holderExit.stderr}\nstdout:\n${holderExit.stdout}`,
      ).toBe(0);
      expect(
        contenderExit.code,
        `contender stderr:\n${contenderExit.stderr}\nstdout:\n${contenderExit.stdout}`,
      ).toBe(0);
      expect(await waitForJson(enteredPath)).toEqual({
        pid: contenderReady.pid,
      });
      expect(await waitForJson(join(root, 'credential-holder-result.json'))).toEqual({ ok: true });
      expect(await waitForJson(join(root, 'credential-contender-result.json'))).toEqual({
        ok: true,
      });
      expect(existsSync(holderReady.lockPath)).toBe(false);
      expect(lockArtifacts(root)).toEqual([]);
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, 'release\n');
      for (const worker of [holder, contender]) {
        if (
          worker &&
          worker.child.exitCode === null &&
          worker.child.signalCode === null
        ) {
          await worker.exit;
        }
      }
    }
  }, 10_000);

  it('rejects publication when the lease changes after the temporary write', async () => {
    const root = temporaryRoot();
    const workerPath = await buildWorker(root);
    const worker = spawnWorker(workerPath, root, 'lease-loss');
    const workerExit = await worker.exit;
    expect(
      workerExit.code,
      `worker stderr:\n${workerExit.stderr}\nstdout:\n${workerExit.stdout}`,
    ).toBe(0);

    const result = await waitForJson<{
      errorName: string | null;
      importedAt?: string;
      replacementPublished: boolean;
      replacementToken?: string;
      temporaryArtifacts: string[];
    }>(join(root, 'lease-loss-result.json'));
    expect(result).toMatchObject({
      errorName: 'RegistryLockLostError',
      importedAt: 'sentinel',
      replacementPublished: true,
      replacementToken: 'replacement-owner',
      temporaryArtifacts: [],
    });
    expect(lockArtifacts(root)).toEqual([]);
  }, 10_000);
});
