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

const { loadPreferences, savePreferences } = await import('../src/config.js');
const { parseArgs, runModelsCommand } = await import('../src/cli.js');

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
});
