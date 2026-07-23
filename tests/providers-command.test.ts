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
const authenticateProviderMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
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
    expect(help).not.toContain('OpenCode');
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
    selectMock.mockResolvedValue('apikey');
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

  it('offers ChatGPT OAuth first and API key second', async () => {
    selectMock.mockResolvedValue('noop');

    await runProvidersAdd();

    const options = selectMock.mock.calls[0]?.[0].options.map((option: { value: string }) => option.value);
    expect(options).toEqual(['oauth', 'apikey']);
  });

  it('reports pending cleanup after an API-key provider is committed', async () => {
    selectMock.mockResolvedValue('apikey');
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
