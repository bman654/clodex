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
import { reportPricingBoundaryCrossing, resetPricingBoundaryWarnings } from '../src/pricing-boundary.js';
import { getTemplateById, verifyOpenCodeGoCredential } from '../src/provider-templates.js';
import { createLanguageModel, effortProviderOptions, getPatchReasoningCapabilities } from '../src/provider-factory.js';
import { transformOpenAiCompatibleRequestBody } from '../src/model-runtime-compatibility.js';
import { projectNativeEffort } from '../src/patch-transforms.js';
import { applyTemplateModelMetadata } from '../src/registry/fetch-template-models.js';
import {
  cachedModelToLocal,
  materializeRegistry,
  projectProviderCachedModels,
} from '../src/registry/materialize.js';
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
   * The exact literals below — the total, the format split, and
   * gpt-5.6-luna's precise cost — are deliberate tripwires, not incidental
   * assertions. The catalog is generated, so a regeneration that silently
   * adds, drops, or reprices a model should FAIL here and be re-read by a
   * human rather than shipped. If you are here after `npm run
   * update:opencode-go`, the right move is to check the diff and update these
   * numbers on purpose — not to loosen them.
   */
  it('records its OpenCode catalog source and admits only verified Responses-only models', () => {
    const models = buildOpenCodeGoModels();
    const ids = models.map(model => model.id);

    expect(OPENCODE_GO_SOURCE).toBe('https://models.dev/api.json');
    expect(new Date(OPENCODE_GO_SOURCE_FETCHED_AT).toISOString()).toBe(OPENCODE_GO_SOURCE_FETCHED_AT);
    expect(models).toHaveLength(20);
    expect(new Set(ids).size).toBe(models.length);
    expect(ids).not.toContain('grok-4.5');
    expect(new Set(models.map(model => model.modelFormat))).toEqual(new Set(['anthropic', 'openai']));
    expect(models.filter(model => model.modelFormat === 'anthropic')).toHaveLength(4);
    expect(models.filter(model => model.modelFormat === 'openai')).toHaveLength(16);
    expect(models.filter(model => model.npm === '@ai-sdk/openai').map(model => model.id).sort())
      .toEqual(['gpt-6-luna', 'muse-spark-1.2-contributor', 'muse-spark-1.3-contributor']);
    // clodex sends graded effort only for recognised OpenAI/Codex families, so
    // advertising a control here would promise one that never reaches the wire.
    for (const id of ['muse-spark-1.2-contributor', 'muse-spark-1.3-contributor']) {
      expect(models.find(model => model.id === id)?.compatibility?.supportsReasoningEffort)
        .toBe(false);
    }
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
    // 2026-09-11 feed: the "(2x usage)" promotional pricing ended; list price doubled.
    expect(byId.get('gpt-5.6-luna')?.cost).toEqual({
      input: 0.2,
      output: 1.2,
      cache_read: 0.02,
      cache_write: 0.25,
    });
    expect(byId.get('gpt-6-luna')).toMatchObject({
      contextWindow: 1_050_000,
      pricingBoundary: 272_000,
      modalities: ['text', 'image'],
      compatibility: { reasoningEffortMap: {
        none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
      } },
      cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
    });
    // OpenCode's Go docs list V4.1 Flash on Chat Completions, and its Messages
    // route was reported failing every request with 422 (#308). Apart from its
    // name and image input, it is V4 Flash's entry.
    expect(byId.get('deepseek-v4.1-flash')).toEqual({
      ...byId.get('deepseek-v4-flash'),
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      upstreamModelId: 'deepseek-v4.1-flash',
      modalities: ['text', 'image'],
    });
    expect(byId.get('deepseek-v4.1-flash')).toMatchObject({
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      apiUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
      contextWindow: 1_000_000,
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
      name: 'DeepSeek V4 Pro (New)',
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

  it('projects both retained identities onto curated mixed-protocol authority', () => {
    const cached = [
      liveModel('qwen3.8-max'),
      liveModel('deepseek-v4-pro'),
      liveModel('grok-4.5'),
      liveModel('unknown-future-model'),
    ];
    const providers = [
      {
        id: 'opencode-go',
        templateId: 'opencode-go',
      },
      {
        id: 'imported-opencode',
        templateId: 'opencode-go',
      },
    ];

    for (const identity of providers) {
      const projected = projectProviderCachedModels({
        ...identity,
        name: 'OpenCode Go',
        enabled: true,
        authRef: `keyring:provider:${identity.id}`,
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
        modelsCache: { fetchedAt: '2026-08-12T00:00:00.000Z', models: cached },
        addedAt: '2026-08-12T00:00:00.000Z',
      });

      expect(projected.map(model => model.id)).toEqual(['qwen3.8-max', 'deepseek-v4-pro']);
      expect(projected[0]).toMatchObject({
        modelFormat: 'anthropic',
        npm: '@ai-sdk/anthropic',
        apiUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
        contextWindow: 1_000_000,
      });
      expect(projected[1]).toMatchObject({
        modelFormat: 'openai',
        npm: '@ai-sdk/openai-compatible',
        apiUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
        contextWindow: 1_000_000,
      });
    }
  });

  it('fails closed for unknown-only retained caches without a provider or route', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'imported-opencode',
        templateId: 'opencode-go',
        name: 'Imported OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:imported-opencode',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [liveModel('unknown-future-model')],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }],
    };

    expect(projectProviderCachedModels(registry.providers[0]!)).toEqual([]);
    const providers = materializeRegistry(registry, () => 'go-key');
    expect(providers).toEqual([]);
    expect(buildHttpProxyRoutes(providers, [
      { providerId: 'imported-opencode', modelId: 'unknown-future-model' },
    ]).routes).toEqual([]);
  });

  it('leaves ordinary custom cached models unchanged', () => {
    const cached = [liveModel('unknown-custom-model')];
    const provider: RegistryProvider = {
      id: 'custom-provider',
      templateId: 'custom-openai',
      name: 'Custom provider',
      enabled: true,
      authRef: 'keyring:provider:custom-provider',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://custom.invalid/v1' },
      modelsCache: { fetchedAt: '2026-08-12T00:00:00.000Z', models: cached },
      addedAt: '2026-08-12T00:00:00.000Z',
    };

    expect(projectProviderCachedModels(provider)).toBe(cached);
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
    const error = await verifyOpenCodeGoCredential('bad-key');
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
    expect(await verifyOpenCodeGoCredential('bad-key')).not.toBeNull();
  });

  it('treats a 403 authorization_error as inconclusive', async () => {
    const authorizationError = '{"error":{"type":"authorization_error","message":"Authorization failed."}}';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(authorizationError, { status: 403 })));
    expect(await verifyOpenCodeGoCredential('good-key')).toBeNull();
  });

  it('treats a 401 ModelError as inconclusive, never a key rejection', async () => {
    // Live behavior that broke the original empty-body probe: the gateway
    // returns 401 ModelError for an unsupported model REGARDLESS of the key.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(modelError, { status: 401 })));
    expect(await verifyOpenCodeGoCredential('good-key')).toBeNull();
  });

  it('treats an unparseable 401 as inconclusive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 401 })));
    expect(await verifyOpenCodeGoCredential('good-key')).toBeNull();
  });

  it('accepts a key whose probe fails ordinary request validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"messages required"}', { status: 400 })));
    expect(await verifyOpenCodeGoCredential('good-key')).toBeNull();
  });

  it('treats an unreachable upstream as inconclusive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await verifyOpenCodeGoCredential('any-key')).toBeNull();
  });

  it('is wired on the template so the add flow probes before persisting', () => {
    expect(getTemplateById('opencode-go')?.verifyCredential).toBe(verifyOpenCodeGoCredential);
  });

  it('sends the credential only to the reviewed literal endpoint', async () => {
    // PO2. Asserted against the spelled-out address rather than the constant:
    // comparing the constant with itself would still pass if the constant were
    // repointed, and this probe carries a live API key.
    const fetchMock = vi.fn(async () => new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    await verifyOpenCodeGoCredential('live-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });

  it('takes no argument that could redirect the probe', () => {
    // The destination is structurally template-bound: the function accepts the
    // key and nothing else, so no caller — CLI flag, import, or config — can
    // point a live credential somewhere the template never declared.
    expect(verifyOpenCodeGoCredential).toHaveLength(1);
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
      await verifyOpenCodeGoCredential('any-key');
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
    expect(await verifyOpenCodeGoCredential('good-key')).toBeNull();
  });

  it('does not read an entitlement rejection as a bad key', async () => {
    // The probe names ONE fixed model. If that model is ever plan-gated, a
    // perfectly good key answers 403 here — and an unanchored /auth/i matches
    // inside "Unauthorized", rejecting the key at add time for a plan problem.
    const entitlement = '{"error":{"type":"UnauthorizedModelError","message":"Your plan does not include deepseek-v4-flash."}}';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(entitlement, { status: 403 })));
    expect(await verifyOpenCodeGoCredential('good-key')).toBeNull();
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
      expect(await verifyOpenCodeGoCredential('bad-key'), body)
        .toContain('authentication failed');
    }
  });
});

