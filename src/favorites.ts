import { MAX_FAVORITES, MAX_MODEL_CATALOG } from './constants.js';
import type { FavoriteModel } from './types.js';

function sameFavorite(a: FavoriteModel, b: FavoriteModel): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

export interface FavoriteExposureProjection {
  /** Favorites selected for this Claude-facing surface, in persisted order. */
  exposedFavorites: FavoriteModel[];
  /** Saved favorites omitted only because the Claude-facing catalog is full. */
  capacitySkippedFavorites: FavoriteModel[];
}

export interface FavoriteExposureOptions {
  max?: number;
  /** A favorite already exposed separately, such as an endpoint launch model. */
  reservedFavorite?: FavoriteModel;
  /** Slots consumed by models exposed outside the returned favorite tail. */
  reservedSlots?: number;
}

/**
 * Select the persisted favorites that may reach one Claude-facing surface.
 *
 * A separately exposed starting model consumes one slot. When that model is
 * itself a saved favorite, it is removed from the ordered tail rather than
 * consuming a second slot. Saved entries are never mutated or reordered.
 */
export function projectFavoriteExposure(
  favorites: FavoriteModel[],
  options: FavoriteExposureOptions = {},
): FavoriteExposureProjection {
  const {
    max = MAX_MODEL_CATALOG,
    reservedFavorite,
    reservedSlots = reservedFavorite ? 1 : 0,
  } = options;
  const candidates = reservedFavorite
    ? favorites.filter(favorite => !sameFavorite(favorite, reservedFavorite))
    : favorites;
  const availableSlots = Math.max(0, max - Math.max(0, reservedSlots));
  return {
    exposedFavorites: candidates.slice(0, availableSlots),
    capacitySkippedFavorites: candidates.slice(availableSlots),
  };
}

export function isFavorite(list: FavoriteModel[], fav: FavoriteModel): boolean {
  return list.some(f => sameFavorite(f, fav));
}

export type AddFavoriteResult =
  | { ok: true; list: FavoriteModel[] }
  | { ok: false; reason: 'duplicate' | 'cap' };

export function addFavorite(
  list: FavoriteModel[],
  fav: FavoriteModel,
  max = MAX_FAVORITES,
): AddFavoriteResult {
  if (isFavorite(list, fav)) return { ok: false, reason: 'duplicate' };
  if (list.length >= max) return { ok: false, reason: 'cap' };
  return { ok: true, list: [...list, fav] };
}

export function removeFavorite(list: FavoriteModel[], fav: FavoriteModel): FavoriteModel[] {
  return list.filter(f => !(f.providerId === fav.providerId && f.modelId === fav.modelId));
}
