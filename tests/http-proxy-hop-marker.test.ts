import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';

const proxyEnv = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_TLS_REJECT_UNAUTHORIZED'] as const;
const savedEnv = Object.fromEntries(proxyEnv.map(name => [name, process.env[name]]));
const hopHeader = 'x-clodex-proxy-hop';

afterEach(() => {
  for (const name of proxyEnv) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

async function request(port: number, path: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function connect(port: number, target: string, extraHeaders = ''): Promise<string> {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extraHeaders}\r\n`);
    return await new Promise<string>((resolve, reject) => {
      let received = '';
      const timer = setTimeout(() => reject(new Error(`CONNECT timed out: ${received}`)), 3000);
      socket.on('data', chunk => {
        received += chunk.toString();
        if (received.includes('\r\n\r\n')) {
          clearTimeout(timer);
          resolve(received);
        }
      });
      socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error(`CONNECT closed: ${received}`));
      });
    });
  } finally {
    socket.destroy();
  }
}

describe('outbound proxy hop marker', () => {
  it('terminates an A→B→A CONNECT loop at the listener with 508 and bounded sockets', async () => {
    for (const name of proxyEnv) delete process.env[name];
    const sockets = new Set<net.Socket>();
    let hops = 0;
    let innerResponse = '';
    let hopValue: string | undefined;
    let proxyPort = 0;
    const notices: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      notices.push(String(chunk));
      return true;
    });
    // B forwards the CONNECT to A unchanged, including its proxy-only headers.
    // An eight-hop cap makes the RED baseline safe (no descriptor exhaustion).
    const middle = http.createServer();
    middle.on('connect', (req, client, head) => {
      hops++;
      hopValue = req.headers[hopHeader];
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      client.on('error', () => client.destroy());
      if (hops > 8) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      const upstream = net.connect(proxyPort, '127.0.0.1');
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.on('error', () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.write(`CONNECT ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce((acc, part, i) => acc + (i % 2 ? `${part}\r\n` : `${part}: `), '')}\r\n`);
        if (head.length) upstream.write(head);
        upstream.on('data', chunk => { innerResponse += chunk.toString(); });
        upstream.pipe(client);
        client.pipe(upstream);
      });
      client.once('close', () => upstream.destroy());
    });
    const middlePort = await listen(middle);
    // B is a different outbound proxy listener that relays the marked CONNECT
    // back to A. The literal self-target check cannot detect this A→B→A cycle.
    process.env['HTTPS_PROXY'] = `http://localhost.:${middlePort}`;
    process.env['HTTP_PROXY'] = 'http://proxy.example.test:1234';
    const proxy = await startHttpProxy({ routes: [] });
    proxyPort = proxy.port;
    try {
      const response = await connect(proxy.port, 'service.example:443');
      expect(response).toContain('508 Loop Detected');
      expect(innerResponse).toContain('508 Loop Detected');
      expect(hops).toBe(1);
      expect(sockets.size).toBeLessThanOrEqual(2);
      expect(notices.join('')).toContain('check HTTPS_PROXY (request returned to this proxy)');
      expect(hopValue).toMatch(/^[0-9a-f-]{36}$/);

      // The same nonce can return on a plain HTTP proxy request too. Nothing
      // behind this listener should see it (or be contacted at all).
      let originRequests = 0;
      const origin = http.createServer((_req, res) => {
        originRequests++;
        res.end('ok');
      });
      const originPort = await listen(origin);
      try {
        const plain = await request(proxy.port, `http://127.0.0.1:${originPort}/`, {
          [hopHeader]: `other-hop, ${hopValue}`,
        });
        expect(plain.status).toBe(508);
        expect(originRequests).toBe(0);
      } finally {
        await new Promise<void>(resolve => origin.close(() => resolve()));
      }

      // Even a marker injected into the TLS request after an intercepted
      // CONNECT must be refused, rather than passed to the Anthropic origin.
      const tunnel = net.connect(proxy.port, '127.0.0.1');
      tunnel.on('error', () => {});
      await once(tunnel, 'connect');
      tunnel.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
      const [handshake] = await once(tunnel, 'data') as [Buffer];
      expect(handshake.toString()).toContain('200 Connection Established');
      const certs = ensureHttpProxyCertificates();
      const secure = tls.connect({ socket: tunnel, servername: 'api.anthropic.com', ca: certs.caCert });
      await once(secure, 'secureConnect');
      secure.write(`GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\n${hopHeader}: ${hopValue}\r\nConnection: close\r\n\r\n`);
      const chunks: Buffer[] = [];
      secure.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(secure, 'close');
      expect(Buffer.concat(chunks).toString()).toContain('508 Loop Detected');
      expect(hops).toBe(1);

      const upgradeTunnel = net.connect(proxy.port, '127.0.0.1');
      upgradeTunnel.on('error', () => {});
      await once(upgradeTunnel, 'connect');
      upgradeTunnel.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
      const [upgradeHandshake] = await once(upgradeTunnel, 'data') as [Buffer];
      expect(upgradeHandshake.toString()).toContain('200 Connection Established');
      const upgrade = tls.connect({ socket: upgradeTunnel, servername: 'api.anthropic.com', ca: certs.caCert });
      await once(upgrade, 'secureConnect');
      upgrade.write(`GET /ws HTTP/1.1\r\nHost: api.anthropic.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${hopHeader}: ${hopValue}\r\n\r\n`);
      const upgradeChunks: Buffer[] = [];
      upgrade.on('data', chunk => upgradeChunks.push(Buffer.from(chunk)));
      await once(upgrade, 'close');
      expect(Buffer.concat(upgradeChunks).toString()).toContain('508 Loop Detected');
      expect(hops).toBe(1);
    } finally {
      await proxy.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => middle.close(() => resolve()));
    }
  });

  it('terminates a raw Anthropic passthrough loop through another proxy', async () => {
    for (const name of proxyEnv) delete process.env[name];
    const sockets = new Set<net.Socket>();
    let proxyPort = 0;
    let hops = 0;
    let innerResponse = '';
    const notices: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      notices.push(String(chunk));
      return true;
    });
    const middle = http.createServer();
    middle.on('connect', (req, client) => {
      hops++;
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      client.on('error', () => client.destroy());
      if (hops > 8) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      const upstream = net.connect(proxyPort, '127.0.0.1');
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.once('connect', () => {
        upstream.write(`CONNECT ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce((acc, part, i) => acc + (i % 2 ? `${part}\r\n` : `${part}: `), '')}\r\n`);
        upstream.on('data', chunk => { innerResponse += chunk.toString(); });
        upstream.pipe(client);
        client.pipe(upstream);
      });
      client.once('close', () => upstream.destroy());
      upstream.on('error', () => upstream.destroy());
    });
    const middlePort = await listen(middle);
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${middlePort}`;
    const proxy = await startHttpProxy({ routes: [] });
    proxyPort = proxy.port;
    try {
      const certs = ensureHttpProxyCertificates();
      const tunnel = net.connect(proxy.port, '127.0.0.1');
      tunnel.on('error', () => {});
      await once(tunnel, 'connect');
      tunnel.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
      const [handshake] = await once(tunnel, 'data') as [Buffer];
      expect(handshake.toString()).toContain('200 Connection Established');
      const secure = tls.connect({ socket: tunnel, servername: 'api.anthropic.com', ca: certs.caCert });
      await once(secure, 'secureConnect');
      secure.write('GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: close\r\n\r\n');
      const chunks: Buffer[] = [];
      secure.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(secure, 'close');
      expect(Buffer.concat(chunks).toString()).toContain('508 Loop Detected');
      expect(Buffer.concat(chunks).toString()).toContain('Outbound proxy loop detected');
      expect(innerResponse).toContain('508 Loop Detected');
      expect(hops).toBe(1);
      expect(sockets.size).toBeLessThanOrEqual(2);
      expect(notices.join('')).toContain('HTTPS_PROXY');
    } finally {
      await proxy.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => middle.close(() => resolve()));
    }
  });

  it('accepts foreign CONNECT markers when it has a real outbound proxy', async () => {
    for (const name of proxyEnv) delete process.env[name];
    const target = net.createServer(socket => socket.end());
    const targetPort = await listen(target);
    const sockets = new Set<net.Socket>();
    let forwarded = 0;
    const upstreamProxy = http.createServer();
    upstreamProxy.on('connect', (req, client) => {
      forwarded++;
      const [host, port] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(port), host!);
      sockets.add(client);
      sockets.add(upstream);
      client.once('close', () => { sockets.delete(client); upstream.destroy(); });
      upstream.once('close', () => sockets.delete(upstream));
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
    });
    const upstreamPort = await listen(upstreamProxy);
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${upstreamPort}`;
    const proxy = await startHttpProxy({ routes: [] });
    const foreignHop = `${hopHeader}: 11111111-2222-3333-4444-555555555555\r\n`;
    try {
      const response = await connect(proxy.port, `127.0.0.1:${targetPort}`, foreignHop);
      expect(response).toContain('200 Connection Established');
      expect(response).not.toContain('508 Loop Detected');
      expect(forwarded).toBe(1);

      // This CONNECT is intercepted locally, but the listener's Anthropic
      // passthrough agent is also configured to use the outbound proxy.
      const intercepted = await connect(proxy.port, 'api.anthropic.com:443', foreignHop);
      expect(intercepted).toContain('200 Connection Established');
      expect(intercepted).not.toContain('508 Loop Detected');
      expect(forwarded).toBe(1);
    } finally {
      await proxy.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => upstreamProxy.close(() => resolve()));
      await new Promise<void>(resolve => target.close(() => resolve()));
    }
  });

  it('does not forward a foreign hop marker on plain HTTP or Anthropic passthrough', async () => {
    for (const name of proxyEnv) delete process.env[name];
    const certs = ensureHttpProxyCertificates();
    const seen: (string | string[] | undefined)[] = [];
    const upstream = https.createServer({ key: certs.serverKey, cert: certs.serverCert }, (req, res) => {
      seen.push(req.headers[hopHeader]);
      res.end('ok');
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startHttpProxy({
      routes: [], anthropicOrigin: `https://127.0.0.1:${upstreamPort}`,
      anthropicRejectUnauthorized: false,
    });
    try {
      // Plain HTTP requests must not echo an untrusted inbound marker.
      const plain = http.createServer((req, res) => {
        seen.push(req.headers[hopHeader]);
        res.end('ok');
      });
      const plainPort = await listen(plain);
      try {
        const result = await request(proxy.port, `http://127.0.0.1:${plainPort}/`, { [hopHeader]: 'foreign-nonce' });
        expect(result).toEqual({ status: 200, body: 'ok' });
      } finally {
        await new Promise<void>(resolve => plain.close(() => resolve()));
      }
      // An intercepted CONNECT establishes TLS; raw passthrough must strip the marker too.
      const tunnel = net.connect(proxy.port, '127.0.0.1');
      tunnel.on('error', () => {});
      await once(tunnel, 'connect');
      tunnel.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
      const [response] = await once(tunnel, 'data') as [Buffer];
      expect(response.toString()).toContain('200 Connection Established');
      const secure = tls.connect({ socket: tunnel, servername: 'api.anthropic.com', ca: certs.caCert });
      await once(secure, 'secureConnect');
      secure.write(`GET /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n${hopHeader}: foreign-nonce\r\nConnection: close\r\n\r\n`);
      await once(secure, 'data');
      secure.destroy();
      expect(seen).toEqual([undefined, undefined]);
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});

// These tests use the real listener and transport agents. A fixed port lets the
// listener inherit its own bridge URL, as a standalone server can in a shell.
async function reservePort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function proxiedHttpsGet(port: number): Promise<string> {
  const { outboundWsProxyAgent } = await import('../src/outbound-proxy.js');
  const agent = outboundWsProxyAgent(`wss://127.0.0.1:${port}`);
  try {
    return await new Promise<string>((resolve, reject) => {
      https.get(`https://127.0.0.1:${port}/`, { agent, rejectUnauthorized: false }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk.toString(); });
        res.on('end', () => resolve(`${res.statusCode}:${body}`));
      }).on('error', reject);
    });
  } finally {
    agent?.destroy();
  }
}

