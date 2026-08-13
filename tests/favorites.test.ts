// tests/favorites.test.ts
import { describe, it, expect } from 'vitest';
import { MAX_FAVORITES, MAX_MODEL_CATALOG } from '../src/constants.js';
import {
  addFavorite,
  isFavorite,
  projectFavoriteExposure,
  removeFavorite,
} from '../src/favorites.js';
import type { FavoriteModel } from '../src/types.js';

const fav = (providerId: string, modelId: string): FavoriteModel => ({ providerId, modelId });

describe('isFavorite', () => {
  it('returns false for an empty list', () => {
    expect(isFavorite([], fav('groq', 'llama-3.3-70b'))).toBe(false);
  });

  it('returns true when matching entry exists', () => {
    const list = [fav('groq', 'llama-3.3-70b')];
    expect(isFavorite(list, fav('groq', 'llama-3.3-70b'))).toBe(true);
  });

  it('returns false when providerId differs', () => {
    const list = [fav('groq', 'llama-3.3-70b')];
    expect(isFavorite(list, fav('deepseek', 'llama-3.3-70b'))).toBe(false);
  });

  it('returns false when modelId differs', () => {
    const list = [fav('groq', 'llama-3.3-70b')];
    expect(isFavorite(list, fav('groq', 'llama-3.1-8b'))).toBe(false);
  });
});

describe('addFavorite', () => {
  it('adds a new entry and returns ok', () => {
    const result = addFavorite([], fav('groq', 'llama-3.3-70b'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.list).toEqual([fav('groq', 'llama-3.3-70b')]);
    }
  });

  it('returns duplicate when the same entry is added twice', () => {
    const list = [fav('groq', 'llama-3.3-70b')];
    const result = addFavorite(list, fav('groq', 'llama-3.3-70b'));
    expect(result).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('returns cap when the list is full', () => {
    const list: FavoriteModel[] = Array.from({ length: MAX_FAVORITES }, (_, i) =>
      fav('provider', `model-${i}`),
    );
    const result = addFavorite(list, fav('provider', 'model-new'));
    expect(result).toEqual({ ok: false, reason: 'cap' });
  });

  it('allows curation beyond the Claude-facing exposure cap', () => {
    const list = Array.from({ length: MAX_MODEL_CATALOG }, (_, index) => (
      fav('provider', `model-${index}`)
    ));

    const result = addFavorite(list, fav('provider', 'model-20'));

    expect(result.ok).toBe(true);
  });

  it('respects a custom cap argument', () => {
    const list = [fav('groq', 'a'), fav('groq', 'b')];
    expect(addFavorite(list, fav('groq', 'c'), 2)).toEqual({ ok: false, reason: 'cap' });
    expect(addFavorite(list, fav('groq', 'c'), 3).ok).toBe(true);
  });

  it('does not mutate the input list', () => {
    const list: FavoriteModel[] = [];
    addFavorite(list, fav('groq', 'llama'));
    expect(list).toHaveLength(0);
  });

  it('appends to the end of the list', () => {
    const list = [fav('groq', 'a'), fav('deepseek', 'b')];
    const result = addFavorite(list, fav('google', 'c'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.list).toEqual([fav('groq', 'a'), fav('deepseek', 'b'), fav('google', 'c')]);
    }
  });
});

describe('projectFavoriteExposure', () => {
  const favorites = Array.from({ length: 25 }, (_, index) => fav('provider', `model-${index}`));

  it('exposes the first catalog-sized window in persisted order and reports every omission', () => {
    const result = projectFavoriteExposure(favorites);

    expect(result.exposedFavorites).toEqual(favorites.slice(0, MAX_MODEL_CATALOG));
    expect(result.capacitySkippedFavorites).toEqual(favorites.slice(MAX_MODEL_CATALOG));
    expect(result.capacitySkippedFavorites.map(favorite => (
      `clodex:${favorite.providerId}:${favorite.modelId}`
    ))).toEqual([
      'clodex:provider:model-20',
      'clodex:provider:model-21',
      'clodex:provider:model-22',
      'clodex:provider:model-23',
      'clodex:provider:model-24',
    ]);
  });

  it('reserves one catalog slot for a separately exposed starting favorite', () => {
    const result = projectFavoriteExposure(favorites, {
      max: 4,
      reservedFavorite: favorites[1],
      reservedSlots: 1,
    });

    expect(result.exposedFavorites).toEqual([favorites[0], favorites[2], favorites[3]]);
    expect(result.capacitySkippedFavorites).toEqual(favorites.slice(4));
  });

  it('reserves a starting slot even when the starting model is not saved', () => {
    const result = projectFavoriteExposure(favorites.slice(0, 5), {
      max: 3,
      reservedFavorite: fav('other', 'starting'),
      reservedSlots: 1,
    });

    expect(result.exposedFavorites).toEqual(favorites.slice(0, 2));
    expect(result.capacitySkippedFavorites).toEqual(favorites.slice(2, 5));
  });
});

describe('removeFavorite', () => {
  it('removes the matching entry', () => {
    const list = [fav('groq', 'a'), fav('deepseek', 'b'), fav('google', 'c')];
    expect(removeFavorite(list, fav('deepseek', 'b'))).toEqual([fav('groq', 'a'), fav('google', 'c')]);
  });

  it('returns the list unchanged when entry not present', () => {
    const list = [fav('groq', 'a')];
    expect(removeFavorite(list, fav('groq', 'z'))).toEqual(list);
  });

  it('handles an empty list gracefully', () => {
    expect(removeFavorite([], fav('groq', 'a'))).toEqual([]);
  });

  it('does not mutate the input list', () => {
    const list = [fav('groq', 'a'), fav('deepseek', 'b')];
    removeFavorite(list, fav('groq', 'a'));
    expect(list).toHaveLength(2);
  });

  it('removes only the first matching entry if provider+model is unique', () => {
    // By design each provider:model pair is unique; double-check remove leaves others intact
    const list = [fav('groq', 'a'), fav('groq', 'b'), fav('groq', 'a')];
    // Note: addFavorite prevents duplicates, but removeFavorite still removes all matches
    expect(removeFavorite(list, fav('groq', 'a'))).toEqual([fav('groq', 'b')]);
  });
});

describe('favorite and exposure limits', () => {
  it('allows curating 100 favorites while exposing at most 20', () => {
    expect(MAX_FAVORITES).toBe(100);
    expect(MAX_MODEL_CATALOG).toBe(20);
  });
});
