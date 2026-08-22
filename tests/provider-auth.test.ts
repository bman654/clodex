import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRegistry } from '../src/registry/types.js';

const lockState = vi.hoisted(() => ({
  active: false,
  registryTail: Promise.resolve(),
  credentialActive: false,
  credentialTails: new Map<string, Promise<void>>(),
  afterRegistryUnlock: null as null | (() => void),
  providerActive: false,
}));
const registryState = vi.hoisted(() => ({
  current: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));
const journalState = vi.hoisted(() => ({
  pending: new Set<string>(),
}));

vi.mock('../src/ui.js', () => ({
  printOAuthStepsPanel: vi.fn(),
  printOAuthBrowserPanel: vi.fn(),
}));
vi.mock('../src/oauth/openai.js', () => ({
  runOpenAiDeviceCodeFlow: vi.fn(async () => ({
    tokens: {
      access_token: 'openai-access',
      refresh_token: 'openai-refresh',
      expires_in: 3600,
    },
    accountId: 'acct-123',
  })),
  runOpenAiBrowserFlow: vi.fn(async () => ({
    tokens: {
      access_token: 'openai-browser-access',
      refresh_token: 'openai-browser-refresh',
      expires_in: 3600,
    },
    accountId: 'acct-browser',
  })),
}));
vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    deleteProviderCredential: vi.fn(),
    probeProviderCredentialStore: vi.fn(),
    provisionProviderCredential: vi.fn(),
    resolveProviderCredential: vi.fn(),
    saveProviderCredential: vi.fn(),
  };
});
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => structuredClone(registryState.current)),
  loadRegistryStrict: vi.fn(() => structuredClone(registryState.current)),
  saveRegistry: vi.fn((registry: ProviderRegistry) => {
    if (!lockState.active) throw new Error('registry write escaped its lock');
    registryState.current = structuredClone(registry);
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
vi.mock('../src/registry/refresh-models.js', () => ({
  refreshProviderModelsWithCredential: vi.fn(),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(async <T>(operation: () => Promise<T> | T): Promise<T> => {
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
  withProviderMutationLock: vi.fn(async (_providerSlot: string, operation: () => unknown) => {
    lockState.providerActive = true;
    try {
      return await operation();
    } finally {
      lockState.providerActive = false;
    }
  }),
}));
vi.mock('@clack/prompts', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

import {
  deleteProviderCredential,
  probeProviderCredentialStore,
  provisionProviderCredential,
  resolveProviderCredential,
  saveProviderCredential,
} from '../src/env.js';
import { runOpenAiBrowserFlow, runOpenAiDeviceCodeFlow } from '../src/oauth/openai.js';
import { reconcilePendingCredentialDeletes } from '../src/registry/credential-lifecycle.js';
import * as cleanupJournal from '../src/registry/credential-cleanup-journal.js';
import { loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { authenticateProvider } from '../src/registry/provider-auth.js';
import { refreshProviderModelsWithCredential as refreshProviderModels } from '../src/registry/refresh-models.js';
import { credentialInstanceAuthRef } from '../src/credential-helper.js';
import * as prompts from '@clack/prompts';

describe('authenticateProvider', () => {
  const previousHelper = process.env.CLODEX_CREDENTIAL_HELPER;
  const previousHome = process.env.CLODEX_HOME;
  const previousAccountOverride = process.env.CLODEX_OAUTH_ACCOUNT;
  let home = '';
  let credentialRef = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-provider-auth-'));
    process.env.CLODEX_HOME = home;
    credentialRef = credentialInstanceAuthRef('oauth:provider:openai-oauth');
    registryState.current = { schemaVersion: 1, providers: [] };
    journalState.pending.clear();
    delete process.env.CLODEX_CREDENTIAL_HELPER;
    delete process.env.CLODEX_OAUTH_ACCOUNT;
    vi.mocked(deleteProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(probeProviderCredentialStore).mockReset().mockResolvedValue(true);
    lockState.active = false;
    lockState.registryTail = Promise.resolve();
    lockState.credentialActive = false;
    lockState.credentialTails.clear();
    lockState.afterRegistryUnlock = null;
    lockState.providerActive = false;
    vi.mocked(provisionProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(resolveProviderCredential).mockReset().mockResolvedValue('selected-access');
    vi.mocked(saveProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(loadRegistryStrict).mockReset().mockImplementation(
      () => structuredClone(registryState.current),
    );
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes).mockReset()
      .mockImplementation(async () => [...journalState.pending]);
    vi.mocked(cleanupJournal.queueCredentialDelete).mockReset()
      .mockImplementation(async (authRef: string) => {
        if (!authRef.startsWith('keyring:') && !authRef.startsWith('helper:v1:')) return false;
        journalState.pending.add(authRef);
        return true;
      });
    vi.mocked(cleanupJournal.cancelCredentialDelete).mockReset()
      .mockImplementation(async (authRef: string) => journalState.pending.delete(authRef));
    vi.mocked(saveRegistry).mockReset().mockImplementation(registry => {
      if (!lockState.active) throw new Error('registry write escaped its lock');
      registryState.current = structuredClone(registry) as typeof registryState.current;
    });
    vi.mocked(runOpenAiDeviceCodeFlow).mockReset().mockResolvedValue({
      tokens: { access_token: 'openai-access', refresh_token: 'openai-refresh', expires_in: 3600 },
      accountId: 'acct-123',
    });
    vi.mocked(runOpenAiBrowserFlow).mockReset().mockResolvedValue({
      tokens: { access_token: 'openai-browser-access', refresh_token: 'openai-browser-refresh', expires_in: 3600 },
      accountId: 'acct-browser',
    });
    vi.mocked(refreshProviderModels).mockReset().mockResolvedValue({
      id: 'openai-oauth',
      name: 'OpenAI',
      ok: true,
    });
    vi.mocked(prompts.select).mockClear();
  });

  afterEach(() => {
    if (previousHelper === undefined) delete process.env.CLODEX_CREDENTIAL_HELPER;
    else process.env.CLODEX_CREDENTIAL_HELPER = previousHelper;
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    if (previousAccountOverride === undefined) delete process.env.CLODEX_OAUTH_ACCOUNT;
    else process.env.CLODEX_OAUTH_ACCOUNT = previousAccountOverride;
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects a named account before the device ceremony when no default sign-in exists', async () => {
    await expect(authenticateProvider('openai', { account: 'work' }))
      .rejects.toThrow(/run the default sign-in first/);
    // The check must fire BEFORE the interactive flow: authorizing an account
    // and waiting for tokens only to be rejected afterward wastes the ceremony.
    expect(runOpenAiDeviceCodeFlow).not.toHaveBeenCalled();
  });

  it('stores a named account slot without touching the default credential', async () => {
    await authenticateProvider('openai');
    const defaultRef = registryState.current.providers[0]!.authRef;

    const result = await authenticateProvider('openai', { account: 'work' });

    const entry = registryState.current.providers[0]!;
    expect(entry.authRef).toBe(defaultRef);
    const slot = entry.authAccounts?.work;
    expect(slot?.authRef).toBeTruthy();
    expect(slot!.authRef).not.toBe(defaultRef);
    expect(slot).not.toHaveProperty('oauthAccountId');
    expect(JSON.stringify(entry)).not.toContain('acct-123');
    expect(provisionProviderCredential).toHaveBeenCalledWith(
      slot!.authRef,
      expect.stringContaining('"accountId":"acct-123"'),
      expect.any(Function),
    );
    expect(result.registryProvider.authAccounts?.work?.authRef).toBe(slot!.authRef);
    // The named slot owns its catalog. Refreshing it must not replace the
    // shared cache used by the persisted selection.
    expect(refreshProviderModels).toHaveBeenLastCalledWith(
      'openai-oauth',
      expect.any(Function),
      'work',
      { ignoreProviderOverride: true },
    );
  });

  it('normalizes the account name and reuses the slot ref on re-auth', async () => {
    await authenticateProvider('openai');
    await authenticateProvider('openai', { account: 'Work' });
    const firstRef = registryState.current.providers[0]!.authAccounts!.work!.authRef;
    await authenticateProvider('openai', { account: 'work' });
    const entry = registryState.current.providers[0]!;
    expect(Object.keys(entry.authAccounts!)).toEqual(['work']);
    expect(entry.authAccounts!.work!.authRef).toBe(firstRef);
  });

  it('rebuilds an invalidated default cache instead of following a temporary account', async () => {
    await authenticateProvider('openai');
    await authenticateProvider('openai', { account: 'work' });
    process.env.CLODEX_OAUTH_ACCOUNT = 'work';

    await authenticateProvider('openai');

    expect(refreshProviderModels).toHaveBeenLastCalledWith(
      'openai-oauth',
      expect.any(Function),
      null,
      { ignoreProviderOverride: true },
    );
  });

  it('invalidates both copies of an active named-account cache before rebuilding it', async () => {
    const cache = {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{
        id: 'old-work-model',
        name: 'Old work model',
        upstreamModelId: 'old-work-model',
        modelFormat: 'openai' as const,
      }],
    };
    registryState.current.providers.push({
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: credentialRef,
      authType: 'oauth',
      activeAuthAccount: 'work',
      authAccounts: {
        work: {
          authRef: credentialInstanceAuthRef('oauth:provider:openai-oauth:account:work'),
          addedAt: '2026-08-09T00:00:00.000Z',
          modelsCache: structuredClone(cache),
        },
      },
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-08-09T00:00:00.000Z',
      refreshedAt: cache.fetchedAt,
      modelsCache: structuredClone(cache),
    });

    await authenticateProvider('openai', { account: 'work' });

    const provider = registryState.current.providers[0]!;
    expect(provider.modelsCache).toBeUndefined();
    expect(provider.refreshedAt).toBeUndefined();
    expect(provider.authAccounts?.work?.modelsCache).toBeUndefined();
    expect(refreshProviderModels).toHaveBeenLastCalledWith(
      'openai-oauth',
      expect.any(Function),
      'work',
      { ignoreProviderOverride: true },
    );
  });

  it('preserves the active slot cache when reauthorizing the inactive provider default', async () => {
    const cache = {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{
        id: 'work-model',
        name: 'Work model',
        upstreamModelId: 'work-model',
        modelFormat: 'openai' as const,
      }],
    };
    registryState.current.providers.push({
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: credentialRef,
      authType: 'oauth',
      activeAuthAccount: 'work',
      authAccounts: {
        work: {
          authRef: credentialInstanceAuthRef('oauth:provider:openai-oauth:account:work'),
          addedAt: '2026-08-09T00:00:00.000Z',
          modelsCache: structuredClone(cache),
        },
      },
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-08-09T00:00:00.000Z',
      refreshedAt: cache.fetchedAt,
      modelsCache: structuredClone(cache),
    });

    await authenticateProvider('openai');

    const provider = registryState.current.providers[0]!;
    expect(provider.modelsCache?.models[0]?.id).toBe('work-model');
    expect(provider.authAccounts?.work?.modelsCache?.models[0]?.id).toBe('work-model');
    expect(refreshProviderModels).toHaveBeenLastCalledWith(
      'openai-oauth',
      expect.any(Function),
      null,
      { ignoreProviderOverride: true },
    );
  });

  it('updates the selected top ref with an active named-slot reauthentication', async () => {
    const defaultRef = 'keyring:oauth:provider:openai-oauth::credential::v1:default-old';
    const oldSelectedRef = 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:old';
    const newSelectedRef = credentialInstanceAuthRef('oauth:provider:openai-oauth:account:work');
    const cache = {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{
        id: 'old-work-model',
        name: 'Old work model',
        upstreamModelId: 'old-work-model',
        modelFormat: 'openai' as const,
      }],
    };
    registryState.current = {
      schemaVersion: 5,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authType: 'oauth',
        authRef: oldSelectedRef,
        defaultAuthRef: defaultRef,
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: oldSelectedRef,
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: structuredClone(cache),
          },
        },
        modelsCache: structuredClone(cache),
        refreshedAt: cache.fetchedAt,
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    };

    await authenticateProvider('openai', { account: 'work' });

    expect(registryState.current.providers[0]).toMatchObject({
      authRef: newSelectedRef,
      defaultAuthRef: defaultRef,
      activeAuthAccount: 'work',
      authAccounts: { work: { authRef: newSelectedRef } },
    });
    expect(registryState.current.providers[0]?.modelsCache).toBeUndefined();
    expect(registryState.current.providers[0]?.authAccounts?.work?.modelsCache).toBeUndefined();
    expect(deleteProviderCredential).toHaveBeenCalledWith(oldSelectedRef);
    expect(deleteProviderCredential).not.toHaveBeenCalledWith(defaultRef);
  });

  it('replaces only the parked provider default while a named slot is selected', async () => {
    const oldDefaultRef = 'keyring:oauth:provider:openai-oauth::credential::v1:default-old';
    const selectedRef = credentialInstanceAuthRef('oauth:provider:openai-oauth:account:work');
    const oldDefaultCache = {
      fetchedAt: '2026-08-08T00:00:00.000Z',
      models: [{
        id: 'old-default-model',
        name: 'Old default model',
        upstreamModelId: 'old-default-model',
        modelFormat: 'openai' as const,
      }],
    };
    const cache = {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{
        id: 'work-model',
        name: 'Work model',
        upstreamModelId: 'work-model',
        modelFormat: 'openai' as const,
      }],
    };
    registryState.current = {
      schemaVersion: 5,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authType: 'oauth',
        authRef: selectedRef,
        defaultAuthRef: oldDefaultRef,
        defaultModelsCache: oldDefaultCache,
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: selectedRef,
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: structuredClone(cache),
          },
        },
        modelsCache: structuredClone(cache),
        refreshedAt: cache.fetchedAt,
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    };

    const result = await authenticateProvider('openai');

    expect(result.registryProvider).toMatchObject({
      authRef: selectedRef,
      defaultAuthRef: credentialRef,
      activeAuthAccount: 'work',
    });
    expect(result.registryProvider.modelsCache).toEqual(cache);
    expect(result.registryProvider.authAccounts?.work?.modelsCache).toEqual(cache);
    expect(result.registryProvider.defaultModelsCache).toBeUndefined();
    expect(deleteProviderCredential).toHaveBeenCalledWith(oldDefaultRef);
    expect(deleteProviderCredential).not.toHaveBeenCalledWith(selectedRef);
  });

  it('reauthenticates an inactive named slot without changing selected or default routing', async () => {
    const defaultRef = 'keyring:oauth:provider:openai-oauth::credential::v1:default-old';
    const selectedRef = credentialInstanceAuthRef('oauth:provider:openai-oauth:account:alt');
    const oldWorkRef = 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:old';
    const newWorkRef = credentialInstanceAuthRef('oauth:provider:openai-oauth:account:work');
    registryState.current = {
      schemaVersion: 5,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authType: 'oauth',
        authRef: selectedRef,
        defaultAuthRef: defaultRef,
        activeAuthAccount: 'alt',
        authAccounts: {
          alt: { authRef: selectedRef, addedAt: '2026-08-09T00:00:00.000Z' },
          work: { authRef: oldWorkRef, addedAt: '2026-08-09T00:00:00.000Z' },
        },
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    };

    await authenticateProvider('openai', { account: 'work' });

    expect(registryState.current.providers[0]).toMatchObject({
      authRef: selectedRef,
      defaultAuthRef: defaultRef,
      activeAuthAccount: 'alt',
      authAccounts: {
        alt: { authRef: selectedRef },
        work: { authRef: newWorkRef },
      },
    });
    expect(deleteProviderCredential).toHaveBeenCalledWith(oldWorkRef);
    expect(deleteProviderCredential).not.toHaveBeenCalledWith(selectedRef);
    expect(deleteProviderCredential).not.toHaveBeenCalledWith(defaultRef);
  });

  it.each(['ghost', 'constructor'])(
    'repairs a legacy selected %s slot that disappeared by reauthenticating that exact name',
    async account => {
      const defaultRef = 'keyring:oauth:provider:openai-oauth::credential::v1:default-old';
      const repairedRef = credentialInstanceAuthRef(`oauth:provider:openai-oauth:account:${account}`);
      registryState.current = {
        schemaVersion: 3,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authType: 'oauth',
          authRef: defaultRef,
          activeAuthAccount: account,
          authAccounts: {
            work: { authRef: 'keyring:oauth:work', addedAt: '2026-08-09T00:00:00.000Z' },
          },
          api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
          addedAt: '2026-08-09T00:00:00.000Z',
        }],
      };

      await authenticateProvider('openai', { account });

      expect(registryState.current.providers[0]).toMatchObject({
        authRef: repairedRef,
        defaultAuthRef: defaultRef,
        activeAuthAccount: account,
        authAccounts: { [account]: { authRef: repairedRef } },
      });
      expect(Object.prototype.hasOwnProperty.call(
        registryState.current.providers[0]?.authAccounts,
        account,
      )).toBe(true);
    },
  );

  it.each(['ghost', 'constructor'])(
    'does not fall back to the default when default reauth sees broken %s selector',
    async account => {
      const oldDefaultRef = 'keyring:oauth:provider:openai-oauth::credential::v1:default-old';
      registryState.current = {
        schemaVersion: 3,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authType: 'oauth',
          authRef: oldDefaultRef,
          activeAuthAccount: account,
          authAccounts: {
            work: { authRef: 'keyring:oauth:work', addedAt: '2026-08-09T00:00:00.000Z' },
          },
          api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
          addedAt: '2026-08-09T00:00:00.000Z',
        }],
      };

      await expect(authenticateProvider('openai')).rejects.toThrow(
        new RegExp(`account "${account}".*no longer exists`),
      );

      expect(registryState.current.providers[0]).toMatchObject({
        authRef: oldDefaultRef,
        activeAuthAccount: account,
      });
      expect(registryState.current.providers[0]?.defaultAuthRef).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(
        registryState.current.providers[0]?.authAccounts,
        account,
      )).toBe(false);
      expect(refreshProviderModels).not.toHaveBeenCalled();
      expect(journalState.pending).toContain(credentialRef);
    },
  );

  it('reports a returned model-refresh failure instead of claiming success', async () => {
    const stop = vi.fn();
    vi.mocked(prompts.spinner)
      .mockReturnValueOnce({ start: vi.fn(), stop: vi.fn() })
      .mockReturnValueOnce({ start: vi.fn(), stop });
    vi.mocked(refreshProviderModels).mockResolvedValueOnce({
      id: 'openai-oauth',
      name: 'OpenAI',
      ok: false,
      reason: 'Provider configuration changed while credentials were resolving.',
    });

    await authenticateProvider('openai');

    expect(stop).toHaveBeenCalledWith(
      'Could not refresh models — Provider configuration changed while credentials were resolving.',
    );
    expect(stop).not.toHaveBeenCalledWith('Models refreshed');
  });

  it('reports a transient-credential refresh skip instead of claiming success', async () => {
    const stop = vi.fn();
    vi.mocked(prompts.spinner)
      .mockReturnValueOnce({ start: vi.fn(), stop: vi.fn() })
      .mockReturnValueOnce({ start: vi.fn(), stop });
    vi.mocked(refreshProviderModels).mockResolvedValueOnce({
      id: 'openai-oauth',
      name: 'OpenAI',
      ok: true,
      skipped: true,
      reason: 'CLODEX_KEY_OPENAI_OAUTH is a process-scoped provider credential override.',
    });

    await authenticateProvider('openai');

    expect(stop).toHaveBeenCalledWith(
      'Models not refreshed — CLODEX_KEY_OPENAI_OAUTH is a process-scoped provider credential override.',
    );
    expect(stop).not.toHaveBeenCalledWith('Models refreshed');
  });

  it('rejects a named account before the default sign-in exists', async () => {
    await expect(authenticateProvider('openai', { account: 'work' }))
      .rejects.toThrow(/default sign-in first/);
    expect(registryState.current.providers).toHaveLength(0);
  });

  it('rejects an invalid account name before any device authorization', async () => {
    await expect(authenticateProvider('openai', { account: 'Bad Name!' }))
      .rejects.toThrow(/Invalid account name/);
    expect(runOpenAiDeviceCodeFlow).not.toHaveBeenCalled();
  });

  it('runs the OpenAI device-code flow and stores the openai-oauth registry entry', async () => {
    vi.mocked(provisionProviderCredential).mockImplementationOnce(async () => {
      expect(lockState.active).toBe(false);
      expect(lockState.credentialActive).toBe(true);
      expect(lockState.providerActive).toBe(true);
      return true;
    });
    const result = await authenticateProvider('openai');

    expect(prompts.select).not.toHaveBeenCalled();
    expect(probeProviderCredentialStore).toHaveBeenCalledWith(
      'keyring:oauth:provider:openai-oauth',
      expect.any(Function),
    );
    expect(runOpenAiDeviceCodeFlow).toHaveBeenCalled();
    expect(saveRegistry).toHaveBeenCalled();
    expect(result.providerId).toBe('openai-oauth');
    expect(result.credential.access).toBe('openai-access');
    expect(result.registryProvider.name).toBe('OpenAI (ChatGPT)');
    expect(result.registryProvider.authRef).toBe(credentialRef);
  });

  it('runs the browser PKCE flow instead of device code when method is browser', async () => {
    const result = await authenticateProvider('openai', { method: 'browser' });

    expect(runOpenAiBrowserFlow).toHaveBeenCalled();
    expect(runOpenAiDeviceCodeFlow).not.toHaveBeenCalled();
    expect(result.providerId).toBe('openai-oauth');
    expect(result.credential.access).toBe('openai-browser-access');
  });

  it('stops before device authorization when the credential store preflight fails', async () => {
    vi.mocked(probeProviderCredentialStore).mockImplementationOnce(async (_authRef, diagnostic) => {
      diagnostic?.('native keyring probe failed');
      return false;
    });
    await expect(authenticateProvider('openai')).rejects.toThrow(
      'Credential store is unavailable: native keyring probe failed. '
      + 'Set CLODEX_CREDENTIAL_HELPER to an absolute path to an external credential helper and try again.',
    );
    expect(runOpenAiDeviceCodeFlow).not.toHaveBeenCalled();
    expect(provisionProviderCredential).not.toHaveBeenCalled();
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('rejects before updating the registry or refreshing models when token persistence fails', async () => {
    vi.mocked(provisionProviderCredential).mockImplementationOnce(async (_authRef, _credential, diagnostic) => {
      diagnostic?.('credential write failed');
      return false;
    });

    await expect(authenticateProvider('openai')).rejects.toThrow(
      'Could not save OAuth tokens to the credential store',
    );
    expect(provisionProviderCredential).toHaveBeenCalled();
    expect(registryState.current.providers).toHaveLength(0);
    expect([...journalState.pending]).toEqual([credentialRef]);
    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('does not publish a provider when token persistence fails', async () => {
    vi.mocked(provisionProviderCredential).mockResolvedValueOnce(false);

    await expect(authenticateProvider('openai')).rejects.toThrow(
      'Could not save OAuth tokens to the credential store',
    );
    expect(provisionProviderCredential).toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('moves an older credential reference to the selected account instance', async () => {
    const existingProvider = {
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authType: 'oauth' as const,
      authRef: 'keyring:oauth:provider:openai-oauth',
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    };
    registryState.current.providers = [existingProvider];
    vi.mocked(provisionProviderCredential).mockResolvedValue(true);

    const result = await authenticateProvider('openai');

    expect(provisionProviderCredential).toHaveBeenCalledWith(
      credentialRef,
      expect.any(String),
      expect.any(Function),
    );
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(result.registryProvider.authRef).toBe(credentialRef);
  });

  it('replaces the credential when the selected account instance is current', async () => {
    const authRef = credentialRef;
    registryState.current.providers = [
      {
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authType: 'oauth' as const,
        authRef,
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    vi.mocked(saveProviderCredential).mockResolvedValue(true);

    const result = await authenticateProvider('openai');

    expect(saveProviderCredential).toHaveBeenCalledWith(
      authRef,
      expect.any(String),
      expect.any(Function),
    );
    expect(provisionProviderCredential).not.toHaveBeenCalled();
    expect(result.registryProvider.authRef).toBe(authRef);
  });

  it('does not persist credentials when the registry cannot be validated', async () => {
    vi.mocked(loadRegistryStrict).mockImplementationOnce(() => {
      throw new Error('Provider registry contains an invalid provider entry.');
    });

    await expect(authenticateProvider('openai')).rejects.toThrow(
      'Provider registry contains an invalid provider entry.',
    );

    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
    expect(cleanupJournal.loadPendingCredentialDeletes).not.toHaveBeenCalled();
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('keeps authorization and model refresh outside the credential transaction lock', async () => {
    const observations: Array<[string, boolean, boolean]> = [];
    vi.mocked(runOpenAiDeviceCodeFlow).mockImplementationOnce(async () => {
      observations.push(['authorization', lockState.active, lockState.credentialActive]);
      return {
        tokens: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        },
        accountId: 'account-id',
      };
    });
    vi.mocked(provisionProviderCredential).mockImplementationOnce(async () => {
      observations.push(['credential-write', lockState.active, lockState.credentialActive]);
      return true;
    });
    vi.mocked(refreshProviderModels).mockImplementationOnce(async () => {
      observations.push(['model-refresh', lockState.active, lockState.credentialActive]);
      return { id: 'openai-oauth', name: 'OpenAI', ok: true };
    });

    await authenticateProvider('openai');

    expect(observations).toEqual([
      ['authorization', false, false],
      ['credential-write', false, true],
      ['model-refresh', false, false],
    ]);
  });

  it('removes an unshared prior credential after migrating stores', async () => {
    registryState.current.providers.push({
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: 'keyring:oauth:provider:openai-oauth',
      authType: 'oauth',
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    process.env.CLODEX_CREDENTIAL_HELPER = process.execPath;
    const helperAuthRef = credentialInstanceAuthRef('oauth:provider:openai-oauth');

    await authenticateProvider('openai');

    expect(provisionProviderCredential).toHaveBeenCalledWith(
      helperAuthRef,
      expect.any(String),
      expect.any(Function),
    );
    expect(deleteProviderCredential).toHaveBeenCalledWith('keyring:oauth:provider:openai-oauth');
    expect(registryState.current.providers[0]?.authRef).toBe(helperAuthRef);
  });

  it('reauthorizes the same OAuth reference without deleting the active credential', async () => {
    const authRef = credentialRef;
    registryState.current.providers.push({
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef,
      authType: 'oauth',
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await authenticateProvider('openai');

    expect(saveProviderCredential).toHaveBeenCalledWith(
      authRef,
      expect.any(String),
      expect.any(Function),
    );
    expect(result.registryProvider.authRef).toBe(authRef);
    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(journalState.pending.size).toBe(0);
  });

  it('keeps the new provider active and queues the prior credential when cleanup is uncertain', async () => {
    registryState.current.providers.push({
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: 'keyring:oauth:provider:openai-oauth',
      authType: 'oauth',
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    process.env.CLODEX_CREDENTIAL_HELPER = process.execPath;
    const helperAuthRef = credentialInstanceAuthRef('oauth:provider:openai-oauth');
    vi.mocked(deleteProviderCredential).mockResolvedValue(false);

    const result = await authenticateProvider('openai');
    expect(result.credentialCleanupPending).toBe(true);
    expect(registryState.current.providers[0]?.authRef).toBe(helperAuthRef);
    expect([...journalState.pending]).toEqual([
      'keyring:oauth:provider:openai-oauth',
    ]);
    expect(deleteProviderCredential).toHaveBeenCalledWith('keyring:oauth:provider:openai-oauth');
    expect(deleteProviderCredential).not.toHaveBeenCalledWith(helperAuthRef);
  });

  it('does not write a credential when the durable pending marker cannot be saved', async () => {
    vi.mocked(cleanupJournal.queueCredentialDelete).mockRejectedValueOnce(
      new Error('journal unavailable'),
    );

    await expect(authenticateProvider('openai')).rejects.toThrow('journal unavailable');
    expect(provisionProviderCredential).not.toHaveBeenCalled();
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(registryState.current.providers).toHaveLength(0);
  });

  it('leaves a newly written credential journaled when provider activation cannot be saved', async () => {
    vi.mocked(saveRegistry).mockImplementationOnce(() => {
      throw new Error('activation failed');
    });

    await expect(authenticateProvider('openai')).rejects.toThrow('activation failed');
    expect(provisionProviderCredential).toHaveBeenCalled();
    expect(registryState.current.providers).toHaveLength(0);
    expect([...journalState.pending]).toEqual([credentialRef]);
    expect(deleteProviderCredential).not.toHaveBeenCalled();
  });

  it('does not let concurrent reconciliation delete a credential during activation', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    vi.mocked(provisionProviderCredential).mockImplementation(async () => {
      await writeGate;
      return true;
    });

    const authentication = authenticateProvider('openai');
    await vi.waitFor(() => expect(provisionProviderCredential).toHaveBeenCalledTimes(1));
    const reconciliation = reconcilePendingCredentialDeletes();
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(deleteProviderCredential).not.toHaveBeenCalled();
    releaseWrite();
    const [result, cleanup] = await Promise.all([authentication, reconciliation]);
    expect(result.registryProvider.authRef).toBe(credentialRef);
    expect(cleanup.deleted).toEqual([]);
    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(journalState.pending.size).toBe(0);
  });

  it('retains a removal marker queued immediately after OAuth replacement commit', async () => {
    registryState.current.providers.push({
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: `helper:v1:${'b'.repeat(64)}:oauth:provider:openai-oauth`,
      authType: 'oauth',
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    });
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
      const replacementRef = registry.providers[0]?.authRef;
      lockState.afterRegistryUnlock = () => {
        registryState.current.providers = [];
        if (replacementRef) journalState.pending.add(replacementRef);
      };
    });

    const result = await authenticateProvider('openai');
    const replacementRef = result.registryProvider.authRef;

    expect(cancellationLockStates).toEqual([true]);
    expect(replacementRef).toBe(credentialRef);
    expect(journalState.pending).toContain(replacementRef);
    expect(result.credentialCleanupPending).toBe(true);
  });

  it('reports cleanup pending instead of rejecting after OAuth provider commit', async () => {
    vi.mocked(cleanupJournal.loadPendingCredentialDeletes).mockRejectedValue(
      new Error('cleanup journal lock timed out'),
    );

    const result = await authenticateProvider('openai');

    expect(result.registryProvider.id).toBe('openai-oauth');
    expect(result.credentialCleanupPending).toBe(true);
    expect(registryState.current.providers).toHaveLength(1);
  });

  it('rejects non-OpenAI providers', async () => {
    await expect(authenticateProvider('xai')).rejects.toThrow('only available for openai');
  });
});
