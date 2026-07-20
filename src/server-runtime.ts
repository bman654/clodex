// src/server-runtime.ts
//
// Runtime-state advertisement for the standalone `clodex server` command.
// The server writes ~/.clodex/server-runtime.json on startup and removes it on
// graceful shutdown so other processes (notably the `clodex-claude` wrapper
// bin) can discover the running server's mode, port, and CA path without any
// hardcoding. Stale detection is the READER's job: a crashed server leaves the
// file behind, so readers must validate pid liveness before trusting it.
//
// NOTE: only the standalone `clodex server` command writes this file. The
// per-session MITM proxy spawned by `clodex claude --proxy` is private to that
// session and must NOT advertise itself here.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Parse + validate a raw server-runtime.json payload. Returns null for anything malformed. */
export function parseServerRuntimeState(raw: string): ServerRuntimeState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;

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

/** Best-effort write — a state-file failure must never take the server down. */
export function writeServerRuntimeState(state: ServerRuntimeState, env: HomeEnv = process.env): void {
  try {
    const path = getServerRuntimePath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Discovery is optional; the server itself keeps running.
  }
}

/** Best-effort removal on graceful shutdown. Missing file is fine. */
export function removeServerRuntimeState(env: HomeEnv = process.env): void {
  try {
    rmSync(getServerRuntimePath(env), { force: true });
  } catch {
    // Stale files are handled by readers via pid liveness.
  }
}

export interface ReadServerRuntimeOptions {
  isAlive?: (pid: number) => boolean;
}

/**
 * Read the advertised server state, returning null when the file is missing,
 * malformed, or refers to a process that is no longer alive (crashed server).
 */
export function readLiveServerRuntimeState(
  env: HomeEnv = process.env,
  options: ReadServerRuntimeOptions = {},
): ServerRuntimeState | null {
  let raw: string;
  try {
    raw = readFileSync(getServerRuntimePath(env), 'utf8');
  } catch {
    return null;
  }
  const state = parseServerRuntimeState(raw);
  if (!state) return null;
  const alive = options.isAlive ?? isPidAlive;
  return alive(state.pid) ? state : null;
}
