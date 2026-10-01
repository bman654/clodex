import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOllamaCloudModels,
  OLLAMA_CLOUD_COMPLETIONS_BASE_URL,
} from '../src/data/ollama-cloud-models.js';
import { TEST_TIMEOUT_MS } from '../src/constants.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import {
  getTemplateById,
  listAddableTemplates,
  verifyOllamaCloudCredential,
} from '../src/provider-templates.js';
import { applyTemplateModelMetadata } from '../src/registry/fetch-template-models.js';
import { materializeRegistry } from '../src/registry/materialize.js';
import type { CachedModel, ProviderRegistry } from '../src/registry/types.js';

const IDS = ['kimi-k3', 'glm-5.3', 'glm-5.3-flash', 'deepseek-v4.1-flash'];

function liveModel(id: string): CachedModel {
  return {
    id,
    name: `live ${id}`,
    upstreamModelId: id,
    family: id.split('-')[0] ?? id,
    brand: 'Ollama',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
  };
}

describe('Ollama Cloud template and catalog', () => {
  it('is a builtin addable api template pinned to ollama.com/v1', () => {
    const template = getTemplateById('ollama-cloud')!;
    expect(template).toMatchObject({
      name: 'Ollama Cloud',
      authType: 'api',
      npm: '@ai-sdk/openai-compatible',
      defaultBaseUrl: 'https://ollama.com/v1',
      signupUrl: 'https://ollama.com',
      staticModelPolicy: 'allowlist',
      preserveModelPricing: true,
      supported: true,
    });
    expect(listAddableTemplates([]).map(t => t.id)).toContain('ollama-cloud');
    expect(listAddableTemplates(['ollama-cloud']).map(t => t.id)).not.toContain('ollama-cloud');
  });

  it('catalog holds exactly the four Chat Completions models with sane invariants', () => {
    const models = buildOllamaCloudModels();
    expect(models.map(m => m.id)).toEqual(IDS);
    for (const model of models) {
      expect(model.modelFormat, model.id).toBe('openai');
      expect(model.npm, model.id).toBe('@ai-sdk/openai-compatible');
      expect(model.apiUrl, model.id).toBe('https://ollama.com/v1');
      expect(model.upstreamModelId, model.id).toBe(model.id);
      expect(Number.isInteger(model.contextWindow), model.id).toBe(true);
      expect(model.contextWindow!, model.id).toBeGreaterThan(0);
      expect(model.contextWindow!, model.id).toBeLessThanOrEqual(10_000_000);
      expect(model.name.trim(), model.id).toBeTruthy();
      expect(model.cost, model.id).toBeUndefined();
    }
  });

  it('returns isolated catalog copies', () => {
    buildOllamaCloudModels()[0]!.name = 'mutated';
    expect(buildOllamaCloudModels()[0]!.name).toBe('Kimi K3');
  });

  it('allowlist hides unlisted live models and overlays curated metadata', () => {
    const template = getTemplateById('ollama-cloud')!;
    const result = applyTemplateModelMetadata(template, [
      liveModel('gpt-oss:120b'),
      liveModel('kimi-k3'),
      liveModel('qwen3-coder:480b'),
      liveModel('glm-5.3-flash'),
    ]);
    expect(result.map(m => m.id)).toEqual(['kimi-k3', 'glm-5.3-flash']);
    expect(result[0]).toMatchObject({
      name: 'Kimi K3',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      apiUrl: OLLAMA_CLOUD_COMPLETIONS_BASE_URL,
    });
  });

  it('materializes a Chat Completions route with the stored key', () => {
    const template = getTemplateById('ollama-cloud')!;
    const models = applyTemplateModelMetadata(template, IDS.map(liveModel));
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'ollama-cloud',
        templateId: 'ollama-cloud',
        name: 'Ollama Cloud',
        enabled: true,
        authRef: 'keyring:provider:ollama-cloud',
        authType: 'api',
        preserveModelPricing: true,
        api: { npm: '@ai-sdk/openai-compatible', url: OLLAMA_CLOUD_COMPLETIONS_BASE_URL },
        modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models },
        addedAt: '2026-10-01T00:00:00.000Z',
      }],
    };
    const providers = materializeRegistry(registry, () => 'ollama-key');
    const routes = buildHttpProxyRoutes(providers, [
      { providerId: 'ollama-cloud', modelId: 'kimi-k3' },
    ]).routes;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: OLLAMA_CLOUD_COMPLETIONS_BASE_URL,
      apiKey: 'ollama-key',
    });
  });
});

describe('verifyOllamaCloudCredential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a 401 and probes the literal endpoint with a catalog model', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await verifyOllamaCloudCredential('bad-key');
    expect(error).toContain('authentication failed');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://ollama.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bad-key');
    expect(IDS).toContain((JSON.parse(String(init.body)) as { model?: string }).model);
  });

  it('rejects a key-shaped 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid api key"}', { status: 403 })));
    expect(await verifyOllamaCloudCredential('bad-key')).not.toBeNull();
  });

  it('does not read a plan/entitlement 403 as a bad key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":"this model requires a subscription"}', { status: 403 })));
    expect(await verifyOllamaCloudCredential('good-key')).toBeNull();
  });

  it('accepts a key that only fails request validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"messages required"}', { status: 400 })));
    expect(await verifyOllamaCloudCredential('good-key')).toBeNull();
  });

  it('treats an unreachable upstream as inconclusive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await verifyOllamaCloudCredential('any-key')).toBeNull();
  });

  it('is wired on the template, takes only the key, and bounds the probe', async () => {
    expect(getTemplateById('ollama-cloud')?.verifyCredential).toBe(verifyOllamaCloudCredential);
    expect(verifyOllamaCloudCredential.length).toBe(1);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    await verifyOllamaCloudCredential('k');
    expect(timeoutSpy).toHaveBeenCalledWith(TEST_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });
});
