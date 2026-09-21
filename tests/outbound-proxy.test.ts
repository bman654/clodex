// tests/outbound-proxy.test.ts
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import {
  hasOutboundProxyEnv,
  installOutboundDispatcher,
  noProxyBypasses,
  outboundHttpProxyAgent,
  outboundProxyUrlForTarget,
  outboundWsProxyAgent,
  proxyUrlTargetsListener,
  resetOutboundDispatcherForTests,
} from '../src/outbound-proxy.js';

const PROXY = 'http://127.0.0.1:8888';

const dispatcherEnvNames = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_TLS_REJECT_UNAUTHORIZED',
] as const;
let originalDispatcher: Dispatcher;
let originalDispatcherEnv: Record<typeof dispatcherEnvNames[number], string | undefined>;
const testDispatchers = new Set<Dispatcher>();
const testServers = new Set<net.Server>();
const testSockets = new Set<net.Socket>();
const h2Sessions = new Set<http2.ServerHttp2Session>();

async function listen(server: net.Server): Promise<number> {
  testServers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  originalDispatcherEnv = Object.fromEntries(
    dispatcherEnvNames.map(name => [name, process.env[name]]),
  ) as Record<typeof dispatcherEnvNames[number], string | undefined>;
  for (const name of dispatcherEnvNames) delete process.env[name];
  resetOutboundDispatcherForTests();
});

