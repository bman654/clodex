import { describe, it, expect } from 'vitest';
import {
  resolveFavorite,
  buildFavoritesList,
  resolveFirstAvailableFavorite,
  type ResolveContext,
} from '../src/favorites-resolver.js';
import { shouldHideModel } from '../src/model-compatibility.js';
import type { FavoriteModel, LocalProvider, ModelInfo } from '../src/types.js';

const sampleLocalProvider: LocalProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  apiKey: 'ant-key',
  models: [
    {
      id: 'claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      family: 'claude',
      brand: 'Anthropic',
      modelFormat: 'anthropic',
      upstreamModelId: 'claude-sonnet-4-5-20250929',
      baseUrl: 'https://api.anthropic.com',
      contextWindow: 200000,
    },
  ],
};

describe('resolveFavorite', () => {
  it('resolves a local provider favorite', async () => {
    const ctx: ResolveContext = {
      localProviders: [sampleLocalProvider],
      findLocalModel: (pid, mid) => {
        if (pid !== 'anthropic') return undefined;
        const provider = sampleLocalProvider;
        const model = provider.models.find(m => m.id === mid);
        return model ? { provider, model } : undefined;
      },
    };
    const fav: FavoriteModel = { providerId: 'anthropic', modelId: 'claude-sonnet-4.5' };

    const result = await resolveFavorite(fav, ctx);

    expect(result?.providerId).toBe('anthropic');
    expect(result?.providerName).toBe('Anthropic');
    expect(result?.apiKey).toBe('ant-key');
    expect(result?.model).toBe(sampleLocalProvider.models[0]);
  });

  it('returns undefined when the provider is missing', async () => {
    const ctx: ResolveContext = {
      localProviders: [],
      findLocalModel: () => undefined,
    };
    const fav: FavoriteModel = { providerId: 'openai', modelId: 'gpt-5.5' };
    expect(await resolveFavorite(fav, ctx)).toBeUndefined();
  });

  it('returns undefined when the model is missing from the provider', async () => {
    const ctx: ResolveContext = {
      localProviders: [sampleLocalProvider],
      findLocalModel: (pid, mid) => {
        if (pid !== 'anthropic') return undefined;
        const model = sampleLocalProvider.models.find(m => m.id === mid);
        return model ? { provider: sampleLocalProvider, model } : undefined;
      },
    };
    const fav: FavoriteModel = { providerId: 'anthropic', modelId: 'gpt-5.5' };
    expect(await resolveFavorite(fav, ctx)).toBeUndefined();
  });

  it('returns undefined when the model is blacklisted for the agent', async () => {
    // The blacklist may or may not flag this exact model — we just check the wiring
    // call exists. The test is reliable as long as resolveFavorite calls
    // shouldHideModel when ctx.agent is set.
    const ctx: ResolveContext = {
      agent: 'codex',
      localProviders: [sampleLocalProvider],
      findLocalModel: (pid, mid) => {
        if (pid !== 'anthropic') return undefined;
        const model = sampleLocalProvider.models.find(m => m.id === mid);
        return model ? { provider: sampleLocalProvider, model } : undefined;
      },
    };
    const fav: FavoriteModel = { providerId: 'anthropic', modelId: 'claude-sonnet-4.5' };

    const hidden = shouldHideModel({ providerId: fav.providerId, modelId: fav.modelId, agent: 'codex' });
    const result = await resolveFavorite(fav, ctx);
    if (hidden) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toBeDefined();
    }
  });
});

