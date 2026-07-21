import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addProviderFromTemplate } from '../src/registry/add-template.js';
import * as env from '../src/env.js';
import * as providerFactory from '../src/provider-factory.js';
import * as fetchTemplate from '../src/registry/fetch-template-models.js';
import * as io from '../src/registry/io.js';
import * as pricing from '../src/registry/pricing.js';
import type { ProviderTemplate } from '../src/provider-templates.js';
import type { ProviderRegistry } from '../src/registry/types.js';

const lockState = vi.hoisted(() => ({ active: false }));

vi.mock('../src/env.js', () => ({ saveProviderCredential: vi.fn() }));
vi.mock('../src/provider-factory.js', () => ({ isSdkMigratedNpm: vi.fn() }));
vi.mock('../src/registry/fetch-template-models.js', () => ({ fetchTemplateModels: vi.fn() }));
vi.mock('../src/registry/io.js', () => ({ loadRegistry: vi.fn(), saveRegistry: vi.fn() }));
vi.mock('../src/registry/pricing.js', () => ({
  loadPricingCache: vi.fn(),
  enrichModelsWithPricing: vi.fn(),
  enrichPricingAsync: vi.fn(),
  pricingPlatformForProvider: vi.fn(),
  buildPricingIndex: vi.fn(),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(async (operation: () => unknown) => {
    if (lockState.active) return operation();
    lockState.active = true;
    try {
      return await operation();
    } finally {
      lockState.active = false;
    }
  }),
}));

describe('registry/add-template', () => {
  const dummyTemplate: ProviderTemplate = {
    id: 'test-template',
    name: 'Test Provider',
    supported: true,
    npm: '@ai-sdk/openai-compatible',
    docsUrl: '',
    authInstructions: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lockState.active = false;

    vi.mocked(providerFactory.isSdkMigratedNpm).mockReturnValue(true);
    vi.mocked(env.saveProviderCredential).mockResolvedValue(true);
    
    vi.mocked(io.loadRegistry).mockReturnValue({
      version: 1,
      providers: [],
    });
    
    vi.mocked(fetchTemplate.fetchTemplateModels).mockResolvedValue({
      models: [{ id: 'model-1', name: 'Model 1', upstreamModelId: 'model-1', family: 'fam', brand: 'brand', modelFormat: 'openai' }],
      baseUrl: 'https://api.example.com',
    });

    vi.mocked(pricing.enrichModelsWithPricing).mockImplementation((models) => models);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails if template is not supported', async () => {
    const tpl = { ...dummyTemplate, supported: false, unsupportedReason: 'Coming soon' };
    const res = await addProviderFromTemplate(tpl, 'key');
    expect(res.added).toBe(false);
    expect(res.error).toBe('Coming soon');
  });

  it('fails if npm is not available', async () => {
    vi.mocked(providerFactory.isSdkMigratedNpm).mockReturnValue(false);
    const res = await addProviderFromTemplate(dummyTemplate, 'key');
    expect(res.added).toBe(false);
    expect(res.error).toContain('is not available in clodex');
  });

  it('fails on empty API key', async () => {
    const res = await addProviderFromTemplate(dummyTemplate, '   ');
    expect(res.added).toBe(false);
    expect(res.error).toBe('API key cannot be empty.');
  });

  it('fails if provider already exists and replaceExisting is not set', async () => {
    vi.mocked(io.loadRegistry).mockReturnValue({
      version: 1,
      providers: [{ id: 'test-template', templateId: 'test-template', name: 'Existing', enabled: true, authType: 'keyring', authRef: 'k', api: {} }],
    });

    const res = await addProviderFromTemplate(dummyTemplate, 'key');
    expect(res.added).toBe(false);
    expect(res.error).toContain('is already configured');
  });

  it('fails if fetching models returns an error', async () => {
    vi.mocked(fetchTemplate.fetchTemplateModels).mockResolvedValue({
      models: [],
      error: 'Network failure',
    });

    const res = await addProviderFromTemplate(dummyTemplate, 'key');
    expect(res.added).toBe(false);
    expect(res.error).toBe('Network failure');
  });

  it('keeps model discovery and background pricing outside the registry lock', async () => {
    vi.mocked(fetchTemplate.fetchTemplateModels).mockImplementation(async () => {
      expect(lockState.active).toBe(false);
      return {
        models: [{ id: 'model-1', name: 'Model 1', upstreamModelId: 'model-1', family: 'fam', brand: 'brand', modelFormat: 'openai' }],
        baseUrl: 'https://api.example.com',
      };
    });
    vi.mocked(pricing.enrichPricingAsync).mockImplementation(() => {
      expect(lockState.active).toBe(false);
    });

    const res = await addProviderFromTemplate(dummyTemplate, 'key');

    expect(res.added).toBe(true);
    expect(fetchTemplate.fetchTemplateModels).toHaveBeenCalledOnce();
    expect(pricing.enrichPricingAsync).toHaveBeenCalledOnce();
  });

  it('revalidates provider existence after model discovery', async () => {
    vi.mocked(io.loadRegistry)
      .mockReturnValueOnce({ schemaVersion: 1, providers: [] })
      .mockReturnValueOnce({
        schemaVersion: 1,
        providers: [{
          id: 'test-template',
          templateId: 'test-template',
          name: 'Concurrent provider',
          enabled: true,
          authType: 'api',
          authRef: 'keyring:provider:test-template',
          api: {},
          addedAt: '2026-01-01T00:00:00.000Z',
        }],
      });

    const res = await addProviderFromTemplate(dummyTemplate, 'key');

    expect(res.added).toBe(false);
    expect(res.error).toContain('is already configured');
    expect(fetchTemplate.fetchTemplateModels).toHaveBeenCalledOnce();
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    expect(io.saveRegistry).not.toHaveBeenCalled();
  });

  it('fails if credential cannot be saved', async () => {
    vi.mocked(env.saveProviderCredential).mockResolvedValue(false);

    const res = await addProviderFromTemplate(dummyTemplate, 'key');
    expect(res.added).toBe(false);
    expect(res.error).toContain('Could not save API key');
  });

  it('successfully adds provider', async () => {
    const res = await addProviderFromTemplate(dummyTemplate, 'key_123');

    expect(res.added).toBe(true);
    expect(res.provider?.id).toBe('test-template');
    expect(res.provider?.name).toBe('Test Provider');
    expect(res.provider?.modelsCache?.models).toHaveLength(1);
    expect(res.modelCount).toBe(1);

    expect(env.saveProviderCredential).toHaveBeenCalledWith('keyring:provider:test-template', 'key_123');
    expect(io.saveRegistry).toHaveBeenCalled();
  });

  it('replaces existing provider if replaceExisting is true', async () => {
    vi.mocked(io.loadRegistry).mockReturnValue({
      version: 1,
      providers: [{ id: 'test-template', templateId: 'test-template', name: 'Existing', enabled: true, authType: 'keyring', authRef: 'k', api: {} }],
    });

    const res = await addProviderFromTemplate(dummyTemplate, 'key_123', { replaceExisting: true });

    expect(res.added).toBe(true);
    
    const savedRegistry = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
    expect(savedRegistry.providers).toHaveLength(1); // Replaced, not duplicated
    expect(savedRegistry.providers[0]?.name).toBe('Test Provider');
  });
});
