// src/server-runtime.ts
//
// Runtime-state advertisement for the standalone `clodex server` command.
// Each registering server ADDS its own record (keyed by pid) to
// ~/.clodex/server-runtime.json on startup and removes ONLY its own record on
// graceful shutdown, so other processes (notably the `clodex-claude` wrapper
// bin) can discover every running server's mode, port, and CA path without any
// hardcoding. The file holds an ARRAY of records; the legacy single-object
// shape (pre multi-server) is tolerated on read as a one-element list. Stale
// detection is the READER's job: a crashed server leaves its record behind, so
// readers must validate pid liveness before trusting it. Writers additionally
// prune dead-pid records while they hold the write lock.
//
// Concurrency: read-modify-write cycles are serialized by a short-lived pid
// lock (~/.clodex/server-runtime.lock — same pattern as the patcher's
// patch.lock: O_EXCL create, pid + staleness, ESRCH liveness) and the file is
// replaced via write-temp-then-rename so a reader never sees a torn write. A
// crashed lock holder cannot deadlock registration: the lock goes stale after
// 10 seconds or when its pid dies, and after a brief bounded wait a writer
// proceeds lockless (best-effort — same exposure as the old single-slot write).
//
// NOTE: only the standalone `clodex server` command writes this file. The
// per-session MITM proxy spawned by `clodex claude --proxy` is private to that
// session and must NOT advertise itself here. `clodex server --no-discovery`
// (or CLODEX_NO_DISCOVERY=1) also opts a server out of registration entirely.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getAppHome } from './paths.js';

export interface ServerRuntimeState {
  mode: 'endpoint' | 'proxy';
  port: number;
  pid: number;
  /** Proxy mode only: absolute path to the CA bundle a client must trust. */
  caPath?: string;
  startedAt: string;
}

interface HomeEnv {
  HOME?: string;
  CLODEX_HOME?: string;
  USERPROFILE?: string;
}

export function getServerRuntimePath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'server-runtime.json');
}

export function getServerRuntimeLockPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'server-runtime.lock');
}

