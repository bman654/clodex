import { describe, it, expect } from 'vitest';
import { APICallError, RetryError } from 'ai';
import {
  anthropicErrorType,
  clampRetryAfterSeconds,
  formatUpstreamError,
  frameStatusCode,
  isContextLengthExceededError,
  sdkUpstreamErrorDetails,
  upstreamHttpStatus,
} from '../src/upstream-error.js';

function apiCallError(overrides: {
  statusCode: number;
  message?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  data?: unknown;
}): APICallError {
  return new APICallError({
    message: `HTTP ${overrides.statusCode} failure`,
    url: 'https://chatgpt.com/backend-api/codex/responses',
    requestBodyValues: {},
    ...overrides,
  });
}

describe('sdkUpstreamErrorDetails retry-after extraction', () => {
  it('keeps every non-WebSocket 403 a terminal permission error (WS layer owns the throttle mapping)', () => {
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 403,
      responseBody: JSON.stringify({
        error: { type: 'invalid_request_error', message: 'Your account may not use this model.' },
      }),
    }));
    expect(details).toMatchObject({ statusCode: 403, isRetryable: false });
    expect(details?.retryAfterSeconds).toBeUndefined();
    expect(anthropicErrorType(details!.statusCode!)).toBe('permission_error');
  });

  it('keeps a bodyless 403 terminal — the removed WS-throttle heuristic must not return here', () => {
    // OpenAI's edge rejects the WebSocket upgrade with an HTTP 403 carrying NO
    // body. That exact shape maps to a retryable 429 in the WebSocket layer
    // ONLY; reintroducing a bodyless-403 -> 429 heuristic in this HTTP
    // classifier would make every plain 403 (real permission failures) retryable.
    const details = sdkUpstreamErrorDetails(apiCallError({ statusCode: 403 }));
    expect(details).toMatchObject({ statusCode: 403, isRetryable: false });
    expect(details?.statusCode).not.toBe(429);
    expect(details?.retryAfterSeconds).toBeUndefined();
    expect(anthropicErrorType(details!.statusCode!)).toBe('permission_error');
  });

  it('extracts the backoff hint on 429s from the error payload or retry-after header', () => {
    const fromPayload = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      data: { error: { message: 'rate limited', retry_after_seconds: 5 } },
    }));
    expect(fromPayload).toMatchObject({ statusCode: 429, isRetryable: true, retryAfterSeconds: 5 });

    const fromHeader = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: 'rate limited' } }),
      responseHeaders: { 'retry-after': '12' },
    }));
    expect(fromHeader).toMatchObject({ statusCode: 429, retryAfterSeconds: 12 });
  });

  it('recovers the hint from message text on 429s (the WS synthetic frame path)', () => {
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      message: 'OpenAI edge throttled the Responses WebSocket upgrade (HTTP 403); retry after 5s',
    }));
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true, retryAfterSeconds: 5 });
  });

  it('clamps an oversized extracted hint to 60s', () => {
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: 'rate limited' } }),
      responseHeaders: { 'retry-after': '3600' },
    }));
    expect(details?.retryAfterSeconds).toBe(60);
  });

  it('carries no backoff hint on non-rate-limit failures', () => {
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 500,
      responseBody: 'internal error',
      responseHeaders: { 'retry-after': '30' },
    }));
    expect(details?.statusCode).toBe(500);
    expect(details?.retryAfterSeconds).toBeUndefined();
  });

  it('omits a misleading capped HTTP backoff for a plan-level usage limit', () => {
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      data: {
        error: {
          type: 'usage_limit_reached',
          code: 'usage_limit_reached',
          message: 'Weekly usage limit reached',
          retry_after_seconds: 21_600,
        },
      },
    }));
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true });
    expect(details?.retryAfterSeconds).toBeUndefined();
  });

  it('omits the capped hint for a code-only plan-limit signal with no type discriminator', () => {
    // `apiErrorIsPlanUsageLimit` accepts either the `type` or the `code`, so
    // the code alone must be enough to trigger the omission — the plan-limit
    // signal survives without any `type` on the payload.
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      data: {
        error: {
          code: 'usage_limit_reached',
          message: 'Weekly usage limit reached',
          retry_after_seconds: 21_600,
        },
      },
    }));
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true });
    expect(details?.retryAfterSeconds).toBeUndefined();
  });

  it('detects a usage limit whose discriminator survives only in the serialized body', () => {
    // The responseBody fallback exists for malformed or non-conforming bodies:
    // the SDK's JSON error handler populates `data` for any schema-valid body,
    // whose error schema requires the message. When the usage-limit signal does
    // survive only in the serialized body, the classifier must still read the
    // same structured payload both consumers use. Misread, the oversized
    // retry-after below would be clamped to 60s instead of omitted.
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      responseBody: JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          code: 'usage_limit_reached',
          message: 'Weekly usage limit reached',
        },
      }),
      responseHeaders: { 'retry-after': '21600' },
    }));
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true });
    expect(details?.retryAfterSeconds).toBeUndefined();
  });

  it('lets a parsed body retry hint win over a conflicting retry-after header', () => {
    // numericRetryAfterSeconds reads the parsed body before the header, so the
    // body's in-bounds plan-limit hint is kept (the exemption only omits hints
    // above the cap) while the capped header is never consulted.
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      responseBody: JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          code: 'usage_limit_reached',
          message: 'Weekly usage limit reached',
          retry_after_seconds: 30,
        },
      }),
      responseHeaders: { 'retry-after': '21600' },
    }));
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true, retryAfterSeconds: 30 });
  });

  it('treats a malformed serialized body as absent instead of crashing the classifier', () => {
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 429,
      responseBody: 'not json {',
      responseHeaders: { 'retry-after': '3600' },
    }));
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true, retryAfterSeconds: 60 });
  });
});

