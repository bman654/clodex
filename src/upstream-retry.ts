export const UPSTREAM_MAX_RETRIES_ENV = 'CLODEX_UPSTREAM_MAX_RETRIES';
export const MAX_UPSTREAM_MAX_RETRIES = 8;
const reportedInvalidValues = new Set<string>();

/**
 * Optional request retry override. Eight SDK backoffs total 510 seconds, which
 * stays within the adapter's ten-minute request ceiling; a ninth cannot.
 */
export function upstreamMaxRetries(
  env: NodeJS.ProcessEnv = process.env,
  log?: (message: string) => void,
): number | undefined {
  const raw = env[UPSTREAM_MAX_RETRIES_ENV]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_UPSTREAM_MAX_RETRIES) {
    if (log && !reportedInvalidValues.has(raw)) {
      log(
        `ignoring ${UPSTREAM_MAX_RETRIES_ENV}=${raw} `
        + `(expected an integer between 0 and ${MAX_UPSTREAM_MAX_RETRIES})`,
      );
      reportedInvalidValues.add(raw);
    }
    return undefined;
  }
  return value;
}
