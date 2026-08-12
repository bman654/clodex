// tests/upstream-forward.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Writable, type Transform } from 'node:stream';
import {
  anthropicUpstreamHeaders,
  fetchWithOAuthRetry,
  anthropicSseModelRewrite,
  relayAnthropicMessages,
} from '../src/upstream-forward.js';
import {
  extractConfiguredBetaTokens,
  isAnthropicBetaHeaderName,
  normalizeBetaTokens,
  resolveOutboundBeta,
} from '../src/anthropic-beta-policy.js';

/** Header names that would only ever be present to simulate a native Claude client. */
const NATIVE_IDENTITY_HEADER_NAMES = [
  'User-Agent',
  'user-agent',
  'x-app',
  'X-App',
  'X-Claude-Code-Session-Id',
  'x-claude-code-session-id',
];

function expectNoSynthesizedIdentity(headers: Record<string, string>): void {
  for (const name of NATIVE_IDENTITY_HEADER_NAMES) {
    expect(headers).not.toHaveProperty(name);
  }
  expect(JSON.stringify(headers)).not.toContain('claude-cli');
}

describe('anthropicUpstreamHeaders', () => {
  it('includes bearer and x-api-key', () => {
    expect(anthropicUpstreamHeaders('secret-key')).toMatchObject({
      Authorization: 'Bearer secret-key',
      'x-api-key': 'secret-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('adds stream accept header when requested', () => {
    expect(anthropicUpstreamHeaders('secret-key', true).Accept).toBe('text/event-stream');
  });

  // Supersedes "adds Claude Code session header for OAuth requests": no supported
  // producer emits routed claude-code OAuth, so the identity that header simulated
  // has no lineage to stand on. The credential scheme it rode alongside is retained
  // by the assertions below.
  it('sends OAuth as Bearer without x-api-key and without synthesized identity', () => {
    const headers = anthropicUpstreamHeaders('oauth-token', true, 'oauth');
    expect(headers).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'anthropic-version': '2023-06-01',
      Accept: 'text/event-stream',
    });
    expect(headers).not.toHaveProperty('x-api-key');
    expectNoSynthesizedIdentity(headers);
  });

  it('emits no anthropic-beta when the provider configures none', () => {
    for (const authType of ['api', 'oauth', 'none'] as const) {
      const headers = anthropicUpstreamHeaders('token', false, authType, { 'X-Plan': 'coding' });
      expect(headers).not.toHaveProperty('anthropic-beta');
      expect(Object.keys(headers).some(isAnthropicBetaHeaderName)).toBe(false);
    }
  });

  it('emits exactly the configured beta, merging case-variant header names', () => {
    const headers = anthropicUpstreamHeaders('token', false, 'api', {
      'Anthropic-Beta': ' alpha-2026-01-01 , beta-2026-02-02 ,, alpha-2026-01-01 ',
      'anthropic-beta': 'beta-2026-02-02,Gamma-2026-03-03',
    });
    // Stable first-seen order, exact-token dedupe, preserved token case, one header only.
    expect(headers['anthropic-beta']).toBe('alpha-2026-01-01,beta-2026-02-02,Gamma-2026-03-03');
    expect(Object.keys(headers).filter(isAnthropicBetaHeaderName)).toEqual(['anthropic-beta']);
    expect(headers).not.toHaveProperty('Anthropic-Beta');
  });

  it('omits authentication headers for anonymous requests', () => {
    const headers = anthropicUpstreamHeaders('', false, 'none', {
      authorization: 'Bearer configured-secret',
      'X-API-Key': 'configured-secret',
      Cookie: 'session=configured-secret',
      'Proxy-Authorization': 'Bearer configured-secret',
      'X-Auth-Token': 'configured-secret',
      'X-Client-Secret': 'configured-secret',
      'X-Credential-Id': 'configured-secret',
      'X-Custom': 'preserved',
    });

    for (const name of [
      'Authorization',
      'authorization',
      'x-api-key',
      'X-API-Key',
      'Cookie',
      'Proxy-Authorization',
      'X-Auth-Token',
      'X-Client-Secret',
      'X-Credential-Id',
    ]) {
      expect(headers).not.toHaveProperty(name);
    }
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'X-Custom': 'preserved',
    });
  });

  it('preserves configured provider headers for authenticated requests', () => {
    expect(anthropicUpstreamHeaders(
      'oauth-token',
      false,
      'oauth',
      { 'X-Plan': 'coding' },
    )).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'X-Plan': 'coding',
    });
  });

  it('keeps a configured beta on an anonymous route while still dropping credentials', () => {
    const headers = anthropicUpstreamHeaders('', false, 'none', {
      'ANTHROPIC-BETA': 'alpha-2026-01-01',
      Authorization: 'Bearer configured-secret',
    });
    expect(headers['anthropic-beta']).toBe('alpha-2026-01-01');
    expect(headers).not.toHaveProperty('Authorization');
    expectNoSynthesizedIdentity(headers);
  });
});

