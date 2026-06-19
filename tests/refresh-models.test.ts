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

import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { saveRegistry } from '../src/registry/io.js';

describe('refreshProviderModels', () => {
  beforeEach(() => {
    vi.mocked(fetchTemplateModels).mockReset();
    vi.mocked(saveRegistry).mockClear();
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

    const first = await refreshProviderModels('groq', 'gsk-real-key', registry);
    const second = await refreshProviderModels('groq', 'gsk-real-key', registry);

    expect(first).toMatchObject({ ok: true, modelCount: 2 });
    expect(first.previousModelCount).toBeUndefined();
    expect(second).toMatchObject({ ok: true, modelCount: 2, previousModelCount: 2 });
  });
});
