import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ServerResponse } from 'node:http';
import { sanitizeCredential } from './server/auth.js';
import { CLAUDE_CODE_USER_AGENT } from './oauth/claude-identity.js';
import { isCredentialBearingHeader } from './credential-headers.js';

export function anthropicUpstreamHeaders(
  apiKey: string,
  stream = false,
  inboundBeta?: string,
  authType?: 'api' | 'oauth' | 'none',
  claudeCodeSessionId?: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const key = sanitizeCredential(apiKey) ?? apiKey.trim();
  const resolvedAuthType = authType ?? 'api';
  const isOAuth = resolvedAuthType === 'oauth';
  const forwardedExtraHeaders = resolvedAuthType === 'none'
    ? Object.fromEntries(
        Object.entries(extraHeaders ?? {}).filter(
          ([name]) => !isCredentialBearingHeader(name),
        ),
      )
    : extraHeaders;
  const headers: Record<string, string> = {
    ...forwardedExtraHeaders,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(resolvedAuthType === 'none'
      ? {}
      : {
          Authorization: `Bearer ${key}`,
          ...(isOAuth ? {} : { 'x-api-key': key }),
        }),
    ...(isOAuth ? { 'User-Agent': CLAUDE_CODE_USER_AGENT, 'x-app': 'cli' } : {}),
    ...(isOAuth && claudeCodeSessionId ? { 'X-Claude-Code-Session-Id': claudeCodeSessionId } : {}),
    ...(stream ? { Accept: 'text/event-stream' } : {}),
  };
  if (inboundBeta) {
    headers['anthropic-beta'] = inboundBeta;
  }
  return headers;
}

export class UpstreamUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Upstream unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'UpstreamUnreachableError';
  }
}

export async function resolveOAuthRetryReplacement(
  enabled: boolean,
  status: number,
  attempt: number,
  headersSent: boolean,
  apiKey: string,
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>,
): Promise<string | null> {
  if (!enabled || status !== 401 || attempt !== 0 || headersSent || !refreshToken) {
    return null;
  }
  const replacement = await refreshToken(apiKey).catch(() => null);
  return replacement && replacement !== apiKey ? replacement : null;
}

export async function fetchWithOAuthRetry<TResponse extends {
  status: number;
  body?: { cancel?: () => Promise<void> | void } | null;
}>(
  apiKey: string,
  request: (apiKey: string) => Promise<TResponse>,
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>,
): Promise<{ response: TResponse; apiKey: string; refreshed: boolean }> {
  let response = await request(apiKey);
  const refreshed = await resolveOAuthRetryReplacement(
    true,
    response.status,
    0,
    false,
    apiKey,
    refreshToken,
  );
  if (!refreshed) {
    return { response, apiKey, refreshed: false };
  }

  try {
    await response.body?.cancel?.();
  } catch {
    // A failed cleanup must not prevent the bounded retry.
  }
  response = await request(refreshed);
  return { response, apiKey: refreshed, refreshed: true };
}

/** Relay an Anthropic /v1/messages response (JSON or SSE) to the client. */
export interface RelayAnthropicOptions {
  inboundBeta?: string;
  authType?: 'api' | 'oauth' | 'none';
  log?: (message: string) => void;
  claudeCodeSessionId?: string;
  extraHeaders?: Record<string, string>;
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>;
  onTokenRefreshed?: (token: string) => void;
  onUpstreamError?: (statusCode: number, body: string) => void;
  signal?: AbortSignal;
  /**
   * Echo this exact model id in the relayed response instead of the upstream's,
   * so a passthrough route selected through an alias reports the id the client
   * asked for rather than the canonical one. Substituting the canonical id broke
   * auto-compaction for patched/alias ids in the field; the window lookup itself
   * does not read the response body in 2.1.261 (see
   * `.claude/docs/claude-code-internals.md`), so keep this for identity
   * consistency rather than because the client parses it. Rewrites the JSON
   * body's `model` and the SSE `message_start` event; every other byte passes
   * through.
   */
  responseModelOverride?: string;
}

/**
 * An event-stream line ends with CRLF, LF, or a bare CR. Splitting on \n alone
 * finds no boundary at all in a CR-framed stream: every byte accumulates in the
 * tail buffer and the client sees nothing until the upstream closes, which
 * stalls the relay rather than merely missing a rewrite. Capturing the
 * separator lets each line be re-emitted with the exact ending it arrived with.
 */
const SSE_LINE_SPLIT = /(\r\n|\r|\n)/;

