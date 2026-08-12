import { describe, it, expect } from 'vitest';
import {
  applyPricingToRegistryProviders,
  buildPricingIndex,
  enrichModelsWithPricing,
  loadBundledPricingCache,
  lookupModelCost,
  normalizeModelIdCandidates,
  pickPricingRow,
  providerPreservesModelPricing,
} from '../src/registry/pricing.js';
import type { CachedModel } from '../src/registry/types.js';

describe('normalizeModelIdCandidates', () => {
  it('strips common provider prefixes', () => {
    const candidates = normalizeModelIdCandidates('moonshotai/kimi-k2.6');
    expect(candidates).toContain('moonshotai/kimi-k2.6');
    expect(candidates).toContain('kimi-k2.6');
  });
});

describe('pricing enrich', () => {
  it('loads bundled cache with sample models', () => {
    const cache = loadBundledPricingCache();
    expect(cache.models?.length).toBeGreaterThan(0);
  });

  it('enriches groq model cost from bundled cache', () => {
    const cache = loadBundledPricingCache();
    const index = buildPricingIndex(cache);
    const cost = lookupModelCost(index, 'llama-3.3-70b-versatile', 'groq');
    expect(cost?.input).toBe(0.59);
    expect(cost?.output).toBe(0.79);
  });

  it('enriches kimi alias ids', () => {
    const cache = loadBundledPricingCache();
    const index = buildPricingIndex(cache);
    const cost = lookupModelCost(index, 'moonshotai/kimi-k2.6', 'openrouter');
    expect(cost?.input).toBe(0.6);
  });

  it('applies cost to cached models', () => {
    const cache = loadBundledPricingCache();
    const index = buildPricingIndex(cache);
    const models: CachedModel[] = [{
      id: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B',
      upstreamModelId: 'llama-3.3-70b-versatile',
      modelFormat: 'openai',
    }];
    const enriched = enrichModelsWithPricing(models, index, 'groq');
    expect(enriched[0]?.cost?.input).toBe(0.59);
  });

  it('preserves provider-owned pricing when the registry opts out of enrichment', () => {
    const registry = {
      schemaVersion: 1 as const,
      providers: [{
        id: 'mixed-provider',
        templateId: 'mixed-provider',
        name: 'Mixed Provider',
        enabled: true,
        authRef: 'keyring:provider:mixed-provider',
        preserveModelPricing: true,
        api: { npm: '@ai-sdk/openai-compatible' },
        addedAt: '2026-08-07T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-08-07T00:00:00.000Z',
          models: [{
            id: 'kimi-k2.7-code',
            name: 'Kimi K2.7 Code',
            upstreamModelId: 'kimi-k2.7-code',
            modelFormat: 'openai' as const,
            cost: { input: 0.95, output: 4 },
          }],
        },
      }],
    };
    const changed = applyPricingToRegistryProviders(registry, {
      models: [{
        model_id: 'kimi-k2.7-code',
        pricing: [{
          platform: 'openrouter',
          tier: 'standard',
          input_per_1m_tokens: 99,
          output_per_1m_tokens: 199,
        }],
      }],
    });

    expect(changed).toBe(false);
    expect(registry.providers[0]?.modelsCache?.models[0]?.cost).toEqual({
      input: 0.95,
      output: 4,
    });
  });

  it('reads the opt-out through the template when a record lost the flag, without disturbing ordinary providers', () => {
    // PO4, both directions in one registry. The OpenCode Go record has no
    // `preserveModelPricing` — the field an older clodex drops on round trip —
    // so only the template fallback can save its curated prices. The groq
    // record alongside it must still be enriched exactly as #98 enriches it,
    // across the top-level and named-account caches.
    const fetchedAt = '2026-08-09T00:00:00.000Z';
    const curated = {
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      upstreamModelId: 'claude-sonnet-4-5',
      modelFormat: 'anthropic' as const,
      cost: { input: 3, output: 15 },
    };
    const ordinary = {
      id: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B',
      upstreamModelId: 'llama-3.3-70b-versatile',
      modelFormat: 'openai' as const,
    };
    const registry = {
      schemaVersion: 1 as const,
      providers: [
        {
          id: 'opencode-go',
          templateId: 'opencode-go',
          name: 'OpenCode Go',
          enabled: true,
          authRef: 'keyring:provider:opencode-go',
          // deliberately no preserveModelPricing field
          api: { npm: '@ai-sdk/openai-compatible' },
          addedAt: fetchedAt,
          modelsCache: { fetchedAt, models: [{ ...curated }] },
        },
        {
          id: 'groq',
          templateId: 'groq',
          name: 'Groq',
          enabled: true,
          authRef: 'keyring:provider:groq',
          api: { npm: '@ai-sdk/groq' },
          addedAt: fetchedAt,
          modelsCache: { fetchedAt, models: [{ ...ordinary }] },
          authAccounts: {
            work: {
              authRef: 'keyring:provider:groq-work',
              addedAt: fetchedAt,
              modelsCache: { fetchedAt, models: [{ ...ordinary }] },
            },
          },
        },
      ],
    };

    // A cache that genuinely collides with BOTH models, so preservation and
    // enrichment are each observable rather than vacuously true.
    const changed = applyPricingToRegistryProviders(registry, {
      models: [
        {
          model_id: 'claude-sonnet-4-5',
          pricing: [{ tier: 'standard', input_per_1m_tokens: 99, output_per_1m_tokens: 199 }],
        },
        {
          model_id: 'llama-3.3-70b-versatile',
          pricing: [{
            platform: 'groq',
            tier: 'standard',
            input_per_1m_tokens: 0.59,
            output_per_1m_tokens: 0.79,
          }],
        },
      ],
    });

    // Curated OpenCode prices survive purely on the template fallback: the
    // colliding 99/199 row must NOT land.
    expect(registry.providers[0]?.modelsCache?.models[0]?.cost).toEqual({ input: 3, output: 15 });
    // The ordinary provider keeps #98 enrichment on both cache locations.
    expect(changed).toBe(true);
    expect(registry.providers[1]?.modelsCache?.models[0]?.cost?.input).toBe(0.59);
    expect(registry.providers[1]?.authAccounts?.work?.modelsCache?.models[0]?.cost?.input).toBe(0.59);
  });

  it('composes provider-owned pricing with account-cache enrichment', () => {
    const fetchedAt = '2026-08-09T00:00:00.000Z';
    const model = {
      id: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B',
      upstreamModelId: 'llama-3.3-70b-versatile',
      modelFormat: 'openai' as const,
    };
    const ordinaryCache = () => ({ fetchedAt, models: [{ ...model }] });
    const curatedCache = () => ({
      fetchedAt,
      models: [{ ...model, cost: { input: 7, output: 11 } }],
    });
    const registry = {
      schemaVersion: 5,
      providers: [{
        id: 'curated-groq',
        templateId: 'groq',
        name: 'Curated Groq',
        enabled: true,
        authRef: 'keyring:provider:curated-work',
        defaultAuthRef: 'keyring:provider:curated-default',
        authType: 'oauth' as const,
        activeAuthAccount: 'work',
        defaultModelsCache: curatedCache(),
        authAccounts: {
          work: {
            authRef: 'keyring:provider:curated-work',
            addedAt: fetchedAt,
            modelsCache: curatedCache(),
          },
          alt: {
            authRef: 'keyring:provider:curated-alt',
            addedAt: fetchedAt,
            modelsCache: curatedCache(),
          },
        },
        preserveModelPricing: true,
        api: { npm: '@ai-sdk/groq' },
        addedAt: fetchedAt,
        modelsCache: curatedCache(),
      }, {
        id: 'ordinary-groq',
        templateId: 'groq',
        name: 'Ordinary Groq',
        enabled: true,
        authRef: 'keyring:provider:ordinary-work',
        defaultAuthRef: 'keyring:provider:ordinary-default',
        authType: 'oauth' as const,
        activeAuthAccount: 'work',
        defaultModelsCache: ordinaryCache(),
        authAccounts: {
          work: {
            authRef: 'keyring:provider:ordinary-work',
            addedAt: fetchedAt,
            modelsCache: ordinaryCache(),
          },
          alt: {
            authRef: 'keyring:provider:ordinary-alt',
            addedAt: fetchedAt,
            modelsCache: ordinaryCache(),
          },
        },
        api: { npm: '@ai-sdk/groq' },
        addedAt: fetchedAt,
        modelsCache: ordinaryCache(),
      }],
    };

    expect(applyPricingToRegistryProviders(registry, loadBundledPricingCache())).toBe(true);
    expect(registry.providers[0]?.modelsCache.models[0]?.cost).toEqual({ input: 7, output: 11 });
    expect(registry.providers[0]?.defaultModelsCache.models[0]?.cost).toEqual({ input: 7, output: 11 });
    expect(registry.providers[0]?.authAccounts.work.modelsCache.models[0]?.cost).toEqual({ input: 7, output: 11 });
    expect(registry.providers[0]?.authAccounts.alt.modelsCache.models[0]?.cost).toEqual({ input: 7, output: 11 });
    expect(registry.providers[1]?.modelsCache.models[0]?.cost?.input).toBe(0.59);
    expect(registry.providers[1]?.defaultModelsCache.models[0]?.cost?.input).toBe(0.59);
    expect(registry.providers[1]?.authAccounts.work.modelsCache.models[0]?.cost?.input).toBe(0.59);
    expect(registry.providers[1]?.authAccounts.alt.modelsCache.models[0]?.cost?.input).toBe(0.59);
  });

  it('marks enriched zero-cost models as verified free', () => {
    const index = buildPricingIndex({
      models: [{
        model_id: 'vendor/free-model',
        pricing: [{
          platform: 'openrouter',
          tier: 'standard',
          modality: 'text',
          input_per_1m_tokens: 0,
          output_per_1m_tokens: 0,
        }],
      }],
    });
    const enriched = enrichModelsWithPricing([{
      id: 'vendor/free-model',
      name: 'Free Model',
      upstreamModelId: 'vendor/free-model',
      modelFormat: 'openai',
    }], index, 'openrouter');

    expect(enriched[0]).toMatchObject({
      cost: { input: 0, output: 0 },
      isFree: true,
      freeStatus: 'verified_free',
    });
  });
});

