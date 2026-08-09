// src/registry/materialize.ts — registry entries → LocalProvider runtime shape

import { shouldHideModel, type CompatibilityAgent } from '../model-compatibility.js';
import { deriveBrand } from '../models.js';
import { resolveContextWindow } from '../context-window.js';
import type { LocalProvider, LocalProviderModel } from '../types.js';
import { normalizeGoogleDisplayName, normalizeGoogleModelId } from './google-model-id.js';
import { findModelsDevModel } from './models-dev.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';
import { isValidProviderId } from './validate.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import {
  effectiveProviderCachedModels,
  ignoresModelsDevForOpenCodeGoProvider,
} from '../data/opencode-go-models.js';
import { resolveAnthropicAuthMode } from '../anthropic-auth-mode.js';

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
  const apiUrl = cached.apiUrl ?? provider.api.url ?? '';
  const endpoint = resolveEndpoint(npm, apiUrl);
  if (endpoint === null) return null;

  const ignoreModelsDevCapabilities = ignoresModelsDevForOpenCodeGoProvider(provider);
  const modelsDev = ignoreModelsDevCapabilities
    ? null
    : findModelsDevModel(provider.id, cached.id);
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
    reasoning: cached.codingCapabilitiesAuthoritative
      ? cached.reasoning
      : cached.reasoning ?? modelsDev?.reasoning,
    codingCapabilitiesAuthoritative: cached.codingCapabilitiesAuthoritative,
    ignoreModelsDevCapabilities: ignoreModelsDevCapabilities || undefined,
    interleavedReasoningField: cached.codingCapabilitiesAuthoritative
      ? cached.interleavedReasoningField
      : cached.interleavedReasoningField ?? modelsDev?.interleaved?.field,
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

function isLegacyAnonymousCustomEndpoint(
  provider: RegistryProvider,
  credential: string | null,
): boolean {
  return provider.authType === undefined
    && (provider.templateId === 'custom-openai' || provider.templateId === 'custom-anthropic')
    && provider.authRef === `keyring:provider:${provider.id}`
    && credential === 'local';
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
  const anthropicAuthMode = resolveAnthropicAuthMode(provider);
  const models: LocalProviderModel[] = [];
  const cachedModels = effectiveProviderCachedModels(provider);
  for (const cached of cachedModels) {
    const freeStatus = classifyFreeStatus({
      model: cached,
      providerId: provider.id,
      templateId: provider.templateId,
    });
    if (freeOnly && !isFreeStatus(freeStatus)) continue;
    const model = cachedModelToLocal(cached, provider);
    if (!model) continue;
    if (shouldHideModel({
      providerId: provider.id,
      modelId: model.id,
      agent,
      codingCapabilitiesAuthoritative: model.codingCapabilitiesAuthoritative,
      ignoreModelsDevCapabilities: model.ignoreModelsDevCapabilities,
    })) continue;
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
    ...(anthropicAuthMode ? { anthropicAuthMode } : {}),
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
