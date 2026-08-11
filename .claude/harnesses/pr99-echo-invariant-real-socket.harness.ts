// zz-pr99-l2-echo.test.ts — PR#99 lens 2: passthrough echo invariant, executed end to end.
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { anthropicSseModelRewrite } from '../src/upstream-forward.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';

// ── Part 1: transform torture ───────────────────────────────────────────────

const drive = async (chunks: (string | Buffer)[], override = 'ALIAS'): Promise<string> => {
  const t = anthropicSseModelRewrite(override);
  const out: Buffer[] = [];
  t.on('data', c => out.push(Buffer.from(c)));
  for (const c of chunks) t.write(typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
  await new Promise<void>((resolve, reject) => {
    t.on('end', resolve);
    t.on('error', reject);
    t.end();
  });
  return Buffer.concat(out).toString('utf8');
};

const START = 'event: message_start\n'
  + 'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"UPSTREAM-ID","content":[],"usage":{"input_tokens":7}}}\n\n';
const PING = 'event: ping\ndata: {"type":"ping"}\n\n';
const DELTA = 'event: content_block_delta\n'
  + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"UPSTREAM-ID"}}\n\n';
const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const FULL = START + PING + DELTA + STOP;

describe('PR99 L2 / anthropicSseModelRewrite torture', () => {
  it('whole-stream in one chunk', async () => {
    const out = await drive([FULL]);
    expect(out).toContain('"model":"ALIAS"');
    expect(out).not.toContain('"model":"UPSTREAM-ID"');
    expect(out).toContain('"text":"UPSTREAM-ID"');
  });

  it('BYTE-BY-BYTE split (1-byte chunks)', async () => {
    const bytes = [...Buffer.from(FULL, 'utf8')].map(b => Buffer.from([b]));
    const out = await drive(bytes);
    expect(out).toContain('"model":"ALIAS"');
    expect(out).not.toContain('"model":"UPSTREAM-ID"');
    // event framing must survive
    expect(out.split('\n\n').length).toBe(FULL.split('\n\n').length);
  });

  it('chunk containing NO newline at all does not stall or drop', async () => {
    // 'data: {' has no newline; the transform must buffer, not emit ''-then-lose.
    const out = await drive(['data: {"type":"message_start","message":{"model":"UPST', 'REAM-ID"}}\n\n']);
    expect(out).toContain('"model":"ALIAS"');
  });

  it('CRLF line endings', async () => {
    const crlf = FULL.replace(/\n/g, '\r\n');
    const out = await drive([crlf]);
    expect(out).toContain('"model":"ALIAS"');
    expect(out).not.toContain('"model":"UPSTREAM-ID"');
    return { out };
  });

  it('reports CRLF byte-level shape', async () => {
    const crlf = 'event: message_start\r\ndata: {"type":"message_start","message":{"model":"UPSTREAM-ID"}}\r\n\r\n';
    const out = await drive([crlf]);
    // eslint-disable-next-line no-console
    console.log('CRLF OUT =', JSON.stringify(out));
    expect(out.length).toBeGreaterThan(0);
  });

  it('multi-byte UTF-8 split across the chunk boundary', async () => {
    const line = 'data: {"type":"message_start","message":{"model":"UPSTREAM-ID","x":"é中"}}\n\n';
    const buf = Buffer.from(line, 'utf8');
    const idx = buf.indexOf(Buffer.from('中', 'utf8')) + 1; // split INSIDE the 3-byte char
    const out = await drive([buf.subarray(0, idx), buf.subarray(idx)]);
    // eslint-disable-next-line no-console
    console.log('UTF8 SPLIT OUT =', JSON.stringify(out));
    expect(out).toContain('"model":"ALIAS"');
    expect(out).toContain('中');
  });

  it('data: with no space after the colon', async () => {
    const out = await drive(['data:{"type":"message_start","message":{"model":"UPSTREAM-ID"}}\n\n']);
    expect(out).toContain('"model":"ALIAS"');
  });

  it('does NOT rewrite a non-message_start event whose text mentions message_start', async () => {
    const line = 'data: {"type":"content_block_delta","delta":{"text":"\\"message_start\\" model","model":"UPSTREAM-ID"}}\n\n';
    const out = await drive([line]);
    expect(out).toBe(line);
  });

  it('reports what happens to a message_start with no trailing newline at EOF', async () => {
    const noNl = 'data: {"type":"message_start","message":{"model":"UPSTREAM-ID"}}';
    const out = await drive([noNl]);
    // eslint-disable-next-line no-console
    console.log('EOF-NO-NEWLINE OUT =', JSON.stringify(out));
    expect(out).toContain('"model":"ALIAS"');
  });

  it('multi-line data: field (SSE spec-legal) — reports behaviour', async () => {
    const multi = 'event: message_start\ndata: {"type":"message_start",\ndata: "message":{"model":"UPSTREAM-ID"}}\n\n';
    const out = await drive([multi]);
    // eslint-disable-next-line no-console
    console.log('MULTILINE OUT =', JSON.stringify(out));
    expect(out).toBe(multi); // documents: untouched
  });
});

