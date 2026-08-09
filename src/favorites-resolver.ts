// src/favorites-resolver.ts
import { MAX_MODEL_CATALOG } from './constants.js';
import { projectFavoriteExposure } from './favorites.js';
import type { FavoriteModel, LocalProvider, LocalProviderModel } from './types.js';
import type { ServerModelInfo } from './server/models.js';
import { shouldHideModel, type CompatibilityAgent } from './model-compatibility.js';
import { resolveLocalProviderApiKey } from './provider-catalog.js';

export interface ResolvedFavorite {
  providerId: string;
  providerName: string;
  model: LocalProviderModel | ServerModelInfo;
  apiKey: string;
  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  providerData?: Record<string, unknown>;
}

/**
 * Per-surface resolution context. Each surface (Claude, Codex, Server) builds
 * its own context and passes it to resolveFavorite / buildFavoritesList.
 * The resolver is route-shape-agnostic — each caller builds its own route type.
 */
export interface ResolveContext {
  /** When set, call shouldHideModel with this agent to filter blacklisted favorites. */
  agent?: CompatibilityAgent;
  /** Claude: registry providers. */
  localProviders?: LocalProvider[];
  /** Server: pre-loaded server model list. */
  serverModels?: ServerModelInfo[];
  /** Lookup function for a registry model. Returns the model + its parent provider. */
  findLocalModel?: LocalModelLookup;
}

export interface LocalModelLookupResult {
  provider: LocalProvider;
  model: LocalProviderModel;
}

export type LocalModelLookup =
  (providerId: string, modelId: string) => LocalModelLookupResult | undefined;

export async function resolveFavorite(
  fav: FavoriteModel,
  ctx: ResolveContext,
): Promise<ResolvedFavorite | undefined> {
  if (ctx.findLocalModel) {
    const found = ctx.findLocalModel(fav.providerId, fav.modelId);
    if (!found) return undefined;
    if (ctx.agent && shouldHideModel({ providerId: fav.providerId, modelId: fav.modelId, agent: ctx.agent })) {
      return undefined;
    }
    return {
      providerId: fav.providerId,
      providerName: found.provider.name,
      model: found.model,
      apiKey: (await resolveLocalProviderApiKey(found.provider)) ?? '',
      authType: found.provider.authType,
      oauthAccountId: found.provider.oauthAccountId,
      providerData: found.provider.providerData,
    };
  }

  return undefined;
}

export interface BuildFavoritesListOptions {
  dropEmptyApiKey?: boolean;
  /** @deprecated Capacity omissions are always returned. */
  trackCapacitySkipped?: boolean;
}

export async function buildFavoritesList(
  starting: ResolvedFavorite | undefined,
  favorites: FavoriteModel[],
  ctx: ResolveContext,
  max = MAX_MODEL_CATALOG,
  options: BuildFavoritesListOptions = {},
): Promise<{
  resolved: ResolvedFavorite[];
  droppedFavorites: FavoriteModel[];
  capacitySkippedFavorites: FavoriteModel[];
}> {
  const seen = new Set<string>();
  const out: ResolvedFavorite[] = [];

  if (starting) {
    seen.add(`${starting.providerId}::${starting.model.id}`);
    out.push(starting);
  }

  const projection = projectFavoriteExposure(favorites, {
    max,
    reservedFavorite: starting
      ? { providerId: starting.providerId, modelId: starting.model.id }
      : undefined,
    reservedSlots: starting ? 1 : 0,
  });
  const uniqueFavorites = projection.exposedFavorites.filter(fav => {
    const key = `${fav.providerId}::${fav.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const resolutions = await Promise.all(uniqueFavorites.map(fav => resolveFavorite(fav, ctx)));

  const droppedFavorites: FavoriteModel[] = [];
  for (let i = 0; i < uniqueFavorites.length; i++) {
    const resolved = resolutions[i];
    if (!resolved || (
      options.dropEmptyApiKey &&
      !resolved.apiKey.trim() &&
      resolved.authType !== 'none'
    )) {
      droppedFavorites.push(uniqueFavorites[i]!);
      continue;
    }
    out.push(resolved);
  }

  return {
    resolved: out,
    droppedFavorites,
    capacitySkippedFavorites: projection.capacitySkippedFavorites,
  };
}

export function resolveFirstAvailableFavorite(
  favorites: FavoriteModel[],
  providers: LocalProvider[],
): LocalModelLookupResult | undefined {
  for (const fav of favorites) {
    const provider = providers.find(lp => lp.id === fav.providerId);
    const model = provider?.models.find(m => m.id === fav.modelId);
    if (provider && model) return { provider, model };
  }
  return undefined;
}
