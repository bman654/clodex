import { connect, type AddressInfo, type Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const LISTENER_READY_TIMEOUT_MS = 1_000;
const LISTENER_READY_RETRY_MS = 5;

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

function probeTcpListener(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
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
  const deadline = Date.now() + LISTENER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (await probeTcpListener(probeHost, address.port, Math.min(remaining, 50))) {
      return address;
    }
    await delay(Math.min(LISTENER_READY_RETRY_MS, Math.max(1, deadline - Date.now())));
  }

  await closeAfterReadinessFailure(server);
  throw new Error(
    `TCP listener did not become reachable within ${LISTENER_READY_TIMEOUT_MS}ms: `
      + `${probeHost}:${address.port}`,
  );
}