async function interceptedHttpsGet(port: number, ca: string, extraHeaders = ''): Promise<string> {
  const tunnel = net.connect(port, '127.0.0.1');
  try {
    await once(tunnel, 'connect');
    tunnel.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n${extraHeaders}\r\n`);
    const [handshake] = await once(tunnel, 'data') as [Buffer];
    expect(handshake.toString()).toContain('200 Connection Established');
    const secure = tls.connect({ socket: tunnel, servername: 'api.anthropic.com', ca });
    await once(secure, 'secureConnect');
    secure.write('GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: close\r\n\r\n');
    const chunks: Buffer[] = [];
    secure.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(secure, 'close');
    return Buffer.concat(chunks).toString();
  } finally {
    tunnel.destroy();
  }
}

async function captureOwnProxyHop(): Promise<string> {
  const { outboundHttpProxyAgent } = await import('../src/outbound-proxy.js');
  let marker: string | undefined;
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    marker = req.headers[hopHeader];
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  const port = await listen(proxy);
  const agent = outboundHttpProxyAgent('https://example.invalid/', {
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
  });
  try {
    await new Promise<void>(resolve => {
      https.get('https://example.invalid/', { agent }, res => {
        res.resume();
        res.on('end', resolve);
      }).on('error', () => resolve());
    });
    expect(marker).toMatch(/^[0-9a-f-]{36}$/);
    return marker!;
  } finally {
    agent?.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
}

describe('self-targeting outbound proxy URLs', () => {
  it('keeps literal self-targeting direct for fetch, WebSocket CONNECTs, and Anthropic passthrough', async () => {
    for (const name of proxyEnv) delete process.env[name];
    const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
    const { installOutboundDispatcher, resetOutboundDispatcherForTests } = await import('../src/outbound-proxy.js');
    const previousDispatcher = getGlobalDispatcher();
    const certs = ensureHttpProxyCertificates();
    const origin = https.createServer({ key: certs.serverKey, cert: certs.serverCert }, (_req, res) => res.end('ok'));
    const originPort = await listen(origin);
    const ownHop = await captureOwnProxyHop();
    const port = await reservePort();
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${port}`;
    const proxy = await startHttpProxy({ routes: [], port,
      anthropicOrigin: `https://127.0.0.1:${originPort}`, anthropicRejectUnauthorized: false });
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    resetOutboundDispatcherForTests();
    try {
      expect(await installOutboundDispatcher()).toBe(true);
      const response = await fetch(`https://127.0.0.1:${originPort}/`);
      expect([response.status, await response.text()]).toEqual([200, 'ok']);
      expect(await proxiedHttpsGet(originPort)).toBe('200:ok');
      // Even a returning hop need not be refused when the listener will dial
      // direct: the literal self-target guard already breaks the cycle.
      expect(await connect(proxy.port, `127.0.0.1:${originPort}`, `${hopHeader}: ${ownHop}\r\n`))
        .toContain('200 Connection Established');
      expect(await interceptedHttpsGet(proxy.port, certs.caCert, `${hopHeader}: ${ownHop}\r\n`))
        .toContain('200 OK');
    } finally {
      await getGlobalDispatcher().destroy().catch(() => {});
      setGlobalDispatcher(previousDispatcher);
      resetOutboundDispatcherForTests();
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });

  it('refuses a direct self-loop through a wildcard-address alias, including fetch entry', async () => {
    for (const name of proxyEnv) delete process.env[name];
    const { createHook } = await import('node:async_hooks');
    const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
    const { installOutboundDispatcher, resetOutboundDispatcherForTests } = await import('../src/outbound-proxy.js');
    const previousDispatcher = getGlobalDispatcher();
    const certs = ensureHttpProxyCertificates();
    const origin = https.createServer({ key: certs.serverKey, cert: certs.serverCert }, (_req, res) => res.end('ok'));
    const originPort = await listen(origin);
    const port = await reservePort();
    process.env['HTTPS_PROXY'] = `http://0.0.0.0:${port}`;
    const notices: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      notices.push(String(chunk));
      return true;
    });
    const proxy = await startHttpProxy({ routes: [], port, host: '127.0.0.1' });
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    resetOutboundDispatcherForTests();
    let socketsCreated = 0;
    const hook = createHook({ init: (_id, type) => { if (type === 'TCPWRAP') socketsCreated++; } });
    try {
      hook.enable();
      expect(await installOutboundDispatcher()).toBe(true);
      await expect(fetch(`https://127.0.0.1:${originPort}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      expect(socketsCreated).toBeLessThan(16);
      expect(notices.join('')).toContain('outbound proxy loop detected; check HTTPS_PROXY');
      const response = await connect(proxy.port, `127.0.0.1:${originPort}`);
      expect(response).toContain('508 Loop Detected');
      expect(socketsCreated).toBeLessThan(16);
    } finally {
      hook.disable();
      await getGlobalDispatcher().destroy().catch(() => {});
      setGlobalDispatcher(previousDispatcher);
      resetOutboundDispatcherForTests();
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });
});
