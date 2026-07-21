import type { OAuthTokenResponse } from './types.js';

const OAUTH_REFRESH_TIMEOUT_MS = 30_000;

export interface PostOAuthRefreshOptions {
  contentType: 'form' | 'json';
  errorPrefix: string;
  includeStatus?: boolean;
  includeBody?: boolean;
  headers?: Record<string, string>;
}

export async function postOAuthRefresh(
  url: string,
  body: URLSearchParams | Record<string, string>,
  options: PostOAuthRefreshOptions,
): Promise<OAuthTokenResponse> {
  const isJson = options.contentType === 'json';
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS),
    headers: {
      'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...options.headers,
    },
    body: isJson ? JSON.stringify(body) : (body as URLSearchParams).toString(),
  });

  if (!response.ok) {
    const detail = options.includeBody ? await response.text().catch(() => '') : '';
    const status = options.includeStatus ? ` (${response.status})` : '';
    throw new Error(`${options.errorPrefix}${status}${detail ? `: ${detail}` : ''}`);
  }

  return response.json() as Promise<OAuthTokenResponse>;
}
