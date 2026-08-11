import models from './opencode-go-models.json';
import snapshot from './opencode-go-cli-snapshot.json';
import type { CachedModel, RegistryProvider } from '../registry/types.js';

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_PROVIDER_NAME = 'OpenCode Go';

function resolvedApiUrl(npm: string): string {
  const urls = new Set(snapshot.models
    .filter(model => model.api.npm === npm)
    .map(model => model.api.url.replace(/\/+$/, '')));
  if (urls.size !== 1) {
    throw new Error(`OpenCode Go snapshot must resolve one ${npm} API URL`);
  }
  return [...urls][0]!;
}

export const OPENCODE_GO_COMPLETIONS_BASE_URL = resolvedApiUrl('@ai-sdk/openai-compatible');
export const OPENCODE_GO_ANTHROPIC_BASE_URL = resolvedApiUrl('@ai-sdk/anthropic')
  .replace(/\/v1$/, '');
export const OPENCODE_GO_SOURCE = snapshot._meta.sourceCommand;
export const OPENCODE_GO_SOURCE_FETCHED_AT = snapshot._meta.capturedAt;
export const OPENCODE_GO_SOURCE_VERSION = snapshot._meta.openCodeVersion;
export const OPENCODE_GO_SOURCE_RELEASE_COMMIT = snapshot._meta.releaseCommit;
export const OPENCODE_GO_SOURCE_ASSET_SHA256 = snapshot._meta.releaseAssetSha256;
export const OPENCODE_GO_SOURCE_MODELS_SHA256 = snapshot._meta.normalizedModelsSha256;
export const OPENCODE_GO_RESPONSES_MODEL_IDS = snapshot.models
  .filter(model => model.api.npm === '@ai-sdk/openai')
  .map(model => model.id);

type OpenCodeGoModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

/**
 * Curated OpenCode Go models supported by Clodex.
 *
 * Metadata, model membership, SDK transport, and variant declarations come
 * from the committed output of OpenCode's model resolver. The updater derives
 * Messages vs Chat Completions from the resolved AI SDK package. Responses
 * entries remain in the source snapshot for provenance but never enter this
 * runtime allowlist.
 */
export function buildOpenCodeGoModels(): OpenCodeGoModel[] {
  return structuredClone(models) as unknown as OpenCodeGoModel[];
}

type ProviderIdentity = Pick<RegistryProvider, 'id' | 'templateId' | 'api'>
  & Partial<Pick<RegistryProvider, 'modelsCache'>>;

function normalizedApiUrl(url: string | undefined): string | undefined {
  const normalized = url?.trim().replace(/\/+$/, '');
  return normalized || undefined;
}

function isExactOfficialOpenCodeGoApiUrl(url: string | undefined): boolean {
  const trimmed = url?.trim();
  return trimmed === OPENCODE_GO_COMPLETIONS_BASE_URL
    || trimmed === OPENCODE_GO_ANTHROPIC_BASE_URL;
}

/**
 * Deny-boundary check for URLs that target an official OpenCode Go service.
 *
 * This is deliberately broader than positive identity/provenance trust. URL
 * parsing normalizes host case and trailing dots. Once the target host is the
 * official third-party domain, credentials, paths, query strings, fragments,
 * alternate schemes, and ports cannot make a partial provider identity safe.
 * A genuinely custom endpoint must use its own domain.
 */
export function isOfficialOpenCodeGoApiUrl(url: string | undefined): boolean {
  const raw = url?.trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    return hostname === 'opencode.ai';
  } catch {
    return false;
  }
}

function hasOfficialOpenCodeGoProvenance(model: CachedModel): boolean {
  // Capability authority says who owns capability truth, not where the row
  // originated. Only an exact resolver-emitted API URL proves official origin.
  return isExactOfficialOpenCodeGoApiUrl(model.apiUrl);
}

function isCanonicalOpenCodeGoIdentity(provider: ProviderIdentity): boolean {
  return provider.id === OPENCODE_GO_PROVIDER_ID
    && provider.templateId === OPENCODE_GO_PROVIDER_ID;
}

export function crossesOpenCodeGoIdentityBoundary(provider: ProviderIdentity): boolean {
  return provider.id === OPENCODE_GO_PROVIDER_ID
    || provider.templateId === OPENCODE_GO_PROVIDER_ID;
}

export function isOfficialBuiltInOpenCodeGoProvider(
  provider: ProviderIdentity,
  cachedModels = provider.modelsCache?.models ?? [],
): boolean {
  if (!isCanonicalOpenCodeGoIdentity(provider)) return false;
  const configuredUrl = normalizedApiUrl(provider.api.url);
  if (configuredUrl) return configuredUrl === OPENCODE_GO_COMPLETIONS_BASE_URL;

  // A missing provider URL needs positive official provenance. Otherwise a
  // neutral legacy/custom row would be mistaken for the built-in identity and
  // gain an opencode.ai route solely because the URL disappeared. Generated
  // official rows carry an exact resolver-emitted per-model URL. The generic
  // resolver-authority bit is not origin proof, so retain only a non-empty
  // cache where every row names that exact official URL.
  return cachedModels.length > 0
    && cachedModels.every(hasOfficialOpenCodeGoProvenance);
}

