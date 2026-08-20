import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import * as io from '../src/registry/io.js';
import * as pricing from '../src/registry/pricing.js';
import type { CachedModel, ProviderRegistry } from '../src/registry/types.js';

vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(),
  loadRegistryStrict: vi.fn(),
  saveRegistry: vi.fn(),
}));

vi.mock('../src/registry/pricing.js', async () => {
  const actual = await vi.importActual<typeof import('../src/registry/pricing.js')>(
    '../src/registry/pricing.js',
  );
  return {
    ...actual,
    loadPricingCache: vi.fn(),
    enrichModelsWithPricing: vi.fn((models: CachedModel[]) => models.map(model => ({
      ...model,
      cost: { input: 999, output: 999 },
    }))),
    enrichPricingAsync: vi.fn(),
    pricingPlatformForProvider: vi.fn(),
    buildPricingIndex: vi.fn(),
  };
});

describe('registry/refresh-models', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('refreshProviderModels (OpenAI OAuth 3-tier fetch)', () => {
    it('Tier 1: uses Codex endpoint if available', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);

      // Codex endpoint returns valid models
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ slug: 'gpt-4', title: 'GPT-4' }]
        }),
      } as Response);

      const result = await refreshProviderModels('openai-oauth', 'mock_token', mockRegistry);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('https://chatgpt.com/backend-api/codex/models?client_version='), expect.anything());
      
      expect(result.ok).toBe(true);
      expect(result.modelCount).toBe(1);
      
      const savedRegistry = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
      const models = savedRegistry.providers[0]?.modelsCache?.models;
      expect(models?.[0]?.id).toBe('gpt-4');
    });

    it('Tier 2: falls back to general endpoint and filters unsupported if Codex fails', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai', // legacy template id, same logic
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);

      // 1. Codex endpoint 404s
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      // 2. General endpoint returns models, including unsupported ones
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { slug: 'gpt-4', title: 'GPT-4' },
            { slug: 'gpt-5.5-fast', title: 'GPT-5.5-fast' } // unsupported
          ]
        }),
      } as Response);

      const result = await refreshProviderModels('openai-oauth', 'mock_token', mockRegistry);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenNthCalledWith(2, 'https://chatgpt.com/backend-api/models', expect.anything());
      const savedRegistry = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
      const models = savedRegistry.providers[0]?.modelsCache?.models;
      console.log('MODELS RETURNED:', models);
      
      expect(result.ok).toBe(true);
      expect(result.modelCount).toBe(1); // the gizmo model is filtered out
      expect(models?.length).toBe(1);
      expect(models?.[0]?.id).toBe('gpt-4');
    });

    it('Tier 3: falls back to static seed if both endpoints fail', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);

      // Both endpoints fail
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const result = await refreshProviderModels('openai-oauth', 'mock_token', mockRegistry);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      expect(result.modelCount).toBeGreaterThan(0); // static seed models
    });

    it('Tier 3: keeps existing cached models instead of overwriting with the static seed', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
          modelsCache: {
            models: [{
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              upstreamModelId: 'gpt-5.6-sol',
              family: 'gpt',
              brand: 'GPT',
              contextWindow: 1_000_000,
              modelFormat: 'openai',
              npm: '@ai-sdk/openai',
              reasoning: true,
            }],
            fetchedAt: Date.now(),
          },
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);

      // Both live endpoints fail — would normally fall back to the static seed.
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const result = await refreshProviderModels('openai-oauth', 'mock_token', mockRegistry);

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.modelCount).toBe(1);
      // The previously cached gpt-5.6-sol model must survive — not overwritten by the
      // older static seed list, and saveRegistry must not have been called.
      expect(io.saveRegistry).not.toHaveBeenCalled();
      expect(mockRegistry.providers[0]?.modelsCache?.models[0]?.id).toBe('gpt-5.6-sol');
    });

    it('retains a cached catalog but rejects a credential refused by both OAuth endpoints', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
          modelsCache: {
            models: [{
              id: 'cached-model',
              name: 'Cached model',
              upstreamModelId: 'cached-model',
              modelFormat: 'openai',
            }],
            fetchedAt: Date.now(),
          },
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      } as Response);

      const result = await refreshProviderModels('openai-oauth', 'rejected-token', mockRegistry);

      expect(result).toMatchObject({
        ok: false,
        modelCount: 1,
        reason: expect.stringContaining('OAuth credential was rejected'),
      });
      expect(io.saveRegistry).not.toHaveBeenCalled();
      expect(mockRegistry.providers[0]?.modelsCache?.models[0]?.id).toBe('cached-model');
    });

    it('captures use_responses_lite / prefer_websockets flags from the live Codex endpoint', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { slug: 'gpt-5.6-luna', title: 'GPT-5.6 Luna', context_window: 272_000, use_responses_lite: true, prefer_websockets: true },
            { slug: 'gpt-5.6-sol', title: 'GPT-5.6 Sol', context_window: 272_000 },
          ],
        }),
      } as Response);

      await refreshProviderModels('openai-oauth', 'mock_token', mockRegistry);

      const savedRegistry = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
      const models = savedRegistry.providers[0]?.modelsCache?.models ?? [];
      const luna = models.find(m => m.id === 'gpt-5.6-luna');
      const sol = models.find(m => m.id === 'gpt-5.6-sol');
      expect(luna?.useResponsesLite).toBe(true);
      expect(luna?.preferWebSockets).toBe(true);
      expect(luna?.contextWindow).toBe(272_000);
      expect(sol?.contextWindow).toBe(272_000);
      // A model the backend does not flag stays on the HTTP path.
      expect(sol?.useResponsesLite).toBeUndefined();
      expect(sol?.preferWebSockets).toBeUndefined();
    });

    // A catalog that omits the ceiling is not one reporting there is none. Treating
    // the two the same is what collapses the `max` stop back onto the standard one,
    // silently, on exactly the accounts where discovery is thinnest.
    it('keeps the seed ceiling when the live catalog reports a window but no ceiling', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { slug: 'gpt-5.6-sol', title: 'GPT-5.6 Sol', context_window: 272_000 },
            { slug: 'codex-auto-review', title: 'Auto Review', context_window: 272_000 },
          ],
        }),
      } as Response);

      await refreshProviderModels('openai-oauth', 'mock_token', mockRegistry);

      const saved = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
      const models = saved.providers[0]?.modelsCache?.models ?? [];
      const sol = models.find(m => m.id === 'gpt-5.6-sol');
      expect(sol?.contextWindow).toBe(272_000);
      expect(sol?.maxContextWindow).toBe(872_000);
      expect(sol?.effectiveContextPercent).toBe(95);
      expect(sol?.pricingBoundary).toBe(272_000);

      // A discovered model outside the seed still gets no invented ceiling.
      const review = models.find(m => m.id === 'codex-auto-review');
      expect(review?.contextWindow).toBe(272_000);
      expect(review?.maxContextWindow).toBeUndefined();
    });

    it('takes the live ceiling and headroom over the seed when the catalog reports them', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{
            slug: 'gpt-5.6-sol',
            title: 'GPT-5.6 Sol',
            context_window: 372_000,
            max_context_window: 2_000_000,
            effective_context_window_percent: 90,
            max_output_tokens: 64_000,
          }],
        }),
      } as Response);

      await refreshProviderModels('openai-oauth', 'mock_token', mockRegistry);

      const saved = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
      const sol = (saved.providers[0]?.modelsCache?.models ?? []).find(m => m.id === 'gpt-5.6-sol');
      expect(sol?.contextWindow).toBe(372_000);
      expect(sol?.maxContextWindow).toBe(2_000_000);
      expect(sol?.effectiveContextPercent).toBe(90);
      expect(sol?.maxOutputTokens).toBe(64_000);
    });

    it('Tier 3: static seed carries Luna capability flags so a discovery outage does not regress it', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
        }],
      };
      vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);

      // Both live endpoints fail → static seed.
      vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 500 } as Response);

      await refreshProviderModels('openai-oauth', 'mock_token', mockRegistry);

      const savedRegistry = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
      const luna = savedRegistry.providers[0]?.modelsCache?.models.find(m => m.id === 'gpt-5.6-luna');
      expect(luna?.contextWindow).toBe(272_000);
      expect(luna?.useResponsesLite).toBe(true);
      expect(luna?.preferWebSockets).toBe(true);
    });

    it('returns error if OAuth token is missing', async () => {
      const mockRegistry: ProviderRegistry = {
        version: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai-oauth',
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring',
          authType: 'oauth',
          api: {},
        }],
      };

      const result = await refreshProviderModels('openai-oauth', null, mockRegistry);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('OAuth token not available');
    });
  });

  it('preserves curated OpenCode pricing when the provider flag is absent', async () => {
    const mockRegistry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        api: {
          npm: '@ai-sdk/openai-compatible',
          url: 'https://opencode.ai/zen/go/v1',
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }],
    };
    vi.mocked(io.loadRegistryStrict).mockReturnValue(mockRegistry);
    vi.mocked(pricing.loadPricingCache).mockReturnValue({ models: [] });
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ]), { status: 200 }));

    expect(pricing.providerPreservesModelPricing(mockRegistry.providers[0]!)).toBe(true);
    const result = await refreshProviderModels('opencode-go', 'oc-real-key', mockRegistry);

    const savedRegistry = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
    const savedModel = savedRegistry.providers[0]?.modelsCache?.models[0];
    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(savedModel?.cost).toEqual({ input: 0.435, output: 0.87, cache_read: 0.003625 });
    expect(pricing.enrichModelsWithPricing).not.toHaveBeenCalled();
  });

    });