/**
 * Line-preserving SSE transform that rewrites the `message_start` event's
 * `message.model` to the requested id. Buffers only up to one line; every
 * line that is not a parseable `message_start` data line passes through
 * byte-for-byte, with its original line ending.
 */
export function anthropicSseModelRewrite(override: string): Transform {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  const rewriteLine = (line: string): string => {
    if (!line.startsWith('data:') || !line.includes('"message_start"')) return line;
    try {
      // A multi-line `data:` payload (legal SSE, never emitted by Anthropic)
      // fails to parse here and relays untouched — fail-open, so the worst
      // case is an un-rewritten model id rather than a corrupted stream.
      const parsed = JSON.parse(line.slice(5)) as { type?: string; message?: { model?: unknown } };
      if (parsed.type === 'message_start' && parsed.message && typeof parsed.message.model === 'string') {
        parsed.message.model = override;
        return 'data: ' + JSON.stringify(parsed);
      }
    } catch {
      // Not a single-line JSON payload; relay it untouched.
    }
    return line;
  };
  // Split preserves separators at odd indices, so a line and its exact ending
  // are re-joined unchanged; the final element is the unterminated remainder.
  const rewriteTerminated = (parts: string[]): string => {
    let out = '';
    for (let i = 0; i + 1 < parts.length; i += 2) out += rewriteLine(parts[i]!) + parts[i + 1]!;
    return out;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffered = tail + decoder.write(chunk);
      // Emit every observed line ending immediately. If a CRLF is split across
      // chunks, the CR and later LF still pass through in their original order;
      // treating the LF as an empty internal line is harmless because this
      // transform carries no event-level state.
      const parts = buffered.split(SSE_LINE_SPLIT);
      tail = parts.pop() ?? '';
      callback(null, rewriteTerminated(parts));
    },
    flush(callback) {
      const rest = tail + decoder.end();
      if (!rest) {
        callback(null, '');
        return;
      }
      const parts = rest.split(SSE_LINE_SPLIT);
      const remainder = parts.length % 2 === 1 ? parts.pop()! : '';
      callback(null, rewriteTerminated(parts) + (remainder ? rewriteLine(remainder) : ''));
    },
  });
}

export async function relayAnthropicMessages(
  res: ServerResponse,
  messagesUrl: string,
  body: Record<string, unknown>,
  apiKey: string,
  clientWantsStream: boolean,
  options: RelayAnthropicOptions = {},
): Promise<void> {
  const doFetch = (key: string) => fetch(messagesUrl, {
    method: 'POST',
    headers: anthropicUpstreamHeaders(
      key,
      clientWantsStream,
      options.inboundBeta,
      options.authType,
      options.claudeCodeSessionId,
      options.extraHeaders,
    ),
    body: JSON.stringify(body),
    signal: options.signal,
  });

  let upstreamRes: Response;
  try {
    const retryResult = await fetchWithOAuthRetry(apiKey, doFetch, options.refreshToken);
    upstreamRes = retryResult.response;
    if (retryResult.refreshed) options.onTokenRefreshed?.(retryResult.apiKey);
  } catch (err) {
    throw new UpstreamUnreachableError(err);
  }

  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text();
    options.log?.(`anthropic upstream ${upstreamRes.status}: ${errBody}`);
    options.onUpstreamError?.(upstreamRes.status, errBody);
    res.writeHead(upstreamRes.status, { 'Content-Type': upstreamRes.headers.get('content-type') || 'application/json' });
    res.end(errBody);
    return;
  }

  if (clientWantsStream && upstreamRes.body) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const upstream = Readable.fromWeb(upstreamRes.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', () => res.destroy());
    if (options.responseModelOverride) {
      upstream
        .pipe(anthropicSseModelRewrite(options.responseModelOverride))
        .on('error', () => res.destroy())
        .pipe(res);
    } else {
      upstream.pipe(res);
    }
    return;
  }

  if (!upstreamRes.body) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream returned empty response body' } }));
    return;
  }

  let text = await upstreamRes.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream response was not valid JSON' } }));
    return;
  }
  // Narrowed to an Anthropic Message, matching what the SSE path already
  // requires of `message_start`. Any JSON object with a string `model` used to
  // qualify, so an error envelope or a count_tokens-shaped body that happened
  // to carry one had its `model` rewritten too — the two directions of the same
  // relay disagreed about what they were allowed to touch.
  if (
    options.responseModelOverride
    && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).type === 'message'
    && typeof (parsed as Record<string, unknown>).model === 'string'
  ) {
    (parsed as Record<string, unknown>).model = options.responseModelOverride;
    text = JSON.stringify(parsed);
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text).toString(),
  });
  res.end(text);
}
