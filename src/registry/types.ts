// src/registry/types.ts — native provider registry schema (no secrets)

import type { FreeStatus } from '../free-models.js';
import type { ModelRuntimeCompatibility } from '../model-runtime-compatibility.js';

export const REGISTRY_SCHEMA_VERSION = 1;

export type RegistrySubscriptionFilter = 'free';

export interface CachedModel {
  id: string;
  name: string;
  upstreamModelId: string;
  family?: string;
  brand?: string;
  contextWindow?: number;
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

export interface RegistryProvider {
  id: string;
  templateId: string;
  name: string;
  enabled: boolean;
  authRef: string;
  authType?: 'api' | 'oauth' | 'none';
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
  modelsCache?: {
    fetchedAt: string;
    models: CachedModel[];
  };
  addedAt: string;
  refreshedAt?: string;
}

export interface ProviderRegistry {
  schemaVersion: number;
  providers: RegistryProvider[];
  importedAt?: string;
  pricingCacheAt?: string;
}
