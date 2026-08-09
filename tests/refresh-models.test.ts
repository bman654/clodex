import { describe, expect, it, vi, beforeEach } from 'vitest';
import { refreshAllProviderModels, refreshProviderModels } from '../src/registry/refresh-models.js';
import type { ProviderRegistry } from '../src/registry/types.js';
import {
  OPENCODE_GO_ANTHROPIC_BASE_URL,
  OPENCODE_GO_COMPLETIONS_BASE_URL,
} from '../src/data/opencode-go-models.js';

vi.mock('../src/registry/fetch-template-models.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/registry/fetch-template-models.js')>()),
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
  withRegistryWriteLock: vi.fn(async (operation: () => unknown) => operation()),
}));

import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { loadRegistryStrict, saveRegistry } from '../src/registry/io.js';

describe('refreshProviderModels', () => {
  beforeEach(() => {
    vi.mocked(fetchTemplateModels).mockReset();
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

  it('deduplicates provider model ids before persisting and reporting the refresh count', async () => {
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
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    const model = {
      id: 'live-a',
      name: 'First Live A',
      upstreamModelId: 'live-a',
      modelFormat: 'openai' as const,
    };
    vi.mocked(loadRegistryStrict).mockReturnValue(registry);
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      baseUrl: 'https://api.groq.com/openai/v1',
      models: [model, { ...model, name: 'Duplicate Live A' }],
    });

    const result = await refreshProviderModels('groq', 'test-key', registry);

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(registry.providers[0]?.modelsCache?.models).toEqual([
      expect.objectContaining({ id: 'live-a', name: 'First Live A' }),
    ]);
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

  it('rejects restricted provider API URLs before refreshing models', async () => {
    const registry: ProviderRegistry = {
      version: 1,
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

  it('does not borrow the OpenCode template URL for an ambiguous missing-url provider', async () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Ambiguous OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            id: 'custom-model',
            name: 'Custom model',
            upstreamModelId: 'custom-model',
            modelFormat: 'openai',
            npm: '@ai-sdk/openai-compatible',
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    const result = await refreshProviderModels('opencode-go', 'custom-key', registry);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no verified API base URL.*re-add/i),
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'template id only',
      id: 'custom-opencode-slot',
      templateId: 'opencode-go',
    },
    {
      label: 'provider id only',
      id: 'opencode-go',
      templateId: 'legacy-unmapped-template',
    },
    {
      label: 'provider id with a different known template',
      id: 'opencode-go',
      templateId: 'groq',
    },
  ])('does not borrow the OpenCode template URL from a partial identity ($label)', async ({
    id,
    templateId,
  }) => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id,
        templateId,
        name: 'Partial OpenCode identity',
        enabled: true,
        authRef: `keyring:provider:${id}`,
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            id: 'custom-model',
            name: 'Custom model',
            upstreamModelId: 'custom-model',
            modelFormat: 'openai',
            npm: '@ai-sdk/openai-compatible',
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    const result = await refreshProviderModels(id, 'custom-key', registry);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no verified API base URL.*re-add/i),
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it.each([
    ['template/completions', 'custom-opencode-slot', 'opencode-go', OPENCODE_GO_COMPLETIONS_BASE_URL],
    ['provider/completions', 'opencode-go', 'legacy-unmapped-template', OPENCODE_GO_COMPLETIONS_BASE_URL],
    ['provider-known-template/completions', 'opencode-go', 'groq', OPENCODE_GO_COMPLETIONS_BASE_URL],
    ['template/anthropic', 'custom-opencode-slot', 'opencode-go', OPENCODE_GO_ANTHROPIC_BASE_URL],
    ['provider/anthropic', 'opencode-go', 'legacy-unmapped-template', OPENCODE_GO_ANTHROPIC_BASE_URL],
    ['provider-known-template/anthropic', 'opencode-go', 'groq', OPENCODE_GO_ANTHROPIC_BASE_URL],
    ['uppercase host', 'opencode-go', 'groq', 'https://OPENCODE.AI/zen/go/v1'],
    ['default port', 'opencode-go', 'groq', 'https://opencode.ai:443/zen/go/v1'],
    ['dot segment', 'opencode-go', 'groq', 'https://opencode.ai/zen/./go/v1'],
    ['encoded path', 'opencode-go', 'groq', 'https://opencode.ai/%7Aen/go/%76%31'],
    ['encoded separator', 'opencode-go', 'groq', 'https://opencode.ai/zen%2Fgo/v1'],
    ['trailing-dot host and alternate path', 'opencode-go', 'groq', 'https://opencode.ai./some/other/path'],
    ['userinfo and query', 'opencode-go', 'groq', 'https://user:secret@opencode.ai/zen/go/v1?source=custom#fragment'],
    ['plaintext scheme', 'opencode-go', 'groq', 'http://opencode.ai/zen/go/v1'],
  ])('does not refresh a partial identity through an official endpoint (%s)', async (
    _label,
    id,
    templateId,
    url,
  ) => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id,
        templateId,
        name: 'Partial OpenCode identity',
        enabled: true,
        authRef: `keyring:provider:${id}`,
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    const result = await refreshProviderModels(id, 'custom-key', registry);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no verified API base URL.*re-add/i),
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'OpenCode id with OpenAI OAuth template',
      id: 'opencode-go',
      templateId: 'openai',
      url: undefined,
    },
    {
      label: 'OpenAI OAuth id with OpenCode template',
      id: 'openai-oauth',
      templateId: 'opencode-go',
      url: OPENCODE_GO_COMPLETIONS_BASE_URL,
    },
  ])('blocks OAuth discovery before dispatch for a partial identity ($label)', async ({
    id,
    templateId,
    url,
  }) => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id,
        templateId,
        name: 'Boundary-confused OAuth provider',
        enabled: true,
        authRef: `keyring:provider:${id}`,
        authType: 'oauth',
        api: { npm: '@ai-sdk/openai', ...(url ? { url } : {}) },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await refreshProviderModels(id, 'oauth-token', registry);
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/no verified API base URL.*re-add/i),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fetchTemplateModels).not.toHaveBeenCalled();
      expect(saveRegistry).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects a fail-closed OpenCode identity before resolving its credential', async () => {
    const provider: ProviderRegistry['providers'][number] = {
      id: 'opencode-go',
      templateId: 'openai',
      name: 'Boundary-confused OAuth provider',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'oauth',
      api: { npm: '@ai-sdk/openai' },
      addedAt: '2026-08-08T00:00:00.000Z',
    };
    vi.mocked(loadRegistryStrict).mockReturnValue({ schemaVersion: 1, providers: [provider] });
    const resolveKey = vi.fn(async () => 'oauth-token');

    const result = await refreshAllProviderModels(resolveKey);

    expect(resolveKey).not.toHaveBeenCalled();
    expect(result.refreshed).toEqual([
      expect.objectContaining({ id: provider.id, ok: false }),
    ]);
  });

  it('does not report an imported snapshot as a model-count change on first live refresh', async () => {
    const registry: ProviderRegistry = {
      version: 1,
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
});
