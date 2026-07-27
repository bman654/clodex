import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';

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
  withResponsesWebSocketDiagnosticContext,
  type ResponsesWebSocketDiagnosticEvent,
} from '../src/oauth/responses-websocket.js';
import { sdkUpstreamErrorDetails } from '../src/upstream-error.js';

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

/** Drive a failed WebSocket upgrade by emitting `unexpected-response`. */
function rejectUpgrade(
  socket: FakeWebSocket,
  statusCode: number,
  opts: { headers?: Record<string, string>; statusMessage?: string } = {},
): { resume: ReturnType<typeof vi.fn> } {
  const response = Object.assign(new EventEmitter(), {
    statusCode,
    statusMessage: opts.statusMessage ?? '',
    headers: opts.headers ?? {},
    resume: vi.fn(),
  });
  socket.emit('unexpected-response', {}, response);
  return response;
}

/** Parse the single SSE error frame produced by a failed request. */
async function readErrorFrame(res: Response): Promise<{
  type: string;
  sequence_number: number;
  error: Record<string, unknown>;
}> {
  const body = await readAll(res);
  return JSON.parse(body.replace(/^data: /, '').trim());
}

/** Run the SSE error body through the real AI SDK and classify the surfaced error. */
async function classifyThroughSdk(sseBody: string): Promise<ReturnType<typeof sdkUpstreamErrorDetails>> {
  const provider = createOpenAI({
    apiKey: 'test-only',
    fetch: async () => new Response(sseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  });
  const streamed = streamText({
    model: provider.responses('gpt-5.6-sol'),
    prompt: 'test',
    maxRetries: 0,
    onError: () => {},
  });
  let upstreamError: unknown;
  for await (const part of streamed.stream) {
    if (part.type === 'error') upstreamError = part.error;
  }
  return sdkUpstreamErrorDetails(upstreamError);
}

function emitTextResponse(
  socket: FakeWebSocket,
  responseId: string,
  text: string,
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens: number;
  },
): void {
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
    type: 'response.completed', response: { id: responseId, usage },
  })));
}

function emitAssistantMessagesResponse(
  socket: FakeWebSocket,
  responseId: string,
  texts: string[],
): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created',
    response: { id: responseId },
  })));
  texts.forEach((text, outputIndex) => {
    const itemId = `msg_${responseId}_${outputIndex}`;
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: itemId },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      item_id: itemId,
      delta: text,
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: { type: 'message', id: itemId },
    })));
  });
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed',
    response: { id: responseId },
  })));
}

