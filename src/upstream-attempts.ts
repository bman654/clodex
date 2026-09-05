import { APICallError, RetryError, wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import {
  clampAiSdkRetryAfterSeconds,
  MAX_RETRY_AFTER_SECONDS,
  providerErrorFrame,
  retryAfterProvenanceFromParam,
} from './upstream-error.js';

interface TrackedUpstreamModel {
  model: LanguageModel;
  deadlineError: (timeoutError: Error) => Error;
}

/**
 * OpenAI snapshots a streaming Response's headers before a later WebSocket
 * failure supplies its hint. Restore only safe, upstream-stated synthetic hints
 * at the model boundary, before the AI SDK chooses its retry delay.
 */
function restoreSyntheticRetryAfterHeader(error: unknown): void {
  if (!APICallError.isInstance(error) || error.statusCode !== 429) return;
  const headers = error.responseHeaders;
  if (!headers || headers['retry-after'] !== undefined
    || headers['retry-after-ms'] !== undefined) return;
  const rawFrame = error.data;
  if (!rawFrame || typeof rawFrame !== 'object'
    || (rawFrame as Record<string, unknown>).type !== 'error') return;
  const frame = providerErrorFrame(rawFrame);
  if (frame?.retryAfterSeconds === undefined) return;
  const nestedError = (rawFrame as { error?: unknown }).error;
  const provenance = retryAfterProvenanceFromParam(
    nestedError && typeof nestedError === 'object'
      ? (nestedError as { param?: unknown }).param
      : undefined,
  );
  if (provenance?.source !== 'upstream') return;
  if (provenance.rawSeconds < 0
    || provenance.rawSeconds > MAX_RETRY_AFTER_SECONDS) return;

  headers['retry-after'] = String(clampAiSdkRetryAfterSeconds(provenance.rawSeconds));
}

/**
 * Preserve provider errors when a request deadline interrupts the AI SDK's
 * retry delay. A deadline during an active provider call remains a timeout so
 * an older rejection cannot hide a newly silent attempt.
 */
export function trackUpstreamAttempts(model: LanguageModel): TrackedUpstreamModel {
  if (typeof model === 'string') {
    return { model, deadlineError: timeoutError => timeoutError };
  }

  const failedAttempts: unknown[] = [];
  let waitingToRetry = false;

  const track = async <T>(call: () => PromiseLike<T>): Promise<T> => {
    waitingToRetry = false;
    try {
      const result = await call();
      failedAttempts.length = 0;
      return result;
    } catch (error) {
      restoreSyntheticRetryAfterHeader(error);
      failedAttempts.push(error);
      waitingToRetry = true;
      throw error;
    }
  };

  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v4',
    wrapGenerate: ({ doGenerate }) => track(doGenerate),
    wrapStream: ({ doStream }) => track(doStream),
  };

  return {
    model: wrapLanguageModel({ model, middleware }),
    deadlineError: timeoutError => {
      if (!waitingToRetry || failedAttempts.length === 0) return timeoutError;
      const count = failedAttempts.length;
      return new RetryError({
        message: [
          'Provider retry interrupted by a request deadline after',
          count,
          `failed ${count === 1 ? 'attempt' : 'attempts'}`,
        ].join(' '),
        reason: 'abort',
        errors: [...failedAttempts],
      });
    },
  };
}
