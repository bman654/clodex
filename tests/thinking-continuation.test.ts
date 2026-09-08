import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createOpenAI } from '@ai-sdk/openai';

// Fake `ws` WebSocket. Records every frame the transport sends, in the order it
// was sent, so a turn that continues an EARLIER socket is still read in sequence.
const { fakeSockets, sentFrames } = vi.hoisted(() => ({
  fakeSockets: [] as FakeWebSocket[],
  sentFrames: [] as Array<{ socket: FakeWebSocket; payload: Record<string, any> }>,
}));

class FakeWebSocket extends EventEmitter {
  url: string;
  options: { headers?: Record<string, string> };
  send = vi.fn((data: string) => {
    sentFrames.push({ socket: this, payload: JSON.parse(data) });
  });
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
  resetReasoningGapWarningsForTests,
  resetToolArgumentGapWarningsForTests,
  type ResponsesWebSocketDiagnosticEvent,
  type ResponsesWebSocketFetchOptions,
} from '../src/oauth/responses-websocket.js';
import { streamAnthropicResponse, translateRequest } from '../src/sdk-adapter.js';
import type { UpgradeAdmission } from '../src/oauth/ws-upgrade-pacer.js';

const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
const MODEL = 'gpt-5.6-sol';
const SYSTEM = 'You are a coding assistant.';

/** Responses-API item shapes, written from the API contract rather than from clodex. */
const userItem = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const assistantItem = (text: string) => ({ role: 'assistant', content: [{ type: 'output_text', text }] });
const summaryItems = (texts: string[]) => texts.map(text => ({ type: 'summary_text', text }));
const reasoningItem = (id: string, encrypted: string, texts: string[]) => ({
  type: 'reasoning', id, encrypted_content: encrypted, summary: summaryItems(texts),
});

// ── upstream producer ────────────────────────────────────────────────────────
// Real Codex WebSocket event sequences. Every piece of assistant state under
// test reaches the head through these frames, never by planting an item in a
// request `input` (which the transport keeps verbatim and so can never diverge).

type ReasoningSummary = string | string[];
interface ReasoningSpec { itemId: string; encrypted: string; summaries: ReasoningSummary[] }

const reasoningSummaryText = (summary: ReasoningSummary): string =>
  Array.isArray(summary) ? summary.join('') : summary;

function emitEvent(socket: FakeWebSocket, event: unknown): void {
  socket.emit('message', Buffer.from(JSON.stringify(event)));
}

/** One reasoning item; array-valued summaries arrive as several deltas within one part. */
function reasoningEvents(spec: ReasoningSpec, outputIndex: number): unknown[] {
  const events: unknown[] = [{
    type: 'response.output_item.added', output_index: outputIndex,
    item: { type: 'reasoning', id: spec.itemId, summary: [] },
  }];
  spec.summaries.forEach((summary, summaryIndex) => {
    const deltas = Array.isArray(summary) ? summary : [summary];
    const text = reasoningSummaryText(summary);
    if (summaryIndex > 0) {
      events.push({
        type: 'response.reasoning_summary_part.added', output_index: outputIndex,
        item_id: spec.itemId, summary_index: summaryIndex, part: { type: 'summary_text', text: '' },
      });
    }
    for (const delta of deltas) {
      events.push({
        type: 'response.reasoning_summary_text.delta', output_index: outputIndex,
        item_id: spec.itemId, summary_index: summaryIndex, delta,
      });
    }
    events.push({
      type: 'response.reasoning_summary_part.done', output_index: outputIndex,
      item_id: spec.itemId, summary_index: summaryIndex, part: { type: 'summary_text', text },
    });
  });
  events.push({
    type: 'response.output_item.done', output_index: outputIndex,
    item: {
      type: 'reasoning', id: spec.itemId, encrypted_content: spec.encrypted,
      summary: summaryItems(spec.summaries.map(reasoningSummaryText)),
    },
  });
  return events;
}

function completeResponse(
  socket: FakeWebSocket,
  options: { responseId: string; reasoning: ReasoningSpec[]; text: string },
): void {
  emitEvent(socket, {
    type: 'response.created',
    response: { id: options.responseId, created_at: 0, model: MODEL },
  });
  let outputIndex = 0;
  for (const spec of options.reasoning) {
    for (const event of reasoningEvents(spec, outputIndex)) emitEvent(socket, event);
    outputIndex += 1;
  }
  const messageId = `msg_${options.responseId}`;
  emitEvent(socket, {
    type: 'response.output_item.added', output_index: outputIndex,
    item: { type: 'message', id: messageId },
  });
  emitEvent(socket, { type: 'response.output_text.delta', item_id: messageId, delta: options.text });
  emitEvent(socket, {
    type: 'response.output_item.done', output_index: outputIndex,
    item: { type: 'message', id: messageId },
  });
  emitEvent(socket, {
    type: 'response.completed',
    response: { id: options.responseId, usage: { input_tokens: 11, output_tokens: 22 } },
  });
}

