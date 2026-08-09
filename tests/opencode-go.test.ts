import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenCodeGoModels,
  OPENCODE_GO_ANTHROPIC_BASE_URL,
  OPENCODE_GO_COMPLETIONS_BASE_URL,
  OPENCODE_GO_SOURCE,
  OPENCODE_GO_SOURCE_FETCHED_AT,
} from '../src/data/opencode-go-models.js';
import { TEST_TIMEOUT_MS } from '../src/constants.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import { getTemplateById, verifyOpenCodeGoCredential } from '../src/provider-templates.js';
import { applyTemplateModelMetadata } from '../src/registry/fetch-template-models.js';
import { materializeRegistry } from '../src/registry/materialize.js';
import type { CachedModel, ProviderRegistry } from '../src/registry/types.js';

function liveModel(id: string): CachedModel {
  return {
    id,
    name: `live ${id}`,
    upstreamModelId: id,
    family: id.split('-')[0] ?? id,
    brand: 'OpenCode',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
  };
}

describe('OpenCode Go catalog', () => {
  /**
   * The exact literals below — the total, the 4/13 format split, and
   * gpt-5.6-luna's precise cost — are deliberate tripwires, not incidental
   * assertions. The catalog is generated, so a regeneration that silently
   * adds, drops, or reprices a model should FAIL here and be re-read by a
   * human rather than shipped. If you are here after `npm run
   * update:opencode-go`, the right move is to check the diff and update these
   * numbers on purpose — not to loosen them.
   */
  it('records its OpenCode catalog source and excludes Responses-only models', () => {
    const models = buildOpenCodeGoModels();
    const ids = models.map(model => model.id);

    expect(OPENCODE_GO_SOURCE).toBe('https://models.dev/api.json');
    expect(new Date(OPENCODE_GO_SOURCE_FETCHED_AT).toISOString()).toBe(OPENCODE_GO_SOURCE_FETCHED_AT);
    expect(models).toHaveLength(17);
    expect(new Set(ids).size).toBe(models.length);
    expect(ids).not.toContain('grok-4.5');
    expect(new Set(models.map(model => model.modelFormat))).toEqual(new Set(['anthropic', 'openai']));
    expect(models.filter(model => model.modelFormat === 'anthropic')).toHaveLength(4);
    expect(models.filter(model => model.modelFormat === 'openai')).toHaveLength(13);
  });

  it('assigns per-model protocol, endpoint, context, vision, pricing, and compatibility metadata', () => {
    const byId = new Map(buildOpenCodeGoModels().map(model => [model.id, model]));

    expect(byId.get('qwen3.8-max')).toMatchObject({
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      apiUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      contextWindow: 1_000_000,
      modalities: ['text', 'image'],
    });
    expect(byId.get('deepseek-v4-pro')).toMatchObject({
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      apiUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
      contextWindow: 1_000_000,
      compatibility: {
        reasoningEffortMap: {
          minimal: null,
          low: null,
          medium: null,
          high: 'high',
          max: 'max',
        },
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek',
        maxTokensField: 'max_tokens',
      },
    });
    expect(byId.get('qwen3.6-plus')?.compatibility?.thinkingFormat).toBe('qwen');
    expect(byId.get('kimi-k2.6')?.compatibility?.supportsReasoningEffort).toBe(false);
    expect(byId.get('gpt-5.6-luna')?.cost).toEqual({
      input: 0.1,
      output: 0.6,
      cache_read: 0.01,
      cache_write: 0.125,
    });
  });

  it('uses live discovery only for availability and fails closed on unsupported models', () => {
    const template = getTemplateById('opencode-go')!;
    const result = applyTemplateModelMetadata(template, [
      liveModel('qwen3.8-max'),
      liveModel('deepseek-v4-pro'),
      liveModel('grok-4.5'),
      liveModel('unknown-future-model'),
    ]);

    expect(result.map(model => model.id)).toEqual(['qwen3.8-max', 'deepseek-v4-pro']);
    expect(result[0]).toMatchObject({
      name: 'Qwen3.8 Max',
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      apiUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
    });
    expect(result[1]).toMatchObject({
      name: 'DeepSeek V4 Pro',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      apiUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
    });
  });

  it('materializes Anthropic passthrough and Chat Completions routes under one credential', () => {
    const template = getTemplateById('opencode-go')!;
    const models = applyTemplateModelMetadata(template, [
      liveModel('qwen3.8-max'),
      liveModel('deepseek-v4-pro'),
    ]);
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        preserveModelPricing: true,
        api: {
          npm: '@ai-sdk/openai-compatible',
          url: OPENCODE_GO_COMPLETIONS_BASE_URL,
        },
        modelsCache: {
          fetchedAt: '2026-08-07T00:00:00.000Z',
          models,
        },
        addedAt: '2026-08-07T00:00:00.000Z',
      }],
    };

    const providers = materializeRegistry(registry, () => 'go-key');
    const routes = buildHttpProxyRoutes(providers, [
      { providerId: 'opencode-go', modelId: 'qwen3.8-max' },
      { providerId: 'opencode-go', modelId: 'deepseek-v4-pro' },
    ]).routes;

    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      modelFormat: 'anthropic',
      upstreamUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      apiKey: 'go-key',
    });
    expect(routes[1]).toMatchObject({
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: OPENCODE_GO_COMPLETIONS_BASE_URL,
      apiKey: 'go-key',
    });
  });

  it('returns isolated catalog copies', () => {
    const first = buildOpenCodeGoModels();
    first[0]!.name = 'mutated';
    expect(buildOpenCodeGoModels()[0]!.name).not.toBe('mutated');
  });
});

