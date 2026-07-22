import { resolveProviderCredential } from './env.js';
import type { CompatibilityAgent } from './model-compatibility.js';
import { oauthAuthRef } from './registry/import-build.js';
import { loadRegistry } from './registry/io.js';
import { loadRegistryProviders } from './registry/load.js';
import { isAnonymousProvider } from './registry/materialize.js';
import { getTemplateById } from './provider-templates.js';
import type { LocalProvider } from './types.js';
import type { ServerModelInfo } from './server/models.js';

export async function fetchProviderCatalog(
  opts?: { agent?: CompatibilityAgent },
): Promise<LocalProvider[]> {
  return loadRegistryProviders(undefined, opts);
}

export function providersForPicker(providers: LocalProvider[]): LocalProvider[] {
  for (const p of providers) {
    p.models.sort((a, b) => {
      const nameA = a.name || a.id;
      const nameB = b.name || b.id;
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    });
  }

  return providers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Resolve API key when provider.apiKey is empty (registry authRef or OAuth credential store). */
export async function resolveLocalProviderApiKey(provider: LocalProvider): Promise<string | null> {
  if (provider.authRef === 'none:anonymous' || provider.authType === 'none') return '';

  const direct = provider.apiKey?.trim();
  if (direct) return direct;

  const template = getTemplateById(provider.id);
  if (template?.apiKeyOptional || template?.anonymousFreeModels) {
    return '';
  }

  const reg = loadRegistry().providers.find(p => p.id === provider.id);
  const authRef = provider.authRef ?? reg?.authRef ?? oauthAuthRef(provider.id);
  return resolveProviderCredential(provider.id, authRef);
}

/** Human-readable auth line for `providers list` and provider detail. */
export function formatRegistryAuthLabel(
  provider: Pick<import('./registry/types.js').RegistryProvider, 'authRef' | 'authType'>,
): string {
  if (provider.authType === 'oauth' || provider.authRef.includes('oauth:provider:')) {
    return provider.authRef.startsWith('helper:') ? 'helper (OAuth)' : 'keychain (OAuth)';
  }
  if (isAnonymousProvider(provider)) return 'anonymous';
  if (provider.authType === 'none') {
    return 'gcloud / manual credentials';
  }
  if (provider.authRef.startsWith('keyring:')) {
    return 'keychain (API key)';
  }
  if (provider.authRef.startsWith('helper:')) {
    return 'helper (API key)';
  }
  if (provider.authRef.startsWith('env:')) {
    return provider.authRef;
  }
  return provider.authRef;
}

/** Row for providers list / hub. */
export interface ProviderDisplayEntry {
  id: string;
  name: string;
  modelCount: number;
  enabled: boolean;
  authLabel: string;
  inRegistry: boolean;
}

export async function resolveProvidersForDisplay(): Promise<ProviderDisplayEntry[]> {
  const reg = loadRegistry();
  const entries: ProviderDisplayEntry[] = [];

  for (const provider of reg.providers) {
    entries.push({
      id: provider.id,
      name: provider.name,
      modelCount: provider.modelsCache?.models.length ?? 0,
      enabled: provider.enabled,
      authLabel: formatRegistryAuthLabel(provider),
      inRegistry: true,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function localProvidersToServerModels(localProviders: LocalProvider[]): ServerModelInfo[] {
  return localProviders.flatMap(provider =>
    provider.models.map(model => ({
      id: model.id,
      name: model.name,
      isFree: model.isFree ?? false,
      freeStatus: model.freeStatus,
      brand: model.brand,
      providerLabel: provider.name,
      providerId: provider.id,
      sourceBackend: provider.id,
      modelFormat: model.modelFormat,
      upstreamModelId: model.upstreamModelId,
      cost: model.cost,
      baseUrl: model.baseUrl,
      completionsUrl: model.completionsUrl,
      npm: model.modelFormat === 'openai' ? (model.npm || '@ai-sdk/openai-compatible') : model.npm,
      apiBaseUrl: model.apiBaseUrl,
      apiKey: provider.apiKey,
      authType: provider.authType,
      oauthAccountId: provider.oauthAccountId,
      contextWindow: model.contextWindow,
      supportedParameters: model.supportedParameters,
      reasoning: model.reasoning,
      interleavedReasoningField: model.interleavedReasoningField,
      useResponsesLite: model.useResponsesLite,
      preferWebSockets: model.preferWebSockets,
      headers: provider.headers,
      providerData: provider.providerData,
    }))
  );
}