describe('usage-limit classification', () => {
  it('maps the clodex-specific usage-limit signal to retryable 429 semantics', () => {
    expect(frameStatusCode(undefined, 'usage_limit_reached')).toBe(429);
    expect(frameStatusCode(undefined, 'server_error usage_limit_reached')).toBe(429);

    const details = sdkUpstreamErrorDetails({
      type: 'usage_limit_reached',
      code: 'usage_limit_reached',
      message: 'Weekly usage limit reached',
      retry_after_seconds: 30,
    });
    expect(details).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      retryAfterSeconds: 30,
      attemptCount: 1,
    });
    expect(anthropicErrorType(details!.statusCode!)).toBe('rate_limit_error');
  });

  it('omits the backoff hint for a raw usage-limit frame even when its prose carries one', () => {
    // The plan-limit exemption applies on the frame path too: an oversized
    // reset stated only in message prose is omitted, never clamped.
    const details = sdkUpstreamErrorDetails({
      type: 'usage_limit_reached',
      code: 'usage_limit_reached',
      message: 'Weekly usage limit reached; retry after 3600s',
    });
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true });
    expect(details?.retryAfterSeconds).toBeUndefined();
  });

  it('clamps the same oversized prose hint on an ordinary rate-limit frame', () => {
    // The control: an equivalent plain rate limit with the same oversized hint
    // is an ordinary throttle and still clamps to 60s.
    const details = sdkUpstreamErrorDetails({
      type: 'rate_limit_exceeded',
      code: 'rate_limit_exceeded',
      message: 'Rate limit reached; retry after 3600s',
    });
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true, retryAfterSeconds: 60 });
  });
});

describe('sdkUpstreamErrorDetails transport-code extraction', () => {
  it('omits an unexpected WebSocket transport code', () => {
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 500,
      data: {
        error: {
          message: 'transport unavailable',
          code: 'unexpected_transport_code',
        },
      },
    }));

    expect(details).toBeDefined();
    expect(details).not.toHaveProperty('transportCode');
  });

  it('omits an overlong WebSocket transport code', () => {
    const details = sdkUpstreamErrorDetails(apiCallError({
      statusCode: 500,
      data: {
        error: {
          message: 'transport unavailable',
          code: `websocket_${'transport_'.repeat(30)}error`,
        },
      },
    }));

    expect(details).toBeDefined();
    expect(details).not.toHaveProperty('transportCode');
  });
});

