import { describe, expect, it } from 'vitest';
import { buildHttpProxyRoutes, httpProxyModelId } from '../src/http-proxy/routes.js';
import { buildPatchModelConfig } from '../src/patcher.js';
import type { LocalProvider } from '../src/types.js';

const providers: LocalProvider[] = [
  {
    id: 'groq',
    name: 'Groq Cloud',
    apiKey: 'groq-key',
    models: [{
      id: 'llama-3.3-70b',
      upstreamModelId: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B',
      family: 'llama',
      brand: 'Meta',
      modelFormat: 'openai',
      npm: '@ai-sdk/groq',
      contextWindow: 1_000_000,
    }],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiKey: 'anthropic-key',
    models: [{
      id: 'claude-sonnet-4-6',
      upstreamModelId: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      family: 'claude',
      brand: 'Claude',
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      baseUrl: 'https://api.anthropic.com',
    }],
  },
];

describe('HTTP proxy routes', () => {
  it('uses stable provider-prefixed names for SDK and Anthropic passthrough favorites', () => {
    const result = buildHttpProxyRoutes(providers, [
      { providerId: 'groq', modelId: 'llama-3.3-70b' },
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      { providerId: 'missing', modelId: 'gone' },
    ]);

    expect(result.routes).toHaveLength(2);
    expect(result.routes[0]).toMatchObject({
      aliasId: 'clodex:groq:llama-3.3-70b[1m]',
      realModelId: 'llama-3.3-70b-versatile',
      npm: '@ai-sdk/groq',
      apiKey: 'groq-key',
    });
    expect(result.routes[1]).toMatchObject({
      aliasId: 'clodex:anthropic:claude-sonnet-4-6[1m]',
      realModelId: 'claude-sonnet-4-6',
      modelFormat: 'anthropic',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'anthropic-key',
    });
    expect(result.unsupported).toEqual([]);
    expect(result.unavailable).toEqual([{ providerId: 'missing', modelId: 'gone' }]);
  });

  it('rejects an Anthropic favorite without a passthrough base URL', () => {
    const missingBase = [{
      ...providers[1]!,
      models: [{ ...providers[1]!.models[0]!, baseUrl: undefined }],
    }];

    const result = buildHttpProxyRoutes(missingBase, [
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    ]);

    expect(result.routes).toEqual([]);
    expect(result.unsupported).toEqual([
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    ]);
  });

  it('does not create a route when the provider credential is empty', () => {
    const noKey = [{ ...providers[0]!, apiKey: '' }];
    const result = buildHttpProxyRoutes(noKey, [{ providerId: 'groq', modelId: 'llama-3.3-70b' }]);
    expect(result.routes).toEqual([]);
    expect(result.unavailable).toHaveLength(1);
  });

  it('retains an explicitly anonymous route with an empty credential', () => {
    const anonymous = [{ ...providers[0]!, apiKey: '', authType: 'none' as const }];
    const favorite = { providerId: 'groq', modelId: 'llama-3.3-70b' };

    const result = buildHttpProxyRoutes(anonymous, [favorite]);

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({
      aliasId: 'clodex:groq:llama-3.3-70b[1m]',
      apiKey: '',
      authType: 'none',
    });
    expect(result.unavailable).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('formats the exact freeform Claude model id', () => {
    expect(httpProxyModelId('openrouter', 'deepseek/deepseek-v3')).toBe('clodex:openrouter:deepseek/deepseek-v3');
  });

  it('resolves short aliases only when they target available HTTP-proxy favorites', () => {
    const result = buildHttpProxyRoutes(
      providers,
      [{ providerId: 'groq', modelId: 'llama-3.3-70b' }],
      [
        { name: 'llama', providerId: 'groq', modelId: 'llama-3.3-70b' },
        { name: 'missing', providerId: 'groq', modelId: 'gone' },
        { name: 'bad:name', providerId: 'groq', modelId: 'llama-3.3-70b' },
        { name: 'DeFaUlT', providerId: 'groq', modelId: 'llama-3.3-70b' },
      ],
    );

    expect(result.aliases).toEqual([{
      name: 'llama',
      routeId: 'clodex:groq:llama-3.3-70b[1m]',
      displayName: 'Llama 3.3 70B (Groq Cloud)',
    }]);
    expect(result.unavailableAliasRejections).toEqual([
      {
        alias: { name: 'bad:name', providerId: 'groq', modelId: 'llama-3.3-70b' },
        reason: 'invalid-name',
      },
      {
        alias: { name: 'DeFaUlT', providerId: 'groq', modelId: 'llama-3.3-70b' },
        reason: 'reserved-name',
      },
      {
        alias: { name: 'missing', providerId: 'groq', modelId: 'gone' },
        reason: 'target-not-favorite',
      },
    ]);
  });

  it('fails closed when case variants point at different targets', () => {
    const result = buildHttpProxyRoutes(
      providers,
      [{ providerId: 'groq', modelId: 'llama-3.3-70b' }],
      [
        { name: 'LLaMa', providerId: 'groq', modelId: 'llama-3.3-70b' },
        { name: 'llama', providerId: 'groq', modelId: 'other' },
      ],
    );

    expect(result.aliases).toEqual([]);
    expect(result.unavailableAliasRejections).toEqual([
      {
        alias: { name: 'LLaMa', providerId: 'groq', modelId: 'llama-3.3-70b' },
        reason: 'conflicting-targets',
      },
      {
        alias: { name: 'llama', providerId: 'groq', modelId: 'other' },
        reason: 'conflicting-targets',
      },
    ]);
  });

  it('collapses equivalent case variants without reporting an unavailable alias', () => {
    const result = buildHttpProxyRoutes(
      providers,
      [{ providerId: 'groq', modelId: 'llama-3.3-70b' }],
      [
        { name: 'LLaMa', providerId: 'groq', modelId: 'llama-3.3-70b' },
        { name: 'LLAMA', providerId: 'groq', modelId: 'llama-3.3-70b' },
      ],
    );

    expect(result.aliases).toEqual([{
      name: 'llama',
      routeId: 'clodex:groq:llama-3.3-70b[1m]',
      displayName: 'Llama 3.3 70B (Groq Cloud)',
      sourceNames: ['LLaMa', 'LLAMA'],
    }]);
    expect(result.unavailableAliasRejections).toEqual([]);
  });

  it('uses the same canonical alias for patch identity and proxy routing', () => {
    const favorite = { providerId: 'groq', modelId: 'llama-3.3-70b' };
    const aliases = [{ name: 'LLaMa', ...favorite }];
    const routes = buildHttpProxyRoutes(providers, [favorite], aliases);
    const patch = buildPatchModelConfig(
      [favorite],
      aliases,
      () => ({ contextWindow: 1_000_000, displayName: 'Llama 3.3 70B' }),
    );

    expect(routes.aliases[0]?.name).toBe(
      patch.config['clodex:groq:llama-3.3-70b']?.alias,
    );
    expect(routes.aliases[0]?.sourceNames).toEqual(['LLaMa']);
  });

  it('exposes only the first saved favorites and keeps later aliases inactive', () => {
    const manyProvider: LocalProvider = {
      id: 'many',
      name: 'Many Models',
      apiKey: 'many-key',
      models: Array.from({ length: 25 }, (_, index) => ({
        id: `model-${index}`,
        upstreamModelId: `upstream-${index}`,
        name: `Model ${index}`,
        family: 'test',
        brand: 'Other',
        modelFormat: 'openai' as const,
        npm: '@ai-sdk/openai-compatible',
      })),
    };
    const favorites = manyProvider.models.map(model => ({
      providerId: manyProvider.id,
      modelId: model.id,
    }));

    const result = buildHttpProxyRoutes([manyProvider], favorites, [{
      name: 'late',
      providerId: manyProvider.id,
      modelId: 'model-20',
    }]);

    expect(result.routes.map(route => route.aliasId)).toEqual(
      favorites.slice(0, 20).map(favorite => `clodex:${favorite.providerId}:${favorite.modelId}`),
    );
    expect(result.capacitySkippedFavorites).toEqual(favorites.slice(20));
    expect(result.aliases).toEqual([]);
    expect(result.unavailableAliasRejections).toEqual([{
      alias: {
        name: 'late',
        providerId: 'many',
        modelId: 'model-20',
      },
      reason: 'target-not-exposed',
    }]);
  });

  it('does not backfill the window when a favorite inside it is unavailable', () => {
    const mainProvider: LocalProvider = {
      id: 'main',
      name: 'Main Models',
      apiKey: 'main-key',
      models: ['one', 'two', 'three'].map(id => ({
        id,
        upstreamModelId: id,
        name: id,
        family: 'test',
        brand: 'Other',
        modelFormat: 'openai' as const,
        npm: '@ai-sdk/openai-compatible',
      })),
    };
    const favorites = [
      { providerId: 'missing', modelId: 'gone' },
      { providerId: 'main', modelId: 'one' },
      { providerId: 'main', modelId: 'two' },
      { providerId: 'main', modelId: 'three' },
    ];

    const result = buildHttpProxyRoutes([mainProvider], favorites, [
      { name: 'missing', providerId: 'missing', modelId: 'gone' },
      { name: 'later', providerId: 'main', modelId: 'three' },
    ], 3);

    expect(result.routes.map(route => route.aliasId)).toEqual([
      'clodex:main:one',
      'clodex:main:two',
    ]);
    expect(result.unavailable).toEqual([{ providerId: 'missing', modelId: 'gone' }]);
    expect(result.capacitySkippedFavorites).toEqual([{ providerId: 'main', modelId: 'three' }]);
    expect(result.unavailableAliasRejections).toEqual([
      {
        alias: { name: 'missing', providerId: 'missing', modelId: 'gone' },
        reason: 'target-unavailable',
      },
      {
        alias: { name: 'later', providerId: 'main', modelId: 'three' },
        reason: 'target-not-exposed',
      },
    ]);
    const routedAliasIds = new Set(result.routes.map(route => route.aliasId));
    expect(
      result.capacitySkippedFavorites.every(
        favorite => !routedAliasIds.has(httpProxyModelId(favorite.providerId, favorite.modelId)),
      ),
    ).toBe(true);
  });
});