describe('route-owned credential headers cannot collide', () => {
  /** Every configured spelling that normalizes to one wire header name. */
  const spellingsOf = (headers: Record<string, string>, name: string) =>
    Object.keys(headers).filter(key => key.trim().toLowerCase() === name);

  const COLLIDING = {
    authorization: 'Bearer configured-secret',
    Authorization: 'Bearer configured-secret-2',
    AUTHORIZATION: 'Bearer configured-secret-3',
    'x-api-key': 'configured-secret',
    'X-API-Key': 'configured-secret-2',
    'X-Api-Key ': 'configured-secret-3',
    'X-Plan': 'coding',
    'Anthropic-Beta': 'cfg-a',
  };

  it('lets an API-key route own both credential headers outright', () => {
    const headers = anthropicUpstreamHeaders('route-key', false, 'api', { ...COLLIDING });

    expect(spellingsOf(headers, 'authorization')).toEqual(['Authorization']);
    expect(spellingsOf(headers, 'x-api-key')).toEqual(['x-api-key']);
    expect(headers.Authorization).toBe('Bearer route-key');
    expect(headers['x-api-key']).toBe('route-key');
    // Never concatenated with a configured value.
    expect(JSON.stringify(headers)).not.toContain('configured-secret');
    // Ordinary configured headers survive untouched.
    expect(headers['X-Plan']).toBe('coding');
    expect(headers['anthropic-beta']).toBe('cfg-a');
  });

  it('lets an OAuth route own the bearer and carry no configured x-api-key', () => {
    const headers = anthropicUpstreamHeaders('oauth-token', false, 'oauth', { ...COLLIDING });

    expect(spellingsOf(headers, 'authorization')).toEqual(['Authorization']);
    expect(headers.Authorization).toBe('Bearer oauth-token');
    // OAuth authority is bearer-only: a configured x-api-key is not a second
    // credential it may carry.
    expect(spellingsOf(headers, 'x-api-key')).toEqual([]);
    expect(JSON.stringify(headers)).not.toContain('configured-secret');
    expect(headers['X-Plan']).toBe('coding');
  });

  it('keeps the anonymous route credential-free exactly as before', () => {
    const headers = anthropicUpstreamHeaders('', false, 'none', { ...COLLIDING });

    expect(spellingsOf(headers, 'authorization')).toEqual([]);
    expect(spellingsOf(headers, 'x-api-key')).toEqual([]);
    expect(headers['X-Plan']).toBe('coding');
    expect(headers['anthropic-beta']).toBe('cfg-a');
  });

  it('keeps the retry attempts collision-free and otherwise identical', async () => {
    const refreshToken = vi.fn(async () => 'refreshed-token');
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response('nope', { status: 401 })
        : new Response(JSON.stringify({ id: 'm', type: 'message', model: 'm', content: [] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
    }));
    const res = new Writable({ write(_c, _e, cb) { cb(); } }) as never as Record<string, unknown>;
    res.writeHead = () => res;
    res.end = () => undefined;

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'm' },
      'stale-token',
      false,
      { authType: 'oauth', refreshToken, extraHeaders: { ...COLLIDING } },
    );

    const attempts = vi.mocked(fetch).mock.calls.map(
      ([, init]) => (init?.headers ?? {}) as Record<string, string>,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.Authorization).toBe('Bearer stale-token');
    expect(attempts[1]!.Authorization).toBe('Bearer refreshed-token');
    for (const headers of attempts) {
      expect(spellingsOf(headers, 'authorization')).toEqual(['Authorization']);
      expect(spellingsOf(headers, 'x-api-key')).toEqual([]);
      expect(JSON.stringify(headers)).not.toContain('configured-secret');
      expect(headers['anthropic-beta']).toBe('cfg-a');
    }
    vi.unstubAllGlobals();
  });
});

