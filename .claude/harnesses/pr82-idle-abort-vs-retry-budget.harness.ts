import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Independent verification for PR 82:
 * does the 120s idle abort in streamAnthropicResponse fire before an
 * 8-retry exponential backoff budget (claimed 510s) can be spent?
 *
 * We drive the REAL retry helper from the installed ai package so the
 * backoff schedule is the shipped one, not a re-derivation.
 */
describe('PR82: idle abort vs SDK retry budget', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports when the 120s idle abort fires relative to each retry attempt', async () => {
    const { retryWithExponentialBackoff } = await import(
      '@ai-sdk/provider-utils'
    ) as any;

    const IDLE_MS = 120_000; // SDK_STREAM_IDLE_TIMEOUT_MS in src/sdk-adapter.ts
    const controller = new AbortController();
    // Armed BEFORE streamText, exactly as src/sdk-adapter.ts:866 does, and
    // never reset because a failing attempt yields no stream part.
    setTimeout(() => controller.abort(new Error('idle 120s')), IDLE_MS);

    const attemptTimes: number[] = [];
    const start = Date.now();

    const retryable = Object.assign(new Error('rate limited'), {
      name: 'AI_APICallError',
      isRetryable: true,
      statusCode: 429,
    });

    const retry = retryWithExponentialBackoff({
      maxRetries: 8,
      initialDelayInMs: 2000,
      backoffFactor: 2,
      abortSignal: controller.signal,
      shouldRetry: () => true,
      getDelayInMs: ({ exponentialBackoffDelay }: any) => exponentialBackoffDelay,
      createRetryError: ({ message, errors }: any) =>
        Object.assign(new Error(message), { errors }),
    });

    const promise = retry(async () => {
      attemptTimes.push(Date.now() - start);
      throw retryable;
    }).catch((e: any) => e);

    await vi.advanceTimersByTimeAsync(600_000);
    const outcome = await promise;

    // eslint-disable-next-line no-console
    console.log('ATTEMPT_OFFSETS_MS=' + JSON.stringify(attemptTimes));
    // eslint-disable-next-line no-console
    console.log('ATTEMPTS=' + attemptTimes.length + ' (1 initial + retries)');
    // eslint-disable-next-line no-console
    console.log('OUTCOME=' + (outcome?.message ?? String(outcome)));
    // eslint-disable-next-line no-console
    console.log('ABORTED_AT_MS=' + IDLE_MS + ' ; attempts after abort = '
      + attemptTimes.filter(t => t > IDLE_MS).length);

    expect(attemptTimes.length).toBeGreaterThan(0);
  });
});
