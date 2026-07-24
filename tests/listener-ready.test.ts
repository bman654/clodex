import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  listenTcpServer,
  tcpListenerUrlHost,
  waitForTcpListener,
} from '../src/listener-ready.js';

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

  it('retries transient connection failures until a listener is reachable', async () => {
    const reservation = createServer();
    const address = await listenTcpServer(reservation, 0, '127.0.0.1');
    await new Promise<void>(resolve => reservation.close(() => resolve()));

    const delayedServer = createServer(socket => socket.end());
    const readiness = waitForTcpListener('127.0.0.1', address.port, 500);
    await delay(25);
    await new Promise<void>((resolve, reject) => {
      delayedServer.once('error', reject);
      delayedServer.listen(address.port, '127.0.0.1', resolve);
    });

    try {
      await expect(readiness).resolves.toBe(true);
    } finally {
      await new Promise<void>(resolve => delayedServer.close(() => resolve()));
    }
  });
});
