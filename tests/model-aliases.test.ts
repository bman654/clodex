import { describe, expect, it } from 'vitest';
import {
  canonicalModelAliasName,
  describeModelAliasRejection,
  isValidModelAlias,
  modelAliasLookupKey,
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

    for (const name of ['sonnet', 'OpUs', 'HAIKU', 'fable', 'best', 'opusplan', 'inherit', 'DeFaUlT']) {
      expect(isValidModelAlias(name)).toBe(false);
      expect(parseModelAliasAssignment(`${name}=clodex:provider:model`)).toEqual({
        error: 'That alias name is reserved by the client.',
      });
    }
  });

  it('shares writer identity for valid spellings without absorbing route or malformed identities', () => {
    expect(modelAliasLookupKey(' DeFaUlT ')).toBe('default');
    expect(modelAliasLookupKey('DEFAULT')).toBe('default');
    expect(modelAliasLookupKey('luna')).not.toBe(modelAliasLookupKey('orbit'));
    expect(modelAliasLookupKey('DeFaUlT[1m]')).toBe('DeFaUlT[1m]');
    expect(modelAliasLookupKey('clodex:Provider:Model')).toBe('clodex:Provider:Model');
    expect(modelAliasLookupKey('Bad Alias')).toBe('Bad Alias');
  });

  it('collapses equivalent case variants and rejects ambiguous collisions', () => {
    const normalized = normalizeModelAliases([
      { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
      { name: 'LUNA', providerId: 'one', modelId: 'model-a' },
      { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
      { name: 'best', providerId: 'one', modelId: 'model-a' },
    ]);

    expect(normalized.aliases).toEqual([
      { name: 'luna', providerId: 'one', modelId: 'model-a' },
    ]);
    expect(normalized.accepted).toEqual([
      {
        alias: { name: 'luna', providerId: 'one', modelId: 'model-a' },
        source: { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
        sources: [
          { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
          { name: 'LUNA', providerId: 'one', modelId: 'model-a' },
        ],
      },
    ]);
    expect(normalized.rejected).toEqual([
      { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
      { name: 'best', providerId: 'one', modelId: 'model-a' },
    ]);
  });

  it('rejects named malformed targets without rewriting their stored records', () => {
    const missingProvider = { name: 'MiSsInG', modelId: 'model-a' };
    const numericModel = { name: 'NuMeRiC', providerId: 'one', modelId: 42 };

    const normalized = normalizeModelAliases([missingProvider, numericModel]);

    expect(normalized.aliases).toEqual([]);
    expect(normalized.rejections).toEqual([
      { alias: missingProvider, reason: 'invalid-target' },
      { alias: numericModel, reason: 'invalid-target' },
    ]);
    expect(normalized.rejections[0]?.alias).toBe(missingProvider);
    expect(normalized.rejections[1]?.alias).toBe(numericModel);
  });

  it('preserves exact provider and model identifiers while canonicalizing only the name', () => {
    const normalized = normalizeModelAliases([
      { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
      { name: 'LUNA', providerId: 'one ', modelId: 'model-a' },
      { name: 'Exact', providerId: ' two ', modelId: ' model-b ' },
    ]);

    expect(normalized.aliases).toEqual([
      { name: 'exact', providerId: ' two ', modelId: ' model-b ' },
    ]);
    expect(normalized.rejections).toEqual([
      {
        alias: { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
        reason: 'conflicting-targets',
      },
      {
        alias: { name: 'LUNA', providerId: 'one ', modelId: 'model-a' },
        reason: 'conflicting-targets',
      },
    ]);
  });

  it('treats an absent alias list as empty and rejects malformed containers', () => {
    expect(normalizeModelAliases(undefined)).toEqual({
      aliases: [],
      accepted: [],
      rejected: [],
      rejections: [],
    });
    for (const malformed of [null, {}, 'luna', 1]) {
      expect(() => normalizeModelAliases(malformed)).toThrow(
        'Saved model aliases are malformed: "modelAliases" must be an array.',
      );
    }
  });

  it.each([
    ['null', null],
    ['primitive', 7],
    ['non-string name', { name: 7, providerId: 'one', modelId: 'model-a' }],
  ])('rejects a malformed %s array element with its index', (_kind, malformed) => {
    expect(() => normalizeModelAliases([
      { name: 'valid', providerId: 'one', modelId: 'model-a' },
      malformed,
    ])).toThrow(
      'Saved model aliases are malformed: "modelAliases[1]" must be an object with a string "name".',
    );
  });

  it('keeps capacity omission distinct from target unavailability', () => {
    expect(describeModelAliasRejection('target-not-exposed'))
      .toBe('target is outside the active Claude Code catalog');
    expect(describeModelAliasRejection('target-unavailable'))
      .toBe('target is unavailable or unsupported');
  });

  it('formats a canonical HTTP-proxy target', () => {
    expect(modelAliasTarget({ providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }))
      .toBe('clodex:openai-oauth:gpt-5.6-luna');
  });
});