// `@ai-sdk/openai` converts a stream failure arriving BEFORE the first output
// chunk into a real APICallError. Once output has started it instead enqueues
// the frame verbatim, and our adapter rethrows that raw payload — these are the
// shapes it produces, and the only ones that reach the recovery under test.
const nestedErrorChunk = {
  type: 'error',
  sequence_number: 42,
  error: {
    type: 'server_error',
    code: 'server_error',
    message: 'The model produced an internal error',
    param: null,
  },
};
const responseFailedChunk = {
  type: 'response.failed',
  sequence_number: 7,
  response: {
    error: { code: 'server_error', message: 'The server had an error while processing' },
    incomplete_details: null,
  },
};
const flatErrorChunk = {
  type: 'error',
  sequence_number: 3,
  code: 'rate_limit_exceeded',
  message: 'Rate limit reached for gpt-5.6',
  param: null,
};

describe('provider stream error frames', () => {
  it('recovers the provider message from a mid-stream nested error chunk', () => {
    // The production failure: 26s into a healthy stream an error part arrived
    // and collapsed to "Upstream model request failed." with a synthesized
    // HTTP 500 and no details, discarding everything the provider said.
    const message = formatUpstreamError(nestedErrorChunk);
    expect(message).toBe('The model produced an internal error (HTTP 500)');
    expect(upstreamHttpStatus(nestedErrorChunk, message)).toBe(500);
    expect(sdkUpstreamErrorDetails(nestedErrorChunk)).toMatchObject({
      statusCode: 500,
      isRetryable: true,
      attemptCount: 1,
    });
  });

  it('recovers the error nested under response.failed', () => {
    const message = formatUpstreamError(responseFailedChunk);
    expect(message).toBe('The server had an error while processing (HTTP 500)');
    expect(sdkUpstreamErrorDetails(responseFailedChunk)).toMatchObject({ statusCode: 500 });
  });

  it('maps a flat error chunk code to its real status', () => {
    const message = formatUpstreamError(flatErrorChunk);
    expect(message).toBe('Rate limit reached for gpt-5.6 (HTTP 429)');
    expect(upstreamHttpStatus(flatErrorChunk, message)).toBe(429);
    expect(anthropicErrorType(429)).toBe('rate_limit_error');
  });

  it('parses the bare payload the chat-completions transport enqueues', () => {
    // That transport enqueues `error: chunk.error` — the OpenAI error object
    // with no chunk wrapper around it.
    const bare = {
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message: 'Your input exceeds the context window of this model',
      param: 'messages',
    };
    const message = formatUpstreamError(bare);
    expect(message).toBe('Your input exceeds the context window of this model (HTTP 400)');
    expect(sdkUpstreamErrorDetails(bare)).toMatchObject({ statusCode: 400, isRetryable: false });
    expect(isContextLengthExceededError(bare, message)).toBe(true);
  });

  it('classifies a mid-stream frame the same way the SDK classifies it pre-output', () => {
    // The same failure must not report a different status depending on whether
    // it landed before or after the first output chunk, so this mirrors
    // @ai-sdk/openai's own getStatusCode discriminators.
    const statusFor = (code: string | undefined, type: string | undefined) => {
      const frame = { type: 'error', sequence_number: 0, error: { code, type, message: 'failed' } };
      return upstreamHttpStatus(frame, formatUpstreamError(frame));
    };
    expect(statusFor('rate_limit_exceeded', undefined)).toBe(429);
    expect(statusFor('insufficient_quota', undefined)).toBe(429);
    expect(statusFor(undefined, 'authentication_error')).toBe(401);
    expect(statusFor(undefined, 'permission_error')).toBe(403);
    expect(statusFor(undefined, 'not_found_error')).toBe(404);
    expect(statusFor('context_length_exceeded', undefined)).toBe(400);
    expect(statusFor('invalid_prompt', undefined)).toBe(400);
    expect(statusFor('overloaded_error', undefined)).toBe(503);
    expect(statusFor('timeout', undefined)).toBe(504);
    expect(statusFor('server_error', undefined)).toBe(500);
    // clodex's own synthetic frames carry the stringified status as the code.
    expect(statusFor('429', 'rate_limit_error')).toBe(429);
  });

  it('never infers a status from digits in the provider message', () => {
    // A recognized frame must resolve its own status; letting the recovered
    // message reach upstreamHttpStatus's prose sniffing turned a token count
    // into a phantom rate limit, telling the client to retry a hard failure.
    const frame = {
      type: 'error',
      sequence_number: 1,
      error: {
        type: 'billing_error',
        code: 'quota_billing_hard_limit_reached',
        message: 'You have consumed 429000 of your 500000 monthly tokens.',
        param: null,
      },
    };
    const message = formatUpstreamError(frame);
    expect(upstreamHttpStatus(frame, message)).toBe(500);
    const details = sdkUpstreamErrorDetails(frame);
    expect(details?.statusCode).toBe(500);
    // isRetryable must agree with the status it is reported alongside; the
    // phantom 429 was logged next to isRetryable:false.
    expect(details?.isRetryable).toBe(true);
  });

  it('decides context overflow from the frame code, not from loose prose', () => {
    // Acting on this substitutes a synthetic "prompt is too long" that Claude
    // Code parses to drive auto-compaction, so a false positive both discards
    // the real error and drops conversation history.
    const unrelated = {
      type: 'error',
      sequence_number: 1,
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_parameter',
        message: "Unsupported parameter 'reasoning' for this model; see the context window docs",
      },
    };
    expect(upstreamHttpStatus(unrelated, formatUpstreamError(unrelated))).toBe(400);
    expect(isContextLengthExceededError(unrelated, formatUpstreamError(unrelated))).toBe(false);

    const byCode = {
      type: 'error',
      sequence_number: 1,
      error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Input too large' },
    };
    expect(isContextLengthExceededError(byCode, formatUpstreamError(byCode))).toBe(true);

    const byWording = {
      type: 'error',
      sequence_number: 1,
      error: {
        type: 'invalid_request_error',
        code: 'bad_request',
        message: "This model's maximum context length is 272000 tokens",
      },
    };
    expect(isContextLengthExceededError(byWording, formatUpstreamError(byWording))).toBe(true);
  });

  it('still says something when the provider message starts with a blank line', () => {
    // sanitizeMessage keeps only the first line; an empty message field reads
    // to Claude Code as no message and it prints the raw error envelope.
    const frame = {
      type: 'error',
      sequence_number: 1,
      error: { type: 'server_error', code: 'server_error', message: '\nThe model produced an internal error' },
    };
    expect(formatUpstreamError(frame)).toBe('Upstream model request failed. (HTTP 500)');
  });

  it('recovers a rate-limit backoff hint that survives only in message text', () => {
    // The AI SDK's chunk schema is a closed zod object, so it strips
    // `retry_after_seconds`; the hint reaches us only as prose.
    const frame = (message: string) => ({
      type: 'error',
      sequence_number: 0,
      error: { type: 'rate_limit_error', code: '429', message },
    });
    expect(sdkUpstreamErrorDetails(frame('throttled; retry after 7s')))
      .toMatchObject({ statusCode: 429, isRetryable: true, retryAfterSeconds: 7 });
    // Clamped so a hostile or absurd hint cannot park a client past the
    // 120s no-event stream abort.
    expect(sdkUpstreamErrorDetails(frame('throttled; retry after 3600s'))?.retryAfterSeconds).toBe(60);
  });

  it('preserves the WebSocket transport code and treats it as transient', () => {
    const frame = {
      type: 'error',
      sequence_number: 0,
      error: {
        type: 'transport_error',
        code: 'websocket_transport_error',
        message: 'WebSocket closed before the response completed',
        param: null,
      },
    };
    expect(sdkUpstreamErrorDetails(frame)).toMatchObject({
      transportCode: 'websocket_transport_error',
      isRetryable: true,
      statusCode: 500,
    });
    expect(formatUpstreamError(frame)).toBe('WebSocket closed before the response completed (HTTP 500)');
  });

  it('records the whole payload as errorContent for the diagnostic log', () => {
    const content = sdkUpstreamErrorDetails(nestedErrorChunk)?.errorContent ?? '';
    // Exact equality, not a subset: the promise of this field is the WHOLE
    // payload, so dropping a key (`param` here) has to fail the test.
    expect(JSON.parse(content)).toEqual(nestedErrorChunk.error);
  });

  it('bounds an overlong provider message rather than dropping it', () => {
    const frame = {
      type: 'error',
      sequence_number: 0,
      error: { type: 'server_error', code: 'server_error', message: 'x'.repeat(5000) },
    };
    const message = formatUpstreamError(frame);
    expect(message.length).toBeLessThan(300);
    expect(message).toContain('xxx');
    expect(message).not.toBe('Upstream model request failed.');
  });

  it('does not split a surrogate pair when bounding the message', () => {
    // A lone surrogate does not survive JSON serialization to the client.
    const frame = {
      type: 'error',
      sequence_number: 0,
      error: { type: 'server_error', code: 'server_error', message: `${'a'.repeat(238)}😀z` },
    };
    const message = formatUpstreamError(frame);
    expect(message.isWellFormed()).toBe(true);
    expect(JSON.parse(JSON.stringify({ message })).message).toBe(message);
  });

  it('counts retry attempts when the SDK wraps a frame in a RetryError', () => {
    const retry = new RetryError({
      message: 'Failed after 2 attempts',
      reason: 'maxRetriesExceeded',
      errors: [nestedErrorChunk, nestedErrorChunk],
    });
    expect(sdkUpstreamErrorDetails(retry)).toMatchObject({ statusCode: 500, attemptCount: 2 });
    expect(formatUpstreamError(retry)).toBe('The model produced an internal error (HTTP 500)');
  });
});

