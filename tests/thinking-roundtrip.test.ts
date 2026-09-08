import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it } from 'vitest';
import {
  generateAnthropicResponse,
  streamAnthropicResponse,
  translateRequest,
} from '../src/sdk-adapter.js';

// Issue #190, second leg: reasoning must survive a full round trip.
//
// Turn 1 streams reasoning down to Claude Code as Anthropic thinking blocks.
// Claude Code persists those blocks verbatim and replays them on turn 2, where
// clodex has to rebuild the ORIGINAL upstream reasoning items -- same item ids,
// same encrypted blobs, and the same summary strings, split exactly where the
// model split them.
//
// Two independent contracts are in play and they must not be confused:
//
//   * DOWNSTREAM (what a human reads) -- consecutive summaries of one reasoning
//     item render as readable paragraphs, separated by a blank line.
//   * OUTBOUND (what goes back upstream) -- the summary strings must be the
//     EXACT originals, with no display separator baked into them.
//
// `store: false` is set unconditionally for `@ai-sdk/openai`
// (`thinkingProviderOptions`, src/provider-factory.ts:1173-1179), so the SDK
// takes its grouping branch: reasoning parts carrying `providerOptions.openai.itemId`
// are merged into one `reasoning` input item per id, each part appended as its
// own `summary_text` entry, with `encrypted_content` taken from the part options
// (node_modules/@ai-sdk/openai/dist/index.js:3964-4013).
//
// Both legs run the real production path. Only `fetch` is replaced -- the seam
// the OAuth WebSocket transport occupies in `src/provider-factory.ts:196-205`.
// Nothing here imports the pending envelope module; these assertions are the
// wire contract, so they stay valid whatever representation carries it.

const MODEL = 'gpt-5.6-sol';

const ITEM_ONE = {
  id: 'rs_1',
  blob: 'encrypted-reasoning-blob-one',
  // The second summary arrives as two deltas, which must concatenate with NO
  // separator -- that is what distinguishes a delta boundary from a summary
  // boundary.
  summaries: [['Weighing the options.'], ['Checking the ', 'constraints.']],
  expected: ['Weighing the options.', 'Checking the constraints.'],
};

const ITEM_TWO = {
  id: 'rs_2',
  blob: 'encrypted-reasoning-blob-two',
  summaries: [['Listing the files.'], ['Reading the adapter.']],
  expected: ['Listing the files.', 'Reading the adapter.'],
};

interface AnthropicSseEvent { event: string; data: Record<string, any> }
interface AnthropicBlock { type: string; thinking?: string; signature?: string; text?: string }

function upstreamSseBody(chunks: unknown[]): string {
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('');
}

/**
 * One reasoning output item. The encrypted blob is absent while the item streams
 * and only appears on `response.output_item.done`, which is how the Responses API
 * delivers it -- and it is that chunk which makes the SDK emit `reasoning-end`
 * carrying `reasoningEncryptedContent` for every summary still open
 * (node_modules/@ai-sdk/openai/dist/index.js:7329-7347).
 */
function reasoningItemChunks(
  item: { id: string; blob: string; summaries: string[][] },
  outputIndex: number,
): unknown[] {
  const chunks: unknown[] = [{
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { type: 'reasoning', id: item.id, encrypted_content: null },
  }];
  item.summaries.forEach((deltas, summaryIndex) => {
    if (summaryIndex > 0) {
      chunks.push({
        type: 'response.reasoning_summary_part.added',
        item_id: item.id,
        summary_index: summaryIndex,
      });
    }
    for (const delta of deltas) {
      chunks.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: item.id,
        summary_index: summaryIndex,
        delta,
      });
    }
    chunks.push({
      type: 'response.reasoning_summary_part.done',
      item_id: item.id,
      summary_index: summaryIndex,
    });
  });
  chunks.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: { type: 'reasoning', id: item.id, encrypted_content: item.blob },
  });
  return chunks;
}

function turnOneChunks(): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_1', created_at: 0, model: MODEL } },
    ...reasoningItemChunks(ITEM_ONE, 0),
    ...reasoningItemChunks(ITEM_TWO, 1),
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'message', id: 'msg_1' },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      delta: 'All done.',
      logprobs: [],
    },
    {
      type: 'response.output_item.done',
      output_index: 2,
      item: { type: 'message', id: 'msg_1' },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        created_at: 0,
        model: MODEL,
        incomplete_details: null,
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    },
  ];
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

/**
 * Rebuild the assistant message from the downstream SSE the way Claude Code
 * does: accumulate each block's deltas and keep the signature it was closed
 * with. Turn 2 replays exactly this.
 */
function assistantBlocksFromSse(events: AnthropicSseEvent[]): AnthropicBlock[] {
  const blocks = new Map<number, AnthropicBlock>();
  for (const e of events) {
    const index = e.data.index as number;
    if (e.event === 'content_block_start') {
      blocks.set(index, e.data.content_block.type === 'thinking'
        ? { type: 'thinking', thinking: '', signature: '' }
        : { type: 'text', text: '' });
    } else if (e.event === 'content_block_delta') {
      const block = blocks.get(index);
      if (!block) continue;
      const delta = e.data.delta;
      if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
      else if (delta.type === 'signature_delta') block.signature = delta.signature;
      else if (delta.type === 'text_delta') block.text += delta.text;
    }
  }
  return [...blocks.values()];
}

