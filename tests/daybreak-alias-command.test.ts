import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as p from '@clack/prompts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalProvider } from '../src/types.js';

const catalog: LocalProvider[] = [{
  id: 'openai-oauth',
  name: 'OpenAI (ChatGPT)',
  apiKey: '',
  authType: 'oauth',
  models: [
    {
      id: 'gpt-6-luna', upstreamModelId: 'gpt-6-luna', name: 'GPT-6 Luna', family: 'gpt', brand: 'OpenAI',
      modelFormat: 'openai', npm: '@ai-sdk/openai', cyberAccessPrograms: ['standard', 'daybreak_blue'],
    },
    {
      id: 'gpt-6.1-sol', upstreamModelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', family: 'gpt', brand: 'OpenAI',
      modelFormat: 'openai', npm: '@ai-sdk/openai', cyberAccessPrograms: ['standard'],
    },
    {
      // Cached by a clodex that did not record programs yet.
      id: 'gpt-6-sol', upstreamModelId: 'gpt-6-sol', name: 'GPT-6 Sol', family: 'gpt', brand: 'OpenAI',
      modelFormat: 'openai', npm: '@ai-sdk/openai',
    },
  ],
}];

// The provider catalog and its credentials are the boundary; everything from
// there to the saved alias runs as the proxy runs it.
vi.mock('../src/provider-catalog.js', async original => ({
  ...await original<typeof import('../src/provider-catalog.js')>(),
  fetchProviderCatalog: vi.fn(async () => catalog),
  resolveLocalProviderApiKey: vi.fn(async () => 'tok'),
}));

vi.mock('../src/registry/models-dev.js', async original => ({
  ...await original<typeof import('../src/registry/models-dev.js')>(),
  refreshModelsDevCacheAsync: vi.fn(),
}));

const { loadPreferences, savePreferences } = await import('../src/config.js');
const { main, parseArgs, runModelsCommand } = await import('../src/cli.js');

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-daybreak-alias-'));
  process.env['CLODEX_HOME'] = tempHome;
  savePreferences({
    favoriteModels: catalog[0]!.models.map(model => ({ providerId: 'openai-oauth', modelId: model.id })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CLODEX_HOME'];
});

describe('clodex models --alias … --daybreak', () => {
  it('parses the flag', () => {
    expect(parseArgs(['models', '--alias', 'blue=openai-oauth:gpt-6-luna', '--daybreak']))
      .toMatchObject({ favoritesAlias: 'blue=openai-oauth:gpt-6-luna', favoritesDaybreak: true });
  });

  it('saves the opt-in and names the program the catalog offers', async () => {
    const success = vi.spyOn(p.log, 'success').mockImplementation(() => {});
    expect(await runModelsCommand({ alias: 'blue=openai-oauth:gpt-6-luna', daybreak: true })).toBe(0);
    expect(loadPreferences().modelAliases).toEqual([
      { name: 'blue', providerId: 'openai-oauth', modelId: 'gpt-6-luna', daybreak: true },
    ]);
    expect(success).toHaveBeenCalledWith('Saved model alias blue → clodex:openai-oauth:gpt-6-luna (Daybreak Blue).');
  });

  it('turns Daybreak off when the alias is saved again without the flag', async () => {
    expect(await runModelsCommand({ alias: 'blue=openai-oauth:gpt-6-luna', daybreak: true })).toBe(0);
    expect(await runModelsCommand({ alias: 'blue=openai-oauth:gpt-6-luna' })).toBe(0);
    expect(loadPreferences().modelAliases).toEqual([
      { name: 'blue', providerId: 'openai-oauth', modelId: 'gpt-6-luna' },
    ]);
  });

  it.each([
    ['gpt-6.1-sol', "Daybreak isn't available for gpt-6.1-sol on this ChatGPT account"],
    ['gpt-6-sol', 'run `clodex providers refresh-models` to load it'],
  ])('refuses %s and saves nothing', async (modelId, reason) => {
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    expect(await runModelsCommand({ alias: `x=openai-oauth:${modelId}`, daybreak: true })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(reason));
    expect(loadPreferences().modelAliases).toBeUndefined();
  });

  it('needs --alias', async () => {
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    expect(await runModelsCommand({ list: true, daybreak: true })).toBe(1);
    expect(error).toHaveBeenCalledWith('--daybreak applies to --alias.');
  });

  it('saves the opt-in from the command line as a user types it', async () => {
    vi.spyOn(p.log, 'success').mockImplementation(() => {});
    expect(await main(['models', '--alias', 'blue=clodex:openai-oauth:gpt-6-luna', '--daybreak'])).toBe(0);
    expect(loadPreferences().modelAliases).toEqual([
      { name: 'blue', providerId: 'openai-oauth', modelId: 'gpt-6-luna', daybreak: true },
    ]);
  });

  // The endpoint server answers its own model ids before saved aliases, so a
  // Daybreak alias with such a name would be served there without Daybreak.
  it('refuses an alias name the endpoint server answers as a model id', async () => {
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    expect(await runModelsCommand({ alias: 'gpt-6-luna=openai-oauth:gpt-6-luna', daybreak: true })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the endpoint server answers that name as a model id'));
    expect(loadPreferences().modelAliases).toBeUndefined();
  });

  it('refuses a masked discovery id as a name too', async () => {
    // The masked form of anthropic-openai-oauth__gpt-6-luna, spelled out rather
    // than computed with the helper under test.
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    expect(await runModelsCommand({ alias: 'anthropic-htuao-ianepo__anul-6-tpg=openai-oauth:gpt-6-luna', daybreak: true }))
      .toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the endpoint server answers that name as a model id'));
    expect(loadPreferences().modelAliases).toBeUndefined();
  });

  const context = {
    contextAssignments: [{ label: 'x', providerId: 'openai-oauth', modelId: 'gpt-6-luna', stop: 'max' as const }],
    saveContext: true,
  };
  it.each([
    ['a Daybreak alias with --json', { alias: 'blue=openai-oauth:gpt-6-luna', daybreak: true, json: true }],
    ['a Daybreak alias with --context', { alias: 'blue=openai-oauth:gpt-6-luna', daybreak: true, ...context }],
    ['a plain alias with --json', { alias: 'blue=openai-oauth:gpt-6-luna', json: true }],
    ['a plain alias with --context', { alias: 'blue=openai-oauth:gpt-6-luna', ...context }],
    ['--unalias with --json', { unalias: 'keep', json: true }],
    ['--unalias with --context', { unalias: 'keep', ...context }],
  ])('refuses %s instead of skipping the alias change', async (_label, options) => {
    savePreferences({ modelAliases: [{ name: 'keep', providerId: 'openai-oauth', modelId: 'gpt-6-luna' }] });
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    expect(await runModelsCommand(options)).toBe(1);
    expect(error).toHaveBeenCalledWith('--alias/--unalias run on their own, without --json or --context.');
    expect(loadPreferences().modelAliases).toEqual([{ name: 'keep', providerId: 'openai-oauth', modelId: 'gpt-6-luna' }]);
    expect(loadPreferences().modelContextModes).toBeUndefined();
  });
});
