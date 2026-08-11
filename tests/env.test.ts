// tests/env.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  detectConflicts,
  addGatewayNoProxyBypass,
  buildChildEnv,
  buildHttpProxyChildEnv,
  classifyKeyringError,
  parseAuthRef,
  providerKeyringAccount,
  clodexKeyEnvVar,
  resolveProviderCredential,
  resolveProviderCredentialOverrideState,
} from '../src/env.js';
import { createHash } from 'node:crypto';

const TEST_HELPER_ID = 'a'.repeat(64);
import { CONFLICTING_ENV_VARS } from '../src/constants.js';

const UPSTREAM_URL = 'https://api.example.com';

// Snapshot of all conflicting vars before any test so we can restore them
const originalConflictingValues: Record<string, string | undefined> = {};

describe('classifyKeyringError', () => {
  it('identifies missing native module', () => {
    expect(classifyKeyringError(new Error("Cannot find module '@napi-rs/keyring'"))).toContain('native keyring module');
    expect(classifyKeyringError(new Error('Module not found: keyring.node'))).toContain('native keyring module');
    expect(classifyKeyringError(new Error('failed to load native binding'))).toContain('native keyring module');
  });

  it('identifies Secret Service / D-Bus daemon not running', () => {
    expect(classifyKeyringError(new Error('Secret Service error: no daemon running'))).toContain('Secret Service daemon');
    expect(classifyKeyringError(new Error('DBus error: connection refused'))).toContain('Secret Service daemon');
    expect(classifyKeyringError(new Error('daemon not available'))).toContain('Secret Service daemon');
  });

  it('identifies permission denied / locked keychain', () => {
    expect(classifyKeyringError(new Error('access denied by user'))).toContain('denied');
    expect(classifyKeyringError(new Error('keychain is locked'))).toContain('denied');
    expect(classifyKeyringError(new Error('user cancelled the operation'))).toContain('denied');
    expect(classifyKeyringError(new Error('user refused to grant access'))).toContain('denied');
  });

  it('falls back to generic message for unknown errors', () => {
    const result = classifyKeyringError(new Error('something totally unexpected'));
    expect(result).toContain('keyring error:');
    expect(result).toContain('something totally unexpected');
  });

  it('handles non-Error values gracefully', () => {
    expect(() => classifyKeyringError('string error')).not.toThrow();
    expect(() => classifyKeyringError(42)).not.toThrow();
    expect(() => classifyKeyringError(null)).not.toThrow();
  });
});

