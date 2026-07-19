import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreferences, savePreferences } from '../src/config.js';
import { runModelsCommand } from '../src/cli.js';

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-alias-command-'));
  process.env['CLODEX_HOME'] = tempHome;
  savePreferences({
    favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }],
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
    expect(await runModelsCommand({ alias: 'luna=clodex:openai-oauth:gpt-5.6-luna[1m]' })).toBe(0);
    expect(loadPreferences().modelAliases).toEqual([
      { name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    ]);

    expect(await runModelsCommand({ alias: 'luna=openai-oauth:gpt-5.6-luna' })).toBe(0);
    expect(loadPreferences().modelAliases).toHaveLength(1);

    expect(await runModelsCommand({ unalias: 'luna' })).toBe(0);
    expect(loadPreferences().modelAliases).toEqual([]);
  });

  it('rejects aliases whose targets are not saved favorites', async () => {
    expect(await runModelsCommand({ alias: 'other=clodex:openai-oauth:gpt-other' })).toBe(1);
    expect(loadPreferences().modelAliases).toBeUndefined();
  });
});