// ── Part 2: end-to-end through the real proxy catalog ───────────────────────

interface Upstream { url: string; close: () => Promise<void>; lastBody: () => any }

async function startFakeAnthropic(upstreamModelId: string): Promise<Upstream> {
  let lastBody: any = null;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastBody = { url: req.url, body: JSON.parse(raw || '{}') };
      const wantsStream = Boolean(lastBody.body?.stream);
      if (wantsStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const start = 'event: message_start\n'
          + `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: upstreamModelId, content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`;
        // deliberately split the message_start mid-field across two writes
        const cut = start.indexOf('"model":"') + 11;
        res.write(start.slice(0, cut));
        setTimeout(() => {
          res.write(start.slice(cut));
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        }, 5);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: upstreamModelId, content: [], usage: { input_tokens: 3, output_tokens: 0 } }));
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(r => server.close(() => r())),
    lastBody: () => lastBody,
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const c of cleanups) await c(); });

describe('PR99 L2 / echo invariant end-to-end through startProxyCatalog', () => {
  const UPSTREAM_ID = 'claude-sonnet-4-5-20250929';

  const mkRoute = (aliasId: string, upstreamUrl: string): ProxyRoute => ({
    aliasId,
    realModelId: UPSTREAM_ID,
    displayName: 'Fake Sonnet (Acme)',
    upstreamUrl,
    apiKey: 'test-key',
    modelFormat: 'anthropic',
    contextWindow: 1_000_000,
    providerId: 'acme',
    authType: 'api',
  });

  it.each([
    ['canonical clodex id', 'clodex:acme:sonnet[1m]', 'clodex:acme:sonnet[1m]'],
    ['bare canonical (no suffix)', 'clodex:acme:sonnet', 'clodex:acme:sonnet'],
    ['short alias', 'sol', 'sol'],
    ['masked gateway id', 'anthropic-acme__sonnet[1m]', 'anthropic-acme__sonnet[1m]'],
  ])('%s echoes verbatim, non-streaming and streaming', async (_label, requested, expected) => {
    const up = await startFakeAnthropic(UPSTREAM_ID);
    cleanups.push(up.close);
    const route = mkRoute('clodex:acme:sonnet[1m]', up.url);
    const maskedRoute = mkRoute('anthropic-acme__sonnet[1m]', up.url);
    const handle = await startProxyCatalog(
      [route, maskedRoute],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'sol', routeId: route.aliasId }],
    );
    cleanups.push(async () => { handle.close(); });

    // non-streaming
    const jsonRes = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': handle.token },
      body: JSON.stringify({ model: requested, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    });
    expect(jsonRes.status).toBe(200);
    const json = await jsonRes.json() as { model: string };
    expect(json.model).toBe(expected);
    // request body forwarded with the upstream id
    expect(up.lastBody().body.model).toBe(UPSTREAM_ID);
    expect(up.lastBody().url).toBe('/v1/messages');

    // streaming (upstream splits message_start mid-field)
    const sseRes = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': handle.token },
      body: JSON.stringify({ model: requested, stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    });
    const sse = await sseRes.text();
    expect(sse).toContain(`"model":"${expected}"`);
    expect(sse).not.toContain(`"model":"${UPSTREAM_ID}"`);
  });

  it('DEFAULT-ROUTE FALLBACK: an unrelated model id is echoed back as if it were the served model', async () => {
    const up = await startFakeAnthropic(UPSTREAM_ID);
    cleanups.push(up.close);
    const route = mkRoute('clodex:acme:sonnet[1m]', up.url);
    const handle = await startProxyCatalog([route], route.aliasId);
    cleanups.push(async () => { handle.close(); });

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': handle.token },
      body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    });
    const json = await res.json() as { model: string };
    // eslint-disable-next-line no-console
    console.log('DEFAULT-ROUTE ECHO =', json.model, ' (upstream actually served', UPSTREAM_ID, ')');
    expect(json.model).toBeTypeOf('string');
  });
});
