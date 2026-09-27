import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it, vi } from 'vitest';
import {
  generateAnthropicResponse,
  streamAnthropicResponse,
  translateRequest,
  writeAnthropicStream,
} from '../src/sdk-adapter.js';
import { NonStreamContent } from '../src/non-stream-content.js';
import { createLanguageModel } from '../src/provider-factory.js';
import type { FullStreamPart } from '../src/proxy-shared.js';

// A turn Claude Code receives without streaming must carry the same reasoning
// as the same turn streamed. Claude Code asks for a non-streaming response when
// a stream fails partway, and it persists whatever that response contains: a
// response without thinking blocks drops the turn's reasoning from every later
// request in the session. DeepSeek's thinking mode requires that reasoning back
// on every request that carries tools.
//
// The route tests drive the production path end to end with only `fetch`
// replaced. The streamed leg is the reference: the non-streaming response must
// rebuild the same Anthropic content, and replaying it must send the same
// reasoning upstream. The last block holds the two builders to the same block
// rules over hand-built part sequences, including shapes (such as round-trip
// signatures) that no installed provider currently produces.

type Block = Record<string, any>;

const TOOLS = [{
  name: 'Read',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
}];

function sse(chunks: unknown[], done = false): Response {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
    + (done ? 'data: [DONE]\n\n' : '');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Rebuild the assistant content from downstream SSE the way Claude Code does. */
function blocksFromSse(raw: string): Block[] {
  const blocks = new Map<number, Block>();
  const toolJson = new Map<number, string>();
  for (const chunk of raw.split('\n\n').filter(Boolean)) {
    const [eventLine, dataLine] = chunk.split('\n');
    const event = eventLine.replace('event: ', '');
    const data = JSON.parse(dataLine.replace('data: ', ''));
    if (event === 'content_block_start') {
      const start = data.content_block;
      blocks.set(data.index, start.type === 'tool_use'
        ? { type: 'tool_use', id: start.id, name: start.name, input: {} }
        : start.type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' });
    } else if (event === 'content_block_delta') {
      const block = blocks.get(data.index)!;
      const delta = data.delta;
      if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
      else if (delta.type === 'signature_delta') block.signature = delta.signature;
      else if (delta.type === 'text_delta') block.text += delta.text;
      else if (delta.type === 'input_json_delta') {
        toolJson.set(data.index, (toolJson.get(data.index) ?? '') + delta.partial_json);
      }
    }
  }
  for (const [index, raw] of toolJson) blocks.get(index)!.input = JSON.parse(raw);
  return [...blocks.values()];
}

// ── OpenAI Responses ─────────────────────────────────────────────────────────

const OPENAI_MODEL = 'gpt-5.6-sol';

interface OpenAiItem {
  reasoning?: { id: string; blob: string; summaries: string[] };
  message?: { id: string; text: string };
  call?: { id: string; callId: string; args: string };
}

function openAiStreamChunks(items: OpenAiItem[]): unknown[] {
  const chunks: unknown[] = [
    { type: 'response.created', response: { id: 'resp_1', created_at: 0, model: OPENAI_MODEL } },
  ];
  items.forEach((item, outputIndex) => {
    if (item.reasoning) {
      const { id, blob, summaries } = item.reasoning;
      chunks.push({
        type: 'response.output_item.added', output_index: outputIndex,
        item: { type: 'reasoning', id, encrypted_content: null },
      });
      summaries.forEach((text, summaryIndex) => {
        if (summaryIndex > 0) {
          chunks.push({ type: 'response.reasoning_summary_part.added', item_id: id, summary_index: summaryIndex });
        }
        chunks.push({ type: 'response.reasoning_summary_text.delta', item_id: id, summary_index: summaryIndex, delta: text });
        chunks.push({ type: 'response.reasoning_summary_part.done', item_id: id, summary_index: summaryIndex });
      });
      chunks.push({
        type: 'response.output_item.done', output_index: outputIndex,
        item: { type: 'reasoning', id, encrypted_content: blob },
      });
    } else if (item.message) {
      const { id, text } = item.message;
      chunks.push({ type: 'response.output_item.added', output_index: outputIndex, item: { type: 'message', id } });
      chunks.push({ type: 'response.output_text.delta', item_id: id, delta: text, logprobs: [] });
      chunks.push({ type: 'response.output_item.done', output_index: outputIndex, item: { type: 'message', id } });
    } else if (item.call) {
      const { id, callId, args } = item.call;
      chunks.push({
        type: 'response.output_item.added', output_index: outputIndex,
        item: { type: 'function_call', id, call_id: callId, name: 'Read', arguments: '' },
      });
      chunks.push({ type: 'response.function_call_arguments.delta', item_id: id, output_index: outputIndex, delta: args });
      chunks.push({
        type: 'response.output_item.done', output_index: outputIndex,
        item: { type: 'function_call', id, call_id: callId, name: 'Read', arguments: args, status: 'completed' },
      });
    }
  });
  chunks.push({
    type: 'response.completed',
    response: {
      id: 'resp_1', created_at: 0, model: OPENAI_MODEL, incomplete_details: null,
      usage: {
        input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5, output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  });
  return chunks;
}

function openAiJson(items: OpenAiItem[]): unknown {
  return {
    id: 'resp_1', created_at: 0, model: OPENAI_MODEL, incomplete_details: null,
    output: items.map(item => {
      if (item.reasoning) {
        return {
          type: 'reasoning', id: item.reasoning.id, encrypted_content: item.reasoning.blob,
          summary: item.reasoning.summaries.map(text => ({ type: 'summary_text', text })),
        };
      }
      if (item.message) {
        return {
          type: 'message', role: 'assistant', id: item.message.id,
          content: [{ type: 'output_text', text: item.message.text, annotations: [], logprobs: [] }],
        };
      }
      return {
        type: 'function_call', id: item.call!.id, call_id: item.call!.callId,
        name: 'Read', arguments: item.call!.args, status: 'completed',
      };
    }),
    usage: {
      input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5, output_tokens_details: { reasoning_tokens: 4 },
    },
  };
}

const OPENAI_TURN: OpenAiItem[] = [
  { reasoning: { id: 'rs_1', blob: 'blob-one', summaries: ['Weighing the options.', 'Checking the constraints.'] } },
  { message: { id: 'msg_1', text: 'Reading the file.' } },
  { call: { id: 'fc_1', callId: 'call_1', args: '{"file_path":"/tmp/a"}' } },
];

// Reasoning between two calls: each reasoning item must still precede the call
// it produced when the turn is replayed, or the Responses API rejects it.
const OPENAI_INTERLEAVED: OpenAiItem[] = [
  { reasoning: { id: 'rs_1', blob: 'blob-one', summaries: ['First thought.'] } },
  { call: { id: 'fc_1', callId: 'call_1', args: '{"file_path":"/tmp/a"}' } },
  { reasoning: { id: 'rs_2', blob: 'blob-two', summaries: ['Second thought.'] } },
  { call: { id: 'fc_2', callId: 'call_2', args: '{"file_path":"/tmp/b"}' } },
];

function openAiParams(oauth: boolean, messages: unknown[] = [{ role: 'user', content: 'go' }]) {
  return translateRequest(
    { model: OPENAI_MODEL, messages: messages as any, tools: TOOLS as any },
    '@ai-sdk/openai',
    { openAiOAuth: oauth },
  );
}

async function openAiStreamed(items: OpenAiItem[], oauth: boolean): Promise<Block[]> {
  const provider = createOpenAI({ apiKey: 'test', fetch: async () => sse(openAiStreamChunks(items)) });
  let raw = '';
  await streamAnthropicResponse(provider.responses(OPENAI_MODEL), openAiParams(oauth), OPENAI_MODEL, c => { raw += c; });
  return blocksFromSse(raw);
}

/** The non-streaming response: OAuth collects a real stream, API-key OpenAI calls generateText. */
async function openAiNonStreamed(items: OpenAiItem[], oauth: boolean): Promise<Block[]> {
  const provider = createOpenAI({
    apiKey: 'test',
    fetch: async () => (oauth ? sse(openAiStreamChunks(items)) : json(openAiJson(items))),
  });
  const response = await generateAnthropicResponse(
    provider.responses(OPENAI_MODEL), openAiParams(oauth), OPENAI_MODEL, { forceStream: oauth },
  );
  return response.content as Block[];
}

/** Replay an assistant turn after its tool results and capture the Responses input sent upstream. */
async function openAiReplay(assistant: Block[], oauth: boolean): Promise<any[]> {
  let input: any[] = [];
  const provider = createOpenAI({
    apiKey: 'test',
    fetch: async (_url, init) => {
      input = JSON.parse(String(init?.body)).input ?? [];
      return json(openAiJson([{ message: { id: 'msg_2', text: 'ok' } }]));
    },
  });
  const toolResults = assistant
    .filter(b => b.type === 'tool_use')
    .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'contents' }));
  const params = openAiParams(oauth, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: assistant },
    { role: 'user', content: toolResults },
  ]);
  await generateAnthropicResponse(provider.responses(OPENAI_MODEL), params, OPENAI_MODEL);
  return input;
}

