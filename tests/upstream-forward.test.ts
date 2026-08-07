// tests/upstream-forward.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Transform } from 'node:stream';
import {
  anthropicUpstreamHeaders,
  fetchWithOAuthRetry,
  anthropicSseModelRewrite,
  relayAnthropicMessages,
} from '../src/upstream-forward.js';

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

  it('adds Claude Code session header for OAuth requests', () => {
    expect(anthropicUpstreamHeaders(
      'oauth-token',
      true,
      'oauth-2025-04-20',
      'oauth',
      'session-123',
    )).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'User-Agent': 'claude-cli/2.1.195 (external, cli)',
      'x-app': 'cli',
      'X-Claude-Code-Session-Id': 'session-123',
    });
  });

  it('omits authentication headers for anonymous requests', () => {
    const headers = anthropicUpstreamHeaders('', false, undefined, 'none', undefined, {
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
      undefined,
      'oauth',
      undefined,
      { 'X-Plan': 'coding' },
    )).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'X-Plan': 'coding',
    });
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
});
