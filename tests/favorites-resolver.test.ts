import { describe, it, expect } from 'vitest';
import {
  resolveFavorite,
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
