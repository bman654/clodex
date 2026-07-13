import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Fake `ws` WebSocket that records constructor args and lets tests drive events.
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
  resetResponsesWebSocketConnectionsForTests,
  responsesWebSocketPartitionKey,
  responsesWebSocketPromptFingerprint,
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

function emitTextResponse(socket: FakeWebSocket, responseId: string, text: string): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created', response: { id: responseId },
  })));
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

describe('createResponsesWebSocketFetch', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
  });

  it('forwards request headers and adds the WebSocket beta header on the upgrade', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok',
        'ChatGPT-Account-Id': 'acct-123',
        originator: 'relay-ai',
        version: '0.144.1',
        'x-openai-internal-codex-responses-lite': 'true',
      },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });

    const headers = lastSocket().options.headers ?? {};
    expect(lastSocket().url).toBe(WS_URL);
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['ChatGPT-Account-Id']).toBe('acct-123');
    expect(headers['version']).toBe('0.144.1');
    expect(headers['x-openai-internal-codex-responses-lite']).toBe('true');
    expect(headers['OpenAI-Beta']).toContain('responses_websockets');
  });

  it('sends the payload as the first frame and folds in the Responses-Lite shape', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: { 'x-openai-internal-codex-responses-lite': 'true' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', reasoning: { effort: 'high' } }),
    });

    const socket = lastSocket();
    socket.emit('open');
    expect(socket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    // Must be a `response.create` event with the Responses fields at top level.
    expect(sent.type).toBe('response.create');
    expect(sent.model).toBe('gpt-5.6-luna');
    expect(sent.parallel_tool_calls).toBe(false);
    expect(sent.store).toBe(false);
    expect(sent.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
  });

  it('does not mutate the body when the Responses-Lite header is absent', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: JSON.stringify({ model: 'gpt-5.6-sol' }),
    });
    const socket = lastSocket();
    socket.emit('open');
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    // Still wrapped in the response.create envelope, but no Responses-Lite fields added.
    expect(sent).toEqual({ type: 'response.create', model: 'gpt-5.6-sol' });
  });

  it('collapses each frame onto a single SSE data line and closes on response.completed', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: '{}',
    });
    const socket = lastSocket();
    socket.emit('open');
    // Pretty-printed JSON frame must not become a multi-line SSE event.
    socket.emit('message', Buffer.from('{\n  "type": "response.output_text.delta",\n  "delta": "hi"\n}'));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed' })));

    const body = await readAll(res);
    const lines = body.split('\n\n').filter(Boolean);
    expect(lines[0]).toBe('data: {"type":"response.output_text.delta","delta":"hi"}');
    expect(lines[1]).toBe('data: {"type":"response.completed"}');
    expect(socket.close).toHaveBeenCalled();
  });

  it('logs privacy-safe raw cache usage from the terminal response event', async () => {
    const debug: string[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, message => debug.push(message));
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_usage',
        usage: {
          input_tokens: 1_200,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 200 },
          output_tokens: 50,
        },
      },
    })));
    await readAll(res);

    expect(debug).toContain(
      'ws: usage input_tokens=1200 cached_tokens=900 cache_write_tokens=200 output_tokens=50',
    );
  });

  it('surfaces a socket error as an SSE error event', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
    const socket = lastSocket();
    socket.emit('error', new Error('boom'));
    const body = await readAll(res);
    expect(body).toContain('"type":"error"');
    expect(body).toContain('boom');
  });

  it('closes the socket when the request is aborted', async () => {
    const controller = new AbortController();
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}', signal: controller.signal });
    const socket = lastSocket();
    controller.abort();
    await readAll(res);
    expect(socket.close).toHaveBeenCalled();
  });

  it('retains one socket and sends only append-only input with current prompt fields', async () => {
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai', accountId: 'acct-1',
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_1', 'hi');
    await readAll(first);

    expect(socket.close).not.toHaveBeenCalled();

    // A newly-created provider/fetch closure must still find the process-level chain.
    const nextFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai', accountId: 'acct-1',
    });
    const echoedAssistant = { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] };
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'again' }] };
    const updatedTools = [
      { type: 'function', name: 'Read', parameters: { type: 'object' } },
      { type: 'function', name: 'Write', parameters: { type: 'object' } },
    ];
    const second = await nextFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...firstInput, echoedAssistant, nextUser], {
        instructions: 'You are a coding assistant. A skill is now active.',
        tools: updatedTools,
      })),
    });

    expect(fakeSockets).toHaveLength(1);
    expect(socket.send).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_1');
    expect(sent.input).toEqual([nextUser]);
    expect(sent.instructions).toBe('You are a coding assistant. A skill is now active.');
    expect(sent.tools).toEqual(updatedTools);

    emitTextResponse(socket, 'resp_2', 'hello again');
    await readAll(second);
  });

  it('continues a tool loop with only the function_call_output', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'read it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-tools' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{ "path": "file.ts", "line": 1 }', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_tool' } })));
    await readAll(first);

    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read',
      arguments: '{"line":1,"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_tool');
    expect(sent.input).toEqual([toolOutput]);
    emitTextResponse(socket, 'resp_done', 'done');
    await readAll(second);
  });

  it('validates encrypted reasoning and exact assistant text before continuing', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'reason' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-reasoning' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: 'thinking',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 1,
      item: { type: 'message', id: 'msg_reason' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta', item_id: 'msg_reason', delta: 'answer',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: { type: 'message', id: 'msg_reason' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason' } })));
    await readAll(first);

    const reasoning = {
      type: 'reasoning', encrypted_content: 'enc_1',
      summary: [{ type: 'summary_text', text: 'thinking' }],
    };
    const assistant = { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] };
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, reasoning, assistant, nextUser])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(socket, 'resp_reason_next', 'done');
    await readAll(second);
  });

  it('isolates an unrelated parallel request and preserves the main chain head', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-parallel' });
    const main = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');

    const auxiliary = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'make a title' }] },
      ])),
    });
    const auxiliarySocket = lastSocket();
    expect(auxiliarySocket).not.toBe(mainSocket);
    auxiliarySocket.emit('open');
    emitTextResponse(auxiliarySocket, 'resp_aux', 'title');
    await readAll(auxiliary);

    emitTextResponse(mainSocket, 'resp_main', 'main answer');
    await readAll(main);
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
        nextUser,
      ])),
    });
    expect(lastSocket()).toBe(auxiliarySocket); // no new socket was constructed
    const sent = JSON.parse(mainSocket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_main');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(mainSocket, 'resp_next', 'next answer');
    await readAll(next);
  });

  it('retains the main head when a completed auxiliary request starts another branch', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-hidden-branch' });
    const main = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');
    emitTextResponse(mainSocket, 'resp_main', 'main answer');
    await readAll(main);

    // Claude stop hooks/title generation can run after the visible response and
    // inherit the same session/model/effort partition with unrelated history.
    const auxiliaryInput = [{ role: 'user', content: [{ type: 'input_text', text: 'make a title' }] }];
    const auxiliary = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(auxiliaryInput)),
    });
    expect(fakeSockets).toHaveLength(2);
    const auxiliarySocket = lastSocket();
    auxiliarySocket.emit('open');
    emitTextResponse(auxiliarySocket, 'resp_aux', 'title');
    await readAll(auxiliary);
    expect(mainSocket.close).not.toHaveBeenCalled();

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
        nextUser,
      ])),
    });

    expect(fakeSockets).toHaveLength(2);
    const sent = JSON.parse(mainSocket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_main');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(mainSocket, 'resp_main_next', 'you are welcome');
    await readAll(next);
  });

  it('retries previous_response_not_found once on a new socket with full context', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-retry' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_old', 'answer');
    await readAll(first);

    const fullNextInput = [
      ...input,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullNextInput)),
    });
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));

    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const retried = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(retried.previous_response_id).toBeUndefined();
    expect(retried.input).toEqual(fullNextInput);
    emitTextResponse(replacement, 'resp_recovered', 'recovered');
    const body = await readAll(second);
    expect(body).not.toContain('previous_response_not_found');
  });

  it('resets a rewind/branch to full context and establishes the branch as the new head', async () => {
    const original = [{ role: 'user', content: [{ type: 'input_text', text: 'original' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-branch' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(original)),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_original', 'original answer');
    await readAll(first);

    const branchInput = [{ role: 'user', content: [{ type: 'input_text', text: 'different branch' }] }];
    const branch = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(branchInput)),
    });
    expect(fakeSockets).toHaveLength(2);
    const branchSocket = lastSocket();
    branchSocket.emit('open');
    const reset = JSON.parse(branchSocket.send.mock.calls[0]![0] as string);
    expect(reset.previous_response_id).toBeUndefined();
    expect(reset.input).toEqual(branchInput);
    emitTextResponse(branchSocket, 'resp_branch', 'branch answer');
    await readAll(branch);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'continue branch' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...branchInput,
        { role: 'assistant', content: [{ type: 'output_text', text: 'branch answer' }] },
        nextUser,
      ])),
    });
    const continued = JSON.parse(branchSocket.send.mock.calls[1]![0] as string);
    expect(continued.previous_response_id).toBe('resp_branch');
    expect(continued.input).toEqual([nextUser]);
    emitTextResponse(branchSocket, 'resp_branch_next', 'done');
    await readAll(next);
  });

  it('expires an idle chain and restarts with full context', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-ttl', idleTtlMs: 100, hardTtlMs: 1_000, now: () => now,
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_ttl', 'answer');
    await readAll(first);

    now += 101;
    const full = [...input, { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] }];
    await wsFetch('https://x', { method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(full)) });
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(full);
  });

  it('partitions by provider, account, model, effort, and session only', () => {
    const payload = sessionPayload([]);
    const base = responsesWebSocketPartitionKey(WS_URL, payload, { providerId: 'openai', accountId: 'a' });
    expect(base).not.toBe(responsesWebSocketPartitionKey(WS_URL, payload, { providerId: 'other', accountId: 'a' }));
    expect(base).not.toBe(responsesWebSocketPartitionKey(WS_URL, payload, { providerId: 'openai', accountId: 'b' }));
    expect(base).not.toBe(responsesWebSocketPartitionKey(WS_URL, { ...payload, model: 'gpt-other' }, { providerId: 'openai', accountId: 'a' }));
    expect(base).not.toBe(responsesWebSocketPartitionKey(WS_URL, { ...payload, reasoning: { effort: 'low' } }, { providerId: 'openai', accountId: 'a' }));
    expect(base).not.toBe(responsesWebSocketPartitionKey(WS_URL, { ...payload, prompt_cache_key: 'other-session' }, { providerId: 'openai', accountId: 'a' }));
    expect(base).toBe(responsesWebSocketPartitionKey(WS_URL, {
      ...payload,
      instructions: 'changed',
      tools: [{ type: 'function', name: 'Write' }],
    }, { providerId: 'openai', accountId: 'a' }));
  });

  it('canonicalizes object key ordering in prompt fingerprints', () => {
    expect(responsesWebSocketPromptFingerprint({ model: 'm', tools: [{ name: 'x', parameters: { b: 2, a: 1 } }], input: ['a'] }))
      .toBe(responsesWebSocketPromptFingerprint({ tools: [{ parameters: { a: 1, b: 2 }, name: 'x' }], model: 'm', input: ['different'] }));
  });
});
