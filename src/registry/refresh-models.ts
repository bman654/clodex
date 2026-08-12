// src/registry/refresh-models.ts — user-initiated model list refresh per modelSource

import { isDeepStrictEqual } from 'node:util';
import { getOAuthAccountSlot } from './oauth-account-storage.js';
import { fetchAnthropicModels } from './custom-endpoint.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistryStrict, saveRegistry } from './io.js';
import { withProviderMutationLock, withRegistryWriteLock } from './lock.js';
import { resolveModelSource } from './model-source.js';
import { validateCustomEndpointUrl } from './url-security.js';
import {
  effectiveProviderBaseUrl,
  isRetainedOpenCodeGoProvider,
  resolveProviderTemplate,
  retainedOpenCodeGoTemplate,
  syntheticTemplate,
} from './resolve-template.js';
import {
  buildPricingIndex,
  enrichModelsWithPricing,
  enrichPricingAsync,
  loadPricingCache,
  pricingPlatformForProvider,
  providerPreservesModelPricing,
} from './pricing.js';
import {
  cachedModelCount,
  isLikelyPlaceholderKey,
  refreshCredentialSnapshot,
  resolveRefreshCredentialWithSource,
  skipWithCachedModels,
  type RefreshCredentialResolver,
  type RefreshCredentialSnapshot,
} from './refresh-credentials.js';
import { OAUTH_ACCOUNT_ENV } from '../oauth-account-selection.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';
import { buildOpenAiOAuthModels, CHATGPT_CODEX_UNSUPPORTED_MODELS } from '../data/openai-oauth-models.js';
import { modelPrefersResponsesApi } from '../provider-factory.js';
import { deriveBrand } from '../models.js';
import { resolveContextWindow } from '../context-window.js';
import { getInstalledClaudeVersion } from '../launch.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import {
  isLegacyAnonymousCustomEndpoint,
  openCodeGoPinnedApiUrl,
} from './materialize.js';
import { OPENCODE_GO_PROVIDER_NAME } from '../data/opencode-go-models.js';

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
): Promise<{
  models: CachedModel[];
  baseUrl?: string;
  source: 'live' | 'seed';
  failureReason?: string;
  credentialRejected?: boolean;
}> {
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
): Promise<{
  models: CachedModel[];
  source: 'live' | 'seed';
  failureReason?: string;
  credentialRejected?: boolean;
}> {
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
  const failures = [codexResult.error, chatGptResult.error]
    .filter((error): error is string => error !== undefined);
  const credentialFailure = failures.find(error => /(?:\brejected\b|\b401\b|\b403\b)/i.test(error));
  return {
    models: [...seedById.values()],
    source: 'seed',
    failureReason: credentialFailure ?? chatGptResult.error ?? codexResult.error,
    credentialRejected: credentialFailure !== undefined,
  };
}

async function refreshApiListProvider(
  provider: RegistryProvider,
  apiKey: string,
): Promise<{ models: CachedModel[]; baseUrl?: string; error?: string }> {
  const npm = provider.api.npm ?? '@ai-sdk/openai-compatible';
  // Resolve the retained built-in's OWN template first. `resolveProviderTemplate`
  // reads `templateId` ahead of `id`, so a retained record that names another
  // template resolves to that stranger's entry — and the entry is what carries
  // OpenCode's committed allowlist, its bare-array parse flag, and the default
  // URL the pin below compares against. Resolving it here also keeps a drifted
  // record from being refused for a base URL its real template does allow.
  const retained = isRetainedOpenCodeGoProvider(provider);
  const catalogTemplate = (retained ? retainedOpenCodeGoTemplate() : undefined)
    ?? resolveProviderTemplate(provider);
  const baseUrl = effectiveProviderBaseUrl(provider, catalogTemplate);

  if (!baseUrl) {
    return { models: [], error: 'Provider has no API base URL configured.' };
  }

  // The retained built-in's destination is decided HERE, before any
  // npm-specific branch below can put the credential on the wire.
  //
  // `fetchTemplateModels` enforces the same pin, but only the
  // openai-compatible branch reaches it: a record storing
  // `api.npm: '@ai-sdk/anthropic'` took the branch below and handed the key to
  // `fetchAnthropicModels` at its stored address first. Ordering the check
  // ahead of the branch — and ahead of `validateCustomEndpointUrl`, so a forged
  // address is not even resolved — is what makes the pin unconditional.
  //
  // Refuse rather than silently substitute the pinned URL: a caller that
  // believed it had redirected discovery should find out that it had not.
  if (retained) {
    const pinned = openCodeGoPinnedApiUrl(npm);
    if (!pinned) {
      return {
        models: [],
        error: `${OPENCODE_GO_PROVIDER_NAME} does not support the ${npm} SDK package.`,
      };
    }
    if (baseUrl.replace(/\/$/, '') !== pinned) {
      return {
        models: [],
        error: `${OPENCODE_GO_PROVIDER_NAME} does not support a custom API base URL.`,
      };
    }
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

  // The pin above decides WHERE the key goes; it says nothing about which
  // routine reads the answer. A retained record storing
  // `api.npm: '@ai-sdk/anthropic'` at the pinned OpenCode Anthropic address
  // clears the pin and then falls in here, where `fetchAnthropicModels`
  // expects an Anthropic `{ data: [...] }` envelope that OpenCode does not
  // send and applies none of the committed allowlist/metadata overlay. The
  // retained built-in discovers through its template whatever npm it names;
  // ordinary Anthropic providers keep this branch unchanged.
  if (!retained && npm === '@ai-sdk/anthropic') {
    const fetched = await fetchAnthropicModels(safeBaseUrl, apiKey);
    if (fetched.error || fetched.models.length === 0) {
      return { models: [], error: fetched.error ?? 'No models returned.', baseUrl: fetched.baseUrl };
    }
    return {
      models: fetched.models.map(m => ({ ...m, apiUrl: m.apiUrl ?? fetched.baseUrl })),
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
      apiUrl: m.apiUrl ?? fetched.baseUrl,
    })),
    baseUrl: fetched.baseUrl,
  };
}

