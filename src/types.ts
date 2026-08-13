// src/types.ts

import type { FreeStatus } from './free-models.js';
import type { EffortProfile, UnsupportedEffortPolicy } from './effort-policy.js';
import type { ModelRuntimeCompatibility } from './model-runtime-compatibility.js';

export type ModelFormat = 'anthropic' | 'openai' | 'unsupported';

export type StarterCommand = 'root' | 'claude' | 'server' | 'models' | 'providers' | 'patch';

export interface ModelCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
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
  /** Runtime-only: resolver-pinned identity skips models.dev capability fallback/veto. */
  ignoreModelsDevCapabilities?: boolean;
  /** Backend capability: model requires the Responses-Lite request shape (x-openai-internal-codex-responses-lite). */
  useResponsesLite?: boolean;
  /** Backend capability: model must use the WebSocket Responses transport instead of HTTP. */
  preferWebSockets?: boolean;
  /** OpenCode Zen free-tier models only. */
  isFree?: boolean;
  freeStatus?: FreeStatus;
  modalities?: ('text' | 'image')[];
  /** Provider-neutral per-model wire quirks. */
  compatibility?: ModelRuntimeCompatibility;
  /**
   * Runtime-only: the reviewed effort levels this model can actually run.
   * Attached from the generated authority after retained-identity projection,
   * never read from or written to a persisted model cache.
   */
  effortProfile?: EffortProfile;
}

export interface LocalProvider {
  id: string;
  name: string;
  apiKey: string;
  authRef?: string;
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
  /** Explicit opt-in to execute ~/.clodex/local-patches.mjs during patch runs. */
  localPatchesEnabled?: boolean;
  /** Global behavior for an explicit effort the target model does not support. */
  effortPolicy?: UnsupportedEffortPolicy;
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
  /** --fast (claude): Codex fast mode — sets CLODEX_SERVICE_TIER=fast for this launch. */
  fast?: boolean;
  /** Explicit bridge mode from --endpoint / --proxy — applies to this run only. */
  bridgeMode?: BridgeMode;
  /** --save-mode: persist the explicit bridge mode as this command's default. */
  saveBridgeMode?: boolean;
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
  /** Skip registering this `clodex server` in ~/.clodex/server-runtime.json discovery. */
  serverNoDiscovery?: boolean;
  /** Print saved proxy-mode model names without opening the favorites manager. */
  favoritesList?: boolean;
  /** Save a short proxy-mode model alias (`name=clodex:provider:model`). */
  favoritesAlias?: string;
  /** Remove a saved short proxy-mode model alias. */
  favoritesUnalias?: string;
  /** Persist the global behavior for an unsupported explicit effort. */
  effortPolicy?: UnsupportedEffortPolicy;
  /** clodex patch: restore the pristine Claude Code binary. */
  patchRestore?: boolean;
  /** clodex patch: persistently enable or disable local patch execution. */
  patchLocalPatches?: boolean;
  error?: string;
}

export interface ConflictInfo {
  name: string;
  value: string;
}