describe('anthropic beta policy tokens', () => {
  it('normalizes list and comma forms into stable-order exact tokens', () => {
    expect(normalizeBetaTokens(undefined)).toEqual([]);
    expect(normalizeBetaTokens('')).toEqual([]);
    expect(normalizeBetaTokens(' , ,, ')).toEqual([]);
    expect(normalizeBetaTokens('b , a,b')).toEqual(['b', 'a']);
    expect(normalizeBetaTokens([' b ', 'a,b', 'C'])).toEqual(['b', 'a', 'C']);
    // Exact-token dedupe: case variants are distinct upstream identifiers.
    expect(normalizeBetaTokens('alpha,ALPHA')).toEqual(['alpha', 'ALPHA']);
  });

  it('extracts and resolves configured beta case-insensitively', () => {
    expect(isAnthropicBetaHeaderName(' Anthropic-Beta ')).toBe(true);
    expect(isAnthropicBetaHeaderName('anthropic-beta-extra')).toBe(false);
    expect(extractConfiguredBetaTokens(undefined)).toEqual([]);
    expect(extractConfiguredBetaTokens({ 'X-Plan': 'coding' })).toEqual([]);
    expect(extractConfiguredBetaTokens({ 'ANTHROPIC-BETA': 'a,b', 'Anthropic-Beta': 'b,c' }))
      .toEqual(['a', 'b', 'c']);
    expect(resolveOutboundBeta(undefined)).toEqual({ source: 'none' });
    expect(resolveOutboundBeta({ 'anthropic-beta': ' , ' })).toEqual({ source: 'none' });
    expect(resolveOutboundBeta({ 'Anthropic-Beta': 'a, b' }))
      .toEqual({ source: 'configured', value: 'a,b' });
  });
});