describe('qwen3.6-plus reasoning toggle', () => {
  const model = buildOpenCodeGoModels().find(entry => entry.id === 'qwen3.6-plus')!;
  const meta = {
    reasoning: model.reasoning,
    compatibility: model.compatibility,
    providerId: 'opencode-go',
  };

  it('turns thinking on for every selectable level, max included', () => {
    // Qwen accepts no reasoning_effort — `thinkingFormat: 'qwen'` injects the
    // boolean `enable_thinking` and only does so when an effort is PRESENT, so
    // the effort value is an internal signal rather than a wire control.
    // Before the map, mapCodexEffortToOpenAI dropped `max` along with `off`
    // and `minimal`, so choosing MAX silently disabled thinking while `low`
    // enabled it — backwards, and invisible.
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const options = effortProviderOptions(model.npm!, level, model.id, meta as never) as
        Record<string, Record<string, unknown>> | undefined;
      const effort = options?.opencodeGo?.reasoningEffort as string | undefined;
      expect(effort, level).toBeTruthy();
      const body = transformOpenAiCompatibleRequestBody(
        { model: model.id, reasoning_effort: effort },
        model.compatibility,
      ) as Record<string, unknown>;
      expect(body.enable_thinking, level).toBe(true);
    }
  });

  it('leaves thinking off when the user asks for off', () => {
    const options = effortProviderOptions(model.npm!, 'off', model.id, meta as never);
    expect(options).toBeUndefined();
    const body = transformOpenAiCompatibleRequestBody(
      { model: model.id },
      model.compatibility,
    ) as Record<string, unknown>;
    expect(body.enable_thinking).toBeUndefined();
  });

  it('keeps a capability the patcher will actually accept', () => {
    // The grades are cosmetic while the upstream control is a boolean, so
    // collapsing them to one level is tempting — but getPatchReasoningCapabilities
    // dedups identical provider options, and projectNativeEffort DISCARDS any
    // capability missing low/medium/high. A one-level capability therefore
    // leaves a patched client with no effort control at all, which is worse
    // than cosmetic grades.
    const patch = getPatchReasoningCapabilities(model.npm!, model.id, meta as never);
    expect(patch.levels).toContain(patch.defaultLevel);
    for (const base of ['low', 'medium', 'high']) expect(patch.levels).toContain(base);
    expect(projectNativeEffort({ levels: patch.levels, defaultLevel: patch.defaultLevel! }))
      .toBeTruthy();
  });
});

