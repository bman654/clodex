import { describe, it, expect } from 'vitest';
import {
  claudeCodeClientModelId,
  normalizeRouteLookupId,
  routeLookupIds,
  stripOneMContextSuffix,
} from '../src/context-model-id.js';

describe('claudeCodeClientModelId', () => {
  it('appends [1m] for a genuine 1M context', () => {
    expect(claudeCodeClientModelId('gemini-3.5-flash', 1_000_000)).toBe('gemini-3.5-flash[1m]');
  });

  it('does not mislabel intermediate context sizes as 1M', () => {
    expect(claudeCodeClientModelId('gpt-5.6-sol', 272_000)).toBe('gpt-5.6-sol');
    expect(claudeCodeClientModelId('custom-model', 999_999)).toBe('custom-model');
  });

  it('leaves 200K models unchanged', () => {
    expect(claudeCodeClientModelId('claude-haiku-4-5', 200_000)).toBe('claude-haiku-4-5');
  });

  it('is idempotent when [1m] is already present', () => {
    expect(claudeCodeClientModelId('gemini-3.5-flash[1m]', 1_000_000)).toBe('gemini-3.5-flash[1m]');
  });
});

describe('routeLookupIds', () => {
  it('includes [1m] and legacy models/ variants', () => {
    const ids = routeLookupIds('gemini-3.5-flash');
    expect(ids).toContain('gemini-3.5-flash[1m]');
    expect(ids).toContain('models/gemini-3.5-flash');
  });

  it('normalizes context suffix case and the Google models prefix to one key', () => {
    expect(normalizeRouteLookupId('sol[1M]')).toBe('sol');
    expect(normalizeRouteLookupId('models/sol[1m]')).toBe('sol');
  });
});

describe('stripOneMContextSuffix', () => {
  it('removes suffix case-insensitively', () => {
    expect(stripOneMContextSuffix('sonnet[1M]')).toBe('sonnet');
  });
});
