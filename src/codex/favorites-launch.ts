import * as p from '@clack/prompts';
import type { CodexProxyRoute } from '../codex-proxy.js';
import { buildFavoritesList, resolveFavorite } from '../favorites-resolver.js';
import type { ResolveContext, ResolvedFavorite } from '../favorites-resolver.js';
import type { CompatibilityAgent } from '../model-compatibility.js';
import { resolveCodexRoute } from './routing.js';
import type { LocalProvider, LocalProviderModel, FavoriteModel } from '../types.js';

export function buildCodexProxyRoutesFromResolved(
  resolved: ResolvedFavorite[],
  providersById: Map<string, LocalProvider>,
): CodexProxyRoute[] {
  return resolved
    .map(r => {
      const provider = providersById.get(r.providerId);
      if (!provider) return undefined;
      const model = r.model as LocalProviderModel;
      const route = resolveCodexRoute(provider, model, r.apiKey);
      return {
        modelId: route.modelId,
        npm: route.npm,
        apiKey: route.apiKey,
        baseURL: route.baseURL,
        upstreamModelId: route.upstreamModelId,
        providerId: route.providerId,
        authType: route.authType,
        oauthAccountId: route.oauthAccountId,
      } as CodexProxyRoute;
    })
    .filter((r): r is CodexProxyRoute => r !== undefined);
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
