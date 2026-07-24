import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import { anthropicErrorType, clampRetryAfterSeconds, sdkUpstreamErrorDetails } from '../src/upstream-error.js';

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
