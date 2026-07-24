import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';

const registryState = vi.hoisted(() => ({
  current: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));
const journalState = vi.hoisted(() => ({
  pending: new Set<string>(),
  cancelFailures: new Set<string>(),
}));
const lockState = vi.hoisted(() => ({
  registryActive: false,
  credentialActive: null as string | null,
  credentialFailures: new Set<string>(),
  registryFailures: new Set<string>(),
  events: [] as string[],
  afterRegistryUnlock: null as null | (() => void),
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  deleteProviderCredential: vi.fn(),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistryStrict: vi.fn(() => structuredClone(registryState.current)),
}));
vi.mock('../src/registry/credential-cleanup-journal.js', () => ({
  isStoredCredentialRef: vi.fn((authRef: string) =>
    authRef.startsWith('keyring:') || authRef.startsWith('helper:v1:')),
  loadPendingCredentialDeletes: vi.fn(async () => [...journalState.pending]),
  queueCredentialDelete: vi.fn(async (authRef: string) => {
    journalState.pending.add(authRef);
    return true;
  }),
  cancelCredentialDelete: vi.fn(async (authRef: string) => {
    if (journalState.cancelFailures.has(authRef)) {
      throw new Error('journal write failed');
    }
    return journalState.pending.delete(authRef);
  }),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(async <T>(operation: () => Promise<T> | T): Promise<T> => {
    const authRef = lockState.credentialActive;
    if (authRef && lockState.registryFailures.has(authRef)) {
      throw new Error(`registry lock timed out for ${authRef}`);
    }
    if (lockState.registryActive) throw new Error('registry lock re-entered');
    lockState.registryActive = true;
    try {
      return await operation();
    } finally {
      lockState.registryActive = false;
      const afterUnlock = lockState.afterRegistryUnlock;
      lockState.afterRegistryUnlock = null;
      afterUnlock?.();
    }
  }),
  withCredentialMutationLock: vi.fn(async <T>(
    authRef: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    if (lockState.credentialFailures.has(authRef)) {
      throw new Error(`credential lock timed out for ${authRef}`);
    }
    lockState.credentialActive = authRef;
    lockState.events.push(`credential:enter:${authRef}`);
    try {
      return await operation();
    } finally {
      lockState.events.push(`credential:exit:${authRef}`);
      lockState.credentialActive = null;
    }
  }),
}));

import { deleteProviderCredential } from '../src/env.js';
import * as cleanupJournal from '../src/registry/credential-cleanup-journal.js';
import { reconcilePendingCredentialDeletes } from '../src/registry/credential-lifecycle.js';
import { loadRegistryStrict } from '../src/registry/io.js';

const TEST_HELPER_ID = 'a'.repeat(64);
const helperRef = (account: string): string => `helper:v1:${TEST_HELPER_ID}:${account}`;

describe('credential cleanup lifecycle', () => {
  beforeEach(() => {
    registryState.current = { schemaVersion: 1, providers: [] };
    journalState.pending.clear();
    journalState.cancelFailures.clear();
    lockState.registryActive = false;
    lockState.credentialActive = null;
    lockState.credentialFailures.clear();
    lockState.registryFailures.clear();
    lockState.events = [];
    lockState.afterRegistryUnlock = null;
    vi.mocked(deleteProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(loadRegistryStrict).mockReset()
      .mockImplementation(() => structuredClone(registryState.current));
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes).mockReset()
      .mockImplementation(async () => [...journalState.pending]);
    vi.mocked(cleanupJournal.cancelCredentialDelete).mockReset()
      .mockImplementation(async (authRef: string) => {
        if (journalState.cancelFailures.has(authRef)) {
          throw new Error('journal write failed');
        }
        return journalState.pending.delete(authRef);
      });
  });

  it('clears successful deletions while retaining failed and thrown deletions', async () => {
    const deletedRef = helperRef('provider:deleted');
    const failedRef = helperRef('provider:failed');
    const thrownRef = 'keyring:provider:thrown';
    journalState.pending = new Set([deletedRef, failedRef, thrownRef]);
    vi.mocked(deleteProviderCredential).mockImplementation(async authRef => {
      expect(lockState.registryActive).toBe(false);
      expect(lockState.credentialActive).toBe(authRef);
      lockState.events.push(`delete:${authRef}`);
      if (authRef === deletedRef) return true;
      if (authRef === thrownRef) throw new Error('response lost');
      return false;
    });

    const result = await reconcilePendingCredentialDeletes();

    expect(result.deleted).toEqual([deletedRef]);
    expect(result.pending).toEqual([failedRef, thrownRef]);
    expect([...journalState.pending]).toEqual(result.pending);
  });

  it('never deletes a credential that became active again', async () => {
    const authRef = helperRef('provider:active');
    registryState.current.providers.push({
      id: 'active',
      templateId: 'active',
      name: 'Active',
      enabled: true,
      authRef,
      api: {},
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    journalState.pending.add(authRef);

    const result = await reconcilePendingCredentialDeletes();

    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(result.pending).toEqual([]);
    expect(journalState.pending.size).toBe(0);
  });

  it('does not cancel a removal marker queued after an active-reference decision', async () => {
    const authRef = helperRef('provider:removed-after-check');
    registryState.current.providers.push({
      id: 'active',
      templateId: 'active',
      name: 'Active',
      enabled: true,
      authRef,
      api: {},
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    journalState.pending.add(authRef);
    vi.mocked(cleanupJournal.cancelCredentialDelete).mockImplementation(
      async candidate => {
        lockState.events.push(`cancel:${lockState.registryActive}`);
        return journalState.pending.delete(candidate);
      },
    );
    lockState.afterRegistryUnlock = () => {
      registryState.current.providers = [];
      journalState.pending.add(authRef);
      lockState.events.push('provider-removed');
    };

    const result = await reconcilePendingCredentialDeletes();

    expect(lockState.events).toEqual([
      `credential:enter:${authRef}`,
      'cancel:true',
      'provider-removed',
      `credential:exit:${authRef}`,
    ]);
    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(result.pending).toEqual([authRef]);
    expect(journalState.pending).toEqual(new Set([authRef]));
  });

  it('isolates credential-lock failures and continues unrelated references', async () => {
    const lockedRef = helperRef('provider:locked');
    const deletableRef = helperRef('provider:deletable');
    journalState.pending = new Set([lockedRef, deletableRef]);
    lockState.credentialFailures.add(lockedRef);

    const result = await reconcilePendingCredentialDeletes();

    expect(deleteProviderCredential).toHaveBeenCalledWith(deletableRef);
    expect(result.deleted).toEqual([deletableRef]);
    expect(result.pending).toEqual([lockedRef]);
    expect(result.persistenceError).toContain(lockedRef);
    expect(result.persistenceError).toContain('credential lock timed out');
  });

  it('isolates registry-lock failures and continues unrelated references', async () => {
    const lockedRef = helperRef('provider:registry-locked');
    const deletableRef = helperRef('provider:deletable');
    journalState.pending = new Set([lockedRef, deletableRef]);
    lockState.registryFailures.add(lockedRef);

    const result = await reconcilePendingCredentialDeletes();

    expect(deleteProviderCredential).toHaveBeenCalledWith(deletableRef);
    expect(result.deleted).toEqual([deletableRef]);
    expect(result.pending).toEqual([lockedRef]);
    expect(result.persistenceError).toContain(lockedRef);
    expect(result.persistenceError).toContain('registry lock timed out');
  });

  it('keeps cleanup queued when the provider registry cannot be read', async () => {
    const authRef = helperRef('provider:registry-unreadable');
    journalState.pending.add(authRef);
    vi.mocked(loadRegistryStrict).mockImplementationOnce(() => {
      throw new Error('provider registry is unreadable');
    });

    const result = await reconcilePendingCredentialDeletes();

    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(result.pending).toEqual([authRef]);
    expect(result.persistenceError).toContain('provider registry is unreadable');
  });

  it('reports a snapshot read failure without rejecting', async () => {
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes).mockRejectedValueOnce(
      new Error('journal lock timed out'),
    );

    const result = await reconcilePendingCredentialDeletes();

    expect(result).toEqual({
      deleted: [],
      pending: [],
      persistenceError: expect.stringContaining('journal lock timed out'),
    });
    expect(deleteProviderCredential).not.toHaveBeenCalled();
  });

  it('retains known pending state when the final journal read fails', async () => {
    const authRef = helperRef('provider:failed');
    journalState.pending.add(authRef);
    vi.mocked(deleteProviderCredential).mockResolvedValue(false);
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes)
      .mockResolvedValueOnce([authRef])
      .mockRejectedValueOnce(new Error('final journal read failed'));

    const result = await reconcilePendingCredentialDeletes();

    expect(result.pending).toEqual([authRef]);
    expect(result.persistenceError).toContain('final journal read failed');
  });

  it('keeps a deleted reference journaled when clearing it fails', async () => {
    const authRef = helperRef('provider:stale');
    journalState.pending.add(authRef);
    journalState.cancelFailures.add(authRef);

    const result = await reconcilePendingCredentialDeletes();

    expect(result.deleted).toEqual([authRef]);
    expect(result.pending).toEqual([authRef]);
    expect(result.persistenceError).toContain('journal write failed');
  });

  it('retries an already-deleted credential when marker clearing previously failed', async () => {
    const authRef = helperRef('provider:already-deleted');
    journalState.pending.add(authRef);
    journalState.cancelFailures.add(authRef);

    const first = await reconcilePendingCredentialDeletes();
    journalState.cancelFailures.delete(authRef);
    const second = await reconcilePendingCredentialDeletes();

    expect(first.deleted).toEqual([authRef]);
    expect(first.pending).toEqual([authRef]);
    expect(second.deleted).toEqual([authRef]);
    expect(second.pending).toEqual([]);
    expect(deleteProviderCredential).toHaveBeenCalledTimes(2);
  });
});
