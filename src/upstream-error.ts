// Short user-facing messages from SDK/upstream failures — no stack traces in Codex TUI.

import { APICallError, RetryError } from 'ai';

interface ApiCallLike {
  message?: string;
  statusCode?: number;
  responseBody?: string;
  data?: { error?: { message?: string; type?: string; code?: string } };
  lastError?: { message?: string; statusCode?: number };
  errors?: Array<{ message?: string; statusCode?: number }>;
}

export interface SdkUpstreamErrorDetails {
  statusCode?: number;
  errorContent: string;
  isRetryable: boolean;
  attemptCount: number;
  /** Client backoff hint (seconds); only present on rate-limit (429) failures. */
  retryAfterSeconds?: number;
  transportCode?: 'websocket_transport_error';
}

/** Default downstream backoff hint when the upstream throttle gives none. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;
/**
 * Upper bound for any retry-after hint clodex produces or forwards. Keeps the
 * AI SDK's bounded backoff (default maxRetries=2) and downstream clients well
 * clear of clodex's 120s no-event stream abort.
 */
export const MAX_RETRY_AFTER_SECONDS = 60;

/** Clamp a retry-after hint to [0, 60]s; missing/invalid values become the 5s default. */
export function clampRetryAfterSeconds(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return Math.min(Math.round(value), MAX_RETRY_AFTER_SECONDS);
}

function numericRetryAfterSeconds(inner: InstanceType<typeof APICallError>): number | undefined {
  const data = inner.data as { error?: { retry_after_seconds?: unknown; message?: unknown } } | undefined;
  const fromBody = data?.error?.retry_after_seconds;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const fromHeader = inner.responseHeaders?.['retry-after'];
  if (typeof fromHeader === 'string' && /^\d+$/.test(fromHeader.trim())) return Number(fromHeader.trim());
  // The OAuth WebSocket transport's synthetic error frames can only carry the
  // hint in message text — the AI SDK's chunk schema strips unknown fields.
  for (const message of [data?.error?.message, inner.message]) {
    if (typeof message !== 'string') continue;
    const match = /retry after (\d+)s\b/i.exec(message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function boundedTransportCode(data: unknown): 'websocket_transport_error' | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const error = (data as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  return (error as { code?: unknown }).code === 'websocket_transport_error'
    ? 'websocket_transport_error'
    : undefined;
}

/** Extract the real HTTP failure from an AI SDK retry wrapper without relying on instanceof. */
export function sdkUpstreamErrorDetails(err: unknown): SdkUpstreamErrorDetails | undefined {
  const retry = RetryError.isInstance(err) ? err : undefined;
  const inner = retry?.lastError ?? err;
  if (!APICallError.isInstance(inner)) return undefined;

  let errorContent = inner.responseBody;
  if (!errorContent && inner.data !== undefined) {
    try {
      errorContent = JSON.stringify(inner.data);
    } catch {
      // Fall through to the SDK's safe message.
    }
  }

  const rawRetryAfter = inner.statusCode === 429 ? numericRetryAfterSeconds(inner) : undefined;
  const retryAfterSeconds = rawRetryAfter === undefined
    ? undefined
    : clampRetryAfterSeconds(rawRetryAfter);

  return {
    statusCode: inner.statusCode,
    errorContent: errorContent || inner.message,
    isRetryable: inner.isRetryable,
    attemptCount: retry?.errors.length ?? 1,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    transportCode: boundedTransportCode(inner.data),
  };
}

/** True when an upstream SDK/provider error says the model context was exceeded. */
export function isContextLengthExceededError(err: unknown, formattedMessage = ''): boolean {
  const details = sdkUpstreamErrorDetails(err);
  const rec = err && typeof err === 'object' ? err as ApiCallLike : undefined;
  const candidates = [
    formattedMessage,
    details?.errorContent,
    rec?.message,
    rec?.responseBody,
    rec?.data?.error?.code,
    rec?.data?.error?.type,
    rec?.data?.error?.message,
    rec?.lastError?.message,
    ...(rec?.errors?.map(error => error.message) ?? []),
  ].filter((value): value is string => typeof value === 'string');
  return candidates.some(value => (
    /context_length_exceeded/i.test(value)
    || /context window/i.test(value)
    || /maximum context length/i.test(value)
    || /prompt is too long/i.test(value)
  ));
}

export function formatUpstreamError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Upstream model request failed.';

  const rec = err as ApiCallLike;

  if (rec.data?.error?.message) {
    const short = sanitizeMessage(rec.data.error.message);
    return rec.statusCode ? `${short} (HTTP ${rec.statusCode})` : short;
  }

  if (rec.responseBody) {
    try {
      const parsed = JSON.parse(rec.responseBody) as { error?: { message?: string } };
      if (parsed.error?.message) {
        const short = sanitizeMessage(parsed.error.message);
        return rec.statusCode ? `${short} (HTTP ${rec.statusCode})` : short;
      }
    } catch { /* ignore */ }
  }

  const last = rec.lastError;
  if (last?.message) {
    const code = last.statusCode;
    const short = sanitizeMessage(last.message);
    return code ? `${short} (HTTP ${code})` : short;
  }

  const fromList = rec.errors?.[rec.errors.length - 1];
  if (fromList?.message) {
    const short = sanitizeMessage(fromList.message);
    return fromList.statusCode ? `${short} (HTTP ${fromList.statusCode})` : short;
  }

  if (rec.message) {
    const short = sanitizeMessage(rec.message);
    if (short && !short.includes('file://') && !short.includes('APICallError') && short.length < 240) {
      return rec.statusCode ? `${short} (HTTP ${rec.statusCode})` : short;
    }
  }

  return 'Upstream model request failed.';
}

/** Real upstream HTTP status from an SDK error, falling back to sniffing the formatted message. */
export function upstreamHttpStatus(err: unknown, message: string): number {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (typeof code === 'number' && code >= 400 && code <= 599) return code;
  }
  if (message.includes('HTTP 429') || message.includes('429')) return 429;
  if (message.includes('HTTP 400')) return 400;
  return 500;
}

/** Anthropic SSE error `type` for a status code — lets clients tell retryable from terminal failures. */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 429: return 'rate_limit_error';
    default: return 'api_error';
  }
}

function sanitizeMessage(message: string): string {
  const line = message.split('\n')[0]?.trim() ?? message;
  if (line.startsWith('RetryError') || line.includes('AI_RetryError')) {
    return 'Upstream model request failed after retries.';
  }
  return line;
}
