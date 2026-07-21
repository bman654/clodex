import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  tryAcquireRegistryLock,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from '../src/registry/lock.js';

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
    const release = tryAcquireRegistryLock(lockPath);
    expect(release).toBeTypeOf('function');
    expect(tryAcquireRegistryLock(lockPath)).toBeNull();

    release?.();
    const nextRelease = tryAcquireRegistryLock(lockPath);
    expect(nextRelease).toBeTypeOf('function');
    nextRelease?.();
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
    const release = tryAcquireRegistryLock(lockPath, {
      now: () => now,
      isAlive: () => false,
    });
    expect(release).toBeTypeOf('function');
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).not.toBe(
      'first-owner',
    );
    release?.();
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

    const release = tryAcquireRegistryLock(lockPath, {
      now: () => now,
      isAlive: () => true,
    });

    expect(release).toBeTypeOf('function');
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).not.toBe(
      'expired-owner',
    );
    release?.();
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

    let competingRelease: (() => void) | null = null;
    let interleaved = false;
    const release = tryAcquireRegistryLock(lockPath, {
      isAlive: (pid) => {
        if (pid === stalePid && !interleaved) {
          interleaved = true;
          competingRelease = tryAcquireRegistryLock(lockPath, {
            isAlive: () => false,
          });
        }
        return pid !== stalePid;
      },
    });

    try {
      expect(competingRelease).toBeTypeOf('function');
      expect(release).toBeNull();
    } finally {
      release?.();
      competingRelease?.();
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

    const release = tryAcquireRegistryLock(lockPath, { isAlive: () => false });

    expect(release).toBeTypeOf('function');
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).not.toBe(
      'dead-owner',
    );
    release?.();
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

    const release = tryAcquireRegistryLock(secondPath);
    expect(release).toBeTypeOf('function');
    release?.();
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

    const release = tryAcquireRegistryLock(lockPath);
    expect(release).toBeTypeOf('function');
    try {
      await detachedFinished;
    } finally {
      release?.();
    }

    expect(events).toEqual([]);
    expect(detachedError).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Timed out after 0ms'),
      }),
    );
  });
});
