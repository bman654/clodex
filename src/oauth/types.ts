// oauth/types.ts — stored OAuth credential shape (keychain JSON)

export interface StoredOAuthCredential {
  type: 'oauth';
  access: string;
  refresh: string;
  /** Epoch millis when the access token expires. */
  expires: number;
  accessRejected?: true;
  accountId?: string;
  providerData?: Record<string, unknown>;
}

/** Serialize a stored OAuth credential for the keychain. */
export function oauthCredentialToKeychainJson(cred: StoredOAuthCredential): string {
  return JSON.stringify(cred);
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

export function tokensToStoredCredential(
  tokens: OAuthTokenResponse,
  existingRefresh?: string,
  accountId?: string,
  providerData?: Record<string, unknown>,
): StoredOAuthCredential {
  const access = typeof tokens.access_token === 'string'
    ? tokens.access_token.trim()
    : '';
  if (!access) {
    throw new Error('OAuth token response is missing a valid access token');
  }

  if (
    tokens.expires_in !== undefined
    && (
      typeof tokens.expires_in !== 'number'
      || !Number.isFinite(tokens.expires_in)
      || tokens.expires_in < 0
    )
  ) {
    throw new Error('OAuth token response has an invalid expiration');
  }

  const returnedRefresh = typeof tokens.refresh_token === 'string'
    ? tokens.refresh_token.trim()
    : '';
  const expires = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  if (!Number.isFinite(expires)) {
    throw new Error('OAuth token response has an invalid expiration');
  }
  return {
    type: 'oauth',
    access,
    refresh: returnedRefresh || existingRefresh || '',
    expires,
    ...(accountId ? { accountId } : {}),
    ...(providerData ? { providerData } : {}),
  };
}

export function parseStoredOAuthCredential(raw: string | null): StoredOAuthCredential | null {
  if (!raw?.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as StoredOAuthCredential;
    if (parsed.type === 'oauth'
      && typeof parsed.access === 'string'
      && parsed.access.trim().length > 0
      && typeof parsed.refresh === 'string'
      && typeof parsed.expires === 'number'
      && Number.isFinite(parsed.expires)
      && (parsed.accessRejected === undefined || parsed.accessRejected === true)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export const OAUTH_REFRESH_SKEW_MS = 120_000;

export function oauthCredentialNeedsRefresh(cred: StoredOAuthCredential, skewMs = OAUTH_REFRESH_SKEW_MS): boolean {
  return cred.expires <= Date.now() + Math.max(0, skewMs);
}

/** JWT exp claim — best-effort; opaque tokens return false (no proactive refresh). */
export function accessTokenIsExpiring(token: string | undefined, skewMs = OAUTH_REFRESH_SKEW_MS): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    let payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4 !== 0) payload += '=';
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { exp?: number };
    if (typeof claims.exp !== 'number') return false;
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs);
  } catch {
    return false;
  }
}

export const NATIVE_OAUTH_PROVIDER_IDS = ['openai', 'openai-oauth'] as const;
export type NativeOAuthProviderId = typeof NATIVE_OAUTH_PROVIDER_IDS[number];

export function supportsNativeOAuth(providerId: string): providerId is NativeOAuthProviderId {
  return (NATIVE_OAUTH_PROVIDER_IDS as readonly string[]).includes(providerId);
}
