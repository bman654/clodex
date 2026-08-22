import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseProvidersArgs,
  providerHubChoiceValue,
  providersHelpText,
  runProvidersAdd,
  runProvidersAuth,
  runProvidersRemove,
  runProvidersCommand,
} from '../src/providers-command.js';
import {
  removeProviderFromRegistry,
  toggleProviderEnabled,
} from '../src/registry/crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import {
  loadPendingCredentialDeletes,
  queueCredentialDelete,
} from '../src/registry/credential-cleanup-journal.js';
import { providerAuthHelpText } from '../src/registry/provider-auth.js';
import type { RegistryProvider } from '../src/registry/types.js';
import * as env from '../src/env.js';

const selectMock = vi.hoisted(() => vi.fn());
const passwordMock = vi.hoisted(() => vi.fn());
const spinnerStartMock = vi.hoisted(() => vi.fn());
const spinnerStopMock = vi.hoisted(() => vi.fn());
const addTemplateMock = vi.hoisted(() => vi.fn());
const authenticateProviderMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const logSuccessMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
const refreshProviderModelsWithCredentialMock = vi.hoisted(() => vi.fn());
const refreshAllProviderModelsMock = vi.hoisted(() => vi.fn());
const browseAllModelsMock = vi.hoisted(() => vi.fn());
const TEST_HELPER_ID = 'a'.repeat(64);
const helperRef = (account: string): string => `helper:v1:${TEST_HELPER_ID}:${account}`;

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    select: selectMock,
    password: passwordMock,
    spinner: () => ({
      start: spinnerStartMock,
      stop: spinnerStopMock,
    }),
    log: {
      ...actual.log,
      error: logErrorMock,
      success: logSuccessMock,
      warn: warnMock,
    },
  };
});

vi.mock('../src/registry/provider-auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/provider-auth.js')>();
  return {
    ...actual,
    authenticateProvider: authenticateProviderMock,
  };
});

vi.mock('../src/registry/add-template.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/add-template.js')>();
  return {
    ...actual,
    addProviderFromTemplate: addTemplateMock,
  };
});

vi.mock('../src/registry/refresh-models.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/refresh-models.js')>(),
  refreshProviderModelsWithCredential: refreshProviderModelsWithCredentialMock,
  refreshAllProviderModels: refreshAllProviderModelsMock,
}));

vi.mock('../src/prompts.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/prompts.js')>(),
  browseAllModels: browseAllModelsMock,
}));

vi.mock('../src/registry/provider-auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/provider-auth.js')>();
  return {
    ...actual,
    authenticateProvider: authenticateProviderMock,
  };
});

function openaiEntry(partial: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'openai',
    templateId: 'openai',
    name: 'OpenAI',
    enabled: true,
    authRef: 'keyring:provider:openai',
    api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
    addedAt: new Date().toISOString(),
    ...partial,
  };
}

