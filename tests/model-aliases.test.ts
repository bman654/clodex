import { describe, expect, it } from 'vitest';
import {
  canonicalModelAliasName,
  isValidModelAlias,
  modelAliasTarget,
  normalizeModelAliases,
  parseModelAliasAssignment,
} from '../src/model-aliases.js';

describe('model aliases', () => {
  it('parses canonical and prefix-free targets while preserving colons in model ids', () => {
    expect(parseModelAliasAssignment('luna=clodex:openai-oauth:gpt-5.6-luna')).toEqual({
      name: 'luna',
      providerId: 'openai-oauth',
      modelId: 'gpt-5.6-luna',
    });
    expect(parseModelAliasAssignment('free=kilo:model:free')).toEqual({
      name: 'free',
      providerId: 'kilo',
      modelId: 'model:free',
    });
    expect(parseModelAliasAssignment('luna=clodex:openai-oauth:gpt-5.6-luna[1m]')).toEqual({
      name: 'luna',
      providerId: 'openai-oauth',
      modelId: 'gpt-5.6-luna',
    });
  });

  it('rejects malformed or unsafe names and targets', () => {
    expect(parseModelAliasAssignment('luna')).toHaveProperty('error');
    expect(parseModelAliasAssignment('bad name=clodex:openai:gpt-5')).toHaveProperty('error');
    expect(parseModelAliasAssignment('luna=gpt-5')).toHaveProperty('error');
    expect(isValidModelAlias('luna_2-fast')).toBe(true);
    expect(isValidModelAlias('clodex:openai:model')).toBe(false);
  });

  it('canonicalizes mixed-case names and rejects reserved names case-insensitively', () => {
    expect(canonicalModelAliasName(' LuNa ')).toBe('luna');
    expect(parseModelAliasAssignment('LuNa=clodex:openai-oauth:gpt-5.6-luna')).toEqual({
      name: 'luna',
      providerId: 'openai-oauth',
      modelId: 'gpt-5.6-luna',
    });

    for (const name of ['sonnet', 'OpUs', 'HAIKU', 'fable', 'best', 'opusplan', 'inherit']) {
      expect(isValidModelAlias(name)).toBe(false);
      expect(parseModelAliasAssignment(`${name}=clodex:provider:model`)).toEqual({
        error: 'That alias name is reserved by the client.',
      });
    }
  });

  it('collapses equivalent case variants and rejects ambiguous collisions', () => {
    const normalized = normalizeModelAliases([
      { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
      { name: 'luna', providerId: 'one', modelId: 'model-a' },
      { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
      { name: 'best', providerId: 'one', modelId: 'model-a' },
    ]);

    expect(normalized.aliases).toEqual([
      { name: 'luna', providerId: 'one', modelId: 'model-a' },
    ]);
    expect(normalized.rejected).toEqual([
      { name: 'luna', providerId: 'one', modelId: 'model-a' },
      { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
      { name: 'best', providerId: 'one', modelId: 'model-a' },
    ]);
  });

  it('formats a canonical HTTP-proxy target', () => {
    expect(modelAliasTarget({ providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }))
      .toBe('clodex:openai-oauth:gpt-5.6-luna');
  });
});