/** Boundary states that must expose no model, route, refresh, or patch target. */
export function isFailClosedOpenCodeGoBoundaryProvider(provider: ProviderIdentity): boolean {
  if (
    !crossesOpenCodeGoIdentityBoundary(provider)
    || isOfficialBuiltInOpenCodeGoProvider(provider)
  ) return false;
  const configuredUrl = normalizedApiUrl(provider.api.url);
  return !configuredUrl || isOfficialOpenCodeGoApiUrl(configuredUrl);
}

/** A custom built-in-id entry must not inherit OpenCode's models.dev identity. */
export function ignoresModelsDevForOpenCodeGoProvider(provider: ProviderIdentity): boolean {
  return crossesOpenCodeGoIdentityBoundary(provider)
    && !isOfficialBuiltInOpenCodeGoProvider(provider);
}

function projectCustomOpenCodeGoCache(
  provider: ProviderIdentity,
  cachedModels: CachedModel[],
): CachedModel[] {
  if (
    !crossesOpenCodeGoIdentityBoundary(provider)
    || isOfficialBuiltInOpenCodeGoProvider(provider, cachedModels)
  ) {
    return cachedModels;
  }
  const providerNpm = provider.api.npm?.trim() || undefined;
  const apiUrl = normalizedApiUrl(provider.api.url);
  if (!apiUrl || isOfficialOpenCodeGoApiUrl(apiUrl)) {
    // Without positive official provenance, there is no provider-level route
    // to make authoritative. An incomplete/mismatched identity may not send a
    // credential to an official OpenCode URL even when that URL is explicit;
    // the canonical id+template pair is required for that trust decision.
    // Retaining neutral or custom-routed rows could otherwise guess a route or
    // send a credential to a stale endpoint, so fail closed.
    return [];
  }
  return cachedModels.flatMap(cached => {
    if (isOfficialOpenCodeGoApiUrl(cached.apiUrl)) {
      // This row came from the official bundled overlay. Once the provider
      // changes identity, even its display/context/cost fields are unsafe to
      // reuse: a wrong context window can delay compaction until the custom
      // backend rejects the prompt. Fail closed until custom discovery wins.
      return [];
    }
    if (
      !providerNpm
      && (
        !cached.npm?.trim()
        || (cached.modelFormat !== 'anthropic' && cached.modelFormat !== 'openai')
      )
    ) {
      // A custom URL alone does not identify a wire protocol. Preserve a
      // neutral row's explicit transport when it has one, but never guess a
      // missing npm package from the built-in template identity.
      return [];
    }
    // Neutral rows came from the custom endpoint itself. Preserve its metadata
    // while making the provider-level route authoritative, so a stale per-row
    // URL can never receive the custom credential.
    return [{
      ...cached,
      ...(providerNpm
        ? {
            npm: providerNpm,
            modelFormat: providerNpm === '@ai-sdk/anthropic' ? 'anthropic' : 'openai',
          }
        : {}),
      apiUrl,
    }];
  });
}

/**
 * Exact cached targets suppressed after an OpenCode provider changes identity.
 * The patcher uses this to reject only quarantined favorites; neutral custom
 * rows and no-cache custom favorites remain patchable.
 */
export function quarantinedOpenCodeGoModelTargets(
  provider: RegistryProvider,
): Set<string> {
  if (!ignoresModelsDevForOpenCodeGoProvider(provider)) return new Set();
  const cachedModels = provider.modelsCache?.models ?? [];
  const configuredUrl = normalizedApiUrl(provider.api.url);
  const quarantined = !configuredUrl || isOfficialOpenCodeGoApiUrl(configuredUrl)
    ? cachedModels
    : cachedModels.filter(model => isOfficialOpenCodeGoApiUrl(model.apiUrl));
  return new Set(quarantined.map(model => `${provider.id}:${model.id}`));
}

/**
 * Correct a persisted built-in OpenCode Go cache with the bundled catalog.
 *
 * Existing installs keep model metadata in providers.json, so changing the
 * generated catalog alone would leave old transport and variant decisions in
 * both runtime materialization and the patcher until the next network refresh.
 * This pure overlay makes the current bundled allowlist authoritative while
 * retaining live availability: it updates rows that were discovered and drops
 * cached Responses/unknown rows. It is deliberately gated to the built-in id,
 * template, and official URL so a custom endpoint is never rewritten.
 */
export function overlayBuiltInOpenCodeGoCache(
  provider: ProviderIdentity,
  cachedModels: CachedModel[],
): CachedModel[] {
  if (!isOfficialBuiltInOpenCodeGoProvider(provider, cachedModels)) return cachedModels;
  const bundled = new Map(buildOpenCodeGoModels().map(model => [model.id, model]));
  const seen = new Set<string>();
  return cachedModels.flatMap(cached => {
    if (seen.has(cached.id)) return [];
    seen.add(cached.id);
    const overlay = bundled.get(cached.id);
    if (!overlay) return [];
    // The endpoint contributes membership/order only. Starting from the
    // committed row (rather than spreading the cache) also removes stale
    // optional fields when the resolver explicitly stops declaring them.
    return [structuredClone(overlay) as CachedModel];
  });
}

/** One authoritative view for every consumer of persisted provider membership. */
export function effectiveProviderCachedModels(
  provider: RegistryProvider,
): CachedModel[] {
  const cachedModels = provider.modelsCache?.models ?? [];
  if (isOfficialBuiltInOpenCodeGoProvider(provider)) {
    return overlayBuiltInOpenCodeGoCache(provider, cachedModels);
  }
  return projectCustomOpenCodeGoCache(provider, cachedModels);
}