describe('fetchWithOAuthRetry', () => {
  it('refreshes once on 401 and retries with the refreshed token', async () => {
    const refreshToken = vi.fn(async () => 'new-token');
    const cancel = vi.fn(async () => {});
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 401, body: { cancel } })
      .mockResolvedValueOnce({ status: 200 });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(200);
    expect(result.apiKey).toBe('new-token');
    expect(result.refreshed).toBe(true);
    expect(refreshToken).toHaveBeenCalledWith('old-token');
    expect(request).toHaveBeenNthCalledWith(1, 'old-token');
    expect(request).toHaveBeenNthCalledWith(2, 'new-token');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['the rejected token', 'old-token'],
    ['no token', null],
  ])('does not retry when resolution returns %s', async (_label, resolved) => {
    const refreshToken = vi.fn(async () => resolved);
    const cancel = vi.fn(async () => {});
    const request = vi.fn().mockResolvedValue({ status: 401, body: { cancel } });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(401);
    expect(result.refreshed).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('returns a second 401 without entering another refresh loop', async () => {
    const refreshToken = vi.fn(async () => 'new-token');
    const request = vi.fn().mockResolvedValue({ status: 401 });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(401);
    expect(result.apiKey).toBe('new-token');
    expect(result.refreshed).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

describe('anthropicSseModelRewrite', () => {
  const collect = async (transform: Transform, chunks: string[]): Promise<string> => {
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    for (const chunk of chunks) transform.write(Buffer.from(chunk, 'utf8'));
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });
    return Buffer.concat(out).toString('utf8');
  };

  const messageStart = 'event: message_start\n'
    + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":1}}}\n\n';
  const textDelta = 'event: content_block_delta\n'
    + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"model claude-sonnet-4-5"}}\n\n';

  it('rewrites only the message_start model and passes every other byte through', async () => {
    const out = await collect(anthropicSseModelRewrite('clodex:acme:sonnet[200k]'), [messageStart + textDelta]);
    expect(out).toContain('"model":"clodex:acme:sonnet[200k]"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Content text mentioning the upstream id is untouched.
    expect(out).toContain('"text":"model claude-sonnet-4-5"');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('rewrites a message_start split across chunk boundaries mid-field', async () => {
    const whole = messageStart + textDelta;
    const split = whole.indexOf('"model":"claude') + 12;
    const out = await collect(
      anthropicSseModelRewrite('alias-x'),
      [whole.slice(0, split), whole.slice(split)],
    );
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
  });

  it('passes malformed data lines through unchanged', async () => {
    const malformed = 'data: {"type":"message_start","message":{oops\n\n';
    const out = await collect(anthropicSseModelRewrite('alias-x'), [malformed]);
    expect(out).toBe(malformed);
  });

  it('keeps CRLF line endings on the line it rewrites', async () => {
    // Splitting on \n leaves the \r on every line. Dropping it only from the
    // rewritten line would emit a stream with mixed endings, which is a framing
    // change rather than a model-id change.
    const crlf = 'event: message_start\r\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\n\r\n';
    const out = await collect(anthropicSseModelRewrite('alias-x'), [crlf]);
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Every original line ending survives: no bare \n was introduced.
    expect(out.split('\n').length).toBe(crlf.split('\n').length);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  // Collect what reached the client *before* the stream ended, which is what a
  // relay is for. `collect` cannot see a stall: it ends the transform, so a
  // transform that emitted nothing until flush still returns the whole body.
  const collectBeforeEnd = async (
    transform: Transform,
    chunks: string[],
  ): Promise<{ streamed: string; total: string }> => {
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    for (const chunk of chunks) transform.write(Buffer.from(chunk, 'utf8'));
    await new Promise(resolve => setImmediate(resolve));
    const streamed = Buffer.concat(out).toString('utf8');
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });
    return { streamed, total: Buffer.concat(out).toString('utf8') };
  };

  const crOnly = 'event: message_start\r'
    + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\r'
    + 'event: ping\rdata: {"type":"ping"}\r\r';

  it('frames a CR-delimited stream instead of holding it until the upstream closes', async () => {
    // SSE terminates a line with CRLF, LF, or a bare CR. Splitting on \n alone
    // finds no line boundary at all in a CR-framed stream, so every byte
    // accumulates in the tail buffer and the client receives nothing until the
    // upstream closes — a stalled relay, not just a missed rewrite.
    const { streamed } = await collectBeforeEnd(anthropicSseModelRewrite('alias-x'), [crOnly]);
    expect(streamed).not.toBe('');
    expect(streamed).toContain('"model":"alias-x"');
  });

  it('emits a complete CR-delimited event before the upstream closes', async () => {
    const event = 'event: message_start\r'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\r';
    const { streamed } = await collectBeforeEnd(anthropicSseModelRewrite('alias-x'), [event]);
    expect(streamed).toBe(event.replace('"model":"claude-sonnet-4-5"', '"model":"alias-x"'));
  });

  it('keeps CR-only line endings on the line it rewrites', async () => {
    const out = await collect(anthropicSseModelRewrite('alias-x'), [crOnly]);
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Framing is preserved exactly: no \n was introduced and no \r was lost.
    expect(out).not.toContain('\n');
    expect(out.split('\r').length).toBe(crOnly.split('\r').length);
  });

  it('does not split a CRLF whose halves land in different chunks', async () => {
    // Holding the trailing CR keeps a split CRLF as one internal delimiter in
    // spec-shaped framing; the emitted bytes are equivalent without the guard.
    const crlf = 'event: message_start\r\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\n\r\n';
    const boundary = crlf.indexOf('\r\n') + 1;
    const out = await collect(
      anthropicSseModelRewrite('alias-x'),
      [crlf.slice(0, boundary), crlf.slice(boundary)],
    );
    expect(out).toContain('"model":"alias-x"');
    expect(out.replace(/\r\n/g, '')).not.toContain('\r');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out.split('\r\n').length).toBe(crlf.split('\r\n').length);
  });

  it('passes an LF stream through with its framing byte-for-byte', async () => {
    // Conservation for the ending Anthropic actually sends.
    const out = await collect(anthropicSseModelRewrite('alias-x'), [messageStart + textDelta]);
    expect(out).not.toContain('\r');
    expect(out).toBe((messageStart + textDelta).replace('"model":"claude-sonnet-4-5"', '"model":"alias-x"'));
  });
});

describe('relayAnthropicMessages responseModelOverride', () => {
  const makeRes = () => {
    const chunks: Buffer[] = [];
    let headers: Record<string, string> = {};
    let status = 0;
    const res = {
      writeHead(code: number, hdrs: Record<string, string>) { status = code; headers = hdrs; return res; },
      write(chunk: unknown) { chunks.push(Buffer.from(chunk as Buffer)); return true; },
      end(chunk?: unknown) { if (chunk) chunks.push(Buffer.from(chunk as Buffer)); res.finished = true; res.emit?.('finish'); },
      destroy() { /* noop */ },
      on() { return res; },
      once() { return res; },
      emit() { return false; },
      removeListener() { return res; },
      finished: false,
      body: () => Buffer.concat(chunks).toString('utf8'),
      status: () => status,
      headers: () => headers,
    };
    return res;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites the JSON body model to the requested id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-sonnet-4-5', content: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.status()).toBe(200);
    const body = JSON.parse(res.body()) as { model: string };
    expect(body.model).toBe('clodex:acme:sonnet[200k]');
    expect(res.headers()['Content-Length']).toBe(String(Buffer.byteLength(res.body())));
  });

  it('leaves the JSON body untouched without an override', async () => {
    const raw = JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-sonnet-4-5', content: [] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      {},
    );
    expect(res.body()).toBe(raw);
  });

  it('leaves a non-message JSON envelope untouched even with an override', async () => {
    // The SSE path only ever rewrites `message_start`; the JSON path must agree
    // and only rewrite an Anthropic Message. An error envelope that happens to
    // carry a `model` is not the assistant's answer, and rewriting it would
    // misreport which model produced the failure.
    const raw = JSON.stringify({
      type: 'error',
      model: 'claude-sonnet-4-5',
      error: { type: 'overloaded_error', message: 'upstream busy' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.body()).toBe(raw);
    expect(res.body()).not.toContain('clodex:acme:sonnet[200k]');
  });

  it('leaves a count_tokens-shaped body untouched even with an override', async () => {
    const raw = JSON.stringify({ input_tokens: 42, model: 'claude-sonnet-4-5' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages/count_tokens',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.body()).toBe(raw);
  });
});

describe('relayAnthropicMessages streaming', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A REAL Writable, unlike the object mock above: the streaming path reaches
   * the client through `.pipe(res)`, so a plain object never exercises it.
   * That is the gap this suite had — `anthropicSseModelRewrite` was well
   * covered directly, but deleting the `.pipe(...)` that installs it in the
   * relay left every test green.
   */
  function makeStreamRes() {
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: Record<string, string> = {};
    const res = new Writable({
      write(chunk: Buffer, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }) as Writable & {
      writeHead: (code: number, hdrs?: Record<string, string>) => unknown;
      body: () => string;
      status: () => number;
      headers: () => Record<string, string>;
    };
    res.writeHead = (code, hdrs) => { status = code; headers = hdrs ?? {}; return res; };
    res.body = () => Buffer.concat(chunks).toString('utf8');
    res.status = () => status;
    res.headers = () => headers;
    return res;
  }

  const SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","model":"qwen3.8-max","content":[]}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  it('pipes the streaming body through the model rewrite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'qwen3.8-max', stream: true },
      'key',
      true,
      { responseModelOverride: 'clodex:opencode-go:qwen3.8-max[1m]' },
    );
    await done;

    expect(res.status()).toBe(200);
    expect(res.headers()['Content-Type']).toBe('text/event-stream');
    const body = res.body();
    // The echo invariant: the client sees back exactly the id it asked for.
    expect(body).toContain('"model":"clodex:opencode-go:qwen3.8-max[1m]"');
    expect(body).not.toContain('"model":"qwen3.8-max"');
    // Every other line survives byte-for-byte.
    expect(body).toContain('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}');
    expect(body).toContain('event: message_stop');
  });

  it('streams through untouched without an override', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'qwen3.8-max', stream: true },
      'key',
      true,
      {},
    );
    await done;

    expect(res.body()).toBe(SSE);
  });
});

