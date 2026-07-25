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
        return attempts === 3 ? 'ready' : 'unreachable';
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
    let attempts = 0;

    const readiness = waitForTcpListener('127.0.0.1', 17_645, 12, {
      now: () => elapsedMs,
      probe: async () => {
        attempts += 1;
        return 'unreachable';
      },
      delay: async (ms: number) => {
        elapsedMs += ms;
      },
    });

    await expect(readiness).resolves.toBe(false);
    expect(elapsedMs).toBe(12);
    expect(attempts).toBeGreaterThan(1);
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
          return 'ready';
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
    const probedPorts: number[] = [];

    const selected = await waitForTcpListenerCandidate(
      '127.0.0.1',
      [{ port: 17_645 }, { port: 17_646 }],
      12,
      {
        now: () => elapsedMs,
        probe: async (_host: string, port: number) => {
          probedPorts.push(port);
          return 'unreachable';
        },
        delay: async (ms: number) => {
          elapsedMs += ms;
        },
      },
    );

    expect(selected).toBeNull();
    expect(elapsedMs).toBe(12);
    expect(probedPorts.length).toBeGreaterThan(2);
    expect(new Set(probedPorts)).toEqual(new Set([17_645, 17_646]));
  });

  it('retries only failures accepted by the retry policy', async () => {
    let elapsedMs = 0;
    const attempts = new Map<number, number>();
    const candidates = [{ port: 17_645 }, { port: 17_646 }];

    const selected = await waitForTcpListenerCandidate(
      '127.0.0.1',
      candidates,
      20,
      {
        now: () => elapsedMs,
        probe: async (_host: string, port: number) => {
          const attempt = (attempts.get(port) ?? 0) + 1;
          attempts.set(port, attempt);
          if (port === 17_645) return 'unreachable';
          return attempt === 1 ? 'timeout' : 'ready';
        },
        retryFailure: result => result === 'timeout',
        delay: async (ms: number) => {
          elapsedMs += ms;
        },
      },
    );

    expect(selected).toBe(candidates[1]);
    expect(attempts.get(17_645)).toBe(1);
    expect(attempts.get(17_646)).toBe(2);
  });
});