describe('provider frame recovery leaves other error sources alone', () => {
  it('does not treat a local abort or timeout as a provider frame', () => {
    const abort = new Error('SDK stream aborted');
    abort.name = 'AbortError';
    expect(sdkUpstreamErrorDetails(abort)).toBeUndefined();
    expect(formatUpstreamError(abort)).toBe('SDK stream aborted');

    const idle = new Error('no data received from provider for 120s');
    expect(sdkUpstreamErrorDetails(idle)).toBeUndefined();
    expect(formatUpstreamError(idle)).toBe('no data received from provider for 120s');
  });

  it('does not treat an arbitrary object carrying a message as a provider frame', () => {
    expect(sdkUpstreamErrorDetails({ message: 'something went wrong' })).toBeUndefined();
  });

  // The SDK's error schema types `code` as `string | number` and `type` as
  // nullish, and its own `getStatusCode` reads a numeric code first. Reading
  // only string codes, or demanding a string `type`, classified these payloads
  // 500 after first output while the SDK classified them exactly before it —
  // the pre/post-output split this module exists to remove.
  it('classifies a numeric code the way the SDK does', () => {
    const frame = { type: 'server_error', code: 503, message: 'service unavailable', param: null };
    expect(sdkUpstreamErrorDetails(frame)).toMatchObject({ statusCode: 503, isRetryable: true });
    expect(formatUpstreamError(frame)).toBe('service unavailable (HTTP 503)');
  });

  it('recovers a rejection whose type is null, as the SDK schema permits', () => {
    const frame = { message: 'Too many requests', type: null, param: null, code: 429 };
    expect(sdkUpstreamErrorDetails(frame)).toMatchObject({ statusCode: 429, isRetryable: true });
  });

  it('recovers a status-like code with neither type nor param', () => {
    expect(sdkUpstreamErrorDetails({ message: 'gateway timeout', code: '504' }))
      .toMatchObject({ statusCode: 504, isRetryable: true });
  });

  // The SDK accepts an unwrapped payload on ANY ONE of a string `type`, a
  // `code` key, or a `param` key. Each is pinned separately, because requiring
  // combinations of them is what previously left a rate limit as a 500 once
  // output had started.
  it.each([
    ['a non-status code alone', { message: 'limited', code: 'rate_limit_exceeded' }, 429],
    ['a type alone', { message: 'limited', type: 'rate_limit_error' }, 429],
    ['a param alone', { message: 'bad field', param: 'reasoning.summary' }, 500],
    ['a null code', { message: 'failed', code: null }, 500],
    // Numeric statuses beyond the retryable ones: covering only 429/503 let an
    // implementation that recognized just those two pass while every other
    // numeric code silently became 500 after output.
    ['a terminal numeric code', { message: 'auth failed', code: 401 }, 401],
    ['a numeric code at the range floor', { message: 'bad request', code: 400 }, 400],
    ['a numeric code at the range ceiling', { message: 'unknown', code: 599 }, 599],
  ])('recovers an unwrapped frame identified by %s', (_label, frame, statusCode) => {
    expect(sdkUpstreamErrorDetails(frame)).toMatchObject({ statusCode });
  });

  it('recognizes an empty type the way the SDK does, instead of sniffing prose', () => {
    // `type: ''` is schema-valid and the SDK accepts any string, mapping this
    // to 500. Rejecting it here sent the message on to the digit scan in
    // `upstreamHttpStatus`, which read the token counts as a rate limit — so
    // the same payload was terminal before first output and retryable after.
    const frame = { message: 'consumed 429000 of 500000 tokens', type: '' };
    expect(sdkUpstreamErrorDetails(frame)).toMatchObject({ statusCode: 500, isRetryable: true });
    expect(upstreamHttpStatus(frame, formatUpstreamError(frame))).toBe(500);
  });

  it('recovers the status of a frame whose message is blank', () => {
    // Schema-valid: `message` need only be a string. The status still matters —
    // this one carries retryability and a backoff hint.
    const details = sdkUpstreamErrorDetails({ message: '', code: 429 });
    expect(details).toMatchObject({ statusCode: 429, isRetryable: true });
    expect(formatUpstreamError({ message: '', code: 429 }))
      .toBe('Provider returned an error (HTTP 429)');
  });

  // Provenance is the discriminator: these carry the very fields the predicate
  // accepts on a plain object, but they are thrown Errors, not provider frames.
  it.each([
    ['param', Object.assign(new Error('bad local argument'), { param: 'url' })],
    ['a numeric code', Object.assign(new Error('local numeric code'), { code: 429 })],
    ['type and code', Object.assign(new Error('socket event'), { type: 'error', code: 'EPIPE' })],
  ])('does not treat an ordinary Error carrying %s as a provider frame', (_label, error) => {
    expect(sdkUpstreamErrorDetails(error)).toBeUndefined();
  });

  it('does not treat a socket error as a provider frame despite its code', () => {
    // Node system errors carry a `code` ('ECONNRESET'), so a bare `code` can
    // never be sufficient on its own to call something a provider frame — it
    // is neither status-like nor accompanied by `type`/`param`.
    const socketError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(sdkUpstreamErrorDetails(socketError)).toBeUndefined();
    expect(formatUpstreamError(socketError)).toBe('socket hang up');
  });

  it('keeps APICallError classification authoritative', () => {
    const apiError = apiCallError({
      statusCode: 403,
      responseBody: JSON.stringify({ error: { message: 'Your account may not use this model.' } }),
    });
    expect(sdkUpstreamErrorDetails(apiError)).toMatchObject({ statusCode: 403, isRetryable: false });
    expect(formatUpstreamError(apiError)).toBe('Your account may not use this model. (HTTP 403)');

    const wrapped = new RetryError({
      message: 'Failed after 2 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiError, apiError],
    });
    expect(sdkUpstreamErrorDetails(wrapped)).toMatchObject({ statusCode: 403, attemptCount: 2 });
  });
});

describe('clampRetryAfterSeconds', () => {
  it('defaults missing or invalid values to 5s and caps at 60s', () => {
    expect(clampRetryAfterSeconds(undefined)).toBe(5);
    expect(clampRetryAfterSeconds(Number.NaN)).toBe(5);
    expect(clampRetryAfterSeconds(-1)).toBe(5);
    expect(clampRetryAfterSeconds(0)).toBe(0);
    expect(clampRetryAfterSeconds(12)).toBe(12);
    expect(clampRetryAfterSeconds(3600)).toBe(60);
  });
});