function updateProviderCache(
  registry: ProviderRegistry,
  providerId: string,
  models: CachedModel[],
  baseUrl?: string,
  credentialSnapshot?: RefreshCredentialSnapshot,
): void {
  const idx = registry.providers.findIndex(p => p.id === providerId);
  if (idx < 0) return;
  const now = new Date().toISOString();
  const existing = registry.providers[idx]!;
  const modelsCache = { fetchedAt: now, models };
  const selectedAccount = credentialSnapshot?.selectedAccount;
  const temporaryAccount = isTemporaryAccountSelection(credentialSnapshot);
  const selectedSlot = selectedAccount
    ? getOAuthAccountSlot(existing, selectedAccount.name)
    : undefined;
  const authAccounts = selectedAccount && selectedSlot
    ? {
        ...existing.authAccounts,
        [selectedAccount.name]: {
          ...selectedSlot,
          modelsCache,
        },
      }
    : existing.authAccounts;
  registry.providers[idx] = {
    ...existing,
    api: baseUrl ? { ...existing.api, url: baseUrl } : existing.api,
    ...(authAccounts ? { authAccounts } : {}),
    ...(!temporaryAccount ? { refreshedAt: now, modelsCache } : {}),
  };
}

function isTemporaryAccountSelection(snapshot?: RefreshCredentialSnapshot): boolean {
  return Boolean(
    snapshot?.environmentAccount
    && snapshot.selectedAccount
    && snapshot.environmentAccount !== snapshot.activeAuthAccount,
  );
}

function providerWithRefreshCache(
  provider: RegistryProvider,
  snapshot?: RefreshCredentialSnapshot,
): RegistryProvider {
  const selected = snapshot?.selectedAccount;
  const temporary = isTemporaryAccountSelection(snapshot);
  if (!temporary || !selected) return provider;
  const projected = { ...provider };
  const cache = getOAuthAccountSlot(provider, selected.name)?.modelsCache;
  if (cache) projected.modelsCache = cache;
  else delete projected.modelsCache;
  return projected;
}

function providerDiscoveryInputsMatch(
  current: RegistryProvider,
  started: RegistryProvider,
): boolean {
  return current.authRef === started.authRef
    && current.enabled === started.enabled
    && current.authType === started.authType
    && current.templateId === started.templateId
    && isDeepStrictEqual(current.api, started.api);
}

