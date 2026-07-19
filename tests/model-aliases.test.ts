import { describe, expect, it } from 'vitest';
import {
  isValidModelAlias,
  modelAliasTarget,
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

  it('formats a canonical HTTP-proxy target', () => {
    expect(modelAliasTarget({ providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }))
      .toBe('clodex:openai-oauth:gpt-5.6-luna');
  });
});
