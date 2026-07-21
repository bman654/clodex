// tests/env.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  detectConflicts,
  buildChildEnv,
  buildHttpProxyChildEnv,
  classifyKeyringError,
  parseAuthRef,
  providerKeyringAccount,
  clodexKeyEnvVar,
  resolveProviderCredential,
} from '../src/env.js';
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
    process.env['ANTHROPIC_API_KEY'] = 'normal-api-key';
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'normal-auth-token';
    process.env['ANTHROPIC_MODEL'] = 'sonnet';
    process.env['ANTHROPIC_BASE_URL'] = 'https://old-gateway.example';
    process.env['CLAUDE_CODE_USE_VERTEX'] = '1';
    process.env['NO_PROXY'] = 'localhost,api.anthropic.com,.internal.example';
    try {
      const env = buildHttpProxyChildEnv(18181, '/tmp/relay-ca.pem');
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
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_AUTH_TOKEN'];
      delete process.env['ANTHROPIC_MODEL'];
      delete process.env['ANTHROPIC_BASE_URL'];
      delete process.env['CLAUDE_CODE_USE_VERTEX'];
      delete process.env['NO_PROXY'];
    }
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