function assertRefreshCredentialStillCurrent(
  current: RegistryProvider,
  snapshot: RefreshCredentialSnapshot,
): void {
  const routing = snapshot.provider;
  if (
    current.id !== routing.id
    || current.addedAt !== routing.addedAt
    || current.enabled !== routing.enabled
    || current.authType !== routing.authType
    || current.templateId !== routing.templateId
    || !isDeepStrictEqual(current.api, routing.api)
  ) {
    throw new Error('Provider configuration changed while credentials were resolving.');
  }
  const activeAuthAccount = current.activeAuthAccount?.trim() || undefined;
  if (activeAuthAccount !== snapshot.activeAuthAccount) {
    throw new Error('Provider account selection changed while models were refreshing.');
  }
  let currentSnapshot: RefreshCredentialSnapshot;
  try {
    currentSnapshot = refreshCredentialSnapshot(
      current,
      snapshot.environmentAccount ?? null,
      { ignoreProviderOverride: snapshot.ignoreProviderOverride },
    );
  } catch {
    throw new Error('Provider account selection changed while models were refreshing.');
  }
  if (currentSnapshot.authRef !== snapshot.authRef) {
    throw new Error('Provider credentials changed while models were refreshing.');
  }
  if (!isDeepStrictEqual(currentSnapshot.selectedAccount, snapshot.selectedAccount)) {
    throw new Error('Provider account credentials changed while models were refreshing.');
  }
  if (!isDeepStrictEqual(currentSnapshot.credentialOverride, snapshot.credentialOverride)) {
    throw new Error('Provider credential override changed while models were refreshing.');
  }
}

