// src/registry/materialize.ts — registry entries → LocalProvider runtime shape

import { shouldHideModel, type CompatibilityAgent } from '../model-compatibility.js';
import { deriveBrand } from '../models.js';
import { resolveContextWindow } from '../context-window.js';
import type { LocalProvider, LocalProviderModel } from '../types.js';
import { normalizeGoogleDisplayName, normalizeGoogleModelId } from './google-model-id.js';
import { findModelsDevModel } from './models-dev.js';
import { applyTemplateModelMetadata } from './fetch-template-models.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';
import { isValidProviderId } from './validate.js';
import {
  isRetainedOpenCodeGoProvider,
  openCodeGoPinnedApiUrl,
  retainedOpenCodeGoTemplate,
} from './resolve-template.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import { OAUTH_ACCOUNT_ENV } from '../oauth-account-selection.js';

export { OAUTH_ACCOUNT_ENV } from '../oauth-account-selection.js';

export type CredentialResolver = (provider: RegistryProvider) => string | null;

/** Map an AI SDK npm package + API URL to the endpoint shape clodex should use. */
export function resolveEndpoint(
  npm: string,
  apiUrl: string,
): { format: 'anthropic' | 'openai'; baseUrl?: string; completionsUrl?: string } | null {
  if (!npm) return null;
  if (npm === '@ai-sdk/anthropic') {
    return {
      format: 'anthropic',
      baseUrl: (apiUrl || 'https://api.anthropic.com').replace(/\/v1\/?$/, ''),
    };
  }
  if (npm === '@ai-sdk/openai-compatible') {
    if (!apiUrl) return null;
    return {
      format: 'openai',
      completionsUrl: apiUrl.replace(/\/$/, '') + '/chat/completions',
    };
  }
  // Any other npm — SDK adapter owns endpoints.
  return { format: 'openai' };
}

export interface MaterializeOptions {
  agent?: CompatibilityAgent;
}

export { openCodeGoPinnedApiUrl } from './resolve-template.js';

/**
 * Project persisted model caches onto the authority that owns their provider identity.
 * Ordinary and custom providers retain their cache array unchanged; retained OpenCode
 * identities are fail-closed against the committed template catalog.
 */
export function projectProviderCachedModels(provider: RegistryProvider): CachedModel[] {
  const cached = provider.modelsCache?.models ?? [];
  if (!isRetainedOpenCodeGoProvider(provider)) return cached;
  const template = retainedOpenCodeGoTemplate();
  return template ? applyTemplateModelMetadata(template, cached) : [];
}

function resolveMaterializedApiUrl(
  cached: CachedModel,
  provider: RegistryProvider,
  npm: string,
): string | null {
  if (!isRetainedOpenCodeGoProvider(provider)) {
    return cached.apiUrl ?? provider.api.url ?? '';
  }
  return openCodeGoPinnedApiUrl(npm);
}

export function cachedModelToLocal(
  cached: CachedModel,
  provider: RegistryProvider,
): LocalProviderModel | null {
  const freeStatus = classifyFreeStatus({
    model: cached,
    providerId: provider.id,
    templateId: provider.templateId,
  });

  const npm = cached.npm ?? provider.api.npm ?? '';
  const apiUrl = resolveMaterializedApiUrl(cached, provider, npm);
  if (apiUrl === null) return null;
  const endpoint = resolveEndpoint(npm, apiUrl);
  if (endpoint === null) return null;

  const modelsDev = findModelsDevModel(provider.id, cached.id);
  const { id, upstreamModelId } = normalizeGoogleModelId(cached.id, npm);
  const normalizedUpstream = normalizeGoogleModelId(cached.upstreamModelId ?? cached.id, npm).upstreamModelId;
  const family = npm === '@ai-sdk/google' ? (id.split(/[-/:]/)[0] ?? id) : (cached.family ?? '');

  return {
    id,
    name: npm === '@ai-sdk/google' ? normalizeGoogleDisplayName(cached.name, id) : cached.name,
    family,
    brand: npm === '@ai-sdk/google' ? deriveBrand(family) : (cached.brand ?? deriveBrand(cached.family ?? '')),
    modelFormat: (cached.modelFormat === 'anthropic' || cached.modelFormat === 'openai' ? cached.modelFormat : undefined) ?? endpoint.format,
    upstreamModelId: normalizedUpstream,
    baseUrl: endpoint.baseUrl,
    completionsUrl: endpoint.completionsUrl,
    npm: npm || undefined,
    apiBaseUrl: apiUrl || undefined,
    cost: cached.cost,
    isFree: isFreeStatus(freeStatus),
    freeStatus,
    contextWindow: cached.contextWindow ?? resolveContextWindow(id),
    supportedParameters: cached.supportedParameters,
    reasoning: cached.reasoning ?? modelsDev?.reasoning,
    interleavedReasoningField: cached.interleavedReasoningField ?? modelsDev?.interleaved?.field,
    useResponsesLite: cached.useResponsesLite,
    preferWebSockets: cached.preferWebSockets,
    modalities: cached.modalities,
    compatibility: cached.compatibility,
  };
}