function emitCompactionResponse(
  socket: FakeWebSocket,
  responseId: string,
  encryptedContent: string,
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens: number;
  },
): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created', response: { id: responseId },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'compaction', id: `cmp_${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'compaction',
      id: `cmp_${responseId}`,
      encrypted_content: encryptedContent,
    },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed', response: { id: responseId, usage },
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
        originator: 'clodex',
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
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, message => debug.push(message), {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      {
        requestId: 'req-usage',
        claudeSessionId: '927b8642-15d2-4535-ab27-1430ae54c4aa',
      },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' }),
    );
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
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_usage',
      requestId: 'req-usage',
      claudeSessionId: '927b8642-15d2-4535-ab27-1430ae54c4aa',
      connectionId: 1,
      generation: 'isolated',
      continued: false,
      retried: false,
      inputTokens: 1_200,
      cachedTokens: 900,
      cacheWriteTokens: 200,
      outputTokens: 50,
    }));
  });

  it('retries a pre-frame socket error once on a fresh socket with full context', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'retry this request' }] },
    ];
    const payload = sessionPayload(input);
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-socket-error' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(payload),
      }),
    );
    const socket = lastSocket();
    const error = Object.assign(new Error('secret socket failure'), { code: 'ECONNRESET' });
    socket.emit('error', error);

    expect(fakeSockets).toHaveLength(2);
    expect(socket.close).toHaveBeenCalledOnce();
    const replacement = lastSocket();
    replacement.emit('open');
    expect(JSON.parse(replacement.send.mock.calls[0]![0] as string)).toEqual({
      type: 'response.create',
      ...payload,
    });
    emitTextResponse(replacement, 'resp_transport_retry', 'recovered');
    expect(await readAll(res)).toContain('recovered');

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      requestId: 'req-socket-error',
      connectionId: 1,
      generation: 'nursery',
      source: 'socket_error',
      socketErrorName: 'Error',
      socketErrorCode: 'ECONNRESET',
      frameCount: 0,
      emittedModelData: false,
      errorMessageBytes: 21,
      errorMessageHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'recovered',
      requestId: 'req-socket-error',
      connectionId: 2,
      frameCount: 1,
      emittedModelData: false,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('secret socket failure');
  });

  it('shares one retry budget across pre-frame socket errors and closes', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });

    const first = lastSocket();
    first.emit(
      'error',
      Object.assign(new Error('first private failure'), { code: 'ECONNRESET' }),
    );
    const replacement = lastSocket();
    replacement.emit('close', 1006, Buffer.from('second private failure'));

    expect(fakeSockets).toHaveLength(2);
    const body = await readAll(res);
    expect(JSON.parse(body.replace(/^data: /, '').trim())).toEqual({
      type: 'error',
      sequence_number: 0,
      error: {
        type: 'transport_error',
        code: 'websocket_transport_error',
        message: 'WebSocket closed (1006): second private failure',
        param: null,
      },
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'exhausted',
      connectionId: 2,
      source: 'socket_close',
      closeCode: 1006,
      frameCount: 0,
      emittedModelData: false,
    }));
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('first private failure');
    expect(serialized).not.toContain('second private failure');
  });

  it('retries a synchronous send failure once on a fresh socket', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const payload = sessionPayload([
      { role: 'user', content: [{ type: 'input_text', text: 'send this request' }] },
    ]);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(payload),
    });
    const first = lastSocket();
    first.send.mockImplementationOnce(() => {
      throw Object.assign(new Error('private synchronous send failure'), { code: 'EPIPE' });
    });

    expect(() => first.emit('open')).not.toThrow();
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    expect(JSON.parse(replacement.send.mock.calls[0]![0] as string)).toEqual({
      type: 'response.create',
      ...payload,
    });
    emitTextResponse(replacement, 'resp_sync_send_retry', 'recovered');
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      source: 'socket_send',
      failureMode: 'synchronous',
      socketErrorCode: 'EPIPE',
      frameCount: 0,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private synchronous send failure');
  });

  it('retries a callback-reported send failure through the same transport path', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    const first = lastSocket();
    first.send.mockImplementationOnce((
      _data: string,
      callback?: (error?: Error) => void,
    ) => {
      callback?.(Object.assign(new Error('private callback send failure'), { code: 'ECONNRESET' }));
    });

    first.emit('open');
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_callback_send_retry', 'recovered');
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      source: 'socket_send',
      failureMode: 'callback',
      socketErrorCode: 'ECONNRESET',
      frameCount: 0,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private callback send failure');
  });

  it('does not create a replacement when cancellation occurs while retiring the failed socket', async () => {
    const controller = new AbortController();
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
      signal: controller.signal,
    });
    const socket = lastSocket();
    socket.close.mockImplementationOnce(() => controller.abort());

    socket.emit(
      'error',
      Object.assign(new Error('private cancelled failure'), { code: 'ECONNRESET' }),
    );

    expect(fakeSockets).toHaveLength(1);
    expect(await readAll(res)).toBe('');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'cancelled',
      connectionId: 1,
      frameCount: 0,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private cancelled failure');
  });

  it('does not retry after any upstream response frame has arrived', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created',
      response: { id: 'resp_started' },
    })));
    socket.emit(
      'error',
      Object.assign(new Error('private post-frame failure'), { code: 'ECONNRESET' }),
    );

    expect(fakeSockets).toHaveLength(1);
    expect(await readAll(res)).toContain('websocket_transport_error');
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      connectionId: 1,
      frameCount: 1,
      emittedModelData: false,
    }));
  });

  it('does not retry after model output has reached the downstream stream', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'partial output',
    })));
    socket.emit(
      'error',
      Object.assign(new Error('post-output failure'), { code: 'ECONNRESET' }),
    );

    expect(fakeSockets).toHaveLength(1);
    const body = await readAll(res);
    expect(body).toContain('partial output');
    expect(body).toContain('websocket_transport_error');
  });

  it('retries a failed incremental continuation with the complete original context', async () => {
    const initialInput = [
      { role: 'user', content: [{ type: 'input_text', text: 'first turn' }] },
    ];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-transport-continuation',
    });
    const first = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(initialInput)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_transport_base', 'first answer');
    await readAll(first);

    const fullInput = [
      ...initialInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'second turn' }] },
    ];
    const continued = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(fullInput)),
    });
    const incremental = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(incremental.previous_response_id).toBe('resp_transport_base');
    expect(incremental.input).toEqual([fullInput[2]]);

    socket.emit(
      'error',
      Object.assign(new Error('continuation transport failure'), { code: 'ECONNRESET' }),
    );
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const replay = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(replay.previous_response_id).toBeUndefined();
    expect(replay.input).toEqual(fullInput);
    emitTextResponse(replacement, 'resp_transport_recovered', 'second answer');
    await readAll(continued);
  });

  it('retains a retried parallel auxiliary request as a reusable head', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-parallel-transport',
      onDiagnostic: event => diagnostics.push(event),
    });
    const mainInput = [
      { role: 'user', content: [{ type: 'input_text', text: 'main request' }] },
    ];
    const main = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(mainInput)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');

    const auxiliaryInput = [
      { role: 'user', content: [{ type: 'input_text', text: 'auxiliary request' }] },
    ];
    const auxiliary = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(auxiliaryInput)),
    });
    const failedAuxiliarySocket = lastSocket();
    failedAuxiliarySocket.emit(
      'error',
      Object.assign(new Error('auxiliary transport failure'), { code: 'ECONNRESET' }),
    );
    const auxiliaryReplacement = lastSocket();
    auxiliaryReplacement.emit('open');
    emitTextResponse(auxiliaryReplacement, 'resp_auxiliary', 'auxiliary answer');
    await readAll(auxiliary);
    emitTextResponse(mainSocket, 'resp_main', 'main answer');
    await readAll(main);

    const nextAuxiliaryInput = [
      ...auxiliaryInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'auxiliary answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'continue auxiliary' }] },
    ];
    const nextAuxiliary = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(nextAuxiliaryInput)),
    });
    expect(fakeSockets).toHaveLength(3);
    const nextAuxiliarySocket = auxiliaryReplacement;
    expect(JSON.parse(nextAuxiliarySocket.send.mock.calls[1]![0] as string)).toMatchObject({
      previous_response_id: 'resp_auxiliary',
      input: [nextAuxiliaryInput.at(-1)],
    });
    emitTextResponse(nextAuxiliarySocket, 'resp_auxiliary_next', 'done');
    await readAll(nextAuxiliary);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'recovered',
      generation: 'nursery',
    }));
  });

  it('terminates an unexpected HTTP upgrade response with a schema-valid stream error', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-upgrade-401' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: { Authorization: 'Bearer private-rejected-token' },
        body: JSON.stringify(
          sessionPayload([
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'private request body' }],
            },
          ]),
        ),
      }),
    );
    const socket = lastSocket();
    const { resume } = rejectUpgrade(socket, 401, {
      statusMessage: 'private response status',
      headers: { 'x-private': 'private response header' },
    });

    const body = await readAll(res);
    const frame = JSON.parse(body.replace(/^data: /, '').trim());
    expect(frame).toEqual({
      type: 'error',
      sequence_number: 0,
      error: {
        type: 'authentication_error',
        code: '401',
        message: 'WebSocket upgrade failed (HTTP 401)',
        param: null,
      },
    });
    expect((await classifyThroughSdk(body))?.statusCode).toBe(401);
    expect(resume).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        event: 'ws_response_error',
        requestId: 'req-upgrade-401',
        source: 'unexpected_response',
        httpStatusCode: 401,
        emittedModelData: false,
      }),
    );
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('private-rejected-token');
    expect(serialized).not.toContain('private request body');
    expect(serialized).not.toContain('private response status');
    expect(serialized).not.toContain('private response header');

    const next = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer private-rejected-token' },
      body: JSON.stringify(
        sessionPayload([
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'replacement request' }],
          },
        ]),
      ),
    });
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_after_401', 'recovered');
    await readAll(next);
  });

  it('maps a 403 upgrade rejection (edge throttle) to a retryable 429 rate limit without reading the body', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-upgrade-403' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
        body: JSON.stringify(sessionPayload([
          { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ])),
      }),
    );
    // Emit only `unexpected-response` — never body data or `end`. The mapping
    // must be synchronous and status-only.
    const { resume } = rejectUpgrade(lastSocket(), 403);

    const body = await readAll(res);
    const frame = JSON.parse(body.replace(/^data: /, '').trim());
    expect(frame.error.type).toBe('rate_limit_error');
    expect(frame.error.code).toBe('429');
    expect(frame.error.retry_after_seconds).toBe(5);
    expect(frame.error.message).toMatch(/retry after 5s/i);
    expect(resume).toHaveBeenCalledOnce();

    // Through the real AI SDK the failure surfaces as a retryable 429 with the
    // backoff hint — never as the permission error hosts relabel "Please run
    // /login".
    const details = await classifyThroughSdk(body);
    expect(details).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      retryAfterSeconds: 5,
    });

    // Diagnostics keep the real upstream status alongside the mapping.
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-upgrade-403',
      source: 'unexpected_response',
      httpStatusCode: 403,
      mappedStatusCode: 429,
      retryAfterSeconds: 5,
    }));
  });

  it('honors an upstream retry-after header on a 403 rejection', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });
    rejectUpgrade(lastSocket(), 403, { headers: { 'retry-after': '12' } });

    const frame = await readErrorFrame(res);
    expect(frame.error.type).toBe('rate_limit_error');
    expect(frame.error.retry_after_seconds).toBe(12);
  });

  it('clamps an oversized retry-after header and defaults a malformed one', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);

    const oversized = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });
    rejectUpgrade(lastSocket(), 403, { headers: { 'retry-after': '3600' } });
    const oversizedFrame = await readErrorFrame(oversized);
    expect(oversizedFrame.error.retry_after_seconds).toBe(60);
    // The message text is the only channel that survives the AI SDK's chunk
    // schema stripping, so the CLAMPED value must appear there too.
    expect(oversizedFrame.error.message).toMatch(/retry after 60s\b/i);

    const malformed = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });
    rejectUpgrade(lastSocket(), 403, { headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    const malformedFrame = await readErrorFrame(malformed);
    expect(malformedFrame.error.retry_after_seconds).toBe(5);
    expect(malformedFrame.error.message).toMatch(/retry after 5s\b/i);
  });

  it('handles the 403 synchronously so later socket error/close events cannot retry or double-handle', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'throttled' }] },
      ])),
    });
    const socket = lastSocket();
    rejectUpgrade(socket, 403);
    // ws surfaces transport teardown after a failed upgrade; the pre-frame
    // transport retry (PR #29) must see a finished request and stand down.
    socket.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    socket.emit('close', 1006, Buffer.from(''));

    expect(fakeSockets).toHaveLength(1);
    const frames = (await readAll(res)).split('\n\n').filter(Boolean);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.replace(/^data: /, '')).error.type).toBe('rate_limit_error');
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
    }));
  });

  it('lets the AI SDK transparently retry a 403-throttled upgrade and recover', async () => {
    // The design premise of the 403->429 mapping: because the synthetic error
    // frame arrives BEFORE any output chunk, @ai-sdk/openai's
    // throwIfOpenAIStreamErrorBeforeOutput rejects doStream with a retryable
    // 429 APICallError, so the AI SDK's own retry loop re-attempts the whole
    // request — including a fresh WebSocket upgrade. This drives that loop for
    // real: attempt 1 gets a 403 upgrade rejection, attempt 2 succeeds.
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const provider = createOpenAI({ apiKey: 'test-only', fetch: wsFetch });
    const streamed = streamText({
      model: provider.responses('gpt-5.6-sol'),
      prompt: 'retry me',
      maxRetries: 1,
      onError: () => {},
    });
    const collected = (async () => {
      let out = '';
      for await (const chunk of streamed.textStream) out += chunk;
      return out;
    })();

    await vi.waitFor(() => expect(fakeSockets).toHaveLength(1));
    rejectUpgrade(lastSocket(), 403);

    // The SDK backs off (no retry-after header on the synthetic SSE response,
    // so its default ~2s exponential delay) and opens a SECOND upgrade.
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(2), { timeout: 10_000 });
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_retry_recovered', 'recovered');

    // Transparent recovery: the caller sees only the successful text.
    await expect(collected).resolves.toBe('recovered');
    expect(fakeSockets).toHaveLength(2);
  }, 20_000);

  it('maps an in-band WebSocket connection limit error to a retryable 429', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-connection-limit' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
        body: JSON.stringify(sessionPayload([])),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        code: 'websocket_connection_limit_reached',
        message: 'connection limit reached',
        retry_after_seconds: 12,
      },
    })));

    const body = await readAll(res);
    expect(JSON.parse(body.replace(/^data: /, '').trim())).toEqual({
      type: 'error',
      sequence_number: 1,
      error: {
        type: 'rate_limit_error',
        code: '429',
        message: 'OpenAI reported the Responses WebSocket connection limit was reached; retry after 12s',
        param: null,
        retry_after_seconds: 12,
      },
    });
    expect(body).not.toContain('transport_error');
    expect(await classifyThroughSdk(body)).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      retryAfterSeconds: 12,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-connection-limit',
      source: 'error_frame',
      errorCode: 'websocket_connection_limit_reached',
      mappedStatusCode: 429,
      retryAfterSeconds: 12,
      emittedModelData: false,
    }));
  });

  it('logs sanitized upstream response failure details after partial output', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-response-failed' },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' }),
    );
    const socket = lastSocket();
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'partial',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'resp_failed',
        status: 'failed',
        error: {
          type: 'server_error',
          code: 'internal_error',
          message: 'sensitive backend explanation',
        },
      },
    })));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-response-failed',
      connectionId: 1,
      source: 'response_event',
      upstreamEventType: 'response.failed',
      errorType: 'server_error',
      errorCode: 'internal_error',
      responseStatus: 'failed',
      emittedModelData: true,
      willRetry: false,
      errorMessageBytes: 29,
      errorMessageHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive backend explanation');
  });

  it('logs a content-free anomaly when reasoning delta has no matching start', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-reasoning-anomaly' },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: JSON.stringify({ store: false }) }),
    );
    const socket = lastSocket();
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'sensitive-reasoning-item-id',
      summary_index: 0,
      delta: 'sensitive reasoning text',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_anomaly' },
    })));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_protocol_anomaly',
      requestId: 'req-reasoning-anomaly',
      connectionId: 1,
      source: 'response_event_sequence',
      anomaly: 'reasoning_start_missing_before_delta',
      upstreamEventType: 'response.reasoning_summary_text.delta',
      itemIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      summaryIndex: 0,
      knownSummaryParts: [],
      recentUpstreamEventTypes: ['response.reasoning_summary_text.delta'],
      emittedModelData: false,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive-reasoning-item-id');
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive reasoning text');
  });

  it('accepts a correctly sequenced multi-part reasoning response', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify({ store: false }),
    });
    const socket = lastSocket();
    const events = [
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1' },
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-1',
        summary_index: 0, delta: 'first',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-1', summary_index: 0,
      },
      {
        type: 'response.reasoning_summary_part.added', item_id: 'reasoning-1', summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-1',
        summary_index: 1, delta: 'second',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-1', summary_index: 1,
      },
      {
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1' },
      },
      { type: 'response.completed', response: { id: 'resp_reasoning' } },
    ];
    for (const event of events) socket.emit('message', Buffer.from(JSON.stringify(event)));
    await readAll(res);

    expect(diagnostics.some(event => event.event === 'ws_response_protocol_anomaly')).toBe(false);
  });

  it('detects a late delta for a reasoning part the SDK has already concluded', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify({ store: false }),
    });
    const socket = lastSocket();
    const events = [
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-late' },
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-late',
        summary_index: 0, delta: 'first',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-late', summary_index: 0,
      },
      {
        type: 'response.reasoning_summary_part.added', item_id: 'reasoning-late', summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-late',
        summary_index: 0, delta: 'late',
      },
      { type: 'response.failed', response: { id: 'resp_late', status: 'failed' } },
    ];
    for (const event of events) socket.emit('message', Buffer.from(JSON.stringify(event)));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_protocol_anomaly',
      anomaly: 'reasoning_start_missing_before_delta',
      summaryIndex: 0,
      knownSummaryParts: [
        { summaryIndex: 0, state: 'concluded' },
        { summaryIndex: 1, state: 'active' },
      ],
      recentUpstreamEventTypes: [
        'response.output_item.added',
        'response.reasoning_summary_text.delta',
        'response.reasoning_summary_part.done',
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_text.delta',
      ],
    }));
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

  it('keeps upstream frames byte-identical when native compaction is disabled', async () => {
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compaction-disabled',
      compactFetch: compactFetch as typeof fetch,
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Preserve the default path.' }],
    };
    const firstPayload = sessionPayload([firstUser]);
    const first = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 999_999 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(firstPayload),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    expect(socket.send.mock.calls[0]![0]).toBe(JSON.stringify({
      type: 'response.create',
      ...firstPayload,
    }));
    emitTextResponse(socket, 'resp_disabled_base', 'Default answer.', {
      input_tokens: 999_999,
      output_tokens: 10,
    });
    await readAll(first);

    const assistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Default answer.' }],
    };
    const compactInstruction = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Create the normal portable summary.' }],
    };
    const secondPayload = sessionPayload([firstUser, assistant, compactInstruction]);
    const second = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 999_999, forceCompaction: true },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(secondPayload),
      }),
    );
    expect(socket.send.mock.calls[1]![0]).toBe(JSON.stringify({
      type: 'response.create',
      ...secondPayload,
      input: [compactInstruction],
      previous_response_id: 'resp_disabled_base',
    }));
    expect(compactFetch).not.toHaveBeenCalled();
    expect(fakeSockets).toHaveLength(1);
    emitTextResponse(
      socket,
      'resp_disabled_summary',
      '<summary>The default summary remains unchanged.</summary>',
    );
    await readAll(second);
  });

  it('never triggers compaction without new incremental input', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-empty-delta',
      compactThreshold: 100,
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_empty_delta_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const sameHistory = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ];
    const repeated = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(sameHistory)),
    });
    expect(originalSocket.send).toHaveBeenCalledOnce();
    const replacement = lastSocket();
    expect(replacement).not.toBe(originalSocket);
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.input).toEqual(sameHistory);
    expect(sent.input).not.toContainEqual({ type: 'compaction_trigger' });
    emitTextResponse(replacement, 'resp_empty_delta_repeated', 'done');
    await readAll(repeated);
  });

  it('compacts once at the measured threshold, starts a fresh chain, then resumes delta-only', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const canonical = [{ type: 'compaction', encrypted_content: 'opaque-summary' }];
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'acct-native-compact',
      compactThreshold: 900,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_before_compact', 'first answer', {
      input_tokens: 950,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens: 20,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = { role: 'user', content: [{ type: 'input_text', text: 'second' }] };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify(sessionPayload(secondInput)),
    });

    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    const trigger = JSON.parse(originalSocket.send.mock.calls[1]![0] as string);
    expect(trigger.previous_response_id).toBe('resp_before_compact');
    expect(trigger.input).toEqual([secondUser, { type: 'compaction_trigger' }]);
    emitCompactionResponse(originalSocket, 'resp_compaction_trigger', 'opaque-summary', {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 950, cache_write_tokens: 25 },
      output_tokens: 25,
    });
    const second = await secondPromise;
    expect(compactFetch).not.toHaveBeenCalled();

    expect(fakeSockets).toHaveLength(2);
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    const compactedHead = JSON.parse(compactedSocket.send.mock.calls[0]![0] as string);
    expect(compactedHead.previous_response_id).toBeUndefined();
    expect(compactedHead.input).toEqual([firstUser, secondUser, ...canonical]);
    emitTextResponse(compactedSocket, 'resp_compacted', 'second answer', {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 75 },
      output_tokens: 20,
    });
    await readAll(second);
    expect(originalSocket.close).toHaveBeenCalledOnce();

    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    const thirdUser = { role: 'user', content: [{ type: 'input_text', text: 'third' }] };
    const third = await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });
    expect(compactFetch).not.toHaveBeenCalled();
    expect(fakeSockets).toHaveLength(2);
    const continued = JSON.parse(compactedSocket.send.mock.calls[1]![0] as string);
    expect(continued.previous_response_id).toBe('resp_compacted');
    expect(continued.input).toEqual([thirdUser]);
    compactedSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'previous_response_not_found', message: 'compacted head expired' },
    })));
    expect(fakeSockets).toHaveLength(3);
    const restoredSocket = lastSocket();
    restoredSocket.emit('open');
    const restored = JSON.parse(restoredSocket.send.mock.calls[0]![0] as string);
    expect(restored.previous_response_id).toBeUndefined();
    expect(restored.input).toEqual([
      firstUser,
      secondUser,
      ...canonical,
      secondAssistant,
      thirdUser,
    ]);
    emitTextResponse(restoredSocket, 'resp_after_compact', 'third answer');
    await readAll(third);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'completed',
      reason: 'measured_threshold',
      threshold: 900,
      transport: 'previous_response_compaction_trigger',
      inputTokens: 1_000,
      cachedTokens: 950,
      cacheWriteTokens: 25,
      outputTokens: 25,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_head_decision',
      decision: 'compaction_trigger_new_head',
      compactThreshold: 900,
    }));
  });

  it('re-anchors Claude rewritten history to native compacted state by portable-summary hash', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-claude-summary-anchor',
      compactThreshold: 900,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Investigate the original task.' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_anchor_base', 'Original answer.', {
      input_tokens: 950,
      output_tokens: 10,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Original answer.' }],
    };
    const secondUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Continue the original task.' }],
    };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(secondInput)),
    });
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_anchor_trigger', 'opaque-anchor');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_anchor_compacted', 'Second answer.', {
      input_tokens: 120,
      output_tokens: 10,
    });
    await readAll(second);
    expect(originalSocket.close).toHaveBeenCalledOnce();

    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Second answer.' }],
    };
    const compactInstruction = {
      role: 'user',
      content: [{
        type: 'input_text',
        text: 'Your task is to create a detailed summary of the conversation so far.',
      }],
    };
    const compactRequestInput = [
      ...secondInput,
      secondAssistant,
      compactInstruction,
    ];
    const compactRequestPromise = withResponsesWebSocketDiagnosticContext(
      { forceCompaction: true },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(compactRequestInput)),
      }),
    );

    const compactRequest = await compactRequestPromise;
    expect(fakeSockets).toHaveLength(2);
    expect(JSON.parse(compactedSocket.send.mock.calls[1]![0] as string)).toMatchObject({
      previous_response_id: 'resp_anchor_compacted',
      input: [compactInstruction],
    });
    expect(compactFetch).not.toHaveBeenCalled();
    const portableSummary =
      'The original task and its verified answer are preserved in this portable summary.';
    const modelSummary =
      `<analysis>private preparation</analysis>\n<summary>${portableSummary}</summary>`;
    emitAssistantMessagesResponse(compactedSocket, 'resp_anchor_summary', [
      '<summary>This earlier assistant message must not become the anchor.</summary>',
      modelSummary,
    ]);
    await readAll(compactRequest);

    const continuationPrefix =
      'This session is being continued from a previous conversation that ran out of context. '
      + 'The summary below covers the earlier portion of the conversation.\n\n';
    const continuationSuffix =
      'Continue the conversation from where it left off without asking the user any further questions. '
      + 'Resume directly — do not acknowledge the summary, do not recap what was happening, '
      + 'do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
    const currentPrompt = { type: 'input_text', text: 'Now implement the next change.' };
    const mismatchedUser = {
      role: 'user',
      content: [{
        type: 'input_text',
        text: `${continuationPrefix}Summary:\nA different portable summary must not select opaque state.`
          + `\n${continuationSuffix}`,
      }, currentPrompt],
    };
    const mismatched = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([mismatchedUser])),
    });
    expect(fakeSockets).toHaveLength(3);
    const mismatchedSocket = lastSocket();
    mismatchedSocket.emit('open');
    const mismatchedSent = JSON.parse(mismatchedSocket.send.mock.calls[0]![0] as string);
    expect(mismatchedSent.previous_response_id).toBeUndefined();
    expect(mismatchedSent.input).toEqual([mismatchedUser]);
    emitTextResponse(mismatchedSocket, 'resp_anchor_mismatch', 'Safe fallback.');
    await readAll(mismatched);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'anchor_missed',
      envelopeCount: 1,
    }));

    const rewrittenUser = {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `${continuationPrefix}Summary:\n${portableSummary}`
            + '\n\nIf you need specific details from before compaction, consult the transcript.'
            + `\n${continuationSuffix}`,
        },
        currentPrompt,
      ],
    };
    const duplicatedUser = {
      ...rewrittenUser,
      content: [{
        type: 'input_text',
        text: `${rewrittenUser.content[0]!.text}\n${rewrittenUser.content[0]!.text}`,
      }, currentPrompt],
    };
    const duplicated = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([duplicatedUser])),
    });
    expect(fakeSockets).toHaveLength(4);
    const duplicatedSocket = lastSocket();
    duplicatedSocket.emit('open');
    const duplicatedSent = JSON.parse(duplicatedSocket.send.mock.calls[0]![0] as string);
    expect(duplicatedSent.previous_response_id).toBeUndefined();
    expect(duplicatedSent.input).toEqual([duplicatedUser]);
    emitTextResponse(duplicatedSocket, 'resp_anchor_duplicated', 'Safe duplicate fallback.');
    await readAll(duplicated);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'anchor_missed',
      envelopeCount: 2,
    }));

    const continued = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([rewrittenUser])),
    });

    expect(fakeSockets).toHaveLength(4);
    const sent = JSON.parse(compactedSocket.send.mock.calls[2]![0] as string);
    expect(sent.previous_response_id).toBe('resp_anchor_summary');
    expect(sent.input).toEqual([{
      role: 'user',
      content: [currentPrompt],
    }]);
    expect(compactFetch).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'continuation',
      continuationMatchMode: 'claude_compaction_summary',
      selectedConnectionId: 2,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(portableSummary);

    emitTextResponse(compactedSocket, 'resp_anchor_continued', 'Implemented.');
    await readAll(continued);
  });

  it('does not anchor an implausibly short Claude compaction summary', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-short-summary',
      compactThreshold: 100,
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_short_summary_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    };
    const secondUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'second' }],
    };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(secondInput)),
    });
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_short_summary_trigger', 'short-anchor');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_short_summary_compacted', 'second answer');
    await readAll(second);

    const compactInstruction = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Create a portable summary.' }],
    };
    const compactRequest = await withResponsesWebSocketDiagnosticContext(
      { forceCompaction: true },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          ...secondInput,
          { role: 'assistant', content: [{ type: 'output_text', text: 'second answer' }] },
          compactInstruction,
        ])),
      }),
    );
    emitTextResponse(compactedSocket, 'resp_short_summary_output', '<summary>x</summary>');
    await readAll(compactRequest);

    const continuationPrefix =
      'This session is being continued from a previous conversation that ran out of context. '
      + 'The summary below covers the earlier portion of the conversation.\n\n';
    const continuationSuffix =
      'Continue the conversation from where it left off without asking the user any further questions. '
      + 'Resume directly — do not acknowledge the summary, do not recap what was happening, '
      + 'do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
    const rewrittenUser = {
      role: 'user',
      content: [{
        type: 'input_text',
        text: `${continuationPrefix}Summary:\nx\n${continuationSuffix}`,
      }, {
        type: 'input_text',
        text: 'continue',
      }],
    };
    const continued = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([rewrittenUser])),
    });
    const fallbackSocket = lastSocket();
    expect(fallbackSocket).not.toBe(compactedSocket);
    fallbackSocket.emit('open');
    const sent = JSON.parse(fallbackSocket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual([rewrittenUser]);
    emitTextResponse(fallbackSocket, 'resp_short_summary_fallback', 'done');
    await readAll(continued);
  });

  it('bounds retained user messages to the Codex 64K policy during a native rebase', async () => {
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-retention-budget',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const hugeUser = {
      role: 'user',
      content: [{ type: 'input_text', text: `begin-${'old-context-'.repeat(30_000)}-end` }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([hugeUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_retention_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const latestUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'preserve this latest request exactly' }],
    };
    const fullInput = [
      hugeUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      latestUser,
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_retention_trigger', 'bounded-summary');
    const second = await secondPromise;

    const rebasedSocket = lastSocket();
    rebasedSocket.emit('open');
    const rebased = JSON.parse(rebasedSocket.send.mock.calls[0]![0] as string);
    expect(rebased.input).toHaveLength(3);
    expect(rebased.input[1]).toEqual(latestUser);
    expect(rebased.input[2]).toEqual({
      type: 'compaction',
      encrypted_content: 'bounded-summary',
    });
    const truncatedText = rebased.input[0].content[0].text as string;
    expect(truncatedText).toContain('retained text truncated');
    expect(truncatedText.length).toBeLessThan(hugeUser.content[0]!.text.length);
    expect(JSON.stringify(rebased.input.slice(0, 2)).length).toBeLessThan(260_000);
    expect(compactFetch).not.toHaveBeenCalled();
    emitTextResponse(rebasedSocket, 'resp_retention_done', 'done');
    await readAll(second);
  });

  it('budgets retained images as vision input instead of base64 text', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-image-budget',
      compactThreshold: 100,
    });
    const imagePart = {
      type: 'input_image',
      image_url: `data:image/png;base64,${'a'.repeat(250_000)}`,
    };
    const hugeUser = {
      role: 'user',
      content: [
        imagePart,
        { type: 'input_text', text: `begin-${'x'.repeat(300_000)}-end` },
      ],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([hugeUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_image_budget_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const latestUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'keep the image-aware budget' }],
    };
    const fullInput = [
      hugeUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      latestUser,
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(fullInput)),
    });
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_image_budget_trigger', 'image-summary');
    const second = await secondPromise;
    const rebasedSocket = lastSocket();
    rebasedSocket.emit('open');
    const rebased = JSON.parse(rebasedSocket.send.mock.calls[0]![0] as string);
    expect(rebased.input[0].content[0]).toEqual(imagePart);
    const retainedText = rebased.input[0].content[1].text as string;
    expect(Buffer.byteLength(retainedText, 'utf8')).toBeGreaterThan(240_000);
    expect(Buffer.byteLength(retainedText, 'utf8')).toBeLessThanOrEqual(250_000);
    emitTextResponse(rebasedSocket, 'resp_image_budget_done', 'done');
    await readAll(second);
  });

  it('falls back to a normal full-context head when both native compaction routes are unavailable', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'private compact failure' },
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-fallback',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_fallback_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const fullInput = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      nextUser,
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });

    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    expect(JSON.parse(socket.send.mock.calls[1]![0] as string)).toMatchObject({
      previous_response_id: 'resp_fallback_base',
      input: [nextUser, { type: 'compaction_trigger' }],
    });
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'compaction_trigger_unavailable', message: 'private trigger failure' },
    })));
    const second = await secondPromise;
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(fullInput);
    emitTextResponse(replacement, 'resp_fallback_next', 'done');
    await readAll(second);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'fallback',
      transport: 'previous_response_compaction_trigger',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'fallback',
      transport: 'responses_compact_endpoint',
      statusCode: 503,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private compact failure');
    expect(JSON.stringify(diagnostics)).not.toContain('private trigger failure');
  });

  it('times out an in-band trigger before the downstream watchdog and falls back', async () => {
    const canonical = [
      { role: 'user', content: [{ type: 'input_text', text: 'retained after timeout' }] },
      { type: 'compaction', encrypted_content: 'timeout-summary' },
    ];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: canonical,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-trigger-timeout',
      compactThreshold: 100,
      compactTimeoutMs: 5,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_timeout_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'next' }],
    };
    const second = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        firstUser,
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        nextUser,
      ])),
    });
    expect(originalSocket.close).toHaveBeenCalledOnce();
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'fallback',
      transport: 'previous_response_compaction_trigger',
      errorType: 'ResponsesCompactionError',
    }));

    const replacement = lastSocket();
    replacement.emit('open');
    expect(JSON.parse(replacement.send.mock.calls[0]![0] as string).input).toEqual(canonical);
    emitTextResponse(replacement, 'resp_timeout_recovered', 'done');
    await readAll(second);
  });

  it('uses standalone compact output when a live compaction trigger fails', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const canonical = [
      { role: 'user', content: [{ type: 'input_text', text: 'retained' }] },
      { type: 'compaction_summary', encrypted_content: 'endpoint-summary' },
    ];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: canonical,
      usage: {
        input_tokens: 200,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 30,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-endpoint-fallback',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_endpoint_fallback_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const fullInput = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    originalSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'compaction_trigger_unavailable', message: 'private trigger failure' },
    })));

    const second = await secondPromise;
    expect(compactFetch).toHaveBeenCalledOnce();
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(canonical);
    emitTextResponse(replacement, 'resp_endpoint_fallback_next', 'done');
    await readAll(second);
    expect(originalSocket.close).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'completed',
      transport: 'responses_compact_endpoint',
      inputTokens: 200,
      outputTokens: 30,
    }));
  });

  it('recompacts canonical opaque state when an in-band trigger falls back to HTTP', async () => {
    const firstCanonical = [{ type: 'compaction', encrypted_content: 'first-opaque-state' }];
    const secondCanonical = [{ type: 'compaction', encrypted_content: 'second-opaque-state' }];
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).toEqual([
        firstUser,
        secondUser,
        ...firstCanonical,
        secondAssistant,
        thirdUser,
      ]);
      return new Response(JSON.stringify({ output: secondCanonical }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-recompact-http-fallback',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_recompact_base', 'first answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = { role: 'user', content: [{ type: 'input_text', text: 'second' }] };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_recompact_first_trigger', 'first-opaque-state');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    emitTextResponse(compactedSocket, 'resp_recompact_first_head', 'second answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(second);

    const thirdUser = { role: 'user', content: [{ type: 'input_text', text: 'third' }] };
    const thirdPromise = wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });
    await vi.waitFor(() => expect(compactedSocket.send).toHaveBeenCalledTimes(2));
    compactedSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'compaction_trigger_unavailable', message: 'trigger unavailable' },
    })));
    const third = await thirdPromise;

    expect(compactFetch).toHaveBeenCalledOnce();
    const recompactedSocket = lastSocket();
    recompactedSocket.emit('open');
    const sent = JSON.parse(recompactedSocket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(secondCanonical);
    emitTextResponse(recompactedSocket, 'resp_recompact_second_head', 'third answer');
    await readAll(third);
    expect(compactedSocket.close).toHaveBeenCalledOnce();
  });

  it('retries a compacted fresh head with canonical compact input, not the full transcript', async () => {
    const canonical = [{ type: 'compaction', encrypted_content: 'retry-summary' }];
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-retry',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_retry_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const fullInput = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      nextUser,
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_retry_trigger', 'retry-summary');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    const compactedInput = [firstUser, nextUser, ...canonical];
    expect(JSON.parse(compactedSocket.send.mock.calls[0]![0] as string).input)
      .toEqual(compactedInput);

    compactedSocket.emit(
      'error',
      Object.assign(new Error('compacted transport failure'), { code: 'ECONNRESET' }),
    );
    const replacement = lastSocket();
    replacement.emit('open');
    const replay = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(replay.previous_response_id).toBeUndefined();
    expect(replay.input).toEqual(compactedInput);
    expect(replay.input).not.toEqual(fullInput);
    emitTextResponse(replacement, 'resp_compact_retry', 'recovered');
    await readAll(second);
    expect(compactFetch).not.toHaveBeenCalled();
  });

  it('retries compaction after a post-compact failure and recovers after success', async () => {
    const retryCanonical = [{
      type: 'compaction',
      encrypted_content: 'retry-loop-summary',
    }];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: retryCanonical,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-failure-loop',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const fetchWithEstimate = (input: unknown[], estimatedInputTokens: number) =>
      withResponsesWebSocketDiagnosticContext(
        { estimatedInputTokens },
        () => wsFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload(input)),
        }),
      );
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const first = await fetchWithEstimate([firstUser], 50);
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_failure_loop_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const fullInput = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ];
    const secondPromise = fetchWithEstimate(fullInput, 150);
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_failure_loop_trigger', 'loop-summary');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    compactedSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'resp_failure_loop_failed',
        error: { code: 'server_error', message: 'post-compact turn failed' },
      },
    })));
    await readAll(second);

    const retry = await fetchWithEstimate(fullInput, 150);
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(compactFetch.mock.calls[0]![1]?.body)).input).toEqual(fullInput);
    expect(originalSocket.send).toHaveBeenCalledTimes(2);
    const retrySocket = lastSocket();
    retrySocket.emit('open');
    const retryFrame = JSON.parse(retrySocket.send.mock.calls[0]![0] as string);
    expect(retryFrame.previous_response_id).toBeUndefined();
    expect(retryFrame.input).toEqual(retryCanonical);
    emitTextResponse(retrySocket, 'resp_failure_loop_recovered', 'done', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(retry);

    const finalUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'after recovery' }],
    };
    const recoveredInput = [
      ...fullInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      finalUser,
    ];
    const recovered = await fetchWithEstimate(recoveredInput, 150);
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(retrySocket.send).toHaveBeenCalledTimes(2);
    const recoveredFrame = JSON.parse(retrySocket.send.mock.calls[1]![0] as string);
    expect(recoveredFrame.previous_response_id).toBe('resp_failure_loop_recovered');
    expect(recoveredFrame.input).toEqual([finalUser]);
    emitTextResponse(retrySocket, 'resp_failure_loop_done', 'fully recovered');
    await readAll(recovered);
  });

  it('restores a compact checkpoint after every matching live head has closed', async () => {
    const canonical = [{ type: 'compaction', encrypted_content: 'checkpoint-summary' }];
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-checkpoint',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_checkpoint_base', 'first answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = { role: 'user', content: [{ type: 'input_text', text: 'second' }] };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    await vi.waitFor(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_checkpoint_trigger', 'checkpoint-summary');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_checkpoint_compact', 'second answer', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(second);

    originalSocket.emit('close', 1000, Buffer.from(''));
    compactedSocket.emit('close', 1000, Buffer.from(''));
    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    const thirdUser = { role: 'user', content: [{ type: 'input_text', text: 'third' }] };
    await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });

    const restoredSocket = lastSocket();
    restoredSocket.emit('open');
    const restored = JSON.parse(restoredSocket.send.mock.calls[0]![0] as string);
    expect(restored.previous_response_id).toBeUndefined();
    expect(restored.input).toEqual([
      firstUser,
      secondUser,
      ...canonical,
      secondAssistant,
      thirdUser,
    ]);
    expect(compactFetch).not.toHaveBeenCalled();
  });

  it('expires process-local compact checkpoints after 30 minutes', async () => {
    let now = 0;
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const canonical = [
      firstUser,
      { type: 'compaction', encrypted_content: 'ttl-summary' },
    ];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: canonical,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-checkpoint-ttl',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
      now: () => now,
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 150 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([firstUser])),
      }),
    );
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_checkpoint_ttl', 'answer', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(first);
    compactedSocket.emit('close', 1000, Buffer.from(''));

    now = 30 * 60_000 + 1;
    const assistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    };
    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'next' }],
    };
    const fullInput = [firstUser, assistant, nextUser];
    const second = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(fullInput)),
    });
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(fullInput);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_head_decision',
      evictions: expect.arrayContaining([
        expect.objectContaining({ reason: 'checkpoint_ttl' }),
      ]),
    }));
    emitTextResponse(replacement, 'resp_checkpoint_ttl_fallback', 'done');
    await readAll(second);
  });

  it('enforces both per-partition and global compact-checkpoint caps', async () => {
    async function exerciseCap(partitionKeys: string[]): Promise<{
      oldestInput: unknown[];
      newestInput: unknown[];
      oldestSummary: string;
      newestSummary: string;
    }> {
      let now = 0;
      const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const user = body.input[0];
        const label = user.content[0].text as string;
        return new Response(JSON.stringify({
          output: [user, { type: 'compaction', encrypted_content: `summary-${label}` }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: `acct-checkpoint-cap-${partitionKeys.length}`,
        compactThreshold: 100,
        compactFetch: compactFetch as typeof fetch,
        now: () => now,
      });
      const records: Array<{
        user: { role: string; content: Array<{ type: string; text: string }> };
        assistant: { role: string; content: Array<{ type: string; text: string }> };
        promptCacheKey: string;
        summary: string;
      }> = [];
      for (let index = 0; index < partitionKeys.length; index += 1) {
        now = index + 1;
        const label = `branch-${index}`;
        const user = {
          role: 'user',
          content: [{ type: 'input_text', text: label }],
        };
        const response = await withResponsesWebSocketDiagnosticContext(
          { estimatedInputTokens: 150 },
          () => wsFetch('https://example.test/responses', {
            method: 'POST',
            headers: {},
            body: JSON.stringify(sessionPayload([user], {
              prompt_cache_key: partitionKeys[index],
            })),
          }),
        );
        const socket = lastSocket();
        socket.emit('open');
        emitTextResponse(socket, `resp_cap_${index}`, `answer-${index}`, {
          input_tokens: 50,
          output_tokens: 10,
        });
        await readAll(response);
        socket.emit('close', 1000, Buffer.from(''));
        records.push({
          user,
          assistant: {
            role: 'assistant',
            content: [{ type: 'output_text', text: `answer-${index}` }],
          },
          promptCacheKey: partitionKeys[index]!,
          summary: `summary-${label}`,
        });
      }

      const requestBranch = async (
        record: typeof records[number],
        suffix: string,
      ): Promise<unknown[]> => {
        now += 1;
        const nextUser = {
          role: 'user',
          content: [{ type: 'input_text', text: suffix }],
        };
        const response = await wsFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload([
            record.user,
            record.assistant,
            nextUser,
          ], {
            prompt_cache_key: record.promptCacheKey,
          })),
        });
        const socket = lastSocket();
        socket.emit('open');
        const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
        emitTextResponse(socket, `resp_${suffix}`, 'done');
        await readAll(response);
        return sent.input;
      };

      const oldest = records[0]!;
      const newest = records.at(-1)!;
      return {
        oldestInput: await requestBranch(oldest, 'oldest-next'),
        newestInput: await requestBranch(newest, 'newest-next'),
        oldestSummary: oldest.summary,
        newestSummary: newest.summary,
      };
    }

    const perPartition = await exerciseCap(Array.from({ length: 9 }, () => 'shared-key'));
    expect(perPartition.oldestInput).not.toContainEqual(expect.objectContaining({
      encrypted_content: perPartition.oldestSummary,
    }));
    expect(perPartition.newestInput).toContainEqual(expect.objectContaining({
      encrypted_content: perPartition.newestSummary,
    }));

    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    const global = await exerciseCap(Array.from(
      { length: 33 },
      (_, index) => `partition-${index}`,
    ));
    expect(global.oldestInput).not.toContainEqual(expect.objectContaining({
      encrypted_content: global.oldestSummary,
    }));
    expect(global.newestInput).toContainEqual(expect.objectContaining({
      encrypted_content: global.newestSummary,
    }));
  });

  it('reuses a socket only while the authorization credential is unchanged', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'acct-token-rotation',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-a' },
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_token_a_1', 'first answer');
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'second' }],
    };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const second = await wsFetch('https://x', {
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer token-a' }),
      body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    emitTextResponse(firstSocket, 'resp_token_a_2', 'second answer');
    await readAll(second);

    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    const thirdUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'third' }],
    };
    const third = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-b' },
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });

    expect(fakeSockets).toHaveLength(2);
    const replacementSocket = lastSocket();
    expect(replacementSocket).not.toBe(firstSocket);
    expect(replacementSocket.options.headers?.Authorization).toBe('Bearer token-b');
    replacementSocket.emit('open');
    emitTextResponse(replacementSocket, 'resp_token_b_1', 'third answer');
    await readAll(third);
    expect(JSON.stringify(diagnostics)).not.toMatch(/token-[ab]/);
  });

  it('emits correlated privacy-safe reasons when a history mismatch creates another head', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'private-account-id',
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'private first prompt' }] }];
    const first = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-first' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
      }),
    );
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_first', 'private answer');
    await readAll(first);

    const branchInput = [{ role: 'user', content: [{ type: 'input_text', text: 'private divergent prompt' }] }];
    const branch = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-branch' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(branchInput)),
      }),
    );
    const branchSocket = lastSocket();
    branchSocket.emit('open');
    emitTextResponse(branchSocket, 'resp_branch', 'private branch answer');
    await readAll(branch);

    const firstDecision = diagnostics.find(event => event.requestId === 'req-first');
    const branchDecision = diagnostics.find(event => event.requestId === 'req-branch');
    expect(firstDecision).toMatchObject({
      event: 'ws_head_decision',
      decision: 'new_partition_head',
      candidateCount: 0,
      createdConnectionId: 1,
      keyTuple: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        effort: 'high',
        promptCacheKey: 'relay-session-abc',
        accountIdHash: expect.any(String),
      },
    });
    expect(branchDecision).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_new_head',
      candidateCount: 1,
      matchingCandidateCount: 0,
      createdConnectionId: 2,
      heads: [{
        connectionId: 1,
        mismatch: {
          firstMismatch: 0,
          expectedKind: 'user',
          actualKind: 'user',
          expectedHash: expect.any(String),
          actualHash: expect.any(String),
        },
      }],
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('private-account-id');
    expect(serialized).not.toContain('private first prompt');
    expect(serialized).not.toContain('private divergent prompt');
    expect(serialized).not.toContain('private answer');
    expect(serialized).not.toContain('private branch answer');
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

  it('continues when Claude omits reasoning but exactly echoes the following function call', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-omitted-reasoning',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{"path":"file.ts"}', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed', response: { id: 'resp_reason_tool' },
    })));
    await readAll(first);

    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason_tool');
    expect(sent.input).toEqual([toolOutput]);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'continuation',
      continuationMatchMode: 'omitted_reasoning',
      promotedConnectionId: 1,
      selectedGeneration: 'established',
    });
    emitTextResponse(socket, 'resp_after_tool', 'done');
    await readAll(second);
  });

  it('continues when Claude omits reasoning but exactly echoes the following assistant text', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'answer it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-omitted-reasoning-text' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_text' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'message', id: 'msg_1',
        content: [{ type: 'output_text', text: 'the answer' }], status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason_text' } })));
    await readAll(first);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] };
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'the answer' }] },
        nextUser,
      ])),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason_text');
    expect(sent.input).toEqual([nextUser]);
  });

  it('does not ignore a mismatch in the assistant item after omitted reasoning', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-reasoning-mismatch' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{}', status: 'completed' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason_tool' } })));
    await readAll(first);

    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { type: 'function_call', call_id: 'call_1', name: 'Write', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
      ])),
    });
    expect(fakeSockets).toHaveLength(2);
  });

  it('retains an unrelated parallel request and preserves both branch heads', async () => {
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

    const nextAuxiliaryUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'revise title' }],
    };
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'make a title' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'title' }] },
        nextAuxiliaryUser,
      ])),
    });
    expect(fakeSockets).toHaveLength(2);
    const auxiliarySent = JSON.parse(auxiliarySocket.send.mock.calls[1]![0] as string);
    expect(auxiliarySent.previous_response_id).toBe('resp_aux');
    expect(auxiliarySent.input).toEqual([nextAuxiliaryUser]);
  });

  it('retains parallel workflow-agent heads for independent continuation', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-parallel-workflow',
    });
    const roots = ['agent one', 'agent two', 'agent three'].map(text => [
      { role: 'user', content: [{ type: 'input_text', text }] },
    ]);
    const pending: Response[] = [];
    for (const input of roots) {
      pending.push(await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      }));
    }
    expect(fakeSockets).toHaveLength(3);

    fakeSockets.forEach((socket, index) => {
      socket.emit('open');
      emitTextResponse(socket, `resp_agent_${index}`, `answer ${index}`);
    });
    await Promise.all(pending.map(readAll));

    for (let index = 0; index < roots.length; index += 1) {
      const nextUser = {
        role: 'user',
        content: [{ type: 'input_text', text: `continue ${index}` }],
      };
      await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          ...roots[index]!,
          { role: 'assistant', content: [{ type: 'output_text', text: `answer ${index}` }] },
          nextUser,
        ])),
      });
      const sent = JSON.parse(fakeSockets[index]!.send.mock.calls[1]![0] as string);
      expect(sent.previous_response_id).toBe(`resp_agent_${index}`);
      expect(sent.input).toEqual([nextUser]);
      emitTextResponse(fakeSockets[index]!, `resp_agent_${index}_next`, `done ${index}`);
    }
    expect(fakeSockets).toHaveLength(3);
  });

  it('continues a workflow tool loop when Claude replays a reshaped reasoning envelope', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const root = [
      { role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] },
      { role: 'developer', content: [{ type: 'input_text', text: 'workflow agent' }] },
    ];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-workflow-replayed-reasoning',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(root)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created',
      response: { id: 'resp_workflow_reasoning' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_original',
        encrypted_content: 'opaque-original',
        summary: [{ type: 'summary_text', text: 'Use Bash.' }],
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_original',
        call_id: 'call_pwd',
        name: 'Bash',
        arguments: '{"command":"pwd"}',
        status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_workflow_reasoning' },
    })));
    await readAll(first);

    const toolOutput = {
      type: 'function_call_output',
      call_id: 'call_pwd',
      output: '/tmp/workflow',
    };
    const next = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        ...root,
        {
          type: 'reasoning',
          encrypted_content: 'opaque-round-tripped',
          summary: [],
        },
        {
          type: 'function_call',
          call_id: 'call_pwd',
          name: 'Bash',
          arguments: '{ "command": "pwd" }',
        },
        toolOutput,
      ])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_workflow_reasoning');
    expect(sent.input).toEqual([toolOutput]);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'continuation',
      continuationMatchMode: 'replayed_reasoning',
      selectedConnectionId: 1,
    });
    emitTextResponse(socket, 'resp_workflow_done', 'done');
    await readAll(next);
  });

  it('retains the full 16-agent Claude workflow concurrency ceiling', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-full-width-workflow',
      onDiagnostic: event => diagnostics.push(event),
    });
    const pending: Response[] = [];
    for (let index = 0; index < 16; index += 1) {
      pending.push(await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          { role: 'user', content: [{ type: 'input_text', text: `agent ${index}` }] },
        ])),
      }));
    }

    expect(fakeSockets).toHaveLength(16);
    expect(diagnostics.filter(
      event => event.event === 'ws_head_decision' && event.decision === 'parallel_isolated',
    )).toHaveLength(0);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'parallel_new_head',
      nurseryConnectionCount: 15,
      maxNurseryConnections: 16,
      createdGeneration: 'nursery',
    });

    fakeSockets.forEach((socket, index) => {
      socket.emit('open');
      emitTextResponse(socket, `resp_full_width_${index}`, `answer ${index}`);
    });
    await Promise.all(pending.map(readAll));

    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'continue agent 15' }],
    };
    await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'agent 15' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer 15' }] },
        nextUser,
      ])),
    });
    const sent = JSON.parse(fakeSockets[15]!.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_full_width_15');
    expect(sent.input).toEqual([nextUser]);
  });

  it('falls back to an isolated parallel socket when every nursery slot is active', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-parallel-cap',
      maxNurseryConnections: 2,
      onDiagnostic: event => diagnostics.push(event),
    });
    const pending: Response[] = [];
    for (const text of ['one', 'two', 'overflow']) {
      pending.push(await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          { role: 'user', content: [{ type: 'input_text', text }] },
        ])),
      }));
    }
    expect(fakeSockets).toHaveLength(3);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'parallel_isolated',
      createdGeneration: 'isolated',
    });

    fakeSockets.forEach((socket, index) => {
      socket.emit('open');
      emitTextResponse(socket, `resp_cap_${index}`, `answer ${index}`);
    });
    await Promise.all(pending.map(readAll));

    const overflowContinuation = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'overflow' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer 2' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'continue overflow' }] },
      ])),
    });
    expect(fakeSockets).toHaveLength(3);
    const reusedNursery = fakeSockets.find(socket => socket.send.mock.calls.length === 2);
    expect(reusedNursery).toBeDefined();
    const sent = JSON.parse(reusedNursery!.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    emitTextResponse(reusedNursery!, 'resp_overflow_next', 'done');
    await readAll(overflowContinuation);
  });

  it('reuses a warm nursery socket for sequential divergent full-history requests', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-nursery-reuse',
      onDiagnostic: event => diagnostics.push(event),
    });
    const roots = ['branch one', 'branch two', 'branch three'].map(text => [
      { role: 'user', content: [{ type: 'input_text', text }] },
    ]);

    for (let index = 0; index < roots.length; index += 1) {
      const sendCounts = fakeSockets.map(socket => socket.send.mock.calls.length);
      const response = await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(roots[index]!)),
      });
      const socket = fakeSockets.find(
        (candidate, socketIndex) => candidate.send.mock.calls.length > (sendCounts[socketIndex] ?? 0),
      ) ?? lastSocket();
      if (index < 2) socket.emit('open');
      const sent = JSON.parse(socket.send.mock.calls.at(-1)![0] as string);
      expect(sent.previous_response_id).toBeUndefined();
      expect(sent.input).toEqual(roots[index]);
      emitTextResponse(socket, `resp_branch_${index}`, `answer ${index}`);
      await readAll(response);
    }

    expect(fakeSockets).toHaveLength(2);
    expect(fakeSockets[0]!.send).toHaveBeenCalledTimes(2);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_reused_head',
      selectedConnectionId: 1,
      selectedGeneration: 'nursery',
      createdConnectionId: undefined,
    });
  });

  it('reuses completed nursery heads across consecutive concurrent workflow waves', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-two-wave-workflow',
      onDiagnostic: event => diagnostics.push(event),
    });

    const runWave = async (labels: string[]): Promise<void> => {
      const pending: Response[] = [];
      const sendCounts = fakeSockets.map(socket => socket.send.mock.calls.length);
      for (const label of labels) {
        pending.push(await wsFetch('https://x', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload([
            { role: 'user', content: [{ type: 'input_text', text: label }] },
          ])),
        }));
      }
      fakeSockets.forEach((socket, index) => {
        if (sendCounts[index] === undefined) socket.emit('open');
        if (socket.send.mock.calls.length <= (sendCounts[index] ?? 0)) return;
        emitTextResponse(socket, `resp_${labels.join('')}_${index}`, `answer ${index}`);
      });
      await Promise.all(pending.map(readAll));
    };

    await runWave(['A', 'B', 'C']);
    expect(fakeSockets).toHaveLength(3);
    await runWave(['D', 'E', 'F']);

    // Two warm heads are recycled. One anchor is preserved, so the third
    // concurrent branch creates exactly one new retained head.
    expect(fakeSockets).toHaveLength(4);
    expect(diagnostics.filter(
      event => event.event === 'ws_head_decision'
        && event.decision === 'history_mismatch_reused_head',
    )).toHaveLength(2);
    expect(diagnostics.filter(
      event => event.event === 'ws_head_decision'
        && event.decision === 'parallel_isolated',
    )).toHaveLength(0);
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

  it('starts and resumes TTL clocks only after each response stream finishes', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-paused-ttl',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 100,
      hardTtlMs: 100,
      now: () => now,
    });
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
    });
    const socket = lastSocket();
    socket.emit('open');

    // The initial stream lasts far longer than every TTL, but none of that
    // in-flight time should age the retained head.
    now = 2_000;
    emitTextResponse(socket, 'resp_pause_1', 'answer one');
    await readAll(first);

    now = 2_050;
    const secondInput = [
      ...firstInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer one' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);

    // Suspend the already-running clocks during another long response.
    now = 3_050;
    emitTextResponse(socket, 'resp_pause_2', 'answer two');
    await readAll(second);

    now = 3_099;
    const thirdInput = [
      ...secondInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer two' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'three' }] },
    ];
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(thirdInput)),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[2]![0] as string);
    expect(sent.previous_response_id).toBe('resp_pause_2');
  });

  it('promotes a continued nursery head and preserves it past the nursery TTL at capacity', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-generations',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 1_000,
      hardTtlMs: 10_000,
      maxConnections: 1,
      now: () => now,
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_gen_1', 'answer one');
    await readAll(first);

    now += 50;
    const secondInput = [
      ...input,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer one' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    emitTextResponse(socket, 'resp_gen_2', 'answer two');
    await readAll(second);

    now += 150;
    const thirdInput = [
      ...secondInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer two' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'three' }] },
    ];
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(thirdInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[2]![0] as string);
    expect(sent.previous_response_id).toBe('resp_gen_2');
  });

  it('expires an unpromoted head on the shorter nursery TTL', async () => {
    let now = 1_000;
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-nursery-ttl',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 1_000,
      hardTtlMs: 10_000,
      now: () => now,
      onDiagnostic: event => diagnostics.push(event),
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_nursery', 'answer');
    await readAll(first);

    now += 101;
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
      ])),
    });

    expect(fakeSockets).toHaveLength(2);
    expect(socket.close).toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'new_partition_head',
      evictions: [{
        connectionId: 1,
        generation: 'nursery',
        reason: 'nursery_idle_ttl',
      }],
    });
  });

  it('keeps separate nursery capacity and evicts there without displacing a full established LRU', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-generation-lru',
      maxConnections: 1,
      maxNurseryConnections: 1,
      onDiagnostic: event => diagnostics.push(event),
    });
    const mainInput = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(mainInput)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');
    emitTextResponse(mainSocket, 'resp_main_1', 'main answer');
    await readAll(first);

    const mainNext = [
      ...mainInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'continue main' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(mainNext)),
    });
    emitTextResponse(mainSocket, 'resp_main_2', 'continued');
    await readAll(second);

    const branch = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'branch one' }] },
      ])),
    });
    const nurserySocket = lastSocket();
    nurserySocket.emit('open');
    emitTextResponse(nurserySocket, 'resp_branch_1', 'branch answer');
    await readAll(branch);
    expect(fakeSockets).toHaveLength(2);
    expect(mainSocket.close).not.toHaveBeenCalled();
    expect(nurserySocket.close).not.toHaveBeenCalled();

    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'branch two' }] },
      ])),
    });

    expect(fakeSockets).toHaveLength(3);
    expect(nurserySocket.close).toHaveBeenCalled();
    expect(mainSocket.close).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_new_head',
      evictions: [{
        connectionId: 2,
        generation: 'nursery',
        reason: 'nursery_lru_cap',
      }],
    });
  });

  it('partitions by provider, account, model, effort, session, and credential fingerprint', () => {
    const payload = sessionPayload([]);
    const options = { providerId: 'openai', accountId: 'a' };
    const base = responsesWebSocketPartitionKey(WS_URL, payload, options, 'credential-a');
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      { providerId: 'other', accountId: 'a' },
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      { providerId: 'openai', accountId: 'b' },
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, model: 'gpt-other' },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, reasoning: { effort: 'low' } },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, prompt_cache_key: 'other-session' },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      options,
      'credential-b',
    ));
    expect(base).toBe(responsesWebSocketPartitionKey(WS_URL, {
      ...payload,
      instructions: 'changed',
      tools: [{ type: 'function', name: 'Write' }],
    }, options, 'credential-a'));
  });

  it('canonicalizes object key ordering in prompt fingerprints', () => {
    expect(responsesWebSocketPromptFingerprint({ model: 'm', tools: [{ name: 'x', parameters: { b: 2, a: 1 } }], input: ['a'] }))
      .toBe(responsesWebSocketPromptFingerprint({ tools: [{ parameters: { a: 1, b: 2 }, name: 'x' }], model: 'm', input: ['different'] }));
  });
});