describe('detectConflicts', () => {
  beforeEach(() => {
    // Save and unset ALL conflicting vars so the empty-array test is reliable
    // even when the shell has ANTHROPIC_API_KEY, CLAUDE_CODE_USE_VERTEX, etc. set.
    for (const name of CONFLICTING_ENV_VARS) {
      originalConflictingValues[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    // Restore everything we cleared in beforeEach
    for (const name of CONFLICTING_ENV_VARS) {
      if (originalConflictingValues[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalConflictingValues[name];
      }
    }
  });

  it('returns empty array when no conflicting vars are set', () => {
    expect(detectConflicts()).toEqual([]);
  });

  it('returns conflict entries for each set variable', () => {
    process.env['CLAUDE_CODE_USE_VERTEX'] = '1';
    process.env['ANTHROPIC_API_KEY'] = 'old-key';
    const conflicts = detectConflicts();
    expect(conflicts.some(c => c.name === 'CLAUDE_CODE_USE_VERTEX' && c.value === '1')).toBe(true);
    expect(conflicts.some(c => c.name === 'ANTHROPIC_API_KEY' && c.value === 'old-key')).toBe(true);
  });
});

describe('provider credentials', () => {
  it('parses authRef strings', () => {
    expect(parseAuthRef('keyring:provider:openai')).toEqual({ kind: 'keyring', account: 'provider:openai' });
    expect(parseAuthRef('keyring:oauth:provider:openai-oauth')).toEqual({ kind: 'keyring', account: 'oauth:provider:openai-oauth' });
    expect(parseAuthRef(`helper:v1:${TEST_HELPER_ID}:oauth:provider:openai-oauth`)).toEqual({
      kind: 'helper',
      helperId: TEST_HELPER_ID,
      account: 'oauth:provider:openai-oauth',
    });
    expect(parseAuthRef('helper:oauth:provider:openai-oauth')).toBeNull();
    expect(parseAuthRef('env:OPENAI_API_KEY')).toEqual({ kind: 'env', varName: 'OPENAI_API_KEY' });
    expect(parseAuthRef('none:anonymous')).toEqual({ kind: 'none' });
    expect(parseAuthRef('bad')).toBeNull();
  });

  it('builds provider keyring account names', () => {
    expect(providerKeyringAccount('openai')).toBe('provider:openai');
    expect(providerKeyringAccount('custom-together')).toBe('provider:custom-together');
  });

  it('resolves CLODEX_KEY_* env before authRef', async () => {
    process.env[clodexKeyEnvVar('openai')] = 'env-openai-key';
    const key = await resolveProviderCredential('openai', 'keyring:provider:openai');
    expect(key).toBe('env-openai-key');
    delete process.env[clodexKeyEnvVar('openai')];
  });

  it('can resolve the configured credential while bypassing CLODEX_KEY_*', async () => {
    const variable = clodexKeyEnvVar('openai');
    const previousOverride = process.env[variable];
    const previousStored = process.env.CLODEX_STORED_OPENAI_KEY;
    process.env[variable] = 'temporary-provider-key';
    process.env.CLODEX_STORED_OPENAI_KEY = 'stored-openai-key';
    try {
      await expect(resolveProviderCredential(
        'openai',
        'env:CLODEX_STORED_OPENAI_KEY',
        undefined,
        { ignoreProviderOverride: true },
      )).resolves.toBe('stored-openai-key');
      expect(resolveProviderCredentialOverrideState(
        'openai',
        process.env,
        { ignoreProviderOverride: true },
      )).toBeNull();
    } finally {
      if (previousOverride === undefined) delete process.env[variable];
      else process.env[variable] = previousOverride;
      if (previousStored === undefined) delete process.env.CLODEX_STORED_OPENAI_KEY;
      else process.env.CLODEX_STORED_OPENAI_KEY = previousStored;
    }
  });

  it('exposes only redaction-safe state for the usable provider override', async () => {
    const providerId = 'source-state-test';
    const variable = clodexKeyEnvVar(providerId);
    const credential = 'super-secret-provider-override';
    process.env[variable] = credential;
    process.env.CLODEX_SOURCE_STATE_FALLBACK = 'stored-fallback';
    try {
      const state = resolveProviderCredentialOverrideState(providerId);
      expect(state).toEqual({
        variable,
        fingerprint: createHash('sha256').update(credential).digest('hex'),
      });
      expect(JSON.stringify(state)).not.toContain(credential);

      // The state inspector and credential resolver share the exact remembered
      // rejection semantics: the same value remains unusable until it changes.
      await expect(resolveProviderCredential(
        providerId,
        'env:CLODEX_SOURCE_STATE_FALLBACK',
        undefined,
        { rejectedAccessToken: credential },
      )).resolves.toBe('stored-fallback');
      expect(resolveProviderCredentialOverrideState(providerId)).toBeNull();

      process.env[variable] = 'rotated-provider-override';
      expect(resolveProviderCredentialOverrideState(providerId)).toMatchObject({ variable });
    } finally {
      delete process.env[variable];
      delete process.env.CLODEX_SOURCE_STATE_FALLBACK;
      // An absent value clears any remembered rejection for this test-only id.
      resolveProviderCredentialOverrideState(providerId);
    }
  });

  it('keeps explicit anonymous access authoritative over provider environment keys', async () => {
    process.env[clodexKeyEnvVar('openai')] = 'stale-provider-key';
    await expect(resolveProviderCredential('openai', 'none:anonymous')).resolves.toBeNull();
    delete process.env[clodexKeyEnvVar('openai')];
  });

  it('resolves env authRef', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai';
    const key = await resolveProviderCredential('openai', 'env:OPENAI_API_KEY');
    expect(key).toBe('sk-openai');
    delete process.env['OPENAI_API_KEY'];
  });

  it('scopes rejected shared env credentials to the provider that rejected them', async () => {
    process.env['CLODEX_TEST_SHARED_KEY'] = 'shared-access';
    try {
      await expect(resolveProviderCredential(
        'first-provider',
        'env:CLODEX_TEST_SHARED_KEY',
        undefined,
        { rejectedAccessToken: 'shared-access' },
      )).resolves.toBeNull();
      await expect(resolveProviderCredential(
        'second-provider',
        'env:CLODEX_TEST_SHARED_KEY',
      )).resolves.toBe('shared-access');
      await expect(resolveProviderCredential(
        'first-provider',
        'env:CLODEX_TEST_SHARED_KEY',
      )).resolves.toBeNull();
    } finally {
      delete process.env['CLODEX_TEST_SHARED_KEY'];
    }
  });
});

describe('buildChildEnv', () => {
  beforeEach(() => {
    process.env['CLAUDE_CODE_USE_VERTEX'] = '1';
    process.env['ANTHROPIC_VERTEX_PROJECT_ID'] = 'my-project';
    process.env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = 'claude-opus-4-6[1m]';
  });

  afterEach(() => {
    delete process.env['CLAUDE_CODE_USE_VERTEX'];
    delete process.env['ANTHROPIC_VERTEX_PROJECT_ID'];
    delete process.env['ANTHROPIC_DEFAULT_OPUS_MODEL'];
  });

  it('removes all conflicting vars from child env', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key');
    expect(env['CLAUDE_CODE_USE_VERTEX']).toBeUndefined();
    expect(env['ANTHROPIC_VERTEX_PROJECT_ID']).toBeUndefined();
    expect(env['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBeUndefined();
  });

  it('sets ANTHROPIC_BASE_URL to backend URL', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key');
    expect(env['ANTHROPIC_BASE_URL']).toBe(UPSTREAM_URL);
  });

  it('sets ANTHROPIC_API_KEY to the provided key', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key');
    expect(env['ANTHROPIC_API_KEY']).toBe('my-key');
  });

  it('sets ANTHROPIC_MODEL to the selected model', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key');
    expect(env['ANTHROPIC_MODEL']).toBe('claude-sonnet-4-6[1m]');
  });

  it('appends [1m] for third-party models with a 1M context', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'gemini-3.5-flash', 'my-key', 12345, 1_000_000);
    expect(env['ANTHROPIC_MODEL']).toBe('gemini-3.5-flash[1m]');
    expect(env['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBe('1000000');
  });

  it('sets CLAUDE_CODE_MAX_CONTEXT_TOKENS from model id for proxy sessions', () => {
    expect(buildChildEnv(UPSTREAM_URL, 'zzzz-unknown-model', 'k')['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBe('200000');
  });

  it('uses explicit contextWindow override when provided', () => {
    expect(buildChildEnv(UPSTREAM_URL, 'custom-model', 'k', undefined, 512_000)['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBe('512000');
    expect(buildChildEnv(UPSTREAM_URL, 'custom-model', 'k', undefined, 1_048_576)['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBe('1048576');
  });

  it('sets the launch model window AND gateway discovery in switch-menu mode', () => {
    // Claude Code's gateway model discovery only carries id + display_name (no
    // context_window), so this env var is the only context-window lever and it
    // reflects the launch model. It cannot update on live /model switch.
    const env = buildChildEnv(UPSTREAM_URL, 'big-pickle', 'k', 1234, 200_000, true);
    expect(env['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBe('200000');
    expect(env['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY']).toBe('1');
  });

  it('does NOT mutate process.env', () => {
    buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key');
    expect(process.env['CLAUDE_CODE_USE_VERTEX']).toBe('1');
    expect(process.env['ANTHROPIC_VERTEX_PROJECT_ID']).toBe('my-project');
  });

  it('preserves non-conflicting env vars like PATH and HOME', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key');
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env['HOME']).toBe(process.env['HOME']);
  });

  it('uses proxy URL when proxyPort is provided', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'deepseek-v4-flash', 'my-key', 12345);
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:12345');
  });

  it('restores first-party-like Claude Code behavior for proxy/gateway routes', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'gemini-3.5-flash', 'my-key', 12345);
    expect(env['ENABLE_TOOL_SEARCH']).toBe('true');
    expect(env['CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT']).toBe('0');
  });

  it('uses upstream URL when proxyPort is not provided', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'minimax-m3', 'my-key');
    expect(env['ANTHROPIC_BASE_URL']).toBe(UPSTREAM_URL);
  });
});

