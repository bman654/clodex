// tests/responses-websocket-exit.test.ts
//
// A Responses WebSocket that clodex closes waits for the server to answer the closing handshake,
// behind ws's ref'd 30-second close timer. That wait must not hold up the process exiting: under
// `clodex claude --endpoint` it delayed every exit by the server's round trip, and a server that
// never answered would hold it until the exit fallback fired. Measured against the real ws package
// and chatgpt.com in the endpoint launch census; pinned here with a fake socket that reports the
// CLOSING state the real one enters on close().
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS_CLOSING = 2;
const WS_CLOSED = 3;

const { fakeSockets, exitCancellers, closeLeavesState } = vi.hoisted(() => ({
  fakeSockets: [] as FakeWebSocket[],
  exitCancellers: [] as Array<{ cancel: () => void; release: ReturnType<typeof vi.fn> }>,
  closeLeavesState: { value: 2 },
}));

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = closeLeavesState.value;
  });
  terminate = vi.fn();
  constructor(public url: string, public options: unknown) {
    super();
    fakeSockets.push(this);
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
vi.mock('../src/process-exit.js', () => ({
  cancelOnExit: vi.fn((cancel: () => void) => {
    const release = vi.fn();
    exitCancellers.push({ cancel, release });
    return release;
  }),
}));

import {
  createResponsesWebSocketFetch,
  resetResponsesWebSocketConnectionsForTests,
} from '../src/oauth/responses-websocket.js';

const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';

async function readAll(res: Response): Promise<string> {
  return new Response(res.body).text();
}

/** One isolated request run to `response.completed`, which closes its socket. */
async function completeOneRequest(): Promise<FakeWebSocket> {
  const wsFetch = createResponsesWebSocketFetch(WS_URL);
  const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
  const socket = fakeSockets[fakeSockets.length - 1]!;
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed' })));
  await readAll(res);
  return socket;
}

describe('closing a Responses WebSocket', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    exitCancellers.length = 0;
    closeLeavesState.value = WS_CLOSING;
  });

  it('terminates a socket still in its closing handshake when the process is asked to exit', async () => {
    const socket = await completeOneRequest();
    expect(socket.close).toHaveBeenCalled();
    expect(exitCancellers.length).toBeGreaterThan(0);
    expect(socket.terminate).not.toHaveBeenCalled();

    for (const { cancel } of exitCancellers) cancel();
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('withdraws the exit hook once the handshake completes', async () => {
    const socket = await completeOneRequest();
    socket.readyState = WS_CLOSED;
    socket.emit('close', 1000, Buffer.alloc(0));
    for (const { release } of exitCancellers) expect(release).toHaveBeenCalled();
  });

  it('registers nothing for a socket that closed without a handshake to wait for', async () => {
    closeLeavesState.value = WS_CLOSED;
    const socket = await completeOneRequest();
    expect(socket.close).toHaveBeenCalled();
    expect(exitCancellers).toHaveLength(0);
  });

  it('also covers sockets dropped through the failure path', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const controller = new AbortController();
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: '{}',
      signal: controller.signal,
    });
    const socket = fakeSockets[fakeSockets.length - 1]!;
    socket.readyState = 1;
    socket.emit('open');
    controller.abort();
    await readAll(res).catch(() => '');
    expect(socket.close).toHaveBeenCalled();
    for (const { cancel } of exitCancellers) cancel();
    expect(socket.terminate).toHaveBeenCalled();
  });
});
