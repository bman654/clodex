import { describe, it, expect, vi } from 'vitest';
import { APICallError, RetryError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  anthropicErrorType,
  clampAiSdkRetryAfterSeconds,
  clampRetryAfterSeconds,
  formatUpstreamError,
  isContextLengthExceededError,
  sdkUpstreamErrorDetails,
  upstreamHttpStatus,
} from '../src/upstream-error.js';
import { generateAnthropicResponse, streamAnthropicResponse } from '../src/sdk-adapter.js';
import { generateOpenAiResponse, streamOpenAiResponse } from '../src/openai-adapter.js';
import { trackUpstreamAttempts } from '../src/upstream-attempts.js';

function apiCallError(overrides: {
  statusCode: number;
  message?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  isRetryable?: boolean;
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
    // Clamp an hour-scale hint to the documented 60-second cap.
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

  it('keeps AI SDK retry headers below 60s so early backoff rungs accept them', () => {
    expect(clampAiSdkRetryAfterSeconds(58.6)).toBe(59);
    expect(clampAiSdkRetryAfterSeconds(3600)).toBe(59);
  });
});

describe('retry deadline error preservation', () => {
  async function passThroughTrackedFailure(providerError: APICallError): Promise<void> {
    const model = new MockLanguageModelV4({
      doStream: async () => { throw providerError; },
    });
    const tracked = trackUpstreamAttempts(model);
    if (typeof tracked.model === 'string') throw new Error('expected a wrapped language model');
    await expect(tracked.model.doStream({} as never)).rejects.toBe(providerError);
  }

  it('uses raw upstream hints without replacing captured retry headers', async () => {
    const conflictingProseFrame = {
      type: 'error',
      sequence_number: 0,
      error: {
        type: 'rate_limit_error',
        code: '429',
        message: 'upstream prose says retry after 900s; retry after 2s',
        param: 'clodex_retry_after:upstream:2',
      },
    };
    const authoritativeRawSeconds = apiCallError({
      statusCode: 429,
      data: conflictingProseFrame,
      responseBody: JSON.stringify(conflictingProseFrame),
      responseHeaders: { 'content-type': 'text/event-stream' },
      isRetryable: true,
    });
    await passThroughTrackedFailure(authoritativeRawSeconds);
    expect(authoritativeRawSeconds.responseHeaders?.['retry-after']).toBe('2');

    const capturedMilliseconds = apiCallError({
      statusCode: 429,
      data: conflictingProseFrame,
      responseBody: JSON.stringify(conflictingProseFrame),
      responseHeaders: { 'retry-after-ms': '1' },
      isRetryable: true,
    });
    await passThroughTrackedFailure(capturedMilliseconds);
    expect(capturedMilliseconds.responseHeaders).toEqual({ 'retry-after-ms': '1' });

    const capturedSeconds = apiCallError({
      statusCode: 429,
      data: conflictingProseFrame,
      responseBody: JSON.stringify(conflictingProseFrame),
      responseHeaders: { 'retry-after': '7' },
      isRetryable: true,
    });
    await passThroughTrackedFailure(capturedSeconds);
    expect(capturedSeconds.responseHeaders).toEqual({ 'retry-after': '7' });
  });

  it('does not turn a clamped long upstream hint into repeated 59s waits', async () => {
    const syntheticFrame = {
      type: 'error',
      sequence_number: 0,
      error: {
        type: 'rate_limit_error',
        code: '429',
        message: 'retry after 60s',
        param: 'clodex_retry_after:upstream:1800',
      },
    };
    const providerError = apiCallError({
      statusCode: 429,
      data: syntheticFrame,
      responseBody: JSON.stringify(syntheticFrame),
      responseHeaders: { 'content-type': 'text/event-stream' },
      isRetryable: true,
    });

    await passThroughTrackedFailure(providerError);

    expect(providerError.responseHeaders).toEqual({
      'content-type': 'text/event-stream',
    });
  });

  it.each([
    ['a non-429 error', 500, {
      type: 'error', error: {
        code: '429', message: 'retry after 12s', param: 'clodex_retry_after:upstream:12',
      },
    }],
    ['a non-synthetic 429 body', 429, {
      error: {
        code: '429', message: 'retry after 12s', param: 'clodex_retry_after:upstream:12',
      },
    }],
    ['a synthetic 429 wrapper around a non-rate-limit frame', 429, {
      type: 'error', error: {
        code: '500', message: 'retry after 12s', param: 'clodex_retry_after:upstream:12',
      },
    }],
    ['a synthetic 429 without a hint', 429, {
      type: 'error', error: {
        code: '429', message: 'rate limited', param: 'clodex_retry_after:upstream:12',
      },
    }],
    ['a synthetic 429 hint without clodex provenance', 429, {
      type: 'error', error: { code: '429', message: 'retry after 12s', param: null },
    }],
    ['a synthetic 429 hint with incomplete clodex provenance', 429, {
      type: 'error', error: {
        code: '429',
        message: 'retry after 12s',
        param: 'clodex_retry_after:upstream:',
      },
    }],
    ['a synthetic 429 hint with non-finite upstream provenance', 429, {
      type: 'error', error: {
        code: '429',
        message: 'retry after 12s',
        param: 'clodex_retry_after:upstream:NaN',
      },
    }],
    ['a synthetic 429 hint with negative upstream provenance', 429, {
      type: 'error', error: {
        code: '429',
        message: 'retry after 12s',
        param: 'clodex_retry_after:upstream:-1',
      },
    }],
  ] as const)('leaves %s without a fabricated retry header', async (_name, statusCode, data) => {
    const providerError = apiCallError({
      statusCode,
      data,
      responseBody: JSON.stringify(data),
      responseHeaders: { 'content-type': 'text/event-stream' },
      isRetryable: statusCode >= 500 || statusCode === 429,
    });
    await passThroughTrackedFailure(providerError);
    expect(providerError.responseHeaders?.['retry-after']).toBeUndefined();
  });

  it.each(['doStream', 'doGenerate'] as const)(
    'preserves a rejected provider error from %s while the SDK waits to retry',
    async method => {
      const providerError = apiCallError({
        statusCode: 429,
        responseBody: JSON.stringify({ error: { message: 'rate limited' } }),
        responseHeaders: { 'retry-after': '31' },
        isRetryable: true,
      });
      const model = new MockLanguageModelV4({
        doStream: async () => { throw providerError; },
        doGenerate: async () => { throw providerError; },
      });
      const tracked = trackUpstreamAttempts(model);
      if (typeof tracked.model === 'string') throw new Error('expected a wrapped language model');

      await expect(tracked.model[method]({} as never)).rejects.toBe(providerError);

      expect(sdkUpstreamErrorDetails(tracked.deadlineError(new Error('request timed out'))))
        .toMatchObject({
          statusCode: 429,
          retryAfterSeconds: 31,
          attemptCount: 1,
        });
    },
  );

  it('keeps the last 429 when the idle deadline interrupts real SDK retry backoff', async () => {
    vi.useFakeTimers();
    const envKeys = [
      'CLODEX_UPSTREAM_IDLE_TIMEOUT_MS',
      'CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS',
      'CLODEX_UPSTREAM_MAX_RETRIES',
    ] as const;
    const previous = new Map(envKeys.map(key => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];

    let attempts = 0;
    const providerError = apiCallError({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: 'rate limited' } }),
      responseHeaders: { 'retry-after': '31' },
      isRetryable: true,
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        attempts += 1;
        throw providerError;
      },
    });

    let request: Promise<void> | undefined;
    try {
      request = streamAnthropicResponse(
        model,
        { messages: [{ role: 'user', content: 'test' }] },
        'test-model',
        () => {},
      );
      const rejection = request.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(attempts).toBe(4);
      await vi.advanceTimersByTimeAsync(1);

      const error = await rejection;
      expect(sdkUpstreamErrorDetails(error)).toMatchObject({
        statusCode: 429,
        retryAfterSeconds: 31,
        attemptCount: 4,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await Promise.allSettled(request ? [request] : []);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.useRealTimers();
    }
  });

  it.each([
    ['collected Anthropic stream', 'anthropic'],
    ['forwarded OpenAI stream', 'openai'],
    ['collected OpenAI stream', 'openai-collected'],
  ] as const)('preserves provider failures on the %s route', async (_name, route) => {
    vi.useFakeTimers();
    const priorIdle = process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS;
    const priorTotal = process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS;
    const priorRetries = process.env.CLODEX_UPSTREAM_MAX_RETRIES;
    process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS = '10000';
    process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS = '60000';
    process.env.CLODEX_UPSTREAM_MAX_RETRIES = '2';

    let attempts = 0;
    const providerError = apiCallError({
      statusCode: 429,
      responseHeaders: { 'retry-after': '6' },
      isRetryable: true,
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        attempts += 1;
        throw providerError;
      },
    });

    let request: Promise<unknown> | undefined;
    try {
      const params = { messages: [{ role: 'user' as const, content: 'test' }] };
      request = route === 'anthropic'
        ? generateAnthropicResponse(model, params, 'test-model', { forceStream: true })
        : route === 'openai'
          ? streamOpenAiResponse(model, params, 'test-model', () => {})
          : generateOpenAiResponse(model, params, 'test-model', { forceStream: true });
      const rejection = request.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(sdkUpstreamErrorDetails(await rejection)).toMatchObject({
        statusCode: 429,
        retryAfterSeconds: 6,
        attemptCount: 2,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await Promise.allSettled(request ? [request] : []);
      if (priorIdle === undefined) delete process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS;
      else process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS = priorIdle;
      if (priorTotal === undefined) delete process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS;
      else process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS = priorTotal;
      if (priorRetries === undefined) delete process.env.CLODEX_UPSTREAM_MAX_RETRIES;
      else process.env.CLODEX_UPSTREAM_MAX_RETRIES = priorRetries;
      vi.useRealTimers();
    }
  });

  it.each([
    ['Anthropic', 'anthropic'],
    ['OpenAI', 'openai'],
  ] as const)('preserves provider failures on the non-streaming %s route', async (_name, route) => {
    vi.useFakeTimers();
    const priorIdle = process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS;
    const priorTotal = process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS;
    const priorRetries = process.env.CLODEX_UPSTREAM_MAX_RETRIES;
    process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS = '60000';
    process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS = '60000';
    process.env.CLODEX_UPSTREAM_MAX_RETRIES = '4';

    let attempts = 0;
    const providerError = apiCallError({
      statusCode: 429,
      responseHeaders: { 'retry-after': '31' },
      isRetryable: true,
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        attempts += 1;
        throw providerError;
      },
    });

    let request: Promise<unknown> | undefined;
    try {
      const params = { messages: [{ role: 'user' as const, content: 'test' }] };
      request = route === 'anthropic'
        ? generateAnthropicResponse(model, params, 'test-model')
        : generateOpenAiResponse(model, params, 'test-model');
      const rejection = request.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);

      const error = await rejection;
      expect(sdkUpstreamErrorDetails(error)).toMatchObject({
        statusCode: 429,
        retryAfterSeconds: 31,
        attemptCount: 2,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await Promise.allSettled(request ? [request] : []);
      if (priorIdle === undefined) delete process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS;
      else process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS = priorIdle;
      if (priorTotal === undefined) delete process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS;
      else process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS = priorTotal;
      if (priorRetries === undefined) delete process.env.CLODEX_UPSTREAM_MAX_RETRIES;
      else process.env.CLODEX_UPSTREAM_MAX_RETRIES = priorRetries;
      vi.useRealTimers();
    }
  });

  it('uses the timeout when a retried provider call is currently silent', async () => {
    vi.useFakeTimers();
    const priorIdle = process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS;
    const priorTotal = process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS;
    const priorRetries = process.env.CLODEX_UPSTREAM_MAX_RETRIES;
    process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS = '10000';
    process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS = '60000';
    process.env.CLODEX_UPSTREAM_MAX_RETRIES = '2';

    let attempts = 0;
    const providerError = apiCallError({
      statusCode: 429,
      responseHeaders: { 'retry-after': '2' },
      isRetryable: true,
    });
    const model = new MockLanguageModelV4({
      doStream: async options => {
        attempts += 1;
        if (attempts === 1) throw providerError;
        return new Promise<never>((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(options.abortSignal?.reason),
            { once: true },
          );
        });
      },
    });

    let request: Promise<void> | undefined;
    try {
      request = streamAnthropicResponse(
        model,
        { messages: [{ role: 'user', content: 'test' }] },
        'test-model',
        () => {},
      );
      const rejection = request.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);

      const error = await rejection;
      expect(error).toMatchObject({ message: 'no data received from provider for 10s' });
      expect(sdkUpstreamErrorDetails(error)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await Promise.allSettled(request ? [request] : []);
      if (priorIdle === undefined) delete process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS;
      else process.env.CLODEX_UPSTREAM_IDLE_TIMEOUT_MS = priorIdle;
      if (priorTotal === undefined) delete process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS;
      else process.env.CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS = priorTotal;
      if (priorRetries === undefined) delete process.env.CLODEX_UPSTREAM_MAX_RETRIES;
      else process.env.CLODEX_UPSTREAM_MAX_RETRIES = priorRetries;
      vi.useRealTimers();
    }
  });
});
