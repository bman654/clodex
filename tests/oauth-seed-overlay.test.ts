import { describe, it, expect } from 'vitest';
import { projectProviderCachedModels } from '../src/registry/materialize.js';
import type { RegistryProvider } from '../src/registry/types.js';

/**
 * A catalog cached before the context-budget fields existed carries none of them.
 * Reading it back unchanged reports a raw window with no headroom and no reachable
 * ceiling, which silently collapses the larger stop onto the standard one. That is
 * not hypothetical: the install this was written against held a cache in exactly
 * that shape, and the export returned 272,000 instead of 258,400 until the overlay
 * was added.
 */
function providerWithLegacyCache(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'openai-oauth',
    templateId: 'openai',
    name: 'OpenAI (ChatGPT)',
    enabled: true,
    authRef: 'keyring:provider:openai-oauth',
    authType: 'oauth',
    api: {},
    modelsCache: {
      fetchedAt: '2026-07-21T03:57:52.247Z',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          upstreamModelId: 'gpt-5.6-sol',
          contextWindow: 272_000,
          modelFormat: 'openai',
        },
      ],
    },
    ...overrides,
  } as RegistryProvider;
}

describe('legacy OAuth cache overlay', () => {
  it('fills the budget fields a pre-existing cache never stored', () => {
    const [sol] = projectProviderCachedModels(providerWithLegacyCache());
    expect(sol?.contextWindow).toBe(272_000);
    expect(sol?.effectiveContextPercent).toBe(95);
    expect(sol?.maxContextWindow).toBe(872_000);
    expect(sol?.pricingBoundary).toBe(272_000);
    expect(sol?.maxOutputTokens).toBe(128_000);
  });

  // The overlay is a backfill, never an override: a catalog that reports its own
  // values is the authority, and a stale seed must not quietly replace them.
  it('leaves values the cache already carries alone', () => {
    const provider = providerWithLegacyCache();
    const cached = provider.modelsCache?.models[0];
    if (cached) {
      cached.maxContextWindow = 2_000_000;
      cached.effectiveContextPercent = 90;
      cached.maxOutputTokens = 64_000;
    }
    const [sol] = projectProviderCachedModels(provider);
    expect(sol?.maxContextWindow).toBe(2_000_000);
    expect(sol?.effectiveContextPercent).toBe(90);
    expect(sol?.maxOutputTokens).toBe(64_000);
  });

  // A boundary is claimed only for families whose pricing is documented. The Codex
  // catalog lists `codex-auto-review` with the same windows as GPT-5.6, but the rate
  // card puts code review on a different model, so its band is unknown and asserting
  // one would be inventing it. An unknown model gets neither a ceiling nor a boundary.
  it('invents neither a ceiling nor a boundary for a model outside the seed', () => {
    const provider = providerWithLegacyCache();
    provider.modelsCache?.models.push({
      id: 'codex-auto-review',
      name: 'Auto Review',
      upstreamModelId: 'codex-auto-review',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });
    const review = projectProviderCachedModels(provider).find(m => m.id === 'codex-auto-review');
    expect(review?.contextWindow).toBe(272_000);
    expect(review?.maxContextWindow).toBeUndefined();
    expect(review?.pricingBoundary).toBeUndefined();
  });

  // The boundary is derived from the id family rather than seed membership, so a
  // GPT-5.6 model that only discovery knows about still carries it.
  it('applies the boundary to an unseeded model of a documented family', () => {
    const provider = providerWithLegacyCache();
    provider.modelsCache?.models.push({
      id: 'gpt-5.6-unreleased',
      name: 'GPT-5.6 Unreleased',
      upstreamModelId: 'gpt-5.6-unreleased',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });
    const model = projectProviderCachedModels(provider).find(m => m.id === 'gpt-5.6-unreleased');
    expect(model?.pricingBoundary).toBe(272_000);
    expect(model?.maxContextWindow).toBeUndefined();
  });

  // Only the ChatGPT OAuth provider uses the Codex effective-window convention.
  // Applying it to an API-key provider would shrink every other model by 5%.
  it('does not touch a non-OAuth provider', () => {
    const provider = providerWithLegacyCache({
      id: 'openai',
      authType: 'api',
      authRef: 'keyring:provider:openai',
    });
    const [sol] = projectProviderCachedModels(provider);
    expect(sol?.contextWindow).toBe(272_000);
    expect(sol?.effectiveContextPercent).toBeUndefined();
    expect(sol?.maxContextWindow).toBeUndefined();
  });
});
