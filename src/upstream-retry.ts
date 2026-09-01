import { emitParentNotice } from './parent-notice.js';

export const UPSTREAM_MAX_RETRIES_ENV = 'CLODEX_UPSTREAM_MAX_RETRIES';
export const MAX_UPSTREAM_MAX_RETRIES = 5;
const reportedValues = new Set<string>();

function reportOnce(raw: string, message: string, warn: (message: string) => void): void {
  if (reportedValues.has(raw)) return;
  reportedValues.add(raw);
  try {
    warn(message);
  } catch {
    // A diagnostic must never turn a retry setting into a request failure.
  }
}

/**
 * Optional request retry override. Five retries complete before the translated
 * streaming paths' 120-second no-data timeout; larger integer values clamp to
 * that effective ceiling instead of stalling until a generic timeout.
 */
export function upstreamMaxRetries(
  env: NodeJS.ProcessEnv = process.env,
  // emitParentNotice rather than console.error: this fires from a request while
  // `clodex claude` has the parent's stdout/stderr muted for Claude Code's TUI,
  // and console.error resolves the muted write at call time.
  warn: (message: string) => void = message => emitParentNotice(`clodex: ${message}`),
): number | undefined {
  const raw = env[UPSTREAM_MAX_RETRIES_ENV]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    reportOnce(
      raw,
      `ignoring ${UPSTREAM_MAX_RETRIES_ENV}=${raw} (expected a non-negative integer)`,
      warn,
    );
    return undefined;
  }
  if (value > MAX_UPSTREAM_MAX_RETRIES) {
    reportOnce(
      raw,
      `clamping ${UPSTREAM_MAX_RETRIES_ENV}=${raw} to ${MAX_UPSTREAM_MAX_RETRIES} `
      + '(higher values exceed the 120s streaming idle budget)',
      warn,
    );
    return MAX_UPSTREAM_MAX_RETRIES;
  }
  return value;
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

export function passthroughUpstreamRetries(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = upstreamMaxRetries(env);
  if (explicit !== undefined) return explicit;
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
