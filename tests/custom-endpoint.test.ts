import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';

const registryState = vi.hoisted(() => ({
  current: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));
const lockState = vi.hoisted(() => ({
  active: false,
  entries: 0,
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  saveProviderCredential: vi.fn(),
}));
vi.mock('../src/registry/fetch-template-models.js', () => ({
  fetchTemplateModels: vi.fn(),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => structuredClone(registryState.current)),
  saveRegistry: vi.fn((registry: ProviderRegistry) => {
    registryState.current = structuredClone(registry);
  }),
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
    }
  }),
}));
vi.mock('../src/registry/url-security.js', () => ({
  validateCustomEndpointUrl: vi.fn(),
}));

import {
  clodexKeyEnvVar,
  resolveProviderCredential,
  saveProviderCredential,
} from '../src/env.js';
import {
  addCustomEndpointProvider,
  fetchAnthropicModels,
} from '../src/registry/custom-endpoint.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
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

describe('custom endpoint registry updates', () => {
  beforeEach(() => {
    registryState.current = { schemaVersion: 1, providers: [] };
    lockState.active = false;
    lockState.entries = 0;

    vi.mocked(saveProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(fetchTemplateModels).mockReset().mockResolvedValue(successfulDiscovery());
    vi.mocked(validateCustomEndpointUrl).mockReset().mockResolvedValue({
      ok: true,
      normalizedUrl: endpointInput.baseUrl,
    });
    vi.mocked(saveRegistry)
      .mockReset()
      .mockImplementation((registry) => {
        registryState.current = structuredClone(registry);
      });
  });

  afterEach(() => {
    delete process.env[clodexKeyEnvVar('custom-test-endpoint')];
    vi.unstubAllGlobals();
  });

  it('discovers models before entering the registry write lock', async () => {
    const observedLockStates: boolean[] = [];
    vi.mocked(fetchTemplateModels).mockImplementation(async () => {
      observedLockStates.push(lockState.active);
      return successfulDiscovery();
    });

    const result = await addCustomEndpointProvider(endpointInput);

    expect(result.added).toBe(true);
    expect(observedLockStates).toEqual([false]);
    expect(lockState.entries).toBe(1);
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
    expect(saveProviderCredential).toHaveBeenCalledWith(
      'keyring:provider:custom-test-endpoint-2',
      endpointInput.apiKey,
    );
    expect(registryState.current.providers.map((provider) => provider.id)).toEqual([
      'custom-test-endpoint',
      'custom-test-endpoint-2',
    ]);
  });
});