/** `--no-discovery` flag, with CLODEX_NO_DISCOVERY=1 as the env fallback. */
export function isDiscoveryDisabled(
  flag: boolean | undefined,
  env: { CLODEX_NO_DISCOVERY?: string } = process.env,
): boolean {
  if (flag !== undefined) return flag;
  const raw = env.CLODEX_NO_DISCOVERY?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Validate one runtime record. Returns null for anything malformed. */
export function parseServerRuntimeRecord(value: unknown): ServerRuntimeState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const mode = record['mode'];
  if (mode !== 'endpoint' && mode !== 'proxy') return null;
  if (!isPort(record['port'])) return null;
  const pid = record['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = typeof record['startedAt'] === 'string' ? record['startedAt'] : '';

  const caPath = record['caPath'];
  if (mode === 'proxy') {
    // A proxy-mode server without a CA path is unusable to clients — treat as invalid.
    if (typeof caPath !== 'string' || !caPath.trim()) return null;
    return { mode, port: record['port'], pid, caPath, startedAt };
  }
  return { mode, port: record['port'], pid, startedAt };
}

/**
 * Parse a raw server-runtime.json payload into a list of records. Tolerates
 * BOTH shapes: the current array of records and the legacy single object
 * (wrapped as a one-element list). Malformed input or records are skipped —
 * never throws.
 */
export function parseServerRuntimeStates(raw: string): ServerRuntimeState[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const states: ServerRuntimeState[] = [];
  for (const item of items) {
    const state = parseServerRuntimeRecord(item);
    if (state) states.push(state);
  }
  return states;
}

/** kill(pid, 0) liveness probe: EPERM still means the process exists. */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => unknown = process.kill.bind(process),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

// ── Write lock (pid + staleness, patcher pattern) ───────────────────────────

const RUNTIME_LOCK_STALE_MS = 10_000;
const RUNTIME_LOCK_WAIT_MS = 500;
const RUNTIME_LOCK_RETRY_MS = 25;

interface RuntimeLockContent {
  pid: number;
  startedAt: number;
}

function tryAcquireRuntimeLock(
  lockPath: string,
  opts: { now?: number; isAlive?: (pid: number) => boolean } = {},
): (() => void) | null {
  const now = opts.now ?? Date.now();
  const alive = opts.isAlive ?? isPidAlive;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      const content: RuntimeLockContent = { pid: process.pid, startedAt: now };
      writeFileSync(fd, JSON.stringify(content));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch {
      // Lock exists — check staleness.
      let stale = false;
      try {
        const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as RuntimeLockContent;
        stale = !existing.pid
          || !alive(existing.pid)
          || (typeof existing.startedAt === 'number' && now - existing.startedAt > RUNTIME_LOCK_STALE_MS);
      } catch {
        stale = true; // unreadable lock file → stale
      }
      if (!stale) return null;
      try {
        unlinkSync(lockPath);
      } catch {
        // raced with the owner's cleanup — retry loop handles it
      }
    }
  }
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a read-modify-write mutation under the runtime lock. The lock is only
 * ever held for a few milliseconds, so after a short bounded wait the mutation
 * proceeds WITHOUT the lock rather than dropping a registration — the atomic
 * rename still prevents torn files; the worst case is a lost concurrent
 * update, which is no worse than the old single-slot behavior.
 */
function withRuntimeWriteLock(env: HomeEnv, mutate: () => void): void {
  const lockPath = getServerRuntimeLockPath(env);
  let release: (() => void) | null = null;
  const deadline = Date.now() + RUNTIME_LOCK_WAIT_MS;
  for (;;) {
    release = tryAcquireRuntimeLock(lockPath);
    if (release || Date.now() >= deadline) break;
    sleepSync(RUNTIME_LOCK_RETRY_MS);
  }
  try {
    mutate();
  } finally {
    release?.();
  }
}

function readAllRecords(env: HomeEnv): ServerRuntimeState[] {
  let raw: string;
  try {
    raw = readFileSync(getServerRuntimePath(env), 'utf8');
  } catch {
    return [];
  }
  return parseServerRuntimeStates(raw);
}

/** Atomic replace: write a temp file in the same directory, then rename over. */
function atomicWriteRecords(path: string, records: ServerRuntimeState[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, path);
}

export interface RuntimeMutateOptions {
  isAlive?: (pid: number) => boolean;
}

/**
 * Add or update this server's own record (keyed by pid), pruning records whose
 * pids are dead. Best-effort — a state-file failure must never take the server
 * down.
 */
export function registerServerRuntimeState(
  state: ServerRuntimeState,
  env: HomeEnv = process.env,
  options: RuntimeMutateOptions = {},
): void {
  const alive = options.isAlive ?? isPidAlive;
  try {
    withRuntimeWriteLock(env, () => {
      const records = readAllRecords(env).filter(
        record => record.pid !== state.pid && alive(record.pid),
      );
      records.push(state);
      atomicWriteRecords(getServerRuntimePath(env), records);
    });
  } catch {
    // Discovery is optional; the server itself keeps running.
  }
}

/**
 * Remove ONLY this server's own record (by pid) on graceful shutdown, pruning
 * dead-pid records along the way. Missing file/record is fine. When no live
 * records remain the file is removed entirely.
 */
export function unregisterServerRuntimeState(
  pid: number = process.pid,
  env: HomeEnv = process.env,
  options: RuntimeMutateOptions = {},
): void {
  const alive = options.isAlive ?? isPidAlive;
  try {
    withRuntimeWriteLock(env, () => {
      const records = readAllRecords(env).filter(
        record => record.pid !== pid && alive(record.pid),
      );
      if (records.length === 0) {
        rmSync(getServerRuntimePath(env), { force: true });
      } else {
        atomicWriteRecords(getServerRuntimePath(env), records);
      }
    });
  } catch {
    // Stale records are handled by readers via pid liveness.
  }
}

export interface ReadServerRuntimeOptions {
  isAlive?: (pid: number) => boolean;
}

/**
 * Read every advertised server record whose process is still alive. Missing or
 * malformed files yield an empty list. Read-only: stale records are ignored
 * here and physically pruned on the next registration/unregistration.
 */
export function readLiveServerRuntimeStates(
  env: HomeEnv = process.env,
  options: ReadServerRuntimeOptions = {},
): ServerRuntimeState[] {
  const alive = options.isAlive ?? isPidAlive;
  return readAllRecords(env).filter(state => alive(state.pid));
}

/**
 * Wrapper selection policy: order candidate servers by preference —
 *  1. proxy mode before endpoint mode (bridging through the MITM proxy keeps
 *     Claude Code's own Anthropic auth, the recommended setup);
 *  2. within a mode, newest startedAt first.
 * If only an endpoint server is live it is used; with no live server the
 * wrapper launches claude untouched (both handled by the caller).
 */
export function orderWrapperServerCandidates(records: ServerRuntimeState[]): ServerRuntimeState[] {
  return [...records].sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === 'proxy' ? -1 : 1;
    return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0);
  });
}

/**
 * Read the single preferred live server (selection policy above), or null when
 * none is advertised/alive.
 */
export function readLiveServerRuntimeState(
  env: HomeEnv = process.env,
  options: ReadServerRuntimeOptions = {},
): ServerRuntimeState | null {
  return orderWrapperServerCandidates(readLiveServerRuntimeStates(env, options))[0] ?? null;
}
