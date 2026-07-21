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
}));
const registryState = vi.hoisted(() => ({
  current: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));

vi.mock('../src/ui.js', () => ({
  printOAuthStepsPanel: vi.fn(),
}));
vi.mock('../src/oauth/openai.js', () => ({
  runOpenAiDeviceCodeFlow: vi.fn(),
}));
vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    deleteProviderCredential: vi.fn(),
    probeProviderCredentialStore: vi.fn(),
    saveProviderCredential: vi.fn(),
  };
});
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => structuredClone(registryState.current)),
  saveRegistry: vi.fn((registry: ProviderRegistry) => {
    if (!lockState.active) throw new Error('registry write escaped its lock');
    registryState.current = structuredClone(registry);
  }),
}));
vi.mock('../src/registry/refresh-models.js', () => ({
  refreshProviderModels: vi.fn(),
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
  saveProviderCredential,
} from '../src/env.js';
import { credentialAuthRef } from '../src/credential-helper.js';
import { runOpenAiDeviceCodeFlow } from '../src/oauth/openai.js';
import { reconcilePendingCredentialDeletes } from '../src/registry/credential-lifecycle.js';
import { saveRegistry } from '../src/registry/io.js';
import { authenticateProvider } from '../src/registry/provider-auth.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import * as prompts from '@clack/prompts';

describe('authenticateProvider', () => {
  const previousHelper = process.env.CLODEX_CREDENTIAL_HELPER;
  const previousHome = process.env.CLODEX_HOME;
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-provider-auth-'));
    process.env.CLODEX_HOME = home;
    registryState.current = { schemaVersion: 1, providers: [] };
    delete process.env.CLODEX_CREDENTIAL_HELPER;
    vi.mocked(deleteProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(probeProviderCredentialStore).mockReset().mockResolvedValue(true);
    lockState.active = false;
    lockState.registryTail = Promise.resolve();
    lockState.credentialActive = false;
    lockState.credentialTails.clear();
    vi.mocked(saveProviderCredential).mockReset().mockResolvedValue(true);
    vi.mocked(saveRegistry).mockReset().mockImplementation(registry => {
      if (!lockState.active) throw new Error('registry write escaped its lock');
      registryState.current = structuredClone(registry) as typeof registryState.current;
    });
    vi.mocked(runOpenAiDeviceCodeFlow).mockReset().mockResolvedValue({
      tokens: { access_token: 'openai-access', refresh_token: 'openai-refresh', expires_in: 3600 },
      accountId: 'acct-123',
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
    rmSync(home, { recursive: true, force: true });
  });

  it('runs the OpenAI device-code flow and stores the openai-oauth registry entry', async () => {
    vi.mocked(saveProviderCredential).mockImplementationOnce(async () => {
      expect(lockState.active).toBe(false);
      expect(lockState.credentialActive).toBe(true);
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
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('rejects before updating the registry or refreshing models when token persistence fails', async () => {
    vi.mocked(saveProviderCredential).mockImplementationOnce(async (_authRef, _credential, diagnostic) => {
      diagnostic?.('credential write failed');
      return false;
    });

    await expect(authenticateProvider('openai')).rejects.toThrow(
      'Could not save OAuth tokens to the credential store',
    );
    expect(saveProviderCredential).toHaveBeenCalled();
    expect(registryState.current.providers).toHaveLength(0);
    expect(registryState.current.pendingCredentialDeletes).toEqual([
      'keyring:oauth:provider:openai-oauth',
    ]);
    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('keeps authorization and model refresh outside the credential transaction lock', async () => {
    const observations: Array<[string, boolean, boolean]> = [];
    vi.mocked(runOpenAiDeviceCodeFlow).mockImplementationOnce(async () => {
      observations.push(['authorization', lockState.active, lockState.credentialActive]);
      return {
        tokens: { access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 },
        accountId: 'account-id',
      };
    });
    vi.mocked(saveProviderCredential).mockImplementationOnce(async () => {
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
    const helperAuthRef = credentialAuthRef('oauth:provider:openai-oauth');

    await authenticateProvider('openai');

    expect(saveProviderCredential).toHaveBeenCalledWith(
      helperAuthRef,
      expect.any(String),
      expect.any(Function),
    );
    expect(deleteProviderCredential).toHaveBeenCalledWith('keyring:oauth:provider:openai-oauth');
    expect(registryState.current.providers[0]?.authRef).toBe(helperAuthRef);
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
    const helperAuthRef = credentialAuthRef('oauth:provider:openai-oauth');
    vi.mocked(deleteProviderCredential).mockResolvedValue(false);

    const result = await authenticateProvider('openai');
    expect(result.credentialCleanupPending).toBe(true);
    expect(registryState.current.providers[0]?.authRef).toBe(helperAuthRef);
    expect(registryState.current.pendingCredentialDeletes).toEqual([
      'keyring:oauth:provider:openai-oauth',
    ]);
    expect(deleteProviderCredential).toHaveBeenCalledWith('keyring:oauth:provider:openai-oauth');
    expect(deleteProviderCredential).not.toHaveBeenCalledWith(helperAuthRef);
  });

  it('does not write a credential when the durable pending marker cannot be saved', async () => {
    vi.mocked(saveRegistry).mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });

    await expect(authenticateProvider('openai')).rejects.toThrow('registry unavailable');
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(registryState.current.providers).toHaveLength(0);
  });

  it('leaves a newly written credential journaled when provider activation cannot be saved', async () => {
    vi.mocked(saveRegistry)
      .mockImplementationOnce(registry => {
        registryState.current = structuredClone(registry) as typeof registryState.current;
      })
      .mockImplementationOnce(() => {
        throw new Error('activation failed');
      });

    await expect(authenticateProvider('openai')).rejects.toThrow('activation failed');
    expect(saveProviderCredential).toHaveBeenCalled();
    expect(registryState.current.providers).toHaveLength(0);
    expect(registryState.current.pendingCredentialDeletes).toEqual([
      'keyring:oauth:provider:openai-oauth',
    ]);
    expect(deleteProviderCredential).not.toHaveBeenCalled();
  });

  it('does not let concurrent reconciliation delete a credential during activation', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    vi.mocked(saveProviderCredential).mockImplementation(async () => {
      await writeGate;
      return true;
    });

    const authentication = authenticateProvider('openai');
    await vi.waitFor(() => expect(saveProviderCredential).toHaveBeenCalledTimes(1));
    const reconciliation = reconcilePendingCredentialDeletes();
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(deleteProviderCredential).not.toHaveBeenCalled();
    releaseWrite();
    const [result, cleanup] = await Promise.all([authentication, reconciliation]);
    expect(result.registryProvider.authRef).toBe('keyring:oauth:provider:openai-oauth');
    expect(cleanup.deleted).toEqual([]);
    expect(deleteProviderCredential).not.toHaveBeenCalled();
    expect(registryState.current.pendingCredentialDeletes).toBeUndefined();
  });

  it('rejects non-OpenAI providers', async () => {
    await expect(authenticateProvider('xai')).rejects.toThrow('only available for openai');
  });
});
