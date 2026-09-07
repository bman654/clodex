import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';

const voicePath = '/api/ws/speech_to_text/voice_stream?language=en&tag=a%2Fb&tag=two';
const websocketKey = 'dGhlIHNhbXBsZSBub25jZQ==';
const websocketAccept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
const clientFrame = Buffer.from([0x82, 0x84, 1, 2, 3, 4, 1, 0xfd, 0x83, 0x7b]);
const serverFrame = Buffer.from([0x82, 4, 0xff, 0, 0x80, 0x7f]);
const proxyEnvNames = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const;

async function listen(server: net.Server): Promise<number> {
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(5000) });
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return address.port;
}

function waitForClose(socket: Duplex): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const closed = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.off('close', closed);
      reject(new Error('timed out awaiting socket close'));
    }, 3000);
    socket.once('close', closed);
  });
}

function readSocket(socket: Duplex, head = Buffer.alloc(0)) {
  let bytes = Buffer.from(head);
  socket.on('data', (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]); });
  socket.on('error', () => {});
  return {
    bytes: () => bytes,
    waitFor: (complete: (data: Buffer) => boolean): Promise<Buffer> => {
      if (complete(bytes)) return Promise.resolve(bytes);
      return new Promise((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          socket.off('data', check);
          socket.off('close', closed);
          if (error) reject(error);
          else resolve(bytes);
        };
        const check = () => { if (complete(bytes)) finish(); };
        const closed = () => finish(new Error(`socket closed before expected bytes: ${bytes.toString('hex')}`));
        const timer = setTimeout(() => finish(new Error(`timed out awaiting socket bytes: ${bytes.toString('hex')}`)), 3000);
        socket.on('data', check);
        socket.once('close', closed);
        check();
      });
    },
  };
}

async function connectMitm(
  proxyPort: number,
  authority = 'api.anthropic.com:443',
  allowHalfOpen = false,
): Promise<tls.TLSSocket> {
  const raw = net.connect({ port: proxyPort, host: '127.0.0.1', allowHalfOpen });
  raw.on('error', () => {});
  try {
    await once(raw, 'connect', { signal: AbortSignal.timeout(5000) });
    const response = readSocket(raw);
    raw.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const headers = await response.waitFor(bytes => bytes.includes('\r\n\r\n'));
    expect(headers.toString()).toContain('200 Connection Established');
    raw.removeAllListeners('data');
    const secure = tls.connect({
      socket: raw,
      servername: 'api.anthropic.com',
      ca: ensureHttpProxyCertificates().caCert,
    });
    secure.allowHalfOpen = allowHalfOpen;
    secure.on('error', () => {});
    await once(secure, 'secureConnect', { signal: AbortSignal.timeout(5000) });
    return secure;
  } catch (error) {
    raw.destroy();
    throw error;
  }
}

function upgradeRequest(extraHeaders: string[] = []): Buffer {
  return Buffer.from([
    `GET ${voicePath} HTTP/1.1`,
    'Host: api.anthropic.com',
    'Authorization: Bearer synthetic-voice-token',
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Key: ${websocketKey}`,
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: voice-test',
    'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
    ...extraHeaders,
    '',
    '',
  ].join('\r\n'));
}

function upgradeResponse(extraHeaders: string[] = []): Buffer {
  return Buffer.from([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAccept}`,
    'Sec-WebSocket-Protocol: voice-test',
    ...extraHeaders,
    '',
    '',
  ].join('\r\n'));
}

