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
  warn: (message: string) => void = message => console.error(`clodex: ${message}`),
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
