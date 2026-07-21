// src/server/models.ts
import { resolveContextWindow } from '../context-window.js';
import { aliasModelId } from '../proxy.js';
import { httpProxyModelId } from '../http-proxy/routes.js';
import { maskGatewayModelId } from './vendor-mask.js';
import type { FreeStatus } from '../free-models.js';
import type { ModelAlias } from '../types.js';

export interface GatewayModelOptions {
  maskGatewayIds?: boolean;
}

export type ServerModelFormat = 'anthropic' | 'openai' | 'cloud-code' | 'unsupported';
export type ServerModelSource = string;

export interface ServerModelInfo {
  id: string;
  name: string;
  isFree: boolean;
  freeStatus?: FreeStatus;
  brand: string;
  sourceBackend: ServerModelSource;
  modelFormat: ServerModelFormat;
  /** Wire id sent to the upstream API; may differ from catalog id. */
  upstreamModelId?: string;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  baseUrl?: string;        // anthropic-format: direct Anthropic-protocol URL (without /v1)
  completionsUrl?: string; // openai-format: full chat completions endpoint URL
  npm?: string;            // OpenCode api.npm — openai-format models route through the SDK adapter
  apiBaseUrl?: string;     // base URL for openai-compatible / openrouter SDK providers
  apiKey?: string;         // model-specific API key; overrides server-level apiKey if set; never returned in API responses
  /** Exact registry credential reference used for OAuth retry; never returned in API responses. */
  authRef?: string;
  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  supportedParameters?: string[];
  reasoning?: boolean;
  interleavedReasoningField?: string;
  /** Backend capability: model requires the Responses-Lite request shape (x-openai-internal-codex-responses-lite). */
  useResponsesLite?: boolean;
  /** Backend capability: model must use the WebSocket Responses transport instead of HTTP. */
  preferWebSockets?: boolean;
  /** Fallback reasoning effort when the client omits output_config.effort. */
  defaultEffort?: string;
  contextWindow?: number;
  /** Picker label for gateway aliases, e.g. "OpenCode Go" or local provider name. */
  providerLabel?: string;
  /** Provider id for filtering. */
  providerId?: string;
  /** Static headers sent on every upstream request (e.g. a plan/auth-tracking header a custom endpoint requires). */
  headers?: Record<string, string>;
  /** OAuth provider identity data (e.g. Claude Code's cliUserID/accountUUID) needed to fingerprint requests. */
  providerData?: Record<string, unknown>;
}

export interface ModelCatalog {
  get: (id: string) => ServerModelInfo | undefined;
  list: () => ServerModelInfo[];
}

const CREATED_AT_ISO = '2025-01-01T00:00:00Z';
const CREATED_AT_UNIX = 1735689600;

export function formatAnthropicModelEntry(
  id: string,
  displayName: string,
  contextWindow?: number,
) {
  const maxInput = resolveContextWindow(id, contextWindow);
  return {
    id,
    type: 'model' as const,
    display_name: displayName,
    created_at: CREATED_AT_ISO,
    context_window: maxInput,
    max_input_tokens: maxInput,
  };
}

export function createModelCatalog(models: ServerModelInfo[]): ModelCatalog {
  const byId = new Map(models.map(model => [model.id, model]));

  return {
    get: (id: string) => byId.get(id),
    list: () => [...models],
  };
}

export interface ModelDisplayEntry {
  id: string;
  name: string;
  contextWindow?: number;
}

export function formatAnthropicModelList(entries: ModelDisplayEntry[]) {
  return {
    data: entries.map(entry => formatAnthropicModelEntry(entry.id, entry.name, entry.contextWindow)),
    has_more: false,
    first_id: entries[0]?.id ?? null,
    last_id: entries.at(-1)?.id ?? null,
  };
}

export function formatAnthropicModels(models: ServerModelInfo[]) {
  return formatAnthropicModelList(
    models.map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow })),
  );
}

export function gatewayProviderLabel(model: ServerModelInfo): string {
  return model.providerLabel ?? model.sourceBackend;
}

/** Stable slug for gateway alias ids — provider id when set, else the source backend id. */
export function gatewayProviderId(model: ServerModelInfo): string {
  return model.providerId ?? model.sourceBackend;
}

