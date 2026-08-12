import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  refreshAllProviderModels,
  refreshProviderModels,
  refreshProviderModelsWithCredential,
} from '../src/registry/refresh-models.js';
import { refreshCredentialSnapshot } from '../src/registry/refresh-credentials.js';
import type { ProviderRegistry } from '../src/registry/types.js';

const providerMutationState = vi.hoisted(() => ({ active: false }));

vi.mock('../src/registry/fetch-template-models.js', () => ({
  fetchTemplateModels: vi.fn(),
}));
vi.mock('../src/registry/custom-endpoint.js', () => ({
  fetchAnthropicModels: vi.fn(),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistryStrict: vi.fn(() => ({ schemaVersion: 1, providers: [] })),
  saveRegistry: vi.fn(),
}));
vi.mock('../src/registry/lock.js', () => ({
  withCredentialMutationLock: vi.fn(async (_authRef: string, operation: () => unknown) => operation()),
  withProviderMutationLock: vi.fn(async (_providerId: string, operation: () => unknown) => {
    providerMutationState.active = true;
    try {
      return await operation();
    } finally {
      providerMutationState.active = false;
    }
  }),
  withRegistryWriteLock: vi.fn(async (operation: () => unknown) => operation()),
}));

import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { fetchAnthropicModels } from '../src/registry/custom-endpoint.js';
import { loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import {
  OPENCODE_GO_ANTHROPIC_BASE_URL,
  OPENCODE_GO_COMPLETIONS_BASE_URL,
} from '../src/data/opencode-go-models.js';

describe('refreshProviderModels', () => {
  beforeEach(() => {
    providerMutationState.active = false;
    vi.mocked(fetchTemplateModels).mockReset();
    vi.mocked(fetchAnthropicModels).mockReset();
    vi.mocked(loadRegistryStrict).mockReset();
    vi.mocked(saveRegistry).mockClear();
  });

  it('reloads persisted state before saving discovery results', async () => {
    const initialRegistry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        enabled: true,
        authRef: 'keyring:provider:groq',
        authType: 'api',
        api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    const persistedRegistry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        ...initialRegistry.providers[0]!,
        name: 'Renamed while discovery was running',
      }],
    };
    vi.mocked(loadRegistryStrict).mockReturnValue(persistedRegistry);
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [{
        id: 'live-a',
        name: 'Live A',
        upstreamModelId: 'live-a',
        modelFormat: 'openai',
      }],
    });

    const result = await refreshProviderModels('groq', 'test-key', initialRegistry);

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(loadRegistryStrict).toHaveBeenCalledOnce();
    expect(saveRegistry).toHaveBeenCalledWith(persistedRegistry);
    expect(persistedRegistry.providers[0]?.name).toBe('Renamed while discovery was running');
    expect(persistedRegistry.providers[0]?.modelsCache?.models[0]?.id).toBe('live-a');
  });

  it('does not treat a cached manual-only OAuth provider as usable without its credential', async () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'vertex',
        templateId: 'vertex',
        name: 'Vertex',
        enabled: true,
        authRef: 'keyring:provider:vertex',
        authType: 'oauth',
        api: { npm: '@ai-sdk/google-vertex', url: 'https://vertex.example/v1' },
        modelsCache: {
          fetchedAt: '2026-08-09T00:00:00.000Z',
          models: [{
            id: 'cached-model',
            name: 'Cached model',
            upstreamModelId: 'cached-model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };

    const result = await refreshProviderModels('vertex', null, registry);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('OAuth token not available'),
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('retains imported models but rejects a placeholder API credential', async () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        enabled: true,
        authRef: 'keyring:provider:groq',
        authType: 'api',
        api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
        modelsCache: {
          fetchedAt: '2026-08-09T00:00:00.000Z',
          models: [{
            id: 'imported-model',
            name: 'Imported model',
            upstreamModelId: 'imported-model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };

    const result = await refreshProviderModels('groq', 'placeholder', registry);

    expect(result).toMatchObject({
      ok: false,
      modelCount: 1,
      reason: expect.stringContaining('placeholder API key'),
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('preserves the legacy local credential as anonymous for cached custom endpoints', async () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'legacy-local',
        templateId: 'custom-openai',
        name: 'Legacy local',
        enabled: true,
        authRef: 'keyring:provider:legacy-local',
        api: { npm: '@ai-sdk/openai-compatible', url: 'http://127.0.0.1:11434/v1' },
        modelsCache: {
          fetchedAt: '2026-08-09T00:00:00.000Z',
          models: [{
            id: 'local-model',
            name: 'Local model',
            upstreamModelId: 'local-model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };

    const result = await refreshProviderModels('legacy-local', 'local', registry);

    expect(result).toMatchObject({ ok: true, skipped: true, modelCount: 1 });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('does not apply discovery results after credentials change', async () => {
    const initialRegistry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        enabled: true,
        authRef: 'keyring:provider:groq',
        authType: 'api',
        api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    vi.mocked(loadRegistryStrict).mockReturnValue({
      schemaVersion: 1,
      providers: [{
        ...initialRegistry.providers[0]!,
        authRef: 'keyring:provider:groq-replacement',
      }],
    });
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [{
        id: 'live-a',
        name: 'Live A',
        upstreamModelId: 'live-a',
        modelFormat: 'openai',
      }],
    });

    const result = await refreshProviderModels('groq', 'test-key', initialRegistry);

    expect(result).toMatchObject({
      ok: false,
      reason: 'Provider credentials changed while models were refreshing.',
    });
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('does not apply discovery results after endpoint configuration changes', async () => {
    const initialRegistry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        enabled: true,
        authRef: 'keyring:provider:groq',
        authType: 'api',
        api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    vi.mocked(loadRegistryStrict).mockReturnValue({
      schemaVersion: 1,
      providers: [{
        ...initialRegistry.providers[0]!,
        api: { npm: '@ai-sdk/groq', url: 'https://replacement.example/v1' },
      }],
    });
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [{
        id: 'live-a',
        name: 'Live A',
        upstreamModelId: 'live-a',
        modelFormat: 'openai',
      }],
    });

    const result = await refreshProviderModels('groq', 'test-key', initialRegistry);

    expect(result).toMatchObject({
      ok: false,
      reason: 'Provider configuration changed while models were refreshing.',
    });
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('does not send a resolved credential after the provider route is replaced', async () => {
    const startedProvider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:groq',
      authType: 'api' as const,
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(loadRegistryStrict).mockReturnValue({
      schemaVersion: 1,
      providers: [{
        ...startedProvider,
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://replacement.example/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    });

    const result = await refreshProviderModels(
      'groq',
      'credential-resolved-for-old-route',
      undefined,
      refreshCredentialSnapshot(startedProvider, null),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'Provider configuration changed while credentials were resolving.',
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('does not send after the namespaced provider override changes post-resolution', async () => {
    const provider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:groq',
      authType: 'api' as const,
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    const registry: ProviderRegistry = { schemaVersion: 1, providers: [provider] };
    const previous = process.env.CLODEX_KEY_GROQ;
    process.env.CLODEX_KEY_GROQ = 'override-generation-one';
    try {
      const snapshot = refreshCredentialSnapshot(provider, null);
      process.env.CLODEX_KEY_GROQ = 'override-generation-two';

      const result = await refreshProviderModels(
        'groq',
        'override-generation-one',
        registry,
        snapshot,
      );

      expect(result).toMatchObject({
        ok: false,
        reason: 'Provider credential override changed while models were refreshing.',
      });
      expect(fetchTemplateModels).not.toHaveBeenCalled();
      expect(saveRegistry).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CLODEX_KEY_GROQ;
      else process.env.CLODEX_KEY_GROQ = previous;
    }
  });

  it('does not begin discovery or commit while a provider override owns the credential', async () => {
    const provider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:groq',
      authType: 'api' as const,
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    const registry: ProviderRegistry = { schemaVersion: 1, providers: [provider] };
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);
    const previous = process.env.CLODEX_KEY_GROQ;
    process.env.CLODEX_KEY_GROQ = 'override-generation-one';
    try {
      const snapshot = refreshCredentialSnapshot(provider, null);
      const result = await refreshProviderModels(
        'groq',
        'override-generation-one',
        registry,
        snapshot,
      );

      expect(result).toMatchObject({
        ok: true,
        skipped: true,
        reason: expect.stringContaining('process-scoped provider credential override'),
      });
      expect(fetchTemplateModels).not.toHaveBeenCalled();
      expect(saveRegistry).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CLODEX_KEY_GROQ;
      else process.env.CLODEX_KEY_GROQ = previous;
    }
  });

  it('does not send or commit with a reauthenticated named slot that kept its authRef', async () => {
    const startedProvider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:work',
      defaultAuthRef: 'keyring:provider:default',
      authType: 'oauth' as const,
      activeAuthAccount: 'work',
      authAccounts: {
        work: {
          authRef: 'keyring:provider:work',
          addedAt: '2026-08-09T00:00:00.000Z',
        },
      },
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(loadRegistryStrict).mockReturnValue({
      schemaVersion: 5,
      providers: [{
        ...startedProvider,
        authAccounts: {
          work: {
            authRef: 'keyring:provider:work',
            addedAt: '2026-08-09T01:00:00.000Z',
          },
        },
      }],
    });

    const result = await refreshProviderModels(
      'groq',
      'credential-resolved-before-reauth',
      undefined,
      refreshCredentialSnapshot(startedProvider, null),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'Provider account credentials changed while models were refreshing.',
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('does not commit account-specific discovery after the active account changes', async () => {
    const startedProvider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:work',
      defaultAuthRef: 'keyring:provider:default',
      authType: 'oauth' as const,
      activeAuthAccount: 'work',
      authAccounts: {
        work: { authRef: 'keyring:provider:work', addedAt: '2026-08-09T00:00:00.000Z' },
        alt: { authRef: 'keyring:provider:alt', addedAt: '2026-08-09T00:00:00.000Z' },
      },
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    const initialRegistry: ProviderRegistry = { schemaVersion: 5, providers: [startedProvider] };
    const switchedRegistry: ProviderRegistry = {
      schemaVersion: 5,
      providers: [{ ...startedProvider, authRef: 'keyring:provider:alt', activeAuthAccount: 'alt' }],
    };
    vi.mocked(loadRegistryStrict).mockReturnValue(switchedRegistry);
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [{ id: 'live-a', name: 'Live A', upstreamModelId: 'live-a', modelFormat: 'openai' }],
    });

    const result = await refreshProviderModels(
      'groq',
      'work-token',
      initialRegistry,
      refreshCredentialSnapshot(startedProvider, undefined),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'Provider account selection changed while models were refreshing.',
    });
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('refresh-all resolves each provider through its selected OAuth account', async () => {
    const provider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:work',
      defaultAuthRef: 'keyring:provider:default',
      authType: 'oauth' as const,
      activeAuthAccount: 'work',
      authAccounts: {
        work: { authRef: 'keyring:provider:work', addedAt: '2026-08-09T00:00:00.000Z' },
      },
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    const registry: ProviderRegistry = { schemaVersion: 5, providers: [provider] };
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [{ id: 'live-a', name: 'Live A', upstreamModelId: 'live-a', modelFormat: 'openai' }],
    });
    const resolveKey = vi.fn(async () => 'work-token');

    const result = await refreshAllProviderModels(resolveKey);

    expect(result.refreshed).toMatchObject([{ ok: true, modelCount: 1 }]);
    expect(resolveKey).toHaveBeenCalledWith(expect.objectContaining({
      id: 'groq',
      authRef: 'keyring:provider:work',
    }));
  });

  it('uses the provider default when refresh is called without an account override', async () => {
    const provider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:default',
      authType: 'oauth' as const,
      authAccounts: {
        work: { authRef: 'keyring:provider:work', addedAt: '2026-08-09T00:00:00.000Z' },
      },
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    const registry: ProviderRegistry = { schemaVersion: 2, providers: [provider] };
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [{ id: 'live-a', name: 'Live A', upstreamModelId: 'live-a', modelFormat: 'openai' }],
    });
    const resolveKey = vi.fn(async () => 'default-token');

    const result = await refreshProviderModelsWithCredential('groq', resolveKey, null);

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(resolveKey).toHaveBeenCalledWith(expect.objectContaining({
      authRef: 'keyring:provider:default',
    }));
  });

  it('persists a transient environment account catalog only in that account slot', async () => {
    const provider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:work',
      defaultAuthRef: 'keyring:provider:default',
      authType: 'oauth' as const,
      activeAuthAccount: 'work',
      authAccounts: {
        work: {
          authRef: 'keyring:provider:work',
          addedAt: '2026-08-09T00:00:00.000Z',
          modelsCache: {
            fetchedAt: '2026-08-09T00:00:00.000Z',
            models: [{
              id: 'work-only',
              name: 'Work only',
              upstreamModelId: 'work-only',
              modelFormat: 'openai' as const,
            }],
          },
        },
        alt: { authRef: 'keyring:provider:alt', addedAt: '2026-08-09T00:00:00.000Z' },
      },
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      refreshedAt: '2026-08-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-08-09T00:00:00.000Z',
        models: [{
          id: 'work-only',
          name: 'Work only',
          upstreamModelId: 'work-only',
          modelFormat: 'openai' as const,
        }],
      },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    const registry: ProviderRegistry = { schemaVersion: 5, providers: [provider] };
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);
    vi.mocked(fetchTemplateModels)
      .mockResolvedValueOnce({
        baseUrl: 'https://api.groq.com/openai/v1',
        models: [{
          id: 'alt-only',
          name: 'Alt only',
          upstreamModelId: 'alt-only',
          modelFormat: 'openai',
        }],
      })
      .mockResolvedValueOnce({
        baseUrl: 'https://api.groq.com/openai/v1',
        models: [],
        error: 'API key rejected (401).',
      });
    const resolveKey = vi.fn(async () => {
      expect(providerMutationState.active).toBe(true);
      return 'alt-token';
    });

    const result = await refreshProviderModelsWithCredential('groq', resolveKey, 'alt');

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(resolveKey).toHaveBeenCalledWith(expect.objectContaining({
      authRef: 'keyring:provider:alt',
    }));
    expect(fetchTemplateModels).toHaveBeenCalledOnce();
    expect(saveRegistry).toHaveBeenCalledOnce();
    expect(registry.providers[0]?.modelsCache?.models.map(model => model.id)).toEqual(['work-only']);
    expect(registry.providers[0]?.authAccounts?.alt?.modelsCache?.models.map(model => model.id))
      .toEqual(['alt-only']);

    const retry = await refreshProviderModelsWithCredential('groq', resolveKey, 'alt');
    expect(retry).toMatchObject({
      ok: false,
      modelCount: 1,
      reason: expect.stringContaining('update the API key before launching'),
    });
    expect(registry.providers[0]?.modelsCache?.models.map(model => model.id)).toEqual(['work-only']);
    expect(registry.providers[0]?.authAccounts?.alt?.modelsCache?.models.map(model => model.id))
      .toEqual(['alt-only']);
    expect(fetchTemplateModels).toHaveBeenCalledTimes(2);
    expect(saveRegistry).toHaveBeenCalledOnce();
    expect(providerMutationState.active).toBe(false);
  });

  it('bypasses CLODEX_KEY_* consistently for a persisted-account refresh', async () => {
    const provider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:work',
      defaultAuthRef: 'keyring:provider:default',
      authType: 'oauth' as const,
      activeAuthAccount: 'work',
      authAccounts: {
        work: { authRef: 'keyring:provider:work', addedAt: '2026-08-09T00:00:00.000Z' },
      },
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    const registry: ProviderRegistry = { schemaVersion: 5, providers: [provider] };
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [{ id: 'work-only', name: 'Work only', upstreamModelId: 'work-only', modelFormat: 'openai' }],
    });
    const previous = process.env.CLODEX_KEY_GROQ;
    process.env.CLODEX_KEY_GROQ = 'temporary-provider-key';
    try {
      const result = await refreshProviderModelsWithCredential(
        'groq',
        async () => 'persisted-work-token',
        null,
        { ignoreProviderOverride: true },
      );

      expect(result).toMatchObject({ ok: true, modelCount: 1 });
      expect(fetchTemplateModels).toHaveBeenCalledOnce();
      expect(registry.providers[0]?.modelsCache?.models[0]?.id).toBe('work-only');
      expect(registry.providers[0]?.authAccounts?.work?.modelsCache?.models[0]?.id).toBe('work-only');
    } finally {
      if (previous === undefined) delete process.env.CLODEX_KEY_GROQ;
      else process.env.CLODEX_KEY_GROQ = previous;
    }
  });

  it('rejects the resolved provider-override generation even if the environment changes back', async () => {
    const provider = {
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:groq',
      authType: 'api' as const,
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(loadRegistryStrict).mockReturnValue({ schemaVersion: 1, providers: [provider] });
    const previous = process.env.CLODEX_KEY_GROQ;
    process.env.CLODEX_KEY_GROQ = 'override-generation-one';
    try {
      const result = await refreshProviderModelsWithCredential('groq', async () => {
        process.env.CLODEX_KEY_GROQ = 'override-generation-two';
        const fingerprint = (await import('node:crypto'))
          .createHash('sha256')
          .update('override-generation-two')
          .digest('hex');
        process.env.CLODEX_KEY_GROQ = 'override-generation-one';
        return {
          credential: 'override-generation-two',
          credentialOverride: { variable: 'CLODEX_KEY_GROQ', fingerprint },
        };
      }, null);

      expect(result).toMatchObject({
        ok: false,
        reason: 'Provider credential override changed while models were refreshing.',
      });
      expect(fetchTemplateModels).not.toHaveBeenCalled();
      expect(saveRegistry).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CLODEX_KEY_GROQ;
      else process.env.CLODEX_KEY_GROQ = previous;
    }
  });

  it('rejects restricted provider API URLs before refreshing models', async () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'bad',
        templateId: 'custom-openai',
        name: 'Bad',
        enabled: true,
        authRef: 'keyring:provider:bad',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://169.254.169.254/v1' },
        addedAt: '2026-06-17T00:00:00.000Z',
      }],
    };

    const result = await refreshProviderModels('bad', 'sk-real-key', registry);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/restricted|private|blocked/i);
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('does not report an imported snapshot as a model-count change on first live refresh', async () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        enabled: true,
        authRef: 'keyring:provider:groq',
        authType: 'api',
        api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
        addedAt: '2026-06-18T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-06-18T00:00:00.000Z',
          models: [{
            id: 'imported-model',
            name: 'Imported model',
            upstreamModelId: 'imported-model',
            modelFormat: 'openai',
          }],
        },
      }],
    };
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [{
        id: 'live-a',
        name: 'Live A',
        upstreamModelId: 'live-a',
        modelFormat: 'openai',
      }, {
        id: 'live-b',
        name: 'Live B',
        upstreamModelId: 'live-b',
        modelFormat: 'openai',
      }],
    });
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);

    const first = await refreshProviderModels('groq', 'gsk-real-key', registry);
    const second = await refreshProviderModels('groq', 'gsk-real-key', registry);

    expect(first).toMatchObject({ ok: true, modelCount: 2 });
    expect(first.previousModelCount).toBeUndefined();
    expect(second).toMatchObject({ ok: true, modelCount: 2, previousModelCount: 2 });
  });

  // The retained OpenCode Go built-in ships one immutable endpoint per SDK
  // package. These records forge only the routing fields — `authRef` still
  // names the keyring slot holding the user's real OpenCode credential, which
  // is exactly what makes a redirected destination an exfiltration channel.
  //
  // The forged addresses are RFC 5737 TEST-NET literals so the SSRF guard
  // resolves them without DNS: before the pin they sail through it, which is
  // the point.
  const OPENCODE_EXFIL_URL = 'https://192.0.2.1/v1';

  const openCodeRegistry = (overrides: {
    id?: string;
    templateId?: string;
    npm?: string;
    url?: string;
  } = {}): ProviderRegistry => ({
    schemaVersion: 1,
    providers: [{
      id: overrides.id ?? 'opencode-go',
      templateId: overrides.templateId ?? 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      api: {
        npm: overrides.npm ?? '@ai-sdk/openai-compatible',
        url: overrides.url ?? OPENCODE_GO_COMPLETIONS_BASE_URL,
      },
      addedAt: '2026-08-11T00:00:00.000Z',
    }],
  });

  it('refuses a forged OpenCode Anthropic endpoint before the npm branch sends the key', async () => {
    const registry = openCodeRegistry({
      npm: '@ai-sdk/anthropic',
      url: OPENCODE_EXFIL_URL,
    });

    const result = await refreshProviderModels('opencode-go', 'oc-real-key', registry);

    // Collaborator assertions come first: they name the leak directly instead
    // of letting a downstream unwrap error mask which call put the key on the wire.
    expect(fetchAnthropicModels).not.toHaveBeenCalled();
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not support a custom API base URL/i);
  });

  it('refuses a forged endpoint on a record that drifts its id but keeps the template', async () => {
    const registry = openCodeRegistry({
      id: 'opencode-go-mirror',
      npm: '@ai-sdk/anthropic',
      url: OPENCODE_EXFIL_URL,
    });

    const result = await refreshProviderModels('opencode-go-mirror', 'oc-real-key', registry);

    // Collaborator assertions come first: they name the leak directly instead
    // of letting a downstream unwrap error mask which call put the key on the wire.
    expect(fetchAnthropicModels).not.toHaveBeenCalled();
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not support a custom API base URL/i);
  });

  it('fails closed when an OpenCode record names an SDK package the provider does not serve', async () => {
    const registry = openCodeRegistry({ npm: '@ai-sdk/openai' });

    const result = await refreshProviderModels('opencode-go', 'oc-real-key', registry);

    expect(fetchAnthropicModels).not.toHaveBeenCalled();
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not support the @ai-sdk\/openai SDK package/i);
  });

  it.each([
    ['@ai-sdk/openai-compatible', OPENCODE_GO_ANTHROPIC_BASE_URL],
    ['@ai-sdk/anthropic', OPENCODE_GO_COMPLETIONS_BASE_URL],
  ])('refuses mismatched OpenCode package/destination pair %s before network or writes', async (npm, url) => {
    const registry = openCodeRegistry({ npm, url });

    const result = await refreshProviderModels('opencode-go', 'oc-real-key', registry);

    expect(fetchAnthropicModels).not.toHaveBeenCalled();
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not support a custom API base URL/i);
  });

  it('still refreshes an unmodified OpenCode record against its pinned endpoint', async () => {
    const registry = openCodeRegistry();
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
      models: [{
        id: 'oc-model',
        name: 'OC Model',
        upstreamModelId: 'oc-model',
        modelFormat: 'openai',
      }],
    });
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);

    const result = await refreshProviderModels('opencode-go', 'oc-real-key', registry);

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[2]).toBe(OPENCODE_GO_COMPLETIONS_BASE_URL);
  });

  it('leaves an ordinary Anthropic provider refreshing against its own configured endpoint', async () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'ordinary-anthropic',
        templateId: 'custom-anthropic',
        name: 'Ordinary Anthropic',
        enabled: true,
        authRef: 'keyring:provider:ordinary-anthropic',
        authType: 'api',
        api: { npm: '@ai-sdk/anthropic', url: 'https://192.0.2.2/v1' },
        addedAt: '2026-08-11T00:00:00.000Z',
      }],
    };
    vi.mocked(fetchAnthropicModels).mockResolvedValue({
      baseUrl: 'https://192.0.2.2/v1',
      models: [{
        id: 'ordinary-model',
        name: 'Ordinary Model',
        upstreamModelId: 'ordinary-model',
        modelFormat: 'anthropic',
      }],
    });
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);

    const result = await refreshProviderModels('ordinary-anthropic', 'sk-ant-real-key', registry);

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(fetchAnthropicModels).toHaveBeenCalledWith('https://192.0.2.2/v1', 'sk-ant-real-key');
  });

  // The destination pin above only decides WHERE the key goes. It says nothing
  // about which discovery routine reads the answer, and a record storing
  // `api.npm: '@ai-sdk/anthropic'` at the pinned OpenCode Anthropic address
  // clears the pin and then falls into the ordinary Anthropic npm branch.
  // `fetchAnthropicModels` expects an Anthropic `{ data: [...] }` envelope,
  // while OpenCode answers a bare array, and it applies none of the committed
  // allowlist/metadata overlay — so the retained catalog silently degrades.
  // Retained identity has to pick the discovery route before npm does.
  const openCodeTemplateModels = [{
    id: 'oc-model',
    name: 'OC Model',
    upstreamModelId: 'oc-model',
    modelFormat: 'openai' as const,
  }];

  it('routes a retained OpenCode record with Anthropic npm through template discovery', async () => {
    const registry = openCodeRegistry({
      npm: '@ai-sdk/anthropic',
      url: OPENCODE_GO_ANTHROPIC_BASE_URL,
    });
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      models: openCodeTemplateModels,
    });
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);

    const result = await refreshProviderModels('opencode-go', 'oc-real-key', registry);

    // Naming the wrong collaborator first: this is the assertion that fails
    // when the npm branch wins, and it says which routine read the catalog.
    expect(fetchAnthropicModels).not.toHaveBeenCalled();
    expect(fetchTemplateModels).toHaveBeenCalled();
    // The template carries the allowlist and the bare-array parse flag, so the
    // retained template — not the record's named one — must be what is passed.
    expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[0]?.id).toBe('opencode-go');
    expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[0]?.staticModelPolicy).toBe('allowlist');
    expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[0]?.npm).toBe('@ai-sdk/anthropic');
    expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[2]).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
    expect(result).toMatchObject({ ok: true, modelCount: 1 });
  });

  it('routes a retained OpenCode record that names another template through the retained template', async () => {
    const registry = openCodeRegistry({
      templateId: 'openai',
      url: OPENCODE_GO_COMPLETIONS_BASE_URL,
    });
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
      models: openCodeTemplateModels,
    });
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);

    const result = await refreshProviderModels('opencode-go', 'oc-real-key', registry);

    // Without complete identity the OpenAI template is resolved instead: its
    // absent staticModels turn the committed allowlist into a no-op overlay
    // and `fetchTemplateModels`'s own OpenCode pin re-check never fires.
    expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[0]?.id).toBe('opencode-go');
    expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[0]?.staticModelPolicy).toBe('allowlist');
    expect(result).toMatchObject({ ok: true, modelCount: 1 });
  });

  it.each([
    ['@ai-sdk/openai-compatible', OPENCODE_GO_COMPLETIONS_BASE_URL],
    ['@ai-sdk/anthropic', OPENCODE_GO_ANTHROPIC_BASE_URL],
  ])(
    'refreshes canonical OpenCode identity with %s before a foreign manual-only template can preempt it',
    async (npm, url) => {
      const registry = openCodeRegistry({ templateId: 'bedrock', npm, url });
      vi.mocked(fetchTemplateModels).mockResolvedValue({
        baseUrl: url,
        models: openCodeTemplateModels,
      });
      vi.mocked(loadRegistryStrict).mockReturnValue(registry);

      const result = await refreshProviderModels('opencode-go', 'oc-real-key', registry);

      expect(fetchTemplateModels).toHaveBeenCalledOnce();
      expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[0]).toMatchObject({
        id: 'opencode-go',
        npm,
      });
      expect(saveRegistry).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ ok: true, modelCount: 1 });
    },
  );

  it.each([
    ['opencode-go', 'openai', '@ai-sdk/openai-compatible', OPENCODE_GO_COMPLETIONS_BASE_URL],
    ['opencode-go', 'openai', '@ai-sdk/anthropic', OPENCODE_GO_ANTHROPIC_BASE_URL],
    ['opencode-go-mirror', 'opencode-go', '@ai-sdk/openai-compatible', OPENCODE_GO_COMPLETIONS_BASE_URL],
    ['opencode-go-mirror', 'opencode-go', '@ai-sdk/anthropic', OPENCODE_GO_ANTHROPIC_BASE_URL],
  ])(
    'uses the retained template and package pin when %s names %s without a URL (%s)',
    async (id, templateId, npm, url) => {
      const registry = openCodeRegistry({ id, templateId, npm });
      delete registry.providers[0]!.api.url;
      vi.mocked(fetchTemplateModels).mockResolvedValue({
        baseUrl: url,
        models: openCodeTemplateModels,
      });
      vi.mocked(loadRegistryStrict).mockReturnValue(registry);

      const result = await refreshProviderModels(id, 'oc-real-key', registry);

      expect(fetchAnthropicModels).not.toHaveBeenCalled();
      expect(fetchTemplateModels).toHaveBeenCalledOnce();
      expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[0]).toMatchObject({
        id: 'opencode-go',
        staticModelPolicy: 'allowlist',
        npm,
      });
      expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[2]).toBe(url);
      expect(saveRegistry).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ ok: true, modelCount: 1 });
    },
  );

  it.each([
    ['@ai-sdk/openai-compatible', OPENCODE_GO_COMPLETIONS_BASE_URL],
    ['@ai-sdk/anthropic', OPENCODE_GO_ANTHROPIC_BASE_URL],
  ])('routes a retained OpenCode template migration with %s through template discovery', async (npm, url) => {
    const registry = openCodeRegistry({ id: 'opencode-go-mirror', npm, url });
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: url,
      models: openCodeTemplateModels,
    });
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);

    const result = await refreshProviderModels('opencode-go-mirror', 'oc-real-key', registry);

    expect(fetchAnthropicModels).not.toHaveBeenCalled();
    expect(vi.mocked(fetchTemplateModels).mock.calls[0]?.[0]).toMatchObject({
      id: 'opencode-go',
      npm,
    });
    expect(result).toMatchObject({ ok: true, modelCount: 1 });
  });

  // Ordering conservation: complete identity must not weaken the refusal, and
  // the refusal must still land before anything reaches the network.
  it('still refuses a forged endpoint on a retained record that names another template', async () => {
    const registry = openCodeRegistry({
      templateId: 'openai',
      npm: '@ai-sdk/anthropic',
      url: OPENCODE_EXFIL_URL,
    });

    const result = await refreshProviderModels('opencode-go', 'oc-real-key', registry);

    expect(fetchAnthropicModels).not.toHaveBeenCalled();
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not support a custom API base URL/i);
  });
});
