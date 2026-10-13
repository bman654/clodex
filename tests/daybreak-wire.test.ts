import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLanguageModel } from '../src/provider-factory.js';
import { resetResponsesWebSocketConnectionsForTests } from '../src/oauth/responses-websocket.js';
import type { AccessPrograms } from '../src/daybreak.js';

const { sockets } = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));
class FakeSocket extends EventEmitter {
  send = vi.fn((_data: string, callback?: (error?: Error) => void) => callback?.());
  close = vi.fn();
  terminate = vi.fn();
  constructor(public url: string, public options: { headers: Record<string, string> }) {
    super();
    sockets.push(this);
  }
}
// Only the network socket is fake: the provider factory, the AI SDK and the
// WebSocket transport all run, so this is the frame ChatGPT would receive.
vi.mock('ws', () => ({ WebSocket: FakeSocket, default: FakeSocket }));

beforeEach(() => {
  resetResponsesWebSocketConnectionsForTests();
  sockets.length = 0;
});
afterEach(() => resetResponsesWebSocketConnectionsForTests());

describe('Daybreak on the ChatGPT WebSocket', () => {
  it.each([
    [false, { cyber: 'daybreak_blue' }],
    [true, { cyber: 'daybreak_blue' }],
    [false, undefined],
    [true, undefined],
  ] satisfies [boolean, AccessPrograms | undefined][])(
    'Responses-Lite=%s, program %j reaches the response.create frame',
    async (useResponsesLite, accessPrograms) => {
      const controller = new AbortController();
      const model = await createLanguageModel({
        npm: '@ai-sdk/openai',
        modelId: 'gpt-6-luna',
        apiKey: 'tok',
        providerId: 'openai-oauth',
        authType: 'oauth',
        oauthAccountId: 'acct',
        useResponsesLite,
        ...(accessPrograms ? { accessPrograms } : {}),
      });
      if (typeof model === 'string' || model.specificationVersion !== 'v4') {
        throw new Error('expected the OpenAI provider language model');
      }
      const pending = model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: { openai: { store: false } },
        abortSignal: controller.signal,
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      socket.emit('open');
      // The SDK resolves doStream once the first output arrives.
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'message', id: 'msg_1', role: 'assistant', content: [], status: 'in_progress' },
      })));
      const result = await pending;
      try {
        const frame = JSON.parse(socket.send.mock.calls[0]![0]) as Record<string, unknown>;
        expect(frame.type).toBe('response.create');
        if (accessPrograms) expect(frame.access_programs).toEqual(accessPrograms);
        else expect(frame).not.toHaveProperty('access_programs');
      } finally {
        controller.abort();
        await result.stream.cancel();
      }
    },
  );

  it('leaves API-key Responses requests alone even when a program is passed', async () => {
    const bodies: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: 'stop' } }), { status: 400 });
    }) as typeof fetch;
    try {
      const model = await createLanguageModel({
        npm: '@ai-sdk/openai',
        modelId: 'gpt-6-luna',
        apiKey: 'sk-test',
        baseURL: 'http://127.0.0.1:9/v1',
        providerId: 'openai',
        authType: 'api',
        accessPrograms: { cyber: 'daybreak_blue' },
      });
      if (typeof model === 'string' || model.specificationVersion !== 'v4') {
        throw new Error('expected the OpenAI provider language model');
      }
      await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }).catch(() => {});
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty('access_programs');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
