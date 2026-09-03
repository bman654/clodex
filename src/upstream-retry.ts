import { emitParentNotice } from './parent-notice.js';

export const UPSTREAM_MAX_RETRIES_ENV = 'CLODEX_UPSTREAM_MAX_RETRIES';
export const UPSTREAM_IDLE_TIMEOUT_ENV = 'CLODEX_UPSTREAM_IDLE_TIMEOUT_MS';
export const UPSTREAM_TOTAL_TIMEOUT_ENV = 'CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS';

export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_UPSTREAM_TOTAL_TIMEOUT_MS = 10 * 60_000;
export const MIN_UPSTREAM_IDLE_TIMEOUT_MS = 10_000;
export const MAX_UPSTREAM_IDLE_TIMEOUT_MS = 60 * 60_000;
export const MIN_UPSTREAM_TOTAL_TIMEOUT_MS = 60_000;
export const MAX_UPSTREAM_TOTAL_TIMEOUT_MS = 6 * 60 * 60_000;

const SDK_DEFAULT_MAX_RETRIES = 2;
const SDK_INITIAL_RETRY_DELAY_MS = 2_000;
const reportedValues = new Set<string>();
type Warn = (message: string) => void;

const defaultWarn: Warn = message => emitParentNotice(`clodex: ${message}`);

function reportOnce(key: string, message: string, warn: Warn): void {
  if (reportedValues.has(key)) return;
  reportedValues.add(key);
  try {
    warn(message);
  } catch {
    // A diagnostic must never turn an upstream setting into a request failure.
  }
}

interface ResolvedTimeoutSetting {
  value: number;
  explicit: boolean;
}

function timeoutSetting(
  env: NodeJS.ProcessEnv,
  envName: string,
  fallback: number,
  min: number,
  max: number,
  warn: Warn,
): ResolvedTimeoutSetting {
  const raw = env[envName]?.trim();
  if (raw === undefined || raw === '') return { value: fallback, explicit: false };

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    reportOnce(
      `${envName}=${raw}`,
      `ignoring ${envName}=${raw} (expected a positive integer number of milliseconds)`,
      warn,
    );
    return { value: fallback, explicit: false };
  }

  if (value < min || value > max) {
    const clamped = Math.min(max, Math.max(min, value));
    reportOnce(
      `${envName}=${raw}`,
      `clamping ${envName}=${raw} to ${clamped}ms (supported range is ${min}-${max}ms)`,
      warn,
    );
    return { value: clamped, explicit: true };
  }

  return { value, explicit: true };
}

/**
 * Largest retry count whose cumulative AI SDK fallback backoff is shorter
 * than the resolved idle window. Provider retry hints and failed-attempt time
 * can consume the window sooner; the shared abort signal enforces the deadline.
 */
function maxRetriesForIdleTimeout(idleTimeoutMs: number): number {
  let retries = 0;
  let elapsedMs = 0;
  let delayMs = SDK_INITIAL_RETRY_DELAY_MS;
  while (elapsedMs + delayMs < idleTimeoutMs) {
    elapsedMs += delayMs;
    delayMs *= 2;
    retries += 1;
  }
  return retries;
}

/** The retry ceiling at the default 120-second idle timeout. */
export const MAX_UPSTREAM_MAX_RETRIES = maxRetriesForIdleTimeout(
  DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
);

function configuredUpstreamMaxRetries(
  env: NodeJS.ProcessEnv,
  warn: Warn,
): number | undefined {
  const raw = env[UPSTREAM_MAX_RETRIES_ENV]?.trim();
  if (raw === undefined || raw === '') return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    reportOnce(
      `${UPSTREAM_MAX_RETRIES_ENV}=${raw}`,
      `ignoring ${UPSTREAM_MAX_RETRIES_ENV}=${raw} (expected a non-negative integer)`,
      warn,
    );
    return undefined;
  }
  return value;
}

function resolveUpstreamMaxRetries(
  env: NodeJS.ProcessEnv,
  warn: Warn,
  idleTimeoutMs: number,
): number | undefined {
  const ceiling = maxRetriesForIdleTimeout(idleTimeoutMs);
  const sdkDefault = ceiling < SDK_DEFAULT_MAX_RETRIES ? ceiling : undefined;
  const value = configuredUpstreamMaxRetries(env, warn);
  if (value === undefined) return sdkDefault;

  if (value > ceiling) {
    reportOnce(
      `${UPSTREAM_MAX_RETRIES_ENV}=${value}:idle=${idleTimeoutMs}`,
      `clamping ${UPSTREAM_MAX_RETRIES_ENV}=${value} to ${ceiling} `
      + `(estimated from the SDK fallback backoff and resolved ${idleTimeoutMs}ms idle timeout; `
      + 'provider delays may allow fewer retries)',
      warn,
    );
    return ceiling;
  }
  return value;
}

export interface UpstreamRequestBudget {
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  maxRetries: number | undefined;
}