// ── downstream client ────────────────────────────────────────────────────────

/** Rebuild the assistant message from the Anthropic SSE the way a client does. */
function assembleAssistantMessage(raw: string): { role: 'assistant'; content: Record<string, any>[] } {
  const content: Record<string, any>[] = [];
  for (const block of raw.split('\n\n').filter(Boolean)) {
    const [eventLine, dataLine] = block.split('\n');
    const event = eventLine!.replace('event: ', '');
    const data = JSON.parse(dataLine!.replace('data: ', ''));
    if (event === 'content_block_start') content[data.index] = { ...data.content_block };
    else if (event === 'content_block_delta') {
      const target = content[data.index]!;
      if (data.delta.type === 'thinking_delta') target.thinking += data.delta.thinking;
      else if (data.delta.type === 'signature_delta') target.signature = data.delta.signature;
      else if (data.delta.type === 'text_delta') target.text += data.delta.text;
    }
  }
  return { role: 'assistant', content: content.filter(Boolean) };
}

/** Claude Code 2.1.263 recursively makes every outgoing request string well-formed. */
function clientToWellFormed<T>(value: T): T {
  if (typeof value === 'string') return value.toWellFormed() as T;
  if (Array.isArray(value)) return value.map(clientToWellFormed) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, clientToWellFormed(child)]),
    ) as T;
  }
  return value;
}

interface Client {
  provider: ReturnType<typeof createOpenAI>;
  /** The transport's own head decisions, so a test can name the match it got. */
  headDecisions: ResponsesWebSocketDiagnosticEvent[];
}

function createClient(options: ResponsesWebSocketFetchOptions): Client {
  const headDecisions: ResponsesWebSocketDiagnosticEvent[] = [];
  const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
    pacer: { admit: async (): Promise<UpgradeAdmission> => ({ kind: 'admitted', waitedMs: 0 }) },
    onDiagnostic: event => { if (event.event === 'ws_head_decision') headDecisions.push(event); },
    ...options,
  });
  return { provider: createOpenAI({ apiKey: 'test-only', fetch: wsFetch }), headDecisions };
}

interface Turn {
  /** The `response.create` frame this turn put on the wire. */
  payload: Record<string, any>;
  socket: FakeWebSocket;
  /** Anthropic SSE accumulated downstream; filled in as the turn streams. */
  sse: { text: string };
  finished: Promise<unknown>;
}

/**
 * Drive one whole turn through the production stack: translateRequest ->
 * @ai-sdk/openai Responses -> the real WebSocket transport, stopping once the
 * request frame is on the wire so the caller can script the upstream response.
 */
async function startTurn(
  provider: ReturnType<typeof createOpenAI>,
  messages: Record<string, any>[],
): Promise<Turn> {
  const framesBefore = sentFrames.length;
  const socketsBefore = fakeSockets.length;
  const sse = { text: '' };
  const params = translateRequest(
    { model: MODEL, system: SYSTEM, messages } as never,
    '@ai-sdk/openai',
    { openAiOAuth: true },
  );
  const finished = streamAnthropicResponse(
    provider.responses(MODEL), params, MODEL, chunk => { sse.text += chunk; },
  ).then(() => undefined, (error: unknown) => error);
  let opened = false;
  await vi.waitFor(() => {
    if (!opened && fakeSockets.length > socketsBefore) {
      opened = true;
      fakeSockets[fakeSockets.length - 1]!.emit('open');
    }
    expect(sentFrames.length).toBeGreaterThan(framesBefore);
  });
  const frame = sentFrames[framesBefore]!;
  return { payload: frame.payload, socket: frame.socket, sse, finished };
}

const THREE = ['weigh the options', 'check the second file', 'settle on a plan'];
const TWO = ['double-check the edge case', 'confirm the fix'];