describe('providerPreservesModelPricing', () => {
  it('honours an explicit flag on the provider record', () => {
    expect(providerPreservesModelPricing({ templateId: 'openai', preserveModelPricing: true })).toBe(true);
    expect(providerPreservesModelPricing({ templateId: 'opencode-go', preserveModelPricing: false })).toBe(false);
  });

  it('falls back to the template when the record lost the field', () => {
    // The regression this closes: an older clodex parses providers.json,
    // drops the field it does not know, and saves it back. Without the
    // fallback the setting is gone for good and a curated price is silently
    // replaced by a cache guess on the next enrich — cost display only, which
    // is exactly why nobody would notice.
    expect(providerPreservesModelPricing({ templateId: 'opencode-go' })).toBe(true);
  });

  it('defaults to false for a template that does not ask to keep its prices', () => {
    expect(providerPreservesModelPricing({ templateId: 'openai' })).toBe(false);
    expect(providerPreservesModelPricing({ templateId: 'no-such-template' })).toBe(false);
  });

  // The template fallback above reads ONE mutable field. A record that keeps
  // the canonical OpenCode id while naming another template is still the
  // retained built-in — same credential lineage, same curated catalog — but
  // `getTemplateById('openai')` answers for a provider that never asked to
  // keep its prices, so the curated OpenCode costs are overwritten by a cache
  // guess. Identity has to be the complete one the rest of the registry uses.
  it('keeps curated prices for a retained OpenCode record that names another template', () => {
    expect(providerPreservesModelPricing({ id: 'opencode-go', templateId: 'openai' })).toBe(true);
  });

  it('keeps curated prices for a retained OpenCode record whose id drifted on import', () => {
    expect(providerPreservesModelPricing({ id: 'opencode-go-mirror', templateId: 'opencode-go' })).toBe(true);
  });

  // Explicit policy outranks identity in BOTH directions: the fallback only
  // decides what an absent flag means, so a user who deliberately opted a
  // retained record back into cache pricing keeps that choice.
  it('lets an explicit false outrank retained OpenCode identity', () => {
    expect(providerPreservesModelPricing({
      id: 'opencode-go',
      templateId: 'openai',
      preserveModelPricing: false,
    })).toBe(false);
    expect(providerPreservesModelPricing({
      id: 'opencode-go',
      templateId: 'opencode-go',
      preserveModelPricing: false,
    })).toBe(false);
  });

  it('lets an explicit true outrank an ordinary template that does not preserve', () => {
    expect(providerPreservesModelPricing({
      id: 'ordinary',
      templateId: 'openai',
      preserveModelPricing: true,
    })).toBe(true);
  });

  // Negative: complete identity must not generalize to ordinary providers.
  it('does not preserve prices for ordinary providers or partial records', () => {
    expect(providerPreservesModelPricing({ id: 'my-openai', templateId: 'openai' })).toBe(false);
    expect(providerPreservesModelPricing({ id: 'my-custom', templateId: '' })).toBe(false);
    expect(providerPreservesModelPricing({ id: 'opencode-go-lookalike', templateId: 'no-such-template' })).toBe(false);
  });
});
