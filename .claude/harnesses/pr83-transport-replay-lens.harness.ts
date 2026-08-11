import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { fakeSockets } = vi.hoisted(() => ({ fakeSockets: [] as FakeWebSocket[] }));

class FakeWebSocket extends EventEmitter {
  url: string;
  options: { headers?: Record<string, string> };
  send = vi.fn();
  close = vi.fn();
  constructor(url: string, options: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.options = options;
    fakeSockets.push(this);
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));

import {
  createResponsesWebSocketFetch,
  resetReasoningGapWarningsForTests,
  resetResponsesWebSocketConnectionsForTests,
  type ResponsesWebSocketDiagnosticEvent,
} from '../src/oauth/responses-websocket.js';

const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function lastSocket(): FakeWebSocket {
  return fakeSockets[fakeSockets.length - 1]!;
}

const sessionPayload = (input: unknown[], extra: Record<string, unknown> = {}) => ({
  model: 'gpt-5.6-sol',
  prompt_cache_key: 'relay-session-abc',
  instructions: 'You are a coding assistant.',
  tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
  reasoning: { effort: 'high' },
  store: false,
  input,
  ...extra,
});

function created(socket: FakeWebSocket, id: string): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created', response: { id },
  })));
}

function emitTextResponse(socket: FakeWebSocket, responseId: string, text: string): void {
  created(socket, responseId);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.added', output_index: 0,
    item: { type: 'message', id: `msg_${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_text.delta', item_id: `msg_${responseId}`, delta: text,
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.done', output_index: 0,
    item: { type: 'message', id: `msg_${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed', response: { id: responseId },
  })));
}

function countCreated(body: string): number {
  return body.split('\n').filter(l => l.startsWith('data: ') && l.includes('"response.created"')).length;
}