afterEach(async () => {
  resetOutboundDispatcherForTests();
  setGlobalDispatcher(originalDispatcher);
  for (const dispatcher of testDispatchers) await dispatcher.destroy().catch(() => {});
  testDispatchers.clear();
  for (const socket of testSockets) socket.destroy();
  testSockets.clear();
  for (const session of h2Sessions) session.destroy();
  h2Sessions.clear();
  for (const server of testServers) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  testServers.clear();
  for (const name of dispatcherEnvNames) {
    const value = originalDispatcherEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function startVersionServer(versions: string[]): http2.Http2SecureServer {
  const certificates = ensureHttpProxyCertificates();
  const server = http2.createSecureServer({
    key: certificates.serverKey,
    cert: certificates.serverCert,
    allowHTTP1: true,
  });
  server.on('session', session => {
    h2Sessions.add(session);
    session.once('close', () => h2Sessions.delete(session));
  });
  server.on('request', (req, res) => {
    versions.push(req.httpVersion);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  return server;
}

describe('hasOutboundProxyEnv', () => {
  it('is false with no proxy vars or blank values', () => {
    expect(hasOutboundProxyEnv({})).toBe(false);
    expect(hasOutboundProxyEnv({ HTTPS_PROXY: '  ' })).toBe(false);
    expect(hasOutboundProxyEnv({ NO_PROXY: '*' })).toBe(false);
  });

  it('is true for any of the four proxy var spellings', () => {
    expect(hasOutboundProxyEnv({ HTTPS_PROXY: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ https_proxy: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ HTTP_PROXY: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ http_proxy: PROXY })).toBe(true);
  });
});

describe('outboundProxyUrlForTarget', () => {
  it('uses HTTPS_PROXY for https and wss targets', () => {
    const env = { HTTPS_PROXY: PROXY };
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1/responses', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('wss://chatgpt.com/backend-api/responses', env)).toBe(PROXY);
    // http targets do not fall back to HTTPS_PROXY
    expect(outboundProxyUrlForTarget('http://models.dev/api.json', env)).toBeUndefined();
  });

  it('uses HTTP_PROXY for http and ws targets only', () => {
    const env = { HTTP_PROXY: PROXY };
    expect(outboundProxyUrlForTarget('http://models.dev/api.json', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('ws://localhost:9999/x', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1', env)).toBeUndefined();
  });

  it('prefers the uppercase spelling and trims values', () => {
    expect(outboundProxyUrlForTarget('https://x.test/', {
      HTTPS_PROXY: ` ${PROXY} `,
      https_proxy: 'http://other:1',
    })).toBe(PROXY);
  });

  it('returns undefined for unparseable target URLs', () => {
    expect(outboundProxyUrlForTarget('not a url', { HTTPS_PROXY: PROXY })).toBeUndefined();
  });

  it('honors NO_PROXY', () => {
    const env = { HTTPS_PROXY: PROXY, NO_PROXY: 'api.openai.com' };
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1', env)).toBeUndefined();
    expect(outboundProxyUrlForTarget('https://chatgpt.com/x', env)).toBe(PROXY);
  });
});

describe('outboundHttpProxyAgent', () => {
  it('builds an agent only when the target is not bypassed', async () => {
    const direct = await outboundHttpProxyAgent('https://api.example.test', {
      HTTPS_PROXY: PROXY,
      NO_PROXY: 'api.example.test',
    });
    expect(direct).toBeUndefined();

    const proxied = await outboundHttpProxyAgent('https://api.example.test', {
      HTTPS_PROXY: PROXY,
    });
    expect(proxied).toBeDefined();
    expect(proxied?.keepAlive).toBe(true);
    proxied?.destroy();
  });

  it.each([
    'localhost:3128',
    'http://user:private-proxy-token@[invalid',
  ])('warns and falls back to direct for malformed proxy URL %s', async proxyUrl => {
    // The warning goes through the parent-notice channel so it survives the
    // stderr mute `launchClaude` installs; the non-intercepted CONNECT handler
    // can reach this path while the child owns the terminal.
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    try {
      const agent = await outboundHttpProxyAgent('https://api.example.test', {
        HTTPS_PROXY: proxyUrl,
      });

      expect(agent).toBeUndefined();
      expect(written).toHaveLength(1);
      expect(written.join(' ')).toMatch(
        /using a direct connection \(Invalid (?:proxy )?URL\)/,
      );
      expect(written.join(' ')).not.toContain('private-proxy-token');
    } finally {
      stderr.mockRestore();
    }
  });

  it('builds the WebSocket transport with the same keep-alive proxy agent', () => {
    const agent = outboundWsProxyAgent('wss://api.example.test/responses', {
      HTTPS_PROXY: PROXY,
    });

    expect(agent).toBeDefined();
    expect(agent?.keepAlive).toBe(true);
    agent?.destroy();
  });
});

describe('proxyUrlTargetsListener', () => {
  it('matches loopback aliases and wildcard listeners only on the bound port', () => {
    expect(proxyUrlTargetsListener('http://127.0.0.1:17645', '127.0.0.1', 17645)).toBe(true);
    expect(proxyUrlTargetsListener('http://localhost:17645', '127.0.0.1', 17645)).toBe(true);
    expect(proxyUrlTargetsListener('http://127.0.0.2:17645', '0.0.0.0', 17645)).toBe(true);
    expect(proxyUrlTargetsListener(
      'http://192.0.2.10:17645',
      '0.0.0.0',
      17645,
      new Set(['192.0.2.10']),
    )).toBe(true);
    expect(proxyUrlTargetsListener(
      'http://192.0.2.11:17645',
      '0.0.0.0',
      17645,
      new Set(['192.0.2.10']),
    )).toBe(false);
    expect(proxyUrlTargetsListener('http://127.0.0.1:17646', '127.0.0.1', 17645)).toBe(false);
    expect(proxyUrlTargetsListener('http://proxy.example.test:17645', '127.0.0.1', 17645)).toBe(false);
    expect(proxyUrlTargetsListener('not a URL', '127.0.0.1', 17645)).toBe(false);
  });
});

describe('noProxyBypasses', () => {
  it('matches exact hosts, subdomains, and dot/star suffixes', () => {
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: 'api.openai.com' })).toBe(true);
    // bare domain also matches subdomains (curl semantics)
    expect(noProxyBypasses('sub.openai.com', { NO_PROXY: 'openai.com' })).toBe(true);
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: '.openai.com' })).toBe(true);
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: '*.openai.com' })).toBe(true);
    expect(noProxyBypasses('openai.com.evil.test', { NO_PROXY: 'openai.com' })).toBe(false);
    expect(noProxyBypasses('notopenai.com', { NO_PROXY: 'openai.com' })).toBe(false);
  });

  it('supports the * wildcard, lists, ports, and lowercase spelling', () => {
    expect(noProxyBypasses('anything.test', { NO_PROXY: '*' })).toBe(true);
    expect(noProxyBypasses('b.test', { NO_PROXY: 'a.test, b.test' })).toBe(true);
    expect(noProxyBypasses('c.test', { NO_PROXY: 'c.test:443' })).toBe(true);
    expect(noProxyBypasses('d.test', { no_proxy: 'd.test' })).toBe(true);
    expect(noProxyBypasses('e.test', {})).toBe(false);
  });
});