describe('parseProvidersArgs', () => {
  it('defaults to hub', () => {
    expect(parseProvidersArgs([])).toEqual({ subcommand: 'hub', showHelp: false });
  });

  it('parses add, list, remove, refresh-models, auth', () => {
    expect(parseProvidersArgs(['add'])).toEqual({ subcommand: 'add', showHelp: false });
    expect(parseProvidersArgs(['list'])).toEqual({ subcommand: 'list', showHelp: false });
    expect(parseProvidersArgs(['auth', 'openai', '--account', 'work'])).toEqual({
      subcommand: 'auth', showHelp: false, removeId: 'openai', authMethod: undefined, authAccount: 'work',
    });
    expect(parseProvidersArgs(['auth', 'openai', '--account'])).toMatchObject({
      subcommand: 'auth', error: expect.stringContaining('--account <name>'),
    });
    expect(parseProvidersArgs(['remove', 'openai'])).toEqual({
      subcommand: 'remove',
      showHelp: false,
      removeId: 'openai',
    });
    expect(parseProvidersArgs(['refresh-models'])).toEqual({ subcommand: 'refresh-models', showHelp: false });
    expect(parseProvidersArgs(['refresh-models', 'openai-oauth'])).toEqual({
      subcommand: 'refresh-models',
      showHelp: false,
      removeId: 'openai-oauth',
    });
    expect(parseProvidersArgs(['auth', 'openai', '--native'])).toEqual({
      subcommand: 'auth',
      showHelp: false,
      removeId: 'openai',
      authMethod: 'native',
    });
    expect(parseProvidersArgs(['auth', 'openai', '--browser'])).toEqual({
      subcommand: 'auth',
      showHelp: false,
      removeId: 'openai',
      authMethod: 'browser',
    });
  });

  it('rejects the removed import subcommand', () => {
    expect(parseProvidersArgs(['import']).error).toContain('Unknown providers subcommand');
  });

  it('reports remove without id', () => {
    expect(parseProvidersArgs(['remove']).error).toContain('Usage');
  });

  it('mentions only kept subcommands in help text', () => {
    const help = providersHelpText();
    expect(help).toContain('providers add');
    expect(help).toContain('providers remove');
    expect(help).toContain('refresh-models');
    expect(help).toContain('auth openai');
    expect(help).not.toContain('import');
    expect(help).toContain('built-in provider');
  });

  it('mentions only openai in auth help', () => {
    const help = providerAuthHelpText();
    expect(help).toContain('openai');
    expect(help).not.toContain('github-copilot');
    expect(help).not.toContain('xai');
  });

  it('returns provider:id for all entries', () => {
    expect(providerHubChoiceValue({
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      modelCount: 6,
      enabled: true,
      authLabel: 'keychain',
      inRegistry: true,
    })).toBe('provider:openai-oauth');
  });
});

describe('registry crud', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-crud-'));
    process.env.CLODEX_HOME = home;
    logErrorMock.mockReset();
    logSuccessMock.mockReset();
    warnMock.mockReset();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('toggles provider enabled state', () => {
    const registry = emptyRegistry();
    registry.providers.push(openaiEntry());
    withRegistryWriteLockSync(() => saveRegistry(registry));

    expect(toggleProviderEnabled('openai')).toEqual({ toggled: true, enabled: false });
    expect(loadRegistry().providers[0]?.enabled).toBe(false);
  });

  it('removes provider and deletes its credential', async () => {
    const registry = emptyRegistry();
    registry.providers.push(openaiEntry());
    withRegistryWriteLockSync(() => saveRegistry(registry));

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    const result = await removeProviderFromRegistry('openai');
    expect(result.removed).toBe(true);
    expect(result.credentialDeleted).toBe(true);
    expect(loadRegistry().providers).toHaveLength(0);
    expect(deleteSpy).toHaveBeenCalledWith('keyring:provider:openai');
  });

  it('keeps uncertain credential cleanup queued without failing provider removal', async () => {
    const authRef = 'keyring:provider:openai';
    const registry = emptyRegistry();
    registry.providers.push(openaiEntry({ authRef }));
    withRegistryWriteLockSync(() => saveRegistry(registry));

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(false);
    const code = await runProvidersRemove('openai');

    expect(code).toBe(0);
    expect(loadRegistry().providers).toHaveLength(0);
    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([authRef]);
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(logSuccessMock).toHaveBeenCalledWith('Removed OpenAI.');
    expect(warnMock).toHaveBeenCalledWith(
      'Credential cleanup is pending and will be retried by the next provider command.',
    );
  });

  it('keeps a shared credential when another provider still references it', async () => {
    const registry = emptyRegistry();
    registry.providers.push(
      openaiEntry({ authRef: 'keyring:provider:shared' }),
      openaiEntry({ id: 'openai-oauth', name: 'OpenAI (ChatGPT)', authType: 'oauth', authRef: 'keyring:provider:shared' }),
    );
    withRegistryWriteLockSync(() => saveRegistry(registry));

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    const result = await removeProviderFromRegistry('openai');
    expect(result.removed).toBe(true);
    expect(result.credentialDeleted).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(loadRegistry().providers).toHaveLength(1);
  });

  it.each([
    { authRef: 'none:anonymous', authType: 'none' as const },
    { authRef: 'env:LOCAL_PROVIDER_API_KEY', authType: 'api' as const },
  ])('removes a provider using $authRef without attempting credential deletion', async ({ authRef, authType }) => {
    const registry = emptyRegistry();
    registry.providers.push(openaiEntry({ authRef, authType }));
    withRegistryWriteLockSync(() => saveRegistry(registry));

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(false);
    const code = await runProvidersRemove('openai');

    expect(code).toBe(0);
    expect(loadRegistry().providers).toHaveLength(0);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(logSuccessMock).toHaveBeenCalledWith('Removed OpenAI.');
  });
});

