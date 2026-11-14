import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOllamaCloudModels,
  OLLAMA_CLOUD_COMPLETIONS_BASE_URL,
} from '../src/data/ollama-cloud-models.js';
import { TEST_TIMEOUT_MS } from '../src/constants.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import { transformOpenAiCompatibleRequestBody } from '../src/model-runtime-compatibility.js';
import { effortProviderOptions } from '../src/provider-factory.js';
import {
  getTemplateById,
  listAddableTemplates,
  verifyOllamaCloudCredential,
} from '../src/provider-templates.js';
import { applyTemplateModelMetadata, fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { materializeRegistry } from '../src/registry/materialize.js';
import { providerPreservesModelPricing } from '../src/registry/pricing.js';
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

function ollamaRegistry(models: CachedModel[]): ProviderRegistry {
  return {
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
    const providers = materializeRegistry(ollamaRegistry(models), () => 'ollama-key');
    const routes = buildHttpProxyRoutes(providers, [
      { providerId: 'ollama-cloud', modelId: 'kimi-k3' },
    ]).routes;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      // createLanguageModel keys streamed usage (include_usage) on this provider id.
      providerId: 'ollama-cloud',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: OLLAMA_CLOUD_COMPLETIONS_BASE_URL,
      apiKey: 'ollama-key',
    });
  });
});

describe('Ollama Cloud model discovery with the real template', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists models from ollama.com/v1/models and keeps only the allowlist', async () => {
    // Answers like ollama.com (an OpenAI `{data: [...]}` list) at the real path only.
    const fetchMock = vi.fn(async (url: string) => (url === 'https://ollama.com/v1/models'
      ? new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-oss:120b', object: 'model', owned_by: 'ollama' },
          { id: 'kimi-k3', object: 'model', owned_by: 'ollama' },
          { id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'ollama' },
        ],
      }), { status: 200 })
      : new Response('404 page not found', { status: 404 })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchTemplateModels(getTemplateById('ollama-cloud')!, 'ollama-key');
    expect(result.error).toBeUndefined();
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://ollama.com/v1/models']);
    expect(result.models.map(m => [m.id, m.name])).toEqual([
      ['kimi-k3', 'Kimi K3'],
      ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
    ]);
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

  it('is wired on the template and takes only the key', () => {
    expect(getTemplateById('ollama-cloud')?.verifyCredential).toBe(verifyOllamaCloudCredential);
    expect(verifyOllamaCloudCredential.length).toBe(1);
  });

  it('hands its timeout signal to fetch, so a stalled probe ends as inconclusive', async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    // A fetch that never answers on its own: it settles only when the signal it was
    // given aborts, as the real fetch does.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    try {
      const probe = verifyOllamaCloudCredential('k');
      expect(timeoutSpy).toHaveBeenCalledWith(TEST_TIMEOUT_MS);
      deadline.abort();
      const hung = new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 1000));
      expect(await Promise.race([probe, hung])).toBeNull();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe('Ollama Cloud per-model metadata', () => {
  // contextWindow is `model_info.<arch>.context_length` from ollama.com `/api/show`
  // (re-measured 2026-10-12: 1048576 for all four). Re-measure before changing it.
  // modalities mirror `/api/show` `capabilities` (checked 2026-10-13): `vision` on every
  // id except glm-5.3.
  const EXPECTED: Record<string, { name: string; family: string; modalities: string[] }> = {
    'kimi-k3': { name: 'Kimi K3', family: 'kimi', modalities: ['text', 'image'] },
    'glm-5.3': { name: 'GLM-5.3', family: 'glm', modalities: ['text'] },
    'glm-5.3-flash': { name: 'GLM-5.3 Flash', family: 'glm', modalities: ['text', 'image'] },
    'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', family: 'deepseek', modalities: ['text', 'image'] },
  };

  it('pins every curated field for each model', () => {
    const models = buildOllamaCloudModels();
    expect(models.map(m => m.id)).toEqual(Object.keys(EXPECTED));
    for (const model of models) {
      expect(model, model.id).toEqual({
        id: model.id,
        ...EXPECTED[model.id],
        contextWindow: 1048576,
        upstreamModelId: model.id,
        modelFormat: 'openai',
        npm: '@ai-sdk/openai-compatible',
        apiUrl: 'https://ollama.com/v1',
        compatibility: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: 'max_tokens',
          supportsReasoningEffort: false,
          supportsStreamUsage: true,
        },
      });
    }
  });

  it('carries the curated window and wire quirks from discovery through materialization', () => {
    const template = getTemplateById('ollama-cloud')!;
    // Live discovery carries no window or compatibility; the overlay supplies them.
    const discovered = applyTemplateModelMetadata(template, IDS.map(liveModel));
    const [provider] = materializeRegistry(ollamaRegistry(discovered), () => 'ollama-key');
    expect(provider!.models.map(m => m.id)).toEqual(IDS);
    for (const model of provider!.models) {
      expect(model.contextWindow, model.id).toBe(1048576);
      expect(model.modalities, model.id).toEqual(EXPECTED[model.id]!.modalities);

      const body = transformOpenAiCompatibleRequestBody({
        model: model.id,
        store: true,
        max_completion_tokens: 4096,
        messages: [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hi' }],
      }, model.compatibility!) as Record<string, unknown>;
      expect(body, model.id).toEqual({
        model: model.id,
        max_tokens: 4096,
        messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }],
      });

      const effort = effortProviderOptions(model.npm!, 'high', model.id, {
        providerId: 'ollama-cloud',
        compatibility: model.compatibility,
      } as never);
      expect(effort, model.id).toBeUndefined();
    }
  });

  it('launches on ollama.com even when the stored provider URL differs', () => {
    const template = getTemplateById('ollama-cloud')!;
    const registry = ollamaRegistry(applyTemplateModelMetadata(template, IDS.map(liveModel)));
    registry.providers[0]!.api.url = 'https://relay.example/v1';
    const [provider] = materializeRegistry(registry, () => 'ollama-key');
    for (const model of provider!.models) {
      expect(model.completionsUrl, model.id).toBe('https://ollama.com/v1/chat/completions');
    }
  });

  it('keeps the shared pricing cache off a record whose persisted flag is absent', () => {
    expect(providerPreservesModelPricing({ templateId: 'ollama-cloud' })).toBe(true);
    // An explicit persisted choice still wins.
    expect(providerPreservesModelPricing({ templateId: 'ollama-cloud', preserveModelPricing: false }))
      .toBe(false);
  });
});

