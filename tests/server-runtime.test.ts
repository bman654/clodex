import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getServerRuntimePath,
  isPidAlive,
  parseServerRuntimeState,
  readLiveServerRuntimeState,
  removeServerRuntimeState,
  writeServerRuntimeState,
  type ServerRuntimeState,
} from '../src/server-runtime.js';

let tempHome: string;
let env: { CLODEX_HOME: string };

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-runtime-test-'));
  env = { CLODEX_HOME: join(tempHome, 'app-home') };
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

function proxyState(overrides: Partial<ServerRuntimeState> = {}): ServerRuntimeState {
  return {
    mode: 'proxy',
    port: 17645,
    pid: process.pid,
    caPath: '/tmp/clodex-ca.pem',
    startedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('server runtime state file', () => {
  it('lives at server-runtime.json inside the app home', () => {
    expect(getServerRuntimePath(env)).toBe(join(env.CLODEX_HOME, 'server-runtime.json'));
  });

  it('round-trips a proxy-mode state through write and read', () => {
    const state = proxyState();
    writeServerRuntimeState(state, env);

    expect(readLiveServerRuntimeState(env)).toEqual(state);
  });

  it('round-trips an endpoint-mode state without a caPath', () => {
    const state: ServerRuntimeState = {
      mode: 'endpoint',
      port: 4242,
      pid: process.pid,
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    writeServerRuntimeState(state, env);

    const read = readLiveServerRuntimeState(env);
    expect(read).toEqual(state);
    expect(read?.caPath).toBeUndefined();
  });

  it('remove deletes the file and is a no-op when it is already gone', () => {
    writeServerRuntimeState(proxyState(), env);
    removeServerRuntimeState(env);

    expect(existsSync(getServerRuntimePath(env))).toBe(false);
    expect(() => removeServerRuntimeState(env)).not.toThrow();
    expect(readLiveServerRuntimeState(env)).toBeNull();
  });
});

describe('parseServerRuntimeState', () => {
  it('rejects malformed payloads', () => {
    expect(parseServerRuntimeState('not json')).toBeNull();
    expect(parseServerRuntimeState('42')).toBeNull();
    expect(parseServerRuntimeState(JSON.stringify({ ...proxyState(), mode: 'tunnel' }))).toBeNull();
    expect(parseServerRuntimeState(JSON.stringify({ ...proxyState(), port: 0 }))).toBeNull();
    expect(parseServerRuntimeState(JSON.stringify({ ...proxyState(), port: 70000 }))).toBeNull();
    expect(parseServerRuntimeState(JSON.stringify({ ...proxyState(), pid: -1 }))).toBeNull();
  });

  it('rejects a proxy-mode state without a usable caPath', () => {
    expect(parseServerRuntimeState(JSON.stringify(proxyState({ caPath: undefined })))).toBeNull();
    expect(parseServerRuntimeState(JSON.stringify(proxyState({ caPath: '  ' })))).toBeNull();
  });
});

describe('stale detection', () => {
  it('readLiveServerRuntimeState returns null when the recorded pid is dead', () => {
    writeServerRuntimeState(proxyState(), env);

    expect(readLiveServerRuntimeState(env, { isAlive: () => false })).toBeNull();
  });

  it('readLiveServerRuntimeState returns null for a corrupt file', () => {
    writeServerRuntimeState(proxyState(), env);
    writeFileSync(getServerRuntimePath(env), '{ truncated', 'utf8');

    expect(readLiveServerRuntimeState(env)).toBeNull();
  });

  it('isPidAlive maps ESRCH to dead and EPERM to alive', () => {
    const errWith = (code: string) => {
      const err = new Error(code) as NodeJS.ErrnoException;
      err.code = code;
      return err;
    };
    expect(isPidAlive(1234, () => { throw errWith('ESRCH'); })).toBe(false);
    expect(isPidAlive(1234, () => { throw errWith('EPERM'); })).toBe(true);
    expect(isPidAlive(1234, () => undefined)).toBe(true);
  });

  it('isPidAlive reports the current process as alive via the real probe', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});