describe('providers auth command', () => {
  beforeEach(() => {
    authenticateProviderMock.mockReset();
    logErrorMock.mockReset();
    logSuccessMock.mockReset();
  });

  it('does not report success when credential persistence rejects authentication', async () => {
    authenticateProviderMock.mockRejectedValueOnce(
      new Error('Could not save OAuth tokens to the credential store: credential write failed'),
    );

    await expect(runProvidersAuth('openai')).resolves.toBe(1);

    expect(logErrorMock).toHaveBeenCalledWith(
      'Could not save OAuth tokens to the credential store: credential write failed',
    );
    expect(logSuccessMock).not.toHaveBeenCalled();
  });
});

describe('interactive OAuth account switching', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;
  const prevProviderOverride = process.env.CLODEX_KEY_OPENAI_OAUTH;
  const prevAccountOverride = process.env.CLODEX_OAUTH_ACCOUNT;

  function slottedProvider(activeAuthAccount?: string, enabled = true): RegistryProvider {
    const defaultAuthRef = 'keyring:oauth:provider:openai-oauth::credential::v1:default';
    const modelsCache = {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{
        id: 'default-only-model',
        name: 'Default-only model',
        upstreamModelId: 'default-only-model',
        modelFormat: 'openai' as const,
      }],
    };
    const authAccounts: NonNullable<RegistryProvider['authAccounts']> = {
      work: {
        authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
        addedAt: '2026-08-09T00:00:00.000Z',
      },
      alt: {
        authRef: 'keyring:oauth:provider:openai-oauth:account:alt::credential::v1:a',
        addedAt: '2026-08-09T00:00:00.000Z',
      },
    };
    if (activeAuthAccount && authAccounts[activeAuthAccount]) {
      authAccounts[activeAuthAccount] = {
        ...authAccounts[activeAuthAccount],
        modelsCache: structuredClone(modelsCache),
      };
    }
    return {
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled,
      authRef: activeAuthAccount
        ? authAccounts[activeAuthAccount]!.authRef
        : defaultAuthRef,
      ...(activeAuthAccount ? { defaultAuthRef } : {}),
      authType: 'oauth',
      authAccounts,
      ...(activeAuthAccount ? { activeAuthAccount } : {}),
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      modelsCache,
      addedAt: '2026-08-09T00:00:00.000Z',
    };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-account-switch-'));
    process.env.CLODEX_HOME = home;
    delete process.env.CLODEX_KEY_OPENAI_OAUTH;
    delete process.env.CLODEX_OAUTH_ACCOUNT;
    selectMock.mockReset();
    logErrorMock.mockReset();
    logSuccessMock.mockReset();
    warnMock.mockReset();
    refreshProviderModelsWithCredentialMock.mockReset();
    refreshAllProviderModelsMock.mockReset();
    browseAllModelsMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prevHome;
    if (prevProviderOverride === undefined) delete process.env.CLODEX_KEY_OPENAI_OAUTH;
    else process.env.CLODEX_KEY_OPENAI_OAUTH = prevProviderOverride;
    if (prevAccountOverride === undefined) delete process.env.CLODEX_OAUTH_ACCOUNT;
    else process.env.CLODEX_OAUTH_ACCOUNT = prevAccountOverride;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('retries a failed switch refresh when the same selected account still has no catalog', async () => {
    const registry = emptyRegistry();
    registry.providers.push(slottedProvider());
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('done');
    refreshProviderModelsWithCredentialMock.mockImplementation(async () => {
      expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
      return {
        id: 'openai-oauth',
        name: 'OpenAI (ChatGPT)',
        ok: false,
        reason: 'simulated discovery failure',
      };
    });

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(refreshProviderModelsWithCredentialMock).toHaveBeenCalledOnce();
    expect(refreshProviderModelsWithCredentialMock).toHaveBeenCalledWith(
      'openai-oauth',
      expect.any(Function),
      null,
      { ignoreProviderOverride: true },
    );
    expect(loadRegistry().providers[0]).toMatchObject({ activeAuthAccount: 'work' });
    expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
    expect(logErrorMock).toHaveBeenCalledWith('OpenAI (ChatGPT): simulated discovery failure');
    expect(logSuccessMock).not.toHaveBeenCalledWith(expect.stringContaining('will launch'));
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('did not produce a usable catalog'),
    );

    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('done');

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(refreshProviderModelsWithCredentialMock).toHaveBeenCalledTimes(2);
    expect(loadRegistry().providers[0]).toMatchObject({ activeAuthAccount: 'work' });
    expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
    expect(logSuccessMock).not.toHaveBeenCalledWith(expect.stringContaining('will launch'));
  });

  it('preserves an environment-account caveat when the persisted-selection refresh fails', async () => {
    const registry = emptyRegistry();
    registry.providers.push(slottedProvider());
    withRegistryWriteLockSync(() => saveRegistry(registry));
    process.env.CLODEX_OAUTH_ACCOUNT = 'alt';
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('done');
    refreshProviderModelsWithCredentialMock.mockResolvedValue({
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      ok: false,
      reason: 'simulated discovery failure',
    });

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledWith(expect.stringMatching(
      /CLODEX_OAUTH_ACCOUNT=alt overrides it in this shell.*choose Switch account again/,
    ));
    expect(warnMock).not.toHaveBeenCalledWith(expect.stringContaining('clodex providers refresh-models'));
    expect(logSuccessMock).not.toHaveBeenCalledWith(expect.stringContaining('will launch'));
  });

  it('never mistakes a provider name beginning with Saved for a safe failure caveat', async () => {
    const registry = emptyRegistry();
    const provider = slottedProvider();
    provider.name = 'Saved Provider';
    registry.providers.push(provider);
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('done');
    refreshProviderModelsWithCredentialMock.mockResolvedValue({
      id: 'openai-oauth',
      name: 'Saved Provider',
      ok: false,
      reason: 'simulated discovery failure',
    });

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('Saved work for Saved Provider.'));
    expect(warnMock.mock.calls.flat()).not.toContainEqual(expect.stringContaining('will launch'));
  });

  it('refreshes the persisted account instead of a temporary process selection', async () => {
    const registry = emptyRegistry();
    registry.providers.push(slottedProvider());
    withRegistryWriteLockSync(() => saveRegistry(registry));
    process.env.CLODEX_OAUTH_ACCOUNT = 'alt';
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('done');
    refreshProviderModelsWithCredentialMock.mockResolvedValue({
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      ok: true,
      modelCount: 1,
    });

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(loadRegistry().providers[0]).toMatchObject({ activeAuthAccount: 'work' });
    expect(refreshProviderModelsWithCredentialMock).toHaveBeenCalledWith(
      'openai-oauth',
      expect.any(Function),
      null,
      { ignoreProviderOverride: true },
    );
  });

  it('refreshes a no-op selection to verify its credential without clearing its cache', async () => {
    const registry = emptyRegistry();
    registry.providers.push(slottedProvider('work'));
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('done');
    refreshProviderModelsWithCredentialMock.mockResolvedValue({
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      ok: true,
      modelCount: 1,
    });

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(refreshProviderModelsWithCredentialMock).toHaveBeenCalledOnce();
    expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('default-only-model');
  });

  it('does not confirm a cacheless selection when refresh is skipped', async () => {
    const registry = emptyRegistry();
    registry.providers.push(slottedProvider());
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('done');
    refreshProviderModelsWithCredentialMock.mockResolvedValue({
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      ok: true,
      skipped: true,
      reason: 'simulated unsupported refresh',
    });

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
    expect(logSuccessMock).not.toHaveBeenCalledWith(expect.stringContaining('will launch'));
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('did not produce a usable catalog'));
  });

  it('revalidates a selected account with a cached catalog after its credential refresh fails', async () => {
    const registry = emptyRegistry();
    const provider = slottedProvider();
    provider.authAccounts!.work!.modelsCache = {
      fetchedAt: '2026-08-09T01:00:00.000Z',
      models: [{
        id: 'work-only-model',
        name: 'Work only model',
        upstreamModelId: 'work-only-model',
        modelFormat: 'openai',
      }],
    };
    registry.providers.push(provider);
    withRegistryWriteLockSync(() => saveRegistry(registry));
    refreshProviderModelsWithCredentialMock.mockResolvedValue({
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      ok: false,
      reason: 'OAuth token not available',
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      selectMock
        .mockResolvedValueOnce('provider:openai-oauth')
        .mockResolvedValueOnce('account')
        .mockResolvedValueOnce('work')
        .mockResolvedValueOnce('done');
      await expect(runProvidersCommand([])).resolves.toBe(0);
    }

    expect(refreshProviderModelsWithCredentialMock).toHaveBeenCalledTimes(2);
    expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('work-only-model');
    expect(logSuccessMock).not.toHaveBeenCalledWith(expect.stringContaining('will launch'));
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('did not produce a usable catalog'));
  });

  it('serializes a saved selection through its refresh before another switch can win', async () => {
    const registry = emptyRegistry();
    registry.providers.push(slottedProvider());
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('alt')
      .mockResolvedValueOnce('done')
      .mockResolvedValueOnce('done');

    let releaseFirstRefresh!: () => void;
    const firstRefreshGate = new Promise<void>(resolve => {
      releaseFirstRefresh = resolve;
    });
    let markFirstRefreshStarted!: () => void;
    const firstRefreshStarted = new Promise<void>(resolve => {
      markFirstRefreshStarted = resolve;
    });
    const refreshedSelections: Array<string | undefined> = [];
    refreshProviderModelsWithCredentialMock.mockImplementation(async () => {
      refreshedSelections.push(loadRegistry().providers[0]?.activeAuthAccount);
      if (refreshedSelections.length === 1) {
        markFirstRefreshStarted();
        await firstRefreshGate;
      }
      return {
        id: 'openai-oauth',
        name: 'OpenAI (ChatGPT)',
        ok: false,
        reason: 'simulated discovery failure',
      };
    });

    const firstSwitch = runProvidersCommand([]);
    await firstRefreshStarted;
    const secondSwitch = runProvidersCommand([]);
    await new Promise(resolve => setTimeout(resolve, 50));

    // The second command has made its picker choice, but cannot persist it
    // until the first command's targeted refresh and outcome are complete.
    expect(loadRegistry().providers[0]?.activeAuthAccount).toBe('work');
    releaseFirstRefresh();
    await expect(Promise.all([firstSwitch, secondSwitch])).resolves.toEqual([0, 0]);

    expect(refreshedSelections).toEqual(['work', 'alt']);
    expect(loadRegistry().providers[0]?.activeAuthAccount).toBe('alt');
  });

  it('browses the projected account catalog for a disabled OAuth provider', async () => {
    const registry = emptyRegistry();
    const provider = slottedProvider('work', false);
    provider.authAccounts!.alt!.modelsCache = {
      fetchedAt: '2026-08-09T01:00:00.000Z',
      models: [{
        id: 'alt-only-model',
        name: 'Alt only model',
        upstreamModelId: 'alt-only-model',
        modelFormat: 'openai',
      }],
    };
    registry.providers.push(provider);
    withRegistryWriteLockSync(() => saveRegistry(registry));
    process.env.CLODEX_OAUTH_ACCOUNT = 'alt';
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('browse')
      .mockResolvedValueOnce('done');

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(browseAllModelsMock).toHaveBeenCalledOnce();
    expect(browseAllModelsMock.mock.calls[0]?.[0].models.map((model: { id: string }) => model.id))
      .toEqual(['alt-only-model']);
  });

  it('does not offer another account catalog when the disabled projection has no cache', async () => {
    const registry = emptyRegistry();
    registry.providers.push(slottedProvider('work', false));
    withRegistryWriteLockSync(() => saveRegistry(registry));
    process.env.CLODEX_OAUTH_ACCOUNT = 'alt';
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('back')
      .mockResolvedValueOnce('done');

    await expect(runProvidersCommand([])).resolves.toBe(0);

    const detailOptions = selectMock.mock.calls[1]?.[0].options as Array<{ value: string }>;
    expect(detailOptions.map(option => option.value)).not.toContain('browse');
    expect(browseAllModelsMock).not.toHaveBeenCalled();
  });

  it('does not offer a stored account catalog under a provider-key override', async () => {
    const registry = emptyRegistry();
    registry.providers.push(slottedProvider('work'));
    withRegistryWriteLockSync(() => saveRegistry(registry));
    process.env.CLODEX_KEY_OPENAI_OAUTH = 'temporary-provider-token';
    selectMock
      .mockResolvedValueOnce('provider:openai-oauth')
      .mockResolvedValueOnce('back')
      .mockResolvedValueOnce('done');

    await expect(runProvidersCommand([])).resolves.toBe(0);

    const detailOptions = selectMock.mock.calls[1]?.[0].options as Array<{ value: string }>;
    expect(detailOptions.map(option => option.value)).not.toContain('browse');
    expect(browseAllModelsMock).not.toHaveBeenCalled();
  });

  it('browses only retained models present in the projected authority', async () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
      modelsCache: {
        fetchedAt: '2026-08-12T00:00:00.000Z',
        models: [{
          id: 'deepseek-v4-pro',
          name: 'stale name',
          upstreamModelId: 'deepseek-v4-pro',
          modelFormat: 'openai',
        }, {
          id: 'stale-future-model',
          name: 'Stale future model',
          upstreamModelId: 'stale-future-model',
          modelFormat: 'openai',
        }],
      },
      addedAt: '2026-08-12T00:00:00.000Z',
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock
      .mockResolvedValueOnce('provider:opencode-go')
      .mockResolvedValueOnce('browse')
      .mockResolvedValueOnce('done');

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(browseAllModelsMock.mock.calls[0]?.[0].models.map((model: { id: string }) => model.id))
      .toEqual(['deepseek-v4-pro']);
  });

  it('excludes stale retained models from browse and readiness while preserving the cache', async () => {
    const registry = emptyRegistry();
    const provider = slottedProvider('work');
    provider.id = 'imported-opencode';
    provider.templateId = 'opencode-go';
    provider.name = 'Imported OpenCode Go';
    provider.api = { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' };
    provider.modelsCache = {
      fetchedAt: '2026-08-12T00:00:00.000Z',
      models: [{
        id: 'stale-future-model',
        name: 'Stale future model',
        upstreamModelId: 'stale-future-model',
        modelFormat: 'openai',
      }],
    };
    provider.authAccounts!.work!.modelsCache = provider.modelsCache;
    registry.providers.push(provider);
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock
      .mockResolvedValueOnce('provider:imported-opencode')
      .mockResolvedValueOnce('account')
      .mockResolvedValueOnce('work')
      .mockResolvedValueOnce('done');
    refreshProviderModelsWithCredentialMock.mockResolvedValue({
      id: 'imported-opencode',
      name: 'Imported OpenCode Go',
      ok: true,
      modelCount: 1,
    });

    await expect(runProvidersCommand([])).resolves.toBe(0);

    const detailOptions = selectMock.mock.calls[1]?.[0].options as Array<{ value: string }>;
    expect(detailOptions.map(option => option.value)).not.toContain('browse');
    expect(browseAllModelsMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('did not produce a usable catalog'));
    expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('stale-future-model');
  });
});

