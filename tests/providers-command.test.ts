import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseProvidersArgs, providerHubChoiceValue, providersHelpText, runProvidersAdd } from '../src/providers-command.js';
import {
  removeProviderFromRegistry,
  toggleProviderEnabled,
} from '../src/registry/crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import { providerAuthHelpText } from '../src/registry/provider-auth.js';
import type { RegistryProvider } from '../src/registry/types.js';
import * as env from '../src/env.js';

const selectMock = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    select: selectMock,
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
    saveRegistry(registry);

    expect(toggleProviderEnabled('openai')).toEqual({ toggled: true, enabled: false });
    expect(loadRegistry().providers[0]?.enabled).toBe(false);
  });

  it('removes provider and deletes its credential', async () => {
    const registry = emptyRegistry();
    registry.providers.push(openaiEntry());
    saveRegistry(registry);

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    const result = await removeProviderFromRegistry('openai');
    expect(result.removed).toBe(true);
    expect(result.credentialDeleted).toBe(true);
    expect(loadRegistry().providers).toHaveLength(0);
    expect(deleteSpy).toHaveBeenCalledWith('keyring:provider:openai');
  });

  it('keeps a shared credential when another provider still references it', async () => {
    const registry = emptyRegistry();
    registry.providers.push(
      openaiEntry({ authRef: 'keyring:provider:shared' }),
      openaiEntry({ id: 'openai-oauth', name: 'OpenAI (ChatGPT)', authType: 'oauth', authRef: 'keyring:provider:shared' }),
    );
    saveRegistry(registry);

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    const result = await removeProviderFromRegistry('openai');
    expect(result.removed).toBe(true);
    expect(result.credentialDeleted).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(loadRegistry().providers).toHaveLength(1);
  });
});

describe('providers add menu', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-providers-add-'));
    process.env.CLODEX_HOME = home;
    selectMock.mockReset();
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
});
