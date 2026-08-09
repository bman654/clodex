// tests/catalog.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MAX_MODEL_CATALOG } from '../src/constants.js';
import {
  buildCatalogRoutes,
  localModelToRoute,
  makeRouteResolver,
  resolveCatalogModelAliases,
} from '../src/catalog.js';
import * as env from '../src/env.js';
import { modelAliasTarget } from '../src/model-aliases.js';
import type { ModelInfo } from '../src/types.js';
import type { FavoriteModel, LocalProvider, ModelAlias } from '../src/types.js';
import { NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE } from '../src/anthropic-beta-policy.js';

const TEST_HELPER_REF = `helper:v1:${'a'.repeat(64)}:oauth:provider:openai-oauth`;

describe('buildCatalogRoutes', () => {
  const starting = {
    aliasId: 'claude-sonnet-4',
    realModelId: 'claude-sonnet-4',
    displayName: 'Sonnet (Groq)',
    upstreamUrl: 'https://api.groq.com',
    apiKey: 'k',
    modelFormat: 'openai' as const,
  };

  const resolve = (providerId: string, modelId: string) =>
    providerId === 'groq' && modelId === 'llama-3.3-70b'
      ? { ...starting, aliasId: 'anthropic-groq__llama-3.3-70b', realModelId: modelId }
      : undefined;

  it('dedupes starting model and caps catalog size', () => {
    const favorites: FavoriteModel[] = [
      { providerId: 'groq', modelId: 'llama-3.3-70b' },
      { providerId: 'zen', modelId: 'claude-sonnet-4' },
    ];
    const { routes, droppedFavorites } = buildCatalogRoutes(starting, favorites, resolve, MAX_MODEL_CATALOG);
    expect(routes[0]).toEqual(starting);
    expect(routes).toHaveLength(2);
    expect(droppedFavorites).toEqual([{ providerId: 'zen', modelId: 'claude-sonnet-4' }]);
  });
});

