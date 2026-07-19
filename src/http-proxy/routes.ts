import { MAX_MODEL_CATALOG } from '../constants.js';
import { localModelToRoute } from '../catalog.js';
import { isSdkMigratedNpm } from '../provider-factory.js';
import { claudeCodeClientModelId } from '../context-model-id.js';
import type { ProxyRoute } from '../proxy.js';
import { isValidModelAlias } from '../model-aliases.js';
import type { FavoriteModel, LocalProvider, ModelAlias } from '../types.js';

export const HTTP_PROXY_MODEL_PREFIX = 'clodex:';

export function httpProxyModelId(providerId: string, modelId: string): string {
  return `${HTTP_PROXY_MODEL_PREFIX}${providerId}:${modelId}`;
}

export interface HttpProxyRouteResult {
  routes: ProxyRoute[];
  unavailable: FavoriteModel[];
  unsupported: FavoriteModel[];
  aliases: ResolvedHttpProxyAlias[];
  unavailableAliases: ModelAlias[];
}

export interface ResolvedHttpProxyAlias {
  name: string;
  routeId: string;
  displayName: string;
}

/** Build a positive allowlist: only favorite AI-SDK routes can leave Anthropic's path. */
export function buildHttpProxyRoutes(
  providers: LocalProvider[],
  favorites: FavoriteModel[],
  modelAliases: ModelAlias[] = [],
  max = MAX_MODEL_CATALOG,
): HttpProxyRouteResult {
  const routes: ProxyRoute[] = [];
  const unavailable: FavoriteModel[] = [];
  const unsupported: FavoriteModel[] = [];
  const seen = new Set<string>();
  const routesByFavorite = new Map<string, ProxyRoute>();

  for (const favorite of favorites) {
    if (routes.length >= max) break;
    const provider = providers.find(item => item.id === favorite.providerId);
    const model = provider?.models.find(item => item.id === favorite.modelId);
    if (!provider || !model) {
      unavailable.push(favorite);
      continue;
    }
    if (model.modelFormat !== 'openai' || !isSdkMigratedNpm(model.npm)) {
      unsupported.push(favorite);
      continue;
    }
    const route = localModelToRoute(provider, model);
    if (!route || !route.apiKey.trim()) {
      unavailable.push(favorite);
      continue;
    }
    const aliasId = claudeCodeClientModelId(
      httpProxyModelId(provider.id, model.id),
      model.contextWindow,
    );
    if (seen.has(aliasId)) continue;
    seen.add(aliasId);
    const proxyRoute = {
      ...route,
      aliasId,
      displayName: `${model.name || model.id} (${provider.name})`,
    };
    routes.push(proxyRoute);
    routesByFavorite.set(`${favorite.providerId}:${favorite.modelId}`, proxyRoute);
  }

  const aliases: ResolvedHttpProxyAlias[] = [];
  const unavailableAliases: ModelAlias[] = [];
  const seenAliases = new Set<string>();
  for (const alias of modelAliases) {
    const route = routesByFavorite.get(`${alias.providerId}:${alias.modelId}`);
    if (!isValidModelAlias(alias.name) || seenAliases.has(alias.name) || !route) {
      unavailableAliases.push(alias);
      continue;
    }
    seenAliases.add(alias.name);
    aliases.push({ name: alias.name, routeId: route.aliasId, displayName: route.displayName });
  }

  return { routes, unavailable, unsupported, aliases, unavailableAliases };
}