/** Gateway-discovery-safe id — Claude clients only surface claude-* and anthropic-* ids. */
export function gatewayAliasId(model: ServerModelInfo): string {
  return aliasModelId(model.id, gatewayProviderId(model));
}

export function exposedGatewayAliasId(model: ServerModelInfo, opts?: GatewayModelOptions): string {
  const alias = gatewayAliasId(model);
  return opts?.maskGatewayIds ? maskGatewayModelId(alias) : alias;
}

/** Readable picker label — discovery ids may be masked; names stay real. */
export function gatewayDisplayName(model: ServerModelInfo, opts?: GatewayModelOptions): string {
  if (!opts?.maskGatewayIds) return model.name;
  return `${model.name} (${gatewayProviderLabel(model)})`;
}

export function formatGatewayAnthropicModels(models: ServerModelInfo[], opts?: GatewayModelOptions) {
  return formatAnthropicModelList(
    models.map(model => ({
      id: exposedGatewayAliasId(model, opts),
      name: gatewayDisplayName(model, opts),
      contextWindow: model.contextWindow,
    })),
  );
}

/**
 * Catalog with alias → model lookup for gateway clients (Claude Desktop, Claude Code).
 *
 * Accepted request-model forms, in precedence order (later forms never
 * override earlier keys):
 *   1. exact catalog id (and its gateway-discovery alias);
 *   2. the unmasked gateway id when --mask-gateway-ids is on;
 *   3. the canonical `clodex:{provider}:{model}` id (same spelling the
 *      proxy-mode MITM routes on);
 *   4. saved short aliases from `clodex models --alias` (same alias table the
 *      proxy resolves) — anything else is a 400.
 * Forms 3-4 are accepted INPUT only: `list()` (and every /models listing built
 * from it) still advertises exactly the canonical/masked ids it always did.
 */
export function createGatewayModelCatalog(
  models: ServerModelInfo[],
  opts?: GatewayModelOptions,
  modelAliases?: ModelAlias[],
): ModelCatalog {
  const byId = new Map<string, ServerModelInfo>();
  for (const model of models) {
    byId.set(model.id, model);
    const alias = exposedGatewayAliasId(model, opts);
    if (alias !== model.id) byId.set(alias, model);
    if (opts?.maskGatewayIds) {
      const rawAlias = gatewayAliasId(model);
      if (rawAlias !== alias) byId.set(rawAlias, model);
    }
  }
  for (const model of models) {
    const canonicalId = httpProxyModelId(gatewayProviderId(model), model.id);
    if (!byId.has(canonicalId)) byId.set(canonicalId, model);
  }
  for (const alias of modelAliases ?? []) {
    if (byId.has(alias.name)) continue;
    const target = models.find(
      model => gatewayProviderId(model) === alias.providerId && model.id === alias.modelId,
    );
    if (target) byId.set(alias.name, target);
  }

  return {
    get: (id: string) => byId.get(id),
    list: () => [...models],
  };
}

/** Model id to send upstream (OpenCode / provider API), not the gateway alias. */
export function upstreamModelId(model: ServerModelInfo): string {
  const id = model.upstreamModelId ?? model.id;
  // Claude Code uses a [1m] suffix for 1M context with third-party APIs; Vertex ids omit it.
  return id.replace(/\[1m\]$/i, '');
}

export interface ModelCatalogRow {
  name: string;
  anthropicId: string;
  openaiId: string;
}

/** Dedupe by (name, anthropicId, openaiId) — same model can appear twice in a provider's raw list. */
export function buildDedupedModelRows(models: ServerModelInfo[], opts?: GatewayModelOptions): ModelCatalogRow[] {
  const seen = new Set<string>();
  const rows: ModelCatalogRow[] = [];
  for (const model of [...models].sort((a, b) => a.name.localeCompare(b.name))) {
    const row: ModelCatalogRow = {
      name: model.name,
      anthropicId: exposedGatewayAliasId(model, opts),
      openaiId: model.id,
    };
    const key = `${row.name}\u0000${row.anthropicId}\u0000${row.openaiId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

export function supportsDirectOpenAIChatCompletions(model: ServerModelInfo): boolean {
  return model.modelFormat === 'openai' && !!model.completionsUrl;
}

export function formatOpenAIModels(models: ServerModelInfo[]) {
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      object: 'model',
      created: CREATED_AT_UNIX,
      owned_by: model.sourceBackend,
    })),
  };
}