describe('buildHttpProxyChildEnv', () => {
  it('sets proxy trust without replacing normal Anthropic credentials or model', () => {
    const env = buildHttpProxyChildEnv(18181, '/tmp/relay-ca.pem', {
      ANTHROPIC_API_KEY: 'normal-api-key',
      ANTHROPIC_AUTH_TOKEN: 'normal-auth-token',
      ANTHROPIC_MODEL: 'sonnet',
      ANTHROPIC_BASE_URL: 'https://old-gateway.example',
      CLAUDE_CODE_USE_VERTEX: '1',
      NO_PROXY: 'localhost,api.anthropic.com,.internal.example',
    });

    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:18181');
    expect(env['HTTP_PROXY']).toBe('http://127.0.0.1:18181');
    expect(env['https_proxy']).toBe('http://127.0.0.1:18181');
    expect(env['http_proxy']).toBe('http://127.0.0.1:18181');
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/tmp/relay-ca.pem');
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(env['CLAUDE_CODE_USE_VERTEX']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBe('normal-api-key');
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('normal-auth-token');
    expect(env['ANTHROPIC_MODEL']).toBe('sonnet');
    expect(env['NO_PROXY']).toBe('localhost,.internal.example');
    expect(env['no_proxy']).toBe('localhost,.internal.example');
    expect(JSON.parse(env['CLAUDE_CODE_CLODEX_NETWORK_ENV']!)).toMatchObject({
      version: 1,
      original: {
        HTTPS_PROXY: null,
        NO_PROXY: 'localhost,api.anthropic.com,.internal.example',
      },
      injected: {
        HTTPS_PROXY: 'http://127.0.0.1:18181',
        NO_PROXY: 'localhost,.internal.example',
      },
    });
  });
});

describe('child-env builders never mutate clodex process.env', () => {
  // Guard for the outbound-proxy dispatcher: proxy bridge mode points the CHILD
  // at clodex's MITM listener via env copies only. If these builders leaked
  // HTTPS_PROXY into process.env, the global EnvHttpProxyAgent could route
  // clodex's own upstream calls back through its own listener (self-loop).
  it('buildChildEnv and buildHttpProxyChildEnv work on copies of process.env', () => {
    const before = { ...process.env };

    buildChildEnv(UPSTREAM_URL, 'gpt-5.5', 'key', 12345, 200000, true);
    buildHttpProxyChildEnv(54321, '/tmp/ca.pem');

    expect({ ...process.env }).toEqual(before);
    expect(process.env['HTTPS_PROXY']).toBe(before['HTTPS_PROXY']);
    expect(process.env['HTTP_PROXY']).toBe(before['HTTP_PROXY']);
    expect(process.env['ANTHROPIC_BASE_URL']).toBe(before['ANTHROPIC_BASE_URL']);
  });
});

// Issue #95: endpoint mode leaves the user's HTTP(S)_PROXY in the child env while
// pointing ANTHROPIC_BASE_URL at a loopback gateway. Claude Code honours NO_PROXY
// but has no implicit loopback bypass, so the child asked the corporate proxy to
// fetch 127.0.0.1 and a refusing proxy answered with a bodyless 503.
describe('addGatewayNoProxyBypass', () => {
  const GATEWAY = 'http://127.0.0.1:17645';

  it('does nothing when no proxy is configured', () => {
    const env: NodeJS.ProcessEnv = {};
    addGatewayNoProxyBypass(env, GATEWAY);
    expect(env['NO_PROXY']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
  });

  it('bypasses every loopback spelling when a proxy is configured', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, GATEWAY);
    const entries = env['NO_PROXY']!.split(',');
    expect(entries).toContain('localhost');
    expect(entries).toContain('127.0.0.1');
    expect(entries).toContain('::1');
  });

  it('sets both casings, because Claude Code reads no_proxy first', () => {
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, GATEWAY);
    expect(env['no_proxy']).toBe(env['NO_PROXY']);
    expect(env['no_proxy']).toBeTruthy();
  });

  it('is triggered by any of the four proxy spellings', () => {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      const env: NodeJS.ProcessEnv = { [name]: 'http://corp:3128' };
      addGatewayNoProxyBypass(env, GATEWAY);
      expect(env['NO_PROXY'], `expected ${name} to trigger the bypass`).toContain('127.0.0.1');
    }
  });

  it('preserves the user existing NO_PROXY entries', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128', NO_PROXY: 'internal.corp,.example.com' };
    addGatewayNoProxyBypass(env, GATEWAY);
    const entries = env['NO_PROXY']!.split(',');
    expect(entries).toContain('internal.corp');
    expect(entries).toContain('.example.com');
    expect(entries).toContain('127.0.0.1');
  });

  it('does not duplicate an entry the user already had, case-insensitively', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128', NO_PROXY: 'LocalHost,127.0.0.1' };
    addGatewayNoProxyBypass(env, GATEWAY);
    const entries = env['NO_PROXY']!.split(',');
    expect(entries.filter(e => e.toLowerCase() === 'localhost')).toHaveLength(1);
    expect(entries.filter(e => e === '127.0.0.1')).toHaveLength(1);
  });

  it('leaves a wildcard NO_PROXY untouched rather than narrowing it', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128', NO_PROXY: '*' };
    addGatewayNoProxyBypass(env, GATEWAY);
    expect(env['NO_PROXY']).toBe('*');
  });

  // Claude Code's matcher tests `value === "*"` BEFORE splitting, so a `*` that is
  // merely one entry in a list bypasses nothing. Treating it as bypass-everything
  // would make this a silent no-op and reproduce #95 for that user.
  it('still bypasses when * is only one entry in a list', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128', NO_PROXY: 'internal.corp,*' };
    addGatewayNoProxyBypass(env, GATEWAY);
    const entries = env['NO_PROXY']!.split(',');
    expect(entries).toContain('127.0.0.1');
    expect(entries).toContain('internal.corp');
  });

  // Claude Code reads `no_proxy || NO_PROXY`: a non-empty lowercase value wins
  // outright, so the uppercase one must not be merged back in.
  it('follows lowercase precedence instead of unioning divergent casings', () => {
    const env: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://corp:3128',
      no_proxy: 'lower.internal',
      NO_PROXY: 'upper.internal',
    };
    addGatewayNoProxyBypass(env, GATEWAY);
    const entries = env['no_proxy']!.split(',');
    expect(entries).toContain('lower.internal');
    expect(entries).not.toContain('upper.internal');
    expect(env['NO_PROXY']).toBe(env['no_proxy']);
  });

  it('falls through to NO_PROXY when no_proxy is set but empty', () => {
    const env: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://corp:3128',
      no_proxy: '',
      NO_PROXY: 'upper.internal',
    };
    addGatewayNoProxyBypass(env, GATEWAY);
    expect(env['NO_PROXY']!.split(',')).toContain('upper.internal');
  });

  // The dangerous direction: buildChildEnv is ALSO called with a remote
  // Anthropic-passthrough baseUrl. Bypassing the proxy for a remote host could
  // point the child at a host the proxy is the only route to.
  it('does NOT touch NO_PROXY for a remote gateway', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, 'https://api.anthropic.com');
    expect(env['NO_PROXY']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
  });

  it('does NOT bypass a non-loopback LAN gateway', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, 'http://gateway.lan:17645');
    expect(env['NO_PROXY']).toBeUndefined();
  });

  // NO_PROXY matches host-by-host, so classifying an address as loopback is
  // worthless unless that exact address lands in the list.
  it('emits the gateway address itself across the whole 127.0.0.0/8 range', () => {
    for (const host of ['127.0.0.1', '127.0.0.53', '127.1.2.3']) {
      const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
      addGatewayNoProxyBypass(env, `http://${host}:17645`);
      expect(env['NO_PROXY']!.split(','), `expected ${host} to be bypassed`).toContain(host);
    }
  });

  it('does not repeat the gateway address when it is already a canonical entry', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, 'http://127.0.0.1:17645');
    const entries = env['NO_PROXY']!.split(',');
    expect(entries.filter(e => e === '127.0.0.1')).toHaveLength(1);
  });

  // Regression guard: reading only the uppercase variable silently discards a
  // user who set just `no_proxy`, sending their internal hosts to the proxy.
  it('preserves entries the user set in lowercase no_proxy only', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128', no_proxy: 'git.internal' };
    addGatewayNoProxyBypass(env, GATEWAY);
    expect(env['NO_PROXY']!.split(',')).toContain('git.internal');
    expect(env['no_proxy']!.split(',')).toContain('git.internal');
  });

  it('honours a wildcard set only in lowercase no_proxy', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128', no_proxy: '*' };
    addGatewayNoProxyBypass(env, GATEWAY);
    expect(env['no_proxy']).toBe('*');
    expect(env['NO_PROXY']).toBeUndefined();
  });

  it('treats RFC 6761 .localhost names as loopback', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, 'http://gateway.localhost:17645');
    expect(env['NO_PROXY']!.split(',')).toContain('gateway.localhost');
  });

  it('recognises a bracketed IPv6 loopback gateway', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, 'http://[::1]:17645');
    const entries = env['NO_PROXY']!.split(',');
    expect(entries).toContain('::1');
    expect(entries.some(e => e.includes('['))).toBe(false);
  });

  it('does NOT bypass a non-loopback IPv6 gateway', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, 'http://[fd00::1]:17645');
    expect(env['NO_PROXY']).toBeUndefined();
  });

  it('does nothing when the gateway URL is malformed', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://corp:3128' };
    addGatewayNoProxyBypass(env, 'not a url');
    expect(env['NO_PROXY']).toBeUndefined();
  });
});

