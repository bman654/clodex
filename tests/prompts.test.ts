// tests/prompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  filterModelsBySearch,
  sliceModelPage,
  MODEL_SEARCH_THRESHOLD,
  MODEL_PAGE_SIZE,
} from '../src/prompts.js';

describe('filterModelsBySearch', () => {
  const models = [
    { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', brand: 'Claude' },
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', brand: 'Other' },
    { id: 'gpt-4o', name: 'GPT-4o', brand: 'GPT' },
  ];

  it('matches id, name, and brand case-insensitively', () => {
    expect(filterModelsBySearch(models, 'SONNET').map(m => m.id)).toEqual(['claude-sonnet-4']);
    expect(filterModelsBySearch(models, 'llama').map(m => m.id)).toEqual(['llama-3.3-70b']);
    expect(filterModelsBySearch(models, 'gpt').map(m => m.id)).toEqual(['gpt-4o']);
  });

  it('returns empty for blank query', () => {
    expect(filterModelsBySearch(models, '')).toEqual([]);
    expect(filterModelsBySearch(models, '   ')).toEqual([]);
  });

  it('exports search threshold of 25', () => {
    expect(MODEL_SEARCH_THRESHOLD).toBe(25);
  });
});

describe('sliceModelPage', () => {
  const items = Array.from({ length: 32 }, (_, i) => `model-${i}`);

  it('pages 15 items at a time', () => {
    expect(MODEL_PAGE_SIZE).toBe(15);
    expect(sliceModelPage(items, 0).items).toHaveLength(15);
    expect(sliceModelPage(items, 0).totalPages).toBe(3);
    expect(sliceModelPage(items, 1).items[0]).toBe('model-15');
    expect(sliceModelPage(items, 2).items).toHaveLength(2);
  });

  it('clamps out-of-range page numbers', () => {
    expect(sliceModelPage(items, 99).page).toBe(2);
    expect(sliceModelPage(items, -3).page).toBe(0);
  });
});