describe('relayAnthropicMessages outbound headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeStreamRes() {
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk: Buffer, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }) as Writable & { writeHead: (code: number, hdrs?: Record<string, string>) => unknown };
    res.writeHead = () => res;
    return res;
  }

  const capturedHeaders = () => vi.mocked(fetch).mock.calls.map(
    ([, init]) => (init?.headers ?? {}) as Record<string, string>,
  );

  it('carries the configured beta and no client identity on the JSON path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', model: 'm', content: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const res = new Writable({ write(_c, _e, cb) { cb(); } }) as never as {
      writeHead: (code: number, hdrs?: Record<string, string>) => unknown;
    };
    (res as { writeHead: unknown }).writeHead = () => res;
    (res as unknown as { end: unknown }).end = () => undefined;

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'm' },
      'oauth-token',
      false,
      { authType: 'oauth', extraHeaders: { 'Anthropic-Beta': 'alpha-2026-01-01' } },
    );

    const [headers] = capturedHeaders();
    expect(headers!['anthropic-beta']).toBe('alpha-2026-01-01');
    expect(headers!.Authorization).toBe('Bearer oauth-token');
    expect(headers).not.toHaveProperty('x-api-key');
    expectNoSynthesizedIdentity(headers!);
  });

  it('sends byte-identical headers on the streaming and refresh-retry attempts', async () => {
    const refreshToken = vi.fn(async () => 'refreshed-token');
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response('nope', { status: 401 })
        : new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
            status: 200, headers: { 'Content-Type': 'text/event-stream' },
          });
    }));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'm', stream: true },
      'stale-token',
      true,
      {
        authType: 'oauth',
        refreshToken,
        extraHeaders: { 'ANTHROPIC-BETA': 'alpha-2026-01-01,alpha-2026-01-01' },
      },
    );
    await done;

    const [first, second] = capturedHeaders();
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(first!.Authorization).toBe('Bearer stale-token');
    expect(second!.Authorization).toBe('Bearer refreshed-token');
    for (const headers of [first!, second!]) {
      expect(headers['anthropic-beta']).toBe('alpha-2026-01-01');
      expect(headers.Accept).toBe('text/event-stream');
      expectNoSynthesizedIdentity(headers);
    }
    // Everything except the credential is identical across the retry.
    const stripAuth = (h: Record<string, string>) => {
      const { Authorization: _drop, ...rest } = h;
      return rest;
    };
    expect(stripAuth(second!)).toEqual(stripAuth(first!));
  });

  it('offers no option channel for a client-supplied beta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', model: 'm', content: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const res = new Writable({ write(_c, _e, cb) { cb(); } }) as never as Record<string, unknown>;
    res.writeHead = () => res;
    res.end = () => undefined;

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'm' },
      'key',
      false,
      // A caller cannot pass an inbound/client beta: the option does not exist,
      // and an unknown property is inert rather than forwarded.
      { authType: 'api' } as Record<string, never>,
    );

    const [headers] = capturedHeaders();
    expect(headers).not.toHaveProperty('anthropic-beta');
    expectNoSynthesizedIdentity(headers!);
  });
});