describe('verifyOllamaCloudCredential 403 classification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Synthetic body: no real Ollama Cloud 403 has been observed. It pins the predicate's
  // precedence — a body that names the key is a key rejection even beside entitlement words.
  // One body per entitlement word, each containing no other word from the list, so
  // dropping any single word from the predicate turns exactly one row red.
  it.each([
    ['subscription', '{"error":"a subscription is required"}'],
    ['plan', '{"error":"not available on your plan"}'],
    ['upgrade', '{"error":"please upgrade to continue"}'],
    ['quota', '{"error":"weekly quota exceeded"}'],
    ['model', '{"error":"this model is not enabled"}'],
    ['access', '{"error":"no access to this resource"}'],
  ])('treats a 403 naming only "%s" as inconclusive', async (_word, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 403 })));
    expect(await verifyOllamaCloudCredential('good-key')).toBeNull();
  });

  it.each([
    ['a bare Forbidden', '{"error":"Forbidden"}'],
    ['an HTML block page', '<html><body><h1>403 Forbidden</h1></body></html>'],
    ['an empty body', ''],
  ])('rejects a 403 with %s', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 403 })));
    expect(await verifyOllamaCloudCredential('bad-key')).not.toBeNull();
  });

  it('rejects a 401 even when its body reads like an entitlement problem', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":"this model requires a subscription"}', { status: 401 })));
    expect(await verifyOllamaCloudCredential('bad-key')).not.toBeNull();
  });

  it('rejects a 403 that names the API key even when it also mentions access', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":"api key does not have access"}', { status: 403 })));
    expect(await verifyOllamaCloudCredential('bad-key')).not.toBeNull();
  });
});
