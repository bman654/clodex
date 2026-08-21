// src/favorites-resolver.ts
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
 * Resolution context consumed by resolveFavorite. The resolver is route-shape-agnostic; callers build their own route type.
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
