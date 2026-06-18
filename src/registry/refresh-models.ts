// src/registry/refresh-models.ts — user-initiated model list refresh per modelSource

import { BACKENDS } from '../constants.js';
import { getModels } from '../models.js';
import { fetchAnthropicModels } from './custom-endpoint.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistry, saveRegistry } from './io.js';
import { resolveModelSource } from './model-source.js';
import { validateCustomEndpointUrl } from './url-security.js';
import {
  effectiveProviderBaseUrl,
  resolveProviderTemplate,
  syntheticTemplate,
} from './resolve-template.js';
import {
  buildPricingIndex,
  enrichModelsWithPricing,
  enrichPricingAsync,
  loadPricingCache,
  pricingPlatformForProvider,
} from './pricing.js';
import { cachedModelCount, isLikelyPlaceholderKey, resolveRefreshCredential, skipWithCachedModels } from './refresh-credentials.js';
import { readGlobalOpencodeCredential } from '../env.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';

export interface RefreshProviderResult {
  id: string;
  name: string;
  ok: boolean;
  modelCount?: number;
  previousModelCount?: number;
  skipped?: boolean;
  reason?: string;
}

export interface RefreshModelsResult {
  refreshed: RefreshProviderResult[];
}

function modelInfoToCached(
  m: {
    id: string;
    name: string;
    brand: string;
    modelFormat: string;
    contextWindow?: number;
    cost?: CachedModel['cost'];
    sourceBackend?: string;
  },
  npm?: string,
  apiUrl?: string,
): CachedModel {
  return {
    id: m.id,
    name: m.name,
    upstreamModelId: m.id,
    family: m.brand,
    brand: m.brand,
    contextWindow: m.contextWindow,
    cost: m.cost,
    modelFormat: m.modelFormat === 'anthropic' ? 'anthropic' : 'openai',
    sourceBackend: m.sourceBackend,
    npm,
    apiUrl,
  };
}

async function refreshZenGoProvider(provider: RegistryProvider): Promise<CachedModel[]> {
  const backendId = provider.id === 'go' || provider.templateId === 'go' ? 'go' : 'zen';
  const result = await getModels(BACKENDS[backendId]);
  return result.models
    .filter(m => m.modelFormat !== 'unsupported')
    .map(m => {
      const isAnthropic = m.modelFormat === 'anthropic';
      const npm = isAnthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
      const apiUrl = isAnthropic ? BACKENDS[backendId].baseUrl : `${BACKENDS[backendId].baseUrl}/v1`;
      return modelInfoToCached(m, npm, apiUrl);
    });
}

async function refreshApiListProvider(
  provider: RegistryProvider,
  apiKey: string,
): Promise<{ models: CachedModel[]; baseUrl?: string; error?: string }> {
  const npm = provider.api.npm ?? '@ai-sdk/openai-compatible';
  const catalogTemplate = resolveProviderTemplate(provider);
  const baseUrl = effectiveProviderBaseUrl(provider, catalogTemplate);

  if (!baseUrl) {
    return { models: [], error: 'Provider has no API base URL configured.' };
  }

  let safeBaseUrl = baseUrl;
  const configuredUrl = provider.api.url?.trim();
  const templateDefault = catalogTemplate?.defaultBaseUrl?.trim();
  if (configuredUrl && configuredUrl !== templateDefault) {
    const urlCheck = await validateCustomEndpointUrl(baseUrl, {
      allowInsecureLocal: catalogTemplate?.apiKeyOptional === true,
    });
    if (!urlCheck.ok || !urlCheck.normalizedUrl) {
      return { models: [], error: `${urlCheck.error ?? 'Invalid API base URL.'} ${urlCheck.hint ?? ''}`.trim() };
    }
    safeBaseUrl = urlCheck.normalizedUrl;
  }

  const template = catalogTemplate ?? syntheticTemplate(provider, safeBaseUrl);

  if (npm === '@ai-sdk/anthropic') {
    const fetched = await fetchAnthropicModels(safeBaseUrl, apiKey);
    if (fetched.error || fetched.models.length === 0) {
      return { models: [], error: fetched.error ?? 'No models returned.', baseUrl: fetched.baseUrl };
    }
    return {
      models: fetched.models.map(m => ({ ...m, apiUrl: fetched.baseUrl })),
      baseUrl: fetched.baseUrl,
    };
  }

  const fetched = await fetchTemplateModels(template, apiKey, safeBaseUrl);
  if (fetched.error || fetched.models.length === 0) {
    return { models: [], error: fetched.error ?? 'No models returned.' };
  }

  return {
    models: fetched.models.map(m => ({
      ...m,
      apiUrl: fetched.baseUrl,
    })),
    baseUrl: fetched.baseUrl,
  };
}

