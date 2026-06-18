import { describe, expect, it } from 'vitest';
import {
  buildGlobalFavoriteIndex,
  filterGlobalFavoriteIndex,
  globalFavoritePickKey,
  globalFavoriteSelectOption,
} from '../src/favorites-picker.js';
import type { LocalProvider } from '../src/types.js';

const providers: LocalProvider[] = [
  {
    id: 'zen',
    name: 'OpenCode Zen',
    apiKey: '',
    models: [{
      id: 'deepseek-v4-flash-free',
      name: 'DeepSeek V4 Flash Free',
      family: 'DeepSeek',
      brand: 'DeepSeek',
      modelFormat: 'openai',
      upstreamModelId: 'deepseek-v4-flash-free',
      isFree: true,
    }],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiKey: 'k',
    models: [{
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      family: 'DeepSeek',
      brand: 'DeepSeek',
      modelFormat: 'openai',
      upstreamModelId: 'deepseek-v4-flash',
    }],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    apiKey: 'k',
    models: [{
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      family: 'DeepSeek',
      brand: 'DeepSeek',
      modelFormat: 'openai',
      upstreamModelId: 'deepseek/deepseek-v4-flash',
    }],
  },
];

describe('buildGlobalFavoriteIndex', () => {
  it('includes every provider model with stable composite keys', () => {
    const index = buildGlobalFavoriteIndex(providers);
    expect(index).toHaveLength(3);
    expect(globalFavoritePickKey(index[0]!)).toBe('deepseek::deepseek-v4-flash');
    expect(globalFavoritePickKey(index[1]!)).toBe('zen::deepseek-v4-flash-free');
    expect(globalFavoritePickKey(index[2]!)).toBe('openrouter::deepseek/deepseek-v4-flash');
  });
});

describe('filterGlobalFavoriteIndex', () => {
  const index = buildGlobalFavoriteIndex(providers);

  it('matches model id, name, brand, and provider name', () => {
    expect(filterGlobalFavoriteIndex(index, 'deepseek').map(globalFavoritePickKey)).toEqual([
      'deepseek::deepseek-v4-flash',
      'zen::deepseek-v4-flash-free',
      'openrouter::deepseek/deepseek-v4-flash',
    ]);
    expect(filterGlobalFavoriteIndex(index, 'openrouter').map(e => e.providerId)).toEqual(['openrouter']);
    expect(filterGlobalFavoriteIndex(index, 'zen').map(e => e.providerId)).toEqual(['zen']);
  });

  it('returns empty for blank query', () => {
    expect(filterGlobalFavoriteIndex(index, '')).toEqual([]);
  });
});

describe('globalFavoriteSelectOption', () => {
  const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

  it('puts a bright bracketed provider tag on the label', () => {
    const index = buildGlobalFavoriteIndex(providers);
    const zen = index.find(e => e.providerId === 'zen')!;
    const opt = globalFavoriteSelectOption(zen, []);
    expect(stripAnsi(opt.label)).toContain('(OpenCode Zen · free)');
    expect(opt.hint).toBe('');

    const deepseek = index.find(e => e.providerId === 'deepseek')!;
    expect(stripAnsi(globalFavoriteSelectOption(deepseek, []).label)).toContain('(DeepSeek)');
  });

  it('marks existing favorites in the hint', () => {
    const index = buildGlobalFavoriteIndex(providers);
    const zen = index.find(e => e.providerId === 'zen')!;
    const favorited = globalFavoriteSelectOption(zen, [{ providerId: 'zen', modelId: zen.model.id }]);
    expect(favorited.hint).toContain('already in favorites');
  });
});
