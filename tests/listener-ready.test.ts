import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  listenTcpServer,
  tcpListenerUrlHost,
  waitForTcpListener,
  waitForTcpListenerCandidate,
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
    let elapsedMs = 0;
    let attempts = 0;

    const readiness = waitForTcpListener('127.0.0.1', 17_645, 20, {
      now: () => elapsedMs,
      probe: async () => {
        attempts += 1;
        return attempts === 3;
      },
      delay: async (ms: number) => {
        elapsedMs += ms;
      },
    });

    await expect(readiness).resolves.toBe(true);
    expect(attempts).toBe(3);
    expect(elapsedMs).toBe(10);
  });

  it('returns false at the shared deadline when a listener stays unreachable', async () => {
    let elapsedMs = 0;
    const probeTimeouts: number[] = [];

    const readiness = waitForTcpListener('127.0.0.1', 17_645, 12, {
      now: () => elapsedMs,
      probe: async (_host: string, _port: number, timeoutMs: number) => {
        probeTimeouts.push(timeoutMs);
        return false;
      },
      delay: async (ms: number) => {
        elapsedMs += ms;
      },
    });

    await expect(readiness).resolves.toBe(false);
    expect(elapsedMs).toBe(12);
    expect(probeTimeouts).toEqual([12, 7, 2]);
  });

  it('probes every candidate once and chooses the first reachable candidate', async () => {
    const candidates = [{ port: 17_645 }, { port: 17_646 }];
    const probedPorts: number[] = [];

    const selected = await waitForTcpListenerCandidate(
      '127.0.0.1',
      candidates,
      20,
      {
        now: () => 0,
        probe: async (_host: string, port: number) => {
          probedPorts.push(port);
          return true;
        },
        delay: async () => {
          throw new Error('reachable fast pass must not retry');
        },
      },
    );

    expect(selected).toBe(candidates[0]);
    expect(probedPorts).toEqual([17_645, 17_646]);
  });

  it('shares one exact deadline across all unreachable candidates', async () => {
    let elapsedMs = 0;
    const probes: Array<{ port: number; timeoutMs: number }> = [];

    const selected = await waitForTcpListenerCandidate(
      '127.0.0.1',
      [{ port: 17_645 }, { port: 17_646 }],
      12,
      {
        now: () => elapsedMs,
        probe: async (_host: string, port: number, timeoutMs: number) => {
          probes.push({ port, timeoutMs });
          return false;
        },
        delay: async (ms: number) => {
          elapsedMs += ms;
        },
      },
    );

    expect(selected).toBeNull();
    expect(elapsedMs).toBe(12);
    expect(probes).toEqual([
      { port: 17_645, timeoutMs: 12 },
      { port: 17_646, timeoutMs: 12 },
      { port: 17_645, timeoutMs: 7 },
      { port: 17_646, timeoutMs: 7 },
      { port: 17_645, timeoutMs: 2 },
      { port: 17_646, timeoutMs: 2 },
    ]);
  });
});
