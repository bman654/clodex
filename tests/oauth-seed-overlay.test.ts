import { describe, it, expect } from 'vitest';
import { projectProviderCachedModels } from '../src/registry/materialize.js';
import { buildOpenAiOAuthModels } from '../src/data/openai-oauth-models.js';
import type { RegistryProvider } from '../src/registry/types.js';

/**
 * A catalog cached before the context-budget fields existed carries none of them.
 * Reading it back unchanged reports no reachable ceiling, which silently collapses the
 * larger stop onto the standard one. That is not hypothetical: the install this was
 * written against held a cache in exactly that shape.
 *
 * The overlay originally also imposed a 95% share on the window. It no longer does —
 * that share was clodex's own invention and cost usable context — so these tests now
 * assert the provider's real numbers, and one of them pins the discard of a share left
 * behind in caches written by those versions.
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
    // No share is imposed: the provider does not report one, so the window clodex
    // reports is the window the provider actually gives.
    expect(sol?.effectiveContextPercent).toBeUndefined();
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

  // The upgrade path that the fix would otherwise miss entirely. A user who
  // refreshed their catalog under an older clodex has `reasoning: false` written for
  // these ids — a stale ID GUESS, since the Codex catalog never reported the field.
  // Left authoritative it survives the upgrade, getPatchReasoningCapabilities
  // early-returns on it, and the effort selector stays missing until the user
  // happens to re-run `clodex providers refresh-models`.
  it('overrides a stale reasoning verdict for a model the seed now knows', () => {
    const provider = providerWithLegacyCache();
    provider.modelsCache?.models.push({
      id: 'gpt-6-astra',
      name: 'gpt-6-astra',
      upstreamModelId: 'gpt-6-astra',
      contextWindow: 272_000,
      modelFormat: 'openai',
      reasoning: false,
    });
    const model = projectProviderCachedModels(provider).find(m => m.id === 'gpt-6-astra');
    expect(model?.reasoning).toBe(true);
  });

  // Under-scope guard: the override reaches only ids the seed actually carries, so a
  // model discovered in the wild keeps whatever discovery decided about it.
  it('leaves the reasoning verdict alone for a model the seed does not know', () => {
    const provider = providerWithLegacyCache();
    provider.modelsCache?.models.push({
      id: 'gpt-not-in-the-seed-table',
      name: 'unknown',
      upstreamModelId: 'gpt-not-in-the-seed-table',
      contextWindow: 272_000,
      modelFormat: 'openai',
      reasoning: false,
    });
    const model = projectProviderCachedModels(provider)
      .find(m => m.id === 'gpt-not-in-the-seed-table');
    expect(model?.reasoning).toBe(false);
  });

  // The boundary is derived from the family version, so it needs the same
  // over/under-scope pair the effort predicate has. gpt-5.5 is a real seeded model
  // with a live 272k band; gpt-5.4 has no published one. An off-by-one that silently
  // drops gpt-5.5's high-rate warning is a money bug, not a cosmetic one.
  it.each([
    ['gpt-5.5-unreleased', 272_000],
    ['gpt-6-unreleased', 272_000],
    ['gpt-daybreak-unreleased', 272_000],
  ])('applies the pricing boundary to %s', (id, boundary) => {
    const provider = providerWithLegacyCache();
    provider.modelsCache?.models.push({
      id, name: id, upstreamModelId: id, contextWindow: 272_000, modelFormat: 'openai',
    });
    expect(projectProviderCachedModels(provider).find(m => m.id === id)?.pricingBoundary)
      .toBe(boundary);
  });

  it.each(['gpt-5.4-unreleased', 'gpt-4o-unreleased'])(
    'applies no pricing boundary to %s',
    id => {
      const provider = providerWithLegacyCache();
      provider.modelsCache?.models.push({
        id, name: id, upstreamModelId: id, contextWindow: 272_000, modelFormat: 'openai',
      });
      expect(projectProviderCachedModels(provider).find(m => m.id === id)?.pricingBoundary)
        .toBeUndefined();
    },
  );

  // The seed list is written straight into the cache on the Tier-3 discovery-outage
  // path, so a share injected here would be persisted even though projection strips it
  // on the way back out. Assert the source, not just the projection, or the injection
  // is invisible for as long as the migration happens to mask it.
  it('declares no context share in the seed list itself', () => {
    for (const model of buildOpenAiOAuthModels()) {
      expect(model.effectiveContextPercent, model.id).toBeUndefined();
    }
  });

  // The migration for installs that refreshed while clodex still imposed a share.
  // A cached 95 is not a provider answer — the Codex catalog reports null for this
  // field on every model, and no clodex command writes it — so it can only be the
  // value older versions injected. Left in place it would keep costing 13,600
  // tokens on every session until the user happened to re-run a model refresh.
  it('discards the share clodex used to impose on a cached window', () => {
    const provider = providerWithLegacyCache();
    const cached = provider.modelsCache?.models[0];
    if (cached) cached.effectiveContextPercent = 95;
    const [sol] = projectProviderCachedModels(provider);
    expect(sol?.effectiveContextPercent).toBeUndefined();
  });

  // Under-scope: a share a provider genuinely declares must still be honoured, or
  // the migration has become a blanket "ignore this field".
  it.each([90, 80, 50])('keeps a declared share of %i%%', percent => {
    const provider = providerWithLegacyCache();
    const cached = provider.modelsCache?.models[0];
    if (cached) cached.effectiveContextPercent = percent;
    const [sol] = projectProviderCachedModels(provider);
    expect(sol?.effectiveContextPercent).toBe(percent);
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
