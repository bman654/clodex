import { describe, it, expect } from 'vitest';
import { formatUpstreamError } from '../src/codex/upstream-error.js';

describe('formatUpstreamError', () => {
  it('uses lastError message and status without stack', () => {
    const msg = formatUpstreamError({
      message: 'RetryError [AI_RetryError]: Failed after 2 attempts',
      lastError: { message: 'Not Found', statusCode: 404 },
    });
    expect(msg).toBe('Not Found (HTTP 404)');
  });

  it('sanitizes RetryError-only messages', () => {
    const msg = formatUpstreamError({
      message: 'RetryError [AI_RetryError]: Failed after 2 attempts with non-retryable error',
    });
    expect(msg).toBe('Upstream model request failed after retries.');
  });

  it('extracts Anthropic quota message from AI_APICallError shape', () => {
    const msg = formatUpstreamError({
      message: 'APICallError [AI_APICallError]: You have reached your specified API usage limits.',
      statusCode: 400,
      data: {
        error: {
          type: 'invalid_request_error',
          message: 'You have reached your specified API usage limits. You will regain access on 2026-07-01 at 00:00 UTC.',
        },
      },
    });
    expect(msg).toContain('API usage limits');
    expect(msg).toContain('HTTP 400');
  });
});