describe('provider removal cleanup', () => {
  it('removes the provider and queues cleanup when deletion has an unknown outcome', async () => {
    const registry = emptyRegistry();
    registry.providers.push(openaiEntry({ authRef: helperRef('provider:openai') }));
    withRegistryWriteLockSync(() => saveRegistry(registry));

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockImplementation(async () => {
      const duringDelete = loadRegistry();
      expect(duringDelete.providers).toHaveLength(0);
      await expect(loadPendingCredentialDeletes()).resolves.toEqual([
        helperRef('provider:openai'),
      ]);
      return false;
    });
    const result = await removeProviderFromRegistry('openai');

    expect(result.removed).toBe(true);
    expect(result.credentialCleanupPending).toBe(true);
    expect(result.error).toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledWith(helperRef('provider:openai'));
    expect(loadRegistry().providers).toHaveLength(0);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([
      helperRef('provider:openai'),
    ]);
  });
});

describe('provider command cleanup reconciliation', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-provider-cleanup-'));
    process.env.CLODEX_HOME = home;
    selectMock.mockReset();
    passwordMock.mockReset();
    addTemplateMock.mockReset();
    authenticateProviderMock.mockReset();
    logErrorMock.mockReset();
    warnMock.mockReset();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('persists uncertain cleanup for retry after a process restart', async () => {
    const authRef = helperRef('provider:stale');
    await queueCredentialDelete(authRef);
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runProvidersCommand(['auth']);

    expect(deleteSpy).toHaveBeenNthCalledWith(1, authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([authRef]);
    expect(warnMock).toHaveBeenCalledWith(
      'Credential cleanup is pending and will be retried by the next provider command.',
    );
    const persisted = JSON.parse(
      readFileSync(join(home, 'credential-cleanup.json'), 'utf8'),
    ) as { pendingCredentialDeletes?: string[] };
    expect(persisted.pendingCredentialDeletes).toEqual([authRef]);

    await runProvidersCommand(['auth']);

    expect(deleteSpy).toHaveBeenNthCalledWith(2, authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([]);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('warns once when a mutating command leaves cleanup pending', async () => {
    const authRef = helperRef('provider:openai');
    const registry = emptyRegistry();
    registry.providers.push(openaiEntry({ authRef }));
    withRegistryWriteLockSync(() => saveRegistry(registry));
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(false);

    await expect(runProvidersCommand(['remove', 'openai'])).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      'Credential cleanup is pending and will be retried by the next provider command.',
    );
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([authRef]);
  });

  it('retries queued cleanup when the add picker is cancelled', async () => {
    const authRef = helperRef('provider:retired');
    await queueCredentialDelete(authRef);
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    selectMock.mockResolvedValue(Symbol('cancel'));

    await expect(runProvidersCommand(['add'])).resolves.toBe(0);

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('retries queued cleanup when an add flow returns before mutation', async () => {
    const authRef = helperRef('provider:retired');
    await queueCredentialDelete(authRef);
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    selectMock.mockResolvedValue('api:openai');
    passwordMock.mockResolvedValue('test-key');
    addTemplateMock.mockResolvedValue({
      added: false,
      error: 'Provider package is unavailable.',
    });

    await expect(runProvidersCommand(['add'])).resolves.toBe(1);

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('retries queued cleanup when remove returns before mutation', async () => {
    const authRef = helperRef('provider:retired');
    await queueCredentialDelete(authRef);
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);

    await expect(runProvidersCommand(['remove', 'missing-provider'])).resolves.toBe(1);

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('retries queued cleanup when authorization is cancelled', async () => {
    const authRef = helperRef('provider:retired');
    await queueCredentialDelete(authRef);
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    authenticateProviderMock.mockRejectedValue(new Error('Cancelled'));

    await expect(runProvidersCommand(['auth', 'openai'])).resolves.toBe(0);

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('warns once when authorization fails and queued cleanup remains', async () => {
    const authRef = helperRef('provider:retired');
    await queueCredentialDelete(authRef);
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(false);
    authenticateProviderMock.mockRejectedValue(new Error('Authorization failed.'));

    await expect(runProvidersCommand(['auth', 'openai'])).resolves.toBe(1);

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([authRef]);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      'Credential cleanup is pending and will be retried by the next provider command.',
    );
  });

  it('reconciles hub add cleanup when the mutation throws after journaling', async () => {
    const authRef = helperRef('provider:replaced');
    selectMock
      .mockResolvedValueOnce('add')
      .mockResolvedValueOnce('api:openai');
    passwordMock.mockResolvedValue('test-key');
    addTemplateMock.mockImplementation(async () => {
      await queueCredentialDelete(authRef);
      throw new Error('Credential save failed.');
    });
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(false);

    await expect(runProvidersCommand([])).rejects.toThrow('Credential save failed.');

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([authRef]);
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock).toHaveBeenCalledWith(
      'Credential cleanup is pending and will be retried by the next provider command.',
    );
  });

  it('reconciles provider-detail OAuth cleanup when authentication fails after journaling', async () => {
    const authRef = helperRef('provider:replaced-oauth');
    const registry = emptyRegistry();
    registry.providers.push(openaiEntry());
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock
      .mockResolvedValueOnce('provider:openai')
      .mockResolvedValueOnce('auth')
      .mockResolvedValueOnce('done');
    authenticateProviderMock.mockImplementation(async () => {
      await queueCredentialDelete(authRef);
      throw new Error('Credential save failed.');
    });
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(false);

    await expect(runProvidersCommand([])).resolves.toBe(0);

    expect(logErrorMock).toHaveBeenCalledWith('Credential save failed.');
    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([authRef]);
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock).toHaveBeenCalledWith(
      'Credential cleanup is pending and will be retried by the next provider command.',
    );
  });
});

describe('providers add menu', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-providers-add-'));
    process.env.CLODEX_HOME = home;
    selectMock.mockReset();
    passwordMock.mockReset();
    spinnerStartMock.mockReset();
    spinnerStopMock.mockReset();
    addTemplateMock.mockReset();
    warnMock.mockReset();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('offers ChatGPT OAuth followed by OpenAI and OpenCode Go API keys', async () => {
    selectMock.mockResolvedValue('noop');

    await runProvidersAdd();

    const options = selectMock.mock.calls[0]?.[0].options.map((option: { value: string }) => option.value);
    expect(options).toEqual(['oauth', 'api:openai', 'api:opencode-go']);
  });

  it('adds OpenCode Go through the shared API-key flow', async () => {
    selectMock.mockResolvedValue('api:opencode-go');
    passwordMock.mockResolvedValue('go-key');
    addTemplateMock.mockResolvedValue({ added: true, modelCount: 17 });

    await expect(runProvidersAdd()).resolves.toBe(0);

    expect(addTemplateMock).toHaveBeenCalledOnce();
    expect(addTemplateMock.mock.calls[0]?.[0]).toMatchObject({
      id: 'opencode-go',
      name: 'OpenCode Go',
      staticModelPolicy: 'allowlist',
    });
    expect(addTemplateMock.mock.calls[0]?.[1]).toBe('go-key');
  });

  it('omits OpenCode Go when a migrated provider retains its built-in template identity', async () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'imported-opencode',
      templateId: 'opencode-go',
      name: 'Imported OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:imported-opencode',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://custom.invalid/v1' },
      addedAt: '2026-08-11T00:00:00.000Z',
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock.mockResolvedValue('noop');

    await expect(runProvidersAdd()).resolves.toBe(0);

    const options = selectMock.mock.calls[0]?.[0].options.map((option: { value: string }) => option.value);
    expect(options).toEqual(['oauth', 'api:openai']);
    expect(passwordMock).not.toHaveBeenCalled();
    expect(addTemplateMock).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'opencode-go', name: 'canonical' },
    { id: 'imported-opencode', name: 'migrated' },
  ])('refuses a direct OpenCode Go add for an already configured $name identity', async ({ id }) => {
    const registry = emptyRegistry();
    registry.providers.push({
      id,
      templateId: 'opencode-go',
      name: 'Configured OpenCode Go',
      enabled: true,
      authRef: `keyring:provider:${id}`,
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://custom.invalid/v1' },
      addedAt: '2026-08-11T00:00:00.000Z',
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock.mockResolvedValue('api:opencode-go');

    await expect(runProvidersAdd()).resolves.toBe(0);

    expect(passwordMock).not.toHaveBeenCalled();
    expect(addTemplateMock).not.toHaveBeenCalled();
  });

  it('does not treat an ordinary custom provider template as the configured built-in', async () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'custom-openai-endpoint',
      templateId: 'openai',
      name: 'Custom OpenAI endpoint',
      enabled: true,
      authRef: 'keyring:provider:custom-openai-endpoint',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://custom.invalid/v1' },
      addedAt: '2026-08-11T00:00:00.000Z',
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));
    selectMock.mockResolvedValue('noop');

    await expect(runProvidersAdd()).resolves.toBe(0);

    const options = selectMock.mock.calls[0]?.[0].options.map((option: { value: string }) => option.value);
    expect(options).toEqual(['oauth', 'api:openai', 'api:opencode-go']);
  });

  it('reports pending cleanup after an API-key provider is committed', async () => {
    selectMock.mockResolvedValue('api:openai');
    passwordMock.mockResolvedValue('api-key');
    addTemplateMock.mockResolvedValue({
      added: true,
      modelCount: 3,
      credentialCleanupPending: true,
    });

    await expect(runProvidersAdd()).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledWith(
      'Credential cleanup is pending and will be retried by the next provider command.',
    );
  });
});