export async function refreshProviderModels(
  providerId: string,
  apiKey: string | null,
  registry?: ProviderRegistry,
  credentialSnapshot?: RefreshCredentialSnapshot,
): Promise<RefreshProviderResult> {
  const workingRegistry = registry ?? loadRegistryStrict();
  const provider = workingRegistry.providers.find(p => p.id === providerId);
  if (!provider) {
    return { id: providerId, name: providerId, ok: false, reason: 'Provider not found.' };
  }
  if (credentialSnapshot) {
    try {
      assertRefreshCredentialStillCurrent(provider, credentialSnapshot);
    } catch (err) {
      return {
        id: provider.id,
        name: provider.name,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const cacheProvider = providerWithRefreshCache(provider, credentialSnapshot);

  if (credentialSnapshot?.credentialOverride) {
    return skipWithCachedModels(
      cacheProvider,
      `${credentialSnapshot.credentialOverride.variable} is a process-scoped provider credential override — `
      + 'skipped the persistent model refresh so another shell cannot inherit this credential\'s catalog.',
    );
  }
  const source = resolveModelSource(provider);
  if (source === 'manual-only') {
    if (provider.authType !== 'none' && !apiKey) {
      return {
        id: provider.id,
        name: provider.name,
        ok: false,
        reason: provider.authType === 'oauth'
          ? 'OAuth token not available — try signing in again with clodex providers auth.'
          : 'API key not available — cannot verify the saved model catalog.',
      };
    }
    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      skipped: true,
      reason: 'Manual-only provider — model list is not refreshed automatically.',
    };
  }

  try {
    const previousModelCount = cacheProvider.modelsCache?.models.length ?? 0;
    const hadPreviousRefresh = isTemporaryAccountSelection(credentialSnapshot)
      ? cacheProvider.modelsCache !== undefined
      : provider.refreshedAt !== undefined;
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
      const oauthResult = await refreshOAuthProvider(cacheProvider, apiKey);
      const failureDetail = oauthResult.failureReason ? ` (${oauthResult.failureReason})` : '';
      if (oauthResult.source === 'seed' && oauthResult.credentialRejected) {
        const count = cachedModelCount(cacheProvider);
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          ...(count > 0 ? { modelCount: count } : {}),
          reason: `OAuth credential was rejected${failureDetail}. `
            + (count > 0
              ? `Kept ${count} cached model${count === 1 ? '' : 's'}, but sign in again before launching.`
              : 'Sign in again before refreshing or launching.'),
        };
      }
      if (oauthResult.source === 'seed' && cachedModelCount(cacheProvider) > 0) {
        // Live discovery failed — keep the existing cache (which may already include
        // models newer than the built-in fallback list) instead of overwriting it.
        return skipWithCachedModels(
          cacheProvider,
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
        if (cachedModelCount(cacheProvider) > 0) {
          if (isLegacyAnonymousCustomEndpoint(provider, effectiveKey)) {
            return skipWithCachedModels(
              cacheProvider,
              'Legacy anonymous custom endpoint — kept cached model list.',
            );
          }
          const count = cachedModelCount(cacheProvider);
          return {
            id: provider.id,
            name: provider.name,
            ok: false,
            modelCount: count,
            reason: `A placeholder API key is configured — kept ${count} cached model${count === 1 ? '' : 's'}, `
              + 'but add this provider again with a real key before launching.',
          };
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
          && cachedModelCount(cacheProvider) > 0
        ) {
          const count = cachedModelCount(cacheProvider);
          return {
            id: provider.id,
            name: provider.name,
            ok: false,
            modelCount: count,
            reason: `${fetched.error} Kept ${count} cached model${count === 1 ? '' : 's'} from import, `
              + 'but update the API key before launching.',
          };
        }
        return { id: provider.id, name: provider.name, ok: false, reason: fetched.error };
      }
      models = fetched.models;
      baseUrl = fetched.baseUrl;
    }

    const pricingCache = loadPricingCache();
    const platform = pricingPlatformForProvider(provider.templateId, provider.id);
    const enriched = providerPreservesModelPricing(provider)
      ? models
      : enrichModelsWithPricing(models, buildPricingIndex(pricingCache), platform);

    await withRegistryWriteLock(() => {
      const currentRegistry = loadRegistryStrict();
      const currentProvider = currentRegistry.providers.find(candidate => candidate.id === providerId);
      if (!currentProvider) throw new Error('Provider was removed while models were refreshing.');
      // A v5 account switch necessarily changes top-level authRef too. Check
      // the richer account/generation snapshot first so the fence reports the
      // selection transition instead of collapsing it into a generic ref
      // change; snapshotless callers retain the legacy ref guard below.
      if (credentialSnapshot) {
        assertRefreshCredentialStillCurrent(currentProvider, credentialSnapshot);
      }
      if (currentProvider.authRef !== provider.authRef) {
        throw new Error('Provider credentials changed while models were refreshing.');
      }
      if (!providerDiscoveryInputsMatch(currentProvider, provider)) {
        throw new Error('Provider configuration changed while models were refreshing.');
      }
      updateProviderCache(currentRegistry, providerId, enriched, baseUrl, credentialSnapshot);
      saveRegistry(currentRegistry);
    });
    enrichPricingAsync();

    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      modelCount: enriched.length,
      previousModelCount: hadPreviousRefresh ? previousModelCount : undefined,
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

/**
 * Resolve and use one provider credential under the provider mutation lock.
 * OAuth credential references are deterministic, so registry fields alone
 * cannot detect a concurrent default-account reauthentication. Holding this
 * lock from the credential read through the cache commit makes that generation
 * boundary explicit without persisting credential metadata in the registry.
 */
export async function refreshProviderModelsWithCredential(
  providerId: string,
  resolveKey: RefreshCredentialResolver,
  selected: string | null | undefined = process.env[OAUTH_ACCOUNT_ENV],
  options: { requireEnabled?: boolean; ignoreProviderOverride?: boolean } = {},
): Promise<RefreshProviderResult> {
  return withProviderMutationLock(providerId, async () => {
    const provider = loadRegistryStrict().providers.find(candidate => candidate.id === providerId);
    if (!provider) {
      return { id: providerId, name: providerId, ok: false, reason: 'Provider not found.' };
    }
    if (options.requireEnabled && !provider.enabled) {
      return {
        id: provider.id,
        name: provider.name,
        ok: true,
        skipped: true,
        reason: 'Provider was disabled before its model refresh began.',
      };
    }
    const accountOverride = selected === null ? null : selected ?? process.env[OAUTH_ACCOUNT_ENV] ?? null;
    const snapshot = refreshCredentialSnapshot(provider, accountOverride, {
      ignoreProviderOverride: options.ignoreProviderOverride,
    });
    const resolved = await resolveRefreshCredentialWithSource(
      provider,
      resolveKey,
      accountOverride,
      { ignoreProviderOverride: options.ignoreProviderOverride },
    );
    if (!isDeepStrictEqual(resolved.credentialOverride, snapshot.credentialOverride)) {
      return {
        id: provider.id,
        name: provider.name,
        ok: false,
        reason: 'Provider credential override changed while models were refreshing.',
      };
    }
    return refreshProviderModels(provider.id, resolved.credential, undefined, snapshot);
  });
}

export async function refreshAllProviderModels(
  resolveKey: RefreshCredentialResolver,
): Promise<RefreshModelsResult> {
  const refreshed: RefreshProviderResult[] = [];
  const registry = loadRegistryStrict();

  const enabledProviders = registry.providers.filter(p => p.enabled);

  for (const provider of enabledProviders) {
    const accountOverride = process.env[OAUTH_ACCOUNT_ENV] ?? null;
    try {
      refreshed.push(await refreshProviderModelsWithCredential(
        provider.id,
        resolveKey,
        accountOverride,
        { requireEnabled: true },
      ));
    } catch (err) {
      refreshed.push({
        id: provider.id,
        name: provider.name,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { refreshed };
}