/**
 * The signature is an opaque envelope. A non-streamed response carries each
 * item's encrypted content on every summary where the stream carries it on the
 * last, and both rebuild the same upstream item; replay equality is the check.
 */
const withoutSignatures = (blocks: Block[]) => blocks.map(({ signature: _signature, ...rest }) => rest);

describe.each([
  { route: 'ChatGPT OAuth (collected stream)', oauth: true },
  { route: 'OpenAI API key (generateText)', oauth: false },
])('non-streaming OpenAI response via $route', ({ oauth }) => {
  it('returns the same content blocks as the streamed turn, thinking included', async () => {
    const nonStreamed = await openAiNonStreamed(OPENAI_TURN, oauth);
    expect(nonStreamed.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(withoutSignatures(nonStreamed)).toEqual(withoutSignatures(await openAiStreamed(OPENAI_TURN, oauth)));
    expect(nonStreamed[0].signature).not.toBe('');
  });

  it('sends upstream exactly what the streamed turn sends when replayed', async () => {
    const fromNonStreamed = await openAiReplay(await openAiNonStreamed(OPENAI_TURN, oauth), oauth);
    const fromStreamed = await openAiReplay(await openAiStreamed(OPENAI_TURN, oauth), oauth);
    expect(fromNonStreamed).toEqual(fromStreamed);
  });

  it('replays the original reasoning item upstream on the next request', async () => {
    const input = await openAiReplay(await openAiNonStreamed(OPENAI_TURN, oauth), oauth);
    expect(input.filter(item => item?.type === 'reasoning')).toEqual([{
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'blob-one',
      summary: [
        { type: 'summary_text', text: 'Weighing the options.' },
        { type: 'summary_text', text: 'Checking the constraints.' },
      ],
    }]);
  });

  it('keeps a reasoning item whose summary is empty, with its encrypted content', async () => {
    // The Responses API can return reasoning with no summary at all; the item
    // still has to go back so the model keeps its own chain of thought.
    const items: OpenAiItem[] = [
      { reasoning: { id: 'rs_empty', blob: 'blob-empty', summaries: [] } },
      { call: { id: 'fc_1', callId: 'call_1', args: '{"file_path":"/tmp/a"}' } },
    ];
    const nonStreamed = await openAiNonStreamed(items, oauth);
    expect(nonStreamed.map(b => b.type)).toEqual(['thinking', 'tool_use']);
    expect(nonStreamed[0].thinking).toBe('');

    const input = await openAiReplay(nonStreamed, oauth);
    expect(input.filter(item => item?.type === 'reasoning')).toEqual([{
      type: 'reasoning', id: 'rs_empty', encrypted_content: 'blob-empty', summary: [],
    }]);
    expect(input).toEqual(await openAiReplay(await openAiStreamed(items, oauth), oauth));
  });

  it('keeps each reasoning item ahead of the call it produced when reasoning and calls interleave', async () => {
    const nonStreamed = await openAiNonStreamed(OPENAI_INTERLEAVED, oauth);
    expect(nonStreamed.map(b => b.type)).toEqual(['thinking', 'tool_use', 'thinking', 'tool_use']);
    expect(withoutSignatures(nonStreamed)).toEqual(withoutSignatures(await openAiStreamed(OPENAI_INTERLEAVED, oauth)));

    const input = await openAiReplay(nonStreamed, oauth);
    const order = input
      .filter(item => item?.type === 'reasoning' || item?.type === 'function_call')
      .map(item => item.id ?? item.call_id);
    expect(order).toEqual(['rs_1', 'call_1', 'rs_2', 'call_2']);
  });
});

// ── OpenAI-compatible (DeepSeek-style reasoning_content) ─────────────────────

const COMPAT_MODEL = 'deepseek-v4-flash';

interface CompatTurn { reasoning?: string; text?: string; callId: string; args: string }

function compatStreamChunks(turn: CompatTurn): unknown[] {
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: COMPAT_MODEL };
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => ({
    ...base, choices: [{ index: 0, delta, finish_reason: null }], ...extra,
  });
  const chunks: unknown[] = [];
  if (turn.reasoning) {
    // Two deltas, so a writer that kept only the last one would be caught.
    const half = Math.floor(turn.reasoning.length / 2);
    chunks.push(chunk({ role: 'assistant', reasoning_content: turn.reasoning.slice(0, half) }));
    chunks.push(chunk({ reasoning_content: turn.reasoning.slice(half) }));
  }
  if (turn.text) chunks.push(chunk({ content: turn.text }));
  chunks.push(chunk({
    tool_calls: [{ index: 0, id: turn.callId, type: 'function', function: { name: 'Read', arguments: turn.args } }],
  }));
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  return chunks;
}