describe('resolveCatalogModelAliases', () => {
  it('maps saved provider/model targets to the resolved catalog route id', () => {
    const providers: LocalProvider[] = [{
      id: 'test-provider',
      name: 'Test Provider',
      apiKey: 'test-key',
      models: [{
        id: 'model-v1',
        name: 'Model V1',
        family: 'test',
        brand: 'Other',
        modelFormat: 'openai',
        upstreamModelId: 'model-v1',
        npm: '@ai-sdk/openai-compatible',
        contextWindow: 1_000_000,
      }],
    }];
    const aliases: ModelAlias[] = [
      {
        name: 'Fast',
        providerId: 'test-provider',
        modelId: 'model-v1',
      },
      {
        name: 'best',
        providerId: 'test-provider',
        modelId: 'model-v1',
      },
    ];

    const resolved = resolveCatalogModelAliases(aliases, makeRouteResolver(providers));

    expect(resolved).toEqual([
      {
        name: 'fast',
        routeId: 'anthropic-test-provider__model-v1[1m]',
        savedName: 'Fast',
        sourceNames: ['Fast'],
      },
      {
        name: 'best',
        unavailableReason: 'reserved client name',
      },
    ]);
    expect(resolved[0]?.routeId).not.toBe('clodex:test-provider:model-v1');
  });

  it('preserves unavailable saved aliases as reserved preference targets', () => {
    const alias: ModelAlias = {
      name: 'archived',
      providerId: 'missing-provider',
      modelId: 'missing-model',
    };

    expect(resolveCatalogModelAliases([alias], makeRouteResolver([]))).toEqual([{
      name: 'archived',
      routeId: modelAliasTarget(alias),
      unavailableReason: 'target unavailable',
    }]);
  });

  it('retains raw saved spellings in inactive alias warning metadata', () => {
    const aliases: ModelAlias[] = [
      { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
      { name: 'ArChIvEd', providerId: 'missing-provider', modelId: 'missing-model' },
      { name: 'ARCHIVED', providerId: 'missing-provider', modelId: 'missing-model' },
    ];

    expect(resolveCatalogModelAliases(aliases, makeRouteResolver([]))).toEqual([
      {
        name: 'archived',
        savedName: 'ArChIvEd',
        sourceNames: ['ArChIvEd', 'ARCHIVED'],
        routeId: 'clodex:missing-provider:missing-model',
        unavailableReason: 'target unavailable',
      },
      {
        name: 'orbit',
        savedName: 'Orbit',
        unavailableReason: 'conflicting targets',
      },
      {
        name: 'orbit',
        savedName: 'ORBIT',
        unavailableReason: 'conflicting targets',
      },
    ]);
  });

  it('rejects an alias that would shadow an exact catalog route', () => {
    const exactCatalogRoute = {
      aliasId: 'claude-sonnet-4',
      realModelId: 'claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'anthropic-key',
      modelFormat: 'anthropic' as const,
    };
    const aliasTargetRoute = {
      ...exactCatalogRoute,
      aliasId: 'anthropic-other__model-a',
      realModelId: 'model-a',
      displayName: 'Model A',
    };
    const alias: ModelAlias = {
      name: 'CLAUDE-SONNET-4',
      providerId: 'other',
      modelId: 'model-a',
    };

    expect(resolveCatalogModelAliases(
      [alias],
      () => aliasTargetRoute,
      [exactCatalogRoute, aliasTargetRoute],
    )).toEqual([
      {
        name: 'claude-sonnet-4',
        savedName: 'CLAUDE-SONNET-4',
        sourceNames: ['CLAUDE-SONNET-4'],
        routeId: 'anthropic-other__model-a',
        unavailableReason: 'conflicts with a catalog model id',
      },
    ]);
  });

  it('rejects malformed array elements before resolving catalog routes', () => {
    const resolveRoute = vi.fn();

    expect(() => resolveCatalogModelAliases([
      { name: 'valid', providerId: 'one', modelId: 'model-a' },
      null,
    ], resolveRoute)).toThrow(
      'Saved model aliases are malformed: "modelAliases[1]" must be an object with a string "name".',
    );
    expect(resolveRoute).not.toHaveBeenCalled();
  });
});


describe('localModelToRoute', () => {
  it('uses upstreamModelId for SDK calls while keeping catalog id as alias', () => {
    const provider: LocalProvider = {
      id: 'openai',
      name: 'OpenAI',
      apiKey: 'sk-test',
      models: [{
        id: 'gpt-5.5-fast',
        name: 'GPT-5.5 Fast',
        family: 'gpt',
        brand: 'GPT',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-5.5',
        completionsUrl: 'https://api.openai.com/v1/chat/completions',
        npm: '@ai-sdk/openai',
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({
      aliasId: 'anthropic-openai__gpt-5.5-fast[1m]',
      realModelId: 'gpt-5.5',
    });
  });

  it('preserves OAuth provider data and exact credential references for catalog routes', async () => {
    const resolveSpy = vi.spyOn(env, 'resolveProviderCredential').mockResolvedValue('refreshed-token');
    const provider: LocalProvider = {
      id: 'openai-oauth',
      name: 'OpenAI OAuth (ChatGPT)',
      apiKey: 'oauth-token',
      authType: 'oauth',
      authRef: TEST_HELPER_REF,
      providerData: { plan: 'pro' },
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        family: 'gpt',
        brand: 'GPT',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-5.6-sol',
        npm: '@ai-sdk/openai',
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({
      modelFormat: 'openai',
      authType: 'oauth',
      providerData: { plan: 'pro' },
    });
    await expect(route?.refreshToken?.()).resolves.toBe('refreshed-token');
    expect(resolveSpy).toHaveBeenNthCalledWith(
      1,
      'openai-oauth',
      TEST_HELPER_REF,
    );
    await expect(route?.refreshToken?.('rejected-token')).resolves.toBe('refreshed-token');
    expect(resolveSpy).toHaveBeenNthCalledWith(
      2,
      'openai-oauth',
      TEST_HELPER_REF,
      undefined,
      { rejectedAccessToken: 'rejected-token' },
    );
    resolveSpy.mockRestore();
  });

  it('grants beta provenance only to an exact native Claude Code OAuth route', () => {
    const nativeModel: LocalProvider['models'][number] = {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      family: 'claude',
      brand: 'Anthropic',
      modelFormat: 'anthropic',
      upstreamModelId: 'claude-sonnet-4-6',
      baseUrl: 'https://api.anthropic.com',
    };
    const routeFor = (
      id: string,
      authType: LocalProvider['authType'],
      baseUrl = nativeModel.baseUrl,
    ) => localModelToRoute({
      id,
      name: id,
      apiKey: 'token',
      authType,
      models: [{ ...nativeModel, baseUrl }],
    }, { ...nativeModel, baseUrl });

    expect(routeFor('claude-code', 'oauth')).toMatchObject({
      anthropicBetaProvenance: NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE,
    });
    expect(routeFor('generic-oauth', 'oauth')?.anthropicBetaProvenance).toBeUndefined();
    expect(routeFor('claude-code', 'none')?.anthropicBetaProvenance).toBeUndefined();
    expect(routeFor('claude-code', 'oauth', 'https://messages.example')?.anthropicBetaProvenance)
      .toBeUndefined();
  });

  it('propagates Responses-Lite / WebSocket capability flags onto the route', () => {
    const provider: LocalProvider = {
      id: 'openai-oauth',
      name: 'OpenAI OAuth (ChatGPT)',
      apiKey: 'oauth-token',
      authType: 'oauth',
      models: [{
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        family: 'gpt',
        brand: 'GPT',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-5.6-luna',
        npm: '@ai-sdk/openai',
        useResponsesLite: true,
        preferWebSockets: true,
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({ useResponsesLite: true, preferWebSockets: true });
  });

  it('passes through custom endpoint headers for catalog routes', () => {
    const provider: LocalProvider = {
      id: 'custom-zai',
      name: 'Z.AI Coding Plan',
      apiKey: 'sk-test',
      headers: { 'X-Plan': 'coding' },
      models: [{
        id: 'glm-5.2',
        name: 'GLM-5.2',
        family: 'glm',
        brand: 'Other',
        modelFormat: 'openai',
        upstreamModelId: 'glm-5.2',
        npm: '@ai-sdk/openai-compatible',
        apiBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({ headers: { 'X-Plan': 'coding' } });
  });

  it('returns null when routing fields are missing for non-SDK openai models', () => {
    const provider: LocalProvider = {
      id: 'p',
      name: 'P',
      apiKey: 'k',
      models: [{
        id: 'm',
        name: 'M',
        family: '',
        brand: 'Other',
        modelFormat: 'openai',
        upstreamModelId: 'm',
      }],
    };
    expect(localModelToRoute(provider, provider.models[0]!)).toBeNull();
  });

  it('builds SDK routes without completionsUrl when npm is set', () => {
    const provider: LocalProvider = {
      id: 'cerebras',
      name: 'Cerebras',
      apiKey: 'sk-test',
      models: [{
        id: 'llama-3.3-70b',
        name: 'Llama 3.3 70B',
        family: 'llama',
        brand: 'Other',
        modelFormat: 'openai',
        upstreamModelId: 'llama-3.3-70b',
        npm: '@ai-sdk/cerebras',
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({
      aliasId: 'anthropic-cerebras__llama-3.3-70b',
      realModelId: 'llama-3.3-70b',
      npm: '@ai-sdk/cerebras',
      upstreamUrl: '',
    });
  });
});
