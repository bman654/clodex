import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { listenTcpServer, tcpListenerUrlHost } from '../src/listener-ready.js';

describe('tcp listener readiness', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['0.0.0.0', '127.0.0.1'],
    ['::1', '[::1]'],
    ['::', '[::1]'],
  ])('formats %s as a reachable URL host', (address, expected) => {
    expect(tcpListenerUrlHost(address)).toBe(expected);
  });

  it('removes its bind error listener after a synchronous listen failure', async () => {
    const server = createServer();

    await expect(listenTcpServer(server, 65_536, '127.0.0.1')).rejects.toThrow();

    expect(server.listenerCount('error')).toBe(0);
  });

  it('removes its bind error listener after an asynchronous listen failure', async () => {
    const boundServer = createServer();
    const address = await listenTcpServer(boundServer, 0, '127.0.0.1');
    const conflictingServer = createServer();

    try {
      await expect(
        listenTcpServer(conflictingServer, address.port, '127.0.0.1'),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(conflictingServer.listenerCount('error')).toBe(0);
    } finally {
      await new Promise<void>(resolve => boundServer.close(() => resolve()));
    }
  });
});
