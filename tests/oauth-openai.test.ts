import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import {
  buildOpenAiAuthorizeUrl,
  extractOpenAiAccountId,
  refreshOpenAiAccessToken,
  runOpenAiBrowserFlow,
  runOpenAiDeviceCodeFlow,
} from '../src/oauth/openai.js';

describe('oauth/openai', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('extractOpenAiAccountId', () => {
    function buildJwt(claims: unknown): string {
      return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
    }

    it('returns undefined if no token provided', () => {
      expect(extractOpenAiAccountId({})).toBeUndefined();
    });

    it('extracts from chatgpt_account_id', () => {
      const token = buildJwt({ chatgpt_account_id: 'acc_123' });
      expect(extractOpenAiAccountId({ id_token: token, access_token: '' })).toBe('acc_123');
    });

    it('extracts from api.openai.com/auth', () => {
      const token = buildJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_456' } });
      expect(extractOpenAiAccountId({ access_token: token })).toBe('acc_456');
    });

    it('extracts from organizations array', () => {
      const token = buildJwt({ organizations: [{ id: 'org_789' }] });
      expect(extractOpenAiAccountId({ id_token: token, access_token: '' })).toBe('org_789');
    });

    it('returns undefined for invalid JWT', () => {
      expect(extractOpenAiAccountId({ id_token: 'invalid.jwt.token' })).toBeUndefined();
      expect(extractOpenAiAccountId({ id_token: 'not-even-three-parts' })).toBeUndefined();
    });
  });

  describe('refreshOpenAiAccessToken', () => {
    it('returns tokens on success', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new_token' }),
      } as Response);

      const res = await refreshOpenAiAccessToken('refresh_123');
      expect(res.access_token).toBe('new_token');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://auth.openai.com/oauth/token',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on non-ok response', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      await expect(refreshOpenAiAccessToken('refresh_123')).rejects.toThrow(/OpenAI token refresh failed \(401\)/);
    });
  });

  describe('buildOpenAiAuthorizeUrl', () => {
    it('builds the PKCE authorize URL with the registered client id', () => {
      const url = new URL(buildOpenAiAuthorizeUrl('http://localhost:1455/auth/callback', 'chal', 'st4te'));
      expect(url.origin).toBe('https://auth.openai.com');
      expect(url.pathname).toBe('/oauth/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
      expect(url.searchParams.get('code_challenge')).toBe('chal');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBe('st4te');
    });
  });

  describe('runOpenAiBrowserFlow', () => {
    function hitCallback(authorizeUrl: string, query: (state: string) => string): Promise<number> {
      const authorize = new URL(authorizeUrl);
      const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
      const state = authorize.searchParams.get('state')!;
      return new Promise((resolve, reject) => {
        const request = http.get(
          `${redirect.origin}${redirect.pathname}?${query(state)}`,
          response => {
            const status = response.statusCode ?? 0;
            response.resume();
            response.once('end', () => resolve(status));
          },
        );
        request.once('error', reject);
      });
    }

    function redirectUriHost(authorizeUrl: string): string {
      return new URL(new URL(authorizeUrl).searchParams.get('redirect_uri')!).host;
    }

    it('exchanges the callback code for tokens', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'browser_access', refresh_token: 'browser_refresh' }),
      } as Response);

      let seenUrl = '';
      const result = await runOpenAiBrowserFlow(({ url }) => {
        seenUrl = url;
        void hitCallback(url, state => `code=auth_code_1&state=${encodeURIComponent(state)}`);
      }, { ports: [0], timeoutMs: 2_000 });

      expect(result.tokens.access_token).toBe('browser_access');
      expect(new URL(new URL(seenUrl).searchParams.get('redirect_uri')!).hostname).toBe('localhost');
      const [exchangeUrl, exchangeInit] = vi.mocked(global.fetch).mock.calls[0]!;
      expect(exchangeUrl).toBe('https://auth.openai.com/oauth/token');
      const body = new URLSearchParams(String((exchangeInit as RequestInit).body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth_code_1');
      expect(body.get('redirect_uri')).toBe(new URL(seenUrl).searchParams.get('redirect_uri'));
      const verifier = body.get('code_verifier')!;
      // PKCE binding: the exchanged verifier must hash to the advertised challenge.
      expect(createHash('sha256').update(verifier).digest('base64url'))
        .toBe(new URL(seenUrl).searchParams.get('code_challenge'));
    });

    it('ignores a mismatched callback before accepting a valid one', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'browser_access' }),
      } as Response);

      let staleStatus = 0;
      let callbackSequence: Promise<number> | undefined;
      const flow = runOpenAiBrowserFlow(({ url }) => {
        callbackSequence = hitCallback(url, () => 'code=auth_code_forged&state=forged')
          .then(status => {
            staleStatus = status;
            return hitCallback(url, state => `code=auth_code_1&state=${encodeURIComponent(state)}`);
          });
      }, { ports: [0], timeoutMs: 2_000 });

      const result = await flow;
      if (!callbackSequence) throw new Error('callback sequence was not started');
      await callbackSequence;
      expect(staleStatus).toBe(400);
      expect(result.tokens.access_token).toBe('browser_access');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const body = new URLSearchParams(
        String((vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit).body),
      );
      expect(body.get('code')).toBe('auth_code_1');
    });

    it('rejects when the provider returns an error instead of a code', async () => {
      await expect(runOpenAiBrowserFlow(({ url }) => {
        void hitCallback(url, state => `error=access_denied&state=${encodeURIComponent(state)}`);
      }, { ports: [0], timeoutMs: 2_000 })).rejects.toThrow(/access_denied/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows the browser a failure page when the provider denies access', async () => {
      let bodyDone: Promise<string> | undefined;
      await expect(runOpenAiBrowserFlow(({ url }) => {
        const authorize = new URL(url);
        const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
        const state = authorize.searchParams.get('state')!;
        bodyDone = new Promise((resolve, reject) => {
          const request = http.get(
            `${redirect.origin}${redirect.pathname}?error=access_denied&state=${encodeURIComponent(state)}`,
            response => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', chunk => { body += chunk; });
              response.once('end', () => resolve(body));
            },
          );
          request.once('error', reject);
        });
      }, { ports: [0], timeoutMs: 2_000 })).rejects.toThrow(/access_denied/);
      const deniedBody = await bodyDone!;
      expect(deniedBody).toContain('Sign-in failed');
      expect(deniedBody).not.toContain('Authentication successful');
    });

    it('propagates a non-port-conflict listener failure instead of blaming busy ports', async () => {
      await expect(runOpenAiBrowserFlow(vi.fn(), { ports: [-1], timeoutMs: 200 }))
        .rejects.toThrow(/Could not start the OAuth callback listener/);
    });

    it('reports busy ports instead of a raw bind error', async () => {
      const previousOrder = dns.getDefaultResultOrder();
      // Make localhost resolve away from 127.0.0.1 so a hardcoded IPv4 bind misses the blockers.
      dns.setDefaultResultOrder('ipv6first');
      // Retain server objects before awaiting listens so a partial bind never leaks.
      const blockers = [http.createServer(), http.createServer()];
      try {
        const { address } = await dns.promises.lookup('localhost');
        // Ephemeral blockers so the test never claims OpenAI's real 1455/1457.
        await Promise.all(blockers.map(srv =>
          new Promise<void>((resolve, reject) => {
            srv.once('error', reject);
            srv.listen(0, address, resolve);
          }),
        ));
        const busyPorts = blockers.map(srv => (srv.address() as { port: number }).port);
        await expect(runOpenAiBrowserFlow(vi.fn(), { ports: busyPorts, timeoutMs: 200 }))
          .rejects.toThrow(new RegExp(`${busyPorts[0]} and ${busyPorts[1]} are in use`));
      } finally {
        for (const srv of blockers) srv.close();
        dns.setDefaultResultOrder(previousOrder);
      }
    });

    it('treats a port held on the other loopback family as taken and falls back', async () => {
      // A foreign listener on the loopback family our bind does NOT take would
      // receive the browser's localhost redirect while our bind "succeeds" and
      // the flow hangs until timeout.
      const { address: boundFamily } = await dns.promises.lookup('localhost');
      const otherFamily = boundFamily === '::1' ? '127.0.0.1' : '::1';
      const squatter = http.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          squatter.once('error', reject);
          squatter.listen(0, otherFamily, resolve);
        });
      } catch {
        squatter.close();
        return; // Single-family host: the mismatch this test pins cannot occur.
      }
      const squattedPort = (squatter.address() as { port: number }).port;

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'browser_access' }),
      } as Response);

      let advertisedPort = 0;
      try {
        const result = await runOpenAiBrowserFlow(({ url }) => {
          advertisedPort = Number(redirectUriHost(url).split(':')[1]);
          void hitCallback(url, state => `code=auth_code_1&state=${encodeURIComponent(state)}`);
        }, { ports: [squattedPort, 0], timeoutMs: 5_000 });
        expect(advertisedPort).not.toBe(squattedPort);
        expect(result.tokens.access_token).toBe('browser_access');
      } finally {
        squatter.close();
      }
    });

    it('times out when the browser never completes sign-in', async () => {
      await expect(runOpenAiBrowserFlow(vi.fn(), { ports: [0], timeoutMs: 50 }))
        .rejects.toThrow(/OAuth timeout/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws on a failed token exchange', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 400 } as Response);
      await expect(runOpenAiBrowserFlow(({ url }) => {
        void hitCallback(url, state => `code=auth_code_1&state=${encodeURIComponent(state)}`);
      }, { ports: [0], timeoutMs: 2_000 })).rejects.toThrow(/token exchange failed \(400\)/);
    });
  });

  describe('runOpenAiDeviceCodeFlow', () => {
    it('handles successful polling loop', async () => {
      // 1. Device initiation response
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_auth_id: 'auth_id',
          user_code: 'user_code',
          interval: '1',
          expires_in: 60,
        }),
      } as Response);

      // 2. First polling attempt: authorization pending (403)
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 403,
      } as Response);

      // 3. Second polling attempt: user authorized (200 OK)
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_code: 'auth_code', code_verifier: 'verifier' }),
      } as Response);

      // 4. Token exchange response
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'final_access_token' }),
      } as Response);

      const onDeviceCode = vi.fn();
      const sleep = vi.fn().mockResolvedValue(undefined);
      let time = 1000;
      const now = vi.fn(() => time);

      const promise = runOpenAiDeviceCodeFlow(onDeviceCode, { sleep, now });
      
      // Advance time for the loop
      time = 2000;
      
      const result = await promise;

      expect(onDeviceCode).toHaveBeenCalledWith({
        url: 'https://auth.openai.com/codex/device',
        userCode: 'user_code',
      });
      expect(sleep).toHaveBeenCalledWith(expect.any(Number)); // Called after the 403
      expect(result.tokens.access_token).toBe('final_access_token');
    });

    it('throws if device initiation fails', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      await expect(runOpenAiDeviceCodeFlow(vi.fn())).rejects.toThrow('Failed to initiate OpenAI device authorization');
    });

    it('throws if polling hits an unexpected error (e.g. 500)', async () => {
      // 1. Device initiation
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ device_auth_id: 'auth_id', user_code: 'user_code', interval: '1', expires_in: 60 }),
      } as Response);

      // 2. Polling fails with 500
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      await expect(runOpenAiDeviceCodeFlow(vi.fn())).rejects.toThrow('OpenAI device authorization failed (500)');
    });

    it('throws if device authorization times out', async () => {
      // 1. Device initiation (succeeds)
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ device_auth_id: 'auth_id', user_code: 'user_code', interval: '1', expires_in: 0 }),
      } as Response);
      
      // 2. Polling loop (fails with 403 authorization pending, but we time out)
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 403,
      } as Response);

      let time = 1000;
      const now = vi.fn(() => time);
      const sleep = vi.fn(async (ms) => {
        time += ms;
      });

      await expect(runOpenAiDeviceCodeFlow(vi.fn(), { sleep, now })).rejects.toThrow('OpenAI device authorization timed out');
    });
  });
});
