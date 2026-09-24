import { describe, it, expect } from 'vitest';
import { materializeRegistry, projectProviderCachedModels } from '../src/registry/materialize.js';
import { buildOpenAiOAuthModels } from '../src/data/openai-oauth-models.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

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

  it('keeps the Codex catalog limits and transport flags for seeded GPT-5.5', () => {
    const model = buildOpenAiOAuthModels().find(row => row.id === 'gpt-5.5');
    expect(model).toMatchObject({
      contextWindow: 272_000,
      maxContextWindow: 272_000,
      preferWebSockets: true,
      useResponsesLite: false,
    });
  });

  // The seed list is written straight into the cache on the Tier-3 discovery-outage
  // path, so a share injected here would be persisted even though projection strips it
  // on the way back out. Assert the source, not just the projection, or the injection
  // is invisible for as long as the migration happens to mask it.
  it('declares no context share in the seed list itself', () => {
    for (const model of buildOpenAiOAuthModels()) {
      expect(model.effectiveContextPercent, model.id).toBeUndefined();
    }
  });

  // Same reason as the share: the seed list is written straight into the cache on the
  // Tier-3 discovery-outage path. A seed row that records no window must not be
  // topped up with clodex's invented 200,000, or that number becomes the ceiling the
  // user is clamped to for as long as the outage cache survives.
  it('takes each seed window from the most authoritative tier that claims it', () => {
    const windows = new Map(buildOpenAiOAuthModels().map(model => [model.id, model.contextWindow]));
    // Declared on the row itself wins.
    expect(windows.get('o1')).toBe(200_000);
    expect(windows.get('o3')).toBe(200_000);
    expect(windows.get('o1-mini')).toBe(128_000);
    expect(windows.get('gpt-6-astra')).toBe(272_000);
    expect(windows.get('gpt-6-sol')).toBe(272_000);
    expect(windows.get('gpt-6-luna')).toBe(272_000);
    // Not declared, but a heuristic rule claims it.
    expect(windows.get('o3-mini')).toBe(1_000_000);
    // Nothing here may be the invented default standing in for a miss.
    expect([...windows.values()].every(w => typeof w === 'number' && w > 0)).toBe(true);
  });

  // The builder reads `lookupKnownContextWindow`, which reports `undefined` rather than
  // inventing 200,000 for a model no tier claims. That property is pinned directly in
  // tests/context-window.test.ts ('reports nothing for a model neither tier claims').
  // It cannot also be pinned HERE: every seed row now either declares its own window or
  // is claimed by a heuristic rule, so `lookupKnownContextWindow` and the inventing
  // `resolveContextWindow` return the same answer for all of them and the wiring is
  // unobservable from this seam. Add a seed that no rule claims and this becomes
  // testable again — and worth testing, because that is the row the invention would hit.

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

/**
 * Rows for the Responses-Lite models written by a clodex that did not yet seed them.
 * Before an id was seeded, a refresh that fell back to the general ChatGPT catalog wrote
 * it through the unseeded branch, which carries no Codex-only `use_responses_lite` /
 * `prefer_websockets`. Without use_responses_lite clodex never sends the
 * Responses-Lite headers; prefer_websockets is recorded for catalog parity (all
 * OAuth Responses requests already use WebSocket transport).
 *
 * The window differs by when the row was written. Before #259 the unseeded branch
 * persisted an invented 200,000 default, so GPT-6 Astra / Daybreak rows from before
 * their seeding, and GPT-6 Sol / Luna rows from before #259, carry an explicit 200,000.
 * v2.16.0 (after #259, before GPT-6 Sol / Luna were seeded in #266) had no GPT-6
 * heuristic, so it wrote those two with NO window; today the 1,050,000 GPT-6 heuristic
 * would clamp that to the 872,000 ceiling instead of the 272,000 standard window.
 *
 * The bare-row cases below pin the absent-field contract for every id, not what the
 * historical producer emitted for each one; the legacy-window case pins the explicit
 * 200,000 shape.
 */
const RESPONSES_LITE_IDS = [
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-daybreak-blue-latest',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
];

function bareRow(id: string, extra: Partial<CachedModel> = {}): CachedModel {
  return { id, name: id, upstreamModelId: id, modelFormat: 'openai', npm: '@ai-sdk/openai', ...extra };
}

function providerWithRows(models: CachedModel[]): RegistryProvider {
  return providerWithLegacyCache({
    modelsCache: { fetchedAt: '2026-09-01T00:00:00.000Z', models },
  });
}

