import { describe, expect, it } from 'vitest';
import {
  buildServerFavoriteCatalog,
  filterServerModelsByFreeStatus,
  filterServerModelsByFavorites,
  filterServerModelsByProviders,
  summarizeServerProviders,
} from '../src/server/catalog-filter.js';
import { resolveInitialServerProviders } from '../src/server/provider-select.js';
import type { ServerModelInfo } from '../src/server/models.js';

function model(partial: Partial<ServerModelInfo> & Pick<ServerModelInfo, 'id' | 'providerId'>): ServerModelInfo {
  return {
    name: partial.id,
    isFree: false,
    brand: 'Other',
    sourceBackend: 'zen',
    modelFormat: 'openai',
    providerLabel: partial.providerLabel ?? partial.providerId,
    ...partial,
  };
}

describe('filterServerModelsByProviders', () => {
  const models = [
    model({ id: 'gemini-3', providerId: 'google', providerLabel: 'Google' }),
    model({ id: 'grok-4', providerId: 'xai', providerLabel: 'xAI' }),
    model({ id: 'big-pickle', providerId: 'zen', providerLabel: 'OpenCode Zen' }),
  ];

  it('returns all models when provider filter is unset', () => {
    expect(filterServerModelsByProviders(models, null)).toHaveLength(3);
    expect(filterServerModelsByProviders(models, undefined)).toHaveLength(3);
    expect(filterServerModelsByProviders(models, [])).toHaveLength(3);
  });

  it('keeps only models from selected providers', () => {
    const filtered = filterServerModelsByProviders(models, ['google', 'zen']);
    expect(filtered.map(m => m.id)).toEqual(['gemini-3', 'big-pickle']);
  });
});

describe('filterServerModelsByFavorites', () => {
  const models = [
    model({ id: 'gpt-5.5-fast', providerId: 'openai', providerLabel: 'OpenAI' }),
    model({ id: 'gemini-3.5-flash', providerId: 'google', providerLabel: 'Google' }),
    model({ id: 'grok-4.3', providerId: 'xai', providerLabel: 'xAI' }),
  ];

  it('returns empty list when there are no favorites', () => {
    expect(filterServerModelsByFavorites(models, [])).toEqual([]);
  });

  it('keeps only favorited provider/model pairs', () => {
    const filtered = filterServerModelsByFavorites(models, [
      { providerId: 'xai', modelId: 'grok-4.3' },
      { providerId: 'google', modelId: 'gemini-3.5-flash' },
    ]);
    expect(filtered.map(m => m.id)).toEqual(['grok-4.3', 'gemini-3.5-flash']);
  });

  it('projects the first favorites and reports both unavailable and capacity omissions', () => {
    const result = buildServerFavoriteCatalog(models, [
      { providerId: 'xai', modelId: 'grok-4.3' },
      { providerId: 'missing', modelId: 'gone' },
      { providerId: 'google', modelId: 'gemini-3.5-flash' },
      { providerId: 'openai', modelId: 'gpt-5.5-fast' },
    ], 3);

    expect(result.models.map(model => model.id)).toEqual(['grok-4.3', 'gemini-3.5-flash']);
    expect(result.unavailableFavorites).toEqual([{ providerId: 'missing', modelId: 'gone' }]);
    expect(result.capacitySkippedFavorites).toEqual([
      { providerId: 'openai', modelId: 'gpt-5.5-fast' },
    ]);
  });
});

describe('resolveInitialServerProviders', () => {
  const available = [
    { id: 'google', name: 'Google', modelCount: 18 },
    { id: 'xai', name: 'xAI', modelCount: 8 },
    { id: 'openrouter', name: 'OpenRouter', modelCount: 338 },
  ];

  it('starts empty when nothing is saved', () => {
    expect(resolveInitialServerProviders(undefined, available)).toEqual([]);
    expect(resolveInitialServerProviders([], available)).toEqual([]);
  });

  it('restores only saved providers that still exist', () => {
    expect(resolveInitialServerProviders(['google', 'xai', 'gone'], available)).toEqual(['google', 'xai']);
  });
});

describe('summarizeServerProviders', () => {
  it('groups models by provider label', () => {
    const summary = summarizeServerProviders([
      model({ id: 'a', providerId: 'google', providerLabel: 'Google' }),
      model({ id: 'b', providerId: 'google', providerLabel: 'Google' }),
      model({ id: 'c', providerId: 'xai', providerLabel: 'xAI' }),
    ]);
    expect(summary).toBe('Google (2), xAI (1)');
  });
});
