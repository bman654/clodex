/** API keys and bearer tokens must be single-line — strip accidental paste noise. */
export function sanitizeCredential(value: string | null | undefined): string | null {
  if (!value) return null;
  const firstLine = value.trim().split(/\r?\n/)[0]?.trim();
  return firstLine || null;
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
