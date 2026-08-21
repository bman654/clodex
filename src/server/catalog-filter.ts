import { MAX_MODEL_CATALOG } from '../constants.js';
import { projectFavoriteExposure } from '../favorites.js';
import type { FavoriteModel } from '../types.js';
import type { ServerModelInfo } from './models.js';

export function filterServerModelsByProviders(
  models: ServerModelInfo[],
  providerIds: string[] | null | undefined,
): ServerModelInfo[] {
  if (!providerIds || providerIds.length === 0) return models;
  const allowed = new Set(providerIds);
  return models.filter(model => model.providerId && allowed.has(model.providerId));
}

export function filterServerModelsByFavorites(
  models: ServerModelInfo[],
  favorites: FavoriteModel[],
): ServerModelInfo[] {
  if (favorites.length === 0) return [];
  const byFavorite = new Map(
    models
      .filter((model): model is ServerModelInfo & { providerId: string } => Boolean(model.providerId))
      .map(model => [`${model.providerId}:${model.id}`, model]),
  );
  const seen = new Set<string>();
  return favorites.flatMap(favorite => {
    const key = `${favorite.providerId}:${favorite.modelId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const model = byFavorite.get(key);
    return model ? [model] : [];
  });
}

export function buildServerFavoriteCatalog(
  models: ServerModelInfo[],
  favorites: FavoriteModel[],
  max = MAX_MODEL_CATALOG,
): {
  models: ServerModelInfo[];
  unavailableFavorites: FavoriteModel[];
  capacitySkippedFavorites: FavoriteModel[];
} {
  const projection = projectFavoriteExposure(favorites, { max });
  const exposedModels = filterServerModelsByFavorites(models, projection.exposedFavorites);
  const available = new Set(
    exposedModels
      .filter((model): model is ServerModelInfo & { providerId: string } => Boolean(model.providerId))
      .map(model => `${model.providerId}:${model.id}`),
  );
  return {
    models: exposedModels,
    unavailableFavorites: projection.exposedFavorites.filter(favorite => (
      !available.has(`${favorite.providerId}:${favorite.modelId}`)
    )),
    capacitySkippedFavorites: projection.capacitySkippedFavorites,
  };
}

export function summarizeServerProviders(models: ServerModelInfo[]): string {
  const counts = new Map<string, number>();
  for (const model of models) {
    const key = model.providerLabel ?? model.providerId ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name} (${count})`)
    .join(', ');
}
