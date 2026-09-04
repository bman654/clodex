import { RetryError, wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';

interface TrackedUpstreamModel {
  model: LanguageModel;
  deadlineError: (timeoutError: Error) => Error;
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
