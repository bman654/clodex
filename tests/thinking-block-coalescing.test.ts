import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it } from 'vitest';
import { streamAnthropicResponse, translateRequest } from '../src/sdk-adapter.js';
import { sdkUpstreamErrorDetails } from '../src/upstream-error.js';

// Issue #190: a mid-stream WebSocket 1006 drop kills the agent outright when the
// turn has produced only thinking so far.
//
// Claude Code 2.1.263 has three regimes on an in-band SSE error frame:
//
//   1. no `content_block_stop` emitted yet  -> retries, then non-streaming fallback
//   2. >=1 block closed AND a text/tool_use block started -> partial turn, agent survives
//   3. >=1 block closed, thinking only      -> persisted error "unknown", AGENT DIES
//
// `@ai-sdk/openai` emits one `reasoning-start` per reasoning summary part, and
// `writeAnthropicStream` opens a fresh Anthropic thinking block on each one --
// closing the previous block as it goes. So any thinking-only turn carrying two
// or more summary parts has already emitted a `content_block_stop` and lands in
// regime 3 instead of the retryable regime 1.
//
// These tests drive the REAL production stack: the real `@ai-sdk/openai`
// Responses producer, the real `streamText` call inside `streamAnthropicResponse`,
// and the real Anthropic SSE writer. Only `fetch` is replaced -- which is the
// exact seam the ChatGPT/Codex OAuth WebSocket transport occupies in production
// (`src/provider-factory.ts` passes `createResponsesWebSocketFetch` as `fetch`
// to `createOpenAI`, then calls `.responses(modelId)`).

const MODEL = 'gpt-5.6-sol';

interface AnthropicSseEvent {
  event: string;
  data: Record<string, any>;
}

/**
 * Upstream Responses-API SSE in the exact framing the OAuth WebSocket transport
 * writes downstream: a bare `data: <json>` record with no `event:` line, per
 * `encodeSse` in `src/oauth/responses-websocket.ts`.
 */
function upstreamSseBody(chunks: unknown[]): string {
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('');
}

/**
 * The reasoning chunk sequence for one Responses output item carrying `texts.length`
 * summary parts. Field names and shapes are those required by the pinned
 * `@ai-sdk/openai` 4.0.11 Responses chunk schema (`openaiResponsesChunkSchema`),
 * which is what makes the SDK emit one `reasoning-start` per summary part.
 *
 * By default the item is left mid-flight (no `output_item.done`), which is what a
 * drop interrupts. Pass `encryptedContent` to close the item the way a completed
 * one arrives -- that chunk is what makes the SDK emit `reasoning-end` carrying
 * the blob (node_modules/@ai-sdk/openai/dist/index.js:7329-7347).
 */
function reasoningItemChunks(
  itemId: string,
  texts: string[],
  options: { outputIndex?: number; encryptedContent?: string } = {},
): unknown[] {
  const outputIndex = options.outputIndex ?? 0;
  const chunks: unknown[] = [{
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { type: 'reasoning', id: itemId, encrypted_content: null },
  }];
  texts.forEach((text, summaryIndex) => {
    // Summary part 0 is opened by `output_item.added` itself; every later part
    // announces itself, and that is the chunk that yields a second reasoning-start.
    if (summaryIndex > 0) {
      chunks.push({
        type: 'response.reasoning_summary_part.added',
        item_id: itemId,
        summary_index: summaryIndex,
      });
    }
    chunks.push({
      type: 'response.reasoning_summary_text.delta',
      item_id: itemId,
      summary_index: summaryIndex,
      delta: text,
    });
    chunks.push({
      type: 'response.reasoning_summary_part.done',
      item_id: itemId,
      summary_index: summaryIndex,
    });
  });
  if (options.encryptedContent !== undefined) {
    chunks.push({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: { type: 'reasoning', id: itemId, encrypted_content: options.encryptedContent },
    });
  }
  return chunks;
}

