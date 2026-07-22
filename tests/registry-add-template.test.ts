import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addProviderFromTemplate } from '../src/registry/add-template.js';
import * as env from '../src/env.js';
import * as providerFactory from '../src/provider-factory.js';
import * as fetchTemplate from '../src/registry/fetch-template-models.js';
import * as io from '../src/registry/io.js';
import * as cleanupJournal from '../src/registry/credential-cleanup-journal.js';
import * as pricing from '../src/registry/pricing.js';
import type { ProviderTemplate } from '../src/provider-templates.js';
import type { ProviderRegistry } from '../src/registry/types.js';

const lockState = vi.hoisted(() => ({
  active: false,
  registryTail: Promise.resolve(),
  credentialActive: false,
  credentialTails: new Map<string, Promise<void>>(),
  afterRegistryUnlock: null as null | (() => void),
}));
const journalState = vi.hoisted(() => ({
  pending: new Set<string>(),
}));
let registryState: ProviderRegistry;

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    deleteProviderCredential: vi.fn(),
    saveProviderCredential: vi.fn(),
  };
});
vi.mock('../src/provider-factory.js', () => ({ isSdkMigratedNpm: vi.fn() }));
vi.mock('../src/registry/fetch-template-models.js', () => ({ fetchTemplateModels: vi.fn() }));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(),
  loadRegistryStrict: vi.fn(),
  saveRegistry: vi.fn(),
}));
vi.mock('../src/registry/credential-cleanup-journal.js', () => ({
  isStoredCredentialRef: vi.fn((authRef: string) =>
    authRef.startsWith('keyring:') || authRef.startsWith('helper:v1:')),
  loadPendingCredentialDeletes: vi.fn(async () => [...journalState.pending]),
  queueCredentialDelete: vi.fn(async (authRef: string) => {
    if (!authRef.startsWith('keyring:') && !authRef.startsWith('helper:v1:')) return false;
    journalState.pending.add(authRef);
    return true;
  }),
  cancelCredentialDelete: vi.fn(async (authRef: string) =>
    journalState.pending.delete(authRef)),
}));
vi.mock('../src/registry/pricing.js', () => ({
  loadPricingCache: vi.fn(),
  enrichModelsWithPricing: vi.fn(),
  enrichPricingAsync: vi.fn(),
  pricingPlatformForProvider: vi.fn(),
  buildPricingIndex: vi.fn(),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(async (operation: () => unknown) => {
    const previous = lockState.registryTail;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    lockState.registryTail = previous.then(() => gate);
    await previous;
    lockState.active = true;
    try {
      return await operation();
    } finally {
      lockState.active = false;
      release();
      const afterUnlock = lockState.afterRegistryUnlock;
      lockState.afterRegistryUnlock = null;
      afterUnlock?.();
    }
  }),
  withCredentialMutationLock: vi.fn(async (
    authRef: string,
    operation: () => unknown,
  ) => {
    const previous = lockState.credentialTails.get(authRef) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    lockState.credentialTails.set(authRef, tail);
    await previous;
    lockState.credentialActive = true;
    try {
      return await operation();
    } finally {
      lockState.credentialActive = false;
      release();
      if (lockState.credentialTails.get(authRef) === tail) {
        lockState.credentialTails.delete(authRef);
      }
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
    lockState.registryTail = Promise.resolve();
    lockState.credentialActive = false;
    lockState.credentialTails.clear();
    lockState.afterRegistryUnlock = null;
    journalState.pending.clear();

    vi.mocked(providerFactory.isSdkMigratedNpm).mockReturnValue(true);
    vi.mocked(env.deleteProviderCredential).mockResolvedValue(true);
    vi.mocked(env.saveProviderCredential).mockResolvedValue(true);
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes).mockReset()
      .mockImplementation(async () => [...journalState.pending]);
    vi.mocked(cleanupJournal.queueCredentialDelete).mockClear();
    vi.mocked(cleanupJournal.cancelCredentialDelete).mockClear();
    registryState = {
      schemaVersion: 1,
      providers: [],
    };
    vi.mocked(io.loadRegistry).mockReset().mockImplementation(() =>
      structuredClone(registryState));
    vi.mocked(io.loadRegistryStrict).mockReset().mockImplementation(() =>
      structuredClone(registryState));
    vi.mocked(io.saveRegistry).mockReset().mockImplementation((registry) => {
      if (!lockState.active) throw new Error('registry write escaped its lock');
      registryState = structuredClone(registry);
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
      schemaVersion: 1,
      providers: [{
        id: 'test-template',
        templateId: 'test-template',
        name: 'Existing',
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
    vi.mocked(env.saveProviderCredential).mockImplementation(async () => {
      expect(lockState.active).toBe(false);
      expect(lockState.credentialActive).toBe(true);
      return true;
    });

    const res = await addProviderFromTemplate(dummyTemplate, 'key');

    expect(res.added).toBe(true);
    expect(fetchTemplate.fetchTemplateModels).toHaveBeenCalledOnce();
    expect(pricing.enrichPricingAsync).toHaveBeenCalledOnce();
  });

  it('serializes concurrent writes to the same provider credential', async () => {
    let registry: ProviderRegistry = { schemaVersion: 1, providers: [] };
    vi.mocked(io.loadRegistry).mockImplementation(() =>
      structuredClone(registry));
    vi.mocked(io.saveRegistry).mockImplementation((next) => {
      registry = structuredClone(next);
    });

    const results = await Promise.all([
      addProviderFromTemplate(dummyTemplate, 'first-key'),
      addProviderFromTemplate(dummyTemplate, 'second-key'),
    ]);

    expect(results.filter(result => result.added)).toHaveLength(1);
    expect(results.filter(result => !result.added)).toHaveLength(1);
    expect(env.saveProviderCredential).toHaveBeenCalledOnce();
    const [savedAuthRef, savedKey] = vi.mocked(env.saveProviderCredential).mock.calls[0]!;
    expect(savedAuthRef).toBe('keyring:provider:test-template');
    expect(['first-key', 'second-key']).toContain(savedKey);
    expect(registry.providers).toHaveLength(1);
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
    expect(cleanupJournal.queueCredentialDelete).toHaveBeenCalledWith(
      'keyring:provider:test-template',
    );
    expect(env.deleteProviderCredential).toHaveBeenCalledWith('keyring:provider:test-template');
    expect(journalState.pending.size).toBe(0);
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

  it('represents optional no-key access without a stored credential reference', async () => {
    const anonymousTemplate = { ...dummyTemplate, apiKeyOptional: true };

    const res = await addProviderFromTemplate(anonymousTemplate, '');

    expect(res.added).toBe(true);
    expect(res.provider).toMatchObject({
      authRef: 'none:anonymous',
      authType: 'none',
    });
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    const savedRegistry = vi.mocked(io.saveRegistry).mock.calls.at(-1)?.[0] as ProviderRegistry;
    expect(savedRegistry.providers[0]?.authRef).toBe('none:anonymous');
  });

  it('never sends an anonymous reference to credential deletion', async () => {
    const anonymousTemplate = { ...dummyTemplate, apiKeyOptional: true };

    const res = await addProviderFromTemplate(anonymousTemplate, '');

    expect(res.added).toBe(true);
    expect(res.provider?.authRef).toBe('none:anonymous');
    expect(env.deleteProviderCredential).not.toHaveBeenCalled();
  });

  it('persists free-only filtering for anonymous free-model access', async () => {
    const anonymousTemplate = {
      ...dummyTemplate,
      apiKeyOptional: true,
      anonymousFreeModels: true,
    };
    vi.mocked(fetchTemplate.fetchTemplateModels).mockResolvedValue({
      models: [{
        id: 'free-model',
        name: 'Free Model',
        upstreamModelId: 'free-model',
        family: 'fam',
        brand: 'brand',
        modelFormat: 'openai',
        isFree: true,
      }],
      baseUrl: 'https://api.example.com',
    });

    const res = await addProviderFromTemplate(anonymousTemplate, '');

    expect(res.added).toBe(true);
    expect(res.provider).toMatchObject({
      authRef: 'none:anonymous',
      authType: 'none',
      subscriptionFilter: 'free',
    });
    expect(res.modelCount).toBe(1);
  });

  it('replaces existing provider if replaceExisting is true', async () => {
    registryState = {
      schemaVersion: 1,
      providers: [{
        id: 'test-template',
        templateId: 'test-template',
        name: 'Existing',
        enabled: true,
        authType: 'api',
        authRef: 'keyring:provider:test-template',
        api: {},
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };

    const res = await addProviderFromTemplate(dummyTemplate, 'key_123', { replaceExisting: true });

    expect(res.added).toBe(true);
    
    const savedRegistry = vi.mocked(io.saveRegistry).mock.calls.at(-1)?.[0] as ProviderRegistry;
    expect(savedRegistry.providers).toHaveLength(1); // Replaced, not duplicated
    expect(savedRegistry.providers[0]?.name).toBe('Test Provider');
    expect(savedRegistry.providers[0]?.authRef).toMatch(
      /^keyring:provider:test-template:replacement:/,
    );
    expect(env.deleteProviderCredential).toHaveBeenCalledWith('keyring:provider:test-template');
  });

  it('retains a removal marker queued immediately after replacement commit', async () => {
    registryState = {
      schemaVersion: 1,
      providers: [{
        id: 'test-template',
        templateId: 'test-template',
        name: 'Existing',
        enabled: true,
        authType: 'api',
        authRef: 'keyring:provider:test-template',
        api: {},
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    const cancellationLockStates: boolean[] = [];
    vi.mocked(cleanupJournal.cancelCredentialDelete).mockImplementationOnce(
      async authRef => {
        cancellationLockStates.push(lockState.active);
        return journalState.pending.delete(authRef);
      },
    );
    vi.mocked(env.deleteProviderCredential).mockResolvedValue(false);
    vi.mocked(io.saveRegistry).mockImplementationOnce(registry => {
      if (!lockState.active) throw new Error('registry write escaped its lock');
      registryState = structuredClone(registry);
      const replacementRef = registry.providers[0]?.authRef;
      lockState.afterRegistryUnlock = () => {
        registryState.providers = [];
        if (replacementRef) journalState.pending.add(replacementRef);
      };
    });

    const result = await addProviderFromTemplate(dummyTemplate, 'replacement-key', {
      replaceExisting: true,
    });
    const replacementRef = result.provider?.authRef;

    expect(cancellationLockStates).toEqual([true]);
    expect(replacementRef).toMatch(
      /^keyring:provider:test-template:replacement:/,
    );
    expect(journalState.pending).toContain(replacementRef);
    expect(result.credentialCleanupPending).toBe(true);
  });

  it('keeps a failed replacement journaled without changing the active provider', async () => {
    registryState = {
      schemaVersion: 1,
      providers: [{
        id: 'test-template',
        templateId: 'test-template',
        name: 'Existing',
        enabled: true,
        authType: 'api',
        authRef: 'keyring:provider:test-template',
        api: {},
        addedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    vi.mocked(io.saveRegistry).mockImplementationOnce(() => {
      throw new Error('activation failed');
    });

    await expect(
      addProviderFromTemplate(dummyTemplate, 'replacement-key', {
        replaceExisting: true,
      }),
    ).rejects.toThrow('activation failed');

    expect(registryState.providers[0]?.authRef).toBe('keyring:provider:test-template');
    expect([...journalState.pending]).toEqual([
      expect.stringMatching(/^keyring:provider:test-template:replacement:/),
      'keyring:provider:test-template',
    ]);
    expect(env.deleteProviderCredential).not.toHaveBeenCalled();
  });

  it('reports cleanup pending instead of failing after provider commit', async () => {
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes).mockRejectedValue(
      new Error('cleanup journal lock timed out'),
    );

    const result = await addProviderFromTemplate(dummyTemplate, 'key');

    expect(result.added).toBe(true);
    expect(result.credentialCleanupPending).toBe(true);
    expect(registryState.providers).toHaveLength(1);
  });
});
