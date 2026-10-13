import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Fake `ws` WebSocket that records the handshake headers each socket opened with.
const { fakeSockets } = vi.hoisted(() => ({ fakeSockets: [] as FakeWebSocket[] }));

class FakeWebSocket extends EventEmitter {
  url: string;
  options: { headers?: Record<string, string> };
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
  constructor(url: string, options: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    // Copy, as `ws` does when it builds the upgrade request: a header added to
    // the record after the socket exists never reaches the handshake.
    this.options = { ...options, headers: { ...options.headers } };
    fakeSockets.push(this);
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));

import { createLanguageModel } from '../src/provider-factory.js';
import {
  claudeSessionPromptCacheKey,
  generateAnthropicResponse,
  translateRequest,
} from '../src/sdk-adapter.js';
import {
  createResponsesWebSocketFetch,
  resetResponsesWebSocketConnectionsForTests,
  withResponsesWebSocketDiagnosticContext,
} from '../src/oauth/responses-websocket.js';

const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

function handshakeHeaders(socket: FakeWebSocket): Record<string, string> {
  return socket.options.headers ?? {};
}

function sentFrame(socket: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(socket.send.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
}

function completeTextResponse(socket: FakeWebSocket, responseId: string): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.added', output_index: 0,
    item: { type: 'message', id: `msg_${responseId}`, role: 'assistant', content: [] },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_text.delta', item_id: `msg_${responseId}`, output_index: 0, content_index: 0, delta: 'ok',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.done', output_index: 0,
    item: { type: 'message', id: `msg_${responseId}`, role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed',
    response: { id: responseId, usage: { input_tokens: 1, output_tokens: 1 } },
  })));
}

/**
 * Drive one Claude Code turn through the production path: the Anthropic body is
 * translated (which derives `prompt_cache_key` from the Claude session id), the
 * OpenAI OAuth model built by provider-factory serializes it, and the WebSocket
 * fetch opens the socket. OAuth turns always stream, as the proxy runs them.
 */
async function sendClaudeTurn(sessionId: string, agentId = ''): Promise<FakeWebSocket> {
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai',
    modelId: 'gpt-5.6-sol',
    apiKey: 'tok',
    authType: 'oauth',
    oauthAccountId: 'acct-1',
  });
  const params = translateRequest({
    model: 'gpt-5.6-sol',
    max_tokens: 64,
    system: 'You are terse.',
    messages: [{ role: 'user', content: `hello from ${agentId || 'main'}` }],
    metadata: { user_id: JSON.stringify({ session_id: sessionId, device_id: 'device' }) },
  }, '@ai-sdk/openai', {
    openAiOAuth: true,
    reasoningMetadata: { upstreamModelId: 'gpt-5.6-sol' },
  });
  const socketsBefore = fakeSockets.length;
  const response = withResponsesWebSocketDiagnosticContext(
    { requestId: `req-${sessionId}-${agentId}`, claudeSessionId: sessionId, claudeAgentId: agentId || undefined },
    () => generateAnthropicResponse(model, params, 'gpt-5.6-sol', { forceStream: true }),
  );
  await vi.waitFor(() => expect(fakeSockets.length).toBe(socketsBefore + 1));
  const socket = fakeSockets.at(-1)!;
  socket.emit('open');
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
  completeTextResponse(socket, `resp_${fakeSockets.length}`);
  await response;
  return socket;
}

describe('Responses WebSocket cache-affinity header', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
  });

  it('opens the socket with session-id set to the prompt_cache_key derived from the Claude session', async () => {
    const socket = await sendClaudeTurn(SESSION);

    const expected = claudeSessionPromptCacheKey(SESSION);
    expect(sentFrame(socket).prompt_cache_key).toBe(expected);
    expect(handshakeHeaders(socket)['session-id']).toBe(expected);
  });

  it('gives each Claude session its own session-id', async () => {
    const first = await sendClaudeTurn(SESSION);
    const second = await sendClaudeTurn(OTHER_SESSION);

    expect(second).not.toBe(first);
    expect(handshakeHeaders(second)['session-id']).toBe(claudeSessionPromptCacheKey(OTHER_SESSION));
    expect(handshakeHeaders(second)['session-id']).not.toBe(handshakeHeaders(first)['session-id']);
  });

  // Claude Code's subagents and its periodic agent-summary forks share the
  // session's prompt_cache_key but get a socket of their own. Those fresh
  // sockets resend the whole prefix, so they are the requests that need the
  // header to reach the cache the main conversation warmed.
  it('sends the same session-id on the fresh socket a subagent opens', async () => {
    const main = await sendClaudeTurn(SESSION);
    const subagent = await sendClaudeTurn(SESSION, 'agent-1');

    expect(subagent).not.toBe(main);
    expect(handshakeHeaders(subagent)['session-id']).toBe(claudeSessionPromptCacheKey(SESSION));
  });

  it('opens the replacement socket of a transport retry with the same session-id', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const response = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        prompt_cache_key: 'relay-session-abc',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    });
    fakeSockets[0]!.emit('open');
    fakeSockets[0]!.emit('error', new Error('connection reset'));

    expect(fakeSockets).toHaveLength(2);
    expect(handshakeHeaders(fakeSockets[1]!)['session-id']).toBe('relay-session-abc');
    fakeSockets[1]!.emit('open');
    completeTextResponse(fakeSockets[1]!, 'resp_replaced');
    await response.text();
  });

  it.each([
    ['no', {}],
    ['an empty', { prompt_cache_key: '' }],
    ['a non-string', { prompt_cache_key: 7 }],
  ])('sends no session-id when the request has %s prompt_cache_key', async (_label, cacheKey) => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], ...cacheKey }),
    });

    expect(Object.keys(handshakeHeaders(fakeSockets.at(-1)!)).map(key => key.toLowerCase()))
      .not.toContain('session-id');
  });

  it('keeps a session-id the caller already set instead of sending a second one', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Session-Id': 'caller-chosen' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], prompt_cache_key: 'relay-session-abc' }),
    });

    const headers = handshakeHeaders(fakeSockets.at(-1)!);
    expect(Object.entries(headers).filter(([key]) => key.toLowerCase() === 'session-id'))
      .toEqual([['Session-Id', 'caller-chosen']]);
  });
});
