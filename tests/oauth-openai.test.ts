import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import {
  buildOpenAiAuthorizeUrl,
  extractOpenAiAccountId,
  pollOpenAiDeviceCodeToken,
  refreshOpenAiAccessToken,
  requestOpenAiDeviceCode,
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function responseWithStalledJsonBody(init?: RequestInit): Response {
    const signal = init?.signal;
    const body = new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { ok: true, status: 200, json: () => body } as Response;
  }

  async function expectErrorAtTimeout(
    operation: Promise<unknown>,
    timeoutMs: number,
    message: string,
  ): Promise<void> {
    const pending = Symbol('pending');
    let outcome: unknown = pending;
    void operation.then(
      value => { outcome = value; },
      error => { outcome = error; },
    );

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(outcome).toBe(pending);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(message);
  }

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

    it('reports ignored stale callbacks when sign-in times out', async () => {
      let resolveCallback!: (status: number) => void;
      let rejectCallback!: (error: unknown) => void;
      const callbackResponse = new Promise<number>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      });
      const flow = runOpenAiBrowserFlow(({ url }) => {
        void hitCallback(url, () => 'code=stale&state=stale').then(resolveCallback, rejectCallback);
      }, { ports: [0], timeoutMs: 50 });

      expect(await callbackResponse).toBe(400);
      await expect(flow).rejects.toThrow(
        'OAuth timeout — ignored 1 callback(s) carrying a different sign-in state; '
        + 'you probably completed an older browser tab. Run the command again and use the newest tab.',
      );
      expect(global.fetch).not.toHaveBeenCalled();
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
        // Pin the message exactly, not as a substring: it must state the observed fact (the
        // ports are busy) and never assert a cause we did not observe. toThrow(string) matches a
        // substring, so appended copy would slip through — compare the Error for equality.
        await expect(runOpenAiBrowserFlow(vi.fn(), { ports: busyPorts, timeoutMs: 200 }))
          .rejects.toThrowError(new Error(
            `Ports ${busyPorts[0]} and ${busyPorts[1]} are in use — browser sign-in needs one free. `
            + 'Check for another OpenAI sign-in (e.g. `codex login`), or any other process '
            + 'holding them, then try again.',
          ));
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
        .rejects.toThrow('OAuth timeout — browser closed without completing sign-in');
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
    it('aborts device-code initiation when the response body stalls', async () => {
      vi.useFakeTimers();
      vi.mocked(global.fetch).mockImplementationOnce(async (_input, init) =>
        responseWithStalledJsonBody(init),
      );

      const request = requestOpenAiDeviceCode();

      await expectErrorAtTimeout(
        request,
        30_000,
        'OpenAI device authorization timed out while requesting a sign-in code',
      );
      expect(global.fetch).toHaveBeenCalledWith(
        'https://auth.openai.com/api/accounts/deviceauth/usercode',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('aborts a stalled device-token poll at the device-code deadline', async () => {
      vi.useFakeTimers();
      vi.mocked(global.fetch).mockImplementationOnce(async (_input, init) =>
        responseWithStalledJsonBody(init),
      );

      const poll = pollOpenAiDeviceCodeToken({
        device_auth_id: 'auth_id',
        user_code: 'user_code',
        interval: '1',
        // Synthetic short lifetime to exercise the deadline boundary quickly.
        expires_in: 5,
      });

      await expectErrorAtTimeout(poll, 5_000, 'OpenAI device authorization timed out');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://auth.openai.com/api/accounts/deviceauth/token',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('preserves a non-timeout error from the device token exchange', async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ authorization_code: 'auth_code', code_verifier: 'verifier' }),
        } as Response)
        .mockResolvedValueOnce({ ok: false, status: 400 } as Response);

      const exchange = pollOpenAiDeviceCodeToken({
        device_auth_id: 'auth_id',
        user_code: 'user_code',
        interval: '1',
      });

      const error = await exchange.catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).constructor).toBe(Error);
      expect((error as Error).message).toBe('OpenAI token exchange failed (400)');
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const exchangeSignal = vi.mocked(global.fetch).mock.calls[1]?.[1]?.signal as AbortSignal;
      expect(exchangeSignal.aborted).toBe(true);
      expect(exchangeSignal.reason).toMatchObject({
        name: 'Error',
        message: 'OAuth request completed',
      });
    });

    it('aborts a stalled authorization-code exchange after 30 seconds', async () => {
      vi.useFakeTimers();
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ authorization_code: 'auth_code', code_verifier: 'verifier' }),
        } as Response)
        .mockImplementationOnce(async (_input, init) => responseWithStalledJsonBody(init));

      const exchange = pollOpenAiDeviceCodeToken({
        device_auth_id: 'auth_id',
        user_code: 'user_code',
        interval: '1',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      await expectErrorAtTimeout(exchange, 30_000, 'OpenAI token exchange timed out');
      expect(global.fetch).toHaveBeenLastCalledWith(
        'https://auth.openai.com/oauth/token',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('lets a healthy token exchange finish after the device-code deadline', async () => {
      vi.useFakeTimers();
      let now = 0;
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            now = 4_900;
            return { authorization_code: 'auth_code', code_verifier: 'verifier' };
          },
        } as Response)
        .mockImplementationOnce(async (_input, init) => new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            now = 5_300;
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ access_token: 'final_access_token' }),
            } as Response);
          }, 400);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          }, { once: true });
        }));

      const exchange = pollOpenAiDeviceCodeToken({
        device_auth_id: 'auth_id',
        user_code: 'user_code',
        interval: '1',
        // Synthetic short lifetime to stage a winning poll 100ms before expiry.
        expires_in: 5,
      }, { now: () => now });
      const pending = Symbol('pending');
      let outcome: unknown = pending;
      void exchange.then(
        value => { outcome = value; },
        error => { outcome = error; },
      );

      await vi.advanceTimersByTimeAsync(399);
      expect(outcome).toBe(pending);
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).not.toBeInstanceOf(Error);
      expect(outcome).toMatchObject({ tokens: { access_token: 'final_access_token' } });
    });

    it('continues polling after one request times out', async () => {
      vi.useFakeTimers();
      vi.mocked(global.fetch)
        .mockImplementationOnce(async (_input, init) => responseWithStalledJsonBody(init))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ authorization_code: 'auth_code', code_verifier: 'verifier' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'final_access_token' }),
        } as Response);

      const poll = pollOpenAiDeviceCodeToken({
        device_auth_id: 'auth_id',
        user_code: 'user_code',
        interval: '1',
      });
      const firstSignal = vi.mocked(global.fetch).mock.calls[0]?.[1]?.signal as AbortSignal;
      const pending = Symbol('pending');
      let outcome: unknown = pending;
      void poll.then(
        value => { outcome = value; },
        error => { outcome = error; },
      );

      await vi.advanceTimersByTimeAsync(29_999);
      expect(firstSignal.aborted).toBe(false);
      expect(outcome).toBe(pending);
      await vi.advanceTimersByTimeAsync(1);
      expect(firstSignal.aborted).toBe(true);
      expect(outcome).toBe(pending);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(outcome).toBe(pending);
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).toMatchObject({ tokens: { access_token: 'final_access_token' } });
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

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

    it('propagates a non-timeout poll failure without retrying', async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new TypeError('fetch failed'));
      let now = 0;
      const sleep = vi.fn(async () => {
        now = 300_000;
      });

      const poll = pollOpenAiDeviceCodeToken({
        device_auth_id: 'auth_id',
        user_code: 'user_code',
        interval: '1',
      }, { sleep, now: () => now });

      await expect(poll).rejects.toThrowError(new TypeError('fetch failed'));
      expect(global.fetch).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
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
