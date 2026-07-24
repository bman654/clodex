// src/registry/refresh-models.ts — user-initiated model list refresh per modelSource

import { isDeepStrictEqual } from 'node:util';
import { fetchAnthropicModels } from './custom-endpoint.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistryStrict, saveRegistry } from './io.js';
import { withRegistryWriteLock } from './lock.js';
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
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';
import { buildOpenAiOAuthModels, CHATGPT_CODEX_UNSUPPORTED_MODELS } from '../data/openai-oauth-models.js';
import { modelPrefersResponsesApi } from '../provider-factory.js';
import { deriveBrand } from '../models.js';
import { resolveContextWindow } from '../context-window.js';
import { getInstalledClaudeVersion } from '../launch.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';

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

/**
 * OAuth model refresh:
 * - OpenAI OAuth: Fetch from chatgpt.com/backend-api/models using the OAuth access token.
 *   Falls back to static seed on network failure or unexpected response format.
 *   Note: api.openai.com/v1/models rejects OAuth tokens — never call that endpoint here.
 */
async function refreshOAuthProvider(
  provider: RegistryProvider,
  accessToken: string,
): Promise<{ models: CachedModel[]; baseUrl?: string; source: 'live' | 'seed'; failureReason?: string }> {
  const tpl = provider.templateId ?? provider.id;
  if (tpl === 'openai' || tpl === 'openai-oauth') return refreshOpenAiOAuthModels(accessToken);
  throw new Error(`refreshOAuthProvider: unsupported template "${tpl}"`);
}

/** A parsed model entry, including backend-reported transport capability flags. */
interface OpenAiModelEntry {
  id: string;
  name: string;
  context_window?: number;
  /** Backend flags: model needs the Responses-Lite shape / WebSocket transport. */
  useResponsesLite?: boolean;
  preferWebSockets?: boolean;
}

/** Read the Responses-Lite / WebSocket capability flags off a raw model entry. */
function readCapabilityFlags(m: Record<string, unknown>): Pick<OpenAiModelEntry, 'useResponsesLite' | 'preferWebSockets'> {
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  return {
    useResponsesLite: bool(m['use_responses_lite']),
    preferWebSockets: bool(m['prefer_websockets']),
  };
}

/** Parse model entries from OpenAI-standard or ChatGPT-internal response shapes. */
function parseOpenAiModelEntries(body: unknown): OpenAiModelEntry[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;

  // ChatGPT backend format: { models: [{ slug, title }] }
  if (Array.isArray(b.models)) {
    return (b.models as Array<Record<string, unknown>>)
      .map(m => ({
        id: (m.slug as string) ?? '',
        name: (m.title as string) ?? (m.name as string) ?? (m.slug as string) ?? '',
        context_window: m.context_window as number | undefined,
        ...readCapabilityFlags(m),
      }))
      .filter(m => m.id.length > 0);
  }
  // Standard OpenAI format: { data: [{ id, name }] }
  if (Array.isArray(b.data)) {
    return (b.data as Array<Record<string, unknown>>)
      .map(m => ({
        id: (m.id as string) ?? '',
        name: (m.name as string) ?? (m.id as string) ?? '',
        context_window: m.context_window as number | undefined,
        ...readCapabilityFlags(m),
      }))
      .filter(m => m.id.length > 0);
  }
  return [];
}

/**
 * Build a CachedModel for a discovered OpenAI OAuth model. The live backend is
 * authoritative for context and capability flags: when the model is also seeded,
 * live values are merged over the seed (the seed is only a fallback).
 */
