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

import { installParentNoticeSink } from '../src/parent-notice.js';
import {
  createResponsesWebSocketFetch,
  resetReasoningGapWarningsForTests,
  resetToolArgumentGapWarningsForTests,
  resetResponsesWebSocketConnectionsForTests,
  responsesWebSocketPartitionKey,
  responsesWebSocketPromptFingerprint,
  withResponsesWebSocketDiagnosticContext,
  type ResponsesWebSocketDiagnosticEvent,
} from '../src/oauth/responses-websocket.js';
import { sdkUpstreamErrorDetails } from '../src/upstream-error.js';
import type { UpgradeAdmission } from '../src/oauth/ws-upgrade-pacer.js';

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
    resetReasoningGapWarningsForTests();
    resetToolArgumentGapWarningsForTests();
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

  it('retries after multiple buffered control frames when no output was emitted', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const payload = sessionPayload([
      { role: 'user', content: [{ type: 'input_text', text: 'recover after setup' }] },
    ]);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(payload),
    });
    const first = lastSocket();
    first.emit('open');
    for (const event of [
      { type: 'response.created', response: { id: 'resp_abandoned' } },
      { type: 'response.queued', response: { id: 'resp_abandoned' } },
      { type: 'response.in_progress', response: { id: 'resp_abandoned' } },
      { type: 'response.reasoning_summary_part.added', item_id: 'reasoning_abandoned' },
    ]) {
      first.emit('message', Buffer.from(JSON.stringify(event)));
    }
    first.emit('close', 1006, Buffer.from(''));

    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    expect(JSON.parse(replacement.send.mock.calls[0]![0] as string)).toEqual({
      type: 'response.create',
      ...payload,
    });
    emitTextResponse(replacement, 'resp_recovered', 'recovered');

    const body = await readAll(res);
    expect(body).toContain('recovered');
    expect(body).not.toContain('resp_abandoned');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      source: 'socket_close',
      closeCode: 1006,
      frameCount: 4,
      emittedModelData: false,
      emittedDownstreamData: false,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'recovered',
      connectionId: 2,
      frameCount: 5,
      emittedDownstreamData: false,
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

  it('keeps a retried parallel auxiliary request isolated from reusable heads', async () => {
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
    expect(fakeSockets).toHaveLength(4);
    const nextAuxiliarySocket = lastSocket();
    expect(nextAuxiliarySocket).not.toBe(auxiliaryReplacement);
    nextAuxiliarySocket.emit('open');
    emitTextResponse(nextAuxiliarySocket, 'resp_auxiliary_next', 'done');
    await readAll(nextAuxiliary);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'recovered',
      generation: 'isolated',
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

  it('maps an in-band rejected request to its upstream status instead of an empty stream', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-unsupported-parameter' },
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
        type: 'invalid_request_error',
        code: 'unsupported_parameter',
        message: "Unsupported parameter: 'reasoning.summary' is not supported with the 'gpt-5.3-codex-spark' model.",
        param: 'reasoning.summary',
      },
      status: 400,
    })));

    const body = await readAll(res);
    expect(await readErrorFrame(new Response(body))).toEqual({
      type: 'error',
      sequence_number: 1,
      error: {
        type: 'invalid_request_error',
        code: '400',
        message: "Unsupported parameter: 'reasoning.summary' is not supported with the 'gpt-5.3-codex-spark' model.",
        param: null,
      },
    });
    // The failure must reach the caller as a 400, not as a content-free 200.
    expect(await classifyThroughSdk(body)).toMatchObject({
      statusCode: 400,
      isRetryable: false,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-unsupported-parameter',
      source: 'error_frame',
      errorCode: 'unsupported_parameter',
      mappedStatusCode: 400,
      emittedModelData: false,
    }));
    // One rejection, one record. The generic `response_event` record is
    // suppressed so a diagnostics consumer does not read one failed request as
    // two distinct failures under disjoint field sets.
    expect(diagnostics.filter(event => event.event === 'ws_response_error')).toHaveLength(1);
  });

  it('bounds an upstream-controlled error code in the rejection diagnostic', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      // Hostile: overlong and newline-bearing, so it would corrupt a log line
      // if forwarded verbatim the way the raw value was.
      error: { type: 'invalid_request_error', code: `${'c'.repeat(400)}\nsecond line`, message: 'nope' },
      status: 400,
    })));
    await readAll(res);

    const record = diagnostics.find(event => event.event === 'ws_response_error');
    expect(record).toMatchObject({ source: 'error_frame', mappedStatusCode: 400 });
    // Rejected outright rather than truncated — same discipline every other
    // identifier in this file's diagnostics already follows.
    expect(record?.errorCode).toBeUndefined();
  });

  it('carries an in-band 429 backoff hint through as message text', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'usage limit reached', retry_after_seconds: 45 },
      status: 429,
    })));

    const body = await readAll(res);
    // The AI SDK strips unknown frame fields, so the hint only survives baked
    // into the message — which is how the consumer recovers it.
    expect(body).toContain('retry after 45s');
    expect(await classifyThroughSdk(body)).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      retryAfterSeconds: 45,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      source: 'error_frame',
      // The record that survives dedup must still name the failure.
      errorType: 'rate_limit_error',
      retryAfterSeconds: 45,
    }));
  });

  it('clamps an absurd in-band backoff hint', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down', retry_after_seconds: 86400 },
      status: 429,
    })));

    // Bound a hostile day-long hint to the documented 60-second cap.
    expect(await readAll(res)).toContain('retry after 60s');
  });

  it('states no backoff hint on a 429 when upstream gave none', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      // A plan-level limit: the reason is stated in prose, on an hours scale.
      error: { type: 'usage_limit_reached', message: 'Usage limit reached. Resets in 4 hours.' },
      status: 429,
    })));

    const body = await readAll(res);
    expect(body).toContain('Resets in 4 hours.');
    // Inventing a hint here would become a real `retry-after: 5` header and
    // send the client back long before the limit resets.
    expect(body).not.toContain('retry after');
    expect(await classifyThroughSdk(body)).toMatchObject({ statusCode: 429 });
  });

  it('reads a status nested under error, not only the top-level one', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'nested status', status: 400 },
    })));

    expect(await classifyThroughSdk(await readAll(res))).toMatchObject({ statusCode: 400 });
  });

  // The fall-through cases. `status` must be an HTTP error code specifically —
  // a success status is not a rejection, and `response.status` is a lifecycle
  // string this must never mistake for one.
  it.each([
    ['a non-error status', { type: 'error', error: { type: 'server_error', message: 'keep me' }, status: 200 }],
    ['a lifecycle response status', { type: 'error', error: { type: 'server_error', message: 'keep me' }, response: { status: 'failed' } }],
    ['a fractional status', { type: 'error', error: { type: 'server_error', message: 'keep me' }, status: 400.5 }],
    // `response.status` is a lifecycle state, never an HTTP code. Pinned with a
    // NUMERIC value on purpose: a string one is rejected by the type guard
    // anyway, so only this shape can catch a future edit that starts consulting
    // that field and reports a lifecycle position as a status.
    ['a numeric response status', { type: 'error', error: { type: 'server_error', message: 'keep me' }, response: { status: 400 } }],
  ])('does not adopt %s as the mapped status', async (_label, frame) => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify(frame)));

    const body = await readAll(res);
    // No status was recovered, so none of these shapes may be adopted as one.
    // They fail as a generic 502 rather than being forwarded verbatim: an
    // `error` frame ends the stream, and forwarding it with nothing emitted
    // hands the client a successful, EMPTY 200 — the silent-no-response defect.
    // Pinning 502 keeps the original guard intact too, since an edit that
    // started reading these fields would surface as 200/400 here.
    expect(await classifyThroughSdk(body)).toMatchObject({ statusCode: 502 });
    // The cause is named from the bounded identifiers; upstream's own prose is
    // deliberately not carried (see the log-safety test below).
    expect(body).toContain('server_error');
    expect(body).not.toContain('keep me');
  });

  // Each message source the helper consults, pinned separately — otherwise a
  // "simplification" that drops one of the fallbacks ships green.
  it.each([
    ['nested under response.error', { type: 'error', status: 400, response: { error: { message: 'from response error' } } }, 'from response error'],
    ['on the frame itself', { type: 'error', status: 400, message: 'from the frame' }, 'from the frame'],
  ])('recovers a rejection message %s', async (_label, frame, expected) => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify(frame)));

    expect(await readAll(res)).toContain(expected);
  });

  it('falls back to a generic reason when a rejection carries no message', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'error', status: 503 })));

    const body = await readAll(res);
    expect(body).toContain('OpenAI rejected the request (HTTP 503)');
    expect(await classifyThroughSdk(body)).toMatchObject({ statusCode: 503 });
  });

  it('leaves a status-carrying error frame alone once model data is downstream', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta', delta: 'partial',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'server_error', code: 'internal_error', message: 'late failure' },
      status: 500,
    })));

    // Already-committed stream: the frame is forwarded verbatim, not rewritten
    // into a synthetic error that would contradict the emitted output.
    const body = await readAll(res);
    expect(body).toContain('partial');
    // Assert the ORIGINAL frame is still there, not merely that the synthetic
    // one is absent: `not.toContain` alone passes just as happily when the
    // frame is dropped entirely, which is the regression this test exists to
    // catch. Both halves are required.
    expect(body).toContain('late failure');
    expect(body).toContain('"status":500');
    expect(body).not.toContain('"code":"500"');
  });

  // The silent-no-response defect. A failure terminal that names no HTTP status
  // used to be forwarded verbatim with nothing emitted, so the client received a
  // successful, EMPTY 200 and rendered a turn where the model said nothing —
  // indistinguishable from deliberate silence, and the reason never surfaced.
  async function failWith(frame: unknown): Promise<string> {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify(frame)));
    return readAll(res);
  }

  it('fails an indeterminate output-less terminal as a retryable server fault', async () => {
    const body = await failWith({
      type: 'response.failed',
      response: { id: 'resp_x', status: 'failed', error: { type: 'server_error', message: 'why it died' } },
    });
    expect(await classifyThroughSdk(body)).toMatchObject({ statusCode: 502, isRetryable: true });
  });

  // Deterministic outcomes must NOT be retryable. frameIsRetryable treats every
  // status >= 500 as transient, so a blanket 502 would make the SDK repeat a
  // request upstream has already settled and then report a server fault for
  // something that was never one.
  it.each([
    ['content_filter', { type: 'response.incomplete', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'content_filter' } } }],
    ['max_output_tokens', { type: 'response.incomplete', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }],
    ['invalid_request_error', { type: 'response.failed', response: { id: 'r', status: 'failed', error: { type: 'invalid_request_error', message: 'bad' } } }],
  ])('does not make a deterministic %s outcome retryable', async (_label, frame) => {
    const verdict = await classifyThroughSdk(await failWith(frame));
    expect(verdict).toMatchObject({ statusCode: 400 });
    expect(verdict?.isRetryable).toBe(false);
  });

  it('preserves a context-limit failure as 400 so auto-compaction still fires', async () => {
    // isContextLengthExceededError trusts a frame's structured discriminator
    // over its prose, and the proxy handlers require a 400 before emitting
    // Claude Code's prompt-too-long response. As a 502 a long-context request
    // is retried as a server fault AND loses the signal that would have made
    // room for it — the worst of both.
    for (const frame of [
      { type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'context_length_exceeded', message: 'too long' } } },
      { type: 'error', error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'too long' } },
    ]) {
      const verdict = await classifyThroughSdk(await failWith(frame));
      expect(verdict, JSON.stringify(frame)).toMatchObject({ statusCode: 400 });
      expect(verdict?.isRetryable, JSON.stringify(frame)).toBe(false);
    }
  });

  it('classifies output-less terminals with the same rules as a status-carrying frame', async () => {
    // Delegating to frameStatusCode rather than a local whitelist is what keeps
    // these in step; 502 stands in only where that classifier has no opinion.
    const auth = await classifyThroughSdk(await failWith({
      type: 'response.failed',
      response: { id: 'r', status: 'failed', error: { type: 'authentication_error', message: 'nope' } },
    }));
    expect(auth).toMatchObject({ statusCode: 401 });

    const overload = await classifyThroughSdk(await failWith({
      type: 'response.failed',
      response: { id: 'r', status: 'failed', error: { type: 'overloaded_error', message: 'busy' } },
    }));
    expect(overload).toMatchObject({ statusCode: 503 });
  });

  it('routes a numeric error code through the classifier, not past it', async () => {
    // frameStatusCode recognises a numeric HTTP code only via its `code`
    // argument — clodex's own synthetic frames use that exact channel. Folded
    // into the discriminator as prose instead, `code: '401'` matches no rule,
    // lands on the 500 default, and is rewritten as a RETRYABLE 502.
    for (const [code, expected] of [['401', 401], ['429', 429], ['503', 503]] as const) {
      const verdict = await classifyThroughSdk(await failWith({
        type: 'response.failed',
        response: { id: 'r', status: 'failed', error: { code, message: 'x' } },
      }));
      expect(verdict, code).toMatchObject({ statusCode: expected });
    }
  });

  it('carries an output-less usage-limit backoff in the message text', async () => {
    // The AI SDK's chunk schema is a closed zod object that strips
    // `retry_after_seconds`, so a hint carried only in the frame field never
    // reaches the client — it has to be baked into the prose.
    const body = await failWith({
      type: 'response.failed',
      response: {
        id: 'r',
        status: 'failed',
        error: { type: 'usage_limit_reached', message: 'weekly limit reached', retry_after_seconds: 1800 },
      },
    });
    // Clamped to MAX_RETRY_AFTER_SECONDS so an hour-scale hint cannot park the client.
    expect(body).toContain('retry after 60s');
    expect(await classifyThroughSdk(body)).toMatchObject({ statusCode: 429, retryAfterSeconds: 60 });
  });

  it('asserts no backoff upstream never stated', async () => {
    const body = await failWith({
      type: 'response.failed',
      response: { id: 'r', status: 'failed', error: { type: 'usage_limit_reached', message: 'limit' } },
    });
    expect(body).not.toContain('retry after');
    expect(await classifyThroughSdk(body)).toMatchObject({ statusCode: 429 });
  });

  it('never carries upstream failure prose to the log OR the client', async () => {
    // A response.failed body can echo request content, and it does not stay in
    // one place: the synthetic error is rethrown by the SDK and proxy.ts writes
    // both the formatted message and errorContent to the persistent proxy log,
    // which redactTraceLine only scrubs of known credential shapes. Guarding
    // the immediate `fail:` line while the same text reaches disk one frame
    // later is not a guard — so the prose is not used at all. The bounded
    // identifiers name the cause, and the raw text survives as a length+hash
    // in the structured diagnostic.
    const logged: string[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, line => logged.push(line));
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'r',
        status: 'failed',
        error: { type: 'server_error', message: 'SECRET-ECHOED-PROMPT-CONTENT' },
      },
    })));
    const body = await readAll(res);

    expect(body).not.toContain('SECRET-ECHOED-PROMPT-CONTENT');
    expect(body).toContain('server_error');
    expect(logged.join('\n')).not.toContain('SECRET-ECHOED-PROMPT-CONTENT');
    const failLines = logged.filter(line => line.includes('fail:'));
    expect(failLines.length).toBeGreaterThan(0);
    expect(failLines.join('\n')).toContain('server_error');
  });

  it('maps an output-less usage limit to 429 rather than a server fault', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'resp_x',
        status: 'failed',
        error: { type: 'usage_limit_reached', message: 'plan limit reached' },
      },
    })));

    // An exhausted account is not a server fault: 502 would spend the client's
    // whole retry budget re-asking a question upstream has already answered.
    expect(await classifyThroughSdk(await readAll(res))).toMatchObject({ statusCode: 429 });
  });

  it('keeps a content-free fingerprint of what upstream actually said', async () => {
    // The prose never reaches the client or the log, so the fingerprint is the
    // ONLY evidence distinguishing two failures with the same type and code.
    // failContext fingerprints the message it is given after spreading the
    // details, so an errorMessage* pair passed in is overwritten by the
    // summary's — the upstream one has to travel under its own keys.
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'r',
        status: 'failed',
        error: { type: 'server_error', message: 'sensitive backend explanation' },
      },
    })));
    await readAll(res);

    const record = diagnostics.find(event => event.event === 'ws_response_error') as
      Record<string, unknown> | undefined;
    expect(record).toBeTruthy();
    expect(record!.upstreamMessageBytes).toBe(29);
    expect(record!.upstreamMessageHash).toMatch(/^[a-f0-9]{16}$/);
    // ...alongside, not instead of, the fingerprint of what the client was told.
    expect(record!.errorMessageBytes).not.toBe(29);
    expect(JSON.stringify(record)).not.toContain('sensitive backend explanation');
  });

  it('names the upstream cause in the diagnostic when a terminal emitted nothing', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-empty-terminal' },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' }),
    );
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'resp_x',
        status: 'failed',
        error: { type: 'usage_limit_reached', code: 'usage_limit_reached', message: 'plan limit reached' },
      },
    })));
    await readAll(res);

    // Exactly one record for one failure, carrying the bounded identifier that
    // names the cause — this is what a silent session will be diagnosed from.
    const records = diagnostics.filter(event => event.event === 'ws_response_error');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'empty_failure_terminal',
      upstreamEventType: 'response.failed',
      errorType: 'usage_limit_reached',
      emittedModelData: false,
    });
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

  it('continues a tool loop when the echoed arguments were sanitized of null filler', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'read it back' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-null-filler' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_null' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', call_id: 'call_n', name: 'Read', arguments: '{"path":"file.ts","offset":null}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_null' } })));
    await readAll(first);

    // The translation layer drops the null-valued `offset` before the call
    // reaches the client, so the echo is strictly smaller than the raw
    // upstream arguments. The snapshot must hold the sanitized shape or the
    // head can never match its own echo.
    const echoedCall = { type: 'function_call', call_id: 'call_n', name: 'Read', arguments: '{"path":"file.ts"}' };
    const toolOutput = { type: 'function_call_output', call_id: 'call_n', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_null');
    expect(sent.input).toEqual([toolOutput]);
    emitTextResponse(socket, 'resp_null_done', 'done');
    await readAll(second);
  });

  it('continues when a non-required empty array was sanitized from the echoed arguments', async () => {
    const tools = [{
      type: 'function', name: 'WebSearch',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, allowed_domains: { type: 'array' } },
        required: ['query'],
      },
    }];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'search' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-empty-array' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input, { tools })),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_arr' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', call_id: 'call_a', name: 'WebSearch', arguments: '{"query":"q","allowed_domains":[]}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_arr' } })));
    await readAll(first);

    const echoedCall = { type: 'function_call', call_id: 'call_a', name: 'WebSearch', arguments: '{"query":"q"}' };
    const toolOutput = { type: 'function_call_output', call_id: 'call_a', output: 'results' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput], { tools })),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_arr');
    expect(sent.input).toEqual([toolOutput]);
    emitTextResponse(socket, 'resp_arr_done', 'done');
    await readAll(second);
  });

  it('keeps a required empty array in the snapshot and still continues', async () => {
    const tools = [{
      type: 'function', name: 'TodoWrite',
      parameters: {
        type: 'object',
        properties: { todos: { type: 'array' } },
        required: ['todos'],
      },
    }];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'clear todos' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-required-array' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input, { tools })),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_req' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', call_id: 'call_r', name: 'TodoWrite', arguments: '{"todos":[]}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_req' } })));
    await readAll(first);

    // A required empty array survives sanitization on the way to the client,
    // so the echo carries it and the snapshot must keep it too.
    const echoedCall = { type: 'function_call', call_id: 'call_r', name: 'TodoWrite', arguments: '{"todos":[]}' };
    const toolOutput = { type: 'function_call_output', call_id: 'call_r', output: 'cleared' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput], { tools })),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_req');
    expect(sent.input).toEqual([toolOutput]);
    emitTextResponse(socket, 'resp_req_done', 'done');
    await readAll(second);
  });

  it('starts a new chain when the echoed call differs in a meaningful argument value', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'read it back' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-real-diff' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_diff' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', call_id: 'call_d', name: 'Read', arguments: '{"path":"file.ts"}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_diff' } })));
    await readAll(first);

    // A genuinely different argument value is a divergent history, not a
    // sanitized echo: it must be rejected, or the chain would silently
    // continue a conversation the server never had.
    const divergedCall = { type: 'function_call', call_id: 'call_d', name: 'Read', arguments: '{"path":"other.ts"}' };
    const toolOutput = { type: 'function_call_output', call_id: 'call_d', output: 'contents' };
    const fullInput = [...input, divergedCall, toolOutput];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });
    const isolated = lastSocket();
    expect(isolated).not.toBe(socket);
    isolated.emit('open');
    const sent = JSON.parse(isolated.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(fullInput);
    emitTextResponse(isolated, 'resp_diff_new', 'done');
    await readAll(second);
  });

  it('starts a new chain when the echoed call carries a different call_id', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'read it back' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-callid-diff' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_cid' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', call_id: 'call_c1', name: 'Read', arguments: '{"path":"file.ts"}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_cid' } })));
    await readAll(first);

    const divergedCall = { type: 'function_call', call_id: 'call_c2', name: 'Read', arguments: '{"path":"file.ts"}' };
    const toolOutput = { type: 'function_call_output', call_id: 'call_c2', output: 'contents' };
    const fullInput = [...input, divergedCall, toolOutput];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });
    const isolated = lastSocket();
    expect(isolated).not.toBe(socket);
    isolated.emit('open');
    const sent = JSON.parse(isolated.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(fullInput);
    emitTextResponse(isolated, 'resp_cid_new', 'done');
    await readAll(second);
  });

  it.each([['', 'empty'], ['   ', 'whitespace']])(
    'continues a zero-argument tool call whose blank (%#) arguments string is echoed as {}',
    async (blank, tag) => {
      const input = [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: `acct-blank-${tag}` });
      const first = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      });
      const socket = lastSocket();
      socket.emit('open');
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: `resp_blank_${tag}` } })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', call_id: `call_b_${tag}`, name: 'Ping', arguments: blank },
      })));
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: `resp_blank_${tag}` } })));
      await readAll(first);

      // The client-side SDK parses a blank arguments string as `{}`, so the
      // echo for a zero-argument tool (common for MCP tools) comes back as
      // `"{}"`. A raw-`""` snapshot would lose the chain with the same
      // tail-index signature as #84.
      const echoedCall = { type: 'function_call', call_id: `call_b_${tag}`, name: 'Ping', arguments: '{}' };
      const toolOutput = { type: 'function_call_output', call_id: `call_b_${tag}`, output: 'pong' };
      const second = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
      });
      const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
      expect(sent.previous_response_id).toBe(`resp_blank_${tag}`);
      expect(sent.input).toEqual([toolOutput]);
      emitTextResponse(socket, `resp_blank_${tag}_done`, 'done');
      await readAll(second);
    },
  );

  describe('mismatch diagnostics', () => {
    /** Build a head, then replay a history that diverges at the tool call's
     * argument value, and capture every debug line the transport emits. */
    async function runValueMismatch(opts: {
      accountId: string;
      headArguments?: string;
      replayItems?: (input: unknown[]) => unknown[];
    }): Promise<string[]> {
      const lines: string[] = [];
      const input = [{ role: 'user', content: [{ type: 'input_text', text: 'read it back' }] }];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, message => lines.push(message), {
        accountId: opts.accountId,
      });
      const first = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      });
      const socket = lastSocket();
      socket.emit('open');
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_dump' } })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'function_call', call_id: 'call_dump', name: 'Read',
          arguments: opts.headArguments ?? '{"path":"expected.ts"}',
        },
      })));
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_dump' } })));
      await readAll(first);

      const replay = opts.replayItems
        ? opts.replayItems(input)
        : [
            ...input,
            { type: 'function_call', call_id: 'call_dump', name: 'Read', arguments: '{"path":"actual.ts"}' },
            { type: 'function_call_output', call_id: 'call_dump', output: 'contents' },
          ];
      const second = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(replay)),
      });
      const isolated = lastSocket();
      expect(isolated).not.toBe(socket);
      isolated.emit('open');
      emitTextResponse(isolated, 'resp_dump_new', 'done');
      await readAll(second);
      return lines;
    }

    it('appends both item hashes to the mismatch summary line', async () => {
      const lines = await runValueMismatch({ accountId: 'acct-diag-hashes' });
      const summary = lines.find(line => line.includes('history mismatch starting an additional chain'));
      expect(summary).toMatch(/expected_hash=[0-9a-f]{16} actual_hash=[0-9a-f]{16}/);
    });

    it('writes no dump lines unless CLODEX_MISMATCH_DUMP=1 is set', async () => {
      const lines = await runValueMismatch({ accountId: 'acct-diag-gated' });
      expect(lines.some(line => line.includes('mismatch dump'))).toBe(false);
    });

    it('dumps both divergent items in canonical bytes when opted in', async () => {
      process.env.CLODEX_MISMATCH_DUMP = '1';
      try {
        const lines = await runValueMismatch({ accountId: 'acct-diag-dump' });
        const expectedLine = lines.find(line => line.includes('mismatch dump expected['));
        const actualLine = lines.find(line => line.includes('mismatch dump actual['));
        expect(expectedLine).toContain('expected.ts');
        expect(actualLine).toContain('actual.ts');
      } finally {
        delete process.env.CLODEX_MISMATCH_DUMP;
      }
    });

    it('caps a dump line at 2000 characters with a truncation marker', async () => {
      process.env.CLODEX_MISMATCH_DUMP = '1';
      try {
        const lines = await runValueMismatch({
          accountId: 'acct-diag-cap',
          headArguments: JSON.stringify({ path: 'expected.ts', blob: 'x'.repeat(5_000) }),
        });
        const expectedLine = lines.find(line => line.includes('mismatch dump expected['))!;
        const dumped = expectedLine.slice(expectedLine.indexOf(']: ') + 3);
        expect(dumped).toHaveLength(2_000);
        expect(dumped.endsWith(' [truncated]')).toBe(true);
      } finally {
        delete process.env.CLODEX_MISMATCH_DUMP;
      }
    });

    it('renders (absent) for a side whose history ends before the divergence', async () => {
      process.env.CLODEX_MISMATCH_DUMP = '1';
      try {
        // The client replays a truncated history (a rewind): every comparable
        // item matches, so the divergence is the head simply being longer.
        const lines = await runValueMismatch({
          accountId: 'acct-diag-absent',
          replayItems: input => input,
        });
        const expectedLine = lines.find(line => line.includes('mismatch dump expected['));
        const actualLine = lines.find(line => line.includes('mismatch dump actual['));
        expect(expectedLine).toContain('expected.ts');
        expect(actualLine).toContain('(absent)');
      } finally {
        delete process.env.CLODEX_MISMATCH_DUMP;
      }
    });
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

  it('continues when the upstream reasoning item carried an empty content array', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-empty-reasoning-content',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created', response: { id: 'resp_empty_content' },
    })));
    // The Responses API ships `content: []` on reasoning items. The SDK rebuilds
    // the echoed item from encrypted content and summary alone, so that key never
    // comes back and must not be treated as a divergence.
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1', content: [],
        summary: [{ type: 'summary_text', text: 'weighing it' }], status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{"path":"file.ts"}', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed', response: { id: 'resp_empty_content' },
    })));
    await readAll(first);

    const echoedReasoning = {
      type: 'reasoning', encrypted_content: 'enc_1',
      summary: [{ type: 'summary_text', text: 'weighing it' }],
    };
    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...input, echoedReasoning, echoedCall, toolOutput])),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_empty_content');
    expect(sent.input).toEqual([toolOutput]);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'continuation',
      continuationMatchMode: 'exact',
    });
    emitTextResponse(socket, 'resp_after_empty_content', 'done');
    await readAll(second);
  });

  // Drives one mismatch between a stored reasoning item and the item Claude echoes
  // back, returning what reached stderr and the head-decision diagnostic.
  async function runReasoningMismatch(options: {
    accountId: string;
    storedReasoning: Record<string, unknown>;
    echoedReasoning: Record<string, unknown>;
    responseId: string;
  }): Promise<{ stderr: string[]; diagnostics: ResponsesWebSocketDiagnosticEvent[] }> {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
      const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: options.accountId,
        onDiagnostic: event => diagnostics.push(event),
      });
      const first = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      });
      const socket = lastSocket();
      socket.emit('open');
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.created', response: { id: options.responseId },
      })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0, item: options.storedReasoning,
      })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 1,
        item: {
          type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
          arguments: '{"path":"file.ts"}', status: 'completed',
        },
      })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.completed', response: { id: options.responseId },
      })));
      await readAll(first);

      const echoedCall = {
        type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"file.ts"}',
      };
      const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
      const second = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload([...input, options.echoedReasoning, echoedCall, toolOutput])),
      });
      emitTextResponse(lastSocket(), `${options.responseId}_next`, 'done');
      await readAll(second);
      return { stderr, diagnostics };
    } finally {
      spy.mockRestore();
    }
  }

  const GAP_SUMMARY = [{ type: 'summary_text', text: 'weighing it' }];

  it('continues when a multi-part reasoning summary comes back holding only its final part', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'reason hard' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-multi-summary',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_multi' } })));
    // Upstream ships ONE reasoning item carrying every summary part ...
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_multi', content: [], status: 'completed',
        summary: [
          { type: 'summary_text', text: 'part one' },
          { type: 'summary_text', text: 'part two' },
          { type: 'summary_text', text: 'part three' },
        ],
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{"path":"file.ts"}', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_multi' } })));
    await readAll(first);

    // ... but Claude gets one thinking block per part and only the LAST carries
    // the signature, so the SDK drops the unsigned ones and a single reasoning
    // item comes back holding just the final summary part.
    const echoedReasoning = [{
      type: 'reasoning', encrypted_content: 'enc_multi',
      summary: [{ type: 'summary_text', text: 'part three' }],
    }];
    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...input, ...echoedReasoning, echoedCall, toolOutput])),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_multi');
    expect(sent.input).toEqual([toolOutput]);
    expect(diagnostics.at(-1)).toMatchObject({ event: 'ws_head_decision', decision: 'continuation' });
    emitTextResponse(socket, 'resp_multi_next', 'done');
    await readAll(second);
  });

  it('warns on stderr when an identical reasoning item still fails the continuation match', async () => {
    const { stderr, diagnostics } = await runReasoningMismatch({
      accountId: 'acct-reasoning-gap',
      responseId: 'resp_gap',
      // A populated `content` is exactly the case the empty-array normalization
      // deliberately does not cover, so it must be reported rather than absorbed.
      storedReasoning: {
        type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_same',
        content: [{ type: 'reasoning_text', text: 'private' }], summary: GAP_SUMMARY,
      },
      echoedReasoning: {
        type: 'reasoning', encrypted_content: 'enc_same', summary: GAP_SUMMARY,
      },
    });

    expect(stderr.join('')).toContain('identical encrypted_content');
    expect(stderr.join('')).toContain('content');
    const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
    expect(decision.decision).toBe('history_mismatch_new_head');
    expect((decision.heads as { mismatch: Record<string, unknown> }[])[0]!.mismatch)
      .toMatchObject({
        reasoningNormalizationGap: ['content'],
        // The shape record is what tells a later reader WHICH mechanism produced
        // the gap without ever storing reasoning text.
        reasoningGapShape: {
          expected: { summaryParts: 1, contentItems: 1 },
          actual: { summaryParts: 1, contentItems: 0 },
          clientReasoningRun: 1,
          storedReasoningRun: 1,
        },
      });
  });

  it('routes the reasoning-gap warning through the channel launchClaude leaves open', async () => {
    // `clodex claude` mutes process.stderr for as long as Claude Code owns the
    // terminal, so a warning written straight to it is never seen. Installing the
    // sink is what launchClaude does; the warning has to arrive there instead.
    const notices: string[] = [];
    const release = installParentNoticeSink(line => notices.push(line));
    try {
      const { stderr } = await runReasoningMismatch({
        accountId: 'acct-reasoning-gap-muted',
        responseId: 'resp_gap_muted',
        storedReasoning: {
          type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_same',
          content: [{ type: 'reasoning_text', text: 'private' }], summary: GAP_SUMMARY,
        },
        echoedReasoning: {
          type: 'reasoning', encrypted_content: 'enc_same', summary: GAP_SUMMARY,
        },
      });

      expect(notices.join('')).toContain('identical encrypted_content');
      expect(notices.every(line => line.endsWith('\n'))).toBe(true);
      // Nothing may go to the muted write while the sink is installed.
      expect(stderr.join('')).toBe('');
    } finally {
      release();
    }
  });

  it('stays silent when the reasoning items are genuinely different reasoning', async () => {
    const { stderr, diagnostics } = await runReasoningMismatch({
      accountId: 'acct-reasoning-divergent',
      responseId: 'resp_divergent',
      storedReasoning: {
        type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_stored', summary: GAP_SUMMARY,
      },
      // A different blob means a different turn — mismatching is correct here.
      echoedReasoning: {
        type: 'reasoning', encrypted_content: 'enc_other', summary: GAP_SUMMARY,
      },
    });

    expect(stderr.join('')).toBe('');
    const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
    expect((decision.heads as { mismatch: Record<string, unknown> }[])[0]!.mismatch)
      .not.toHaveProperty('reasoningNormalizationGap');
  });

  /** The mismatch record the head-decision diagnostic kept for the first head. */
  function firstHeadMismatch(diagnostics: ResponsesWebSocketDiagnosticEvent[]): Record<string, unknown> {
    const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
    return (decision.heads as { mismatch: Record<string, unknown> }[])[0]!.mismatch;
  }

  // Drives one mismatch between a stored function_call and the call Claude echoes
  // back.
  //
  // The stored call is emitted BY UPSTREAM, so it reaches the head through
  // `response.output_item.done` → `expectedAssistantItems` → `sanitizedCallArguments`
  // → `entry.expectedAssistant`. That is the only region a forked strip rule can
  // ever diverge in: a request's own `input` is stored verbatim and never
  // re-stripped, so staging the stored call there would exercise the predicate
  // while leaving the wiring — that the detector is applied over the snapshotted
  // region at all — completely unguarded.
  async function runToolArgumentMismatch(options: {
    accountId: string;
    responseId: string;
    /** What upstream emits. The snapshot applies the strip rule to it. */
    upstreamCall: Record<string, unknown>;
    /** What the client sends back on the next turn. */
    echoedCall: Record<string, unknown>;
    /** Optional upstream reasoning that the client omits on replay. */
    storedReasoning?: Record<string, unknown>;
    /** Disable diagnostics to prove warning side effects do not depend on a listener. */
    captureDiagnostics?: boolean;
    tools?: unknown[];
    /** Tools declared on the SECOND turn, when they differ from the first. */
    replayTools?: unknown[];
  }): Promise<{
    stderr: string[];
    trace: string[];
    diagnostics: ResponsesWebSocketDiagnosticEvent[];
  }> {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
      const trace: string[] = [];
      const input = [{ role: 'user', content: [{ type: 'input_text', text: 'search it' }] }];
      const headExtra = options.tools ? { tools: options.tools } : {};
      const replayExtra = options.replayTools ? { tools: options.replayTools } : headExtra;
      const wsFetch = createResponsesWebSocketFetch(WS_URL, message => trace.push(message), {
        accountId: options.accountId,
        ...(options.captureDiagnostics === false
          ? {}
          : { onDiagnostic: (event: ResponsesWebSocketDiagnosticEvent) => diagnostics.push(event) }),
      });
      const first = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input, headExtra)),
      });
      const socket = lastSocket();
      socket.emit('open');
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.created', response: { id: options.responseId },
      })));
      if (options.storedReasoning) {
        socket.emit('message', Buffer.from(JSON.stringify({
          type: 'response.output_item.done', output_index: 0, item: options.storedReasoning,
        })));
      }
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done',
        output_index: options.storedReasoning ? 1 : 0,
        item: options.upstreamCall,
      })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.completed', response: { id: options.responseId },
      })));
      await readAll(first);

      const output = {
        type: 'function_call_output', call_id: options.echoedCall.call_id, output: 'hits',
      };
      const second = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload([...input, options.echoedCall, output], replayExtra)),
      });
      emitTextResponse(lastSocket(), `${options.responseId}_next`, 'done');
      await readAll(second);
      return { stderr, trace, diagnostics };
    } finally {
      spy.mockRestore();
    }
  }

  /** Upstream call the snapshot strips nothing from, plus the echo that carries filler. */
  const FORKED_STRIP = {
    upstreamCall: {
      type: 'function_call', id: 'fc_1', call_id: 'call_g', name: 'Grep',
      arguments: '{"pattern":"x"}', status: 'completed',
    },
    // The strip rule is the only thing that removes a null-valued key on the way
    // to the client, so an echo that still carries one means the head and the
    // client no longer agree about that rule.
    echoedCall: {
      type: 'function_call', call_id: 'call_g', name: 'Grep', arguments: '{"pattern":"x","glob":null}',
    },
  };

  it('warns on stderr when the filler-strip rule has forked', async () => {
    const { stderr, diagnostics } = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-forked',
      responseId: 'resp_tool_gap',
      ...FORKED_STRIP,
    });

    expect(stderr.join('')).toContain('filler-strip rule is applied');
    expect(stderr.join('')).toContain('Grep');
    // The warning reports what was observed. `equalAfterStrip` cannot tell which
    // side stopped applying the rule, so it must not name a cause as certain.
    expect(stderr.join('')).toContain('the head should have matched');
    expect(stderr.join('')).not.toContain('#84');
    const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
    expect(decision.decision).toBe('history_mismatch_new_head');
    expect(firstHeadMismatch(diagnostics))
      .toMatchObject({ toolArgumentNormalizationGap: { tool: 'Grep', equalAfterStrip: true } });
  });

  it('routes the tool-argument canary through the channel launchClaude leaves open', async () => {
    // The regression detector for issue #84 is worthless if it only prints on a
    // path `clodex claude` never takes: with the child holding the terminal, the
    // warning must arrive on the notice channel, not the muted stderr.
    const notices: string[] = [];
    const release = installParentNoticeSink(line => notices.push(line));
    try {
      const { stderr } = await runToolArgumentMismatch({
        accountId: 'acct-tool-gap-muted',
        responseId: 'resp_tool_gap_muted',
        ...FORKED_STRIP,
      });

      expect(notices.join('')).toContain('filler-strip rule is applied');
      expect(notices.join('')).toContain('Grep');
      expect(notices.every(line => line.endsWith('\n'))).toBe(true);
      expect(stderr.join('')).toBe('');
    } finally {
      release();
    }
  });

  it('reports a repeated tool-argument gap once rather than on every turn', async () => {
    const first = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-repeat-1', responseId: 'resp_tool_repeat_1', ...FORKED_STRIP,
    });
    const second = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-repeat-2', responseId: 'resp_tool_repeat_2', ...FORKED_STRIP,
    });

    // Dedup is the only thing bounding this: the cap counts distinct signatures,
    // so without it one forked tool would print on every turn, forever, into the
    // terminal Claude Code's UI owns.
    expect(first.stderr.join('')).toContain('filler-strip rule is applied');
    expect(second.stderr.join('')).toBe('');
  });

  it('records but does not warn when the arguments differ beyond filler', async () => {
    const { stderr, trace, diagnostics } = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-value',
      responseId: 'resp_tool_value',
      // A real value change under the same call_id is indistinguishable from a
      // client that genuinely re-sent something else, so stderr must stay quiet.
      upstreamCall: {
        type: 'function_call', id: 'fc_1', call_id: 'call_g', name: 'Grep',
        arguments: '{"pattern":"x"}', status: 'completed',
      },
      echoedCall: {
        type: 'function_call', call_id: 'call_g', name: 'Grep', arguments: '{"pattern":"y"}',
      },
    });

    expect(stderr.join('')).toBe('');
    // Silent on stderr, but --trace alone must still show the counted gap: a
    // diagnostic nobody can reach without a second opt-in is how #84 hid.
    expect(trace.join('\n')).toContain('tool argument mismatch beyond the strip rule: Grep');
    expect(firstHeadMismatch(diagnostics))
      .toMatchObject({ toolArgumentNormalizationGap: { tool: 'Grep', equalAfterStrip: false } });
  });

  it('stays silent when the divergence is somewhere other than the arguments', async () => {
    const { stderr, diagnostics } = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-other-field',
      responseId: 'resp_tool_other_field',
      // `namespace` stands in for any item field upstream may attach that the
      // echo does not carry back. The arguments are byte-identical, so the strip
      // rule is provably not what diverged and claiming it did would be a lie
      // told in the one warning whose value depends on being believed.
      upstreamCall: {
        type: 'function_call', id: 'fc_1', call_id: 'call_g', name: 'Grep',
        arguments: '{"pattern":"x"}', namespace: 'mcp__server', status: 'completed',
      },
      echoedCall: {
        type: 'function_call', call_id: 'call_g', name: 'Grep', arguments: '{"pattern":"x"}',
      },
    });

    expect(stderr.join('')).toBe('');
    expect(firstHeadMismatch(diagnostics))
      .toMatchObject({ toolArgumentNormalizationGap: { tool: 'Grep', equalAfterStrip: false } });
  });

  it('respects the tool schema when deciding the rule forked', async () => {
    const tools = [{
      type: 'function', name: 'Grep',
      parameters: { type: 'object', properties: { matches: { type: 'array' } }, required: ['matches'] },
    }];
    const { stderr, diagnostics } = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-required',
      responseId: 'resp_tool_required',
      // `matches` is REQUIRED, so the snapshot keeps its empty array — it is an
      // intentional value, not filler. An echo that dropped it is a real
      // difference the strip rule does not explain.
      tools,
      upstreamCall: {
        type: 'function_call', id: 'fc_1', call_id: 'call_g', name: 'Grep',
        arguments: '{"matches":[]}', status: 'completed',
      },
      echoedCall: { type: 'function_call', call_id: 'call_g', name: 'Grep', arguments: '{}' },
    });

    expect(stderr.join('')).toBe('');
    expect(firstHeadMismatch(diagnostics))
      .toMatchObject({ toolArgumentNormalizationGap: { equalAfterStrip: false } });
  });

  it('judges the gap by the schema the head was snapshotted under', async () => {
    const { stderr, diagnostics } = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-schema-drift',
      responseId: 'resp_tool_schema_drift',
      // The head was stripped when `glob` was optional, so its empty array was
      // filler and the snapshot dropped it. The echo still carries it: a real
      // fork. The second turn marks `glob` required — an MCP server or subagent
      // changing the tool list mid-session — which must not be allowed to
      // re-judge what the head was already stripped under and silence the gap.
      tools: [{
        type: 'function', name: 'Grep',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, glob: { type: 'array' } },
          required: ['pattern'],
        },
      }],
      replayTools: [{
        type: 'function', name: 'Grep',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, glob: { type: 'array' } },
          required: ['pattern', 'glob'],
        },
      }],
      upstreamCall: {
        type: 'function_call', id: 'fc_1', call_id: 'call_g', name: 'Grep',
        arguments: '{"pattern":"x","glob":[]}', status: 'completed',
      },
      echoedCall: {
        type: 'function_call', call_id: 'call_g', name: 'Grep', arguments: '{"pattern":"x","glob":[]}',
      },
    });

    expect(stderr.join('')).toContain('filler-strip rule is applied');
    expect(firstHeadMismatch(diagnostics))
      .toMatchObject({ toolArgumentNormalizationGap: { tool: 'Grep', equalAfterStrip: true } });
  });

  it('still catches a forked rule when Claude omits the stored reasoning item', async () => {
    const storedReasoning = {
      type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_o', summary: [], status: 'completed',
    };
    // Both items are emitted by upstream into expectedAssistant. The replay omits
    // reasoning, so omitted-reasoning alignment must re-aim the detector at the call.
    const { stderr, trace, diagnostics } = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-omitted',
      responseId: 'resp_omit',
      storedReasoning,
      ...FORKED_STRIP,
    });

    expect(stderr.join('')).toContain('filler-strip rule');
    const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
    expect(decision.decision).toBe('history_mismatch_new_head');
    expect((decision.heads as { mismatch: Record<string, unknown> }[])[0]!.mismatch)
      .toMatchObject({ toolArgumentNormalizationGap: { tool: 'Grep', equalAfterStrip: true } });
    // diagnosticEntry is evaluated once before continuationMismatchSummary;
    // formatting the summary and heads must not duplicate its pre-dedup trace side effect.
    expect(trace.filter(line => line.includes('tool argument normalization gap: Grep:filler')))
      .toHaveLength(1);

    resetToolArgumentGapWarningsForTests();
    const withoutListener = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-omitted-no-listener',
      responseId: 'resp_omit_no_listener',
      storedReasoning,
      captureDiagnostics: false,
      ...FORKED_STRIP,
    });
    expect(withoutListener.diagnostics).toEqual([]);
    expect(withoutListener.stderr.join('')).toContain('filler-strip rule');
  });

  it('warns for a gap on an older head even when a newer head mismatches ordinarily', async () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      async function runScenario(
        suffix: string,
        captureDiagnostics: boolean,
      ): Promise<ResponsesWebSocketDiagnosticEvent[]> {
        const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
        const user = { role: 'user', content: [{ type: 'input_text', text: 'search it' }] };
        const gapOut = { type: 'function_call_output', call_id: 'call_g', output: 'hits' };
        let clock = 1_000_000;
        const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
          accountId: `acct-tool-gap-multi-${suffix}`,
          now: () => (clock += 1),
          ...(captureDiagnostics ? { onDiagnostic: (event: ResponsesWebSocketDiagnosticEvent) => {
            diagnostics.push(event);
          } } : {}),
        });
        // Older head: upstream emits the call into expectedAssistant, where the
        // snapshot strip rule is applied.
        const first = await wsFetch('https://x', {
          method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([user])),
        });
        const firstSocket = lastSocket();
        firstSocket.emit('open');
        firstSocket.emit('message', Buffer.from(JSON.stringify({
          type: 'response.created', response: { id: `resp_multi_a_${suffix}` },
        })));
        firstSocket.emit('message', Buffer.from(JSON.stringify({
          type: 'response.output_item.done', output_index: 0, item: FORKED_STRIP.upstreamCall,
        })));
        firstSocket.emit('message', Buffer.from(JSON.stringify({
          type: 'response.completed', response: { id: `resp_multi_a_${suffix}` },
        })));
        await readAll(first);

        // Newer head: an unrelated conversation with a distinct prompt snapshot.
        const second = await wsFetch('https://x', {
          method: 'POST', headers: {},
          body: JSON.stringify(sessionPayload(
            [{ role: 'user', content: [{ type: 'input_text', text: 'something else' }] }],
            { instructions: 'You are a newer coding assistant.' },
          )),
        });
        lastSocket().emit('open');
        emitTextResponse(lastSocket(), `resp_multi_b_${suffix}`, 'ok');
        await readAll(second);

        // Replay echoes the older head's filler-bearing call. Warning only for the
        // newer diagnostic entry would let this regression go silent.
        const third = await wsFetch('https://x', {
          method: 'POST', headers: {},
          body: JSON.stringify(sessionPayload([
            user,
            FORKED_STRIP.echoedCall,
            gapOut,
            { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
          ])),
        });
        emitTextResponse(lastSocket(), `resp_multi_c_${suffix}`, 'done');
        await readAll(third);
        return diagnostics;
      }

      const diagnostics = await runScenario('diagnostics', true);
      expect(stderr.join('')).toContain('filler-strip rule');
      const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
      expect(decision.decision).toBe('history_mismatch_new_head');
      // The distinct prompt snapshot proves the newer head became diagnosticEntry.
      expect(decision.promptChanges).toEqual(['instructions']);
      const heads = decision.heads as { idleMs: number }[];
      expect(heads[0]!.idleMs).toBeGreaterThan(heads[1]!.idleMs);

      resetToolArgumentGapWarningsForTests();
      stderr.length = 0;
      const withoutListener = await runScenario('no-listener', false);
      expect(withoutListener).toEqual([]);
      expect(stderr.join('')).toContain('filler-strip rule');
    } finally {
      spy.mockRestore();
    }
  });

  it('warns for a reasoning gap on an older head when a newer head mismatches ordinarily', async () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
      const user = { role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] };
      const echoedReasoning = {
        type: 'reasoning', encrypted_content: 'enc_multi_gap', summary: GAP_SUMMARY,
      };
      const echoedCall = {
        type: 'function_call', call_id: 'call_multi_gap', name: 'Read', arguments: '{"path":"a.ts"}',
      };
      const output = {
        type: 'function_call_output', call_id: 'call_multi_gap', output: 'contents',
      };
      let clock = 1_000_000;
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: 'acct-reasoning-gap-multi',
        now: () => (clock += 1),
        onDiagnostic: event => diagnostics.push(event),
      });

      // Older head: upstream stages the reasoning item in expectedAssistant.
      const first = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([user])),
      });
      const firstSocket = lastSocket();
      firstSocket.emit('open');
      firstSocket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.created', response: { id: 'resp_reasoning_multi_a' },
      })));
      firstSocket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'reasoning', id: 'rs_multi_gap', encrypted_content: 'enc_multi_gap',
          content: [{ type: 'reasoning_text', text: 'private' }], summary: GAP_SUMMARY,
        },
      })));
      firstSocket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 1,
        item: {
          type: 'function_call', id: 'fc_multi_gap', call_id: 'call_multi_gap', name: 'Read',
          arguments: '{"path":"a.ts"}', status: 'completed',
        },
      })));
      firstSocket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.completed', response: { id: 'resp_reasoning_multi_a' },
      })));
      await readAll(first);

      // Newer head mismatches ordinarily and must become diagnosticEntry.
      const second = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload(
          [{ role: 'user', content: [{ type: 'input_text', text: 'something else' }] }],
          { instructions: 'You are a newer coding assistant.' },
        )),
      });
      lastSocket().emit('open');
      emitTextResponse(lastSocket(), 'resp_reasoning_multi_b', 'ok');
      await readAll(second);

      // Same encrypted blob but unequal content is the reasoning detector's gap shape.
      const third = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload([
          user,
          echoedReasoning,
          echoedCall,
          output,
          { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
        ])),
      });
      emitTextResponse(lastSocket(), 'resp_reasoning_multi_c', 'done');
      await readAll(third);

      expect(stderr.join('')).toContain('identical encrypted_content');
      expect(stderr.join('')).not.toContain('filler-strip rule');
      const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
      expect(decision.decision).toBe('history_mismatch_new_head');
      expect(decision.promptChanges).toEqual(['instructions']);
      const heads = decision.heads as { idleMs: number }[];
      expect(heads[0]!.idleMs).toBeGreaterThan(heads[1]!.idleMs);
    } finally {
      spy.mockRestore();
    }
  });

  it('stays silent when a different call_id makes it a genuine branch', async () => {
    const { stderr, diagnostics } = await runToolArgumentMismatch({
      accountId: 'acct-tool-gap-branch',
      responseId: 'resp_branch',
      upstreamCall: {
        type: 'function_call', id: 'fc_1', call_id: 'call_g', name: 'Grep',
        arguments: '{"pattern":"x"}', status: 'completed',
      },
      // A regenerated call carries a NEW call_id — that is a branch, not our bug.
      echoedCall: {
        type: 'function_call', call_id: 'call_h', name: 'Grep', arguments: '{"pattern":"x","glob":null}',
      },
    });

    expect(stderr.join('')).toBe('');
    expect(firstHeadMismatch(diagnostics)).not.toHaveProperty('toolArgumentNormalizationGap');
  });

  it('does not warn about a tool gap on a head that lost to a better match', async () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
      const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: 'acct-tool-gap-not-selected',
        onDiagnostic: event => diagnostics.push(event),
      });

      const first = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      });
      const socket1 = lastSocket();
      socket1.emit('open');
      socket1.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_t1' } })));
      socket1.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
          arguments: '{"path":"a.ts"}', status: 'completed',
        },
      })));
      socket1.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_t1' } })));
      await readAll(first);

      // The echo carries filler the head does not, so head 1 cannot match and
      // this turn legitimately warns while opening head 2.
      const call1 = {
        type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a.ts","offset":null}',
      };
      const out1 = { type: 'function_call_output', call_id: 'call_1', output: 'a' };
      const turn2 = [...input, call1, out1];
      const second = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn2)),
      });
      const socket2 = lastSocket();
      socket2.emit('open');
      socket2.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_t2' } })));
      socket2.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Read',
          arguments: '{"path":"b.ts"}', status: 'completed',
        },
      })));
      socket2.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_t2' } })));
      await readAll(second);
      expect(stderr.join('')).toContain('filler-strip rule is applied');

      // Clear the dedupe so a stray warning on this next turn would be visible.
      resetToolArgumentGapWarningsForTests();
      stderr.length = 0;

      const call2 = { type: 'function_call', call_id: 'call_2', name: 'Read', arguments: '{"path":"b.ts"}' };
      const out2 = { type: 'function_call_output', call_id: 'call_2', output: 'b' };
      const third = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...turn2, call2, out2])),
      });

      const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
      expect(decision.decision).toBe('continuation');
      // Head 1 still carries the gap in the diagnostic record ...
      expect((decision.heads as { mismatch: Record<string, unknown> }[])
        .some(head => head.mismatch.toolArgumentNormalizationGap !== undefined)).toBe(true);
      // ... but this turn continued, so nothing was degraded and the terminal
      // must stay quiet.
      expect(stderr.join('')).toBe('');
      emitTextResponse(lastSocket(), 'resp_t2_next', 'done');
      await readAll(third);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not warn about a gap on a head that lost to a better match', async () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
      const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: 'acct-gap-not-selected',
        onDiagnostic: event => diagnostics.push(event),
      });

      // Head 1 snapshots a reasoning item carrying content the echo will not repeat.
      const first = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      });
      const socket1 = lastSocket();
      socket1.emit('open');
      socket1.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_h1' } })));
      socket1.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1',
          content: [{ type: 'reasoning_text', text: 'private' }], summary: GAP_SUMMARY,
        },
      })));
      socket1.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 1,
        item: {
          type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
          arguments: '{"path":"a.ts"}', status: 'completed',
        },
      })));
      socket1.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_h1' } })));
      await readAll(first);

      const echo1 = { type: 'reasoning', encrypted_content: 'enc_1', summary: GAP_SUMMARY };
      const call1 = { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a.ts"}' };
      const out1 = { type: 'function_call_output', call_id: 'call_1', output: 'a' };
      const turn2 = [...input, echo1, call1, out1];

      // Head 1 cannot match, so this opens head 2 — and legitimately warns.
      const second = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(turn2)),
      });
      const socket2 = lastSocket();
      socket2.emit('open');
      socket2.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_h2' } })));
      socket2.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Read',
          arguments: '{"path":"b.ts"}', status: 'completed',
        },
      })));
      socket2.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_h2' } })));
      await readAll(second);
      expect(stderr.join('')).toContain('identical encrypted_content');

      // Clear the dedupe so a stray warning on this next turn would be visible.
      resetReasoningGapWarningsForTests();
      resetToolArgumentGapWarningsForTests();
      stderr.length = 0;

      const call2 = { type: 'function_call', call_id: 'call_2', name: 'Read', arguments: '{"path":"b.ts"}' };
      const out2 = { type: 'function_call_output', call_id: 'call_2', output: 'b' };
      const third = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...turn2, call2, out2])),
      });

      const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!;
      expect(decision.decision).toBe('continuation');
      // Head 1 still carries the gap in the diagnostic record ...
      expect((decision.heads as { mismatch: Record<string, unknown> }[])
        .some(head => head.mismatch.reasoningNormalizationGap !== undefined)).toBe(true);
      // ... but nothing was lost, so the terminal stays quiet.
      expect(stderr.join('')).toBe('');
      emitTextResponse(lastSocket(), 'resp_h2_next', 'done');
      await readAll(third);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a repeated reasoning gap once rather than on every turn', async () => {
    const storedReasoning = {
      type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_same',
      content: [{ type: 'reasoning_text', text: 'private' }], summary: GAP_SUMMARY,
    };
    const echoedReasoning = {
      type: 'reasoning', encrypted_content: 'enc_same', summary: GAP_SUMMARY,
    };
    const first = await runReasoningMismatch({
      accountId: 'acct-reasoning-repeat-1', responseId: 'resp_r1', storedReasoning, echoedReasoning,
    });
    const second = await runReasoningMismatch({
      accountId: 'acct-reasoning-repeat-2', responseId: 'resp_r2', storedReasoning, echoedReasoning,
    });

    expect(first.stderr.join('')).toContain('identical encrypted_content');
    expect(second.stderr.join('')).toBe('');
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

  it('does not report transport exhaustion for a continuation retry', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-retry-transport-diagnostics',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_old', 'answer');
    await readAll(first);

    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
      ])),
    });
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));
    const replacement = lastSocket();
    replacement.emit('close', 1006, Buffer.from(''));

    expect(await readAll(second)).toContain('websocket_transport_error');
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'exhausted',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      source: 'socket_close',
      frameCount: 1,
    }));
  });

  it('still logs a retried rejection, which no error_frame record covers', async () => {
    // The retry frame carries a 400, so the rejection branch would claim it if
    // the willRetry arm of the diagnostic gate were dropped — and because the
    // retry returns before that branch, the failure would then be logged
    // NOWHERE. This pins the arm that prevents it.
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-retry-diag',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_old', 'answer');
    await readAll(first);

    const second = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
      ])),
    });
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_recovered', 'recovered');
    await readAll(second);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      source: 'response_event',
      errorCode: 'previous_response_not_found',
      willRetry: true,
    }));
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

  // Both pools are process-wide, so a subagent-heavy workload can need more than
  // the defaults. Drives the nursery cap because it is the cheaper one to fill.
  async function fillTwoNurseryHeads(accountId: string): Promise<ResponsesWebSocketDiagnosticEvent[]> {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId,
      onDiagnostic: event => diagnostics.push(event),
    });
    for (const root of ['root one', 'root two']) {
      const response = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload([{ role: 'user', content: [{ type: 'input_text', text: root }] }])),
      });
      const socket = lastSocket();
      socket.emit('open');
      emitTextResponse(socket, `resp_${root.replace(' ', '_')}`, 'ok');
      await readAll(response);
    }
    return diagnostics;
  }

  const lastEvictions = (diagnostics: ResponsesWebSocketDiagnosticEvent[]) =>
    (diagnostics.filter(event => event.event === 'ws_head_decision').at(-1)!.evictions ?? []) as
      Record<string, unknown>[];

  it('honors CLODEX_WS_MAX_NURSERY_CONNECTIONS', async () => {
    process.env.CLODEX_WS_MAX_NURSERY_CONNECTIONS = '1';
    try {
      expect(lastEvictions(await fillTwoNurseryHeads('acct-env-nursery-cap')))
        .toMatchObject([{ reason: 'nursery_lru_cap' }]);
    } finally {
      delete process.env.CLODEX_WS_MAX_NURSERY_CONNECTIONS;
    }
  });

  it('ignores a malformed connection cap rather than reinterpreting it', async () => {
    process.env.CLODEX_WS_MAX_NURSERY_CONNECTIONS = 'lots';
    try {
      // Falls back to the default of 8, so two heads coexist without eviction.
      expect(lastEvictions(await fillTwoNurseryHeads('acct-env-nursery-bad'))).toEqual([]);
    } finally {
      delete process.env.CLODEX_WS_MAX_NURSERY_CONNECTIONS;
    }
  });

  it('lets an explicit option outrank the environment', async () => {
    process.env.CLODEX_WS_MAX_NURSERY_CONNECTIONS = '1';
    try {
      const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: 'acct-env-nursery-override',
        maxNurseryConnections: 8,
        onDiagnostic: event => diagnostics.push(event),
      });
      for (const root of ['root one', 'root two']) {
        const response = await wsFetch('https://x', {
          method: 'POST', headers: {},
          body: JSON.stringify(sessionPayload([{ role: 'user', content: [{ type: 'input_text', text: root }] }])),
        });
        const socket = lastSocket();
        socket.emit('open');
        emitTextResponse(socket, `resp_ovr_${root.replace(' ', '_')}`, 'ok');
        await readAll(response);
      }
      expect(lastEvictions(diagnostics)).toEqual([]);
    } finally {
      delete process.env.CLODEX_WS_MAX_NURSERY_CONNECTIONS;
    }
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

