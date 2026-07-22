import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';

const registryState = vi.hoisted(() => ({
  current: { schemaVersion: 1, providers: [] } as ProviderRegistry,
  persisted: [] as ProviderRegistry[],
}));
const lockState = vi.hoisted(() => ({
  active: false,
  credentialActive: false,
  entries: 0,
  afterRegistryUnlock: null as null | (() => void),
}));
const journalState = vi.hoisted(() => ({
  pending: new Set<string>(),
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  deleteProviderCredential: vi.fn(),
  saveProviderCredential: vi.fn(),
}));
vi.mock('../src/registry/fetch-template-models.js', () => ({
  fetchTemplateModels: vi.fn(),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => structuredClone(registryState.current)),
  loadRegistryStrict: vi.fn(() => structuredClone(registryState.current)),
  saveRegistry: vi.fn((registry: ProviderRegistry) => {
    if (!lockState.active) throw new Error('registry write escaped its lock');
    registryState.current = structuredClone(registry);
    registryState.persisted.push(structuredClone(registry));
  }),
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
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(async <T>(operation: () => Promise<T> | T): Promise<T> => {
    lockState.entries += 1;
    if (lockState.active) throw new Error('registry lock re-entered');
    lockState.active = true;
    try {
      return await operation();
    } finally {
      lockState.active = false;
      const afterUnlock = lockState.afterRegistryUnlock;
      lockState.afterRegistryUnlock = null;
      afterUnlock?.();
    }
  }),
  withCredentialMutationLock: vi.fn(async <T>(
    _authRef: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    if (lockState.credentialActive) {
      throw new Error('credential lock re-entered');
    }
    lockState.credentialActive = true;
    try {
      return await operation();
    } finally {
      lockState.credentialActive = false;
    }
  }),
}));
vi.mock('../src/registry/url-security.js', () => ({
  validateCustomEndpointUrl: vi.fn(),
}));

import {
  clodexKeyEnvVar,
  deleteProviderCredential,
  resolveProviderCredential,
  saveProviderCredential,
} from '../src/env.js';
import {
  addCustomEndpointProvider,
  fetchAnthropicModels,
} from '../src/registry/custom-endpoint.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import * as cleanupJournal from '../src/registry/credential-cleanup-journal.js';
import { saveRegistry } from '../src/registry/io.js';
import { validateCustomEndpointUrl } from '../src/registry/url-security.js';

const endpointInput = {
  displayName: 'Test Endpoint',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  kind: 'openai' as const,
};

function successfulDiscovery() {
  return {
    models: [
      {
        id: 'model-1',
        name: 'Model 1',
        upstreamModelId: 'model-1',
        family: 'test',
        brand: 'test',
        modelFormat: 'openai' as const,
      },
    ],
    baseUrl: endpointInput.baseUrl,
  };
}