describe('installOutboundDispatcher', () => {
  it('pins global fetch to HTTP/1.1 even when the previous dispatcher enables HTTP/2', async () => {
    const versions: string[] = [];
    const upstream = startVersionServer(versions);
    const upstreamPort = await listen(upstream);
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

    // Control leg: reproduce Node 26's default, where the bundled undici 8
    // negotiates HTTP/2. The built-in fetch reads this package agent directly
    // on undici 7; if the pinned undici is bumped to 8.x, Node <=24's fetch
    // wraps it in a Dispatcher1Wrapper that forces HTTP/1.1, so this control
    // needs Node 26 to observe '2.0'. `allowH2: false` in the installer is
    // inert on undici 7 (already the default) and is exactly what keeps the
    // fix in place on 8.x -- this test is the tripwire for that bump.
    const h2Dispatcher = new Agent({ allowH2: true, connect: { rejectUnauthorized: false } });
    testDispatchers.add(h2Dispatcher);
    setGlobalDispatcher(h2Dispatcher);
    expect(await (await fetch(`https://127.0.0.1:${upstreamPort}`)).text()).toBe('ok');

    resetOutboundDispatcherForTests();
    await installOutboundDispatcher();
    testDispatchers.add(getGlobalDispatcher());
    expect(await (await fetch(`https://127.0.0.1:${upstreamPort}`)).text()).toBe('ok');

    expect(versions).toEqual(['2.0', '1.1']);
  });

  it('still sends HTTPS fetches through the configured CONNECT proxy', async () => {
    const versions: string[] = [];
    const upstream = startVersionServer(versions);
    const upstreamPort = await listen(upstream);
    const connectTargets: string[] = [];
    const tunnelSockets = new Set<net.Socket>();
    const connectProxy = http.createServer();
    connectProxy.on('connect', (req, clientSocket, head) => {
      connectTargets.push(req.url ?? '');
      const upstreamSocket = net.connect(upstreamPort, '127.0.0.1');
      testSockets.add(clientSocket);
      testSockets.add(upstreamSocket);
      tunnelSockets.add(upstreamSocket);
      upstreamSocket.once('close', () => {
        tunnelSockets.delete(upstreamSocket);
        testSockets.delete(upstreamSocket);
      });
      clientSocket.once('close', () => testSockets.delete(clientSocket));
      upstreamSocket.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstreamSocket.write(head);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      });
      upstreamSocket.once('error', () => clientSocket.destroy());
      clientSocket.once('error', () => upstreamSocket.destroy());
      clientSocket.once('close', () => upstreamSocket.destroy());
    });
    await listen(connectProxy);
    const proxyPort = (connectProxy.address() as AddressInfo).port;
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

    await installOutboundDispatcher();
    testDispatchers.add(getGlobalDispatcher());
    expect(await (await fetch(`https://127.0.0.1:${upstreamPort}`)).text()).toBe('ok');

    expect(connectTargets).toEqual([`127.0.0.1:${upstreamPort}`]);
    expect(versions).toEqual(['1.1']);
    for (const socket of tunnelSockets) socket.destroy();
  });
});
