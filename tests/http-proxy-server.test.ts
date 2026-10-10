import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ensureHttpProxyCaBundle, ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import {
  createPassthroughAgent,
  shouldInterceptConnect,
  startHttpProxy,
  upstreamUnreachableDetail,
} from '../src/http-proxy/server.js';

const testHome = mkdtempSync(join(tmpdir(), 'clodex-http-proxy-'));
const previousRelayHome = process.env['CLODEX_HOME'];
const outboundProxyEnvNames = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

function replaceOutboundProxyEnv(httpsProxy?: string): () => void {
  const previous = Object.fromEntries(
    outboundProxyEnvNames.map(name => [name, process.env[name]]),
  ) as Record<typeof outboundProxyEnvNames[number], string | undefined>;
  for (const name of outboundProxyEnvNames) delete process.env[name];
  if (httpsProxy !== undefined) process.env['HTTPS_PROXY'] = httpsProxy;
  return () => {
    for (const name of outboundProxyEnvNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * Collects lines raised through `emitParentNotice`, the channel these warnings
 * use so they survive the stderr mute `launchClaude` installs for the child's
 * lifetime. The channel writes to `process.stderr`, so a console spy no longer
 * sees them.
 */
function captureParentNotices(): {
  lines: () => string[];
  clear: () => void;
  restore: () => void;
} {
  const captured: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) => {
    captured.push(String(chunk));
    const callback = rest.find(arg => typeof arg === 'function');
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  }) as typeof process.stderr.write);
  return {
    lines: () => captured.flatMap(chunk => chunk.split('\n')).filter(line => line.length > 0),
    clear: () => { captured.length = 0; },
    restore: () => spy.mockRestore(),
  };
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return address.port;
}

/** Accumulates everything a socket receives and waits for a marker within it. */
function socketReader(socket: net.Socket): {
  until: (needle: string) => Promise<string>;
} {
  let received = '';
  let check: (() => void) | undefined;
  socket.on('data', chunk => {
    received += chunk.toString();
    check?.();
  });
  return {
    until: async (needle: string) => {
      if (!received.includes(needle)) {
        await new Promise<void>(resolve => {
          check = () => {
            if (!received.includes(needle)) return;
            check = undefined;
            resolve();
          };
        });
      }
      return received;
    },
  };
}

/** A target that answers every chunk with `echo:<chunk>`, so a tunnel's two directions are separable. */
async function startEchoTarget(): Promise<{ port: number; close: () => Promise<void> }> {
  const open = new Set<net.Socket>();
  const server = net.createServer(socket => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
  });
  const port = await listen(server);
  return {
    port,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** An upstream HTTP proxy that really tunnels, or refuses with a status line. */
async function startTunnelingProxy(
  options: { refuseWith?: string } = {},
): Promise<{ port: number; authorities: string[]; close: () => Promise<void> }> {
  const authorities: string[] = [];
  const open = new Set<net.Socket>();
  const server = http.createServer();
  server.on('connect', (req, clientSocket, head) => {
    authorities.push(req.url ?? '');
    open.add(clientSocket);
    clientSocket.once('close', () => open.delete(clientSocket));
    clientSocket.on('error', () => clientSocket.destroy());
    if (options.refuseWith !== undefined) {
      clientSocket.end(`HTTP/1.1 ${options.refuseWith}\r\n\r\n`);
      return;
    }
    const [host = '', port = ''] = (req.url ?? '').split(':');
    const target = net.connect(Number(port), host);
    open.add(target);
    target.once('close', () => open.delete(target));
    target.on('error', () => target.destroy());
    target.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) target.write(head);
      clientSocket.pipe(target);
      target.pipe(clientSocket);
    });
  });
  const port = await listen(server);
  return {
    port,
    authorities,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function connectMitm(proxyPort: number, ca: string): Promise<tls.TLSSocket> {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');

  let response = Buffer.alloc(0);
  while (!response.includes(Buffer.from('\r\n\r\n'))) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    response = Buffer.concat([response, chunk]);
  }
  const boundary = response.indexOf('\r\n\r\n') + 4;
  expect(response.subarray(0, boundary).toString()).toContain('200 Connection Established');
  const remainder = response.subarray(boundary);
  if (remainder.length > 0) socket.unshift(remainder);

  const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca });
  await once(secure, 'secureConnect');
  return secure;
}

async function requestMitm(
  proxyPort: number,
  ca: string,
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): Promise<string> {
  const socket = await connectMitm(proxyPort, ca);
  let response = '';
  socket.on('data', chunk => { response += chunk.toString(); });
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  socket.write([
    `POST ${path} HTTP/1.1`,
    'Host: api.anthropic.com',
    'Authorization: Bearer subscription-oauth-token',
    'Content-Type: application/json',
    `Content-Length: ${payload.length}`,
    'Connection: close',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n'));
  socket.write(payload);
  await once(socket, 'close');
  return response;
}

function activeProxySockets(proxyPort: number): net.Socket[] {
  const getActiveHandles = (process as typeof process & {
    _getActiveHandles(): unknown[];
  })._getActiveHandles;
  return getActiveHandles.call(process).filter((handle): handle is net.Socket =>
    handle instanceof net.Socket
    && handle.localPort === proxyPort
    && !handle.destroyed);
}

function adapterRequestWithResponseEvents(
  emitEvents: (response: http.IncomingMessage) => void,
): typeof http.request {
  return ((
    _options: http.RequestOptions,
    onResponse: (response: http.IncomingMessage) => void,
  ) => {
    const request = new EventEmitter() as EventEmitter & {
      end(body: Buffer): void;
      destroy(error?: Error): void;
    };
    request.end = () => {
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), {
          statusCode: 200,
          statusMessage: 'OK',
          headers: { 'content-type': 'text/event-stream' },
          rawHeaders: ['Content-Type', 'text/event-stream'],
          complete: false,
        }) as unknown as http.IncomingMessage;
        onResponse(response);
        emitEvents(response);
      });
    };
    request.destroy = () => {};
    return request;
  }) as unknown as typeof http.request;
}

/**
 * Start the proxy with `route`, send one /v1/messages, and return the parsed
 * inference-log records. Used to assert what the DIAGNOSTIC records, at the
 * real call site — a helper that recomputes the call site's condition would
 * pass just as happily with the condition deleted.
 */