describe('Responses-Lite fields missing from an older cache', () => {
  it.each(RESPONSES_LITE_IDS)('backfills the flags and standard window for %s', id => {
    const model = projectProviderCachedModels(providerWithRows([bareRow(id)]))[0];
    expect(model?.useResponsesLite).toBe(true);
    expect(model?.preferWebSockets).toBe(true);
    expect(model?.contextWindow).toBe(272_000);
    expect(model?.maxContextWindow).toBe(872_000);
  });

  // What the user actually runs on: the launch-time model. Without the window
  // backfill the heuristic 1,050,000 is clamped to the ceiling and reported as 872,000.
  it('reports the 272,000 standard window and the header flag on the launch model', () => {
    const registry = {
      schemaVersion: 4,
      providers: [providerWithRows(RESPONSES_LITE_IDS.map(id => bareRow(id)))],
    } as unknown as ProviderRegistry;
    const [local] = materializeRegistry(registry, () => 'oauth-token');
    for (const id of RESPONSES_LITE_IDS) {
      const model = local?.models.find(m => m.id === id);
      expect(model?.contextWindow, id).toBe(272_000);
      expect(model?.useResponsesLite, id).toBe(true);
      expect(model?.preferWebSockets, id).toBe(true);
    }
  });

  // The shape older clodex actually persisted for Astra / Daybreak (and for Sol / Luna
  // before #259): an explicit legacy 200,000 window and no flags. The flags must be
  // repaired; the window is left alone because the cache cannot tell an invented
  // default from a catalog-reported value.
  it('repairs the flags on a legacy row that carries an explicit 200,000 window', () => {
    const rows = RESPONSES_LITE_IDS.map(id => bareRow(id, { contextWindow: 200_000 }));
    const projected = projectProviderCachedModels(providerWithRows(rows));
    const registry = {
      schemaVersion: 4,
      providers: [providerWithRows(rows)],
    } as unknown as ProviderRegistry;
    const [local] = materializeRegistry(registry, () => 'oauth-token');
    for (const id of RESPONSES_LITE_IDS) {
      const cached = projected.find(m => m.id === id);
      expect(cached?.useResponsesLite, id).toBe(true);
      expect(cached?.preferWebSockets, id).toBe(true);
      expect(cached?.contextWindow, id).toBe(200_000);
      const model = local?.models.find(m => m.id === id);
      expect(model?.useResponsesLite, id).toBe(true);
      expect(model?.preferWebSockets, id).toBe(true);
      expect(model?.contextWindow, id).toBe(200_000);
    }
  });

  // The catalog does report these fields, so whatever it sent is a provider answer.
  // `false` must survive: a truthiness fallback would silently turn it back on.
  it.each(['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra'])(
    'keeps explicit false flags and an explicit window for %s', id => {
      const row = bareRow(id, {
        useResponsesLite: false,
        preferWebSockets: false,
        contextWindow: 400_000,
      });
      const model = projectProviderCachedModels(providerWithRows([row]))[0];
      expect(model?.useResponsesLite).toBe(false);
      expect(model?.preferWebSockets).toBe(false);
      expect(model?.contextWindow).toBe(400_000);
    },
  );

  // Under-scope: seeds that carry no flags must not grow one, and a model the seed does
  // not know keeps exactly what discovery wrote.
  it('invents nothing for a seed without the flags or an unseeded model', () => {
    const models = projectProviderCachedModels(providerWithRows([
      bareRow('gpt-5.4'),
      bareRow('gpt-6-unreleased'),
    ]));
    const legacy = models.find(m => m.id === 'gpt-5.4');
    expect(legacy?.useResponsesLite).toBeUndefined();
    expect(legacy?.preferWebSockets).toBeUndefined();
    expect(legacy?.contextWindow).toBe(272_000);
    const unseeded = models.find(m => m.id === 'gpt-6-unreleased');
    expect(unseeded?.useResponsesLite).toBeUndefined();
    expect(unseeded?.preferWebSockets).toBeUndefined();
    expect(unseeded?.contextWindow).toBeUndefined();
  });

  // Only the ChatGPT OAuth path is Codex. An API-key provider must not be sent the
  // Codex-internal Responses-Lite headers because its model id matches a seed.
  it('does not backfill for a non-OAuth provider', () => {
    const provider = providerWithLegacyCache({
      id: 'openai',
      authType: 'api',
      authRef: 'keyring:provider:openai',
      modelsCache: { fetchedAt: '2026-09-01T00:00:00.000Z', models: [bareRow('gpt-6-sol')] },
    });
    const [sol] = projectProviderCachedModels(provider);
    expect(sol?.useResponsesLite).toBeUndefined();
    expect(sol?.contextWindow).toBeUndefined();
  });
});
