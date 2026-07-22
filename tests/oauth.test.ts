import { describe, expect, it, vi, afterEach } from 'vitest';
import { accessTokenIsExpiring, oauthCredentialNeedsRefresh, tokensToStoredCredential } from '../src/oauth/types.js';
import { extractOpenAiAccountId } from '../src/oauth/openai.js';
import { postOAuthRefresh } from '../src/oauth/refresh-http.js';
import { oauthCredentialShouldRefresh, refreshStoredOAuthCredential } from '../src/oauth/refresh.js';

describe('oauth types', () => {
  it('detects expiring oauth credentials', () => {
    expect(oauthCredentialNeedsRefresh({
      type: 'oauth',
      access: 'tok',
      refresh: 'ref',
      expires: Date.now() + 30_000,
    })).toBe(true);
  });

  it('maps token response to stored credential', () => {
    const cred = tokensToStoredCredential({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, undefined, 'acct');
    expect(cred.access).toBe('a');
    expect(cred.refresh).toBe('r');
    expect(cred.accountId).toBe('acct');
    expect(cred.expires).toBeGreaterThan(Date.now());
  });

  it('rejects malformed token responses before they can be stored', () => {
    expect(() => tokensToStoredCredential(
      {} as unknown as Parameters<typeof tokensToStoredCredential>[0],
    )).toThrow(
      'missing a valid access token',
    );
    expect(() => tokensToStoredCredential({
      access_token: 'access',
      expires_in: Number.NaN,
    })).toThrow('invalid expiration');
    expect(() => tokensToStoredCredential({
      access_token: 'access',
      expires_in: 1e308,
    })).toThrow('invalid expiration');
  });

  it('reads JWT exp for proactive refresh hint', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })).toString('base64url');
    expect(accessTokenIsExpiring(`${header}.${payload}.sig`)).toBe(true);
  });
});

describe('oauth refresh http', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts form refresh requests and includes response text in the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'bad refresh',
    })));

    await expect(postOAuthRefresh(
      'https://auth/token',
      new URLSearchParams({ grant_type: 'refresh_token' }),
      {
        contentType: 'form',
        errorPrefix: 'xAI token refresh failed',
        includeStatus: true,
        includeBody: true,
      },
    )).rejects.toThrow('xAI token refresh failed (401): bad refresh');
  });

  it('cancels an unread failed response body when error details are disabled', async () => {
    const cancel = vi.fn(async () => {});
    const text = vi.fn(async () => 'must stay unread');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      body: { cancel },
      text,
    })));

    await expect(postOAuthRefresh(
      'https://auth/token',
      new URLSearchParams({ grant_type: 'refresh_token' }),
      {
        contentType: 'form',
        errorPrefix: 'token refresh failed',
        includeStatus: true,
      },
    )).rejects.toThrow('token refresh failed (401)');
    expect(cancel).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it('aborts a hung refresh request after 30 seconds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('missing abort signal'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const refresh = postOAuthRefresh(
      'https://auth/token',
      new URLSearchParams({ grant_type: 'refresh_token' }),
      {
        contentType: 'form',
        errorPrefix: 'token refresh failed',
      },
    );
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    const rejection = refresh.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expect(rejection).resolves.toMatchObject({ name: 'TimeoutError' });
  });
});


describe('openai oauth helpers', () => {
  it('extracts account id from jwt', () => {
    const header = Buffer.from('{}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'user-123' })).toString('base64url');
    const id = extractOpenAiAccountId({ access_token: `${header}.${payload}.x`, refresh_token: 'r' });
    expect(id).toBe('user-123');
  });
});


describe('oauth refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes openai tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }), { status: 200 })));

    const cred = await refreshStoredOAuthCredential('openai-oauth', {
      type: 'oauth',
      access: 'old',
      refresh: 'rt',
      expires: 0,
    });
    expect(cred.access).toBe('new-access');
    expect(oauthCredentialShouldRefresh(cred, 'openai-oauth')).toBe(false);
  });

  it('rejects unknown providers', async () => {
    await expect(refreshStoredOAuthCredential('xai', {
      type: 'oauth',
      access: 'old',
      refresh: 'rt',
      expires: 0,
    })).rejects.toThrow('not implemented');
  });
});