describe('verifyOpenCodeGoCredential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const authError = '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}';
  const modelError = '{"type":"error","error":{"type":"ModelError","message":"Model {{model}} is not supported"}}';

  it('rejects a key the upstream answers with an auth-shaped 401, probing with a catalog model', async () => {
    const fetchMock = vi.fn(async () => new Response(authError, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await verifyOpenCodeGoCredential('bad-key', OPENCODE_GO_COMPLETIONS_BASE_URL);
    expect(error).toContain('authentication failed');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${OPENCODE_GO_COMPLETIONS_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bad-key');
    // The gateway resolves the model BEFORE the key, so the probe must name a
    // committed catalog model or every key looks rejected.
    const body = JSON.parse(String(init.body)) as { model?: string };
    const catalogIds = buildOpenCodeGoModels()
      .filter(entry => entry.modelFormat === 'openai')
      .map(entry => entry.upstreamModelId ?? entry.id);
    expect(catalogIds).toContain(body.model);
  });

  it('rejects an auth-shaped 403 as well', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(authError, { status: 403 })));
    expect(await verifyOpenCodeGoCredential('bad-key', OPENCODE_GO_COMPLETIONS_BASE_URL)).not.toBeNull();
  });

  it('treats a 401 ModelError as inconclusive, never a key rejection', async () => {
    // Live behavior that broke the original empty-body probe: the gateway
    // returns 401 ModelError for an unsupported model REGARDLESS of the key.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(modelError, { status: 401 })));
    expect(await verifyOpenCodeGoCredential('good-key', OPENCODE_GO_COMPLETIONS_BASE_URL)).toBeNull();
  });

  it('treats an unparseable 401 as inconclusive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 401 })));
    expect(await verifyOpenCodeGoCredential('good-key', OPENCODE_GO_COMPLETIONS_BASE_URL)).toBeNull();
  });

  it('accepts a key whose probe fails ordinary request validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"messages required"}', { status: 400 })));
    expect(await verifyOpenCodeGoCredential('good-key', OPENCODE_GO_COMPLETIONS_BASE_URL)).toBeNull();
  });

  it('treats an unreachable upstream as inconclusive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await verifyOpenCodeGoCredential('any-key', OPENCODE_GO_COMPLETIONS_BASE_URL)).toBeNull();
  });

  it('is wired on the template so the add flow probes before persisting', () => {
    expect(getTemplateById('opencode-go')?.verifyCredential).toBe(verifyOpenCodeGoCredential);
  });

  it('bounds the probe on the shared deadline so a stalled upstream cannot hang the CLI', async () => {
    // This is the first thing a user hits after pasting a key, under a
    // spinner: without a deadline an upstream that accepts and then never
    // answers leaves no exit but Ctrl-C. Asserted on the deadline itself
    // rather than by waiting one out — fake timers do not reach
    // AbortSignal.timeout's internal timer, and a real 10s wait in the suite
    // is exactly the kind of cost this test exists to prevent.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const seen: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init.signal);
      return new Response('{}', { status: 400 });
    }));

    try {
      await verifyOpenCodeGoCredential('any-key', OPENCODE_GO_COMPLETIONS_BASE_URL);
      expect(timeoutSpy).toHaveBeenCalledWith(TEST_TIMEOUT_MS);
      expect(seen[0], 'probe must carry the deadline signal').toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('treats an aborted probe as inconclusive rather than a bad key', async () => {
    // The other half of the deadline contract: hitting it must not reject the
    // credential, or a stalled network would look like a wrong key.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'TimeoutError' });
    }));
    expect(await verifyOpenCodeGoCredential('good-key', OPENCODE_GO_COMPLETIONS_BASE_URL)).toBeNull();
  });

  it('does not read an entitlement rejection as a bad key', async () => {
    // The probe names ONE fixed model. If that model is ever plan-gated, a
    // perfectly good key answers 403 here — and an unanchored /auth/i matches
    // inside "Unauthorized", rejecting the key at add time for a plan problem.
    const entitlement = '{"error":{"type":"UnauthorizedModelError","message":"Your plan does not include deepseek-v4-flash."}}';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(entitlement, { status: 403 })));
    expect(await verifyOpenCodeGoCredential('good-key', OPENCODE_GO_COMPLETIONS_BASE_URL)).toBeNull();
  });

  it('still rejects the key when upstream names the key itself', async () => {
    // The other half: anchoring must not blunt the real case.
    for (const body of [
      '{"error":{"type":"authentication_error","message":"nope"}}',
      '{"error":{"type":"ServerError","message":"Invalid API key provided."}}',
      '{"error":{"type":"ServerError","message":"The API key is expired."}}',
      '{"error":{"type":"ServerError","message":"Authentication failed."}}',
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 401 })));
      expect(await verifyOpenCodeGoCredential('bad-key', OPENCODE_GO_COMPLETIONS_BASE_URL), body)
        .toContain('authentication failed');
    }
  });
});
