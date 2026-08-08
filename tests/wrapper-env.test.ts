import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeWrapperEnv,
  LOCAL_GATEWAY_API_KEY,
  wrapperRequiresServer,
} from '../src/wrapper-env.js';
import {
  readLiveServerRuntimeState,
  registerServerRuntimeState,
  type ServerRuntimeState,
} from '../src/server-runtime.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../src/network-env.js';

const baseEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  ANTHROPIC_BASE_URL: 'https://corp.example/anthropic',
  HTTPS_PROXY: 'http://corp-proxy:8080',
  https_proxy: 'http://corp-proxy:8080',
  HOME: '/Users/someone',
};

function networkContract(env: NodeJS.ProcessEnv): {
  version: number;
  original: Record<string, string | null>;
  injected: Record<string, string | null>;
} {
  return JSON.parse(env[NETWORK_ENV_CONTRACT_VAR]!);
}

describe('computeWrapperEnv', () => {
  it('proxy-mode server: injects proxy vars + CA and removes ANTHROPIC_BASE_URL', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv(baseEnv, state);

    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(env[name]).toBe('http://127.0.0.1:17645');
    }
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/home/u/.clodex/http-proxy/clodex-ca.pem');
    expect(env['PATH']).toBe('/usr/bin');
    expect(networkContract(env)).toEqual({
      version: 1,
      original: {
        HTTPS_PROXY: 'http://corp-proxy:8080',
        HTTP_PROXY: null,
        https_proxy: 'http://corp-proxy:8080',
        http_proxy: null,
        NODE_EXTRA_CA_CERTS: null,
      },
      injected: {
        HTTPS_PROXY: 'http://127.0.0.1:17645',
        HTTP_PROXY: 'http://127.0.0.1:17645',
        https_proxy: 'http://127.0.0.1:17645',
        http_proxy: 'http://127.0.0.1:17645',
        NODE_EXTRA_CA_CERTS: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      },
    });
  });

  it('proxy-mode server removes Anthropic bypasses while preserving unrelated hosts', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    const env = computeWrapperEnv({
      ...baseEnv,
      NO_PROXY: 'localhost,api.anthropic.com,.anthropic.com,.internal.example,*',
    }, state);

    expect(env['NO_PROXY']).toBe('localhost,.internal.example');
    expect(env['no_proxy']).toBe('localhost,.internal.example');
    expect(networkContract(env)).toMatchObject({
      original: {
        NO_PROXY: 'localhost,api.anthropic.com,.anthropic.com,.internal.example,*',
        no_proxy: null,
      },
      injected: {
        NO_PROXY: 'localhost,.internal.example',
        no_proxy: 'localhost,.internal.example',
      },
    });
  });

  it('merges uppercase and lowercase bypass lists before filtering', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    const env = computeWrapperEnv({
      ...baseEnv,
      NO_PROXY: 'localhost,api.anthropic.com',
      no_proxy: 'corp.internal,.anthropic.com',
    }, state);

    expect(env['NO_PROXY']).toBe('localhost,corp.internal');
    expect(env['no_proxy']).toBe('localhost,corp.internal');
  });

  it('endpoint-mode server: points ANTHROPIC_BASE_URL at the gateway and clears proxy vars', () => {
    const state: ServerRuntimeState = {
      mode: 'endpoint',
      port: 4242,
      pid: process.pid,
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv(baseEnv, state);

    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:4242/anthropic');
    expect(env['ANTHROPIC_API_KEY']).toBe(LOCAL_GATEWAY_API_KEY);
    expect(LOCAL_GATEWAY_API_KEY.length).toBeGreaterThan(0);
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(env[name]).toBeUndefined();
    }
    expect(networkContract(env)).toEqual({
      version: 1,
      original: {
        HTTPS_PROXY: 'http://corp-proxy:8080',
        https_proxy: 'http://corp-proxy:8080',
      },
      injected: {
        HTTPS_PROXY: null,
        https_proxy: null,
      },
    });
  });

  it('preserves the external baseline across nested wrapper launches', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    const inheritedContract = JSON.stringify({
      version: 1,
      original: {
        HTTPS_PROXY: 'http://corp-proxy.example:8080',
        https_proxy: 'http://corp-proxy.example:8080',
        NO_PROXY: '.internal.example',
      },
      injected: {
        HTTPS_PROXY: 'http://127.0.0.1:51234',
        https_proxy: 'http://127.0.0.1:51234',
        NO_PROXY: null,
      },
    });

    const env = computeWrapperEnv({
      ...baseEnv,
      HTTPS_PROXY: 'http://127.0.0.1:51234',
      https_proxy: 'http://127.0.0.1:51234',
      NO_PROXY: undefined,
      [NETWORK_ENV_CONTRACT_VAR]: inheritedContract,
    }, state);

    expect(env['NO_PROXY']).toBe('.internal.example');
    expect(networkContract(env)).toMatchObject({
      original: {
        HTTPS_PROXY: 'http://corp-proxy.example:8080',
        https_proxy: 'http://corp-proxy.example:8080',
      },
      injected: {
        HTTPS_PROXY: 'http://127.0.0.1:17645',
        https_proxy: 'http://127.0.0.1:17645',
      },
    });
  });

  it('uses a settings-level override as the new external baseline', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    const env = computeWrapperEnv({
      ...baseEnv,
      HTTPS_PROXY: 'http://settings-proxy.example:9000',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: { HTTPS_PROXY: 'http://corp-proxy.example:8080' },
        injected: { HTTPS_PROXY: 'http://127.0.0.1:51234' },
      }),
    }, state);

    expect(networkContract(env).original.HTTPS_PROXY)
      .toBe('http://settings-proxy.example:9000');
  });

  it('replaces malformed inherited metadata before applying bridge settings', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv({
      ...baseEnv,
      [NETWORK_ENV_CONTRACT_VAR]: 'not-json',
    }, state);

    expect(networkContract(env)).toMatchObject({
      original: {
        HTTPS_PROXY: 'http://corp-proxy:8080',
        https_proxy: 'http://corp-proxy:8080',
      },
    });
  });

  it('no live server: returns the env untouched without mutating the input', () => {
    const env = computeWrapperEnv(baseEnv, null);

    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);
  });

  it('stale-pid server state resolves to null and leaves the env untouched', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'clodex-wrapper-test-'));
    try {
      const homeEnv = { CLODEX_HOME: join(tempHome, 'app-home') };
      registerServerRuntimeState({
        mode: 'proxy',
        port: 17645,
        pid: 999999,
        caPath: '/tmp/ca.pem',
        startedAt: '2026-07-20T00:00:00.000Z',
      }, homeEnv, { isAlive: () => true });

      const state = readLiveServerRuntimeState(homeEnv, { isAlive: () => false });
      const env = computeWrapperEnv(baseEnv, state);

      expect(state).toBeNull();
      expect(env).toEqual(baseEnv);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('requires a live server only when explicitly enabled', () => {
    expect(wrapperRequiresServer({})).toBe(false);
    expect(wrapperRequiresServer({ CLODEX_REQUIRE_SERVER: '0' })).toBe(false);
    expect(wrapperRequiresServer({ CLODEX_REQUIRE_SERVER: '1' })).toBe(true);
  });
});
