// src/registry/types.ts — native provider registry schema (no secrets)

import type { FreeStatus } from '../free-models.js';
import type { ModelRuntimeCompatibility } from '../model-runtime-compatibility.js';

export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Written whenever any provider carries named OAuth account slots. Builds
 * >= 1.3.0 fail closed on an unknown schema version in every MUTATING path
 * (parseRegistryStrict throws), so those builds cannot load a slot-bearing
 * registry, drop the unknown field, and save the providers back slot-less.
 * Releases 0.1.0-1.2.2 have no strict loader and silently strip slot state;
 * the credentials remain recoverable in the credential store. A registry
 * whose last slot is removed is written back at version 1, so older builds
 * interoperate again the moment no slot state exists.
 */
export const REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_SLOTS = 2;

/**
 * Written whenever any provider carries `activeAuthAccount`.
 *
 * A DISTINCT version, not a reuse of the slot version: a build from before the
 * stored selector existed accepts version 2, parses the slots, silently
 * ignores the unknown `activeAuthAccount`, and saves the registry back without
 * it. Version 3 stops that, because its strict loader throws on a version it
 * does not know. A registry whose selector is cleared falls back to 2 (or 1),
 * so older builds interoperate again as soon as no selector state exists.
 *
 * Versions 3 and 4 are also migration sources for downgrade-safe selection
 * storage. They still carry the provider default in `authRef`; current builds
 * project the selected slot into that field and park the default separately
 * before writing version 5.
 */
export const REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT = 3;

/**
 * Written when a named OAuth slot carries its own model-entitlement cache.
 * A cache is not a credential, but silently dropping it would make a temporary
 * account reuse the persisted account's catalog. Version 4 therefore fences
 * older mutating builds that know about slots but not their cache isolation.
 */
export const REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES = 4;

/**
 * Written whenever `defaultAuthRef` parks a provider's own OAuth credential
 * while `authRef` points at the selected named slot. A pre-selector build's
 * lenient loader ignores both the version and the new fields, but already
 * reads `authRef`, so it launches as the selected identity. Its strict
 * mutation paths reject version 5 and cannot discard the parked default.
 */
export const REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT = 5;

/**
 * Shape rule for a named OAuth account-slot name — the single home. Slot
 * names land in credential-store scopes and env values, and the registry
 * parser must accept exactly what `validateOAuthAccountName` admits, or a
 * saved slot fails to survive a load.
 */
export const OAUTH_ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type RegistrySubscriptionFilter = 'free';

export interface CachedModel {
  id: string;
  name: string;
  upstreamModelId: string;
  family?: string;
  brand?: string;
  contextWindow?: number;
  /** Highest input window the model accepts, reachable via the `max` context stop. */
  maxContextWindow?: number;
  /** Share of the raw window a client fills; mirrors the Codex catalog field. */
  effectiveContextPercent?: number;
  /** Input size above which the provider bills the whole request at a higher rate. */
  pricingBoundary?: number;
  /** How the provider prices above the boundary, for the user-facing warning. */
  pricingBoundaryNote?: string;
  /** Largest output the model accepts, independent of the input window. */
  maxOutputTokens?: number;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  isFree?: boolean;
  freeStatus?: FreeStatus;
  modelFormat: 'anthropic' | 'openai' | 'cloud-code';
  /** Per-model override — wins over provider-level api.npm */
  npm?: string;
  /** Per-model override — wins over provider-level api.url */
  apiUrl?: string;
  sourceBackend?: string;
  /** Provider-reported request parameters, e.g. OpenRouter supported_parameters. */
  supportedParameters?: string[];
  /** Broad model metadata: model can produce reasoning/thinking output. */
  reasoning?: boolean;
  /** Streaming/interleaved reasoning field name from metadata, e.g. reasoning_content. */
  interleavedReasoningField?: string;
  /** Backend capability: model requires the Responses-Lite request shape (x-openai-internal-codex-responses-lite). */
  useResponsesLite?: boolean;
  /** Backend capability: model must use the WebSocket Responses transport instead of HTTP. */
  preferWebSockets?: boolean;
  /** Supported input modalities preserved from curated provider metadata. */
  modalities?: ('text' | 'image')[];
  /** Provider-neutral per-model wire quirks. */
  compatibility?: ModelRuntimeCompatibility;
}

export interface RegistryModelsCache {
  fetchedAt: string;
  models: CachedModel[];
}

export interface RegistryOAuthAccount {
  authRef: string;
  addedAt: string;
  /** Catalog discovered with this named slot's credential. */
  modelsCache?: RegistryModelsCache;
}

export interface RegistryProvider {
  id: string;
  templateId: string;
  name: string;
  enabled: boolean;
  authRef: string;
  /**
   * The provider's own OAuth credential while a named slot is selected.
   * During that time `authRef` deliberately points at the selected slot so a
   * downgraded pre-selector build launches as the same identity. Clearing the
   * selection restores this value to `authRef` and removes the field.
   */
  defaultAuthRef?: string;
  /** Catalog discovered with the provider default while a named slot is selected. */
  defaultModelsCache?: RegistryModelsCache;
  authType?: 'api' | 'oauth' | 'none';
  /**
   * Named OAuth account slots beyond the default credential
   * (`clodex providers auth openai --account <name>`). Each slot owns a
   * disjoint credential-store lineage; CLODEX_OAUTH_ACCOUNT selects one for a
   * launch without replacing the provider-owned default credential.
   */
  authAccounts?: Record<string, RegistryOAuthAccount>;
  /**
   * The `authAccounts` slot every launch uses, so the running identity does not
   * depend on remembering an environment variable. Absent means the provider's
   * own default credential. CLODEX_OAUTH_ACCOUNT still overrides it for a
   * single run. While present on an OAuth provider, persisted `authRef` is the
   * selected slot and `defaultAuthRef` parks the provider default for rollback.
   *
   * Legacy v3/v4 bytes enforce only the name shape so a missing slot remains
   * loadable and repairable; applying it still fails loud. V5 additionally
   * requires membership and exact authRef/cache projection, because a missing
   * materialized slot is corruption rather than a legacy repair state.
   */
  activeAuthAccount?: string;
  subscriptionFilter?: RegistrySubscriptionFilter;
  /** Keep provider/curated costs instead of replacing them with the global pricing cache. */
  preserveModelPricing?: boolean;
  api: {
    npm?: string;
    url?: string;
    id?: string;
    /** Static headers sent on every upstream request (e.g. a plan/auth-tracking header a custom endpoint requires). */
    headers?: Record<string, string>;
  };
  modelsCache?: RegistryModelsCache;
  addedAt: string;
  refreshedAt?: string;
}

export interface ProviderRegistry {
  schemaVersion: number;
  providers: RegistryProvider[];
  importedAt?: string;
  pricingCacheAt?: string;
}