/**
 * The terminal frame the OAuth WebSocket transport injects into the Responses
 * stream when the socket drops mid-response. Copied field-for-field from
 * `failContext` in `src/oauth/responses-websocket.ts`, which builds
 * `WebSocket closed (${code})` with `code: 'websocket_transport_error'` and
 * `type: 'transport_error'` whenever there is no HTTP status to report.
 */
function transportDropChunk(sequenceNumber: number): unknown {
  return {
    type: 'error',
    sequence_number: sequenceNumber,
    error: {
      type: 'transport_error',
      code: 'websocket_transport_error',
      message: 'WebSocket closed (1006)',
      param: null,
    },
  };
}

function parseAnthropicSse(raw: string): AnthropicSseEvent[] {
  return raw.split('\n\n').filter(Boolean).map(block => {
    const [eventLine, dataLine] = block.split('\n');
    return {
      event: eventLine.replace('event: ', ''),
      data: JSON.parse(dataLine.replace('data: ', '')),
    };
  });
}

/** Run the production translation path over a canned upstream Responses stream. */
async function relayUpstream(chunks: unknown[]): Promise<{
  events: AnthropicSseEvent[];
  raw: string;
  error: unknown;
  upstreamRequests: number;
}> {
  let upstreamRequests = 0;
  const provider = createOpenAI({
    apiKey: 'synthetic-test-key',
    fetch: async () => {
      upstreamRequests++;
      return new Response(upstreamSseBody(chunks), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const params = translateRequest(
    { model: MODEL, messages: [{ role: 'user', content: 'go' }] },
    '@ai-sdk/openai',
    { openAiOAuth: true },
  );

  let raw = '';
  let error: unknown;
  try {
    await streamAnthropicResponse(
      provider.responses(MODEL), params, MODEL, chunk => { raw += chunk; },
    );
  } catch (e) {
    error = e;
  }
  return { events: parseAnthropicSse(raw), raw, error, upstreamRequests };
}

const thinkingText = (events: AnthropicSseEvent[]): string => events
  .filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta')
  .map(e => e.data.delta.thinking)
  .join('');

const countStops = (events: AnthropicSseEvent[]): number =>
  events.filter(e => e.event === 'content_block_stop').length;

describe('thinking-only turn interrupted by a WebSocket transport drop', () => {
  it('closes no content block, so Claude Code can retry, when several reasoning summaries arrived', async () => {
    const summaries = ['Weighing the options.', 'Checking the constraints.', 'Picking an approach.'];
    const { events, error, upstreamRequests } = await relayUpstream([
      { type: 'response.created', response: { id: 'resp_1', created_at: 0, model: MODEL } },
      ...reasoningItemChunks('rs_1', summaries),
      transportDropChunk(12),
    ]);

    // Harness fidelity: the drop marker survived the real Responses parser and
    // reached the adapter as a transport failure, not as some generic error.
    expect(sdkUpstreamErrorDetails(error)?.transportCode).toBe('websocket_transport_error');
    // clodex itself does not re-issue the turn; the retry is Claude Code's to make.
    expect(upstreamRequests).toBe(1);

    // The whole point: nothing visible was produced, so the client must still be
    // in its retryable regime. A single `content_block_stop` moves it to the
    // thinking-only regime that persists error "unknown" and kills the agent.
    expect(countStops(events)).toBe(0);

    // Coalescing must not silently drop reasoning the model already streamed.
    // Consecutive summaries read as paragraphs; the blank line is display-only
    // and must never reach the strings sent back upstream (see
    // tests/thinking-roundtrip.test.ts).
    expect(thinkingText(events)).toBe(
      'Weighing the options.\n\nChecking the constraints.\n\nPicking an approach.',
    );
  });

  it('closes no content block after many complete reasoning items, with no group cap reopening one', async () => {
    // Twelve COMPLETE, signed reasoning items -- past any plausible group cap.
    // Two rejected designs would both reopen a block here and put a
    // thinking-only turn back in the regime that kills the agent: merging per
    // item (a boundary, and so a `content_block_stop`, between every pair), and
    // capping the group size with a fallback that starts a fresh block once the
    // cap is hit. Neither is detectable with the two-item fixtures, because
    // twelve is the first count that exceeds a cap anyone would pick.
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `rs_${i + 1}`,
      blob: `encrypted-blob-${i + 1}`,
      // One summary each, so the ONLY boundaries under test are between items.
      // Boundaries within an item are already pinned by the first test.
      text: `Step ${i + 1}.`,
    }));

    const { events, error } = await relayUpstream([
      { type: 'response.created', response: { id: 'resp_many', created_at: 0, model: MODEL } },
      ...items.flatMap((item, i) => reasoningItemChunks(
        item.id, [item.text], { outputIndex: i, encryptedContent: item.blob },
      )),
      transportDropChunk(99),
    ]);

    expect(sdkUpstreamErrorDetails(error)?.transportCode).toBe('websocket_transport_error');
    expect(countStops(events)).toBe(0);

    const starts = events.filter(e => e.event === 'content_block_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.data.content_block.type).toBe('thinking');

    // Every item's reasoning is present, in order, as readable paragraphs.
    expect(thinkingText(events)).toBe(items.map(item => item.text).join('\n\n'));
  });

  it('closes no content block when a single reasoning summary arrived', async () => {
    const { events, error } = await relayUpstream([
      { type: 'response.created', response: { id: 'resp_2', created_at: 0, model: MODEL } },
      ...reasoningItemChunks('rs_2', ['Only one summary part.']),
      transportDropChunk(6),
    ]);

    expect(sdkUpstreamErrorDetails(error)?.transportCode).toBe('websocket_transport_error');
    expect(countStops(events)).toBe(0);
    // A lone summary gets no separator -- the blank line joins summaries, it is
    // not appended to each one.
    expect(thinkingText(events)).toBe('Only one summary part.');
  });

  it('still closes blocks once visible output exists, so a partial turn is finalized', async () => {
    // Over-scope negative: suppressing every `content_block_stop` would be wrong.
    // Once a tool_use block is open the client finalizes the partial turn either
    // way, and the tool block's buffered arguments must still be flushed.
    const { events, error } = await relayUpstream([
      { type: 'response.created', response: { id: 'resp_3', created_at: 0, model: MODEL } },
      ...reasoningItemChunks('rs_3', ['First summary.', 'Second summary.']),
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'Bash',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '{"command":"ls"}',
      },
      transportDropChunk(18),
    ]);

    expect(sdkUpstreamErrorDetails(error)?.transportCode).toBe('websocket_transport_error');
    const startedTypes = events
      .filter(e => e.event === 'content_block_start')
      .map(e => e.data.content_block.type);
    expect(startedTypes).toEqual(['thinking', 'tool_use']);
    expect(countStops(events)).toBe(2);
    expect(events
      .filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')
      .map(e => ({ index: e.data.index, json: e.data.delta.partial_json })))
      .toEqual([{ index: 1, json: '{"command":"ls"}' }]);
  });

  it('completes a multi-summary thinking turn normally when the stream is not interrupted', async () => {
    const { events, error } = await relayUpstream([
      { type: 'response.created', response: { id: 'resp_4', created_at: 0, model: MODEL } },
      ...reasoningItemChunks('rs_4', ['Part one.', 'Part two.']),
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'msg_1' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        delta: 'Here is the answer.',
        logprobs: [],
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_4',
          created_at: 0,
          model: MODEL,
          incomplete_details: null,
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      },
    ]);

    expect(error).toBeUndefined();
    expect(thinkingText(events)).toBe('Part one.\n\nPart two.');
    const text = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
      .map(e => e.data.delta.text)
      .join('');
    expect(text).toBe('Here is the answer.');
    expect(events.at(-1)?.event).toBe('message_stop');
  });
});
