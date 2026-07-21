import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RegistryLockLostError,
  getCredentialMutationLockPath,
  tryAcquireRegistryLock,
  withCredentialMutationLock,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from '../src/registry/lock.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';

const roots: string[] = [];

function temporaryLockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'registry-lock-'));
  roots.push(root);
  return join(root, 'providers.lock');
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
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
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1234, startedAt: now, token: 'first-owner' }),
    );

    expect(
      tryAcquireRegistryLock(lockPath, { now: () => now, isAlive: () => true }),
    ).toBeNull();
    const lease = tryAcquireRegistryLock(lockPath, {
      now: () => now,
      isAlive: () => false,
    });
    expect(lease).toMatchObject({ active: true });
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).not.toBe(
      'first-owner',
    );
    lease?.release();
  });

  it('reaps an expired lock even when its owner process is still alive', () => {
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

    const lease = tryAcquireRegistryLock(lockPath, {
      now: () => now,
      isAlive: () => true,
    });

    expect(lease).toMatchObject({ active: true });
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).not.toBe(
      'expired-owner',
    );
    lease?.release();
  });

  it('does not reap an expired live owner for a credential mutation lock', () => {
    const lockPath = temporaryLockPath();
    const now = Date.now();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1234,
        startedAt: now - 10 * 60 * 1000,
        token: 'live-credential-owner',
      }),
    );

    expect(
      tryAcquireRegistryLock(lockPath, {
        now: () => now,
        isAlive: () => true,
        reclaimExpiredLiveOwner: false,
      }),
    ).toBeNull();
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
      isAlive: (pid) => {
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
        isAlive: (pid) => pid === process.pid,
      }),
    ).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe(
      'stale-owner',
    );
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
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).not.toBe(
      'dead-owner',
    );
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
    const firstGate = new Promise<void>((resolve) => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withRegistryWriteLock(
      () => {
        events.push('second-enter');
      },
      { lockPath, waitMs: 1_000, retryMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

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
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const first = withCredentialMutationLock(
        'keyring:provider:openai',
        async () => {
          events.push('first-enter');
          await firstGate;
          events.push('first-exit');
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = withCredentialMutationLock(
        'keyring:provider:openai',
        () => {
          events.push('second-enter');
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(events).toEqual(['first-enter']);
      expect(getCredentialMutationLockPath('keyring:provider:openai')).not
        .toContain('provider:openai');
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
    } finally {
      if (previousHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousHome;
    }
  });

  it('invalidates inherited asynchronous ownership after releasing the lock', async () => {
    const lockPath = temporaryLockPath();
    const events: string[] = [];
    let startDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
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
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let markSecondEntered!: () => void;
    const secondEntered = new Promise<void>((resolve) => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    const detachedFinished = new Promise<void>((resolve) => {
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

    expect(() => saveRegistry(emptyRegistry(), registryPath)).toThrow(
      RegistryLockLostError,
    );
  });

  it('does not use a lease to authorize a different registry path', () => {
    const lockPath = temporaryLockPath();
    const otherRegistryPath = temporaryLockPath().replace(/\.lock$/, '');

    withRegistryWriteLockSync(
      () => {
        expect(() =>
          saveRegistry(emptyRegistry(), otherRegistryPath),
        ).toThrow(RegistryLockLostError);
      },
      { lockPath },
    );
  });

  it('rejects an expired owner before it can overwrite a newer registry', async () => {
    const lockPath = temporaryLockPath();
    const registryPath = lockPath.replace(/\.lock$/, '');
    let now = Date.now();
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let resumeFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resumeFirst = resolve;
    });

    const first = withRegistryWriteLock(
      async () => {
        firstEntered();
        await firstGate;
        saveRegistry({ ...emptyRegistry(), importedAt: 'first' }, registryPath);
      },
      { lockPath, now: () => now, isAlive: () => true },
    );
    await entered;

    let secondSaved!: () => void;
    const secondSavedGate = new Promise<void>((resolve) => {
      secondSaved = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    now += 10 * 60 * 1000;
    const second = withRegistryWriteLock(
      async () => {
        saveRegistry({ ...emptyRegistry(), importedAt: 'second' }, registryPath);
        secondSaved();
        await secondGate;
      },
      { lockPath, now: () => now, isAlive: () => true },
    );
    await secondSavedGate;
    const secondToken = JSON.parse(readFileSync(lockPath, 'utf8')).token;

    resumeFirst();
    await expect(first).rejects.toBeInstanceOf(RegistryLockLostError);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe(secondToken);
    expect(
      tryAcquireRegistryLock(lockPath, {
        now: () => now,
        isAlive: () => true,
      }),
    ).toBeNull();

    releaseSecond();
    await second;
    expect(JSON.parse(readFileSync(registryPath, 'utf8')).importedAt).toBe(
      'second',
    );
  });
});
