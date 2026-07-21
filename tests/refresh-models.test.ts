import { describe, expect, it, vi, beforeEach } from 'vitest';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import type { ProviderRegistry } from '../src/registry/types.js';

vi.mock('../src/registry/fetch-template-models.js', () => ({
  fetchTemplateModels: vi.fn(),
}));
vi.mock('../src/registry/custom-endpoint.js', () => ({
  fetchAnthropicModels: vi.fn(),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => ({ version: 1, providers: [] })),
  saveRegistry: vi.fn(),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(async (operation: () => unknown) => operation()),
}));

import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';

describe('refreshProviderModels', () => {
  beforeEach(() => {
    vi.mocked(fetchTemplateModels).mockReset();
    vi.mocked(loadRegistry).mockReset();
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
    vi.mocked(loadRegistry).mockReturnValue(persistedRegistry);
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
    expect(loadRegistry).toHaveBeenCalledOnce();
    expect(saveRegistry).toHaveBeenCalledWith(persistedRegistry);
    expect(persistedRegistry.providers[0]?.name).toBe('Renamed while discovery was running');
    expect(persistedRegistry.providers[0]?.modelsCache?.models[0]?.id).toBe('live-a');
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
    vi.mocked(loadRegistry).mockReturnValue({
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
    vi.mocked(loadRegistry).mockReturnValue({
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
    vi.mocked(loadRegistry).mockReturnValue(registry);

    const first = await refreshProviderModels('groq', 'gsk-real-key', registry);
    const second = await refreshProviderModels('groq', 'gsk-real-key', registry);

    expect(first).toMatchObject({ ok: true, modelCount: 2 });
    expect(first.previousModelCount).toBeUndefined();
    expect(second).toMatchObject({ ok: true, modelCount: 2, previousModelCount: 2 });
  });
});