describe('new-connection pacing', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
  });

  /** Records every admission request; production shares one process-wide pacer. */
  function recordingPacer(admission: UpgradeAdmission = { kind: 'admitted', waitedMs: 0 }) {
    return { admit: vi.fn(async () => admission) };
  }

  it('never asks the pacer for a request that reuses an existing connection', async () => {
    const pacer = recordingPacer();
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-pacing-reuse',
      pacer,
      onDiagnostic: event => diagnostics.push(event),
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'first turn' }] }];

    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created', response: { id: 'resp_pace_1' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{"path":"file.ts"}', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed', response: { id: 'resp_pace_1' },
    })));
    await readAll(first);
    expect(pacer.admit).toHaveBeenCalledTimes(1);

    // Second turn continues the same head: no new connection, so no pacing.
    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
    });
    expect(fakeSockets).toHaveLength(1);
    expect(diagnostics.at(-1)).toMatchObject({ event: 'ws_head_decision', decision: 'continuation' });
    expect(pacer.admit).toHaveBeenCalledTimes(1);
    emitTextResponse(socket, 'resp_pace_2', 'done');
    await readAll(second);
    expect(pacer.admit).toHaveBeenCalledTimes(1);
  });

  it('asks the pacer for each primary connection it opens', async () => {
    const pacer = recordingPacer();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-pacing-open',
      pacer,
    });
    // Two unrelated conversations: each needs its own head.
    for (const text of ['alpha', 'beta']) {
      const response = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload(
          [{ role: 'user', content: [{ type: 'input_text', text }] }],
          { prompt_cache_key: `relay-session-${text}` },
        )),
      });
      const socket = lastSocket();
      socket.emit('open');
      emitTextResponse(socket, `resp_${text}`, 'ok');
      await readAll(response);
    }
    expect(fakeSockets).toHaveLength(2);
    expect(pacer.admit).toHaveBeenCalledTimes(2);
  });

  it('records how long a delayed connection waited, on both diagnostics', async () => {
    const debug: string[] = [];
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, message => debug.push(message), {
      accountId: 'acct-pacing-delay',
      pacer: recordingPacer({ kind: 'admitted', waitedMs: 2_500 }),
      onDiagnostic: event => diagnostics.push(event),
    });

    const response = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-paced' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_paced', 'ok');
    await readAll(response);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_new_connection_paced',
      outcome: 'admitted',
      waitedMs: 2_500,
      requestId: 'req-paced',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_head_decision',
      pacingWaitedMs: 2_500,
    }));
    expect(debug).toContain('ws: paced new connection by 2500ms');
  });

  it('refuses without opening a socket, in a shape that classifies as a retryable 429', async () => {
    const debug: string[] = [];
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, message => debug.push(message), {
      accountId: 'acct-pacing-refused',
      pacer: recordingPacer({ kind: 'refused', requiredWaitMs: 7_400, retryAfterSeconds: 8 }),
      onDiagnostic: event => diagnostics.push(event),
    });

    const response = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });

    // The whole point: the connection this would have opened is not opened.
    expect(fakeSockets).toHaveLength(0);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    // A real header, not only the prose: the SDK's backoff reads headers and
    // ignores the body. It does not de-correlate a fan-out — everyone refused at
    // the same instant gets the same hint — it defers the group long enough for
    // the bucket to refill.
    expect(response.headers.get('retry-after')).toBe('8');

    // A refusal happens before any connection or request context exists, so it
    // cannot go through failContext. Prove the standalone frame still CLASSIFIES
    // downstream as a retryable rate limit carrying the backoff hint — the same
    // classification the real upgrade 403 gets. `classifyThroughSdk` runs with
    // maxRetries: 0, so this pins the classification, not the retrying; the
    // 403 test above is what exercises an actual SDK retry.
    const body = await readAll(response);
    // The frame itself, matching the shape failContext writes for a 403.
    expect(JSON.parse(body.replace(/^data: /, '').trim())).toMatchObject({
      type: 'error',
      error: { type: 'rate_limit_error', code: '429', retry_after_seconds: 8 },
    });
    // And through the real provider. Note the hint survives via the PROSE: the
    // SDK's chunk schema strips `retry_after_seconds`, so the frame field alone
    // would not reach the client.
    expect(await classifyThroughSdk(body)).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      retryAfterSeconds: 8,
    });

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_new_connection_paced',
      outcome: 'refused',
      requiredWaitMs: 7_400,
      retryAfterSeconds: 8,
    }));
    expect(diagnostics.some(event => event.event === 'ws_head_decision')).toBe(false);
    expect(debug).toContain(
      'ws: refused a new connection to hold the pacing rate; retry after 8s',
    );
  });

  it('does not open a second persistent head for a partition that filled up during the wait', async () => {
    // The head scan runs before the wait. A same-partition request that starts
    // while this one is queued would otherwise leave BOTH registering
    // persistent nursery heads for one key, filling the nursery with
    // duplicates and evicting other conversations' reusable heads.
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    let releaseQueued: (() => void) | undefined;
    const queued = new Promise<void>(resolve => { releaseQueued = resolve; });
    let markQueued: (() => void) | undefined;
    const isQueued = new Promise<void>(resolve => { markQueued = resolve; });
    let admissions = 0;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-pacing-overlap',
      pacer: {
        admit: async (): Promise<UpgradeAdmission> => {
          admissions += 1;
          if (admissions > 1) return { kind: 'admitted', waitedMs: 0 };
          markQueued!();
          await queued;
          return { kind: 'admitted', waitedMs: 25 };
        },
      },
      onDiagnostic: event => diagnostics.push(event),
    });
    const body = (text: string) => JSON.stringify(sessionPayload(
      [{ role: 'user', content: [{ type: 'input_text', text }] }],
    ));

    // Classified with an empty partition, then held inside the pacer.
    const held = wsFetch('https://x', { method: 'POST', headers: {}, body: body('held') });
    await isQueued;

    // A second request for the same partition gets in and goes in flight.
    const overtaking = await wsFetch('https://x', { method: 'POST', headers: {}, body: body('overtaking') });
    lastSocket().emit('open');

    releaseQueued!();
    const heldResponse = await held;

    const decisions = diagnostics.filter(event => event.event === 'ws_head_decision');
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({
      decision: 'parallel_isolated',
      createdGeneration: 'isolated',
      pacingWaitedMs: 25,
    });

    for (const socket of fakeSockets) socket.emit('open');
    emitTextResponse(fakeSockets[1]!, 'resp_held', 'ok');
    emitTextResponse(fakeSockets[0]!, 'resp_overtaking', 'ok');
    await readAll(heldResponse);
    await readAll(overtaking);
  });

  it('asks the pacer for every shape of primary new connection', async () => {
    // Four shapes reach the creation path. The parallel one dominates real
    // traffic (2,844 of 2,987 observed upgrades), so none of them may be left
    // on prose.
    const pacer = recordingPacer();
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-pacing-shapes',
      pacer,
      onDiagnostic: event => diagnostics.push(event),
    });
    const lastDecision = () => diagnostics.filter(event => event.event === 'ws_head_decision').at(-1);
    const send = (payload: unknown) => wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(payload),
    });
    const turn = (text: string) => [{ role: 'user', content: [{ type: 'input_text', text }] }];

    // 1. unpartitioned_socket — no prompt_cache_key, so there is no partition.
    const unpartitioned = await send({ model: 'gpt-5.6-sol', input: turn('no session') });
    lastSocket().emit('open');
    emitTextResponse(lastSocket(), 'resp_unpartitioned', 'ok');
    await readAll(unpartitioned);
    expect(lastDecision()).toMatchObject({ decision: 'unpartitioned_socket' });
    expect(pacer.admit).toHaveBeenCalledTimes(1);

    // 2. new_partition_head — first turn of a session.
    const root = await send(sessionPayload(turn('root')));
    lastSocket().emit('open');
    emitTextResponse(lastSocket(), 'resp_root', 'ok');
    await readAll(root);
    expect(lastDecision()).toMatchObject({ decision: 'new_partition_head' });
    expect(pacer.admit).toHaveBeenCalledTimes(2);

    // 3. history_mismatch_new_head — same partition, divergent history.
    const diverged = await send(sessionPayload(turn('a different root')));
    expect(lastDecision()).toMatchObject({ decision: 'history_mismatch_new_head' });
    expect(pacer.admit).toHaveBeenCalledTimes(3);

    // 4. parallel_isolated — same partition while that one is still in flight.
    const parallel = await send(sessionPayload(turn('a third root')));
    expect(lastDecision()).toMatchObject({ decision: 'parallel_isolated' });
    expect(pacer.admit).toHaveBeenCalledTimes(4);

    for (const socket of fakeSockets) if (socket.listenerCount('open') > 0) socket.emit('open');
    emitTextResponse(fakeSockets[2]!, 'resp_diverged', 'ok');
    emitTextResponse(fakeSockets[3]!, 'resp_parallel', 'ok');
    await readAll(diverged);
    await readAll(parallel);
  });

  it('does not pace the replacement a transport retry opens', async () => {
    // Deliberate exemption: it recovers a request that was already admitted,
    // it is capped at one per request, and it is built inside a socket
    // callback. Pinned so the exemption cannot drift into an accident.
    const pacer = recordingPacer();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-pacing-transport-replacement',
      pacer,
    });
    const response = await wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])),
    });
    fakeSockets[0]!.emit('open');
    fakeSockets[0]!.emit('error', new Error('connection reset'));

    expect(fakeSockets).toHaveLength(2);
    expect(pacer.admit).toHaveBeenCalledTimes(1);

    fakeSockets[1]!.emit('open');
    emitTextResponse(fakeSockets[1]!, 'resp_replaced', 'ok');
    await readAll(response);
  });

  it('does not pace the replacement a missing previous response opens', async () => {
    // The second unpaced replacement path, and the one the deep doc used to
    // omit entirely.
    const pacer = recordingPacer();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-pacing-prev-missing',
      pacer,
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    fakeSockets[0]!.emit('open');
    emitTextResponse(fakeSockets[0]!, 'resp_prev_1', 'ok');
    await readAll(first);
    expect(pacer.admit).toHaveBeenCalledTimes(1);

    const echoed = [
      ...input,
      { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(echoed)),
    });
    const continued = fakeSockets.length;
    fakeSockets[0]!.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));

    // A replacement socket was opened without consulting the pacer.
    expect(fakeSockets.length).toBeGreaterThan(continued);
    expect(pacer.admit).toHaveBeenCalledTimes(1);

    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_prev_2', 'ok');
    await readAll(second);
  });

  it('demotes a concurrent sibling even when neither request waited', async () => {
    // `admit` is async, so even an immediate admission resumes a microtask
    // later and BOTH requests classify themselves against an empty partition
    // before either registers. Gating the re-check on having waited would let
    // both open a persistent head for one key.
    //
    // The barrier holds both inside the pacer until both have been classified,
    // which is the interleaving that makes this deterministic rather than a
    // race the scheduler happens to win.
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    let admitted = 0;
    let barrierArmed = false;
    let openBarrier: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => { openBarrier = resolve; });
    const debug: string[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, message => debug.push(message), {
      accountId: 'acct-pacing-concurrent',
      pacer: {
        admit: async (): Promise<UpgradeAdmission> => {
          if (!barrierArmed) return { kind: 'admitted', waitedMs: 0 };
          admitted += 1;
          if (admitted === 2) openBarrier!();
          await barrier;
          return { kind: 'admitted', waitedMs: 0 };
        },
      },
      onDiagnostic: event => diagnostics.push(event),
    });
    const send = (text: string) => wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([{ role: 'user', content: [{ type: 'input_text', text }] }])),
    });

    // Resolve the mocked `ws` module BEFORE the concurrent phase: two dynamic
    // imports of a mocked module in flight at once can race in vitest and hand
    // one caller the unmocked module.
    const warmup = await wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload(
        [{ role: 'user', content: [{ type: 'input_text', text: 'warmup' }] }],
        { prompt_cache_key: 'relay-session-warmup' },
      )),
    });
    lastSocket().emit('open');
    emitTextResponse(lastSocket(), 'resp_warmup', 'ok');
    await readAll(warmup);
    barrierArmed = true;

    const [alpha, beta] = await Promise.all([send('alpha'), send('beta')]);

    // The warmup produced a decision of its own; the pair is the last two.
    const decisions = diagnostics.filter(event => event.event === 'ws_head_decision').slice(-2);
    expect(decisions).toHaveLength(2);
    // Both were classified against an empty partition — the race is real...
    expect(decisions.map(event => event.candidateCount)).toEqual([0, 0]);
    // ...but only one of them may end up holding a persistent head for it.
    // Without the demotion both are 'nursery': two persistent heads, one key.
    expect(decisions.map(event => event.createdGeneration).sort())
      .toEqual(['isolated', 'nursery']);
    expect(debug).toContain('ws: parallel request using an isolated socket after pacing');

    for (const socket of fakeSockets.slice(-2)) {
      socket.emit('open');
      emitTextResponse(socket, `resp_${fakeSockets.indexOf(socket)}`, 'ok');
    }
    await Promise.all([readAll(alpha), readAll(beta)]);
  });

  it('ages the heads it reports from after the wait, not from arrival', async () => {
    // The decision record must not mix head ages read on arrival with pool
    // counts read after the wait; a queued request can be seconds old by then.
    let clockMs = 0;
    let waits = 0;
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-pacing-clock',
      now: () => clockMs,
      pacer: {
        admit: async (): Promise<UpgradeAdmission> => {
          waits += 1;
          if (waits === 1) return { kind: 'admitted', waitedMs: 0 };
          clockMs += 4_000;
          return { kind: 'admitted', waitedMs: 4_000 };
        },
      },
      onDiagnostic: event => diagnostics.push(event),
    });
    const body = (text: string) => JSON.stringify(sessionPayload(
      [{ role: 'user', content: [{ type: 'input_text', text }] }],
    ));

    const first = await wsFetch('https://x', { method: 'POST', headers: {}, body: body('first') });
    lastSocket().emit('open');
    emitTextResponse(lastSocket(), 'resp_clock', 'ok');
    await readAll(first);

    // Same partition, different history: an idle head is reported, not reused.
    const second = await wsFetch('https://x', { method: 'POST', headers: {}, body: body('second') });
    const decision = diagnostics.filter(event => event.event === 'ws_head_decision').at(-1);
    expect(decision).toMatchObject({ pacingWaitedMs: 4_000 });
    // Read on arrival this head looks freshly used; it is 4s idle by admission.
    expect((decision as { heads: Array<{ idleMs: number }> }).heads[0]!.idleMs).toBe(4_000);

    lastSocket().emit('open');
    emitTextResponse(lastSocket(), 'resp_clock_2', 'ok');
    await readAll(second);
  });

  it('uses the shared bucket and its env var when no pacer is injected', async () => {
    // Nothing here injects a pacer, so this fails if production stops
    // consulting the shared one — or stops reading the environment.
    process.env.CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN = '1';
    try {
      resetResponsesWebSocketConnectionsForTests();
      const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: 'acct-pacing-shared',
        onDiagnostic: event => diagnostics.push(event),
      });
      const open = async (text: string) => {
        const response = await wsFetch('https://x', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload(
            [{ role: 'user', content: [{ type: 'input_text', text }] }],
            { prompt_cache_key: `relay-session-${text}` },
          )),
        });
        const socket = fakeSockets[fakeSockets.length - 1];
        if (socket && socket.listenerCount('open') > 0) {
          socket.emit('open');
          emitTextResponse(socket, `resp_${text}`, 'ok');
        }
        return readAll(response);
      };

      // At one new connection per minute the burst of ten is free; the
      // eleventh needs a minute, far past the wait bound, so it is refused.
      for (let index = 0; index < 10; index += 1) await open(`burst-${index}`);
      expect(fakeSockets).toHaveLength(10);

      const refusedBody = await open('past-the-burst');
      expect(fakeSockets).toHaveLength(10);
      expect(await classifyThroughSdk(refusedBody)).toMatchObject({
        statusCode: 429,
        isRetryable: true,
      });
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: 'ws_new_connection_paced',
        outcome: 'refused',
      }));
    } finally {
      delete process.env.CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN;
      resetResponsesWebSocketConnectionsForTests();
    }
  });

  it('opens no connection for a request cancelled while it was queued', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-pacing-abort',
      pacer: { admit: vi.fn(async () => { throw aborted; }) },
      onDiagnostic: event => diagnostics.push(event),
    });

    await expect(wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    })).rejects.toBe(aborted);

    expect(fakeSockets).toHaveLength(0);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_new_connection_paced',
      outcome: 'aborted',
    }));
    // The request never reached a head decision, so none is reported.
    expect(diagnostics.some(event => event.event === 'ws_head_decision')).toBe(false);
  });
});
