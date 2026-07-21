import { describe, it, expect } from 'vitest';
import { isLikelyPlaceholderKey, isPlaceholderProviderKey, resolveRefreshCredential } from '../src/registry/refresh-credentials.js';
import type { RegistryProvider } from '../src/registry/types.js';

function makeProvider(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'openai',
    templateId: 'openai',
    name: 'OpenAI',
    enabled: true,
    authRef: 'keyring:global:openai-oauth',
    authType: 'oauth',
    api: {},
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isPlaceholderProviderKey', () => {
  it('detects OpenCode placeholder keys', () => {
    expect(isPlaceholderProviderKey('anything')).toBe(true);
    expect(isPlaceholderProviderKey('ollama')).toBe(true);
    expect(isPlaceholderProviderKey('local')).toBe(true);
  });

  it('accepts real-looking keys', () => {
    expect(isPlaceholderProviderKey('sk-ant-api03-abc123')).toBe(false);
    expect(isPlaceholderProviderKey('nvapi-abc123def456')).toBe(false);
  });

  it('treats empty as placeholder', () => {
    expect(isPlaceholderProviderKey('')).toBe(true);
    expect(isPlaceholderProviderKey(null)).toBe(true);
  });

  it('treats very short keys as likely placeholders', () => {
    expect(isLikelyPlaceholderKey('a')).toBe(true);
    expect(isLikelyPlaceholderKey('ok')).toBe(true);
  });
});

describe('resolveRefreshCredential', () => {
  it('returns the resolved key when it looks real', async () => {
    const key = await resolveRefreshCredential(makeProvider(), async () => 'sk-real-key-123456');
    expect(key).toBe('sk-real-key-123456');
  });

  it('swallows an exception from resolveKey (e.g. OAuth refresh 401) instead of throwing', async () => {
    const previous = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const key = await resolveRefreshCredential(makeProvider(), async () => {
        throw new Error('OpenAI token refresh failed (401)');
      });
      expect(key).toBeNull();
    } finally {
      if (previous === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previous;
    }
  });

  it('falls through to env fallback when resolveKey throws and an env var is set', async () => {
    const prev = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-from-env';
    try {
      const key = await resolveRefreshCredential(makeProvider(), async () => {
        throw new Error('OpenAI token refresh failed (401)');
      });
      expect(key).toBe('sk-from-env');
    } finally {
      if (prev === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prev;
    }
  });

  it('does not resolve credentials or environment fallbacks for anonymous access', async () => {
    const previous = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-from-env';
    try {
      for (const authRef of [
        'none:anonymous',
        'keyring:provider:openai',
      ]) {
        let called = false;
        const key = await resolveRefreshCredential(
          makeProvider({ authRef, authType: 'none' }),
          async () => {
            called = true;
            return 'stale-key';
          },
        );
        expect(key).toBeNull();
        expect(called).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previous;
    }
  });
});