describe('OpenAI thinking round-trip through the WebSocket chain', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    resetReasoningGapWarningsForTests();
    resetToolArgumentGapWarningsForTests();
    fakeSockets.length = 0;
    sentFrames.length = 0;
  });

  it('continues the chain after a multi-item, multi-summary thinking turn', async () => {
    const client = createClient({ accountId: 'acct-continue' });

    const first = await startTurn(client.provider, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
    expect(first.payload.previous_response_id).toBeUndefined();
    completeResponse(first.socket, {
      responseId: 'resp_1',
      reasoning: [
        { itemId: 'rs_1', encrypted: 'enc_one', summaries: THREE },
        { itemId: 'rs_2', encrypted: 'enc_two', summaries: TWO },
      ],
      text: 'answer',
    });
    await expect(first.finished).resolves.toBeUndefined();

    // Five summary parts across two items reach the user as one thinking block.
    const assistant = assembleAssistantMessage(first.sse.text);
    expect(assistant.content.map(block => block.type)).toEqual(['thinking', 'text']);
    expect(assistant.content[0]!.thinking).toBe([...THREE, ...TWO].join('\n\n'));

    const second = await startTurn(client.provider, [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistant,
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ]);

    // The whole prior turn was recognised as already held upstream, so only the
    // new user message crosses the wire. `exact` rather than `omitted_reasoning`:
    // the reasoning was echoed and matched, not skipped and forgiven.
    expect(client.headDecisions.at(-1)).toMatchObject({
      decision: 'continuation', continuationMatchMode: 'exact',
    });
    expect(second.socket).toBe(first.socket);
    expect(second.payload.previous_response_id).toBe('resp_1');
    expect(second.payload.input).toEqual([userItem('next')]);

    completeResponse(second.socket, {
      responseId: 'resp_2', reasoning: [{ itemId: 'rs_3', encrypted: 'enc_three', summaries: ['done'] }], text: 'ok',
    });
    await expect(second.finished).resolves.toBeUndefined();
  });

  it('resends each original reasoning item and ciphertext when the chain has expired', async () => {
    let now = 1_000;
    const client = createClient({ accountId: 'acct-expired', idleTtlMs: 100, now: () => now });

    const first = await startTurn(client.provider, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
    completeResponse(first.socket, {
      responseId: 'resp_expired',
      reasoning: [
        { itemId: 'rs_1', encrypted: 'enc_one', summaries: THREE },
        { itemId: 'rs_2', encrypted: 'enc_two', summaries: TWO },
      ],
      text: 'answer',
    });
    await expect(first.finished).resolves.toBeUndefined();

    // The user reads the five summaries as five paragraphs of one thinking block.
    const assistant = assembleAssistantMessage(first.sse.text);
    expect(assistant.content.map(block => block.type)).toEqual(['thinking', 'text']);
    expect(assistant.content[0]!.thinking).toBe([...THREE, ...TWO].join('\n\n'));

    now += 101;
    const second = await startTurn(client.provider, [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistant,
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ]);

    // No chain to extend, so the full history goes back up — and it must carry
    // the two items with their own 3 and 2 summary parts and their own
    // ciphertext, with none of the display-only paragraph breaks.
    expect(second.socket).not.toBe(first.socket);
    expect(second.payload.previous_response_id).toBeUndefined();
    expect(second.payload.input).toEqual([
      userItem('go'),
      reasoningItem('rs_1', 'enc_one', THREE),
      reasoningItem('rs_2', 'enc_two', TWO),
      assistantItem('answer'),
      userItem('next'),
    ]);

    completeResponse(second.socket, {
      responseId: 'resp_expired_2', reasoning: [{ itemId: 'rs_9', encrypted: 'enc_nine', summaries: ['done'] }], text: 'ok',
    });
    await expect(second.finished).resolves.toBeUndefined();
  });

  it('resends original Unicode after client sanitization and a full chain reset', async () => {
    let now = 2_000;
    const client = createClient({ accountId: 'acct-unicode', idleTtlMs: 100, now: () => now });
    const originals = ['Valid pair 🚀 survives.', 'Original lone \ud83d survives.'];
    const streamed: ReasoningSummary[] = [
      ['Valid pair ', '\ud83d', '\ude80 survives.'],
      ['Original lone ', '\ud83d', ' survives.'],
    ];

    const first = await startTurn(client.provider, [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ]);
    completeResponse(first.socket, {
      responseId: 'resp_unicode',
      reasoning: [{ itemId: 'rs_unicode', encrypted: 'enc_unicode', summaries: streamed }],
      text: 'answer',
    });
    await expect(first.finished).resolves.toBeUndefined();

    const assistant = assembleAssistantMessage(first.sse.text);
    expect(assistant.content[0]!.thinking).toBe(originals.join('\n\n'));
    const sanitized = clientToWellFormed(assistant);
    expect(sanitized.content[0]!.thinking).toBe(originals.map(text => text.toWellFormed()).join('\n\n'));
    expect(sanitized.content[0]!.thinking).not.toBe(assistant.content[0]!.thinking);
    expect(sanitized.content[0]!.signature).toBe(assistant.content[0]!.signature);

    now += 101;
    const second = await startTurn(client.provider, [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      sanitized,
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ]);

    expect(second.socket).not.toBe(first.socket);
    expect(second.payload.previous_response_id).toBeUndefined();
    expect(second.payload.input).toEqual([
      userItem('go'),
      reasoningItem('rs_unicode', 'enc_unicode', originals),
      assistantItem('answer'),
      userItem('next'),
    ]);

    completeResponse(second.socket, {
      responseId: 'resp_unicode_2',
      reasoning: [{ itemId: 'rs_unicode_2', encrypted: 'enc_unicode_2', summaries: ['done'] }],
      text: 'ok',
    });
    await expect(second.finished).resolves.toBeUndefined();
  });

  it('continues a chain from a transcript recorded before signatures carried item structure', async () => {
    const client = createClient({ accountId: 'acct-legacy' });

    const first = await startTurn(client.provider, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
    completeResponse(first.socket, {
      responseId: 'resp_legacy',
      reasoning: [{ itemId: 'rs_1', encrypted: 'enc_legacy', summaries: ['weigh the options'] }],
      text: 'answer',
    });
    await expect(first.finished).resolves.toBeUndefined();

    // A session resumed from an older clodex: the thinking block carries the raw
    // encrypted blob as its signature, with no item or summary structure at all.
    const legacyAssistant = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'weigh the options', signature: 'enc_legacy' },
        { type: 'text', text: 'answer' },
      ],
    };
    const second = await startTurn(client.provider, [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      legacyAssistant,
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ]);

    expect(client.headDecisions.at(-1)).toMatchObject({
      decision: 'continuation', continuationMatchMode: 'exact',
    });
    expect(second.socket).toBe(first.socket);
    expect(second.payload.previous_response_id).toBe('resp_legacy');
    expect(second.payload.input).toEqual([userItem('next')]);

    completeResponse(second.socket, {
      responseId: 'resp_legacy_2', reasoning: [{ itemId: 'rs_2', encrypted: 'enc_l2', summaries: ['done'] }], text: 'ok',
    });
    await expect(second.finished).resolves.toBeUndefined();
  });

  it('refuses to continue when the history holds different reasoning under identical text', async () => {
    const mine = createClient({ accountId: 'acct-mine' });
    const other = createClient({ accountId: 'acct-other' });
    const opening = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];

    const myTurn = await startTurn(mine.provider, opening);
    completeResponse(myTurn.socket, {
      responseId: 'resp_mine',
      reasoning: [{ itemId: 'rs_1', encrypted: 'enc_mine', summaries: THREE }],
      text: 'answer',
    });
    await expect(myTurn.finished).resolves.toBeUndefined();

    // A different conversation reasons to the same visible words under different
    // ciphertext — the only thing separating the two histories.
    const otherTurn = await startTurn(other.provider, opening);
    completeResponse(otherTurn.socket, {
      responseId: 'resp_other',
      reasoning: [{ itemId: 'rs_1', encrypted: 'enc_other', summaries: THREE }],
      text: 'answer',
    });
    await expect(otherTurn.finished).resolves.toBeUndefined();

    const foreign = assembleAssistantMessage(otherTurn.sse.text);
    const own = assembleAssistantMessage(myTurn.sse.text);
    expect(foreign.content[0]!.thinking).toBe(own.content[0]!.thinking);
    expect(foreign.content[0]!.signature).not.toBe(own.content[0]!.signature);

    const resumed = await startTurn(mine.provider, [
      ...opening,
      foreign,
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ]);

    expect(mine.headDecisions.at(-1)).toMatchObject({ decision: 'history_mismatch_new_head' });
    expect(resumed.socket).not.toBe(myTurn.socket);
    expect(resumed.payload.previous_response_id).toBeUndefined();
    expect(resumed.payload.input).toEqual([
      userItem('go'),
      reasoningItem('rs_1', 'enc_other', THREE),
      assistantItem('answer'),
      userItem('next'),
    ]);

    completeResponse(resumed.socket, {
      responseId: 'resp_mine_2', reasoning: [{ itemId: 'rs_2', encrypted: 'enc_m2', summaries: ['done'] }], text: 'ok',
    });
    await expect(resumed.finished).resolves.toBeUndefined();
  });
});