describe('OpenCode Go Responses-only models', () => {
  it('warns when a Go Luna request exceeds the published pricing boundary', () => {
    const provider = {
      id: 'opencode-go', templateId: 'opencode-go', name: 'OpenCode Go', enabled: true,
      authRef: 'keyring:provider:opencode-go', authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
      modelsCache: { fetchedAt: '2026-09-29T00:00:00.000Z', models: [liveModel('gpt-6-luna')] },
      addedAt: '2026-09-29T00:00:00.000Z',
    } as Parameters<typeof projectProviderCachedModels>[0];
    const projected = projectProviderCachedModels(provider)[0]!;
    const local = cachedModelToLocal(projected, provider)!;
    expect(local.pricingBoundary).toBe(272_000);
    expect(projected.pricingBoundaryNote).toContain('OpenCode Go');

    const messages: string[] = [];
    const emit = (message: string) => messages.push(message);
    resetPricingBoundaryWarnings();
    try {
      const observation = {
        modelKey: 'opencode-go:gpt-6-luna', modelLabel: 'GPT-6 Luna',
        pricingBoundary: local.pricingBoundary,
      };
      expect(reportPricingBoundaryCrossing({ ...observation, inputTokens: 272_000 }, emit)).toBe(false);
      expect(reportPricingBoundaryCrossing({ ...observation, inputTokens: 300_000 }, emit)).toBe(true);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('272,000-token pricing boundary');
    } finally {
      resetPricingBoundaryWarnings();
    }
  });

  it('sends GPT-6 Luna to Go Responses with the chosen effort', async () => {
    const luna = buildOpenCodeGoModels().find(model => model.id === 'gpt-6-luna')!;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({
        id: 'resp_luna', model: 'gpt-6-luna', output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    try {
      const model = await createLanguageModel({
        npm: luna.npm!, modelId: luna.upstreamModelId!, apiKey: 'test-key',
        baseURL: luna.apiUrl, providerId: 'opencode-go', authType: 'api',
      });
      for (const level of ['high', 'none']) {
        await model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          providerOptions: effortProviderOptions(luna.npm!, level, luna.id, {
            providerId: 'opencode-go', reasoning: luna.reasoning, compatibility: luna.compatibility,
          }) as never,
        } as never);
      }
      expect(requests.map(request => request.url)).toEqual([
        'https://opencode.ai/zen/go/v1/responses',
        'https://opencode.ai/zen/go/v1/responses',
      ]);
      expect(requests.map(request => request.body.model)).toEqual(['gpt-6-luna', 'gpt-6-luna']);
      expect(requests.map(request => request.body.reasoning)).toEqual([
        expect.objectContaining({ effort: 'high' }),
        expect.objectContaining({ effort: 'none' }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pins a catalog model on the Responses package to the Go /v1 base, but not the provider record', async () => {
    const { openCodeGoPinnedApiUrl, openCodeGoPinnedModelApiUrl } = await import('../src/registry/resolve-template.js');
    expect(openCodeGoPinnedModelApiUrl('@ai-sdk/openai')).toBe(OPENCODE_GO_COMPLETIONS_BASE_URL);
    expect(openCodeGoPinnedModelApiUrl('@ai-sdk/xai')).toBeNull();
    // Discovery and refresh key on the provider record, which still may not name it.
    expect(openCodeGoPinnedApiUrl('@ai-sdk/openai')).toBeNull();
  });

  it('materializes Muse Spark with the Go /v1 base as its SDK base URL', async () => {
    const { cachedModelToLocal } = await import('../src/registry/materialize.js');
    const muse = buildOpenCodeGoModels().find(model => model.id === 'muse-spark-1.3-contributor')!;
    const provider = {
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
    } as unknown as Parameters<typeof cachedModelToLocal>[1];
    const local = cachedModelToLocal(muse as CachedModel, provider);
    expect(local).not.toBeNull();
    expect(local!.npm).toBe('@ai-sdk/openai');
    expect(local!.apiBaseUrl).toBe(OPENCODE_GO_COMPLETIONS_BASE_URL);
  });

  it('catalogs Muse Spark on the Responses package at the Go /v1 base', () => {
    const muse = buildOpenCodeGoModels().filter(model => model.id.startsWith('muse-spark-'));
    expect(muse.map(model => model.id).sort()).toEqual(['muse-spark-1.2-contributor', 'muse-spark-1.3-contributor']);
    for (const model of muse) {
      expect(model.modelFormat, model.id).toBe('openai');
      expect(model.npm, model.id).toBe('@ai-sdk/openai');
      expect(model.apiUrl, model.id).toBe(OPENCODE_GO_COMPLETIONS_BASE_URL);
    }
  });
});