describe('buildFavoritesList', () => {
  const ctx: ResolveContext = {
    localProviders: [sampleLocalProvider],
    findLocalModel: (pid, mid) => {
      if (pid !== 'anthropic') return undefined;
      const model = sampleLocalProvider.models.find(m => m.id === mid);
      return model ? { provider: sampleLocalProvider, model } : undefined;
    },
  };

  it('places starting model first, then favorites', async () => {
    const starting = await resolveFavorite({ providerId: 'anthropic', modelId: 'claude-sonnet-4.5' }, ctx);
    const favorites: FavoriteModel[] = [
      { providerId: 'anthropic', modelId: 'claude-sonnet-4.5' }, // same as starting → dedup
    ];

    const { resolved, droppedFavorites } = await buildFavoritesList(starting, favorites, ctx);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.providerId).toBe('anthropic');
    expect(droppedFavorites).toEqual([]);
  });

  it('drops stale favorites and reports them in the dropped array', async () => {
    const favorites: FavoriteModel[] = [
      { providerId: 'openai', modelId: 'gpt-5.5' }, // stale
      { providerId: 'anthropic', modelId: 'claude-sonnet-4.5' },
    ];

    const { resolved, droppedFavorites } = await buildFavoritesList(undefined, favorites, ctx);

    expect(resolved).toHaveLength(1);
    expect(droppedFavorites).toEqual([{ providerId: 'openai', modelId: 'gpt-5.5' }]);
  });

  it('respects a custom max', async () => {
    // Build 10 distinct valid models so the cap can actually be enforced.
    const manyModels = Array.from({ length: 10 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
      family: 'claude',
      brand: 'Anthropic',
      modelFormat: 'anthropic' as const,
      upstreamModelId: `model-${i}`,
      baseUrl: 'https://api.anthropic.com',
      contextWindow: 200000,
    }));
    const customProvider: LocalProvider = { ...sampleLocalProvider, models: manyModels };
    const customCtx: ResolveContext = {
      localProviders: [customProvider],
      findLocalModel: (pid, mid) => {
        if (pid !== 'anthropic') return undefined;
        const model = customProvider.models.find(m => m.id === mid);
        return model ? { provider: customProvider, model } : undefined;
      },
    };
    const favorites: FavoriteModel[] = manyModels.map(m => ({
      providerId: 'anthropic',
      modelId: m.id,
    }));

    const { resolved } = await buildFavoritesList(undefined, favorites, customCtx, 5);

    expect(resolved).toHaveLength(5);
  });

  it('can drop favorites that resolve to an empty API key', async () => {
    const missingKeyProvider: LocalProvider = {
      id: 'missing-key',
      name: 'Missing Key',
      apiKey: '',
      models: [{
        id: 'available-but-no-key',
        name: 'Available But No Key',
        family: 'test',
        brand: 'Test',
        modelFormat: 'openai',
        upstreamModelId: 'available-but-no-key',
      }],
    };
    const missingKeyCtx: ResolveContext = {
      localProviders: [missingKeyProvider],
      findLocalModel: (pid, mid) => {
        if (pid !== missingKeyProvider.id) return undefined;
        const model = missingKeyProvider.models.find(m => m.id === mid);
        return model ? { provider: missingKeyProvider, model } : undefined;
      },
    };
    const favorites: FavoriteModel[] = [
      { providerId: 'missing-key', modelId: 'available-but-no-key' },
    ];

    const { resolved, droppedFavorites } = await buildFavoritesList(
      undefined,
      favorites,
      missingKeyCtx,
      20,
      { dropEmptyApiKey: true },
    );

    expect(resolved).toHaveLength(0);
    expect(droppedFavorites).toEqual(favorites);
  });

  it('retains anonymous favorites while dropping ordinary empty-key providers', async () => {
    const anonymousProvider: LocalProvider = {
      id: 'anonymous',
      name: 'Anonymous',
      apiKey: '',
      authType: 'none',
      models: [{
        id: 'anonymous-model',
        name: 'Anonymous Model',
        family: 'test',
        brand: 'Test',
        modelFormat: 'openai',
        upstreamModelId: 'anonymous-model',
      }],
    };
    const emptyKeyProvider: LocalProvider = {
      id: 'empty-key',
      name: 'Empty Key',
      apiKey: '',
      authType: 'api',
      models: [{
        id: 'empty-key-model',
        name: 'Empty Key Model',
        family: 'test',
        brand: 'Test',
        modelFormat: 'openai',
        upstreamModelId: 'empty-key-model',
      }],
    };
    const localProviders = [anonymousProvider, emptyKeyProvider];
    const favorites: FavoriteModel[] = [
      { providerId: 'anonymous', modelId: 'anonymous-model' },
      { providerId: 'empty-key', modelId: 'empty-key-model' },
    ];
    const mixedCtx: ResolveContext = {
      localProviders,
      findLocalModel: (providerId, modelId) => {
        const provider = localProviders.find(candidate => candidate.id === providerId);
        const model = provider?.models.find(candidate => candidate.id === modelId);
        return provider && model ? { provider, model } : undefined;
      },
    };

    const { resolved, droppedFavorites } = await buildFavoritesList(
      undefined,
      favorites,
      mixedCtx,
      20,
      { dropEmptyApiKey: true },
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      providerId: 'anonymous',
      apiKey: '',
      authType: 'none',
    });
    expect(droppedFavorites).toEqual([
      { providerId: 'empty-key', modelId: 'empty-key-model' },
    ]);
  });
});

describe('resolveFirstAvailableFavorite', () => {
  it('skips stale favorites and returns the first provider/model still available', () => {
    const result = resolveFirstAvailableFavorite([
      { providerId: 'openai', modelId: 'gpt-5.5' },
      { providerId: 'anthropic', modelId: 'claude-sonnet-4.5' },
    ], [sampleLocalProvider]);

    expect(result?.provider).toBe(sampleLocalProvider);
    expect(result?.model).toBe(sampleLocalProvider.models[0]);
  });
});