describe('buildChildEnv proxy bypass (issue #95)', () => {
  const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of PROXY_NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of PROXY_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('bypasses the loopback gateway the child was pointed at', () => {
    process.env['HTTP_PROXY'] = 'http://corp:3128';
    const env = buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key', 17645);
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:17645');
    expect(env['NO_PROXY']!.split(',')).toContain('127.0.0.1');
    expect(env['no_proxy']).toBe(env['NO_PROXY']);
  });

  it('keeps the proxy itself in the child env — the child still needs it', () => {
    process.env['HTTP_PROXY'] = 'http://corp:3128';
    const env = buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key', 17645);
    expect(env['HTTP_PROXY']).toBe('http://corp:3128');
  });

  it('adds nothing when the user has no proxy configured', () => {
    const env = buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key', 17645);
    expect(env['NO_PROXY']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
  });

  it('never mutates the parent process env', () => {
    process.env['HTTP_PROXY'] = 'http://corp:3128';
    const before = { ...process.env };
    buildChildEnv(UPSTREAM_URL, 'claude-sonnet-4-6', 'my-key', 17645);
    expect({ ...process.env }).toEqual(before);
    expect(process.env['NO_PROXY']).toBeUndefined();
  });
});

describe('buildChildEnv remote passthrough keeps the proxy (issue #95 regression guard)', () => {
  const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of PROXY_NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of PROXY_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  // An Anthropic-format passthrough model launches with a REMOTE baseUrl and no
  // local proxy port. That host must keep going through the user's proxy.
  it('leaves NO_PROXY alone when the child points at a remote baseUrl', () => {
    process.env['HTTPS_PROXY'] = 'http://corp:3128';
    const env = buildChildEnv('https://api.example.com', 'claude-sonnet-4-6', 'my-key');
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://api.example.com');
    expect(env['NO_PROXY']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
    expect(env['HTTPS_PROXY']).toBe('http://corp:3128');
  });
});