async function startOrigin() {
  const certificates = ensureHttpProxyCertificates();
  const server = https.createServer({ key: certificates.serverKey, cert: certificates.serverCert });
  const sockets = new Set<net.Socket>();
  for (const event of ['connection', 'secureConnection']) {
    server.on(event, (socket: net.Socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
  }
  const port = await listen(server);
  return {
    server,
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function startProxy(originPort: number) {
  return startHttpProxy({
    routes: [],
    anthropicOrigin: `https://127.0.0.1:${originPort}`,
    anthropicRejectUnauthorized: false,
  });
}

beforeEach(() => {
  for (const name of proxyEnvNames) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('first-party WebSocket passthrough', () => {
  it('forwards voice requests without proxy headers and relays binary frames', async () => {
    const origin = await startOrigin();
    let request: http.IncomingMessage | undefined;
    let upstream: Duplex | undefined;
    let received: ReturnType<typeof readSocket> | undefined;
    origin.server.on('upgrade', (req, socket, head) => {
      request = req;
      upstream = socket;
      received = readSocket(socket, head);
      socket.write(upgradeResponse([
        'X-Voice-Test: first',
        'X-Voice-Test: second',
      ]));
    });
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      client.write(upgradeRequest([
        'Proxy-Authorization: Basic synthetic-local-proxy-token',
        'Proxy-Connection: keep-alive',
        'X-Voice-Test: first',
        'X-Voice-Test: second',
      ]));
      const headers = (await response.waitFor(bytes => bytes.includes('\r\n\r\n'))).toString();
      expect(headers).toContain('HTTP/1.1 101 Switching Protocols');
      expect(headers).toContain(`Sec-WebSocket-Accept: ${websocketAccept}\r\n`);
      expect(headers).toContain('Sec-WebSocket-Protocol: voice-test\r\n');
      expect(headers).toContain('X-Voice-Test: first\r\nX-Voice-Test: second\r\n');
      expect(request?.url).toBe(voicePath);
      expect(request?.method).toBe('GET');
      expect(request?.headers).toMatchObject({
        host: 'api.anthropic.com',
        authorization: 'Bearer synthetic-voice-token',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': websocketKey,
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'voice-test',
        'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
      });
      expect(request?.headers['proxy-authorization']).toBeUndefined();
      expect(request?.headers['proxy-connection']).toBeUndefined();
      expect(request?.rawHeaders.filter(value => value === 'X-Voice-Test')).toHaveLength(2);
      client.write(clientFrame);
      expect(await received!.waitFor(bytes => bytes.length >= clientFrame.length)).toEqual(clientFrame);
      upstream!.write(serverFrame);
      const wire = await response.waitFor(bytes => bytes.includes(serverFrame));
      expect(wire.subarray(wire.indexOf('\r\n\r\n') + 4)).toEqual(serverFrame);
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('forwards binary bytes sent with each side of the upgrade handshake', async () => {
    const origin = await startOrigin();
    let received: ReturnType<typeof readSocket> | undefined;
    origin.server.on('upgrade', (_req, socket, head) => {
      received = readSocket(socket, head);
      socket.write(Buffer.concat([upgradeResponse(), serverFrame]));
    });
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      client.write(Buffer.concat([upgradeRequest(), clientFrame]));
      const wire = await response.waitFor(bytes => bytes.includes(serverFrame));
      expect(wire.subarray(0, wire.indexOf('\r\n\r\n') + 4)).toEqual(upgradeResponse());
      expect(wire.subarray(wire.indexOf('\r\n\r\n') + 4)).toEqual(serverFrame);
      expect(await received!.waitFor(bytes => bytes.length >= clientFrame.length)).toEqual(clientFrame);
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('preserves an upstream 401 rejection and its body', async () => {
    const origin = await startOrigin();
    const body = '{"error":"synthetic voice access denied"}';
    origin.server.on('upgrade', (_req, socket) => {
      socket.end([
        'HTTP/1.1 401 Unauthorized',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'WWW-Authenticate: Bearer realm="voice-test"',
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const closed = waitForClose(client);
      client.write(upgradeRequest());
      await closed;
      const wire = response.bytes().toString();
      expect(wire).toContain('HTTP/1.1 401 Unauthorized\r\n');
      expect(wire).toContain('WWW-Authenticate: Bearer realm="voice-test"\r\n');
      expect(wire.slice(wire.indexOf('\r\n\r\n') + 4)).toBe(body);
      expect(wire).not.toContain('101 Switching Protocols');
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('preserves chunk framing for an upstream 403 rejection', async () => {
    const origin = await startOrigin();
    const body = 'synthetic voice rejection';
    const chunkedBody = `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`;
    origin.server.on('upgrade', (_req, socket) => {
      socket.end([
        'HTTP/1.1 403 Forbidden',
        'Content-Type: text/plain',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        chunkedBody,
      ].join('\r\n'));
    });
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const closed = waitForClose(client);
      client.write(upgradeRequest());
      await closed;
      const wire = response.bytes().toString();
      expect(wire).toContain('HTTP/1.1 403 Forbidden\r\n');
      expect(wire.toLowerCase()).toContain('transfer-encoding: chunked\r\n');
      expect(wire.slice(wire.indexOf('\r\n\r\n') + 4)).toBe(chunkedBody);
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('keeps a reused upstream connection alive after a rejected voice handshake', async () => {
    const origin = await startOrigin();
    const body = 'follow-up response';
    let client: tls.TLSSocket | undefined;
    origin.server.on('request', (req, res) => {
      req.resume();
      if (req.url === voicePath) {
        res.writeHead(403, { 'Content-Length': '0', 'Connection': 'keep-alive' });
        res.end();
        return;
      }
      const reply = () => {
        res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(body)) });
        res.end(body);
      };
      if (client?.closed) reply();
      else client!.once('close', reply);
    });
    const proxy = await startProxy(origin.port);
    let nextRequest: http.ClientRequest | undefined;
    let resolveFollowup!: (result: { status?: number; body?: string; error?: string }) => void;
    const followup = new Promise<{ status?: number; body?: string; error?: string }>(resolve => {
      resolveFollowup = resolve;
    });
    const originalEmit = https.Agent.prototype.emit;
    const emit = vi.spyOn(https.Agent.prototype, 'emit').mockImplementation(function (this: https.Agent, event, ...args) {
      const result = originalEmit.call(this, event, ...args);
      const socket = args[0];
      if (event === 'free' && socket instanceof net.Socket && socket.remotePort === origin.port && !nextRequest) {
        nextRequest = https.request({
          hostname: '127.0.0.1',
          port: origin.port,
          path: '/follow-up',
          rejectUnauthorized: false,
          agent: this,
        }, res => {
          let response = '';
          res.on('data', chunk => { response += chunk.toString(); });
          res.once('end', () => resolveFollowup({ status: res.statusCode, body: response }));
          res.once('error', error => resolveFollowup({ error: error.message }));
        });
        nextRequest.setTimeout(3000, () => nextRequest!.destroy(new Error('follow-up timed out')));
        nextRequest.once('error', error => resolveFollowup({ error: error.message }));
        nextRequest.end();
      }
      return result;
    });
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const closed = waitForClose(client);
      client.write(upgradeRequest());
      await closed;
      expect(response.bytes().toString()).toContain('HTTP/1.1 403 Forbidden\r\n');
      expect(nextRequest).toBeDefined();
      expect(nextRequest!.reusedSocket).toBe(true);
      expect(await followup).toEqual({ status: 200, body });
    } finally {
      emit.mockRestore();
      nextRequest?.destroy();
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('rejects an untrusted upstream certificate by default', async () => {
    const origin = await startOrigin();
    let originRequests = 0;
    origin.server.on('request', (_req, res) => {
      originRequests += 1;
      res.end('unexpected request');
    });
    origin.server.on('upgrade', (_req, socket) => {
      originRequests += 1;
      socket.write(upgradeResponse());
    });
    const proxy = await startHttpProxy({
      routes: [],
      anthropicOrigin: `https://127.0.0.1:${origin.port}`,
    });
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const closed = waitForClose(client);
      client.write(upgradeRequest());
      await closed;
      expect(response.bytes().toString()).toContain('HTTP/1.1 502 Bad Gateway\r\n');
      expect(response.bytes().toString()).not.toContain('101 Switching Protocols');
      expect(originRequests).toBe(0);
      expect(client.destroyed).toBe(true);
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('returns 502 when the upstream refuses the connection', async () => {
    const reservation = net.createServer();
    const port = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const proxy = await startProxy(port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const closed = waitForClose(client);
      client.write(upgradeRequest());
      await closed;
      expect(response.bytes().toString()).toContain('HTTP/1.1 502 Bad Gateway\r\n');
      expect(response.bytes().toString()).not.toContain('101 Switching Protocols');
    } finally {
      client?.destroy();
      await proxy.close();
    }
  });

  it.each([false, true])('closes upstream when the client disconnects (upgraded=%s)', async upgraded => {
    const origin = await startOrigin();
    origin.server.on('upgrade', (_req, socket) => {
      socket.resume();
      if (upgraded) socket.write(upgradeResponse());
    });
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const handshake = once(origin.server, 'upgrade', { signal: AbortSignal.timeout(3000) });
      client.write(upgradeRequest());
      const [, upstream] = await handshake as [http.IncomingMessage, Duplex, Buffer];
      if (upgraded) await response.waitFor(bytes => bytes.includes('\r\n\r\n'));
      const closed = waitForClose(upstream);
      client.destroy();
      await closed;
      expect(upstream.destroyed).toBe(true);
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('returns 502 when upstream closes before the handshake response', async () => {
    const origin = await startOrigin();
    origin.server.on('upgrade', (_req, socket) => socket.destroy());
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const closed = waitForClose(client);
      client.write(upgradeRequest());
      await closed;
      expect(response.bytes().toString()).toContain('HTTP/1.1 502 Bad Gateway\r\n');
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it.each(['end', 'destroy', 'reset'] as const)('closes the upgraded client after upstream %s', async method => {
    const origin = await startOrigin();
    let raw: net.Socket | undefined;
    origin.server.on('connection', socket => {
      if (socket instanceof net.Socket) raw = socket;
    });
    origin.server.on('upgrade', (_req, socket) => socket.write(upgradeResponse()));
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const handshake = once(origin.server, 'upgrade', { signal: AbortSignal.timeout(3000) });
      client.write(upgradeRequest());
      const [, upstream] = await handshake as [http.IncomingMessage, Duplex, Buffer];
      await response.waitFor(bytes => bytes.includes('\r\n\r\n'));
      const closed = waitForClose(client);
      if (method === 'reset') raw!.resetAndDestroy();
      else upstream[method]();
      await closed;
      expect(client.destroyed).toBe(true);
      expect(response.bytes().toString()).not.toContain('502');
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('releases the proxy socket when upstream ends and the client remains half-open', async () => {
    const origin = await startOrigin();
    origin.server.on('upgrade', (_req, socket) => socket.write(upgradeResponse()));
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port, 'api.anthropic.com:443', true);
      const response = readSocket(client);
      const handshake = once(origin.server, 'upgrade', { signal: AbortSignal.timeout(3000) });
      client.write(upgradeRequest());
      const [, upstream] = await handshake as [http.IncomingMessage, Duplex, Buffer];
      await response.waitFor(bytes => bytes.includes('\r\n\r\n'));
      const getActiveHandles = (process as typeof process & {
        _getActiveHandles(): unknown[];
      })._getActiveHandles;
      const proxySockets = getActiveHandles.call(process).filter((handle): handle is net.Socket =>
        handle instanceof net.Socket
        && handle.localPort === proxy.port
        && handle.remotePort === client!.localPort
        && !handle.destroyed);
      expect(proxySockets.length).toBeGreaterThan(0);
      const closed = Promise.all(proxySockets.map(waitForClose));
      upstream.end();
      await closed;
      expect(proxySockets.every(socket => socket.destroyed)).toBe(true);
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it.each([false, true])('closes both sockets on proxy shutdown (upgraded=%s)', async upgraded => {
    const origin = await startOrigin();
    origin.server.on('upgrade', (_req, socket) => {
      socket.resume();
      if (upgraded) socket.write(upgradeResponse());
    });
    const proxy = await startProxy(origin.port);
    let proxyClosed = false;
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const handshake = once(origin.server, 'upgrade', { signal: AbortSignal.timeout(3000) });
      client.write(upgradeRequest());
      const [, upstream] = await handshake as [http.IncomingMessage, Duplex, Buffer];
      if (upgraded) await response.waitFor(bytes => bytes.includes('\r\n\r\n'));
      const closed = Promise.all([
        waitForClose(client),
        waitForClose(upstream),
      ]);
      await Promise.all([proxy.close(), closed]);
      proxyClosed = true;
      expect(client.destroyed).toBe(true);
      expect(upstream.destroyed).toBe(true);
    } finally {
      client?.destroy();
      if (!proxyClosed) await proxy.close();
      await origin.close();
    }
  });

  it('uses the inherited HTTPS proxy for the upstream WebSocket', async () => {
    const origin = await startOrigin();
    let request: http.IncomingMessage | undefined;
    origin.server.on('upgrade', (req, socket) => {
      request = req;
      socket.write(Buffer.concat([upgradeResponse(), serverFrame]));
    });
    const tunnel = http.createServer();
    const tunnelSockets = new Set<Duplex>();
    let connectAuthority: string | undefined;
    let proxyAuthorization: string | undefined;
    tunnel.on('connect', (req, client, head) => {
      connectAuthority = req.url;
      proxyAuthorization = req.headers['proxy-authorization'];
      const target = net.connect(origin.port, '127.0.0.1');
      for (const socket of [client, target]) {
        tunnelSockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => {
          tunnelSockets.delete(socket);
          client.destroy();
          target.destroy();
        });
      }
      target.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) target.write(head);
        client.pipe(target);
        target.pipe(client);
      });
    });
    const tunnelPort = await listen(tunnel);
    vi.stubEnv('HTTPS_PROXY', `http://test-user:test-pass@127.0.0.1:${tunnelPort}`);
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      client.write(upgradeRequest());
      await response.waitFor(bytes => bytes.includes(serverFrame));
      expect(connectAuthority).toBe(`127.0.0.1:${origin.port}`);
      expect(proxyAuthorization).toBe('Basic dGVzdC11c2VyOnRlc3QtcGFzcw==');
      expect(request?.url).toBe(voicePath);
      expect(request?.headers.authorization).toBe('Bearer synthetic-voice-token');
      expect(request?.headers['proxy-authorization']).toBeUndefined();
    } finally {
      client?.destroy();
      await proxy.close();
      for (const socket of tunnelSockets) socket.destroy();
      await new Promise<void>(resolve => tunnel.close(() => resolve()));
      await origin.close();
    }
  });

  it('keeps non-Anthropic CONNECT destinations outside the first-party relay', async () => {
    const origin = await startOrigin();
    origin.server.on('upgrade', (_req, socket) => socket.write(Buffer.concat([upgradeResponse(), serverFrame])));
    const firstParty = await startOrigin();
    let firstPartyRequests = 0;
    firstParty.server.on('upgrade', (_req, socket) => {
      firstPartyRequests += 1;
      socket.destroy();
    });
    const proxy = await startProxy(firstParty.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port, `127.0.0.1:${origin.port}`);
      const response = readSocket(client);
      client.write(upgradeRequest());
      const wire = await response.waitFor(bytes => bytes.includes(serverFrame));
      expect(wire).toEqual(Buffer.concat([upgradeResponse(), serverFrame]));
      expect(firstPartyRequests).toBe(0);
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
      await firstParty.close();
    }
  });

  it('delivers a rejection body larger than the socket write buffer', async () => {
    const origin = await startOrigin();
    const body = 'voice-rejection-payload;'.repeat(512 * 1024 / 24);
    origin.server.on('upgrade', (_req, socket) => {
      socket.end([
        'HTTP/1.1 401 Unauthorized',
        'Content-Type: text/plain',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const closed = waitForClose(client);
      client.write(upgradeRequest());
      await closed;
      const wire = response.bytes().toString();
      expect(wire).toContain('HTTP/1.1 401 Unauthorized\r\n');
      expect(wire.slice(wire.indexOf('\r\n\r\n') + 4)).toBe(body);
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it('relays a client frame sent while the upstream handshake is pending', async () => {
    const origin = await startOrigin();
    const pendingFrame = Buffer.from([0x82, 0x84, 9, 8, 7, 6, 0x0c, 0x0a, 0x0f, 0x0e]);
    let received: ReturnType<typeof readSocket> | undefined;
    origin.server.on('upgrade', (_req, socket, head) => {
      received = readSocket(socket, head);
    });
    const proxy = await startProxy(origin.port);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const handshake = once(origin.server, 'upgrade', { signal: AbortSignal.timeout(3000) });
      client.write(Buffer.concat([upgradeRequest(), clientFrame]));
      const [, upstream] = await handshake as [http.IncomingMessage, Duplex, Buffer];
      client.write(pendingFrame);
      // The relay must buffer bytes the client sends before the upstream answers.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(response.bytes()).toHaveLength(0);
      upstream.write(upgradeResponse());
      const wire = await response.waitFor(bytes => bytes.includes('\r\n\r\n'));
      expect(wire.toString()).toContain('HTTP/1.1 101 Switching Protocols');
      const relayed = await received!.waitFor(
        bytes => bytes.length >= clientFrame.length + pendingFrame.length,
      );
      expect(relayed).toEqual(Buffer.concat([clientFrame, pendingFrame]));
    } finally {
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });

  it.each([false, true])('drops a pipelined upgrade without disturbing the response in flight (upgraded=%s)', async upgraded => {
    const origin = await startOrigin();
    const body = 'pipelined passthrough response';
    origin.server.on('request', (req, res) => {
      req.resume();
      setTimeout(() => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': String(Buffer.byteLength(body)),
        });
        res.end(body);
      }, 120);
    });
    origin.server.on('upgrade', (_req, socket) => {
      socket.end(upgraded
        ? upgradeResponse()
        : 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    const proxy = await startProxy(origin.port);
    const uncaught: Error[] = [];
    const record = (error: Error) => { uncaught.push(error); };
    process.on('uncaughtException', record);
    let client: tls.TLSSocket | undefined;
    try {
      client = await connectMitm(proxy.port);
      const response = readSocket(client);
      const closed = waitForClose(client);
      client.write(Buffer.concat([
        Buffer.from('GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n'),
        upgradeRequest(),
      ]));
      await closed;
      const wire = response.bytes().toString();
      expect(wire.split('HTTP/1.1 ').length - 1).toBeLessThanOrEqual(1);
      expect(wire).not.toContain('101 Switching Protocols');
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
      client?.destroy();
      await proxy.close();
      await origin.close();
    }
  });
});
