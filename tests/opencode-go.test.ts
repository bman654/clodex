import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOpenCodeGoModels,
  OPENCODE_GO_ANTHROPIC_BASE_URL,
  OPENCODE_GO_COMPLETIONS_BASE_URL,
  OPENCODE_GO_RESPONSES_MODEL_IDS,
  OPENCODE_GO_SOURCE,
  OPENCODE_GO_SOURCE_ASSET_SHA256,
  OPENCODE_GO_SOURCE_FETCHED_AT,
  OPENCODE_GO_SOURCE_MODELS_SHA256,
  OPENCODE_GO_SOURCE_RELEASE_COMMIT,
  OPENCODE_GO_SOURCE_VERSION,
  effectiveProviderCachedModels,
  quarantinedOpenCodeGoModelTargets,
} from '../src/data/opencode-go-models.js';
import { TEST_TIMEOUT_MS } from '../src/constants.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import { getTemplateById, verifyOpenCodeGoCredential } from '../src/provider-templates.js';
import { applyTemplateModelMetadata } from '../src/registry/fetch-template-models.js';
import { materializeRegistry } from '../src/registry/materialize.js';
import type { CachedModel, ProviderRegistry } from '../src/registry/types.js';
import { invalidateModelsDevCache } from '../src/registry/models-dev.js';
import { effortProviderOptions, getReasoningCapabilities } from '../src/provider-factory.js';
import { enrichServerModelReasoning } from '../src/server/index.js';

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
   * The exact literals below — the total, the 6/10 format split, and source
   * hashes — are deliberate tripwires, not incidental
   * assertions. The catalog is generated, so a regeneration that silently
   * adds, drops, or reprices a model should FAIL here and be re-read by a
   * human rather than shipped. If you are here after `npm run
   * update:opencode-go`, the right move is to check the diff and update these
   * numbers on purpose — not to loosen them.
   */
  it('records its OpenCode catalog source and excludes Responses-only models', () => {
    const models = buildOpenCodeGoModels();
    const ids = models.map(model => model.id);

    expect(OPENCODE_GO_SOURCE).toBe('opencode --pure models opencode-go --verbose');
    expect(OPENCODE_GO_SOURCE_VERSION).toBe('1.18.15');
    expect(OPENCODE_GO_SOURCE_RELEASE_COMMIT).toBe('d7b115f623760e68a4749d16508a9eca350f246f');
    expect(OPENCODE_GO_SOURCE_ASSET_SHA256).toBe('bd60b57cb9fe0494a5352c807424d36d6d7853cf6dbddb97065c7ccd3c5d391c');
    expect(OPENCODE_GO_SOURCE_MODELS_SHA256).toBe('fa41e01da5fe41fb08e75b37adf1c5404902489c4dc76d390e5209f555897cb4');
    expect(new Date(OPENCODE_GO_SOURCE_FETCHED_AT).toISOString()).toBe('2026-08-09T17:47:18.000Z');
    expect(OPENCODE_GO_RESPONSES_MODEL_IDS).toEqual(['gpt-5.6-luna', 'grok-4.5']);
    expect(models).toHaveLength(16);
    expect(new Set(ids).size).toBe(models.length);
    expect(ids).not.toContain('grok-4.5');
    expect(ids).not.toContain('gpt-5.6-luna');
    expect(new Set(models.map(model => model.modelFormat))).toEqual(new Set(['anthropic', 'openai']));
    expect(models.filter(model => model.modelFormat === 'anthropic')).toHaveLength(6);
    expect(models.filter(model => model.modelFormat === 'openai')).toHaveLength(10);
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
          high: 'high',
          max: 'max',
        },
        maxTokensField: 'max_tokens',
      },
    });
    expect(byId.get('qwen3.6-plus')).toMatchObject({
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      compatibility: { supportsReasoningEffort: false, supportsCountTokens: false },
    });
    expect(byId.get('minimax-m2.7')?.modelFormat).toBe('anthropic');
    expect(byId.get('kimi-k2.6')?.compatibility?.supportsReasoningEffort).toBe(false);
    expect(byId.get('kimi-k2.7-code')?.compatibility?.supportsTemperature).toBe(false);
    expect(byId.get('kimi-k3')?.compatibility?.supportsTemperature).toBe(false);
    expect(byId.get('deepseek-v4-pro')?.compatibility?.supportsTemperature).toBeUndefined();
  });

  it('keeps CLI effort variants opt-in instead of inventing sparse defaults', () => {
    const byId = new Map(buildOpenCodeGoModels().map(model => [model.id, model]));
    for (const [id, levels] of [
      ['kimi-k3', ['max']],
      ['hy3', ['off', 'low', 'high']],
    ] as const) {
      const model = byId.get(id)!;
      const metadata = {
        providerId: 'opencode-go',
        reasoning: model.reasoning,
        compatibility: model.compatibility,
      };
      expect(getReasoningCapabilities(model.npm!, id, metadata)).toMatchObject({
        levels: [...levels],
        defaultLevel: '',
        mode: 'controllable',
      });
      expect(effortProviderOptions(model.npm!, undefined, id, metadata)).toBeUndefined();
      expect(enrichServerModelReasoning({
        id,
        name: model.name,
        isFree: false,
        brand: model.brand ?? 'OpenCode',
        sourceBackend: 'opencode-go',
        providerId: 'opencode-go',
        modelFormat: 'openai',
        npm: model.npm,
        reasoning: model.reasoning,
        compatibility: model.compatibility,
      }).defaultEffort).toBeUndefined();
    }

    const kimi = byId.get('kimi-k3')!;
    expect(effortProviderOptions(kimi.npm!, 'max', kimi.id, {
      providerId: 'opencode-go',
      reasoning: kimi.reasoning,
      compatibility: kimi.compatibility,
    })).toEqual({ opencodeGo: { reasoningEffort: 'max' } });
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

  it('corrects an existing built-in cache before runtime materialization', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [
            liveModel('qwen3.6-plus'),
            { ...liveModel('qwen3.6-plus'), name: 'duplicate qwen' },
            liveModel('gpt-5.6-luna'),
          ],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    const [provider] = materializeRegistry(registry, () => 'go-key');
    expect(provider?.models.map(model => model.id)).toEqual(['qwen3.6-plus']);
    expect(provider?.models[0]).toMatchObject({
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
    });
  });

  it('uses live cache rows only for membership and removes stale optional metadata', () => {
    const provider: ProviderRegistry['providers'][number] = {
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
      modelsCache: {
        fetchedAt: '2026-08-08T00:00:00.000Z',
        models: [{
          ...liveModel('hy3'),
          brand: 'stale-brand',
          supportedParameters: ['stale_parameter'],
          interleavedReasoningField: 'stale_reasoning',
          useResponsesLite: true,
          preferWebSockets: true,
          isFree: true,
          freeStatus: 'verified_free',
        }],
      },
      addedAt: '2026-08-08T00:00:00.000Z',
    };

    expect(effectiveProviderCachedModels(provider)).toEqual([
      expect.objectContaining({
        id: 'hy3',
        codingCapabilitiesAuthoritative: true,
      }),
    ]);
    const [effective] = effectiveProviderCachedModels(provider);
    expect(effective).not.toHaveProperty('brand');
    expect(effective).not.toHaveProperty('supportedParameters');
    expect(effective).not.toHaveProperty('interleavedReasoningField');
    expect(effective).not.toHaveProperty('useResponsesLite');
    expect(effective).not.toHaveProperty('preferWebSockets');
    expect(effective).not.toHaveProperty('isFree');
    expect(effective).not.toHaveProperty('freeStatus');
  });

  it('drops stale official rows after the provider changes to a custom endpoint', () => {
    const staleOfficial = buildOpenCodeGoModels().find(model => model.id === 'qwen3.6-plus');
    if (!staleOfficial) throw new Error('missing qwen3.6-plus fixture');
    staleOfficial.name = 'stale official name';
    staleOfficial.contextWindow = 1_000_000;
    staleOfficial.cost = { input: 999, output: 999 };
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Custom OpenCode-compatible endpoint',
        enabled: true,
        authRef: 'keyring:provider:custom',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [staleOfficial as CachedModel],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    expect(materializeRegistry(registry, () => 'custom-key')).toEqual([]);
    expect(effectiveProviderCachedModels(registry.providers[0]!)).toEqual([]);
  });

  it.each([
    ['uppercase official host', 'https://OPENCODE.AI/zen/go'],
    ['default-port official host', 'https://opencode.ai:443/zen/go/v1'],
    ['alternate official path', 'https://opencode.ai/some/older/resolver/path'],
  ])('quarantines a non-canonical stale official row after a custom-endpoint transition (%s)', (
    _label,
    staleApiUrl,
  ) => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Custom OpenCode-compatible endpoint',
        enabled: true,
        authRef: 'keyring:provider:custom',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            ...liveModel('qwen3.6-plus'),
            name: 'Stale official metadata',
            contextWindow: 1_000_000,
            apiUrl: staleApiUrl,
            codingCapabilitiesAuthoritative: true,
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    expect(effectiveProviderCachedModels(registry.providers[0]!)).toEqual([]);
    expect(materializeRegistry(registry, () => 'custom-key')).toEqual([]);
  });

  it('routes neutral custom-discovery rows only to the configured custom endpoint', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Custom OpenCode-compatible endpoint',
        enabled: true,
        authRef: 'keyring:provider:custom',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            ...liveModel('custom-model'),
            reasoning: true,
            modalities: ['text', 'image'],
            compatibility: { supportsTemperature: false },
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    const [provider] = materializeRegistry(registry, () => 'custom-key');
    expect(provider?.models[0]).toMatchObject({
      id: 'custom-model',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      apiBaseUrl: 'https://example.test/v1',
      completionsUrl: 'https://example.test/v1/chat/completions',
      reasoning: true,
      modalities: ['text', 'image'],
      compatibility: { supportsTemperature: false },
    });
    expect(provider?.models[0]?.codingCapabilitiesAuthoritative).toBeUndefined();
    expect(provider?.models[0]?.ignoreModelsDevCapabilities).toBe(true);
  });

  it('does not quarantine a custom-routed row merely because its capabilities are authoritative', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Custom authoritative endpoint',
        enabled: true,
        authRef: 'keyring:provider:custom-authoritative',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            ...liveModel('custom-authoritative-model'),
            apiUrl: 'https://example.test/v1',
            codingCapabilitiesAuthoritative: true,
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    expect(effectiveProviderCachedModels(registry.providers[0]!)).toEqual([
      expect.objectContaining({
        id: 'custom-authoritative-model',
        apiUrl: 'https://example.test/v1',
        codingCapabilitiesAuthoritative: true,
      }),
    ]);
    expect(materializeRegistry(registry, () => 'custom-key')[0]?.models[0]).toMatchObject({
      id: 'custom-authoritative-model',
      apiBaseUrl: 'https://example.test/v1',
      completionsUrl: 'https://example.test/v1/chat/completions',
    });
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
  ])('treats a partial OpenCode identity as a custom security boundary ($label)', ({
    id,
    templateId,
  }) => {
    const staleOfficial = buildOpenCodeGoModels().find(model => model.id === 'qwen3.6-plus');
    if (!staleOfficial) throw new Error('missing qwen3.6-plus fixture');
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id,
        templateId,
        name: 'Partial OpenCode identity',
        enabled: true,
        authRef: `keyring:provider:${id}`,
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [
            staleOfficial as CachedModel,
            {
              ...liveModel('custom-model'),
              apiUrl: 'https://example.test/v1',
            },
          ],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };
    const provider = registry.providers[0]!;

    expect(effectiveProviderCachedModels(provider).map(model => model.id)).toEqual(['custom-model']);
    expect(quarantinedOpenCodeGoModelTargets(provider)).toEqual(
      new Set([`${id}:qwen3.6-plus`]),
    );
    expect(materializeRegistry(registry, () => 'custom-key')[0]?.models[0]).toMatchObject({
      id: 'custom-model',
      apiBaseUrl: 'https://example.test/v1',
      completionsUrl: 'https://example.test/v1/chat/completions',
      ignoreModelsDevCapabilities: true,
    });
  });

  it.each([
    ['uppercase host', 'https://OPENCODE.AI/zen/go/v1'],
    ['default port', 'https://opencode.ai:443/zen/go/v1'],
    ['dot segment', 'https://opencode.ai/zen/./go/v1'],
    ['encoded path', 'https://opencode.ai/%7Aen/go/%76%31'],
    ['encoded separator', 'https://opencode.ai/zen%2Fgo/v1'],
    ['trailing-dot host and alternate path', 'https://opencode.ai./some/other/path'],
    ['userinfo and query', 'https://user:secret@opencode.ai/zen/go/v1?source=custom#fragment'],
    ['plaintext scheme', 'http://opencode.ai/zen/go/v1'],
  ])('fails closed for a partial identity using an official-equivalent URL (%s)', (
    _label,
    url,
  ) => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'legacy-unmapped-template',
        name: 'Partial OpenCode identity',
        enabled: true,
        authRef: 'keyring:provider:partial',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [liveModel('custom-model')],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    expect(effectiveProviderCachedModels(registry.providers[0]!)).toEqual([]);
    expect(materializeRegistry(registry, () => 'partial-key')).toEqual([]);
  });

  it('preserves a neutral cached Anthropic transport when a custom provider omits npm', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Custom Anthropic-compatible endpoint',
        enabled: true,
        authRef: 'keyring:provider:custom-anthropic',
        authType: 'api',
        api: { url: 'https://example.test/anthropic' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            ...liveModel('custom-anthropic-model'),
            npm: '@ai-sdk/anthropic',
            modelFormat: 'anthropic',
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    const [provider] = materializeRegistry(registry, () => 'custom-key');
    expect(provider?.models[0]).toMatchObject({
      id: 'custom-anthropic-model',
      npm: '@ai-sdk/anthropic',
      modelFormat: 'anthropic',
      baseUrl: 'https://example.test/anthropic',
      ignoreModelsDevCapabilities: true,
    });
    expect(provider?.models[0]?.completionsUrl).toBeUndefined();
  });

  it('fails closed when the provider URL is missing but a cached row points at a custom endpoint', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Damaged custom endpoint',
        enabled: true,
        authRef: 'keyring:provider:custom',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            ...liveModel('custom-model'),
            apiUrl: 'https://custom.example.test/v1',
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    expect(effectiveProviderCachedModels(registry.providers[0]!)).toEqual([]);
    expect(materializeRegistry(registry, () => 'custom-key')).toEqual([]);
  });

  it('does not let an authority bit override a custom cached URL when the provider URL is missing', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Conflicting OpenCode slot',
        enabled: true,
        authRef: 'keyring:provider:conflicting',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            ...liveModel('qwen3.6-plus'),
            apiUrl: 'https://custom.example.test/v1',
            codingCapabilitiesAuthoritative: true,
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    expect(effectiveProviderCachedModels(registry.providers[0]!)).toEqual([]);
    expect(materializeRegistry(registry, () => 'conflicting-key')).toEqual([]);
  });

  it('does not treat a generic authority bit without an exact API URL as official provenance', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Authority-only OpenCode slot',
        enabled: true,
        authRef: 'keyring:provider:authority-only',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [{
            ...liveModel('qwen3.6-plus'),
            codingCapabilitiesAuthoritative: true,
          }],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    expect(effectiveProviderCachedModels(registry.providers[0]!)).toEqual([]);
    expect(materializeRegistry(registry, () => 'authority-only-key')).toEqual([]);
  });

  it('fails closed when both provider and neutral cached rows lack an API URL', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'Ambiguous OpenCode slot',
        enabled: true,
        authRef: 'keyring:provider:ambiguous',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible' },
        modelsCache: {
          fetchedAt: '2026-08-08T00:00:00.000Z',
          models: [liveModel('qwen3.6-plus')],
        },
        addedAt: '2026-08-08T00:00:00.000Z',
      }],
    };

    expect(effectiveProviderCachedModels(registry.providers[0]!)).toEqual([]);
    expect(materializeRegistry(registry, () => 'ambiguous-key')).toEqual([]);
  });

  it('trusts committed CLI capabilities over a contradictory user models.dev cache only for official rows', () => {
    const previousHome = process.env.CLODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), 'clodex-opencode-authority-'));
    process.env.CLODEX_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'models-dev-cache.json'), JSON.stringify({
      'opencode-go': {
        models: {
          'qwen3.6-plus': {
            tool_call: false,
            reasoning: false,
            interleaved: { field: 'untrusted_reasoning' },
            modalities: { output: ['audio'] },
          },
        },
      },
      'custom-go': {
        models: {
          'qwen3.6-plus': {
            tool_call: false,
            modalities: { output: ['audio'] },
          },
        },
      },
    }));
    invalidateModelsDevCache();

    try {
      const registry: ProviderRegistry = {
        schemaVersion: 1,
        providers: [
          {
            id: 'opencode-go',
            templateId: 'opencode-go',
            name: 'OpenCode Go',
            enabled: true,
            authRef: 'keyring:provider:opencode-go',
            authType: 'api',
            api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
            modelsCache: {
              fetchedAt: '2026-08-08T00:00:00.000Z',
              models: [liveModel('qwen3.6-plus')],
            },
            addedAt: '2026-08-08T00:00:00.000Z',
          },
          {
            id: 'custom-go',
            templateId: 'custom-openai',
            name: 'Custom endpoint',
            enabled: true,
            authRef: 'keyring:provider:custom-go',
            authType: 'api',
            api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
            modelsCache: {
              fetchedAt: '2026-08-08T00:00:00.000Z',
              models: [liveModel('qwen3.6-plus')],
            },
            addedAt: '2026-08-08T00:00:00.000Z',
          },
        ],
      };

      const providers = materializeRegistry(registry, () => 'key', { agent: 'claude' });
      expect(providers.map(provider => provider.id)).toEqual(['opencode-go']);
      expect(providers[0]?.models[0]).toMatchObject({
        id: 'qwen3.6-plus',
        reasoning: true,
        codingCapabilitiesAuthoritative: true,
      });
      expect(providers[0]?.models[0]?.interleavedReasoningField).toBeUndefined();
      expect(buildHttpProxyRoutes(providers, [
        { providerId: 'opencode-go', modelId: 'qwen3.6-plus' },
      ]).routes).toHaveLength(1);

      const customIdentity: ProviderRegistry = {
        schemaVersion: 1,
        providers: [{
          id: 'opencode-go',
          templateId: 'opencode-go',
          name: 'Custom endpoint using the built-in slot',
          enabled: true,
          authRef: 'keyring:provider:custom-opencode',
          authType: 'api',
          api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
          modelsCache: {
            fetchedAt: '2026-08-08T00:00:00.000Z',
            models: [{
              ...liveModel('qwen3.6-plus'),
              reasoning: true,
            }],
          },
          addedAt: '2026-08-08T00:00:00.000Z',
        }],
      };
      const [customProvider] = materializeRegistry(customIdentity, () => 'custom-key', {
        agent: 'claude',
      });
      expect(customProvider?.models[0]).toMatchObject({
        id: 'qwen3.6-plus',
        reasoning: true,
        ignoreModelsDevCapabilities: true,
      });
      expect(customProvider?.models[0]?.codingCapabilitiesAuthoritative).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousHome;
      invalidateModelsDevCache();
      rmSync(home, { recursive: true, force: true });
    }
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
