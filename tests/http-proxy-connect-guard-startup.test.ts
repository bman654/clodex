// The self-proxy guard on the non-intercepted CONNECT path has to be armed from
// the moment the listener starts accepting, not from the moment startHttpProxy
// resolves. `listenTcpServer` resolves `listen()` and only then probes the port,
// so there is a real window in which the socket accepts connections while
// startup is still in flight. Naturally that window is a fraction of a
// millisecond, so this file holds it open deliberately: the mocked
// `listenTcpServer` below runs the real one and then blocks until the test
// releases it, which is exactly the state the race produces.
import { describe, it, expect, vi } from 'vitest';
import * as net from 'node:net';
import { once } from 'node:events';
import { HttpsProxyAgent } from 'https-proxy-agent';

const gate = vi.hoisted(() => {
  let accepting: (() => void) | undefined;
  let release: (() => void) | undefined;
  const acceptingPromise = new Promise<void>(resolve => { accepting = resolve; });
  return {
    whenAccepting: () => acceptingPromise,
    markAccepting: () => accepting?.(),
    held: () => new Promise<void>(resolve => { release = resolve; }),
    release: () => release?.(),
  };
});

vi.mock('../src/listener-ready.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/listener-ready.js')>();
  return {
    ...actual,
    listenTcpServer: async (server: net.Server, port: number, host: string) => {
      const address = await actual.listenTcpServer(server, port, host);
      gate.markAccepting();
      await gate.held();
      return address;
    },
  };
});

const { startHttpProxy } = await import('../src/http-proxy/server.js');

async function reservePort(): Promise<number> {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('reservation did not bind');
  const { port } = address;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  return port;
}

describe('non-intercepted CONNECT self-proxy guard', () => {
  it('is armed for a CONNECT that arrives before startup finishes', async () => {
    const target = net.createServer(socket => socket.pipe(socket));
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const targetPort = (target.address() as net.AddressInfo).port;

    const port = await reservePort();
    const previous = process.env['HTTPS_PROXY'];
    // The bridge URL a user exports from `clodex server --proxy` output, then
    // inherits again when the server restarts on its fixed default port.
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${port}`;
    const connect = vi.spyOn(HttpsProxyAgent.prototype, 'connect');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const starting = startHttpProxy({ routes: [], port });
    let client: net.Socket | undefined;
    try {
      // The socket is accepting here; `startHttpProxy` has not resolved.
      await gate.whenAccepting();

      client = net.connect(port, '127.0.0.1');
      client.on('error', () => {});
      await once(client, 'connect');
      client.write(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${targetPort}\r\n\r\nHELLO`,
      );

      let received = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no echo; got ${JSON.stringify(received)}`)), 4000);
        client!.on('data', chunk => {
          received += chunk.toString();
          if (received.includes('HELLO') && received.includes('200 Connection Established')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      expect(received).toContain('200 Connection Established');
      // The guard sent it straight to the target instead of tunnelling back
      // into this same listener.
      expect(connect).not.toHaveBeenCalled();
    } finally {
      gate.release();
      client?.destroy();
      if (previous === undefined) delete process.env['HTTPS_PROXY'];
      else process.env['HTTPS_PROXY'] = previous;
      connect.mockRestore();
      stderr.mockRestore();
      const proxy = await starting;
      await proxy.close();
      await new Promise<void>(resolve => target.close(() => resolve()));
    }
  });
});
