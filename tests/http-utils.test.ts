import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { clientDisconnected, readBody, ResponseCompleted, watchClientDisconnect } from '../src/http-utils.js';

function mockRequest(body: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  queueMicrotask(() => {
    req.emit('data', body);
    req.emit('end');
  });
  return req;
}

describe('readBody content-encoding decoding', () => {
  const payload = JSON.stringify({ model: 'gpt-4o', input: 'hello' });

  it('returns plain bodies unchanged', async () => {
    const out = await readBody(mockRequest(Buffer.from(payload)));
    expect(JSON.parse(out)).toEqual({ model: 'gpt-4o', input: 'hello' });
  });

  it('decompresses zstd request bodies (Codex Desktop openai provider)', async () => {
    const out = await readBody(mockRequest(zstdCompressSync(Buffer.from(payload)), { 'content-encoding': 'zstd' }));
    expect(JSON.parse(out)).toEqual({ model: 'gpt-4o', input: 'hello' });
  });

  it('decompresses gzip request bodies', async () => {
    const out = await readBody(mockRequest(gzipSync(Buffer.from(payload)), { 'content-encoding': 'gzip' }));
    expect(JSON.parse(out)).toEqual({ model: 'gpt-4o', input: 'hello' });
  });

  it('treats identity encoding as plain text', async () => {
    const out = await readBody(mockRequest(Buffer.from(payload), { 'content-encoding': 'identity' }));
    expect(JSON.parse(out)).toEqual({ model: 'gpt-4o', input: 'hello' });
  });
});

/**
 * `watchClientDisconnect` decides whether the upstream work a request started
 * should be cancelled, and guarantees the controller reaches end of life
 * aborted on every path. Both directions are pinned here: a normal finish
 * aborts with `ResponseCompleted` and is not a disconnect, while a client that
 * goes away aborts with `Client disconnected` and is — including the
 * disconnect that arrives after the response has already started streaming,
 * which is what a user pressing Ctrl-C part-way through an answer produces.
 */
describe('watchClientDisconnect', () => {
  interface Observation {
    aborted: boolean;
    reason: unknown;
    disconnected: boolean;
    headersSent: boolean;
  }

  async function listen(server: Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    return `http://127.0.0.1:${address.port}/`;
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }

  it('aborts a normally completed response with the completion reason, not a disconnect', async () => {
    let settle!: (observation: Observation) => void;
    const observed = new Promise<Observation>(resolve => { settle = resolve; });
    const server = createServer((_req, res) => {
      const controller = watchClientDisconnect(res);
      res.on('close', () => settle({
        aborted: controller.signal.aborted,
        reason: controller.signal.reason,
        disconnected: clientDisconnected(controller.signal),
        headersSent: res.headersSent,
      }));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    try {
      const url = await listen(server);
      const response = await fetch(url);
      expect(await response.text()).toBe('ok');
      const observation = await observed;
      // The controller must not survive the request unaborted: every exit path
      // ends it, so consumer abort listeners run at a known point.
      expect(observation.aborted).toBe(true);
      expect(observation.reason).toBeInstanceOf(ResponseCompleted);
      expect((observation.reason as Error).message).toBe('Response completed');
      // ...but a finished response is not a client that went away, and the
      // callers that stay silent about cancelled requests must still speak up
      // for this one.
      expect(observation.disconnected).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it('aborts when the client disconnects before the response starts', async () => {
    let settle!: (observation: Observation) => void;
    const observed = new Promise<Observation>(resolve => { settle = resolve; });
    let arrived!: () => void;
    const received = new Promise<void>(resolve => { arrived = resolve; });
    const server = createServer((_req, res) => {
      const controller = watchClientDisconnect(res);
      res.on('close', () => settle({
        aborted: controller.signal.aborted,
        reason: controller.signal.reason,
        disconnected: clientDisconnected(controller.signal),
        headersSent: res.headersSent,
      }));
      arrived();
      // Never answer: only the client going away can end this request.
    });

    try {
      const url = await listen(server);
      const client = new AbortController();
      const request = fetch(url, { signal: client.signal }).catch(() => undefined);
      await received;
      client.abort();
      const observation = await observed;
      expect(observation.headersSent).toBe(false);
      expect(observation.aborted).toBe(true);
      expect((observation.reason as Error).message).toBe('Client disconnected');
      expect(observation.reason).not.toBeInstanceOf(ResponseCompleted);
      expect(observation.disconnected).toBe(true);
      await request;
    } finally {
      await closeServer(server);
    }
  });

  it('aborts when the client disconnects mid-stream, after headers are sent', async () => {
    let settle!: (observation: Observation) => void;
    const observed = new Promise<Observation>(resolve => { settle = resolve; });
    const server = createServer((_req, res) => {
      const controller = watchClientDisconnect(res);
      res.on('close', () => settle({
        aborted: controller.signal.aborted,
        reason: controller.signal.reason,
        disconnected: clientDisconnected(controller.signal),
        headersSent: res.headersSent,
      }));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      // Leave the stream open, exactly as a partially-delivered answer does.
    });

    try {
      const url = await listen(server);
      const client = new AbortController();
      const response = await fetch(url, { signal: client.signal });
      const reader = response.body!.getReader();
      // Reading a chunk proves the response is past its headers and streaming.
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('first');
      client.abort();
      const observation = await observed;
      expect(observation.headersSent).toBe(true);
      expect(observation.aborted).toBe(true);
      expect((observation.reason as Error).message).toBe('Client disconnected');
      expect(observation.reason).not.toBeInstanceOf(ResponseCompleted);
      expect(observation.disconnected).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});