async function requestLogEntriesForRoute(
  logName: string,
  route: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const certificates = ensureHttpProxyCertificates();
  const inferenceLogPath = join(testHome, logName);
  const proxy = await startHttpProxy({
    routes: [route as never],
    adapterHandle: { port: 1, token: 'adapter-local-token', close: () => {} },
    inferenceLogPath,
  });
  try {
    const body = JSON.stringify({
      model: route.aliasId,
      messages: [{ role: 'user', content: 'tier probe' }],
    });
    const secure = await connectMitm(proxy.port, certificates.caCert);
    secure.resume();
    secure.write([
      'POST /v1/messages HTTP/1.1',
      'Host: api.anthropic.com',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n') + body);
    await new Promise<void>(resolve => {
      secure.once('close', () => resolve());
      secure.once('error', () => resolve());
    });
    await new Promise(resolve => setImmediate(resolve));
    return readFileSync(inferenceLogPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  } finally {
    await proxy.close();
  }
}

async function adapterResponseFailureEntries(
  logName: string,
  emitEvents: (response: http.IncomingMessage) => void,
): Promise<Array<Record<string, unknown>>> {
  const certificates = ensureHttpProxyCertificates();
  const inferenceLogPath = join(testHome, logName);
  const route = {
    aliasId: 'clodex:test:translated-model',
    realModelId: 'translated-model',
    displayName: 'Translated Model',
    upstreamUrl: '',
    apiKey: 'provider-key',
    modelFormat: 'openai' as const,
    npm: '@ai-sdk/openai-compatible',
    providerId: 'test-provider',
  };
  const proxy = await startHttpProxy({
    routes: [route],
    adapterHandle: {
      port: 1,
      token: 'adapter-local-token',
      close: () => {},
    },
    inferenceLogPath,
    adapterRequest: adapterRequestWithResponseEvents(emitEvents),
  });

  try {
    const body = JSON.stringify({
      model: route.aliasId,
      messages: [{ role: 'user', content: 'test adapter response failure' }],
      stream: true,
    });
    const secure = await connectMitm(proxy.port, certificates.caCert);
    secure.resume();
    secure.write([
      'POST /v1/messages HTTP/1.1',
      'Host: api.anthropic.com',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n') + body);
    await new Promise<void>(resolve => {
      secure.once('close', () => resolve());
      secure.once('error', () => resolve());
    });
    await new Promise(resolve => setImmediate(resolve));

    return readFileSync(inferenceLogPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
  } finally {
    await proxy.close();
  }
}

beforeAll(() => {
  process.env['CLODEX_HOME'] = testHome;
});

afterAll(() => {
  if (previousRelayHome === undefined) delete process.env['CLODEX_HOME'];
  else process.env['CLODEX_HOME'] = previousRelayHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe('selective HTTP proxy', () => {
  let restoreAmbientProxyEnv: (() => void) | undefined;

  beforeEach(() => {
    restoreAmbientProxyEnv = replaceOutboundProxyEnv();
  });

  afterEach(() => {
    restoreAmbientProxyEnv?.();
    restoreAmbientProxyEnv = undefined;
  });

  it('preserves an existing custom CA in the child trust bundle', () => {
    const certificates = ensureHttpProxyCertificates();
    const extraPath = join(testHome, 'corporate-ca.pem');
    writeFileSync(extraPath, '-----BEGIN CERTIFICATE-----\ncorporate-test\n-----END CERTIFICATE-----\n');
    const combinedPath = ensureHttpProxyCaBundle(certificates.caCertPath, extraPath);
    const combined = readFileSync(combinedPath, 'utf8');
    expect(combinedPath).not.toBe(certificates.caCertPath);
    expect(combined).toContain(certificates.caCert.trim());
    expect(combined).toContain('corporate-test');
  });

  it('reports the CA it had to drop instead of silently trusting one less', () => {
    // The old merge swallowed every failure here, so a NODE_EXTRA_CA_CERTS left
    // over from a moved or deleted file disappeared from the bundle without a
    // word — and Node's own complaint names an OpenSSL code, not the variable.
    const certificates = ensureHttpProxyCertificates();
    const missingPath = join(testHome, 'does-not-exist-ca.pem');
    const warnings: string[] = [];

    const result = ensureHttpProxyCaBundle(
      certificates.caCertPath,
      missingPath,
      message => warnings.push(message),
    );

    expect(result).toBe(certificates.caCertPath);
    expect(warnings).toHaveLength(1);
    // Actionable means all three: which value is wrong, that it is dropped, and
    // what the right one is.
    expect(warnings[0]).toContain(`NODE_EXTRA_CA_CERTS=${missingPath}`);
    expect(warnings[0]).toContain('not part of the proxy CA bundle');
    expect(warnings[0]).toContain(certificates.caCertPath);
    // Conditional, because node stays silent for EISDIR and for any process
    // that never initializes its TLS roots.
    expect(warnings[0]).toContain('Where node reports this itself');
  });

  it('does not promise a Node warning for a directory, which Node ignores silently', () => {
    const certificates = ensureHttpProxyCertificates();
    const dirPath = mkdtempSync(join(tmpdir(), 'clodex-ca-dir-'));
    const warnings: string[] = [];
    try {
      expect(ensureHttpProxyCaBundle(certificates.caCertPath, dirPath, m => warnings.push(m)))
        .toBe(certificates.caCertPath);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('cannot be read');
      expect(warnings[0]).not.toContain('Ignoring extra certs ... load failed".');
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it('reports a configured CA file that is empty', () => {
    const certificates = ensureHttpProxyCertificates();
    const emptyPath = join(testHome, 'empty-ca.pem');
    writeFileSync(emptyPath, '   \n');
    const warnings: string[] = [];

    expect(ensureHttpProxyCaBundle(certificates.caCertPath, emptyPath, m => warnings.push(m)))
      .toBe(certificates.caCertPath);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('is empty');
    // NODE_EXTRA_CA_CERTS is additive, so no warning may imply the built-in
    // roots went away -- that would send the reader after a second problem.
    expect(warnings[0]).toContain("node's built-in roots are unaffected");
    expect(warnings[0]).not.toContain('trust only');
    // Node prints nothing at all for an empty file, so this branch must not
    // claim it does. Only the unreadable branch may cite that warning.
    expect(warnings[0]).not.toContain('Ignoring extra certs');
  });

  it('blames clodex, not the configured value, when clodex cannot write the bundle', () => {
    // An unwritable ~/.clodex/http-proxy is a clodex-side fault. Telling the
    // user to "clear or correct" a perfectly good NODE_EXTRA_CA_CERTS sends
    // them to fix the one thing that is not broken.
    const certificates = ensureHttpProxyCertificates();
    // Readable and non-empty is all the code establishes, and all the message
    // may claim -- this fixture is deliberately NOT a parseable certificate.
    const readableCaPath = join(testHome, 'readable-corporate-ca.pem');
    writeFileSync(readableCaPath, '-----BEGIN CERTIFICATE-----\nreadable\n-----END CERTIFICATE-----\n');
    const unwritableDir = mkdtempSync(join(tmpdir(), 'clodex-unwritable-'));
    const relayCaInUnwritableDir = join(unwritableDir, 'clodex-ca.pem');
    writeFileSync(relayCaInUnwritableDir, certificates.caCert);
    // Pre-create the destination as a DIRECTORY so the write fails as EISDIR.
    mkdirSync(join(unwritableDir, 'combined-ca.pem'));
    const warnings: string[] = [];

    try {
      expect(ensureHttpProxyCaBundle(relayCaInUnwritableDir, readableCaPath, m => warnings.push(m)))
        .toBe(relayCaInUnwritableDir);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('clodex could not build the combined CA bundle');
      expect(warnings[0]).toContain('readable, non-empty');
      expect(warnings[0]).not.toContain('Clear or correct it');
      expect(warnings[0]).not.toContain('cannot be read');
    } finally {
      rmSync(unwritableDir, { recursive: true, force: true });
    }
  });

  it('stays quiet when there is nothing wrong to report', () => {
    const certificates = ensureHttpProxyCertificates();
    const extraPath = join(testHome, 'quiet-corporate-ca.pem');
    writeFileSync(extraPath, '-----BEGIN CERTIFICATE-----\nquiet-test\n-----END CERTIFICATE-----\n');
    const warnings: string[] = [];

    // A successful merge, an unset variable, and a variable already pointing at
    // the clodex CA are all normal; none of them may produce a scary line.
    expect(ensureHttpProxyCaBundle(certificates.caCertPath, extraPath, m => warnings.push(m)))
      .not.toBe(certificates.caCertPath);
    expect(ensureHttpProxyCaBundle(certificates.caCertPath, undefined, m => warnings.push(m)))
      .toBe(certificates.caCertPath);
    expect(ensureHttpProxyCaBundle(certificates.caCertPath, '  ', m => warnings.push(m)))
      .toBe(certificates.caCertPath);
    expect(ensureHttpProxyCaBundle(certificates.caCertPath, certificates.caCertPath, m => warnings.push(m)))
      .toBe(certificates.caCertPath);
    expect(warnings).toEqual([]);
  });

  it('intercepts only api.anthropic.com on port 443', () => {
    expect(shouldInterceptConnect('api.anthropic.com:443')).toBe(true);
    expect(shouldInterceptConnect('API.ANTHROPIC.COM.:443')).toBe(true);
    expect(shouldInterceptConnect('api.anthropic.com:8443')).toBe(false);
    expect(shouldInterceptConnect('statsig.anthropic.com:443')).toBe(false);
    expect(shouldInterceptConnect('example.com:443')).toBe(false);
  });

  it('routes passthrough CONNECT tunnels through HTTPS_PROXY, head and both directions', async () => {
    // Acknowledging the CONNECT proves only route selection. Replaying a head
    // and then exchanging bytes is what distinguishes a working tunnel from a
    // handshake with no pipes behind it.
    const target = await startEchoTarget();
    const upstream = await startTunnelingProxy();
    const restoreProxyEnv = replaceOutboundProxyEnv(`http://127.0.0.1:${upstream.port}`);
    const proxy = await startHttpProxy({ routes: [] });
    const client = net.connect(proxy.port, proxy.host);
    client.on('error', () => {});
    const reader = socketReader(client);

    try {
      await once(client, 'connect');
      client.write(
        `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${target.port}\r\n\r\nHELLO`,
      );
      await reader.until('echo:HELLO');
      client.write('PING');
      const received = await reader.until('echo:PING');

      expect(received).toContain('200 Connection Established');
      expect(upstream.authorities).toEqual([`127.0.0.1:${target.port}`]);
    } finally {
      client.destroy();
      restoreProxyEnv();
      await proxy.close();
      await upstream.close();
      await target.close();
    }
  });

  it('answers 502 when the outbound proxy refuses the CONNECT', async () => {
    const upstream = await startTunnelingProxy({
      refuseWith: '407 Proxy Authentication Required',
    });
    const restoreProxyEnv = replaceOutboundProxyEnv(`http://127.0.0.1:${upstream.port}`);
    const proxy = await startHttpProxy({ routes: [] });
    const client = net.connect(proxy.port, proxy.host);
    client.on('error', () => {});
    const reader = socketReader(client);

    try {
      await once(client, 'connect');
      client.write(
        'CONNECT non-anthropic.example:443 HTTP/1.1\r\n'
        + 'Host: non-anthropic.example:443\r\n\r\n',
      );
      const received = await reader.until('502 Bad Gateway');

      expect(received).not.toContain('200 Connection Established');
      expect(upstream.authorities).toEqual(['non-anthropic.example:443']);
    } finally {
      client.destroy();
      restoreProxyEnv();
      await proxy.close();
      await upstream.close();
    }
  });

  it('dials CONNECT targets directly when HTTPS_PROXY names this proxy', async () => {
    // `clodex server --proxy` prints its own bridge URL as setup instructions
    // on a fixed default port, so a restart from that shell inherits a proxy
    // URL addressing its own listener. Tunneling through it would CONNECT back
    // into this handler, and again, until the process runs out of descriptors.
    const target = await startEchoTarget();
    const reservation = net.createServer();
    const proxyPort = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const restoreProxyEnv = replaceOutboundProxyEnv(`http://127.0.0.1:${proxyPort}`);
    // The warning goes through the parent-notice channel, not console.error,
    // because `launchClaude` mutes the parent's stderr while the child runs.
    const notices = captureParentNotices();
    const connect = vi.spyOn(HttpsProxyAgent.prototype, 'connect');
    const proxy = await startHttpProxy({ routes: [], port: proxyPort });
    const client = net.connect(proxy.port, proxy.host);
    client.on('error', () => {});
    const reader = socketReader(client);

    try {
      await once(client, 'connect');
      client.write(
        `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${target.port}\r\n\r\nHELLO`,
      );
      const received = await reader.until('echo:HELLO');

      expect(received).toContain('200 Connection Established');
      expect(connect).not.toHaveBeenCalled();
      expect(notices.lines()).toContain(
        'clodex: HTTP(S)_PROXY points at this proxy; tunneling CONNECT direct',
      );
    } finally {
      client.destroy();
      restoreProxyEnv();
      connect.mockRestore();
      notices.restore();
      await proxy.close();
      await target.close();
    }
  });

  it('warns once about an unusable proxy URL and keeps tunneling direct', async () => {
    // The agent is built per proxy URL, not per CONNECT, so a standalone
    // server does not repeat this line for every tunnel it opens.
    const target = await startEchoTarget();
    const restoreProxyEnv = replaceOutboundProxyEnv('not-a-url');
    const notices = captureParentNotices();
    const proxy = await startHttpProxy({ routes: [] });
    // Startup warns once for the Anthropic passthrough agent; count only what
    // the CONNECT path adds on top of it.
    notices.clear();

    const tunnel = async (): Promise<string> => {
      const client = net.connect(proxy.port, proxy.host);
      client.on('error', () => {});
      const reader = socketReader(client);
      await once(client, 'connect');
      client.write(
        `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${target.port}\r\n\r\nHELLO`,
      );
      const received = await reader.until('echo:HELLO');
      client.destroy();
      return received;
    };

    try {
      expect(await tunnel()).toContain('200 Connection Established');
      expect(await tunnel()).toContain('200 Connection Established');

      const warnings = notices.lines().filter(line =>
        line.startsWith('clodex: HTTP(S)_PROXY cannot be used for a CONNECT tunnel'));
      expect(warnings).toHaveLength(1);
    } finally {
      restoreProxyEnv();
      notices.restore();
      await proxy.close();
      await target.close();
    }
  });

  it('dials passthrough CONNECT targets directly without HTTPS_PROXY', async () => {
    let acceptTarget!: (socket: net.Socket) => void;
    const targetAccepted = new Promise<net.Socket>(resolve => { acceptTarget = resolve; });
    const targetServer = net.createServer(socket => acceptTarget(socket));
    const targetPort = await listen(targetServer);
    const proxy = await startHttpProxy({ routes: [] });
    const client = net.connect(proxy.port, proxy.host);
    client.on('error', () => {});
    let targetSocket: net.Socket | undefined;

    try {
      await once(client, 'connect');
      client.write(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${targetPort}\r\n\r\n`,
      );
      const [response] = await once(client, 'data') as [Buffer];
      targetSocket = await targetAccepted;

      expect(response.toString()).toContain('200 Connection Established');
      expect(targetSocket.remoteAddress).toBe('127.0.0.1');
    } finally {
      client.destroy();
      targetSocket?.destroy();
      await proxy.close();
      await new Promise<void>(resolve => targetServer.close(() => resolve()));
    }
  });

  it('releases both sides of a passthrough CONNECT tunnel when upstream closes', async () => {
    const upstream = net.createServer(socket => socket.end());
    const upstreamPort = await listen(upstream);
    const proxy = await startHttpProxy({ routes: [] });
    const clients: net.Socket[] = [];

    try {
      for (let index = 0; index < 25; index += 1) {
        const client = net.connect({
          host: '127.0.0.1',
          port: proxy.port,
          allowHalfOpen: true,
        });
        clients.push(client);
        await once(client, 'connect');
        client.resume();
        client.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
        await once(client, 'end');
      }
      await new Promise(resolve => setImmediate(resolve));

      expect(activeProxySockets(proxy.port)).toHaveLength(0);
    } finally {
      for (const client of clients) client.destroy();
      await proxy.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it('handles a client reset in a passthrough CONNECT tunnel and tears down upstream', async () => {
    let acceptUpstream!: (socket: net.Socket) => void;
    const upstreamAccepted = new Promise<net.Socket>(resolve => { acceptUpstream = resolve; });
    const upstreamServer = net.createServer(socket => {
      socket.on('error', () => {});
      socket.on('data', data => socket.write(data));
      acceptUpstream(socket);
    });
    const upstreamPort = await listen(upstreamServer);
    const proxy = await startHttpProxy({ routes: [] });
    const client = net.connect(proxy.port, proxy.host);
    client.on('error', () => {});
    const uncaught: Error[] = [];
    const onUncaught = (error: Error): void => { uncaught.push(error); };
    process.prependListener('uncaughtException', onUncaught);
    let upstreamSocket: net.Socket | undefined;

    try {
      await once(client, 'connect');
      client.write(
        `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${upstreamPort}\r\n\r\n`,
      );
      const [established] = await once(client, 'data') as [Buffer];
      expect(established.toString()).toContain('200 Connection Established');
      upstreamSocket = await upstreamAccepted;

      client.write('ping');
      const [echoed] = await once(client, 'data') as [Buffer];
      expect(echoed.toString()).toBe('ping');
      const upstreamClosed = once(upstreamSocket, 'close');
      client.resetAndDestroy();
      await Promise.race([
        upstreamClosed,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('upstream tunnel socket did not close after client reset')),
          1_000,
        )),
      ]);
      await new Promise(resolve => setImmediate(resolve));

      expect(uncaught).toEqual([]);
      expect(upstreamSocket.destroyed).toBe(true);
    } finally {
      process.off('uncaughtException', onUncaught);
      client.destroy();
      upstreamSocket?.destroy();
      await proxy.close();
      await new Promise<void>(resolve => upstreamServer.close(() => resolve()));
    }
  });

  it('handles a client reset while answering a malformed CONNECT authority', async () => {
    const proxy = await startHttpProxy({ routes: [] });
    const client = net.connect(proxy.port, proxy.host);
    client.on('error', () => {});
    const uncaught: Error[] = [];
    const onUncaught = (error: Error): void => { uncaught.push(error); };
    process.prependListener('uncaughtException', onUncaught);

    try {
      await once(client, 'connect');
      // '[' is not a valid authority, so the handler takes the 400 branch.
      client.write('CONNECT [ HTTP/1.1\r\nHost: x\r\n\r\n');
      // Reset before the 400 is written so the write hits a dead socket.
      await new Promise(resolve => setImmediate(resolve));
      client.resetAndDestroy();
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      client.destroy();
      await proxy.close();
    }
  });

  it('forwards first-party request bytes and auth unchanged', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'anthropic-inference.jsonl');
    const webSocketDiagnosticsLogPath = join(testHome, 'websocket-diagnostics.jsonl');
    const claudeSessionId = '00000000-0000-4000-8000-000000000004';
    const previousRequestPreview = process.env['CLODEX_LOG_REQUEST_PREVIEW'];
    process.env['CLODEX_LOG_REQUEST_PREVIEW'] = '1';
    let receivedBody = Buffer.alloc(0);
    let receivedAuth: string | undefined;
    let receivedPath: string | undefined;
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(req, 'end');
      receivedBody = Buffer.concat(chunks);
      receivedAuth = req.headers.authorization;
      receivedPath = req.url;
      const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":321,"output_tokens":1,"cache_creation_input_tokens":12,"cache_read_input_tokens":210}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"private response text"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":19,"output_tokens":8,"cache_creation_input_tokens":100,"cache_read_input_tokens":220}}',
        '',
        '',
      ].join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Content-Encoding': 'gzip',
      });
      res.end(gzipSync(sse));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      webSocketDiagnosticsLogPath,
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = Buffer.from('{\n  "model" : "claude-sonnet-4-6",\n  "output_config":{"effort":"high"},\n  "messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"private-image-data"}},{"type":"text","text":"identify this Sonnet request"}]}],\n  "stream":true\n}\n');
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages?beta=true HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        `x-claude-code-session-id: ${claudeSessionId}`,
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body.toString());
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(receivedPath).toBe('/v1/messages?beta=true');
      expect(receivedAuth).toBe('Bearer subscription-oauth-token');
      expect(receivedBody.equals(body)).toBe(true);
      // Usage decoding and downstream completion are logged by independent
      // asynchronous paths. Wait for every asserted lifecycle event instead of
      // assuming that response_completed is always recorded last.
      const logDeadline = Date.now() + 5000;
      let inferenceLog = readFileSync(inferenceLogPath, 'utf8');
      let entries = inferenceLog.trim().split('\n').map(line => JSON.parse(line));
      while (
        (!entries.some(entry => entry.event === 'response_completed') ||
          !entries.some(entry => entry.event === 'response_usage' && entry.usageStage === 'message_start') ||
          !entries.some(entry => entry.event === 'response_usage' && entry.usageStage === 'message_delta')) &&
        Date.now() < logDeadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 20));
        inferenceLog = readFileSync(inferenceLogPath, 'utf8');
        entries = inferenceLog.trim().split('\n').map(line => JSON.parse(line));
      }
      expect(entries[0]).toMatchObject({
        modelId: 'claude-sonnet-4-6',
        effort: 'high',
        provider: 'anthropic',
        route: 'passthrough',
        claudeSessionId,
        requestPreview: 'user: identify this Sonnet request',
      });
      const responseStarted = entries.find(entry => entry.event === 'response_started');
      const messageStartUsage = entries.find(entry => entry.event === 'response_usage' && entry.usageStage === 'message_start');
      const messageDeltaUsage = entries.find(entry => entry.event === 'response_usage' && entry.usageStage === 'message_delta');
      const responseCompleted = entries.find(entry => entry.event === 'response_completed');
      expect(responseStarted).toMatchObject({
        requestId: entries[0].requestId,
        statusCode: 200,
        route: 'passthrough',
        claudeSessionId,
      });
      expect(messageStartUsage).toMatchObject({
        event: 'response_usage',
        requestId: entries[0].requestId,
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        route: 'passthrough',
        claudeSessionId,
        usageStage: 'message_start',
        inputTokens: 321,
        outputTokens: 1,
        cacheCreationInputTokens: 12,
        cacheReadInputTokens: 210,
      });
      expect(messageDeltaUsage).toMatchObject({
        event: 'response_usage',
        requestId: entries[0].requestId,
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        route: 'passthrough',
        claudeSessionId,
        usageStage: 'message_delta',
        inputTokens: 19,
        outputTokens: 8,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 220,
      });
      expect(responseCompleted).toMatchObject({
        requestId: entries[0].requestId,
        statusCode: 200,
        route: 'passthrough',
        claudeSessionId,
      });
      expect(inferenceLog).not.toContain('private-image-data');
      expect(inferenceLog).not.toContain('private response text');
      const diagnosticRaw = readFileSync(webSocketDiagnosticsLogPath, 'utf8');
      const diagnostic = JSON.parse(diagnosticRaw.trim());
      expect(diagnostic).toMatchObject({
        event: 'request_diagnostic',
        requestId: entries[0].requestId,
        headers: { authorization: '[REDACTED]' },
        body: {
          parameters: { model: 'claude-sonnet-4-6', stream: true },
          messages: { count: 1 },
        },
      });
      expect(diagnosticRaw).not.toContain('subscription-oauth-token');
      expect(diagnosticRaw).not.toContain('private-image-data');
      expect(diagnosticRaw).not.toContain('identify this Sonnet request');
    } finally {
      if (previousRequestPreview === undefined) delete process.env['CLODEX_LOG_REQUEST_PREVIEW'];
      else process.env['CLODEX_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('preserves compressed first-party request bytes, encoding, and auth', async () => {
    const certificates = ensureHttpProxyCertificates();
    let receivedBody = Buffer.alloc(0);
    let receivedEncoding: string | undefined;
    let receivedAuth: string | undefined;
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(req, 'end');
      receivedBody = Buffer.concat(chunks);
      receivedEncoding = req.headers['content-encoding'];
      receivedAuth = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end('{}');
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const compressedBody = gzipSync(Buffer.from(JSON.stringify({
        model: 'claude-synthetic-1',
        messages: [{ role: 'user', content: 'test request' }],
      })));
      const response = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        compressedBody,
        { 'Content-Encoding': 'gzip' },
      );

      expect(response).toContain('200 OK');
      expect(receivedBody.equals(compressedBody)).toBe(true);
      expect(receivedEncoding).toBe('gzip');
      expect(receivedAuth).toBe('Bearer subscription-oauth-token');
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });

  it('streams raw passthrough through the configured CONNECT proxy', async () => {
    const certificates = ensureHttpProxyCertificates();
    let receivedPath: string | undefined;
    let receivedAuthorization: string | undefined;
    let receivedProxyHop: string | string[] | undefined;
    let receivedBody = Buffer.alloc(0);
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(req, 'end');
      receivedBody = Buffer.concat(chunks);
      receivedPath = req.url;
      receivedAuthorization = req.headers.authorization;
      receivedProxyHop = req.headers['x-clodex-proxy-hop'];
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    const originPort = await listen(origin);

    let connectLine: string | undefined;
    let proxyAuthorization: string | undefined;
    let proxyHop: string | undefined;
    const tunnelSockets = new Set<net.Socket>();
    const upstreamProxy = net.createServer(client => {
      tunnelSockets.add(client);
      client.once('close', () => tunnelSockets.delete(client));
      let buffered = Buffer.alloc(0);
      const readConnect = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const boundary = buffered.indexOf('\r\n\r\n');
        if (boundary === -1) return;
        client.removeListener('data', readConnect);
        const headerLines = buffered.subarray(0, boundary).toString('ascii').split('\r\n');
        connectLine = headerLines[0];
        proxyHop = headerLines.find(line => line.toLowerCase().startsWith('x-clodex-proxy-hop:'))
          ?.split(': ', 2)[1];
        proxyAuthorization = headerLines
          .find(line => line.toLowerCase().startsWith('proxy-authorization:'))
          ?.slice('proxy-authorization:'.length)
          .trim();
        const target = net.connect(originPort, '127.0.0.1');
        tunnelSockets.add(target);
        target.once('close', () => tunnelSockets.delete(target));
        target.once('error', () => client.destroy());
        target.once('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const remainder = buffered.subarray(boundary + 4);
          if (remainder.length > 0) target.write(remainder);
          client.pipe(target);
          target.pipe(client);
        });
      };
      client.on('data', readConnect);
      client.once('error', () => client.destroy());
    });
    const upstreamProxyPort = await listen(upstreamProxy);
    const restoreProxyEnv = replaceOutboundProxyEnv(
      `http://test-user:test-pass@127.0.0.1:${upstreamProxyPort}`,
    );
    let proxy: Awaited<ReturnType<typeof startHttpProxy>> | undefined;

    try {
      proxy = await startHttpProxy({
        routes: [],
        anthropicOrigin: `https://127.0.0.1:${originPort}`,
        anthropicRejectUnauthorized: false,
      });
      const response = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        '{"model":"claude-test","stream":true}',
      );

      expect(response).toContain('200 OK');
      expect(response).toContain('event: message_start');
      expect(response).toContain('event: message_stop');
      expect(connectLine).toBe(`CONNECT 127.0.0.1:${originPort} HTTP/1.1`);
      expect(proxyAuthorization).toBe('Basic dGVzdC11c2VyOnRlc3QtcGFzcw==');
      expect(proxyHop).toMatch(/^[0-9a-f-]{36}$/);
      expect(receivedProxyHop).toBeUndefined();
      expect(receivedPath).toBe('/v1/messages');
      expect(receivedAuthorization).toBe('Bearer subscription-oauth-token');
      expect(receivedBody.toString()).toBe('{"model":"claude-test","stream":true}');
    } finally {
      restoreProxyEnv();
      await proxy?.close();
      for (const socket of tunnelSockets) socket.destroy();
      await new Promise<void>(resolve => upstreamProxy.close(() => resolve()));
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });

  it('sends raw passthrough direct when proxy env names the bridge listener', async () => {
    const certificates = ensureHttpProxyCertificates();
    let originRequests = 0;
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, (req, res) => {
      originRequests += 1;
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end('{}');
    });
    const originPort = await listen(origin);
    const reservation = http.createServer();
    const proxyPort = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const restoreProxyEnv = replaceOutboundProxyEnv(`http://127.0.0.1:${proxyPort}`);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connect = vi.spyOn(HttpsProxyAgent.prototype, 'connect');
    let proxy: Awaited<ReturnType<typeof startHttpProxy>> | undefined;

    try {
      proxy = await startHttpProxy({
        routes: [],
        port: proxyPort,
        anthropicOrigin: `https://127.0.0.1:${originPort}`,
        anthropicRejectUnauthorized: false,
      });
      const response = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        '{"model":"claude-test"}',
      );

      expect(response).toContain('200 OK');
      expect(originRequests).toBe(1);
      expect(connect).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        'clodex: HTTP(S)_PROXY points at this proxy; sending Anthropic passthrough direct',
      );
    } finally {
      restoreProxyEnv();
      connect.mockRestore();
      error.mockRestore();
      await proxy?.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });

  it('destroys the raw passthrough proxy agent when the bridge closes', async () => {
    const restoreProxyEnv = replaceOutboundProxyEnv('http://127.0.0.1:9');
    const destroy = vi.spyOn(HttpsProxyAgent.prototype, 'destroy');
    let proxy: Awaited<ReturnType<typeof startHttpProxy>> | undefined;

    try {
      proxy = await startHttpProxy({ routes: [] });
      await proxy.close();
      proxy = undefined;

      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      await proxy?.close();
      destroy.mockRestore();
      restoreProxyEnv();
    }
  });

  it('keeps both raw passthrough agents unbounded, so no request waits for a socket', async () => {
    // The outage hold treats an attempt as unsent unless its socket was reused
    // or finished TLS. A bounded agent can queue a request and later hand it an
    // already-used socket that reports `reusedSocket: false` and never fires
    // `secureConnect`, so the hold deadline could cut a request already sent.
    // Each agent is captured as the one the proxy destroys on close: the agent
    // its passthrough really used. HttpsProxyAgent is spied on separately
    // because an earlier spy's restore can leave it an own `destroy`.
    const destroys = [
      vi.spyOn(http.Agent.prototype, 'destroy'),
      vi.spyOn(HttpsProxyAgent.prototype, 'destroy'),
    ];
    const passthroughAgent = async (httpsProxy?: string): Promise<http.Agent> => {
      const restoreProxyEnv = replaceOutboundProxyEnv(httpsProxy);
      for (const destroy of destroys) destroy.mockClear();
      try {
        const proxy = await startHttpProxy({ routes: [] });
        await proxy.close();
        const destroyed = new Set(destroys.flatMap(destroy => destroy.mock.contexts as http.Agent[]));
        expect(destroyed.size).toBe(1);
        return [...destroyed][0]!;
      } finally {
        restoreProxyEnv();
      }
    };

    try {
      const direct = await passthroughAgent();
      const proxied = await passthroughAgent('http://127.0.0.1:9');

      expect(direct).toBeInstanceOf(https.Agent);
      expect(direct).not.toBeInstanceOf(HttpsProxyAgent);
      expect(proxied).toBeInstanceOf(HttpsProxyAgent);
      for (const agent of [direct, proxied]) {
        expect(agent.maxSockets).toBe(Infinity);
        expect(agent.maxTotalSockets).toBe(Infinity);
      }
    } finally {
      for (const destroy of destroys) destroy.mockRestore();
    }
  });

  it('logs Haiku passthrough status, error body, and system fallback preview', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'haiku-error-inference.jsonl');
    const previousRequestPreview = process.env['CLODEX_LOG_REQUEST_PREVIEW'];
    process.env['CLODEX_LOG_REQUEST_PREVIEW'] = '1';
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(529, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Haiku overloaded for Bearer sk-secret123456789' },
      }));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5',
        system: [{ type: 'text', text: 'Generate a concise title for this Claude Code session.' }],
        messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'private tool output' }] }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('529');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries[0]).toMatchObject({
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        route: 'passthrough',
        requestPreview: 'user: [tool_result] | system: Generate a concise title for this Claude Code session.',
      });
      const upstreamError = entries.find(entry => entry.event === 'upstream_error');
      expect(upstreamError).toMatchObject({
        event: 'upstream_error',
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        route: 'passthrough',
        statusCode: 529,
      });
      expect(upstreamError.errorContent).toContain('Haiku overloaded');
      expect(upstreamError.errorContent).toContain('[REDACTED]');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_completed',
        requestId: entries[0].requestId,
        statusCode: 529,
      }));
      expect(readFileSync(inferenceLogPath, 'utf8')).not.toContain('private tool output');
    } finally {
      if (previousRequestPreview === undefined) delete process.env['CLODEX_LOG_REQUEST_PREVIEW'];
      else process.env['CLODEX_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('logs a partial upstream error body when the origin resets before end', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'partial-error-inference.jsonl');
    const previousRequestPreview = process.env['CLODEX_LOG_REQUEST_PREVIEW'];
    process.env['CLODEX_LOG_REQUEST_PREVIEW'] = '1';
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{"error":{"message":"partial outage');
      setImmediate(() => res.destroy(new Error('origin reset')));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'test partial error logging' }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      secure.resume();
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await new Promise<void>(resolve => {
        secure.once('close', () => resolve());
        secure.once('error', () => resolve());
      });

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const upstreamError = entries.find(entry => entry.event === 'upstream_error');
      expect(upstreamError).toMatchObject({
        event: 'upstream_error',
        modelId: 'claude-haiku-4-5',
        statusCode: 503,
      });
      expect(upstreamError.errorContent).toContain('partial outage');
      expect(upstreamError.errorContent).toContain('stream error');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: entries[0].requestId,
        statusCode: 503,
        terminationSource: 'upstream_failure',
      }));
    } finally {
      if (previousRequestPreview === undefined) delete process.env['CLODEX_LOG_REQUEST_PREVIEW'];
      else process.env['CLODEX_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('logs an Anthropic connection failure as an upstream response failure', async () => {
    // This pins the failure record written once the proxy gives up; the outage
    // hold that precedes it is covered in 'outage hold', so skip it here.
    const previousHold = process.env['CLODEX_PASSTHROUGH_OUTAGE_HOLD_MS'];
    process.env['CLODEX_PASSTHROUGH_OUTAGE_HOLD_MS'] = '0';
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'connection-refused-inference.jsonl');
    const unavailableOrigin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    });
    const unavailablePort = await listen(unavailableOrigin);
    await new Promise<void>(resolve => unavailableOrigin.close(() => resolve()));
    let proxy: Awaited<ReturnType<typeof startHttpProxy>> | undefined;

    try {
      proxy = await startHttpProxy({
        routes: [],
        inferenceLogPath,
        anthropicOrigin: `https://127.0.0.1:${unavailablePort}`,
        anthropicRejectUnauthorized: false,
      });
      const body = JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'test refused origin' }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('502');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: requestEntry.requestId,
        route: 'passthrough',
        statusCode: 502,
        phase: 'waiting_for_headers',
        errorType: expect.stringMatching(/^ECONN(?:REFUSED|RESET)$/),
        terminationSource: 'upstream_failure',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'upstream_error',
        requestId: requestEntry.requestId,
        statusCode: 502,
      }));
    } finally {
      if (previousHold === undefined) delete process.env['CLODEX_PASSTHROUGH_OUTAGE_HOLD_MS'];
      else process.env['CLODEX_PASSTHROUGH_OUTAGE_HOLD_MS'] = previousHold;
      await proxy?.close();
    }
  }, 20_000);

  it('routes exact relay models and short aliases while stripping Anthropic auth from the adapter hop', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'relay-inference.jsonl');
    let adapterAuth: string | undefined;
    let adapterApiKey: string | undefined;
    let adapterClaudeSessionId: string | undefined;
    let adapterClaudeAgentId: string | undefined;
    let adapterClaudeParentAgentId: string | undefined;
    let adapterBody = '';
    let anthropicRequests = 0;
    let fallbackAuth: string | undefined;

    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      anthropicRequests += 1;
      fallbackAuth = req.headers.authorization;
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.setHeader('Connection', 'close');
      res.end('{"unexpected":true}');
    });
    const originPort = await listen(origin);

    const adapterServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(req, 'end');
      adapterAuth = req.headers.authorization;
      adapterApiKey = req.headers['x-api-key'] as string | undefined;
      adapterClaudeSessionId = req.headers['x-claude-code-session-id'] as string | undefined;
      adapterClaudeAgentId = req.headers['x-claude-code-agent-id'] as string | undefined;
      adapterClaudeParentAgentId = req.headers['x-claude-code-parent-agent-id'] as string | undefined;
      adapterBody = Buffer.concat(chunks).toString();
      await new Promise(resolve => setTimeout(resolve, 35));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
      res.end([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'));
    });
    const adapterPort = await listen(adapterServer);
    const proxy = await startHttpProxy({
      routes: [{
        aliasId: 'clodex:groq:llama-3.3-70b',
        realModelId: 'llama-3.3-70b-versatile',
        displayName: 'Llama 3.3 70B (Groq)',
        upstreamUrl: '',
        apiKey: 'provider-key',
        modelFormat: 'openai',
        npm: '@ai-sdk/groq',
        providerId: 'groq',
      }],
      modelAliases: [{
        name: 'llama',
        routeId: 'clodex:groq:llama-3.3-70b',
        displayName: 'Llama 3.3 70B (Groq)',
        sourceNames: ['LLaMa', 'LLAMA'],
      }],
      reservedModelIds: ['missing-route', 'orbit', 'Orbit', 'ORBIT'],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
      inferenceLogPath,
      responseProgressIntervalMs: 10,
    });

    try {
      const body = JSON.stringify({
        model: 'clodex:groq:llama-3.3-70b',
        output_config: { effort: 'medium' },
        messages: [],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'X-Claude-Code-Session-Id: 11111111-1111-4111-8111-111111111111',
        'X-Claude-Code-Agent-Id: agent-a1b2c3d4e5f60718',
        'X-Claude-Code-Parent-Agent-Id: agent-main',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(anthropicRequests).toBe(0);
      expect(adapterAuth).toBeUndefined();
      expect(adapterApiKey).toBe('adapter-local-token');
      expect(adapterClaudeSessionId).toBe('11111111-1111-4111-8111-111111111111');
      // Subagent identity rides with the session id: the relay partitions
      // ChatGPT WebSocket heads by it.
      expect(adapterClaudeAgentId).toBe('agent-a1b2c3d4e5f60718');
      expect(adapterClaudeParentAgentId).toBe('agent-main');
      expect(adapterBody).toBe(body);
      const relayEntries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = relayEntries.find(entry => !entry.event);
      expect(requestEntry).toMatchObject({
        modelId: 'clodex:groq:llama-3.3-70b',
        effort: 'medium',
        provider: 'groq',
        route: 'translated',
        stream: true,
      });
      expect(requestEntry.requestId).toEqual(expect.any(String));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_progress',
        requestId: requestEntry.requestId,
        phase: 'waiting_for_headers',
        bytes: 0,
        chunks: 0,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_started',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_usage',
        requestId: requestEntry.requestId,
        modelId: 'clodex:groq:llama-3.3-70b',
        provider: 'groq',
        route: 'translated',
        usageStage: 'message_start',
        inputTokens: 0,
        outputTokens: 0,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_completed',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));

      const aliasBody = JSON.stringify({ model: 'llama', messages: [], stream: true });
      const aliasSocket = await connectMitm(proxy.port, certificates.caCert);
      aliasSocket.resume();
      aliasSocket.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(aliasBody)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + aliasBody);
      await once(aliasSocket, 'close');

      expect(anthropicRequests).toBe(0);
      // The alias name reaches the adapter unrewritten: the adapter resolves it
      // via its own modelAliases and echoes it back as the response model id.
      expect(JSON.parse(adapterBody)).toMatchObject({
        model: 'llama',
        messages: [],
      });
      const aliasEntries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(aliasEntries.find(entry => !entry.event && entry.modelId === 'llama')).toMatchObject({
        provider: 'groq',
        route: 'translated',
      });

      const normalizedRouteBody = JSON.stringify({
        model: 'clodex:groq:llama-3.3-70b[1M]',
        messages: [],
        stream: true,
      });
      const normalizedRouteResponse = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        normalizedRouteBody,
      );
      expect(normalizedRouteResponse).toContain('200 OK');
      expect(JSON.parse(adapterBody).model).toBe('clodex:groq:llama-3.3-70b[1M]');

      const compressedRouteBody = JSON.stringify({ model: 'llama', messages: [], stream: true });
      const compressedRouteResponse = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        gzipSync(Buffer.from(compressedRouteBody)),
        { 'Content-Encoding': 'gzip' },
      );
      expect(compressedRouteResponse).toContain('200 OK');
      expect(JSON.parse(adapterBody).model).toBe('llama');

      const rejectedCases = [
        { model: 'clodex:groq:typo', path: '/v1/messages' },
        { model: 'LLaMa', path: '/v1/messages' },
        { model: 'LLAMA', path: '/v1/messages' },
        { model: 'orbit', path: '/v1/messages' },
        { model: 'missing-route', path: '/v1/messages' },
        { model: 'missing-route[1m]', path: '/v1/messages' },
        { model: 'missing-route[1M]', path: '/v1/messages' },
        { model: 'models/missing-route[1m]', path: '/v1/messages' },
        { model: 'models/clodex:test:unavailable-model[1M]', path: '/v1/messages' },
        { model: 'missing-route', path: '/v1/messages/count_tokens' },
        { model: 'models/clodex:test:unavailable-model[1M]', path: '/v1/messages/count_tokens' },
      ];
      for (const testCase of rejectedCases) {
        const response = await requestMitm(
          proxy.port,
          certificates.caCert,
          testCase.path,
          JSON.stringify({ model: testCase.model, messages: [] }),
        );
        expect(response, `${testCase.path} ${testCase.model}`).toContain('400 Bad Request');
        expect(response).toContain('invalid_request_error');
        expect(response).toContain('clodex models --list');
        expect(response).not.toContain('clodex patch');
      }

      const compressedUnavailableBody = JSON.stringify({ model: 'missing-route', messages: [] });
      const compressedUnavailableResponse = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        gzipSync(Buffer.from(compressedUnavailableBody)),
        { 'Content-Encoding': 'gzip' },
      );
      expect(compressedUnavailableResponse).toContain('400 Bad Request');
      expect(compressedUnavailableResponse).toContain('invalid_request_error');
      expect(compressedUnavailableResponse).toContain('clodex models --list');
      expect(compressedUnavailableResponse).not.toContain('clodex patch');

      const unreadableCompressedResponse = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        Buffer.from('not-a-gzip-stream'),
        { 'Content-Encoding': 'gzip' },
      );
      expect(unreadableCompressedResponse).toContain('400 Bad Request');
      expect(unreadableCompressedResponse).toContain('Unable to inspect compressed request body');
      expect(anthropicRequests).toBe(0);
      expect(fallbackAuth).toBeUndefined();

      const unavailableAliasEntries = readFileSync(inferenceLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(unavailableAliasEntries).toContainEqual(expect.objectContaining({
        event: 'route_unavailable',
        modelId: 'missing-route',
        statusCode: 400,
      }));
      expect(unavailableAliasEntries).not.toContainEqual(expect.objectContaining({
        event: 'upstream_error',
        modelId: 'missing-route',
      }));
      for (const testCase of rejectedCases.filter(item => item.path === '/v1/messages')) {
        expect(unavailableAliasEntries).not.toContainEqual(expect.objectContaining({
          modelId: testCase.model,
          provider: expect.any(String),
          route: expect.any(String),
        }));
      }
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('routes count_tokens to the adapter without recording it as inference', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'count-tokens-inference.jsonl');
    let adapterPath: string | undefined;
    let anthropicRequests = 0;

    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, (req, res) => {
      anthropicRequests += 1;
      req.resume();
      res.end('{"unexpected":true}');
    });
    const originPort = await listen(origin);
    const adapterServer = http.createServer(async (req, res) => {
      adapterPath = req.url;
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end('{"input_tokens":42}');
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
      inferenceLogPath,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count this' }],
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages/count_tokens?beta=true HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(response).toContain('{"input_tokens":42}');
      expect(adapterPath).toBe('/v1/messages/count_tokens?beta=true');
      expect(anthropicRequests).toBe(0);
      expect(existsSync(inferenceLogPath)).toBe(false);
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('closes the adapter request and logs a terminal client disconnect', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'client-disconnect-inference.jsonl');
    const claudeSessionId = '00000000-0000-4000-8000-000000000002';
    let adapterReceivedResolve!: () => void;
    const adapterReceived = new Promise<void>(resolve => { adapterReceivedResolve = resolve; });
    let adapterClosedResolve!: () => void;
    const adapterClosed = new Promise<void>(resolve => { adapterClosedResolve = resolve; });
    const adapterServer = http.createServer((req) => {
      req.resume();
      req.once('end', adapterReceivedResolve);
      req.socket.once('close', adapterClosedResolve);
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      inferenceLogPath,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'wait forever' }],
        stream: false,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      secure.on('error', () => {});
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `x-claude-code-session-id: ${claudeSessionId}`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        '',
      ].join('\r\n') + body);
      await adapterReceived;
      secure.destroy();
      await adapterClosed;
      await new Promise(resolve => setImmediate(resolve));

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(requestEntry.claudeSessionId).toBe(claudeSessionId);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_client_disconnected',
        requestId: requestEntry.requestId,
        claudeSessionId,
        phase: 'waiting_for_headers',
        terminationSource: 'downstream_client',
      }));
      expect(entries.some(entry => entry.event === 'response_completed')).toBe(false);
      expect(entries.some(entry => entry.event === 'response_failed')).toBe(false);
    } finally {
      await proxy.close();
    }
  }, 20_000);

  it('attributes an in-flight response termination to local proxy shutdown', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'local-shutdown-inference.jsonl');
    let adapterReceivedResolve!: () => void;
    const adapterReceived = new Promise<void>(resolve => {
      adapterReceivedResolve = resolve;
    });
    let adapterClosedResolve!: () => void;
    const adapterClosed = new Promise<void>(resolve => {
      adapterClosedResolve = resolve;
    });
    const adapterServer = http.createServer(req => {
      req.resume();
      req.once('end', adapterReceivedResolve);
      req.socket.once('close', adapterClosedResolve);
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      inferenceLogPath,
    });
    let proxyClosed = false;

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'wait for local shutdown' }],
        stream: false,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      secure.on('error', () => {});
      secure.resume();
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        '',
      ].join('\r\n') + body);
      await adapterReceived;
      await proxy.close();
      proxyClosed = true;
      await adapterClosed;
      await new Promise(resolve => setImmediate(resolve));

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_client_disconnected',
        requestId: requestEntry.requestId,
        phase: 'waiting_for_headers',
        terminationSource: 'local_shutdown',
      }));
      expect(entries.some(entry => entry.terminationSource === 'downstream_client')).toBe(false);
    } finally {
      if (!proxyClosed) await proxy.close();
    }
  }, 20_000);

  it('logs adapter request errno and source when the adapter is unavailable before headers', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'adapter-request-error-inference.jsonl');
    const unavailableAdapter = http.createServer();
    const unavailableAdapterPort = await listen(unavailableAdapter);
    await new Promise<void>(resolve => unavailableAdapter.close(() => resolve()));
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: unavailableAdapterPort,
        token: 'adapter-local-token',
        close: () => {},
      },
      inferenceLogPath,
    });

    try {
      const response = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        JSON.stringify({
          model: route.aliasId,
          messages: [{ role: 'user', content: 'test unavailable adapter' }],
          stream: true,
        }),
      );

      expect(response).toContain('502');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: requestEntry.requestId,
        route: 'translated',
        statusCode: 502,
        phase: 'waiting_for_headers',
        errorType: 'Error',
        errorCode: expect.stringMatching(/^ECONN(?:REFUSED|RESET)$/),
        failureSource: 'adapter_request_error',
        terminationSource: 'upstream_failure',
      }));
    } finally {
      await proxy.close();
    }
  }, 20_000);

  it('keeps translated adapter connections out of the process-global pool', async () => {
    const certificates = ensureHttpProxyCertificates();
    let connectionCount = 0;
    const adapterServer = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': '2',
        });
        res.end('{}');
      });
    });
    adapterServer.keepAliveTimeout = 60_000;
    adapterServer.on('connection', () => {
      connectionCount += 1;
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      adapterRequest: ((options: http.RequestOptions, onResponse: (response: http.IncomingMessage) => void) =>
        http.request(
          { ...options, agent: options.agent ?? false },
          onResponse,
        )) as typeof http.request,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'test adapter connection reuse' }],
        stream: false,
      });
      const requestTranslatedModel = async () => {
        const secure = await connectMitm(proxy.port, certificates.caCert);
        const payload = Buffer.from(body);
        secure.write([
          'POST /v1/messages HTTP/1.1',
          'Host: api.anthropic.com',
          'Content-Type: application/json',
          `Content-Length: ${payload.length}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'));
        secure.write(payload);

        let response = '';
        for await (const chunk of secure) {
          response += chunk.toString();
          if (response.includes('\r\n\r\n{}')) break;
        }
        secure.destroy();
        return response;
      };
      const firstResponse = await requestTranslatedModel();
      const secondResponse = await requestTranslatedModel();

      expect(firstResponse).toContain('200');
      expect(secondResponse).toContain('200');
      expect(connectionCount).toBe(1);
    } finally {
      await proxy.close();
    }
  }, 20_000);

  it('logs a distinct source when the adapter request closes before headers', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'adapter-request-close-inference.jsonl');
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const adapterRequest = () => {
      const request = new EventEmitter() as EventEmitter & {
        end(body: Buffer): void;
        destroy(error?: Error): void;
      };
      request.end = () => queueMicrotask(() => request.emit('close'));
      request.destroy = () => {};
      return request;
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: 1,
        token: 'adapter-local-token',
        close: () => {},
      },
      inferenceLogPath,
      adapterRequest,
    } as Parameters<typeof startHttpProxy>[0]);

    try {
      const response = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        JSON.stringify({
          model: route.aliasId,
          messages: [{ role: 'user', content: 'test closed adapter request' }],
          stream: true,
        }),
      );

      expect(response).toContain('502');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: requestEntry.requestId,
        route: 'translated',
        statusCode: 502,
        phase: 'waiting_for_headers',
        errorType: 'Error',
        failureSource: 'adapter_request_close',
        terminationSource: 'upstream_failure',
      }));
    } finally {
      await proxy.close();
    }
  }, 20_000);

  it('terminates and logs a translated response when the adapter closes before end', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'adapter-abort-inference.jsonl');
    const adapterServer = http.createServer(async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setImmediate(() => res.destroy(new Error('adapter reset')));
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      inferenceLogPath,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'test adapter reset' }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      secure.resume();
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await new Promise<void>(resolve => {
        secure.once('close', () => resolve());
        secure.once('error', () => resolve());
      });

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_started',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: requestEntry.requestId,
        statusCode: 200,
        phase: 'streaming',
        failureSource: 'adapter_response_aborted',
        terminationSource: 'upstream_failure',
      }));
      expect(entries.some(entry => entry.event === 'response_completed')).toBe(false);
    } finally {
      await proxy.close();
    }
  }, 20_000);

  it('logs adapter response errno and source when the response emits an error', async () => {
    const entries = await adapterResponseFailureEntries(
      'adapter-response-error-inference.jsonl',
      response => {
        const error = Object.assign(new Error('adapter response reset'), {
          code: 'ECONNRESET',
        });
        response.emit('error', error);
      },
    );
    const failures = entries.filter(entry => entry['event'] === 'response_failed');

    expect(failures).toEqual([
      expect.objectContaining({
        event: 'response_failed',
        statusCode: 200,
        phase: 'waiting_for_first_byte',
        errorType: 'Error',
        errorCode: 'ECONNRESET',
        failureSource: 'adapter_response_error',
        terminationSource: 'upstream_failure',
      }),
    ]);
  }, 20_000);

  it('logs adapter response abort before a following close', async () => {
    const entries = await adapterResponseFailureEntries(
      'adapter-response-aborted-inference.jsonl',
      response => {
        response.emit('aborted');
        response.emit('close');
      },
    );
    const failures = entries.filter(entry => entry['event'] === 'response_failed');

    expect(failures).toEqual([
      expect.objectContaining({
        event: 'response_failed',
        statusCode: 200,
        phase: 'waiting_for_first_byte',
        failureSource: 'adapter_response_aborted',
        terminationSource: 'upstream_failure',
      }),
    ]);
  }, 20_000);

  it('logs adapter response close when no more specific failure fires first', async () => {
    const entries = await adapterResponseFailureEntries(
      'adapter-response-close-inference.jsonl',
      response => response.emit('close'),
    );
    const failures = entries.filter(entry => entry['event'] === 'response_failed');

    expect(failures).toEqual([
      expect.objectContaining({
        event: 'response_failed',
        statusCode: 200,
        phase: 'waiting_for_first_byte',
        failureSource: 'adapter_response_close',
        terminationSource: 'upstream_failure',
      }),
    ]);
  }, 20_000);

  it('records the resolved service tier for the route that carries one', async () => {
    // The diagnostic records the tier clodex resolved for the selected route
    // before dispatch; it deliberately does not claim wire transmission.
    const previous = process.env['CLODEX_SERVICE_TIER'];
    process.env['CLODEX_SERVICE_TIER'] = 'fast';
    try {
      const entries = await requestLogEntriesForRoute('tier-oauth-inference.jsonl', {
        aliasId: 'clodex:openai-oauth:gpt-5.6-sol',
        realModelId: 'gpt-5.6-sol',
        displayName: 'Sol',
        upstreamUrl: '',
        apiKey: 'oauth-token',
        modelFormat: 'openai' as const,
        npm: '@ai-sdk/openai',
        authType: 'oauth',
        providerId: 'openai-oauth',
      });
      const request = entries.find(entry => entry.route === 'translated');
      expect(request).toBeTruthy();
      // Record the resolved request vocabulary: `fast` is the Codex CLI's
      // spelling and `priority` is the tier clodex asks the SDK to serialize.
      expect(request!.serviceTier).toBe('priority');
    } finally {
      if (previous === undefined) delete process.env['CLODEX_SERVICE_TIER'];
      else process.env['CLODEX_SERVICE_TIER'] = previous;
    }
  });

  it('requires both OAuth auth and the OpenAI SDK route before recording a tier', async () => {
    const previous = process.env['CLODEX_SERVICE_TIER'];
    process.env['CLODEX_SERVICE_TIER'] = 'fast';
    try {
      const oneFieldNegatives = [
        {
          logName: 'tier-api-key-negative-inference.jsonl',
          route: {
            aliasId: 'clodex:openai:gpt-5.6-sol',
            realModelId: 'gpt-5.6-sol',
            displayName: 'API-key Sol',
            upstreamUrl: '',
            apiKey: 'synthetic-api-key',
            modelFormat: 'openai' as const,
            npm: '@ai-sdk/openai',
            authType: 'api' as const,
            providerId: 'openai',
          },
        },
        {
          logName: 'tier-compatible-oauth-negative-inference.jsonl',
          route: {
            aliasId: 'clodex:compatible-oauth:gpt-5.6-sol',
            realModelId: 'gpt-5.6-sol',
            displayName: 'Compatible OAuth Sol',
            upstreamUrl: '',
            apiKey: 'synthetic-oauth-token',
            modelFormat: 'openai' as const,
            npm: '@ai-sdk/openai-compatible',
            authType: 'oauth' as const,
            providerId: 'compatible-oauth',
          },
        },
      ];

      for (const fixture of oneFieldNegatives) {
        const entries = await requestLogEntriesForRoute(fixture.logName, fixture.route);
        const request = entries.find(entry => entry.route === 'translated');
        expect(request, fixture.logName).toBeTruthy();
        expect(request!.serviceTier, fixture.logName).toBeUndefined();
      }
    } finally {
      if (previous === undefined) delete process.env['CLODEX_SERVICE_TIER'];
      else process.env['CLODEX_SERVICE_TIER'] = previous;
    }
  });

  it('records no service tier on a route that cannot carry one', async () => {
    // OAuth-only: API-key OpenAI is excluded because `priority` there is a
    // billable surcharge, and other providers never see it. A log claiming a
    // tier on those routes would be inventing one.
    const previous = process.env['CLODEX_SERVICE_TIER'];
    process.env['CLODEX_SERVICE_TIER'] = 'fast';
    try {
      const entries = await requestLogEntriesForRoute('tier-compatible-inference.jsonl', {
        aliasId: 'clodex:opencode-go:kimi-k3',
        realModelId: 'kimi-k3',
        displayName: 'Kimi K3',
        upstreamUrl: '',
        apiKey: 'go-key',
        modelFormat: 'openai' as const,
        npm: '@ai-sdk/openai-compatible',
        authType: 'api',
        providerId: 'opencode-go',
      });
      const request = entries.find(entry => entry.route === 'translated');
      expect(request).toBeTruthy();
      expect(request!.serviceTier).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['CLODEX_SERVICE_TIER'];
      else process.env['CLODEX_SERVICE_TIER'] = previous;
    }
  });


  // A keep-alive pool can hand out a socket the far end closed while it was
  // idle. Every request in this group drives that shape through the real MITM
  // path against a real origin rather than by emitting a synthetic error.
  describe('Anthropic passthrough retry', () => {
    const ORIGIN_BODY = JSON.stringify({ type: 'message', content: [] });
    const POST_HEADER_MARKER = 'event: message_start\n\n';
    /**
     * Origin that serves every connection normally except for the Nth request
     * it sees on that same connection, which it kills without replying. With
     * `killOnConnectionRequest: 2` a socket is only reset once it has been
     * pooled and reused, which is the production failure; with `1` the reset
     * lands on a freshly opened socket, which must never be replayed.
     */
    function resettingOrigin(killOnConnectionRequest: number): {
      server: https.Server;
      requestCount: () => number;
    } {
      const certificates = ensureHttpProxyCertificates();
      let requests = 0;
      const bodies: string[] = [];
      const perConnection = new WeakMap<net.Socket, number>();
      const server = https.createServer({
        key: certificates.serverKey,
        cert: certificates.serverCert,
      }, (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.once('end', () => bodies.push(Buffer.concat(chunks).toString()));
        const seen = (perConnection.get(req.socket) ?? 0) + 1;
        perConnection.set(req.socket, seen);
        requests += 1;
        if (seen === killOnConnectionRequest) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(ORIGIN_BODY)),
        });
        res.end(ORIGIN_BODY);
      });
      return { server, requestCount: () => requests, bodies };
    }

    function messagesRequest(body: string, path = '/v1/messages'): string {
      return [
        `POST ${path} HTTP/1.1`,
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: keep-alive',
        '',
        '',
      ].join('\r\n') + body;
    }

    /**
     * Resolve once `count` responses have been fully DELIVERED, keyed on the
     * origin's terminating body rather than the status line. Waiting on the
     * status line only would let the next request go out while the upstream
     * socket is still busy: it would then open a fresh socket, and the reuse
     * these tests exist to exercise would silently never happen.
     */
    async function awaitResponses(
      socket: tls.TLSSocket,
      read: () => string,
      count: number,
      terminator = ORIGIN_BODY,
    ): Promise<void> {
      await awaitUntil(socket, () => read().split(terminator).length - 1 >= count,
        () => `expected ${count} x ${JSON.stringify(terminator)}, got: ${read().slice(0, 400)}`);
    }

    /**
     * Poll until `done`, then THROW on expiry. Silently returning on timeout
     * let a test that could never see its terminator burn the full deadline and
     * still pass. One `data` listener for the whole wait, not one per poll.
     */
    async function awaitUntil(
      socket: tls.TLSSocket,
      done: () => boolean,
      describe: () => string,
      timeoutMs = 10_000,
    ): Promise<void> {
      if (done()) return;
      await new Promise<void>((resolve, reject) => {
        const finish = (err?: Error): void => {
          clearInterval(poll);
          clearTimeout(timer);
          socket.off('data', onData);
          if (err) reject(err); else resolve();
        };
        const check = (): void => { if (done()) finish(); };
        const onData = (): void => check();
        const poll = setInterval(check, 25);
        const timer = setTimeout(() => finish(new Error(`timed out: ${describe()}`)), timeoutMs);
        socket.on('data', onData);
        check();
      });
    }

    /** Wait for a 502, which no ORIGIN_BODY terminator can ever match. */
    async function awaitStatus502(socket: tls.TLSSocket, read: () => string): Promise<void> {
      await awaitUntil(socket, () => read().includes('Anthropic upstream unreachable'),
        () => `expected a 502 body, got: ${read().slice(0, 400)}`);
    }

    async function readLog(path: string): Promise<Record<string, unknown>[]> {
      return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    }

    /**
     * Two keep-alive requests down one client connection. The second reuses the
     * proxy's pooled upstream socket, which the origin then resets.
     */
    async function twoRequestsOverOneConnection(logName: string, secondIs502 = false): Promise<{
      response: string;
      entries: Record<string, unknown>[];
      originRequests: number;
      bodies: string[];
    }> {
      const certificates = ensureHttpProxyCertificates();
      const inferenceLogPath = join(testHome, logName);
      const { server, requestCount, bodies } = resettingOrigin(2);
      const originPort = await listen(server);
      const proxy = await startHttpProxy({
        routes: [],
        inferenceLogPath,
        anthropicOrigin: `https://127.0.0.1:${originPort}`,
        anthropicRejectUnauthorized: false,
      });
      try {
        const secure = await connectMitm(proxy.port, certificates.caCert);
        let response = '';
        secure.on('data', chunk => { response += chunk.toString(); });

        secure.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'first' }],
        })));
        await awaitResponses(secure, () => response, 1);
        expect(response).toContain('200 OK');

        secure.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'second' }],
        })));
        if (secondIs502) await awaitStatus502(secure, () => response);
        else await awaitResponses(secure, () => response, 2);
        secure.destroy();

        return {
          response,
          entries: await readLog(inferenceLogPath),
          originRequests: requestCount(),
          bodies,
        };
      } finally {
        await proxy.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }

    it('replays a request whose pooled upstream socket was reset before any reply', async () => {
      const { response, entries, originRequests, bodies } = await twoRequestsOverOneConnection(
        'passthrough-retry-reused.jsonl',
      );

      // Both client requests were answered; the reset never reached the client.
      expect(response.split('HTTP/1.1 200 OK').length - 1).toBe(2);
      expect(response).not.toContain('502');
      expect(response).not.toContain('Anthropic upstream unreachable');
      // First request, the reset second request, and its replay.
      expect(originRequests).toBe(3);
      // The replay must carry the ORIGINAL body byte for byte. Truncating or
      // re-encoding it would still produce a 200 and leave every other
      // assertion green, so pin it here.
      const second = JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'second' }] });
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).toBe(second);
      expect(bodies[2]).toBe(bodies[1]);

      const retried = entries.filter(entry => entry['event'] === 'response_retried');
      expect(retried).toEqual([
        expect.objectContaining({
          event: 'response_retried',
          route: 'passthrough',
          phase: 'waiting_for_headers',
          errorType: 'ECONNRESET',
          terminationSource: 'upstream_failure',
          attempt: 1,
          reusedSocket: true,
        }),
      ]);
      expect(entries.some(entry => entry['event'] === 'response_failed')).toBe(false);
      // The replay's success is attributed to attempt 2, so a log reader can
      // tell a recovered request from one that never needed recovering.
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_completed',
        requestId: retried[0]!['requestId'],
        attempt: 2,
      }));
    }, 20_000);

    it('does not replay a reset on a socket it opened itself', async () => {
      const certificates = ensureHttpProxyCertificates();
      const inferenceLogPath = join(testHome, 'passthrough-retry-fresh.jsonl');
      const { server, requestCount } = resettingOrigin(1);
      const originPort = await listen(server);
      const proxy = await startHttpProxy({
        routes: [],
        inferenceLogPath,
        anthropicOrigin: `https://127.0.0.1:${originPort}`,
        anthropicRejectUnauthorized: false,
      });
      try {
        const secure = await connectMitm(proxy.port, certificates.caCert);
        let response = '';
        secure.on('data', chunk => { response += chunk.toString(); });
        secure.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'fresh socket reset' }],
        })));
        await awaitStatus502(secure, () => response);
        secure.destroy();

        expect(response).toContain('502');
        expect(response).toContain('Anthropic upstream unreachable');
        // Exactly one upstream attempt: a fresh connection may have delivered
        // the request before dying, so replaying it could duplicate the turn.
        expect(requestCount()).toBe(1);

        const entries = await readLog(inferenceLogPath);
        expect(entries.some(entry => entry['event'] === 'response_retried')).toBe(false);
        expect(entries).toContainEqual(expect.objectContaining({
          event: 'response_failed',
          route: 'passthrough',
          statusCode: 502,
          phase: 'waiting_for_headers',
          errorType: 'ECONNRESET',
          attempt: 1,
          reusedSocket: false,
        }));
      } finally {
        await proxy.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 20_000);

    it('does not replay a reused socket that already sent response headers', async () => {
      // Pins the behaviour AND the guard. A clean `destroy()` here is reported
      // on the response object, so the request-level retry decision is never
      // consulted and the test proves nothing. Resetting the RAW TCP socket
      // (the TLS socket cannot: resetAndDestroy throws ERR_INVALID_HANDLE_TYPE)
      // delivers a genuine RST, which node reports on the REQUEST -- the one
      // arrival point where a post-header replay could occur. Staged on a
      // REUSED socket so the reuse gate cannot be what produces the result.
      const certificates = ensureHttpProxyCertificates();
      const inferenceLogPath = join(testHome, 'passthrough-retry-after-headers.jsonl');
      let requests = 0;
      const perConnection = new WeakMap<net.Socket, number>();
      const rawByPort = new Map<number, net.Socket>();
      const origin = https.createServer({
        key: certificates.serverKey,
        cert: certificates.serverCert,
      }, (req, res) => {
        req.resume();
        const seen = (perConnection.get(req.socket) ?? 0) + 1;
        perConnection.set(req.socket, seen);
        requests += 1;
        if (seen === 2) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(POST_HEADER_MARKER);
          const raw = rawByPort.get(req.socket.remotePort ?? -1);
          setTimeout(() => raw?.resetAndDestroy(), 30);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(ORIGIN_BODY)),
        });
        res.end(ORIGIN_BODY);
      });
      origin.on('connection', raw => {
        const port = raw.remotePort;
        if (port !== undefined) rawByPort.set(port, raw);
      });
      const originPort = await listen(origin);
      const proxy = await startHttpProxy({
        routes: [],
        inferenceLogPath,
        anthropicOrigin: `https://127.0.0.1:${originPort}`,
        anthropicRejectUnauthorized: false,
      });
      try {
        const secure = await connectMitm(proxy.port, certificates.caCert);
        let response = '';
        secure.on('data', chunk => { response += chunk.toString(); });

        secure.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'first' }],
        })));
        await awaitResponses(secure, () => response, 1);

        secure.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'reset after headers' }],
          stream: true,
        })));
        await awaitUntil(secure, () => response.includes(POST_HEADER_MARKER),
          () => `expected the partial stream, got: ${response.slice(0, 400)}`);
        await new Promise(resolve => setTimeout(resolve, 250));
        secure.destroy();

        // The client really did receive part of a response before the reset.
        expect(response).toContain(POST_HEADER_MARKER);
        // Two client requests, two upstream attempts. A third would mean the
        // half-delivered response was replayed.
        expect(requests).toBe(2);
        const entries = await readLog(inferenceLogPath);
        expect(entries.some(entry => entry['event'] === 'response_retried')).toBe(false);
      } finally {
        await proxy.close();
        await new Promise<void>(resolve => origin.close(() => resolve()));
      }
    }, 20_000);

    it('identifies a failure whose error carries no message', () => {
      // Observed live on this branch: ETIMEDOUT with an empty message rendered
      // as "Anthropic upstream unreachable: ." and told the reader nothing.
      expect(upstreamUnreachableDetail(Object.assign(new Error(''), { code: 'ETIMEDOUT' })))
        .toBe('ETIMEDOUT');
      // A real message still wins -- it says more than the code does.
      expect(upstreamUnreachableDetail(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })))
        .toBe('socket hang up');
      // And something is always produced, however bare the error.
      expect(upstreamUnreachableDetail(new Error(''))).toBe('Error');
      expect(upstreamUnreachableDetail(Object.assign(new Error(''), { name: '' })))
        .toBe('connection failed');
    });

    it('keeps the idle-eviction the global pool it replaces already had', () => {
      // Expressed as parity, not a magic 5000: the invariant is "no worse than
      // https.globalAgent at dropping idle sockets". Dropping `timeout` leaves
      // dead sockets pooled forever and makes the stale reset MORE likely.
      const agent = createPassthroughAgent();
      try {
        expect(agent.keepAlive).toBe(true);
        expect(agent.options.timeout).toBeDefined();
        expect(agent.options.timeout).toBe(https.globalAgent.options.timeout);
      } finally {
        agent.destroy();
      }
    });

    it('pools passthrough connections in its own agent, not the process-wide one', async () => {
      // Falling back to https.globalAgent shares a pool with every other https
      // client in the process and survives close(). Reuse alone cannot detect
      // that -- globalAgent is keep-alive too -- so assert the pool identity.
      const certificates = ensureHttpProxyCertificates();
      const { server } = resettingOrigin(0);
      const originPort = await listen(server);
      // Agent pool keys carry TLS options too, so match on the origin's port
      // rather than reconstructing the whole key.
      const globalPoolHasOrigin = (): boolean =>
        [...Object.keys(https.globalAgent.freeSockets), ...Object.keys(https.globalAgent.sockets)]
          .some(key => key.startsWith(`127.0.0.1:${originPort}:`));
      expect(globalPoolHasOrigin()).toBe(false);
      const proxy = await startHttpProxy({
        routes: [],
        anthropicOrigin: `https://127.0.0.1:${originPort}`,
        anthropicRejectUnauthorized: false,
      });
      try {
        const secure = await connectMitm(proxy.port, certificates.caCert);
        let response = '';
        secure.on('data', chunk => { response += chunk.toString(); });
        secure.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'pool identity' }],
        })));
        await awaitResponses(secure, () => response, 1);
        secure.destroy();

        expect(response).toContain('200 OK');
        // The kept-alive upstream socket must be parked in the proxy's own pool.
        expect(globalPoolHasOrigin()).toBe(false);
      } finally {
        await proxy.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 20_000);

    it('does not replay, or blame upstream, when the proxy itself is shutting down', async () => {
      // close() destroys the passthrough pool, which surfaces on an in-flight
      // request as a socket error indistinguishable from an upstream fault.
      // Replaying then is pointless work against a dying proxy, and recording
      // it as `upstream_failure` sends a log reader after Anthropic.
      const certificates = ensureHttpProxyCertificates();
      const inferenceLogPath = join(testHome, 'passthrough-retry-shutdown.jsonl');
      let sawSecond: () => void = () => {};
      const secondSeen = new Promise<void>(resolve => { sawSecond = resolve; });
      let requests = 0;
      const perConnection = new WeakMap<net.Socket, number>();
      const origin = https.createServer({
        key: certificates.serverKey,
        cert: certificates.serverCert,
      }, (req, res) => {
        req.resume();
        const seen = (perConnection.get(req.socket) ?? 0) + 1;
        perConnection.set(req.socket, seen);
        requests += 1;
        // Answer the first so the upstream socket is POOLED, then hold the
        // second open across the shutdown. Staged on a reused socket so the
        // reuse gate is not what suppresses the replay.
        if (seen === 1) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(ORIGIN_BODY)),
          });
          res.end(ORIGIN_BODY);
          return;
        }
        req.once('end', () => sawSecond());
      });
      const originPort = await listen(origin);
      const proxy = await startHttpProxy({
        routes: [],
        inferenceLogPath,
        anthropicOrigin: `https://127.0.0.1:${originPort}`,
        anthropicRejectUnauthorized: false,
      });
      let closed = false;
      try {
        const secure = await connectMitm(proxy.port, certificates.caCert);
        let response = '';
        secure.on('data', chunk => { response += chunk.toString(); });
        secure.on('error', () => {});
        secure.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'first' }],
        })));
        await awaitResponses(secure, () => response, 1);
        secure.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'in flight at shutdown' }],
        })));
        await secondSeen;

        await proxy.close();
        closed = true;
        secure.destroy();
        await new Promise(resolve => setTimeout(resolve, 200));

        const entries = await readLog(inferenceLogPath);
        expect(entries.some(entry => entry['event'] === 'response_retried')).toBe(false);
        const upstreamBlamed = entries.filter(entry =>
          entry['event'] === 'response_failed'
          && entry['terminationSource'] === 'upstream_failure');
        expect(upstreamBlamed).toEqual([]);
        // A third upstream request would mean the dying proxy replayed.
        expect(requests).toBe(2);
      } finally {
        if (!closed) await proxy.close();
        await new Promise<void>(resolve => origin.close(() => resolve()));
      }
    }, 20_000);

    it('honours CLODEX_UPSTREAM_MAX_RETRIES=0 by surfacing the reset', async () => {
      const previous = process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
      process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = '0';
      try {
        const { response, entries, originRequests } = await twoRequestsOverOneConnection(
          'passthrough-retry-disabled.jsonl',
          true,
        );
        expect(response).toContain('502');
        expect(originRequests).toBe(2);
        expect(entries.some(entry => entry['event'] === 'response_retried')).toBe(false);
        expect(entries).toContainEqual(expect.objectContaining({
          event: 'response_failed',
          statusCode: 502,
          errorType: 'ECONNRESET',
          attempt: 1,
          reusedSocket: true,
        }));
      } finally {
        if (previous === undefined) delete process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
        else process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = previous;
      }
    }, 20_000);

    it('replays a reset pooled socket only as often as the retry budget allows', async () => {
      // Three pooled sockets that the origin resets on reuse. With one replay
      // allowed, the request fails on the second reset; an unbounded replay
      // would walk every pooled socket and then succeed on a fresh one.
      const certificates = ensureHttpProxyCertificates();
      const inferenceLogPath = join(testHome, 'passthrough-retry-bounded.jsonl');
      let requests = 0;
      const perConnection = new WeakMap<net.Socket, number>();
      const origin = https.createServer({
        key: certificates.serverKey,
        cert: certificates.serverCert,
      }, (req, res) => {
        req.resume();
        const seen = (perConnection.get(req.socket) ?? 0) + 1;
        perConnection.set(req.socket, seen);
        requests += 1;
        if (seen > 1) {
          req.socket.destroy();
          return;
        }
        // Slow enough that the three warm-up requests each open their own socket.
        setTimeout(() => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(ORIGIN_BODY)),
          });
          res.end(ORIGIN_BODY);
        }, 300);
      });
      const originPort = await listen(origin);
      const proxy = await startHttpProxy({
        routes: [],
        inferenceLogPath,
        anthropicOrigin: `https://127.0.0.1:${originPort}`,
        anthropicRejectUnauthorized: false,
      });
      try {
        const clients = await Promise.all([0, 1, 2].map(() => connectMitm(proxy.port, certificates.caCert)));
        const responses = clients.map(() => '');
        clients.forEach((client, i) => client.on('data', chunk => { responses[i] += chunk.toString(); }));
        clients.forEach((client, i) => client.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: `warm ${i}` }],
        }))));
        await Promise.all(clients.map((client, i) => awaitResponses(client, () => responses[i]!, 1)));
        expect(requests).toBe(3);

        clients[0]!.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'on a pooled socket' }],
        })));
        await awaitStatus502(clients[0]!, () => responses[0]!);
        for (const client of clients) client.destroy();

        // Three warm-ups, the reset attempt, and exactly one replay.
        expect(requests).toBe(5);
        const entries = await readLog(inferenceLogPath);
        expect(entries.filter(entry => entry['event'] === 'response_retried')).toHaveLength(1);
        expect(entries).toContainEqual(expect.objectContaining({
          event: 'response_failed',
          errorType: 'ECONNRESET',
          attempt: 2,
          reusedSocket: true,
        }));
      } finally {
        await proxy.close();
        await new Promise<void>(resolve => origin.close(() => resolve()));
      }
    }, 20_000);

    describe('outage hold', () => {
      const HOLD_ENV = 'CLODEX_PASSTHROUGH_OUTAGE_HOLD_MS';
      let previousHold: string | undefined;
      beforeEach(() => { previousHold = process.env[HOLD_ENV]; });
      afterEach(() => {
        if (previousHold === undefined) delete process.env[HOLD_ENV];
        else process.env[HOLD_ENV] = previousHold;
      });

      function okOrigin(): { server: https.Server; bodies: string[] } {
        const certificates = ensureHttpProxyCertificates();
        const bodies: string[] = [];
        const server = https.createServer({ key: certificates.serverKey, cert: certificates.serverCert }, (req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.once('end', () => {
            bodies.push(Buffer.concat(chunks).toString());
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(ORIGIN_BODY)),
            });
            res.end(ORIGIN_BODY);
          });
        });
        return { server, bodies };
      }

      async function freePort(): Promise<number> {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1');
        await once(probe, 'listening');
        const port = (probe.address() as net.AddressInfo).port;
        await new Promise<void>(resolve => probe.close(() => resolve()));
        return port;
      }

      /** A resolver that fails every lookup with `code`, so DNS tests stay hermetic. */
      function failingLookup(code: string): { lookup: net.LookupFunction; calls: () => number } {
        let calls = 0;
        const lookup = ((
          hostname: string,
          _options: unknown,
          callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
        ) => {
          calls += 1;
          const err: NodeJS.ErrnoException = Object.assign(
            new Error(`getaddrinfo ${code} ${hostname}`),
            { code, syscall: 'getaddrinfo', hostname },
          );
          process.nextTick(() => callback(err, '', 0));
        }) as unknown as net.LookupFunction;
        return { lookup, calls: () => calls };
      }

      /** A TCP origin that never answers TLS; `onConnection` decides what each connection does. */
      async function rawOrigin(onConnection: (socket: net.Socket) => void): Promise<{
        port: number;
        connections: () => number;
        close: () => Promise<void>;
      }> {
        const sockets: net.Socket[] = [];
        const server = net.createServer(socket => {
          sockets.push(socket);
          socket.on('error', () => {});
          // Discard the ClientHello; a paused socket never reports the close.
          socket.resume();
          onConnection(socket);
        });
        const port = await listen(server);
        return {
          port,
          connections: () => sockets.length,
          close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
          },
        };
      }

      /** Send one messages request and time it to its 502. */
      async function heldRequestTo502(proxyPort: number, ca: string, content: string, path?: string): Promise<{
        response: string;
        heldMs: number;
      }> {
        const secure = await connectMitm(proxyPort, ca);
        let response = '';
        secure.on('data', chunk => { response += chunk.toString(); });
        const sentAt = Date.now();
        secure.write(messagesRequest(
          JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content }] }),
          path,
        ));
        await awaitStatus502(secure, () => response);
        const heldMs = Date.now() - sentAt;
        secure.destroy();
        expect(response).toContain('HTTP/1.1 502');
        return { response, heldMs };
      }

      it('holds a request whose upstream name does not resolve, then answers 502 when the hold is spent', async () => {
        // A simulated DNS outage, hermetic: the injected resolver fails every
        // lookup, so the host's own resolver cannot change the result. The
        // request carries the `?beta=true` query Claude Code really sends.
        process.env[HOLD_ENV] = '2500';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-dns.jsonl');
        const resolver = failingLookup('ENOTFOUND');
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: 'https://clodex-outage-test.invalid',
          anthropicRejectUnauthorized: false,
          anthropicLookup: resolver.lookup,
        });
        try {
          const { response, heldMs } = await heldRequestTo502(
            proxy.port,
            certificates.caCert,
            'dns',
            '/v1/messages?beta=true',
          );

          // Held for the whole budget rather than failing in milliseconds, and
          // no longer than it.
          expect(heldMs).toBeGreaterThanOrEqual(2_400);
          expect(heldMs).toBeLessThan(3_300);
          expect(response).toContain('Anthropic upstream unreachable: outage hold of 2500 ms expired');
          expect(response).toContain('last upstream error: getaddrinfo ENOTFOUND');
          const entries = await readLog(inferenceLogPath);
          const retried = entries.filter(entry => entry['event'] === 'response_retried');
          expect(retried.length).toBeGreaterThanOrEqual(2);
          expect(resolver.calls()).toBe(retried.length);
          for (const entry of retried) {
            expect(entry).toMatchObject({
              outageHold: true,
              reusedSocket: false,
              phase: 'waiting_for_headers',
              errorType: 'ENOTFOUND',
            });
          }
          // Backoff doubles: 1 s, then the remainder of the budget. The hold is
          // counted from the request's arrival, so the first failure is near 0.
          expect(retried[0]).toMatchObject({ retryDelayMs: 1_000 });
          expect(retried[0]!['holdElapsedMs']).toBeLessThan(500);
          expect(entries).toContainEqual(expect.objectContaining({
            event: 'response_failed',
            statusCode: 502,
            outageHold: true,
          }));
        } finally {
          await proxy.close();
        }
      }, 20_000);

      it('backs off 1 s then 2 s, and cuts the last wait to the deadline', async () => {
        // 4 s budget: attempts at 0, 1 and 3 s, then the third wait is cut from
        // 4 s to the ~1 s left and the 502 arrives at the deadline. Also pins
        // ETIMEDOUT, the timeout class, as a failure that is held.
        process.env[HOLD_ENV] = '4000';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-backoff.jsonl');
        const resolver = failingLookup('ETIMEDOUT');
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: 'https://clodex-outage-test.invalid',
          anthropicRejectUnauthorized: false,
          anthropicLookup: resolver.lookup,
        });
        try {
          const { heldMs } = await heldRequestTo502(proxy.port, certificates.caCert, 'backoff');

          expect(heldMs).toBeGreaterThanOrEqual(3_900);
          expect(heldMs).toBeLessThan(4_700);
          expect(resolver.calls()).toBe(3);
          const retried = (await readLog(inferenceLogPath))
            .filter(entry => entry['event'] === 'response_retried');
          expect(retried.map(entry => entry['errorType'])).toEqual(['ETIMEDOUT', 'ETIMEDOUT', 'ETIMEDOUT']);
          expect(retried[0]!['retryDelayMs']).toBe(1_000);
          expect(retried[1]!['retryDelayMs']).toBe(2_000);
          expect(retried[2]!['retryDelayMs']).toBeGreaterThan(700);
          // A few ms over 1 s is possible: the earlier waits can fire a
          // millisecond early on Node's timer clock, leaving more time to cut to.
          expect(retried[2]!['retryDelayMs']).toBeLessThanOrEqual(1_050);
        } finally {
          await proxy.close();
        }
      }, 20_000);

      it('answers at the deadline when each connect takes long to fail', async () => {
        // The origin accepts TCP, waits 2.5 s, then resets before TLS. With a
        // 3 s hold the 502 must arrive at ~3 s: the hold is counted from the
        // request's arrival and is not restarted by a slow failure.
        process.env[HOLD_ENV] = '3000';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-slow.jsonl');
        const origin = await rawOrigin(socket => {
          setTimeout(() => socket.resetAndDestroy(), 2_500);
        });
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${origin.port}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const { response, heldMs } = await heldRequestTo502(proxy.port, certificates.caCert, 'slow');

          expect(heldMs).toBeGreaterThanOrEqual(2_900);
          expect(heldMs).toBeLessThan(4_000);
          expect(response).toContain('outage hold of 3000 ms expired');
          expect(origin.connections()).toBe(1);
          const retried = (await readLog(inferenceLogPath))
            .filter(entry => entry['event'] === 'response_retried');
          expect(retried).toEqual([expect.objectContaining({ outageHold: true, errorType: 'ECONNRESET' })]);
        } finally {
          await proxy.close();
          await origin.close();
        }
      }, 20_000);

      it('ends an attempt whose TLS handshake never answers at the deadline', async () => {
        process.env[HOLD_ENV] = '1500';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-silent-tls.jsonl');
        const closedByProxy: Promise<unknown>[] = [];
        const origin = await rawOrigin(socket => { closedByProxy.push(once(socket, 'close')); });
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${origin.port}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const { response, heldMs } = await heldRequestTo502(proxy.port, certificates.caCert, 'silent tls');

          expect(heldMs).toBeGreaterThanOrEqual(1_400);
          expect(heldMs).toBeLessThan(2_500);
          expect(response).toContain('outage hold of 1500 ms expired before the TLS handshake completed');
          expect(response).not.toContain('last upstream error');
          expect(origin.connections()).toBe(1);
          // The pending attempt is torn down, not left open behind the 502.
          await Promise.race([
            Promise.all(closedByProxy),
            new Promise((_, reject) => setTimeout(() => reject(new Error('attempt left open')), 2_000)),
          ]);
          expect((await readLog(inferenceLogPath))).toContainEqual(expect.objectContaining({
            event: 'response_failed',
            statusCode: 502,
            errorType: 'outage_hold_expired',
            outageHold: true,
          }));
        } finally {
          await proxy.close();
          await origin.close();
        }
      }, 20_000);

      it('holds a fresh socket that is reset before TLS completes', async () => {
        process.env[HOLD_ENV] = '2500';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-reset-before-tls.jsonl');
        const origin = await rawOrigin(socket => socket.resetAndDestroy());
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${origin.port}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const { heldMs } = await heldRequestTo502(proxy.port, certificates.caCert, 'reset before tls');

          expect(heldMs).toBeGreaterThanOrEqual(2_400);
          expect(origin.connections()).toBeGreaterThanOrEqual(2);
          const retried = (await readLog(inferenceLogPath))
            .filter(entry => entry['event'] === 'response_retried');
          // Every failed attempt is held; the last wait ends at the deadline.
          expect(retried.length).toBe(origin.connections());
          for (const entry of retried) {
            expect(entry).toMatchObject({ outageHold: true, reusedSocket: false, errorType: 'ECONNRESET' });
          }
        } finally {
          await proxy.close();
          await origin.close();
        }
      }, 20_000);

      it('answers 502 at once, with one request seen, when a fresh socket is reset after TLS', async () => {
        // The request bytes go out once TLS completes, so a reset after that may
        // follow a request the origin received. The hold must not retry it.
        process.env[HOLD_ENV] = '3000';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-reset-after-tls.jsonl');
        const { server, requestCount } = resettingOrigin(1);
        const originPort = await listen(server);
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${originPort}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const { heldMs } = await heldRequestTo502(proxy.port, certificates.caCert, 'reset after tls');

          expect(heldMs).toBeLessThan(900);
          expect(requestCount()).toBe(1);
          const entries = await readLog(inferenceLogPath);
          expect(entries.some(entry => entry['event'] === 'response_retried')).toBe(false);
          expect(entries).toContainEqual(expect.objectContaining({
            event: 'response_failed',
            errorType: 'ECONNRESET',
            reusedSocket: false,
          }));
        } finally {
          await proxy.close();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      }, 20_000);

      it('never cuts a request whose TLS completed, however long the answer takes', async () => {
        // Once TLS completes the request bytes can go out, so the deadline stops
        // there: an origin that answers after the hold budget is still waited for.
        process.env[HOLD_ENV] = '800';
        const certificates = ensureHttpProxyCertificates();
        const bodies: string[] = [];
        const origin = https.createServer({ key: certificates.serverKey, cert: certificates.serverCert }, (req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.once('end', () => {
            bodies.push(Buffer.concat(chunks).toString());
            setTimeout(() => {
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(ORIGIN_BODY)),
              });
              res.end(ORIGIN_BODY);
            }, 1_600);
          });
        });
        const originPort = await listen(origin);
        const proxy = await startHttpProxy({
          routes: [],
          anthropicOrigin: `https://127.0.0.1:${originPort}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const secure = await connectMitm(proxy.port, certificates.caCert);
          let response = '';
          secure.on('data', chunk => { response += chunk.toString(); });
          secure.write(messagesRequest(JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'slow answer' }] })));
          await awaitResponses(secure, () => response, 1);
          secure.destroy();

          expect(response).toContain('200 OK');
          expect(response).not.toContain('502');
          expect(bodies).toHaveLength(1);
        } finally {
          await proxy.close();
          await new Promise<void>(resolve => origin.close(() => resolve()));
        }
      }, 20_000);

      /**
       * An origin whose first request on any connection is answered after a short
       * delay. The first request it sees on an already-used connection is held,
       * unanswered, until `resetAfterMs`, then the raw TCP socket is reset; any
       * later request on a used connection is answered at once.
       */
      function lateResetOrigin(resetAfterMs: number): {
        server: https.Server;
        requests: () => number;
        tlsConnections: () => number;
        resetAt: () => number | undefined;
      } {
        const certificates = ensureHttpProxyCertificates();
        let requests = 0;
        let tlsConnections = 0;
        let resetAt: number | undefined;
        let reuseSeen = 0;
        const perConnection = new WeakMap<net.Socket, number>();
        const rawByPort = new Map<number, net.Socket>();
        const server = https.createServer({ key: certificates.serverKey, cert: certificates.serverCert }, (req, res) => {
          req.resume();
          const seen = (perConnection.get(req.socket) ?? 0) + 1;
          perConnection.set(req.socket, seen);
          requests += 1;
          const answer = (): void => {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(ORIGIN_BODY)),
            });
            res.end(ORIGIN_BODY);
          };
          if (seen === 1) {
            setTimeout(answer, 200);
            return;
          }
          reuseSeen += 1;
          if (reuseSeen === 1) {
            const raw = rawByPort.get(req.socket.remotePort ?? -1);
            setTimeout(() => { resetAt = Date.now(); raw?.resetAndDestroy(); }, resetAfterMs);
            return;
          }
          answer();
        });
        server.on('connection', raw => {
          const port = raw.remotePort;
          if (port !== undefined) rawByPort.set(port, raw);
        });
        server.on('secureConnection', () => { tlsConnections += 1; });
        return {
          server,
          requests: () => requests,
          tlsConnections: () => tlsConnections,
          resetAt: () => resetAt,
        };
      }

      async function warmPooledSockets(proxyPort: number, ca: string, count: number): Promise<{
        clients: tls.TLSSocket[];
        responses: string[];
      }> {
        const clients = await Promise.all(Array.from({ length: count }, () => connectMitm(proxyPort, ca)));
        const responses = clients.map(() => '');
        clients.forEach((client, i) => client.on('data', chunk => { responses[i] += chunk.toString(); }));
        clients.forEach((client, i) => client.write(messagesRequest(JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: `warm ${i}` }],
        }))));
        await Promise.all(clients.map((client, i) => awaitResponses(client, () => responses[i]!, 1)));
        return { clients, responses };
      }

      it('answers 502 at once when a replay after the deadline needs a fresh socket', async () => {
        // The request goes out on a pooled socket, the origin holds it past the
        // 1.5 s deadline and then resets it. With no idle socket left, the replay
        // needs a fresh connection after the deadline, and the hold bounds every
        // fresh pre-TLS attempt by that deadline, however late it starts.
        process.env[HOLD_ENV] = '1500';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-late-replay-fresh.jsonl');
        const origin = lateResetOrigin(2_000);
        const originPort = await listen(origin.server);
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${originPort}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const { clients, responses } = await warmPooledSockets(proxy.port, certificates.caCert, 1);
          expect(origin.tlsConnections()).toBe(1);
          const before = responses[0]!.length;
          clients[0]!.write(messagesRequest(JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'late replay' }] })));
          await awaitUntil(clients[0]!, () => responses[0]!.slice(before).includes('Anthropic upstream unreachable'),
            () => `expected a 502 body, got: ${responses[0]!.slice(before, before + 400)}`);
          const answeredAt = Date.now();
          for (const client of clients) client.destroy();

          const late = responses[0]!.slice(before);
          expect(late).toContain('HTTP/1.1 502');
          // Nothing failed to connect, so the 502 names the late reset, not an outage.
          expect(late).toContain(
            'reused connection was reset and the outage hold of 1500 ms had expired before the request could be resent',
          );
          expect(late).not.toContain('expired before the TLS handshake completed');
          // Answered as soon as the reset arrived, without waiting on a new connection.
          expect(answeredAt - origin.resetAt()!).toBeLessThan(300);
          // No fresh connection completed TLS: the replay never reached the origin.
          expect(origin.tlsConnections()).toBe(1);
          expect(origin.requests()).toBe(2);
          const entries = await readLog(inferenceLogPath);
          expect(entries).toContainEqual(expect.objectContaining({
            event: 'response_retried',
            reusedSocket: true,
            errorType: 'ECONNRESET',
          }));
          expect(entries).toContainEqual(expect.objectContaining({
            event: 'response_failed',
            statusCode: 502,
            errorType: 'outage_hold_expired',
            outageHold: true,
            attempt: 2,
          }));
        } finally {
          await proxy.close();
          await new Promise<void>(resolve => origin.server.close(() => resolve()));
        }
      }, 20_000);

      it('keeps the outage message on a held retry that starts after the deadline', async () => {
        // A held retry is started only before the deadline, but building its
        // request can carry it past: the clock is read again after the request
        // exists. Such an attempt is cut when its socket arrives, like a late
        // replay, yet it follows an outage, not a reset of a reused connection,
        // so its 502 must keep saying the outage hold expired. The second lookup
        // moves the clock past the deadline while the request is being built.
        process.env[HOLD_ENV] = '1500';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-late-held-retry.jsonl');
        const realNow = Date.now.bind(Date);
        let clockShiftMs = 0;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockShiftMs);
        let lookups = 0;
        const lookup = ((
          hostname: string,
          _options: unknown,
          callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
        ) => {
          lookups += 1;
          if (lookups === 2) clockShiftMs = 1_000;
          const err: NodeJS.ErrnoException = Object.assign(
            new Error(`getaddrinfo ENOTFOUND ${hostname}`),
            { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname },
          );
          setTimeout(() => callback(err, '', 0), 50);
        }) as unknown as net.LookupFunction;
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: 'https://clodex-outage-test.invalid',
          anthropicRejectUnauthorized: false,
          anthropicLookup: lookup,
        });
        try {
          const { response } = await heldRequestTo502(proxy.port, certificates.caCert, 'late held retry');

          expect(lookups).toBe(2);
          expect(response).toContain('outage hold of 1500 ms expired before the TLS handshake completed');
          expect(response).toContain('last upstream error: getaddrinfo ENOTFOUND');
          expect(response).not.toContain('reused connection');
          const entries = await readLog(inferenceLogPath);
          expect(entries).toContainEqual(expect.objectContaining({
            event: 'response_failed',
            errorType: 'outage_hold_expired',
            attempt: 2,
          }));
        } finally {
          clock.mockRestore();
          await proxy.close();
        }
      }, 20_000);

      it('lets a replay after the deadline go ahead on a reused socket', async () => {
        // Same timeline with a second pooled socket left idle: the replay gets a
        // reused connection, which the hold never cuts, and is answered.
        process.env[HOLD_ENV] = '1500';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-late-replay-reused.jsonl');
        const origin = lateResetOrigin(2_000);
        const originPort = await listen(origin.server);
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${originPort}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const { clients, responses } = await warmPooledSockets(proxy.port, certificates.caCert, 2);
          expect(origin.tlsConnections()).toBe(2);
          const before = responses[0]!.length;
          const sentAt = Date.now();
          clients[0]!.write(messagesRequest(JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'late replay' }] })));
          await awaitUntil(clients[0]!, () => responses[0]!.slice(before).includes(ORIGIN_BODY),
            () => `expected the replay's answer, got: ${responses[0]!.slice(before, before + 400)}`);
          const answeredMs = Date.now() - sentAt;
          for (const client of clients) client.destroy();

          expect(responses[0]!.slice(before)).toContain('200 OK');
          expect(responses[0]!.slice(before)).not.toContain('502');
          // Answered after the deadline, on the second pooled connection.
          expect(answeredMs).toBeGreaterThanOrEqual(1_900);
          expect(origin.tlsConnections()).toBe(2);
          expect(origin.requests()).toBe(4);
          const entries = await readLog(inferenceLogPath);
          expect(entries.some(entry => entry['event'] === 'response_failed')).toBe(false);
          expect(entries).toContainEqual(expect.objectContaining({ event: 'response_completed', attempt: 2 }));
        } finally {
          await proxy.close();
          await new Promise<void>(resolve => origin.server.close(() => resolve()));
        }
      }, 20_000);

      it('does not hold a certificate failure', async () => {
        // A TLS verification error is a configuration fault, not an outage, and
        // holding it would only turn a clear error into a silent wait.
        process.env[HOLD_ENV] = '3000';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-cert.jsonl');
        const { server } = okOrigin();
        let connections = 0;
        server.on('connection', () => { connections += 1; });
        const originPort = await listen(server);
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${originPort}`,
          anthropicRejectUnauthorized: true,
        });
        try {
          const { heldMs } = await heldRequestTo502(proxy.port, certificates.caCert, 'cert');

          expect(heldMs).toBeLessThan(900);
          expect(connections).toBe(1);
          const entries = await readLog(inferenceLogPath);
          expect(entries.some(entry => entry['event'] === 'response_retried')).toBe(false);
        } finally {
          await proxy.close();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      }, 20_000);

      it.each([
        ['count_tokens', 'POST', '/v1/messages/count_tokens'],
        ['an OAuth call', 'GET', '/api/oauth/profile'],
        ['telemetry', 'POST', '/api/event_logging/batch'],
      ])('does not hold %s', async (_name, method, path) => {
        process.env[HOLD_ENV] = '3000';
        const certificates = ensureHttpProxyCertificates();
        const resolver = failingLookup('ENOTFOUND');
        const proxy = await startHttpProxy({
          routes: [],
          anthropicOrigin: `https://127.0.0.1:${await freePort()}`,
          anthropicRejectUnauthorized: false,
          anthropicLookup: resolver.lookup,
        });
        try {
          const secure = await connectMitm(proxy.port, certificates.caCert);
          let response = '';
          secure.on('data', chunk => { response += chunk.toString(); });
          const body = method === 'GET'
            ? ''
            : JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'aux' }] });
          const sentAt = Date.now();
          secure.write([
            `${method} ${path} HTTP/1.1`,
            'Host: api.anthropic.com',
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: keep-alive',
            '',
            '',
          ].join('\r\n') + body);
          await awaitStatus502(secure, () => response);
          expect(Date.now() - sentAt).toBeLessThan(900);
          secure.destroy();
        } finally {
          await proxy.close();
        }
      }, 20_000);

      it('still replays a pooled socket that resets after the hold has retried', async () => {
        // The pooled-socket replay has its own budget. Counting it on the shared
        // attempt number would spend it on the hold's retries and turn a
        // recoverable stale socket into a 502.
        process.env[HOLD_ENV] = '10000';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-then-reuse.jsonl');
        const port = await freePort();
        const { server, requestCount } = resettingOrigin(2);
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${port}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const held = await connectMitm(proxy.port, certificates.caCert);
          let heldResponse = '';
          held.on('data', chunk => { heldResponse += chunk.toString(); });
          held.write(messagesRequest(JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'held' }] })));
          // The first attempt is refused; the hold retries at 1 s. Bring the
          // origin up and pool one socket with another request before then, so
          // the retry is handed that socket, which the origin then resets.
          await new Promise(resolve => setTimeout(resolve, 200));
          server.listen(port, '127.0.0.1');
          await once(server, 'listening');
          const other = await connectMitm(proxy.port, certificates.caCert);
          let otherResponse = '';
          other.on('data', chunk => { otherResponse += chunk.toString(); });
          other.write(messagesRequest(JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'pool' }] })));
          await awaitResponses(other, () => otherResponse, 1);
          await awaitResponses(held, () => heldResponse, 1);
          held.destroy();
          other.destroy();

          expect(heldResponse).toContain('200 OK');
          // The pooling request, the held request's reset on the pooled socket,
          // and its replay on a fresh one.
          expect(requestCount()).toBe(3);
          const retried = (await readLog(inferenceLogPath))
            .filter(entry => entry['event'] === 'response_retried');
          expect(retried).toEqual([
            expect.objectContaining({ outageHold: true, errorType: 'ECONNREFUSED', attempt: 1 }),
            expect.objectContaining({ reusedSocket: true, errorType: 'ECONNRESET', attempt: 2 }),
          ]);
        } finally {
          await proxy.close();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      }, 20_000);
      it('delivers the request once, unchanged, when the upstream comes back during the hold', async () => {
        process.env[HOLD_ENV] = '10000';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-recover.jsonl');
        const port = await freePort();
        const { server, bodies } = okOrigin();
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${port}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const secure = await connectMitm(proxy.port, certificates.caCert);
          let response = '';
          secure.on('data', chunk => { response += chunk.toString(); });
          const body = JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'recover' }] });
          secure.write(messagesRequest(body));
          // Nothing listens yet: every attempt is refused. Bring the origin up mid-hold.
          await new Promise(resolve => setTimeout(resolve, 1_500));
          server.listen(port, '127.0.0.1');
          await once(server, 'listening');
          await awaitResponses(secure, () => response, 1);
          secure.destroy();

          expect(response).toContain('200 OK');
          expect(response).not.toContain('502');
          // Exactly one delivery, byte for byte: the refused attempts sent nothing.
          expect(bodies).toEqual([body]);
          const entries = await readLog(inferenceLogPath);
          const retried = entries.filter(entry => entry['event'] === 'response_retried');
          expect(retried.length).toBeGreaterThanOrEqual(1);
          for (const entry of retried) expect(entry).toMatchObject({ outageHold: true, errorType: 'ECONNREFUSED' });
          expect(entries).toContainEqual(expect.objectContaining({
            event: 'response_completed',
            attempt: retried.length + 1,
          }));
        } finally {
          await proxy.close();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      }, 20_000);

      it('answers 502 at once when the hold is turned off', async () => {
        process.env[HOLD_ENV] = '0';
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-off.jsonl');
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${await freePort()}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const secure = await connectMitm(proxy.port, certificates.caCert);
          let response = '';
          secure.on('data', chunk => { response += chunk.toString(); });
          const sentAt = Date.now();
          secure.write(messagesRequest(JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'off' }] })));
          await awaitStatus502(secure, () => response);
          expect(Date.now() - sentAt).toBeLessThan(900);
          secure.destroy();
          const entries = await readLog(inferenceLogPath);
          expect(entries.some(entry => entry['event'] === 'response_retried')).toBe(false);
        } finally {
          await proxy.close();
        }
      }, 20_000);

      it('stops retrying when the client gives up during the hold', async () => {
        // Counts connections at the origin, not log lines: an attempt made after
        // the client left logs nothing, so only the origin can see it. The hold
        // is long enough that a slow host still leaves a retry wait to cancel.
        const holdMs = 30_000;
        process.env[HOLD_ENV] = String(holdMs);
        const certificates = ensureHttpProxyCertificates();
        const inferenceLogPath = join(testHome, 'passthrough-outage-abandon.jsonl');
        const origin = await rawOrigin(socket => socket.resetAndDestroy());
        const proxy = await startHttpProxy({
          routes: [],
          inferenceLogPath,
          anthropicOrigin: `https://127.0.0.1:${origin.port}`,
          anthropicRejectUnauthorized: false,
        });
        try {
          const secure = await connectMitm(proxy.port, certificates.caCert);
          secure.write(messagesRequest(JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'abandon' }] })));
          // Leave once the second attempt has failed and its wait has begun.
          const retriedSoFar = (): Record<string, unknown>[] => (existsSync(inferenceLogPath)
            ? readFileSync(inferenceLogPath, 'utf8').trim().split('\n')
              .map(line => JSON.parse(line) as Record<string, unknown>)
              .filter(entry => entry['event'] === 'response_retried')
            : []);
          await awaitUntil(secure, () => origin.connections() >= 2 && retriedSoFar().length >= 2,
            () => `expected 2 held attempts, saw ${origin.connections()} connections, ${retriedSoFar().length} retries`);
          const pendingWait = retriedSoFar()[1]!;
          const waitEndsAt = Date.parse(pendingWait['timestamp'] as string) + (pendingWait['retryDelayMs'] as number);
          // The wait being cancelled must end before the deadline, so the only
          // thing it can lead to is another attempt, and it must not have ended
          // yet, so there is still an attempt for the disconnect to prevent.
          expect((pendingWait['holdElapsedMs'] as number) + (pendingWait['retryDelayMs'] as number))
            .toBeLessThan(holdMs);
          expect(Date.now()).toBeLessThan(waitEndsAt);
          expect(origin.connections()).toBe(2);
          secure.destroy();
          await new Promise(resolve => setTimeout(resolve, Math.max(0, waitEndsAt - Date.now()) + 1_500));

          // Nothing ran after the disconnect: no new attempt and no 502.
          expect(origin.connections()).toBe(2);
          const entries = await readLog(inferenceLogPath);
          const disconnectedAt = entries.findIndex(entry => entry['event'] === 'response_client_disconnected');
          expect(disconnectedAt).toBeGreaterThanOrEqual(0);
          expect(entries.slice(disconnectedAt + 1)).toEqual([]);
          expect(entries.filter(entry => entry['event'] === 'response_retried')).toHaveLength(2);
          expect(entries.some(entry => entry['event'] === 'response_failed' || entry['statusCode'] === 502))
            .toBe(false);
        } finally {
          await proxy.close();
          await origin.close();
        }
      }, 20_000);
    });
  });

});
