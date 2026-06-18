import { describe, expect, it, vi, afterEach } from 'vitest';
import { accessTokenIsExpiring, oauthCredentialNeedsRefresh, tokensToStoredCredential } from '../src/oauth/types.js';
import { pollXaiDeviceCodeToken, requestXaiDeviceCode } from '../src/oauth/xai.js';
import { extractOpenAiAccountId } from '../src/oauth/openai.js';
import { oauthCredentialShouldRefresh, refreshStoredOAuthCredential } from '../src/oauth/refresh.js';
import { codexCompatibleProviders } from '../src/codex/routing.js';
import type { LocalProvider } from '../src/types.js';

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

describe('xai device code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests and polls device code tokens', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://x.ai/device',
        expires_in: 60,
        interval: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
      }), { status: 200 })));

    const device = await requestXaiDeviceCode();
    expect(device.user_code).toBe('ABCD-1234');
    const tokens = await pollXaiDeviceCodeToken(device, { sleep: async () => {}, now: () => 0 });
    expect(tokens.access_token).toBe('access');
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

  it('refreshes xai tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }), { status: 200 })));

    const cred = await refreshStoredOAuthCredential('xai', {
      type: 'oauth',
      access: 'old',
      refresh: 'rt',
      expires: 0,
    });
    expect(cred.access).toBe('new-access');
    expect(oauthCredentialShouldRefresh(cred, 'xai')).toBe(false);
  });
});

describe('codexCompatibleProviders', () => {
  it('includes anthropic, zen/go, and groq', () => {
    const providers: LocalProvider[] = [
      { id: 'zen', name: 'Zen', apiKey: 'k', models: [{ id: 'm', name: 'M', family: '', brand: '', modelFormat: 'openai', upstreamModelId: 'm' }] },
      { id: 'groq', name: 'Groq', apiKey: 'k', models: [{ id: 'm', name: 'M', family: '', brand: '', modelFormat: 'openai', upstreamModelId: 'm', npm: '@ai-sdk/groq' }] },
      { id: 'anthropic', name: 'A', apiKey: 'k', models: [{ id: 'm', name: 'M', family: '', brand: '', modelFormat: 'anthropic', upstreamModelId: 'm' }] },
    ];
    expect(codexCompatibleProviders(providers).map(p => p.id).sort()).toEqual(['anthropic', 'groq', 'zen']);
  });
});