describe('custom endpoint credential lifecycle', () => {
  const previousHelper = process.env.CLODEX_CREDENTIAL_HELPER;

  beforeEach(() => {
    delete process.env.CLODEX_CREDENTIAL_HELPER;
    registryState.current = { schemaVersion: 1, providers: [] };
    registryState.persisted = [];
    lockState.active = false;
    lockState.credentialActive = false;
    lockState.entries = 0;
    lockState.afterRegistryUnlock = null;
    journalState.pending.clear();

    vi.mocked(deleteProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(saveProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes).mockReset()
      .mockImplementation(async () => [...journalState.pending]);
    vi.mocked(cleanupJournal.queueCredentialDelete).mockClear();
    vi.mocked(cleanupJournal.cancelCredentialDelete).mockClear();
    vi.mocked(fetchTemplateModels).mockReset().mockResolvedValue(successfulDiscovery());
    vi.mocked(validateCustomEndpointUrl).mockReset().mockResolvedValue({
      ok: true,
      normalizedUrl: endpointInput.baseUrl,
    });
    vi.mocked(saveRegistry)
      .mockReset()
      .mockImplementation((registry) => {
        if (!lockState.active) throw new Error('registry write escaped its lock');
        registryState.current = structuredClone(registry);
        registryState.persisted.push(structuredClone(registry));
      });
  });

  afterEach(() => {
    delete process.env[clodexKeyEnvVar('custom-test-endpoint')];
    vi.unstubAllGlobals();
    if (previousHelper === undefined) delete process.env.CLODEX_CREDENTIAL_HELPER;
    else process.env.CLODEX_CREDENTIAL_HELPER = previousHelper;
  });

  it('discovers models before entering the registry write lock', async () => {
    const observedLockStates: boolean[] = [];
    vi.mocked(fetchTemplateModels).mockImplementation(async () => {
      observedLockStates.push(lockState.active);
      return successfulDiscovery();
    });
    vi.mocked(saveProviderCredential).mockImplementation(async () => {
      observedLockStates.push(lockState.active);
      expect(lockState.credentialActive).toBe(true);
      return true;
    });

    const result = await addCustomEndpointProvider(endpointInput);

    expect(result.added).toBe(true);
    expect(observedLockStates).toEqual([false, false]);
    expect(lockState.entries).toBeGreaterThanOrEqual(1);
    expect(lockState.active).toBe(false);
  });

  it('represents a blank key as anonymous without writing a placeholder credential', async () => {
    process.env[clodexKeyEnvVar('custom-test-endpoint')] = 'stale-provider-key';
    const result = await addCustomEndpointProvider({
      ...endpointInput,
      apiKey: '   ',
    });

    expect(result).toMatchObject({
      added: true,
      provider: {
        authRef: 'none:anonymous',
        authType: 'none',
      },
    });
    expect(fetchTemplateModels).toHaveBeenCalledWith(
      expect.objectContaining({ authType: 'none' }),
      '',
      endpointInput.baseUrl,
      undefined,
    );
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(registryState.current.providers[0]).toMatchObject({
      authRef: 'none:anonymous',
      authType: 'none',
    });
    await expect(resolveProviderCredential(
      result.provider!.id,
      result.provider!.authRef,
    )).resolves.toBeNull();
  });

  it('omits the Anthropic API key header for anonymous discovery', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'local-model', name: 'Local Model' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAnthropicModels('https://local.example/v1', '');

    expect(result.models).toHaveLength(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).has('x-api-key')).toBe(false);
  });

  it('allocates the provider id from state reloaded after discovery', async () => {
    vi.mocked(fetchTemplateModels).mockImplementation(async () => {
      registryState.current.providers.push({
        id: 'custom-test-endpoint',
        templateId: 'custom-openai',
        name: 'Concurrent endpoint',
        enabled: true,
        authRef: 'keyring:provider:custom-test-endpoint',
        api: { npm: '@ai-sdk/openai-compatible', url: endpointInput.baseUrl },
        addedAt: '2026-01-01T00:00:00.000Z',
      });
      return successfulDiscovery();
    });

    const result = await addCustomEndpointProvider(endpointInput);

    expect(result).toMatchObject({
      added: true,
      provider: { id: 'custom-test-endpoint-2' },
    });
    expect(result.provider?.authRef).toMatch(
      /^keyring:provider:custom-test-endpoint:[0-9a-f-]{36}$/,
    );
    expect(saveProviderCredential).toHaveBeenCalledWith(
      result.provider?.authRef,
      endpointInput.apiKey,
    );
    expect(registryState.current.providers.map((provider) => provider.id)).toEqual([
      'custom-test-endpoint',
      'custom-test-endpoint-2',
    ]);
  });

  it('does not persist registry or credential state when model discovery fails', async () => {
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      models: [],
      error: 'Network discovery failed.',
      hint: 'Check the endpoint.',
    });
    const initialRegistry = structuredClone(registryState.current);

    const result = await addCustomEndpointProvider(endpointInput);

    expect(result).toMatchObject({
      added: false,
      error: 'Network discovery failed.',
      hint: 'Check the endpoint.',
    });
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
    expect(lockState.entries).toBe(0);
    expect(registryState.current).toEqual(initialRegistry);
  });

  it('cleans the journal without activating a provider when credential writing fails', async () => {
    vi.mocked(saveProviderCredential).mockResolvedValue(false);

    const result = await addCustomEndpointProvider(endpointInput);

    const authRef = vi.mocked(saveProviderCredential).mock.calls[0]?.[0];
    expect(authRef).toMatch(
      /^keyring:provider:custom-test-endpoint:[0-9a-f-]{36}$/,
    );
    expect(result).toMatchObject({
      added: false,
      error: 'Could not save API key to the credential store.',
    });
    expect(cleanupJournal.queueCredentialDelete).toHaveBeenCalledWith(authRef);
    expect(saveProviderCredential).toHaveBeenCalledWith(authRef!, endpointInput.apiKey);
    expect(deleteProviderCredential).toHaveBeenCalledWith(authRef!);
    expect(registryState.current.providers).toEqual([]);
    expect(journalState.pending.size).toBe(0);
  });

  it('leaves the written credential journaled when provider activation cannot be saved', async () => {
    vi.mocked(saveRegistry).mockImplementationOnce(() => {
      throw new Error('activation failed');
    });

    await expect(addCustomEndpointProvider(endpointInput)).rejects.toThrow('activation failed');

    const authRef = vi.mocked(saveProviderCredential).mock.calls[0]?.[0];
    expect(authRef).toMatch(
      /^keyring:provider:custom-test-endpoint:[0-9a-f-]{36}$/,
    );
    expect(saveProviderCredential).toHaveBeenCalledWith(authRef!, endpointInput.apiKey);
    expect(registryState.current.providers).toEqual([]);
    expect(journalState.pending).toEqual(new Set([authRef]));
    expect(deleteProviderCredential).not.toHaveBeenCalled();
  });

  it('retries pending cleanup on the next successful custom endpoint addition', async () => {
    const staleAuthRef = 'keyring:provider:stale-endpoint';
    journalState.pending.add(staleAuthRef);
    vi.mocked(deleteProviderCredential).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const first = await addCustomEndpointProvider(endpointInput);

    expect(first.added).toBe(true);
    expect(first.credentialCleanupPending).toBe(true);
    expect([...journalState.pending]).toEqual([staleAuthRef]);

    const second = await addCustomEndpointProvider({
      ...endpointInput,
      displayName: 'Second Endpoint',
    });

    expect(second.added).toBe(true);
    expect(second.credentialCleanupPending).toBe(false);
    expect(deleteProviderCredential).toHaveBeenNthCalledWith(1, staleAuthRef);
    expect(deleteProviderCredential).toHaveBeenNthCalledWith(2, staleAuthRef);
    expect(registryState.current.providers).toHaveLength(2);
    expect(journalState.pending.size).toBe(0);
  });

  it('retains a removal marker queued immediately after endpoint commit', async () => {
    const cancellationLockStates: boolean[] = [];
    vi.mocked(cleanupJournal.cancelCredentialDelete).mockImplementationOnce(
      async authRef => {
        cancellationLockStates.push(lockState.active);
        return journalState.pending.delete(authRef);
      },
    );
    vi.mocked(deleteProviderCredential).mockResolvedValue(false);
    vi.mocked(saveRegistry).mockImplementationOnce(registry => {
      if (!lockState.active) throw new Error('registry write escaped its lock');
      registryState.current = structuredClone(registry);
      registryState.persisted.push(structuredClone(registry));
      const authRef = registry.providers[0]?.authRef;
      lockState.afterRegistryUnlock = () => {
        registryState.current.providers = [];
        if (authRef) journalState.pending.add(authRef);
      };
    });

    const result = await addCustomEndpointProvider(endpointInput);
    const authRef = result.provider?.authRef;

    expect(cancellationLockStates).toEqual([true]);
    expect(authRef).toMatch(
      /^keyring:provider:custom-test-endpoint:[0-9a-f-]{36}$/,
    );
    expect(journalState.pending).toContain(authRef);
    expect(result.credentialCleanupPending).toBe(true);
  });

  it('reports cleanup pending instead of rejecting after endpoint commit', async () => {
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes).mockRejectedValue(
      new Error('cleanup journal lock timed out'),
    );

    const result = await addCustomEndpointProvider(endpointInput);

    expect(result.added).toBe(true);
    expect(result.credentialCleanupPending).toBe(true);
    expect(registryState.current.providers).toHaveLength(1);
  });
});
