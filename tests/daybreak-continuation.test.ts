// The Daybreak program must ride every request of a conversation, including the
// incremental continuation turns the WebSocket transport sends with
// previous_response_id. The earlier assistant turn arrives through real
// response events, never planted into transport state.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAccessPrograms } from '../src/daybreak.js';
import {
  createResponsesWebSocketFetch,
  resetResponsesWebSocketConnectionsForTests,
} from '../src/oauth/responses-websocket.js';

const state = vi.hoisted(() => ({ frames: [] as Record<string, unknown>[], sockets: [] as FakeSocket[] }));

class FakeSocket extends EventEmitter {
  close = vi.fn();
  terminate = vi.fn();
  constructor(public url: string, public options: unknown) {
    super();
    state.sockets.push(this);
    setImmediate(() => this.emit('open'));
  }
  send = vi.fn((data: string, callback?: (error?: Error) => void) => {
    callback?.();
    state.frames.push(JSON.parse(data) as Record<string, unknown>);
    const id = `resp_${state.frames.length}`;
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `msg_${id}`, role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `msg_${id}`, role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    setImmediate(() => { for (const event of events) this.emit('message', Buffer.from(JSON.stringify(event))); });
  });
}
vi.mock('ws', () => ({ WebSocket: FakeSocket, default: FakeSocket }));

afterEach(() => {
  resetResponsesWebSocketConnectionsForTests();
  state.frames.length = 0;
  state.sockets.length = 0;
});

const BLUE = { cyber: 'daybreak_blue' } as const;

function request(input: unknown[], responsesLite: boolean): RequestInit {
  return {
    method: 'POST',
    headers: responsesLite ? { 'x-openai-internal-codex-responses-lite': 'true' } : {},
    body: JSON.stringify({
      model: 'gpt-6-luna', prompt_cache_key: 'session', instructions: 'Help.', store: false,
      reasoning: { effort: 'high' }, input,
    }),
  };
}

function daybreakFetch(): typeof fetch {
  return withAccessPrograms(
    createResponsesWebSocketFetch('wss://chatgpt.com/backend-api/codex/responses', undefined, {
      providerId: 'openai-oauth',
      accountId: 'acct',
    }),
    BLUE,
  );
}

describe('Daybreak across a continued conversation', () => {
  it.each([false, true])('Responses-Lite=%s: the continuation turn still carries the program', async responsesLite => {
    const user = { role: 'user', content: [{ type: 'input_text', text: 'hi' }] };
    const first = await daybreakFetch()('https://unused/responses', request([user], responsesLite));
    expect(await first.text()).toContain('response.completed');

    const assistant = { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
    const next = { role: 'user', content: [{ type: 'input_text', text: 'again' }] };
    const second = await daybreakFetch()('https://unused/responses', request([user, assistant, next], responsesLite));
    expect(await second.text()).toContain('response.completed');

    expect(state.sockets).toHaveLength(1);
    expect(state.frames[1]!.previous_response_id).toBe('resp_1');
    expect(state.frames[1]!.input).toEqual([next]);
    expect(state.frames.map(frame => frame.access_programs)).toEqual([BLUE, BLUE]);
    if (responsesLite) expect(state.frames[1]!.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
  });
});
