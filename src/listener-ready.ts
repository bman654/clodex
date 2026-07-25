import { connect, type AddressInfo, type Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const LISTENER_READY_TIMEOUT_MS = 1_000;
const LISTENER_READY_RETRY_MS = 5;
const TCP_PROBE_TIMEOUT_MS = 50;

function connectHost(address: string): string {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '::1';
  return address;
}

/** Return a reachable host formatted for use in an HTTP URL. */
export function tcpListenerUrlHost(address: string): string {
  const host = connectHost(address);
  return host.includes(':') ? `[${host}]` : host;
}

type TcpListenerProbeResult = 'ready' | 'timeout' | 'unreachable';

function probeTcpListener(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<TcpListenerProbeResult> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (result: TcpListenerProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish('ready'));
    socket.once('error', error => {
      finish(
        (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
          ? 'timeout'
          : 'unreachable',
      );
    });
    socket.setTimeout(timeoutMs, () => finish('timeout'));
  });
}

interface TcpListenerWaitOptions {
  now?: () => number;
  probe?: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<TcpListenerProbeResult>;
  retryFailure?: (result: Exclude<TcpListenerProbeResult, 'ready'>) => boolean;
  delay?: (ms: number) => Promise<void>;
}

/**
 * Probe every candidate once per round and return the first reachable
 * candidate in caller-provided priority order. All retry rounds share one
 * overall deadline.
 */
export async function waitForTcpListenerCandidate<T extends { port: number }>(
  host: string,
  candidates: readonly T[],
  timeoutMs = LISTENER_READY_TIMEOUT_MS,
  options: TcpListenerWaitOptions = {},
): Promise<T | null> {
  if (candidates.length === 0) return null;

  const now = options.now ?? Date.now;
  const probe = options.probe ?? probeTcpListener;
  const retryFailure = options.retryFailure ?? (() => true);
  const wait = options.delay ?? (ms => delay(ms));
  const deadline = now() + timeoutMs;
  let pendingCandidates = [...candidates];

  do {
    const remaining = Math.max(1, deadline - now());
    const results = await Promise.all(
      pendingCandidates.map(candidate => probe(
        host,
        candidate.port,
        Math.min(remaining, TCP_PROBE_TIMEOUT_MS),
      )),
    );
    const readyIndex = results.findIndex(result => result === 'ready');
    if (readyIndex >= 0) return pendingCandidates[readyIndex] ?? null;

    pendingCandidates = pendingCandidates.filter((_candidate, index) => {
      const result = results[index];
      return result !== undefined && result !== 'ready' && retryFailure(result);
    });
    if (pendingCandidates.length === 0) return null;

    const retryDelay = Math.min(LISTENER_READY_RETRY_MS, deadline - now());
    if (retryDelay <= 0) return null;
    await wait(retryDelay);
  } while (now() < deadline);

  return null;
}

/** Retry a TCP probe until the listener answers or the deadline expires. */
export async function waitForTcpListener(
  host: string,
  port: number,
  timeoutMs = LISTENER_READY_TIMEOUT_MS,
  options: TcpListenerWaitOptions = {},
): Promise<boolean> {
  return (await waitForTcpListenerCandidate(host, [{ port }], timeoutMs, options)) !== null;
}

async function closeAfterReadinessFailure(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Bind a TCP server and wait until the bound socket accepts connections. */
export async function listenTcpServer(
  server: Server,
  port: number,
  host: string,
): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => server.off('error', onError);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    server.once('error', onError);
    try {
      server.listen(port, host, () => {
        cleanup();
        resolve();
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeAfterReadinessFailure(server);
    throw new Error('TCP server did not bind to a network address');
  }

  const probeHost = connectHost(address.address);
  if (await waitForTcpListener(probeHost, address.port)) return address;

  await closeAfterReadinessFailure(server);
  throw new Error(
    `TCP listener did not become reachable within ${LISTENER_READY_TIMEOUT_MS}ms: `
      + `${probeHost}:${address.port}`,
  );
}