/** Resolve the timeout pair and retry ceiling as one coherent request budget. */
export function upstreamRequestBudget(options: {
  env?: NodeJS.ProcessEnv;
  warn?: Warn;
  /** Internal override used by direct adapter callers; environment values remain bounded. */
  idleTimeoutMs?: number;
} = {}): UpstreamRequestBudget {
  const env = options.env ?? process.env;
  const warn = options.warn ?? defaultWarn;
  const hasIdleOverride = options.idleTimeoutMs !== undefined;
  const configuredIdle = options.idleTimeoutMs !== undefined
    ? { value: options.idleTimeoutMs, explicit: false }
    : timeoutSetting(
      env,
      UPSTREAM_IDLE_TIMEOUT_ENV,
      DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
      MIN_UPSTREAM_IDLE_TIMEOUT_MS,
      MAX_UPSTREAM_IDLE_TIMEOUT_MS,
      warn,
    );
  const configuredTotal = timeoutSetting(
    env,
    UPSTREAM_TOTAL_TIMEOUT_ENV,
    DEFAULT_UPSTREAM_TOTAL_TIMEOUT_MS,
    MIN_UPSTREAM_TOTAL_TIMEOUT_MS,
    MAX_UPSTREAM_TOTAL_TIMEOUT_MS,
    warn,
  );

  let idleTimeoutMs = configuredIdle.value;
  let totalTimeoutMs = configuredTotal.value;
  if (totalTimeoutMs < idleTimeoutMs) {
    if (hasIdleOverride) {
      // Direct adapter overrides never raised the fixed total timeout before
      // configuration was added, so retain that precedence without an env warning.
      idleTimeoutMs = totalTimeoutMs;
    } else if (configuredIdle.explicit && !configuredTotal.explicit) {
      reportOnce(
        `timeout-pair:raise-total:${idleTimeoutMs}:${totalTimeoutMs}`,
        `raising the resolved total timeout from ${totalTimeoutMs}ms to ${idleTimeoutMs}ms `
        + `so it is not shorter than ${UPSTREAM_IDLE_TIMEOUT_ENV}`,
        warn,
      );
      totalTimeoutMs = idleTimeoutMs;
    } else {
      reportOnce(
        `timeout-pair:lower-idle:${idleTimeoutMs}:${totalTimeoutMs}`,
        `lowering the resolved idle timeout from ${idleTimeoutMs}ms to ${totalTimeoutMs}ms `
        + `because it cannot exceed ${UPSTREAM_TOTAL_TIMEOUT_ENV}`,
        warn,
      );
      idleTimeoutMs = totalTimeoutMs;
    }
  }

  return {
    idleTimeoutMs,
    totalTimeoutMs,
    maxRetries: resolveUpstreamMaxRetries(env, warn, idleTimeoutMs),
  };
}

/**
 * Claude Code's own retry budget. Read, never written: if the operator has told
 * the client never to resend a request, clodex must not resend on its behalf.
 */
const CLIENT_MAX_RETRIES_ENV = 'CLAUDE_CODE_MAX_RETRIES';

/**
 * Retry budget for raw Anthropic passthrough requests. These are not SDK
 * generations, but they share the knob so that turning retries off turns them
 * off everywhere. One retry is enough for the failure this exists to absorb: a
 * pooled keep-alive socket the far end closed while it sat idle, which the
 * agent evicts as soon as it resets.
 */
export const DEFAULT_PASSTHROUGH_RETRIES = 1;

export function passthroughUpstreamRetries(
  env: NodeJS.ProcessEnv = process.env,
  warn: Warn = defaultWarn,
): number {
  const explicit = configuredUpstreamMaxRetries(env, warn);
  if (explicit !== undefined) {
    if (explicit <= MAX_UPSTREAM_MAX_RETRIES) return explicit;
    reportOnce(
      `${UPSTREAM_MAX_RETRIES_ENV}=${explicit}:passthrough`,
      `clamping ${UPSTREAM_MAX_RETRIES_ENV}=${explicit} to ${MAX_UPSTREAM_MAX_RETRIES} `
      + '(Anthropic passthrough supports at most this many replays)',
      warn,
    );
    return MAX_UPSTREAM_MAX_RETRIES;
  }
  // Replaying here is safe to default on because Claude Code already resends a
  // 502 itself, so the ambiguous "upstream may have served it" window is one
  // the client already accepts. `CLAUDE_CODE_MAX_RETRIES=0` withdraws exactly
  // that, and reinstating it one layer down would be a duplicate send the
  // operator explicitly opted out of.
  const raw = env[CLIENT_MAX_RETRIES_ENV]?.trim();
  if (raw !== undefined && raw !== '') {
    const clientRetries = Number(raw);
    if (Number.isFinite(clientRetries) && clientRetries === 0) return 0;
  }
  return DEFAULT_PASSTHROUGH_RETRIES;
}