function updateProviderCache(
  registry: ProviderRegistry,
  providerId: string,
  models: CachedModel[],
  baseUrl?: string,
): void {
  const idx = registry.providers.findIndex(p => p.id === providerId);
  if (idx < 0) return;
  const now = new Date().toISOString();
  const existing = registry.providers[idx]!;
  registry.providers[idx] = {
    ...existing,
    refreshedAt: now,
    api: baseUrl ? { ...existing.api, url: baseUrl } : existing.api,
    modelsCache: {
      fetchedAt: now,
      models,
    },
  };
}

export async function refreshProviderModels(
  providerId: string,
  apiKey: string | null,
  registry = loadRegistry(),
): Promise<RefreshProviderResult> {
  const provider = registry.providers.find(p => p.id === providerId);
  if (!provider) {
    return { id: providerId, name: providerId, ok: false, reason: 'Provider not found.' };
  }

  const source = resolveModelSource(provider);
  if (source === 'manual-only') {
    const hint =
      provider.templateId === 'google-vertex' || provider.id === 'google-vertex' || provider.api.npm === '@ai-sdk/google-vertex'
        ? 'Vertex uses gcloud credentials — re-import from OpenCode or configure env auth.'
        : 'Manual-only provider — model list is not refreshed automatically.';
    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      skipped: true,
      reason: hint,
    };
  }

  try {
    const previousModelCount = provider.modelsCache?.models.length ?? 0;
    let models: CachedModel[] = [];
    let baseUrl: string | undefined;

    if (source === 'zen-go-api') {
      models = await refreshZenGoProvider(provider);
    } else {
      const template = resolveProviderTemplate(provider);
      const keyOptional = template?.apiKeyOptional === true;
      const effectiveKey = keyOptional && isLikelyPlaceholderKey(apiKey) ? '' : apiKey;
      if (!keyOptional && isLikelyPlaceholderKey(effectiveKey)) {
        if (cachedModelCount(provider) > 0) {
          return skipWithCachedModels(
            provider,
            'OpenCode imported a placeholder API key — kept cached model list. '
            + 'Add this provider again via relay-ai providers add with a real key to refresh live.',
          );
        }
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'No usable API key — add the provider via relay-ai providers add with a real key.',
        };
      }
      if (!keyOptional && !effectiveKey) {
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'API key not available — cannot refresh models.',
        };
      }
      const fetched = await refreshApiListProvider(provider, effectiveKey ?? '');
      if (fetched.error) {
        if (
          (fetched.error.includes('rejected') || fetched.error.includes('401') || fetched.error.includes('403'))
          && cachedModelCount(provider) > 0
        ) {
          return skipWithCachedModels(
            provider,
            `${fetched.error} Kept ${cachedModelCount(provider)} cached model${cachedModelCount(provider) === 1 ? '' : 's'} from import. `
            + 'Update your API key via relay-ai providers add if you need a live refresh.',
          );
        }
        return { id: provider.id, name: provider.name, ok: false, reason: fetched.error };
      }
      models = fetched.models;
      baseUrl = fetched.baseUrl;
    }

    const pricingCache = loadPricingCache();
    const platform = pricingPlatformForProvider(provider.templateId, provider.id);
    const enriched = enrichModelsWithPricing(models, buildPricingIndex(pricingCache), platform);

    updateProviderCache(registry, providerId, enriched, baseUrl);
    saveRegistry(registry);
    enrichPricingAsync();

    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      modelCount: enriched.length,
      previousModelCount: provider.refreshedAt ? previousModelCount : undefined,
    };
  } catch (err) {
    return {
      id: provider.id,
      name: provider.name,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refreshAllProviderModels(
  resolveKey: (provider: RegistryProvider) => Promise<string | null>,
): Promise<RefreshModelsResult> {
  const refreshed: RefreshProviderResult[] = [];
  const registry = loadRegistry();

  const opencodeKey = await readGlobalOpencodeCredential();

  if (opencodeKey) {
    let changed = false;
    if (!registry.providers.some(p => p.id === 'zen')) {
      registry.providers.push({
        id: 'zen',
        templateId: 'zen',
        name: 'OpenCode Zen',
        enabled: true,
        authRef: 'keyring:global:opencode',
        authType: 'none',
        subscriptionFilter: 'free',
        api: {},
        addedAt: new Date().toISOString(),
      });
      changed = true;
    }
    if (!registry.providers.some(p => p.id === 'go')) {
      registry.providers.push({
        id: 'go',
        templateId: 'go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:global:opencode',
        authType: 'none',
        subscriptionFilter: 'go',
        api: {},
        addedAt: new Date().toISOString(),
      });
      changed = true;
    }
    if (changed) {
      saveRegistry(registry);
    }
  }

  const enabledProviders = registry.providers.filter(p => p.enabled);

  for (const provider of enabledProviders) {
    const key = await resolveRefreshCredential(provider, resolveKey);
    refreshed.push(await refreshProviderModels(provider.id, key, registry));
  }

  return { refreshed };
}
