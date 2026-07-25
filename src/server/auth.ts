/** API keys and bearer tokens must be single-line — strip accidental paste noise. */
export function sanitizeCredential(value: string | null | undefined): string | null {
  if (!value) return null;
  const firstLine = value.trim().split(/\r?\n/)[0]?.trim();
  return firstLine || null;
}

/**
 * A loopback-bound gateway runs unauthenticated (local mode sets serverPassword
 * to null), so it is reachable by any page the user happens to visit. The two
 * guards below close that off without costing legitimate CLI callers anything:
 *
 * - Host: a browser cannot forge it. DNS rebinding — the trick that makes
 *   loopback responses *readable* cross-origin — pins Host to the attacker's
 *   own name, so requiring a loopback literal defeats it.
 * - Origin: reject web pages hosted away from loopback, including CORS-simple
 *   text/plain POSTs that skip preflight. Loopback web apps and Electron clients
 *   with custom-scheme origins remain valid local callers.
 *
 * Network mode binds 0.0.0.0 and mandates a password, so it is gated already
 * and its Host is legitimately a LAN address; both checks are skipped there.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackBind(host: string | undefined): boolean {
  return host === undefined || LOOPBACK_HOSTNAMES.has(host.toLowerCase());
}

export function isAllowedGatewayHost(hostHeader: string | null | undefined): boolean {
  // HTTP/1.0 clients may omit Host entirely; browsers are incapable of it.
  if (!hostHeader) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isDisallowedGatewayOrigin(originHeader: string | null | undefined): boolean {
  if (typeof originHeader !== 'string' || originHeader.trim() === '') return false;
  try {
    const origin = new URL(originHeader);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    return !LOOPBACK_HOSTNAMES.has(origin.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAuthorized(request: Request, serverPassword: string | null): boolean {
  if (serverPassword === null) return true;

  const bearerToken = extractBearerToken(request.headers.get('authorization'));
  if (bearerToken === serverPassword) return true;

  return sanitizeCredential(request.headers.get('x-api-key')) === serverPassword;
}

export function extractBearerToken(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\r?\n/g, ' ').trim();
  const match = /^Bearer\s+(\S+)/i.exec(normalized);
  return sanitizeCredential(match?.[1]);
}