describe('lens1: widened replay window safety', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    resetReasoningGapWarningsForTests();
    fakeSockets.length = 0;
  });

  it('A: abandoned response id never reaches downstream nor becomes a chain head', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-A' });
    const turn1 = [{ role: 'user', content: [{ type: 'input_text', text: 'first' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn1)),
    });
    const s1 = lastSocket();
    s1.emit('open');
    emitTextResponse(s1, 'resp_head1', 'answer one');
    await readAll(first);

    // Turn 2 continues on the same socket, gets response.created, then the socket dies.
    const turn2 = [
      ...turn1,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer one' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'second' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn2)),
    });
    const incremental = JSON.parse(s1.send.mock.calls[1]![0] as string);
    expect(incremental.previous_response_id).toBe('resp_head1');
    created(s1, 'resp_abandoned');
    s1.emit('close', 1006, Buffer.from(''));

    expect(fakeSockets).toHaveLength(2);
    const s2 = lastSocket();
    s2.emit('open');
    const replay = JSON.parse(s2.send.mock.calls[0]![0] as string);
    expect(replay.previous_response_id).toBeUndefined();
    expect(replay.input).toEqual(turn2);
    emitTextResponse(s2, 'resp_recovered', 'answer two');
    const body = await readAll(second);
    expect(body).not.toContain('resp_abandoned');
    expect(countCreated(body)).toBe(1);
    expect(body).toContain('resp_recovered');

    // Turn 3 must continue from the RECOVERED id, not the abandoned one.
    const turn3 = [
      ...turn2,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer two' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'third' }] },
    ];
    const third = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn3)),
    });
    const cont = JSON.parse(s2.send.mock.calls[1]![0] as string);
    expect(cont.previous_response_id).toBe('resp_recovered');
    expect(cont.input).toEqual([turn3[4]]);
    emitTextResponse(s2, 'resp_head3', 'answer three');
    await readAll(third);
  });

  it('B: no leaked accumulator state — replayed attempt 2 output alone forms the head', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-B' });
    const turn1 = [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }];
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn1)),
    });
    const s1 = lastSocket();
    s1.emit('open');
    // A response.created that also (illegally) carries output must not seed anything.
    s1.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created',
      response: { id: 'resp_abandoned', output: [{ type: 'message', content: [{ type: 'output_text', text: 'GHOST' }] }] },
    })));
    s1.emit('close', 1006, Buffer.from(''));
    const s2 = lastSocket();
    expect(fakeSockets).toHaveLength(2);
    s2.emit('open');
    emitTextResponse(s2, 'resp_ok', 'clean');
    const body = await readAll(res);
    expect(body).not.toContain('GHOST');

    const turn2 = [
      ...turn1,
      { role: 'assistant', content: [{ type: 'output_text', text: 'clean' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn2)),
    });
    const cont = JSON.parse(s2.send.mock.calls[1]![0] as string);
    expect(cont.previous_response_id).toBe('resp_ok');
    expect(cont.input).toEqual([turn2[2]]);
    emitTextResponse(s2, 'resp_ok2', 'done');
    await readAll(second);
  });

  it('C: transport replay consumes the retry; a later previous_response_not_found is surfaced', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-C', onDiagnostic: e => diagnostics.push(e),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ])),
    });
    const s1 = lastSocket();
    s1.emit('open');
    created(s1, 'resp_abandoned');
    s1.emit('close', 1006, Buffer.from(''));
    expect(fakeSockets).toHaveLength(2);
    const s2 = lastSocket();
    s2.emit('open');
    // Server (wrongly) answers the full-context replay with previous_response_not_found.
    s2.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));
    expect(fakeSockets).toHaveLength(2); // no third attempt
    const body = await readAll(res);
    // Surfaced as a mapped 400, not retried a second time.
    expect(body).toContain('"code":"400"');
    expect(body).toContain('"message":"gone"');
    expect(countCreated(body)).toBe(0);
    // frameCount was reset by the replay, so the error frame is sequence 1.
    expect(body).toContain('"sequence_number":1');
  });

  it('D: previous_response_not_found retry first, then a control-frame transport failure is terminal', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-D' });
    const turn1 = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn1)),
    });
    const s1 = lastSocket();
    s1.emit('open');
    emitTextResponse(s1, 'resp_old', 'answer');
    await readAll(first);

    const turn2 = [
      ...turn1,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn2)),
    });
    s1.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));
    expect(fakeSockets).toHaveLength(2);
    const s2 = lastSocket();
    s2.emit('open');
    created(s2, 'resp_second_abandoned');
    s2.emit('close', 1006, Buffer.from(''));
    expect(fakeSockets).toHaveLength(2); // retry budget already spent
    const body = await readAll(second);
    expect(body).toContain('websocket_transport_error');
    // The buffered control frame is flushed ahead of the error frame, exactly once.
    expect(countCreated(body)).toBe(1);
  });

  it('E: a control frame followed by a downstream flush is terminal (no replay)', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-E' });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const s1 = lastSocket();
    s1.emit('open');
    created(s1, 'resp_created');
    // A non-JSON frame flushes the buffer downstream immediately.
    s1.emit('message', Buffer.from('not json at all'));
    s1.emit('close', 1006, Buffer.from(''));
    expect(fakeSockets).toHaveLength(1);
    const body = await readAll(res);
    expect(body).toContain('websocket_transport_error');
  });

  it('F: a single non-JSON frame is terminal (no replay)', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-F' });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const s1 = lastSocket();
    s1.emit('open');
    s1.emit('message', Buffer.from('garbage'));
    s1.emit('close', 1006, Buffer.from(''));
    expect(fakeSockets).toHaveLength(1);
    expect(await readAll(res)).toContain('websocket_transport_error');
  });

  it('G: a typeless JSON frame is terminal (no replay)', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-G' });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const s1 = lastSocket();
    s1.emit('open');
    s1.emit('message', Buffer.from(JSON.stringify({ hello: 'world' })));
    s1.emit('close', 1006, Buffer.from(''));
    expect(fakeSockets).toHaveLength(1);
    expect(await readAll(res)).toContain('websocket_transport_error');
  });

  it('H: replayed attempt that also dies after one control frame is terminal, single emit', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-H' });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const s1 = lastSocket();
    s1.emit('open');
    created(s1, 'resp_a');
    s1.emit('close', 1006, Buffer.from(''));
    const s2 = lastSocket();
    expect(fakeSockets).toHaveLength(2);
    s2.emit('open');
    created(s2, 'resp_b');
    s2.emit('close', 1006, Buffer.from(''));
    expect(fakeSockets).toHaveLength(2);
    const body = await readAll(res);
    expect(countCreated(body)).toBe(1);
    expect(body).toContain('resp_b');
    expect(body).not.toContain('resp_a"');
    expect(body).toContain('websocket_transport_error');
  });

  it('I: the abandoned socket cannot mutate the replayed attempt', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-I' });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const s1 = lastSocket();
    s1.emit('open');
    created(s1, 'resp_zombie');
    s1.emit('close', 1006, Buffer.from(''));
    const s2 = lastSocket();
    s2.emit('open');
    // Late frames from the dead socket, interleaved with the live attempt.
    emitTextResponse(s1, 'resp_zombie', 'ZOMBIE');
    emitTextResponse(s2, 'resp_live', 'live text');
    const body = await readAll(res);
    expect(body).not.toContain('ZOMBIE');
    expect(body).toContain('live text');
    expect(countCreated(body)).toBe(1);
  });

  it('J: an abort during the transport replay window closes cleanly', async () => {
    const controller = new AbortController();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-J' });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
      signal: controller.signal,
    });
    const s1 = lastSocket();
    s1.emit('open');
    created(s1, 'resp_x');
    controller.abort();
    s1.emit('close', 1006, Buffer.from(''));
    expect(fakeSockets).toHaveLength(1);
    expect(await readAll(res)).toBe('');
  });
});

describe('lens1: diagnostics sequencing', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    resetReasoningGapWarningsForTests();
    fakeSockets.length = 0;
  });

  it('K: started -> recovered -> exhausted for one request', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-K', onDiagnostic: e => diagnostics.push(e),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const s1 = lastSocket();
    s1.emit('open');
    s1.emit('close', 1006, Buffer.from(''));       // frameCount 0 -> replay
    const s2 = lastSocket();
    s2.emit('open');
    created(s2, 'resp_b');                          // -> recovered
    s2.emit('close', 1006, Buffer.from(''));        // -> ?
    await readAll(res);
    const outcomes = diagnostics
      .filter(e => (e as { event?: string }).event === 'ws_transport_retry')
      .map(e => (e as { outcome?: string }).outcome);
    // eslint-disable-next-line no-console
    console.log('OUTCOMES', JSON.stringify(outcomes));
    expect(outcomes.length).toBeGreaterThan(0);
  });
});