export function isAnonymousProvider(
  provider: Pick<RegistryProvider, 'authRef' | 'authType'>,
): boolean {
  return provider.authType === 'none' && provider.authRef === 'none:anonymous';
}

export function isLegacyAnonymousCustomEndpoint(
  provider: RegistryProvider,
  credential: string | null,
): boolean {
  return provider.authType === undefined
    && (provider.templateId === 'custom-openai' || provider.templateId === 'custom-anthropic')
    && provider.authRef === `keyring:provider:${provider.id}`
    && credential === 'local';
}

/**
 * Resolve the selected OAuth account slot for a provider, highest precedence
 * first: CLODEX_OAUTH_ACCOUNT, then the provider's stored `activeAuthAccount`,
 * then its own default credential. The winner swaps the provider's authRef for
 * that slot's, so every downstream consumer — credential resolution, OAuth
 * metadata, token refresh persistence — transparently uses that account.
 * Providers without slots ignore the selector (it only chooses among slots
 * where slots exist); naming a missing slot on a provider that has slots is
 * a hard error, because silently falling back to the default account would
 * run the session as the wrong identity.
 */
export function applySelectedOAuthAccount(
  provider: RegistryProvider,
  selected: string | undefined = process.env[OAUTH_ACCOUNT_ENV],
  warn?: (message: string) => void,
): RegistryProvider {
  const requested = selected?.trim().toLowerCase();
  // The environment wins so a single command can borrow another identity
  // without disturbing the stored choice every other launch depends on.
  const fromEnvironment = Boolean(requested);
  const name = requested || provider.activeAuthAccount?.trim();
  if (!name) return provider;
  // A disabled provider cannot participate in the launch, so a stale selector
  // aimed at it must not throw and take the whole catalog load down.
  if (!provider.enabled) return provider;
  if (provider.authType !== 'oauth') return provider;
  const slots = provider.authAccounts;
  const stored = provider.activeAuthAccount?.trim();
  // Keyed on whether a STORED selection exists, not on which selector won.
  //
  // An environment selector aimed at a provider with no slots at all is
  // ignored: it only ever chooses AMONG slots, and a stale variable must not
  // take down a catalog load. A stored selection is different — the registry
  // serializes selector-only state as valid, so a missing slot table means a
  // deliberate choice can no longer be honoured, and continuing would run
  // every launch as the wrong identity in silence.
  //
  // Gating on `fromEnvironment` conflated the two: exporting the variable for
  // ANY provider made every orphaned stored selection silently resolve to the
  // provider default, which is the exact substitution this branch exists to
  // refuse. The environment cannot rescue a broken stored selection, because
  // with no slot table it has nothing to select either.
  if (!slots || Object.keys(slots).length === 0) {
    if (stored === undefined || stored === '') {
      if (fromEnvironment) {
        warn?.(`${OAUTH_ACCOUNT_ENV}=${requested} ignored for provider "${provider.id}" because it has no named account slots.`);
      }
      return provider;
    }
    throw new Error(
      `Provider "${provider.id}" is set to use account "${stored}", but it has no named accounts. `
      + 'Re-add the account with: clodex providers auth openai --account ' + stored
      + ', or clear the selection with: clodex providers',
    );
  }
  if (!Object.prototype.hasOwnProperty.call(slots, name)) {
    const available = Object.keys(slots).sort().join(', ');
    // The stored selector reaches here only once its slot is gone, so it needs
    // the repair path rather than the add-an-account one: the account was
    // chosen deliberately, and falling back to the default would run every
    // future launch as the wrong identity without ever saying so.
    throw new Error(
      fromEnvironment
        ? `CLODEX_OAUTH_ACCOUNT=${name}: provider "${provider.id}" has no account named "${name}" (available: ${available}). `
          + 'Add it with: clodex providers auth openai --account ' + name
        : `Provider "${provider.id}" is set to use account "${name}", which no longer exists (available: ${available}). `
          + 'Choose another with: clodex providers',
    );
  }
  const account = slots[name]!;
  const projected = { ...provider, authRef: account.authRef };
  if (fromEnvironment && name !== stored) {
    // The top-level cache belongs to the persisted selection. A temporary
    // account must use only the catalog discovered with that slot; pairing its
    // credential with another account's entitlements can advertise inaccessible
    // models or hide models it owns. No slot cache means fail closed.
    if (account.modelsCache) projected.modelsCache = account.modelsCache;
    else delete projected.modelsCache;
  } else if (!projected.modelsCache && account.modelsCache) {
    // A slot-specific refresh may have populated the safe cache before this
    // account became the persisted selection.
    projected.modelsCache = account.modelsCache;
  }
  return projected;
}

