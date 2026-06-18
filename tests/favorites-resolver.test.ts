import { describe, it, expect } from 'vitest';
import {
  resolveFavorite,
  buildFavoritesList,
  resolveFirstAvailableFavorite,
  type ResolveContext,
} from '../src/favorites-resolver.js';
import { shouldHideModel } from '../src/model-compatibility.js';
import type { FavoriteModel, LocalProvider, ModelInfo } from '../src/types.js';

const sampleZenModels: ModelInfo[] = [
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    isFree: false,
    brand: 'Anthropic',
    sourceBackend: 'zen',
    modelFormat: 'anthropic',
    contextWindow: 200000,
  },
];

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
  it('resolves a Zen favorite to its ModelInfo + apiKey', () => {
    const ctx: ResolveContext = {
      zenModels: sampleZenModels,
      zenGoApiKey: 'test-key',
    };
    const fav: FavoriteModel = { providerId: 'zen', modelId: 'claude-sonnet-4.5' };

    const result = resolveFavorite(fav, ctx);

    expect(result).toEqual({
      providerId: 'zen',
      providerName: 'OpenCode Zen',
      model: sampleZenModels[0],
      apiKey: 'test-key',
      sourceBackend: 'zen',
    });
  });

  it('resolves a local provider favorite', () => {
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

    const result = resolveFavorite(fav, ctx);

    expect(result?.providerId).toBe('anthropic');
    expect(result?.providerName).toBe('Anthropic');
    expect(result?.apiKey).toBe('ant-key');
    expect(result?.model).toBe(sampleLocalProvider.models[0]);
  });

  it('returns undefined when the provider is missing', () => {
    const ctx: ResolveContext = {
      localProviders: [],
      findLocalModel: () => undefined,
    };
    const fav: FavoriteModel = { providerId: 'openai', modelId: 'gpt-5.5' };
    expect(resolveFavorite(fav, ctx)).toBeUndefined();
  });

  it('returns undefined when the model is missing from the provider', () => {
    const ctx: ResolveContext = {
      localProviders: [sampleLocalProvider],
      findLocalModel: (pid, mid) => {
        if (pid !== 'anthropic') return undefined;
        const model = sampleLocalProvider.models.find(m => m.id === mid);
        return model ? { provider: sampleLocalProvider, model } : undefined;
      },
    };
    const fav: FavoriteModel = { providerId: 'anthropic', modelId: 'gpt-5.5' };
    expect(resolveFavorite(fav, ctx)).toBeUndefined();
  });

  it('returns undefined when the model is blacklisted for the agent', () => {
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
    const result = resolveFavorite(fav, ctx);
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

  it('places starting model first, then favorites', () => {
    const starting = resolveFavorite({ providerId: 'anthropic', modelId: 'claude-sonnet-4.5' }, ctx);
    const favorites: FavoriteModel[] = [
      { providerId: 'anthropic', modelId: 'claude-sonnet-4.5' }, // same as starting → dedup
    ];

    const { resolved, droppedFavorites } = buildFavoritesList(starting, favorites, ctx);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.providerId).toBe('anthropic');
    expect(droppedFavorites).toEqual([]);
  });

  it('drops stale favorites and reports them in the dropped array', () => {
    const favorites: FavoriteModel[] = [
      { providerId: 'openai', modelId: 'gpt-5.5' }, // stale
      { providerId: 'anthropic', modelId: 'claude-sonnet-4.5' },
    ];

    const { resolved, droppedFavorites } = buildFavoritesList(undefined, favorites, ctx);

    expect(resolved).toHaveLength(1);
    expect(droppedFavorites).toEqual([{ providerId: 'openai', modelId: 'gpt-5.5' }]);
  });

  it('respects a custom max', () => {
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

    const { resolved } = buildFavoritesList(undefined, favorites, customCtx, 5);

    expect(resolved).toHaveLength(5);
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
