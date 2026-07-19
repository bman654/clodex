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

  it('reads JWT exp for proactive refresh hint', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })).toString('base64url');
    expect(accessTokenIsExpiring(`${header}.${payload}.sig`)).toBe(true);
  });
});

describe('oauth refresh http', () => {
  afterEach(() => {
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