/**
 * Project the OAuth identity a provider would use if enabled, while preserving
 * its current enabled flag. Display and explicit-refresh surfaces use this for
 * dormant providers: their catalog must describe the selected account that
 * will become active, not whichever account happened to populate the
 * top-level cache before the provider was disabled.
 */
export function projectSelectedOAuthAccount(
  provider: RegistryProvider,
  selected: string | undefined = process.env[OAUTH_ACCOUNT_ENV],
): RegistryProvider {
  const dormantOAuth = provider.authType === 'oauth' && !provider.enabled;
  const candidate = dormantOAuth ? { ...provider, enabled: true } : provider;
  const projected = applySelectedOAuthAccount(candidate, selected);
  return dormantOAuth ? { ...projected, enabled: false } : projected;
}

function materializeOne(
  provider: RegistryProvider,
  resolveCredential: CredentialResolver,
  agent: CompatibilityAgent,
): LocalProvider | null {
  if (!provider.enabled) return null;
  if (!isValidProviderId(provider.id)) return null;

  const freeOnly = provider.subscriptionFilter === 'free';
  const explicitAnonymous = isAnonymousProvider(provider);
  const credential = explicitAnonymous ? null : resolveCredential(provider);
  const legacyAnonymous = isLegacyAnonymousCustomEndpoint(provider, credential);
  if (provider.authType === undefined && credential === 'local' && !legacyAnonymous) return null;
  const anonymous = explicitAnonymous || legacyAnonymous;
  const apiKey = anonymous ? '' : credential ?? '';
  const models: LocalProviderModel[] = [];
  for (const cached of projectProviderCachedModels(provider)) {
    const freeStatus = classifyFreeStatus({
      model: cached,
      providerId: provider.id,
      templateId: provider.templateId,
    });
    if (freeOnly && !isFreeStatus(freeStatus)) continue;
    const model = cachedModelToLocal(cached, provider);
    if (!model) continue;
    if (shouldHideModel({ providerId: provider.id, modelId: model.id, agent })) continue;
    models.push(model);
  }
  if (models.length === 0) return null;

  if (!apiKey.trim() && !anonymous) return null;

  return {
    id: provider.id,
    name: provider.name,
    apiKey,
    authRef: anonymous ? 'none:anonymous' : provider.authRef,
    authType: anonymous ? 'none' : provider.authType,
    headers: provider.api.headers,
    models,
  };
}

/** Convert enabled registry providers with credentials into launch-time LocalProvider[]. */
export function materializeRegistry(
  registry: ProviderRegistry,
  resolveCredential: CredentialResolver,
  opts?: MaterializeOptions,
): LocalProvider[] {
  const agent = opts?.agent ?? 'claude';
  const result: LocalProvider[] = [];
  for (const provider of registry.providers) {
    const local = materializeOne(provider, resolveCredential, agent);
    if (local) result.push(local);
  }
  return result;
}
