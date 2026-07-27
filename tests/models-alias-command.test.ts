import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreferences, savePreferences } from '../src/config.js';
import { runModelsCommand } from '../src/cli.js';
import { getConfigPath } from '../src/paths.js';

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-alias-command-'));
  process.env['CLODEX_HOME'] = tempHome;
  savePreferences({
    favoriteModels: [
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ],
  });
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CLODEX_HOME'];
});

describe('models alias command', () => {
  it('saves, replaces, and removes an alias for a favorite', async () => {
    // The value can be copied directly from `clodex models --list`, including
    // Claude's synthetic context-window suffix.
    expect(await runModelsCommand({ alias: 'LuNa=clodex:openai-oauth:gpt-5.6-luna[1m]' })).toBe(0);
    expect(loadPreferences().modelAliases).toEqual([
      { name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    ]);

    expect(await runModelsCommand({ alias: 'LUNA=openai-oauth:gpt-5.6-sol' })).toBe(0);
    expect(loadPreferences().modelAliases).toEqual([
      { name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);

    expect(await runModelsCommand({ unalias: 'Luna' })).toBe(0);
    expect(loadPreferences().modelAliases).toEqual([]);
  });

  it('rejects aliases whose targets are not saved favorites', async () => {
    expect(await runModelsCommand({ alias: 'other=clodex:openai-oauth:gpt-other' })).toBe(1);
    expect(loadPreferences().modelAliases).toBeUndefined();
  });

  it('rejects reserved names without changing saved aliases', async () => {
    expect(await runModelsCommand({
      alias: 'safe=clodex:openai-oauth:gpt-5.6-luna',
    })).toBe(0);
    const before = loadPreferences().modelAliases;

    expect(await runModelsCommand({
      alias: 'BeSt=clodex:openai-oauth:gpt-5.6-sol',
    })).toBe(1);
    expect(loadPreferences().modelAliases).toEqual(before);
  });

  it('removes one alias without discarding unrelated inactive entries', async () => {
    const aliases = [
      { name: 'Active', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
      { name: 'default', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
      { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
      { name: 'bad:name', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ];
    writeFileSync(getConfigPath(), JSON.stringify({
      favoriteModels: loadPreferences().favoriteModels,
      modelAliases: aliases,
    }));

    expect(await runModelsCommand({ unalias: 'ACTIVE' })).toBe(0);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).modelAliases).toEqual(aliases.slice(1));
  });

  it('replaces one canonical alias without discarding unrelated inactive entries', async () => {
    const unrelated = [
      { name: 'default', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
      { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
      { name: 'bad:name', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ];
    writeFileSync(getConfigPath(), JSON.stringify({
      favoriteModels: loadPreferences().favoriteModels,
      modelAliases: [
        { name: 'LuNa', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
        ...unrelated,
      ],
    }));

    expect(await runModelsCommand({
      alias: 'LUNA=clodex:openai-oauth:gpt-5.6-sol',
    })).toBe(0);
    const saved = JSON.parse(readFileSync(getConfigPath(), 'utf8')).modelAliases;
    expect(saved.filter((alias: { name: string }) => alias.name.toLowerCase() === 'luna')).toEqual([
      { name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);
    expect(saved.filter((alias: { name: string }) => alias.name.toLowerCase() !== 'luna')).toEqual(unrelated);
  });

  it('adds one canonical alias without discarding unrelated inactive entries', async () => {
    const unrelated = [
      { name: 'default', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
      { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
    ];
    writeFileSync(getConfigPath(), JSON.stringify({
      favoriteModels: loadPreferences().favoriteModels,
      modelAliases: unrelated,
    }));

    expect(await runModelsCommand({
      alias: 'Fresh=clodex:openai-oauth:gpt-5.6-luna',
    })).toBe(0);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).modelAliases).toEqual([
      ...unrelated,
      { name: 'fresh', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    ]);
  });

  it('removes reserved and conflicting inactive aliases by canonical name', async () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      favoriteModels: loadPreferences().favoriteModels,
      modelAliases: [
        { name: 'default', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
        { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
        { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
        { name: 'safe', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
      ],
    }));

    expect(await runModelsCommand({ unalias: 'DEFAULT' })).toBe(0);
    expect(await runModelsCommand({ unalias: 'orbit' })).toBe(0);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).modelAliases).toEqual([
      { name: 'safe', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    ]);
  });
});