function buildDynamicOAuthModel(entry: OpenAiModelEntry, seedById: Map<string, CachedModel>): CachedModel {
  const seed = seedById.get(entry.id);
  if (seed) {
    return {
      ...seed,
      contextWindow: entry.context_window ?? seed.contextWindow,
      useResponsesLite: entry.useResponsesLite ?? seed.useResponsesLite,
      preferWebSockets: entry.preferWebSockets ?? seed.preferWebSockets,
    };
  }
  const { id } = entry;
  const prefix = id.split('-')[0] ?? id;
  return {
    id,
    name: entry.name,
    upstreamModelId: id,
    family: prefix,
    brand: deriveBrand(prefix),
    contextWindow: entry.context_window ?? resolveContextWindow(id),
    modelFormat: 'openai' as const,
    npm: '@ai-sdk/openai',
    reasoning: modelPrefersResponsesApi(id),
    useResponsesLite: entry.useResponsesLite,
    preferWebSockets: entry.preferWebSockets,
  };
}

/** Fetch and parse JSON from a URL with auth and timeout, returning null on any failure. */
async function fetchJsonWithAuth(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<{ body: unknown | null; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      const detail = await response.text().then(t => t.slice(0, 200)).catch(() => '');
      return { body: null, error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
    }
    return { body: await response.json() };
  } catch (err) {
    return { body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch OpenAI OAuth (ChatGPT) models using a 3-tier strategy:
 *
 * 1. chatgpt.com/backend-api/codex/models — Codex-specific endpoint.
 *    If it exists, it returns ONLY models the Codex API actually supports,
 *    so no filtering is needed. Self-updating as OpenAI changes Codex availability.
 *
 * 2. chatgpt.com/backend-api/models — all ChatGPT models, filtered by the
 *    confirmed-bad set. Used when the Codex endpoint doesn't exist or returns nothing.
 *
 * 3. Static seed — emergency fallback with no network dependency.
 */
async function refreshOpenAiOAuthModels(
  accessToken: string,
): Promise<{ models: CachedModel[]; source: 'live' | 'seed'; failureReason?: string }> {
  const TIMEOUT_MS = 10_000;
  const seedById = new Map(buildOpenAiOAuthModels().map(m => [m.id, m]));
  const toModels = (entries: OpenAiModelEntry[]) =>
    entries.map(entry => buildDynamicOAuthModel(entry, seedById));

  const claudeVersion = getInstalledClaudeVersion();

  // Tier 1: Codex-specific model listing — source of truth for Codex availability.
  const codexResult = await fetchJsonWithAuth(
    `https://chatgpt.com/backend-api/codex/models?client_version=${claudeVersion}`,
    accessToken,
    TIMEOUT_MS,
  );
  const codexEntries = parseOpenAiModelEntries(codexResult.body);
  if (codexEntries.length > 0) {
    return { models: toModels(codexEntries), source: 'live' };
  }

  // Tier 2: General ChatGPT model list, filtered by known Codex restrictions.
  const chatGptResult = await fetchJsonWithAuth(
    'https://chatgpt.com/backend-api/models',
    accessToken,
    TIMEOUT_MS,
  );
  const chatGptEntries = parseOpenAiModelEntries(chatGptResult.body)
    .filter(({ id }) => !CHATGPT_CODEX_UNSUPPORTED_MODELS.has(id));
  if (chatGptEntries.length > 0) {
    return { models: toModels(chatGptEntries), source: 'live' };
  }

  // Tier 3: Static seed — reuse already-built map instead of calling the builder again.
  return {
    models: [...seedById.values()],
    source: 'seed',
    failureReason: chatGptResult.error ?? codexResult.error,
  };
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
  const usableModels = !apiKey.trim() && template.anonymousFreeModels
    ? fetched.models.filter(model => isFreeStatus(classifyFreeStatus({
        model,
        providerId: provider.id,
        templateId: provider.templateId,
      })))
    : fetched.models;
  if (usableModels.length === 0) {
    return { models: [], error: 'No free models were returned for anonymous access.' };
  }

  return {
    models: usableModels.map(m => ({
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

function providerDiscoveryInputsMatch(
  current: RegistryProvider,
  started: RegistryProvider,
): boolean {
  return current.authRef === started.authRef
    && current.authType === started.authType
    && current.templateId === started.templateId
    && isDeepStrictEqual(current.api, started.api);
}

export async function refreshProviderModels(
  providerId: string,
  apiKey: string | null,
  registry?: ProviderRegistry,
): Promise<RefreshProviderResult> {
  const workingRegistry = registry ?? loadRegistryStrict();
  const provider = workingRegistry.providers.find(p => p.id === providerId);
  if (!provider) {
    return { id: providerId, name: providerId, ok: false, reason: 'Provider not found.' };
  }

  const source = resolveModelSource(provider);
  if (source === 'manual-only') {
    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      skipped: true,
      reason: 'Manual-only provider — model list is not refreshed automatically.',
    };
  }

  try {
    const previousModelCount = provider.modelsCache?.models.length ?? 0;
    let models: CachedModel[] = [];
    let baseUrl: string | undefined;
    let oauthFallbackReason: string | undefined;

    if (provider.authType === 'oauth' && ((provider.templateId ?? provider.id) === 'openai' || provider.id === 'openai-oauth')) {
      // OAuth tokens are not valid API keys for the developer endpoints.
      // OpenAI: ChatGPT JWT rejected by api.openai.com; no /v1/models on ChatGPT backend.
      if (!apiKey) {
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'OAuth token not available — try signing in again with clodex providers auth.',
        };
      }
      const oauthResult = await refreshOAuthProvider(provider, apiKey);
      const failureDetail = oauthResult.failureReason ? ` (${oauthResult.failureReason})` : '';
      if (oauthResult.source === 'seed' && cachedModelCount(provider) > 0) {
        // Live discovery failed — keep the existing cache (which may already include
        // models newer than the built-in fallback list) instead of overwriting it.
        return skipWithCachedModels(
          provider,
          `Live model discovery failed${failureDetail} — kept your existing cached model list instead of `
          + "overwriting it with clodex's built-in fallback list. Try refreshing again later.",
        );
      }
      if (oauthResult.source === 'seed') {
        oauthFallbackReason = `Live model discovery failed${failureDetail} — showing clodex's built-in fallback `
          + 'model list, which may not include the newest models yet. Try refreshing again later.';
      }
      models = oauthResult.models;
      if (models.length === 0) {
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'No models available for this OAuth provider — try signing in again.',
        };
      }
    } else {
      const template = resolveProviderTemplate(provider);
      const keyOptional = template?.apiKeyOptional === true;
      const effectiveKey = keyOptional && isLikelyPlaceholderKey(apiKey) ? '' : apiKey;
      if (!keyOptional && isLikelyPlaceholderKey(effectiveKey)) {
        if (cachedModelCount(provider) > 0) {
          return skipWithCachedModels(
            provider,
            'A placeholder API key is configured — kept cached model list. '
            + 'Add this provider again via clodex providers add with a real key to refresh live.',
          );
        }
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'No usable API key — add the provider via clodex providers add with a real key.',
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
            + 'Update your API key via clodex providers add if you need a live refresh.',
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

    await withRegistryWriteLock(() => {
      const currentRegistry = loadRegistryStrict();
      const currentProvider = currentRegistry.providers.find(candidate => candidate.id === providerId);
      if (!currentProvider) throw new Error('Provider was removed while models were refreshing.');
      if (currentProvider.authRef !== provider.authRef) {
        throw new Error('Provider credentials changed while models were refreshing.');
      }
      if (!providerDiscoveryInputsMatch(currentProvider, provider)) {
        throw new Error('Provider configuration changed while models were refreshing.');
      }
      updateProviderCache(currentRegistry, providerId, enriched, baseUrl);
      saveRegistry(currentRegistry);
    });
    enrichPricingAsync();

    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      modelCount: enriched.length,
      previousModelCount: provider.refreshedAt ? previousModelCount : undefined,
      reason: oauthFallbackReason,
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
  const registry = loadRegistryStrict();

  const enabledProviders = registry.providers.filter(p => p.enabled);

  for (const provider of enabledProviders) {
    const key = await resolveRefreshCredential(provider, resolveKey);
    refreshed.push(await refreshProviderModels(provider.id, key));
  }

  return { refreshed };
}
