// src/types.ts

import type { FreeStatus } from './free-models.js';

export type ModelFormat = 'anthropic' | 'openai' | 'unsupported';

export type StarterCommand = 'root' | 'claude' | 'server' | 'models' | 'providers' | 'patch';

export interface BackendConfig {
  id: 'zen' | 'go';
  name: string;
  baseUrl: string;
}

export interface ModelCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  isFree: boolean;
  freeStatus?: FreeStatus;
  brand: string;
  sourceBackend: 'zen' | 'go';
  modelFormat: ModelFormat;
  cost?: ModelCost;
  contextWindow?: number;
  /** Broad model metadata: model can produce reasoning/thinking output. */
  reasoning?: boolean;
  /** Streaming/interleaved reasoning field name from metadata, e.g. reasoning_content. */
  interleavedReasoningField?: string;
}

export interface LocalProviderModel {
  id: string;
  name: string;
  family: string;
  brand: string;
  modelFormat: 'anthropic' | 'openai';
  /** Wire id sent to the upstream API (OpenCode api.id); may differ from catalog id, e.g. gpt-5.5-fast → gpt-5.5. */
  upstreamModelId: string;
  baseUrl?: string;        // set for anthropic-format models
  completionsUrl?: string; // set for openai-format models
  npm?: string;            // OpenCode api.npm package, e.g. @ai-sdk/xai (SDK routing)
  apiBaseUrl?: string;     // raw api.url, for openai-compatible/openrouter SDK base URL
  cost?: ModelCost;
  contextWindow?: number;
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
  /** OpenCode Zen free-tier models only. */
  isFree?: boolean;
  freeStatus?: FreeStatus;
  modalities?: ('text' | 'image')[];
}

export interface LocalProvider {
  id: string;
  name: string;
  apiKey: string;
  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  providerData?: Record<string, unknown>;
  /** Static headers sent on every upstream request (e.g. a plan/auth-tracking header a custom endpoint requires). */
  headers?: Record<string, string>;
  models: LocalProviderModel[];
}

export interface FavoriteModel {
  providerId: string;
  modelId: string;
}

/** Short model name accepted by Claude HTTP-proxy mode for a saved favorite. */
export interface ModelAlias extends FavoriteModel {
  name: string;
}

export type BridgeMode = 'endpoint' | 'proxy';

export interface UserPreferences {
  lastModel?: string;
  lastProvider?: string;
  recentModelsByProvider?: Record<string, string[]>;
  favoriteModels?: FavoriteModel[];
  modelAliases?: ModelAlias[];
  /** Remembered bridge mode for `clodex claude` (set by --endpoint / --proxy). */
  claudeBridgeMode?: BridgeMode;
  /** Remembered bridge mode for `clodex server` (set by --endpoint / --proxy). */
  serverBridgeMode?: BridgeMode;
  /** Manual binary path overrides (e.g. the claude binary). */
  appPathOverrides?: Record<string, string>;
  recentLaunchFolders?: string[];
  server?: {
    savedPassword?: string;
    /** Provider ids exposed by `clodex server`. */
    exposedProviders?: string[];
    /** Reverse gateway ids for model discovery. */
    maskGatewayIds?: boolean;
    /** Expose only models saved via `clodex models`. */
    favoritesOnly?: boolean;
    /** Saved listen mode for one-step `clodex server --quick` launches. */
    listenMode?: 'local' | 'network';
  };
}

export interface ParsedArgs {
  command: StarterCommand;
  showHelp: boolean;
  showVersion: boolean;
  dryRun: boolean;
  trace: boolean;
  claudeArgs: string[];
  /** clodex boot provider (claude); not passed to child CLI */
  launchProvider?: string;
  /** clodex boot model (claude); not passed to child CLI */
  launchModel?: string;
  /** Explicit bridge mode from --endpoint / --proxy (--http-proxy is an alias of --proxy). */
  bridgeMode?: BridgeMode;
  /** Start `clodex server` from saved/default settings without prompts. */
  serverQuick?: boolean;
  /** One-run listen override for `clodex server`. */
  serverListenMode?: 'local' | 'network';
  /** One-run provider exposure mode for `clodex server`. */
  serverProvidersMode?: 'all' | 'favorites' | 'specific';
  /** One-run provider ids when serverProvidersMode is `specific`. */
  serverProviderIds?: string[];
  /** One-run discovery id masking override. */
  serverMaskGatewayIds?: boolean;
  /** One-run network password for `clodex server`. */
  serverPassword?: string;
  /** One-run TCP port override for `clodex server` (endpoint and proxy modes). */
  serverPort?: number;
  /** Opt-in server request-envelope and WebSocket head diagnostics. */
  serverWsDiagnostics?: boolean;
  /** Print saved proxy-mode model names without opening the favorites manager. */
  favoritesList?: boolean;
  /** Save a short proxy-mode model alias (`name=clodex:provider:model`). */
  favoritesAlias?: string;
  /** Remove a saved short proxy-mode model alias. */
  favoritesUnalias?: string;
  /** clodex patch: restore the pristine Claude Code binary. */
  patchRestore?: boolean;
  error?: string;
}

export interface ConflictInfo {
  name: string;
  value: string;
}
