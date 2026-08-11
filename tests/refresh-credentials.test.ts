import { describe, it, expect } from 'vitest';
import {
  cachedModelCount,
  isLikelyPlaceholderKey,
  isPlaceholderProviderKey,
  resolveRefreshCredential,
  skipWithCachedModels,
} from '../src/registry/refresh-credentials.js';
import type { RegistryProvider } from '../src/registry/types.js';
import { OPENCODE_GO_COMPLETIONS_BASE_URL } from '../src/data/opencode-go-models.js';

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

describe('cached model status', () => {
  function openCodeGoProvider(modelIds: string[]): RegistryProvider {
    return makeProvider({
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
      modelsCache: {
        fetchedAt: '2026-08-08T00:00:00.000Z',
        models: modelIds.map(id => ({ id, name: id, upstreamModelId: id, modelFormat: 'openai' })),
      },
    });
  }

  it('counts only models exposed by the committed OpenCode Go allowlist', () => {
    const provider = openCodeGoProvider([
      'deepseek-v4-flash',
      'deepseek-v4-flash',
      'gpt-5.6-luna',
      'unknown-future-model',
    ]);

    expect(cachedModelCount(provider)).toBe(1);
    expect(skipWithCachedModels(provider, 'kept cache')).toMatchObject({
      ok: true,
      skipped: true,
      modelCount: 1,
    });
  });

  it('does not report a stale Responses-only cache as usable models', () => {
    const provider = openCodeGoProvider(['gpt-5.6-luna']);

    expect(cachedModelCount(provider)).toBe(0);
    expect(skipWithCachedModels(provider, 'kept cache').modelCount).toBeUndefined();
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
      let called = false;
      const key = await resolveRefreshCredential(
        makeProvider({ authRef: 'none:anonymous', authType: 'none' }),
        async () => {
          called = true;
          return 'stale-key';
        },
      );
      expect(key).toBeNull();
      expect(called).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previous;
    }
  });
});
