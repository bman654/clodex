import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegistryModelsCache, RegistryProvider } from '../src/registry/types.js';

vi.mock('../src/ui.js', () => ({
  printOAuthStepsPanel: vi.fn(),
}));

vi.mock('../src/oauth/openai.js', () => ({
  runOpenAiDeviceCodeFlow: vi.fn(async () => ({
    tokens: {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
    },
    accountId: 'test-account-id',
  })),
}));

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    probeProviderCredentialStore: vi.fn(async () => true),
    provisionProviderCredential: vi.fn(async () => true),
    resolveProviderCredentialWithSource: vi.fn(async () => ({
      access: 'test-access-token',
      source: { kind: 'stored' as const },
    })),
    saveProviderCredential: vi.fn(async () => true),
  };
});

vi.mock('../src/registry/credential-lifecycle.js', () => ({
  cancelCredentialDelete: vi.fn(async () => true),
  journalCredentialWrite: vi.fn(async () => undefined),
  queueCredentialDelete: vi.fn(async () => true),
  reconcilePendingCredentialDeletes: vi.fn(async () => ({
    deleted: [],
    pending: [],
  })),
}));

vi.mock('../src/registry/refresh-models.js', () => ({
  refreshProviderModelsWithCredential: vi.fn(async (providerId: string) => ({
    id: providerId,
    name: 'OpenAI (ChatGPT)',
    ok: true,
  })),
}));

vi.mock('../src/registry/lock.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/lock.js')>();
  return {
    ...actual,
    // Registry locking remains real so saveRegistry exercises its ownership,
    // validation, fsync, and publication path. Only credential/provider locks
    // are process-global under the native user home and therefore isolated.
    withCredentialMutationLock: vi.fn(async <T>(
      _authRef: string,
      operation: () => Promise<T> | T,
    ): Promise<T> => operation()),
    withProviderMutationLock: vi.fn(async <T>(
      _providerId: string,
      operation: () => Promise<T> | T,
    ): Promise<T> => operation()),
  };
});

vi.mock('@clack/prompts', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

import {
  probeProviderCredentialStore,
  provisionProviderCredential,
  saveProviderCredential,
} from '../src/env.js';
import { runOpenAiDeviceCodeFlow } from '../src/oauth/openai.js';
import { journalCredentialWrite } from '../src/registry/credential-lifecycle.js';
import { authenticateProvider } from '../src/registry/provider-auth.js';
import { loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';

function modelsCache(id: string): RegistryModelsCache {
  return {
    fetchedAt: '2026-08-09T00:00:00.000Z',
    models: [{
      id,
      name: id,
      upstreamModelId: id,
      modelFormat: 'openai',
    }],
  };
}

describe('provider auth storage transitions', () => {
  const previousHome = process.env.CLODEX_HOME;
  let home = '';
  let path = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-provider-auth-storage-'));
    process.env.CLODEX_HOME = home;
    path = join(home, 'providers.json');
    vi.mocked(probeProviderCredentialStore).mockClear();
    vi.mocked(provisionProviderCredential).mockClear();
    vi.mocked(saveProviderCredential).mockClear();
    vi.mocked(runOpenAiDeviceCodeFlow).mockClear();
    vi.mocked(journalCredentialWrite).mockClear();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function persistDormantApiSelector(): RegistryProvider {
    const provider: RegistryProvider = {
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: 'keyring:provider:openai-oauth::credential::v1:api-default',
      authType: 'api',
      activeAuthAccount: 'work',
      authAccounts: {
        work: {
          authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work',
          addedAt: '2026-08-08T00:00:00.000Z',
          modelsCache: modelsCache('work-model'),
        },
      },
      modelsCache: modelsCache('api-model'),
      refreshedAt: '2026-08-09T00:00:00.000Z',
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-08-07T00:00:00.000Z',
    };
    withRegistryWriteLockSync(
      () => saveRegistry({ schemaVersion: 4, providers: [provider] }, path),
      { lockPath: `${path}.lock` },
    );
    return provider;
  }

  it('persists the selected slot projection when default OAuth repairs a dormant API selector', async () => {
    persistDormantApiSelector();

    await authenticateProvider('openai');

    const persisted = loadRegistryStrict(path);
    const provider = persisted.providers[0]!;
    expect(persisted.schemaVersion).toBe(5);
    expect(provider).toMatchObject({
      authType: 'oauth',
      activeAuthAccount: 'work',
      authRef: provider.authAccounts!.work!.authRef,
      modelsCache: modelsCache('work-model'),
    });
    expect(provider.defaultAuthRef).toMatch(/^keyring:oauth:provider:openai-oauth::credential::v1:/);
    expect(provider.defaultAuthRef).not.toBe(provider.authRef);
    expect(provider.refreshedAt).toBe(provider.authAccounts!.work!.modelsCache!.fetchedAt);
    expect(provider.modelsCache?.models.map(model => model.id)).toEqual(['work-model']);
    expect(readFileSync(path, 'utf8')).not.toContain('api-model');
    expect(runOpenAiDeviceCodeFlow).toHaveBeenCalledOnce();
    expect(provisionProviderCredential).toHaveBeenCalledOnce();
  });

  it('rejects named OAuth before the ceremony or credential write on a dormant API selector', async () => {
    persistDormantApiSelector();
    const before = readFileSync(path, 'utf8');

    await expect(authenticateProvider('openai', { account: 'work' }))
      .rejects.toThrow(/does not currently have a default OAuth sign-in.*without --account first/s);

    expect(probeProviderCredentialStore).not.toHaveBeenCalled();
    expect(runOpenAiDeviceCodeFlow).not.toHaveBeenCalled();
    expect(provisionProviderCredential).not.toHaveBeenCalled();
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('rechecks named OAuth under the provider lock after the device ceremony', async () => {
    const provider: RegistryProvider = {
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
      authType: 'oauth',
      authAccounts: {
        work: {
          authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work',
          addedAt: '2026-08-08T00:00:00.000Z',
        },
      },
      modelsCache: modelsCache('default-model'),
      refreshedAt: '2026-08-09T00:00:00.000Z',
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-08-07T00:00:00.000Z',
    };
    withRegistryWriteLockSync(
      () => saveRegistry({ schemaVersion: 2, providers: [provider] }, path),
      { lockPath: `${path}.lock` },
    );
    vi.mocked(runOpenAiDeviceCodeFlow).mockImplementationOnce(async () => {
      // Model a cooperating provider replacement that wins while the user is
      // completing the device flow, before named auth acquires its provider
      // mutation lock and performs the authoritative registry reread.
      withRegistryWriteLockSync(() => {
        const registry = loadRegistryStrict(path);
        registry.providers[0] = {
          ...registry.providers[0]!,
          authType: 'api',
          authRef: 'keyring:provider:openai-oauth::credential::v1:replacement',
        };
        saveRegistry(registry, path);
      }, { lockPath: `${path}.lock` });
      return {
        tokens: {
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
        },
        accountId: 'test-account-id',
      };
    });

    await expect(authenticateProvider('openai', { account: 'work' }))
      .rejects.toThrow(/does not currently have a default OAuth sign-in.*without --account first/s);

    expect(runOpenAiDeviceCodeFlow).toHaveBeenCalledOnce();
    expect(journalCredentialWrite).not.toHaveBeenCalled();
    expect(provisionProviderCredential).not.toHaveBeenCalled();
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(loadRegistryStrict(path).providers[0]).toMatchObject({
      authType: 'api',
      authRef: 'keyring:provider:openai-oauth::credential::v1:replacement',
    });
  });
});
