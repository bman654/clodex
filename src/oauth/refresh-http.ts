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
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    ));
  }, OAUTH_REFRESH_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...options.headers,
      },
      body: isJson ? JSON.stringify(body) : (body as URLSearchParams).toString(),
    });

    if (!response.ok) {
      let detail = '';
      if (options.includeBody) {
        detail = await response.text().catch(() => '');
      } else {
        try {
          await response.body?.cancel();
        } catch {
          // Preserve the refresh failure when transport cleanup also fails.
        }
      }
      const status = options.includeStatus ? ` (${response.status})` : '';
      throw new Error(`${options.errorPrefix}${status}${detail ? `: ${detail}` : ''}`);
    }

    return await response.json() as OAuthTokenResponse;
  } finally {
    clearTimeout(timeout);
  }
}
