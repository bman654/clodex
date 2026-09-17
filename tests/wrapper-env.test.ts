import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeWrapperEnv,
  wrapperSpawnShell,
  LOCAL_GATEWAY_API_KEY,
  wrapperInvocationIsChat,
  wrapperRequiresServer,
  wrapperSubstitutionEligible,
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

describe('wrapperSubstitutionEligible', () => {
  const proxyState: ServerRuntimeState = {
    mode: 'proxy',
    port: 17645,
    pid: process.pid,
    caPath: '/tmp/clodex-ca.pem',
    startedAt: '2026-09-16T00:00:00.000Z',
  };
  const endpointState: ServerRuntimeState = {
    ...proxyState,
    mode: 'endpoint',
  };
  const topLevelEnv = { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' };
  // No platform column: the gate no longer knows the platform. Windows is eligible like every
  // other host; what Windows needs differently is the executable rule in wrapper-target.ts.
  const cases: Array<{
    label: string;
    env: NodeJS.ProcessEnv;
    state: ServerRuntimeState | null;
    expected: boolean;
  }> = [
    { label: 'top-level VS Code chat with a proxy server', env: topLevelEnv, state: proxyState, expected: true },
    { label: 'another entrypoint', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, state: proxyState, expected: false },
    { label: 'CLAUDECODE child', env: { ...topLevelEnv, CLAUDECODE: '1' }, state: proxyState, expected: false },
    { label: 'child session', env: { ...topLevelEnv, CLAUDE_CODE_CHILD_SESSION: '1' }, state: proxyState, expected: false },
    { label: 'endpoint server', env: topLevelEnv, state: endpointState, expected: false },
    { label: 'no server', env: topLevelEnv, state: null, expected: false },
  ];

  it.each(cases)('returns $expected for $label', ({ env, state, expected }) => {
    expect(wrapperSubstitutionEligible(env, state)).toBe(expected);
  });
});

describe('wrapperInvocationIsChat', () => {
  it.each([
    ['persistent stream-json chat', ['--output-format', 'stream-json', '--input-format', 'stream-json'], true],
    ['ordinary helper', ['auth', 'status', '--json'], false],
    ['nonpersistent suggestions query', ['--output-format', 'stream-json', '--no-session-persistence'], false],
  ] as const)('returns %s correctly', (_label, args, expected) => {
    expect(wrapperInvocationIsChat(args)).toBe(expected);
  });
});

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

describe('wrapperSpawnShell', () => {
  it.each([
    ['win32', 'C:\\nvm4w\\nodejs\\claude.cmd', true],
    ['win32', 'C:\\nvm4w\\nodejs\\CLAUDE.CMD', true],
    ['win32', 'C:\\tools\\claude.bat', true],
    ['win32', 'C:\\Users\\jane\\.vscode\\extensions\\anthropic.claude-code-2.1.267-win32-x64\\resources\\native-binary\\claude.exe', false],
    ['win32', 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', false],
    ['win32', 'C:\\nvm4w\\nodejs\\claude', false],
    ['win32', 'C:\\odd\\claude.cmd.exe', false],
    ['darwin', '/usr/local/bin/claude.cmd', false],
    ['linux', '/usr/local/bin/claude', false],
  ] as const)('%s %s -> shell=%s', (platform, target, expected) => {
    expect(wrapperSpawnShell(platform, target)).toBe(expected);
  });
});
