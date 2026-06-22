import * as p from '@clack/prompts';
import type { CodexProxyRoute } from '../codex-proxy.js';
import { buildFavoritesList, resolveFavorite } from '../favorites-resolver.js';
import type { ResolveContext, ResolvedFavorite } from '../favorites-resolver.js';
import type { CompatibilityAgent } from '../model-compatibility.js';
import { resolveCodexRoute } from './routing.js';
import type { LocalProvider, LocalProviderModel, FavoriteModel } from '../types.js';
import { codexCliFavoritesSlug } from './favorites-catalog.js';

export function buildCodexProxyRoutesFromResolved(
  resolved: ResolvedFavorite[],
  providersById: Map<string, LocalProvider>,
): CodexProxyRoute[] {
  const skippedOAuth: string[] = [];
  const routes = resolved
    .map(r => {
      const provider = providersById.get(r.providerId);
      if (!provider) return undefined;
      const model = r.model as LocalProviderModel;

      // Skip if OAuth provider has empty apiKey (OAuth refresh flows not supported in favorites proxy)
      if (!r.apiKey && provider.authType === 'oauth') {
        skippedOAuth.push(`${r.providerId}/${model.id}`);
        return undefined;
      }

      const route = resolveCodexRoute(provider, model, r.apiKey);
      return {
        modelId: codexCliFavoritesSlug(r.providerId, model.id),
        npm: route.npm,
        apiKey: route.apiKey,
        baseURL: route.baseURL,
        upstreamModelId: route.upstreamModelId,
        providerId: route.providerId,
        authType: route.authType,
        oauthAccountId: route.oauthAccountId,
        contextWindow: route.contextWindow,
      } as CodexProxyRoute;
    })
    .filter((r): r is CodexProxyRoute => r !== undefined);

  if (skippedOAuth.length > 0) {
    p.log.warn(
      `Skipped ${skippedOAuth.length} OAuth favorite(s) (OAuth auth not supported in favorites catalog): ${skippedOAuth.join(', ')}`,
    );
  }

  return routes;
}


export function resolveCodexFavorites(
  activeProvider: LocalProvider,
  selectedModel: LocalProviderModel,
  compatible: LocalProvider[],
  favorites: FavoriteModel[],
  agent: CompatibilityAgent,
  zenGoApiKey?: string | null,
): {
  resolvedFavorites: ResolvedFavorite[];
  providersById: Map<string, LocalProvider>;
} {
  const ctx: ResolveContext = {
    agent,
    localProviders: compatible,
    zenGoApiKey,
    zenModels: compatible.find(p => p.id === 'zen')?.models as any,
    goModels: compatible.find(p => p.id === 'go')?.models as any,
    findLocalModel: (pid, mid) => {
      const provider = compatible.find(lp => lp.id === pid);
      const model = provider?.models.find(m => m.id === mid);
      return provider && model ? { provider, model } : undefined;
    },
  };
  const startingResolved = resolveFavorite(
    { providerId: activeProvider.id, modelId: selectedModel.id },
    ctx,
  );
  const { resolved, droppedFavorites } = buildFavoritesList(
    startingResolved,
    favorites,
    ctx,
  );
  if (droppedFavorites.length > 0) {
    p.log.warn(
      `Skipped ${droppedFavorites.length} stale/unauthorized favorite(s): ${droppedFavorites.map(f => `${f.providerId}:${f.modelId}`).join(', ')}`,
    );
  }
  return {
    resolvedFavorites: resolved,
    providersById: new Map(compatible.map(lp => [lp.id, lp])),
  };
}