/** Turn 1: stream a canned upstream response through the production path. */
async function runTurnOne(): Promise<AnthropicSseEvent[]> {
  const provider = createOpenAI({
    apiKey: 'synthetic-test-key',
    fetch: async () => new Response(upstreamSseBody(turnOneChunks()), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  });
  const params = translateRequest(
    { model: MODEL, messages: [{ role: 'user', content: 'go' }] },
    '@ai-sdk/openai',
    { openAiOAuth: true },
  );
  let raw = '';
  await streamAnthropicResponse(
    provider.responses(MODEL), params, MODEL, chunk => { raw += chunk; },
  );
  return parseAnthropicSse(raw);
}

/** Turn 2: replay the assistant turn and capture what actually goes upstream. */
async function runTurnTwo(assistant: AnthropicBlock[]): Promise<any[]> {
  let sentInput: any[] = [];
  const provider = createOpenAI({
    apiKey: 'synthetic-test-key',
    fetch: async (_input, init) => {
      sentInput = JSON.parse(String(init?.body)).input ?? [];
      return new Response(JSON.stringify({
        id: 'resp_2',
        model: MODEL,
        output: [],
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const params = translateRequest({
    model: MODEL,
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: assistant as any },
      { role: 'user', content: 'keep going' },
    ],
  }, '@ai-sdk/openai', { openAiOAuth: true });

  await generateAnthropicResponse(provider.responses(MODEL), params, MODEL);
  return sentInput;
}

const thinkingBlocks = (events: AnthropicSseEvent[]): AnthropicBlock[] =>
  assistantBlocksFromSse(events).filter(b => b.type === 'thinking');

describe('reasoning round trip across two turns', () => {
  it('replays each reasoning item upstream with its original id, blob and exact summary strings', async () => {
    const sentInput = await runTurnTwo(assistantBlocksFromSse(await runTurnOne()));

    const reasoning = sentInput.filter(item => item?.type === 'reasoning');
    expect(reasoning).toEqual([
      {
        type: 'reasoning',
        id: ITEM_ONE.id,
        encrypted_content: ITEM_ONE.blob,
        summary: ITEM_ONE.expected.map(text => ({ type: 'summary_text', text })),
      },
      {
        type: 'reasoning',
        id: ITEM_TWO.id,
        encrypted_content: ITEM_TWO.blob,
        summary: ITEM_TWO.expected.map(text => ({ type: 'summary_text', text })),
      },
    ]);
  });

  it('never leaks the display separator into the strings it sends upstream', async () => {
    const sentInput = await runTurnTwo(assistantBlocksFromSse(await runTurnOne()));

    const summaryTexts = sentInput
      .filter(item => item?.type === 'reasoning')
      .flatMap(item => (item.summary ?? []).map((s: { text: string }) => s.text));

    expect(summaryTexts.length).toBeGreaterThan(0);
    for (const text of summaryTexts) expect(text).not.toContain('\n\n');
    // Deltas inside one summary part concatenate with nothing between them.
    expect(summaryTexts).toContain('Checking the constraints.');
  });

  it('renders uninterrupted reasoning as readable paragraphs in ONE block, whatever the item count', async () => {
    // Deliberately NOT one block per reasoning item. A block boundary between
    // two reasoning items would emit a `content_block_stop`, which is exactly
    // the regime-3 signal that kills a thinking-only turn (issue #190). So while
    // no visible content has started, consecutive reasoning items -- however
    // many -- must stay inside a single thinking block. The upstream item
    // boundaries are carried by the signature envelope, not by block structure,
    // which the outbound tests above prove is enough to rebuild both items.
    const events = await runTurnOne();
    const blocks = thinkingBlocks(events);

    expect(blocks.map(b => b.thinking)).toEqual([
      'Weighing the options.\n\nChecking the constraints.\n\nListing the files.\n\nReading the adapter.',
    ]);

    // The block boundary that does exist is the one before visible text, and it
    // must come after all the reasoning.
    const order = events
      .filter(e => e.event === 'content_block_start' || e.event === 'content_block_stop')
      .map(e => e.event === 'content_block_start' ? `start:${e.data.content_block.type}` : 'stop');
    expect(order).toEqual(['start:thinking', 'stop', 'start:text', 'stop']);
  });

  it('closes every thinking block with a non-empty signature so none is dropped on replay', async () => {
    // The SDK silently discards a reasoning part that carries neither an item id
    // nor an encrypted blob (index.js:4013-4031), so an unsigned thinking block
    // is reasoning the user paid for and never gets back.
    const blocks = thinkingBlocks(await runTurnOne());

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block.signature).not.toBe('');
  });
});
