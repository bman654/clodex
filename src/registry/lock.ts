import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getProvidersPath } from '../paths.js';

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_RETRY_MS = 25;
const INVALID_LOCK_STALE_MS = 10 * 60 * 1000;

interface RegistryLockOwner {
  pid: number;
  startedAt: number;
  token: string;
}

interface RegistryLockSnapshot {
  raw: string;
  device: number;
  inode: number;
  modifiedAt: number;
}

interface RegistryLockOptions {
  lockPath?: string;
  waitMs?: number;
  retryMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

interface RegistryLockContext {
  leases: ReadonlyMap<string, RegistryLockLease>;
}

interface RegistryLockLease {
  active: boolean;
}

const registryLockContext = new AsyncLocalStorage<RegistryLockContext>();

export function getRegistryLockPath(): string {
  return `${getProvidersPath()}.lock`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLockOwner(raw: string): RegistryLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RegistryLockOwner>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (
      typeof parsed.startedAt !== 'number' ||
      !Number.isFinite(parsed.startedAt)
    )
      return null;
    if (typeof parsed.token !== 'string' || parsed.token.length === 0)
      return null;
    return parsed as RegistryLockOwner;
  } catch {
    return null;
  }
}

function getStaleLockSnapshot(
  lockPath: string,
  now: number,
  alive: (pid: number) => boolean,
): RegistryLockSnapshot | null {
  const raw = readFileSync(lockPath, 'utf8');
  const stats = statSync(lockPath);
  const snapshot: RegistryLockSnapshot = {
    raw,
    device: stats.dev,
    inode: stats.ino,
    modifiedAt: stats.mtimeMs,
  };
  const owner = parseLockOwner(raw);
  if (owner) return alive(owner.pid) ? null : snapshot;

  // A process can be between exclusive creation and writing its owner record.
  // Only reap malformed locks after a long grace period.
  return now - snapshot.modifiedAt >= INVALID_LOCK_STALE_MS ? snapshot : null;
}

function removeStaleLock(
  lockPath: string,
  expected?: RegistryLockSnapshot,
): boolean {
  try {
    if (expected) {
      const raw = readFileSync(lockPath, 'utf8');
      const stats = statSync(lockPath);
      if (
        raw !== expected.raw ||
        stats.dev !== expected.device ||
        stats.ino !== expected.inode ||
        stats.mtimeMs !== expected.modifiedAt
      )
        return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

function tryAcquireReaperGuard(
  lockPath: string,
  now: number,
  alive: (pid: number) => boolean,
): (() => void) | null {
  const guardPath = `${lockPath}.reap`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(guardPath, 'wx', 0o600);
      const owner: RegistryLockOwner = {
        pid: process.pid,
        startedAt: now,
        token,
      };
      writeFileSync(fd, JSON.stringify(owner));
      closeSync(fd);
      fd = undefined;
      return () => {
        try {
          const current = parseLockOwner(readFileSync(guardPath, 'utf8'));
          if (current?.token === token) unlinkSync(guardPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      };
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The original error remains authoritative.
        }
        removeStaleLock(guardPath);
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      let stale: RegistryLockSnapshot | null = null;
      try {
        stale = getStaleLockSnapshot(guardPath, now, alive);
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readErr;
      }
      if (!stale) return null;
      if (!removeStaleLock(guardPath, stale)) continue;
    }
  }
  return null;
}

export function tryAcquireRegistryLock(
  lockPath = getRegistryLockPath(),
  options: Pick<RegistryLockOptions, 'now' | 'isAlive'> = {},
): (() => void) | null {
  const now = options.now?.() ?? Date.now();
  const alive = options.isAlive ?? isPidAlive;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      const owner: RegistryLockOwner = {
        pid: process.pid,
        startedAt: now,
        token,
      };
      writeFileSync(fd, JSON.stringify(owner));
      closeSync(fd);
      fd = undefined;
      return () => {
        try {
          const current = parseLockOwner(readFileSync(lockPath, 'utf8'));
          if (current?.token === token) unlinkSync(lockPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      };
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The original error remains authoritative.
        }
        removeStaleLock(lockPath);
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      let stale: RegistryLockSnapshot | null = null;
      try {
        stale = getStaleLockSnapshot(lockPath, now, alive);
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readErr;
      }
      if (!stale) return null;
      const releaseReaper = tryAcquireReaperGuard(lockPath, now, alive);
      if (!releaseReaper) return null;
      try {
        let currentStale: RegistryLockSnapshot | null = null;
        try {
          currentStale = getStaleLockSnapshot(lockPath, now, alive);
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readErr;
        }
        if (!currentStale) return null;
        if (!removeStaleLock(lockPath, currentStale)) continue;
      } finally {
        releaseReaper();
      }
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockTimeoutError(lockPath: string, waitMs: number): Error {
  return new Error(
    `Timed out after ${waitMs}ms waiting for provider registry lock: ${lockPath}`,
  );
}

export async function withRegistryWriteLock<T>(
  operation: () => Promise<T> | T,
  options: RegistryLockOptions = {},
): Promise<T> {
  const lockPath = options.lockPath ?? getRegistryLockPath();
  const inheritedLeases = registryLockContext.getStore()?.leases;
  if (inheritedLeases?.get(lockPath)?.active) return operation();

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  let release: (() => void) | null = null;

  while (!release) {
    release = tryAcquireRegistryLock(lockPath, {
      now,
      isAlive: options.isAlive,
    });
    if (release) break;
    if (now() >= deadline) throw lockTimeoutError(lockPath, waitMs);
    await sleep(retryMs);
  }

  const lease: RegistryLockLease = { active: true };
  const leases = new Map(inheritedLeases);
  leases.set(lockPath, lease);
  const context: RegistryLockContext = { leases };
  return registryLockContext.run(context, async () => {
    try {
      return await operation();
    } finally {
      lease.active = false;
      release?.();
    }
  });
}

export function withRegistryWriteLockSync<T>(
  operation: () => T,
  options: RegistryLockOptions = {},
): T {
  const lockPath = options.lockPath ?? getRegistryLockPath();
  const inheritedLeases = registryLockContext.getStore()?.leases;
  if (inheritedLeases?.get(lockPath)?.active) return operation();

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  let release: (() => void) | null = null;

  while (!release) {
    release = tryAcquireRegistryLock(lockPath, {
      now,
      isAlive: options.isAlive,
    });
    if (release) break;
    if (now() >= deadline) throw lockTimeoutError(lockPath, waitMs);
    sleepSync(retryMs);
  }

  const lease: RegistryLockLease = { active: true };
  const leases = new Map(inheritedLeases);
  leases.set(lockPath, lease);
  const context: RegistryLockContext = { leases };
  return registryLockContext.run(context, () => {
    try {
      return operation();
    } finally {
      lease.active = false;
      release?.();
    }
  });
}