function compatJson(turn: CompatTurn): unknown {
  return {
    id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: COMPAT_MODEL,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: turn.text ?? null,
        ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
        tool_calls: [{ id: turn.callId, type: 'function', function: { name: 'Read', arguments: turn.args } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function compatModel(respond: (body: any) => Response) {
  return createOpenAICompatible({
    name: 'custom-deepseek',
    baseURL: 'https://compat.invalid/v1',
    fetch: async (_url, init) => respond(JSON.parse(String(init?.body))),
  })(COMPAT_MODEL);
}

function compatParams(messages: unknown[] = [{ role: 'user', content: 'go' }]) {
  return translateRequest(
    { model: COMPAT_MODEL, messages: messages as any, tools: TOOLS as any },
    '@ai-sdk/openai-compatible',
  );
}

async function compatStreamed(turn: CompatTurn): Promise<Block[]> {
  let raw = '';
  await streamAnthropicResponse(
    compatModel(() => sse(compatStreamChunks(turn), true)), compatParams(), COMPAT_MODEL, c => { raw += c; },
  );
  return blocksFromSse(raw);
}

async function compatNonStreamed(turn: CompatTurn): Promise<Block[]> {
  const response = await generateAnthropicResponse(
    compatModel(() => json(compatJson(turn))), compatParams(), COMPAT_MODEL,
  );
  return response.content as Block[];
}

async function compatReplay(assistant: Block[]): Promise<any[]> {
  let messages: any[] = [];
  const model = compatModel(body => {
    messages = body.messages;
    return json({
      id: 'chatcmpl-2', object: 'chat.completion', created: 0, model: COMPAT_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  const toolResults = assistant
    .filter(b => b.type === 'tool_use')
    .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'contents' }));
  await generateAnthropicResponse(model, compatParams([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: assistant },
    { role: 'user', content: toolResults },
  ]), COMPAT_MODEL);
  return messages;
}

const COMPAT_TURN: CompatTurn = {
  reasoning: 'I should list the files first.',
  text: 'Let me look.',
  callId: 'call_00_abc',
  args: '{"file_path":"/tmp/a"}',
};

describe('non-streaming OpenAI-compatible response', () => {
  it('returns the same content blocks as the streamed turn, reasoning first', async () => {
    // The SDK lists the non-streamed text before the reasoning, although the
    // model reasoned first and the stream delivers the reasoning first.
    const nonStreamed = await compatNonStreamed(COMPAT_TURN);
    expect(nonStreamed.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(nonStreamed).toEqual(await compatStreamed(COMPAT_TURN));
  });

  it('sends the reasoning back as reasoning_content on the next request', async () => {
    const messages = await compatReplay(await compatNonStreamed(COMPAT_TURN));
    const assistant = messages.find(m => m.role === 'assistant');
    expect(assistant).toMatchObject({
      reasoning_content: 'I should list the files first.',
      content: 'Let me look.',
      tool_calls: [{ id: 'call_00_abc', function: { name: 'Read' } }],
    });
  });

  it('keeps native reasoning ahead of reasoning extracted from <think> tags', async () => {
    // A model id naming a reasoning model gets the SDK's extract-reasoning
    // middleware from the provider factory. Its non-streamed result lists the
    // extracted reasoning first and the native reasoning after the text; the
    // stream delivers the native reasoning first.
    const turn = { ...COMPAT_TURN, reasoning: 'native first', text: '<think>inline second</think>answer' };
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.stream ? sse(compatStreamChunks(turn), true) : json(compatJson(turn));
    });
    try {
      const model = await createLanguageModel({
        npm: '@ai-sdk/openai-compatible', modelId: 'custom-thinking', providerId: 'custom-r1',
        baseURL: 'https://compat.invalid/v1', apiKey: 'test',
      });
      const nonStreamed = (await generateAnthropicResponse(model, compatParams(), 'custom-thinking'))
        .content as Block[];
      let raw = '';
      await streamAnthropicResponse(model, compatParams(), 'custom-thinking', c => { raw += c; });
      const streamed = blocksFromSse(raw).filter(b => b.type !== 'text' || b.text !== '');

      expect(nonStreamed.map(b => b.thinking ?? b.type)).toEqual(['native first', 'inline second', 'text', 'tool_use']);
      expect(nonStreamed).toEqual(streamed);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('adds no thinking block when the model did not reason', async () => {
    const turn = { ...COMPAT_TURN, reasoning: undefined };
    const nonStreamed = await compatNonStreamed(turn);
    expect(nonStreamed.map(b => b.type)).toEqual(['text', 'tool_use']);
    expect(nonStreamed).toEqual(await compatStreamed(turn));

    const assistant = (await compatReplay(nonStreamed)).find(m => m.role === 'assistant');
    expect(assistant.reasoning_content).toBeUndefined();
  });
});

// ── The block rules themselves ───────────────────────────────────────────────

describe('NonStreamContent follows the stream writer block for block', () => {
  const openAi = (itemId: string, encrypted: string | null = null) => ({ openai: { itemId, reasoningEncryptedContent: encrypted } });
  const CORPUS: Record<string, FullStreamPart[]> = {
    'plain reasoning, text, tool': [
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'think ' },
      { type: 'reasoning-delta', id: 'r1', text: 'more' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'hi' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: '/a' } },
    ],
    'two plain reasoning parts stay separate blocks': [
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'one' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'reasoning-start', id: 'r2' },
      { type: 'reasoning-delta', id: 'r2', text: 'two' },
      { type: 'reasoning-end', id: 'r2' },
    ],
    'round-trip signature on reasoning-end': [
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'thought' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: { google: { thoughtSignature: 'SIG' } } },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'answer' },
    ],
    'OpenAI items merge until visible output': [
      { type: 'reasoning-start', id: 'rs_1:0', providerMetadata: openAi('rs_1') },
      { type: 'reasoning-delta', id: 'rs_1:0', text: 'a', providerMetadata: openAi('rs_1') },
      { type: 'reasoning-end', id: 'rs_1:0', providerMetadata: openAi('rs_1', 'blob-1') },
      { type: 'reasoning-start', id: 'rs_2:0', providerMetadata: openAi('rs_2') },
      { type: 'reasoning-delta', id: 'rs_2:0', text: 'b', providerMetadata: openAi('rs_2') },
      { type: 'reasoning-end', id: 'rs_2:0', providerMetadata: openAi('rs_2', 'blob-2') },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: '/a' } },
      { type: 'reasoning-start', id: 'rs_3:0', providerMetadata: openAi('rs_3') },
      { type: 'reasoning-end', id: 'rs_3:0', providerMetadata: openAi('rs_3', 'blob-3') },
    ],
    'plain reasoning after an OpenAI item opens a new block': [
      { type: 'reasoning-start', id: 'rs_1:0', providerMetadata: openAi('rs_1') },
      { type: 'reasoning-delta', id: 'rs_1:0', text: 'a', providerMetadata: openAi('rs_1') },
      { type: 'reasoning-end', id: 'rs_1:0', providerMetadata: openAi('rs_1', 'blob-1') },
      { type: 'reasoning-start', id: 'r2' },
      { type: 'reasoning-delta', id: 'r2', text: 'b' },
      { type: 'reasoning-end', id: 'r2' },
    ],
    'each text-start opens its own block': [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'first' },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', text: 'second' },
    ],
    'a delta with no start still opens a block': [
      { type: 'reasoning-delta', id: 'r1', text: 'orphan thought' },
      { type: 'text-delta', id: 't1', text: 'orphan text' },
    ],
  };

  it.each(Object.keys(CORPUS))('%s', async name => {
    const parts = CORPUS[name]!;
    let raw = '';
    async function* stream() { yield* parts; yield { type: 'finish', finishReason: 'stop' } as FullStreamPart; }
    await writeAnthropicStream(stream(), 'm', chunk => { raw += chunk; });
    const streamed = blocksFromSse(raw).filter(b => b.type !== 'text' || b.text !== '');

    const content = new NonStreamContent();
    for (const part of parts) {
      if (part.type === 'tool-call') {
        content.push({ type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input });
      } else {
        content.add(part);
      }
    }
    expect(content.content()).toEqual(streamed);
  });

  it('drops a text block that stayed empty', () => {
    const content = new NonStreamContent();
    content.add({ type: 'text-start', id: 't1' });
    content.add({ type: 'text-delta', id: 't1', text: '' });
    content.push({ type: 'tool_use', id: 'c1', name: 'Read', input: {} });
    expect(content.content().map(b => b.type)).toEqual(['tool_use']);
  });
});
