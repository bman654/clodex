import { MAX_MODEL_CATALOG } from './constants.js';
import type { FavoriteModel } from './types.js';

export function isFavorite(list: FavoriteModel[], fav: FavoriteModel): boolean {
  return list.some(f => f.providerId === fav.providerId && f.modelId === fav.modelId);
}

export type AddFavoriteResult =
  | { ok: true; list: FavoriteModel[] }
  | { ok: false; reason: 'duplicate' | 'cap' };

export function addFavorite(
  list: FavoriteModel[],
  fav: FavoriteModel,
  max = MAX_MODEL_CATALOG,
): AddFavoriteResult {
  if (isFavorite(list, fav)) return { ok: false, reason: 'duplicate' };
  if (list.length >= max) return { ok: false, reason: 'cap' };
  return { ok: true, list: [...list, fav] };
}

export function removeFavorite(list: FavoriteModel[], fav: FavoriteModel): FavoriteModel[] {
  return list.filter(f => !(f.providerId === fav.providerId && f.modelId === fav.modelId));
}
