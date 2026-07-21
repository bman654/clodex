import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';

const registryState = vi.hoisted(() => ({
  current: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));
const lockState = vi.hoisted(() => ({
  active: false,
  credentialActive: false,
  credentialTails: new Map<string, Promise<void>>(),
}));

vi.mock('../src/env.js', () => ({
  deleteProviderCredential: vi.fn(),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => structuredClone(registryState.current)),
  saveRegistry: vi.fn((registry: ProviderRegistry) => {
    if (!lockState.active) throw new Error('registry write escaped its lock');
    registryState.current = structuredClone(registry);
  }),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(
    async <T>(operation: () => Promise<T> | T): Promise<T> => {
      if (lockState.active) throw new Error('registry lock re-entered');
      lockState.active = true;
      try {
        return await operation();
      } finally {
        lockState.active = false;
      }
    },
  ),
  withCredentialMutationLock: vi.fn(async <T>(
    authRef: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
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
  withRegistryWriteLockSync: vi.fn(),
}));

import { deleteProviderCredential } from '../src/env.js';
import { removeProviderFromRegistry } from '../src/registry/crud.js';
import {
  withCredentialMutationLock,
  withRegistryWriteLock,
} from '../src/registry/lock.js';

describe('registry provider removal', () => {
  beforeEach(() => {
    lockState.active = false;
    lockState.credentialActive = false;
    lockState.credentialTails.clear();
    registryState.current = {
      schemaVersion: 1,
      providers: [
        {
          id: 'openai',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring:provider:openai',
          authType: 'api',
          api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
          addedAt: '2026-07-21T00:00:00.000Z',
        },
      ],
    };
    vi.mocked(deleteProviderCredential).mockReset().mockImplementation(
      async () => {
        expect(lockState.active).toBe(false);
        expect(lockState.credentialActive).toBe(true);
        return true;
      },
    );
  });

  it('commits the registry mutation before deleting the credential outside the lock', async () => {
    const result = await removeProviderFromRegistry('openai');

    expect(result).toMatchObject({
      removed: true,
      credentialDeleted: true,
    });
    expect(registryState.current.providers).toHaveLength(0);
    expect(deleteProviderCredential).toHaveBeenCalledWith(
      'keyring:provider:openai',
    );
    expect(lockState.active).toBe(false);
  });

  it('serializes deletion against reattaching the same credential reference', async () => {
    let startDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      startDelete = resolve;
    });
    let finishDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    let credentialValue: string | null = 'old-key';
    vi.mocked(deleteProviderCredential).mockImplementation(async () => {
      startDelete();
      await deleteGate;
      credentialValue = null;
      return true;
    });

    const removal = removeProviderFromRegistry('openai');
    await deleteStarted;
    let replacementEntered = false;
    const replacement = withCredentialMutationLock(
      'keyring:provider:openai',
      async () => {
        replacementEntered = true;
        credentialValue = 'new-key';
        await withRegistryWriteLock(() => {
          registryState.current.providers.push({
            id: 'openai',
            templateId: 'openai',
            name: 'OpenAI',
            enabled: true,
            authRef: 'keyring:provider:openai',
            authType: 'api',
            api: {
              npm: '@ai-sdk/openai',
              url: 'https://api.openai.com/v1',
            },
            addedAt: '2026-07-21T01:00:00.000Z',
          });
        });
      },
    );

    await Promise.resolve();
    expect(replacementEntered).toBe(false);
    finishDelete();
    await Promise.all([removal, replacement]);

    expect(credentialValue).toBe('new-key');
    expect(registryState.current.providers).toHaveLength(1);
  });
});
