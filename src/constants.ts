// src/constants.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import type { ModelFormat } from './types.js';

// ChatGPT Codex WebSocket Responses transport. Models flagged prefer_websockets
// require it; clodex also uses it for other OAuth Responses models so
// connection-local previous_response_id continuation remains available.
export const CODEX_RESPONSES_LITE_WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
// `version` header sent on OAuth requests for models flagged useResponsesLite
// (provider-factory.ts), over HTTP or WebSocket; the official Codex CLI sends
// its own version here. A version the backend considers too old is refused with
// "The '<model>' model requires a newer version of Codex" or "The '<model>'
// model is not supported when using Codex with a ChatGPT account" — the latter
// is also the reply for a model the account cannot use. The catalog's
// `minimal_client_version` can understate the real gate: gpt-6.1-sol reports
// 0.153.0 but was refused through 0.158.0 and accepted at 0.159.0 on a Plus
// account (2026-09-29, #298). The catalog endpoint's own client_version filter
// matched that gate where measured (omitted at 0.156.0 and 0.158.0, listed at
// 0.159.0), so a refresh also fetches it at this version and records each model it
// withholds; codex-client-version.ts hides a Responses-Lite model whose minimum
// exceeds this pin or that was withheld at a version this pin does not exceed. Keep
// this at or above every catalog minimum among use_responses_lite models and every
// version measured as required.
export const CODEX_RESPONSES_LITE_VERSION = '0.159.0';
// OpenAI-Beta opt-in for the WebSocket Responses transport.
export const CODEX_RESPONSES_WEBSOCKETS_BETA = 'responses_websockets=2026-02-06';

/**
 * Ceiling for every credential/catalog probe a provider add performs. Kept in
 * one place so a newly added probe cannot quietly become the only unbounded
 * call on that path: these run under a spinner, and an upstream that accepts
 * and then stalls (captive portal, egress filter, a proxy that never answers)
 * otherwise hangs the CLI with no way out but Ctrl-C.
 */
export const TEST_TIMEOUT_MS = 10_000;

// These must be removed from the child process environment to avoid conflicts
// with Vertex AI, Bedrock, AWS, Foundry, and any stale Anthropic config.
export const CONFLICTING_ENV_VARS = [
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLOUD_ML_REGION',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

export type ConflictingEnvVar = (typeof CONFLICTING_ENV_VARS)[number];

// Optional enrichment from OpenCode CLI (~/.cache/opencode/models.json) — not a runtime dependency.
export const OPENCODE_CACHE_PATH = join(homedir(), '.cache', 'opencode', 'models.json');

/** Max models in favorites list and mid-session /model switch catalog. */
export const MAX_MODEL_CATALOG = 20;

/** Default TCP port for `clodex server` (endpoint and proxy modes). Override with --port. */
export const DEFAULT_SERVER_PORT = 17645;

/** Vercel AI SDK package for Anthropic Claude models on Google Vertex AI (ADC auth). */
export const VERTEX_ANTHROPIC_NPM = '@ai-sdk/google-vertex/anthropic';

// Classify a model's API format based on cache provider data or ID heuristics.
// Used to decide whether to route directly or through the translation proxy.
export function classifyModelFormat(
  modelId: string,
  providerNpm: string | undefined,
): ModelFormat {
  if (providerNpm === '@ai-sdk/anthropic') return 'anthropic';
  if (providerNpm === '@ai-sdk/openai') return 'unsupported';
  if (providerNpm === '@ai-sdk/google') return 'unsupported';

  // Fallback: ID-prefix heuristics for models not in cache
  const lower = modelId.toLowerCase();
  if (lower.startsWith('claude-')) return 'anthropic';
  if (lower.startsWith('gpt-')) return 'unsupported';
  if (lower.startsWith('gemini-')) return 'unsupported';

  return 'openai';
}

export const VERSION = pkg.version;
