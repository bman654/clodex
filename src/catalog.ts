// Route map + catalog assembly for the mid-session /model switch menu.
import { MAX_MODEL_CATALOG } from './constants.js';
import {
  claudeCodeClientModelId,
  normalizeRouteLookupId,
} from './context-model-id.js';
import { resolveProviderCredential } from './env.js';
import {
  canonicalModelAliasName,
  describeModelAliasRejection,
  modelAliasTarget,
  normalizeModelAliases,
} from './model-aliases.js';
import { isSdkMigratedNpm } from './provider-factory.js';
import { aliasModelId } from './proxy.js';
import type { ProxyModelAlias, ProxyRoute } from './proxy.js';
import type {
  FavoriteModel,
  LocalProvider,
  LocalProviderModel,
} from './types.js';

export function localModelToRoute(lp: LocalProvider, model: LocalProviderModel): ProxyRoute | null {
  if (model.modelFormat === 'anthropic' && !model.baseUrl) return null;
  if (model.modelFormat === 'openai' && !isSdkMigratedNpm(model.npm) && !model.completionsUrl) return null;
  const upstreamUrl = model.modelFormat === 'anthropic' ? model.baseUrl : model.completionsUrl;
  return {
    aliasId: claudeCodeClientModelId(aliasModelId(model.id, lp.id), model.contextWindow),
    realModelId: model.upstreamModelId,
    displayName: `${model.name || model.id} (${lp.name})`,
    upstreamUrl: upstreamUrl ?? '',
    apiKey: lp.apiKey,
    modelFormat: model.modelFormat,
    contextWindow: model.contextWindow,
    npm: model.npm,
    baseURL: model.apiBaseUrl,
    providerId: lp.id,
    authType: lp.authType,
    refreshToken: lp.authType === 'oauth' && lp.authRef
      ? rejectedAccessToken => rejectedAccessToken === undefined
        ? resolveProviderCredential(lp.id, lp.authRef!)
        : resolveProviderCredential(
            lp.id,
            lp.authRef!,
            undefined,
            { rejectedAccessToken },
          )
      : undefined,
    oauthAccountId: lp.oauthAccountId,
    providerData: lp.providerData,
    headers: lp.headers,
    supportedParameters: model.supportedParameters,
    reasoning: model.reasoning,
    interleavedReasoningField: model.interleavedReasoningField,
    useResponsesLite: model.useResponsesLite,
    preferWebSockets: model.preferWebSockets,
    compatibility: model.compatibility,
  };
}

export function makeRouteResolver(
  localProviders: LocalProvider[] | null,
): (providerId: string, modelId: string) => ProxyRoute | undefined {
  return (providerId, modelId) => {
    const provider = localProviders?.find(lp => lp.id === providerId);
    const model = provider?.models.find(m => m.id === modelId);
    return provider && model ? localModelToRoute(provider, model) ?? undefined : undefined;
  };
}

export function resolveCatalogModelAliases(
  modelAliases: unknown,
  resolveRoute: (providerId: string, modelId: string) => ProxyRoute | undefined,
  catalogRoutes: readonly Pick<ProxyRoute, 'aliasId'>[] = [],
): ProxyModelAlias[] {
  const normalized = normalizeModelAliases(modelAliases);
  const catalogRouteIds = new Set(
    catalogRoutes.map(route => normalizeRouteLookupId(route.aliasId)),
  );
  return [
    ...normalized.accepted.map(({ alias, source, sources }) => {
      const route = resolveRoute(alias.providerId, alias.modelId);
      const collidesWithCatalog = catalogRouteIds.has(
        normalizeRouteLookupId(alias.name),
      );
      const sourceNames = [...new Set(sources.map(entry => entry.name))];
      return {
        name: alias.name,
        ...(source.name === alias.name ? {} : { savedName: source.name }),
        ...(
          sourceNames.length === 1 && sourceNames[0] === alias.name
            ? {}
            : { sourceNames }
        ),
        routeId: route?.aliasId ?? modelAliasTarget(alias),
        ...(
          collidesWithCatalog
            ? { unavailableReason: 'conflicts with a catalog model id' }
            : route
              ? {}
              : { unavailableReason: 'target unavailable' }
        ),
      };
    }),
    ...normalized.rejections.map(rejection => ({
      name: canonicalModelAliasName(rejection.alias.name),
      ...(rejection.alias.name === canonicalModelAliasName(rejection.alias.name)
        ? {}
        : { savedName: rejection.alias.name }),
      unavailableReason: describeModelAliasRejection(rejection.reason),
    })),
  ];
}

/**
 * Claude-specific catalog builder. Takes a `resolveRoute` function (not a
 * ResolveContext) and returns built ProxyRoute[] — does NOT delegate to
 * `buildFavoritesList` in `./favorites-resolver.ts` because the input/output
 * shapes are different (closure-based lookup vs. ResolveContext, ProxyRoute
 * vs. ResolvedFavorite). The dedup+cap pattern is duplicated here on purpose;
 * cross-surface shared resolution lives in `favorites-resolver.ts` and is
 * intended to be consumed by other call sites (Codex, Server) that need a
 * route-shape-agnostic intermediate result.
 */
export function buildCatalogRoutes(
  startingRoute: ProxyRoute,
  favorites: FavoriteModel[],
  resolveRoute: (providerId: string, modelId: string) => ProxyRoute | undefined,
  max = MAX_MODEL_CATALOG,
): { routes: ProxyRoute[]; droppedFavorites: FavoriteModel[] } {
  const droppedFavorites: FavoriteModel[] = [];
  const tail = favorites
    .map(fav => {
      const route = resolveRoute(fav.providerId, fav.modelId);
      if (!route) droppedFavorites.push(fav);
      return route;
    })
    .filter((route): route is ProxyRoute => route !== undefined);
  const routes = [
    startingRoute,
    ...tail.filter(route => route.aliasId !== startingRoute.aliasId),
  ].slice(0, max);
  return { routes, droppedFavorites };
}
