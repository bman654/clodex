import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';

const registryState = vi.hoisted(() => ({
  current: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));
const lockState = vi.hoisted(() => ({
  registryActive: false,
  credentialActive: null as string | null,
  credentialTails: new Map<string, Promise<void>>(),
  events: [] as string[],
}));

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    deleteProviderCredential: vi.fn(),
  };
});
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => structuredClone(registryState.current)),
  saveRegistry: vi.fn((registry: ProviderRegistry) => {
    if (!lockState.registryActive) throw new Error('registry write escaped its lock');
    registryState.current = structuredClone(registry);
  }),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(async <T>(operation: () => Promise<T> | T): Promise<T> => {
    if (lockState.registryActive) throw new Error('registry lock re-entered');
    lockState.events.push('registry:enter');
    lockState.registryActive = true;
    try {
      return await operation();
    } finally {
      lockState.registryActive = false;
      lockState.events.push('registry:exit');
    }
  }),
  withCredentialMutationLock: vi.fn(async <T>(
    authRef: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const previous = lockState.credentialTails.get(authRef) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    lockState.credentialTails.set(authRef, tail);
    await previous;
    if (lockState.credentialActive !== null) {
      throw new Error(`nested credential lock: ${lockState.credentialActive} -> ${authRef}`);
    }
    lockState.credentialActive = authRef;
    lockState.events.push(`credential:enter:${authRef}`);
    try {
      return await operation();
    } finally {
      lockState.events.push(`credential:exit:${authRef}`);
      lockState.credentialActive = null;
      release();
      if (lockState.credentialTails.get(authRef) === tail) {
        lockState.credentialTails.delete(authRef);
      }
    }
  }),
}));

import { deleteProviderCredential } from '../src/env.js';
import {
  cancelCredentialDelete,
  queueCredentialDelete,
  reconcilePendingCredentialDeletes,
} from '../src/registry/credential-lifecycle.js';
import { saveRegistry } from '../src/registry/io.js';

const TEST_HELPER_ID = 'a'.repeat(64);
const helperRef = (account: string): string => `helper:v1:${TEST_HELPER_ID}:${account}`;

describe('credential cleanup lifecycle', () => {
  beforeEach(() => {
    registryState.current = { schemaVersion: 1, providers: [] };
    lockState.registryActive = false;
    lockState.credentialActive = null;
    lockState.credentialTails.clear();
    lockState.events = [];
    vi.mocked(deleteProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(saveRegistry).mockReset().mockImplementation(registry => {
      if (!lockState.registryActive) throw new Error('registry write escaped its lock');
      registryState.current = structuredClone(registry);
    });
  });

  it('queues only unreferenced stored credentials', () => {
    registryState.current.providers.push({
      id: 'active',
      templateId: 'active',
      name: 'Active',
      enabled: true,
      authRef: helperRef('provider:active'),
      api: {},
      addedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(queueCredentialDelete(registryState.current, helperRef('provider:active'))).toBe(false);
    expect(queueCredentialDelete(registryState.current, 'env:OPENAI_API_KEY')).toBe(false);
    expect(queueCredentialDelete(registryState.current, helperRef('provider:stale'))).toBe(true);
    expect(queueCredentialDelete(registryState.current, helperRef('provider:stale'))).toBe(false);
    expect(registryState.current.pendingCredentialDeletes).toEqual([helperRef('provider:stale')]);
  });

  it('clears successful deletions while retaining failed and thrown deletions', async () => {
    registryState.current.pendingCredentialDeletes = [
      helperRef('provider:deleted'),
      helperRef('provider:failed'),
      'keyring:provider:thrown',
    ];
    vi.mocked(deleteProviderCredential).mockImplementation(async authRef => {
      expect(lockState.registryActive).toBe(false);
      expect(lockState.credentialActive).toBe(authRef);
      lockState.events.push(`delete:${authRef}`);
      if (authRef.endsWith(':deleted')) return true;
      if (authRef.endsWith(':thrown')) throw new Error('response lost');
      return false;
    });

    const result = await reconcilePendingCredentialDeletes();

    expect(result.deleted).toEqual([helperRef('provider:deleted')]);
    expect(result.pending).toEqual([
      helperRef('provider:failed'),
      'keyring:provider:thrown',
    ]);
    expect(registryState.current.pendingCredentialDeletes).toEqual(result.pending);
    for (const authRef of [
      helperRef('provider:deleted'),
      helperRef('provider:failed'),
      'keyring:provider:thrown',
    ]) {
      const entered = lockState.events.indexOf(`credential:enter:${authRef}`);
      const deletedAt = lockState.events.indexOf(`delete:${authRef}`);
      const exited = lockState.events.indexOf(`credential:exit:${authRef}`);
      expect(entered).toBeGreaterThanOrEqual(0);
      expect(deletedAt).toBeGreaterThan(entered);
      expect(exited).toBeGreaterThan(deletedAt);
    }
  });

  it('never deletes a credential that became active again', async () => {
    registryState.current.providers.push({
      id: 'active',
      templateId: 'active',
      name: 'Active',
      enabled: true,
      authRef: helperRef('provider:active'),
      api: {},
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    registryState.current.pendingCredentialDeletes = [helperRef('provider:active')];

    const result = await reconcilePendingCredentialDeletes();

    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(result.pending).toEqual([]);
    expect(registryState.current.pendingCredentialDeletes).toBeUndefined();
  });

  it('keeps the durable marker when clearing it cannot be saved', async () => {
    registryState.current.pendingCredentialDeletes = [helperRef('provider:stale')];
    vi.mocked(saveRegistry).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const failed = await reconcilePendingCredentialDeletes();
    expect(failed.persistenceError).toContain('disk full');
    expect(failed.pending).toEqual([helperRef('provider:stale')]);
    expect(registryState.current.pendingCredentialDeletes).toEqual([helperRef('provider:stale')]);

    vi.mocked(saveRegistry).mockImplementation(registry => {
      registryState.current = structuredClone(registry);
    });
    const retried = await reconcilePendingCredentialDeletes();
    expect(retried.pending).toEqual([]);
    expect(registryState.current.pendingCredentialDeletes).toBeUndefined();
  });

  it('can cancel a pending deletion when a credential becomes active', () => {
    registryState.current.pendingCredentialDeletes = [helperRef('provider:new')];
    expect(cancelCredentialDelete(registryState.current, helperRef('provider:new'))).toBe(true);
    expect(registryState.current.pendingCredentialDeletes).toBeUndefined();
  });

  it('drops an anonymous cleanup marker without invoking credential deletion', async () => {
    registryState.current.pendingCredentialDeletes = ['none:anonymous'];

    const result = await reconcilePendingCredentialDeletes();

    expect(result).toEqual({ deleted: [], pending: [] });
    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(lockState.events.some(event => event.startsWith('credential:enter:'))).toBe(false);
    expect(registryState.current.pendingCredentialDeletes).toBeUndefined();
  });
});
