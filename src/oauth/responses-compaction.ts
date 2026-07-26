import { createHash } from 'node:crypto';

type JsonObject = Record<string, unknown>;

const ENABLED_VALUES = new Set(['1', 'true', 'on', 'enabled']);
const COMPACT_BODY_FIELDS = [
  'model',
  'input',
  'instructions',
  'tools',
  'parallel_tool_calls',
  'reasoning',
  'service_tier',
  'prompt_cache_key',
  'text',
] as const;

export const OPENAI_COMPACTION_DEFAULT_RATIO = 0.9;
// Compaction runs before the downstream SSE response exists. Keep its budget
// comfortably below Claude Code's 120s no-data watchdog so expiry can fall back
// to the normal request path instead of surfacing as a downstream idle timeout.
export const RESPONSES_COMPACT_TIMEOUT_MS = 60_000;

export interface ResponsesCompactionUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface ResponsesCompactionResult {
  output: unknown[];
  usage?: ResponsesCompactionUsage;
}

export interface CompactResponsesWindowOptions {
  requestUrl: string | URL | Request;
  headers: HeadersInit | undefined;
  payload: JsonObject;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ResponsesCompactionError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ResponsesCompactionError';
    this.statusCode = statusCode;
  }
}

/**
 * Resolve the native-compaction threshold. The default mirrors Codex:
 * compact at 90% of the model's advertised context window.
 *
 * Native compaction is experimental and off by default. Set
 * CLODEX_OPENAI_COMPACTION=1 to opt in.
 */
export function resolveOpenAiCompactionThreshold(
  contextWindow: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const configured = env.CLODEX_OPENAI_COMPACTION?.trim().toLowerCase();
  if (!configured || !ENABLED_VALUES.has(configured)) return undefined;

  const explicit = env.CLODEX_OPENAI_COMPACT_THRESHOLD?.trim();
  if (explicit) {
    const parsed = Number(explicit);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }

  if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return undefined;
  return Math.floor(contextWindow! * OPENAI_COMPACTION_DEFAULT_RATIO);
}

export function responsesCompactUrl(input: string | URL | Request): string {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw);
  const normalized = url.pathname.replace(/\/+$/, '');
  url.pathname = normalized.endsWith('/responses/compact')
    ? normalized
    : normalized.endsWith('/responses')
      ? `${normalized}/compact`
      : `${normalized}/responses/compact`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Match the request shape used by Codex's own standalone compact client. */
export function compactRequestPayload(payload: JsonObject): JsonObject {
  const compact: JsonObject = {};
  for (const key of COMPACT_BODY_FIELDS) {
    if (payload[key] !== undefined) compact[key] = payload[key];
  }
  return compact;
}

function compactHeaders(input: HeadersInit | undefined): Headers {
  const headers = new Headers(input);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');
  headers.delete('content-length');

  // The HTTP compact call is not a Responses WebSocket upgrade. Preserve other
  // beta feature values if they coexist with the WebSocket transport marker.
  const beta = headers.get('OpenAI-Beta');
  if (beta) {
    const retained = beta.split(',')
      .map(value => value.trim())
      .filter(value => value && !value.startsWith('responses_websockets='));
    if (retained.length) headers.set('OpenAI-Beta', retained.join(', '));
    else headers.delete('OpenAI-Beta');
  }
  return headers;
}

function usageFromResponse(value: unknown): ResponsesCompactionUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as JsonObject;
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as JsonObject
    : {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    cachedTokens: typeof details.cached_tokens === 'number' ? details.cached_tokens : 0,
    cacheWriteTokens: typeof details.cache_write_tokens === 'number' ? details.cache_write_tokens : 0,
    outputTokens: outputTokens ?? 0,
  };
}

function responseErrorFingerprint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as JsonObject;
  const error = record.error && typeof record.error === 'object'
    ? record.error as JsonObject
    : record;
  const message = typeof error.message === 'string' ? error.message : undefined;
  return message
    ? createHash('sha256').update(message).digest('hex').slice(0, 16)
    : undefined;
}

/**
 * Call the stateless `/responses/compact` endpoint. The returned output is
 * canonical and must be forwarded as-is to the next Responses create call.
 */
export async function compactResponsesWindow(
  options: CompactResponsesWindowOptions,
): Promise<ResponsesCompactionResult> {
  const requestFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? RESPONSES_COMPACT_TIMEOUT_MS;
  const controller = new AbortController();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`OpenAI compaction exceeded ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );

  try {
    const response = await requestFetch(responsesCompactUrl(options.requestUrl), {
      method: 'POST',
      headers: compactHeaders(options.headers),
      body: JSON.stringify(compactRequestPayload(options.payload)),
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ResponsesCompactionError(
        `OpenAI compact endpoint returned invalid JSON (HTTP ${response.status})`,
        response.status,
      );
    }
    if (!response.ok) {
      const fingerprint = responseErrorFingerprint(body);
      throw new ResponsesCompactionError(
        `OpenAI compact endpoint failed (HTTP ${response.status}`
          + `${fingerprint ? `, error ${fingerprint}` : ''})`,
        response.status,
      );
    }
    if (!body || typeof body !== 'object' || !Array.isArray((body as JsonObject).output)) {
      throw new ResponsesCompactionError('OpenAI compact endpoint omitted its canonical output');
    }
    return {
      output: (body as JsonObject).output as unknown[],
      usage: usageFromResponse((body as JsonObject).usage),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
