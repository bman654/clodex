import { describe, expect, it } from 'vitest';
import { translateMessages, writeAnthropicStream } from '../src/sdk-adapter.js';
import type { FullStreamPart } from '../src/proxy-shared.js';

type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string };

async function display(parts: FullStreamPart[]): Promise<ThinkingBlock[]> {
  const blocks: ThinkingBlock[] = [];
  await writeAnthropicStream((async function* () { yield* parts; })(), 'test-model', chunk => {
    const data = JSON.parse(chunk.split('\ndata: ')[1]);
    if (data.type === 'content_block_start') blocks[data.index] = data.content_block;
    if (data.type === 'content_block_delta') {
      const block = blocks[data.index];
      if (data.delta.type === 'thinking_delta') block.thinking += data.delta.thinking;
      if (data.delta.type === 'signature_delta') block.signature = data.delta.signature;
    }
  });
  return blocks;
}

const start = (id: string, itemId: string): FullStreamPart => ({
  type: 'reasoning-start', id, providerMetadata: { openai: { itemId } },
});
const delta = (id: string, text: string): FullStreamPart => ({ type: 'reasoning-delta', id, text });
const end = (id: string, itemId: string, encryptedContent?: string): FullStreamPart => ({
  type: 'reasoning-end', id,
  providerMetadata: { openai: { itemId, reasoningEncryptedContent: encryptedContent } },
});

const originalParts = [
  start('rs_a:0', 'rs_a'), delta('rs_a:0', 'First.'), end('rs_a:0', 'rs_a'),
  start('rs_a:1', 'rs_a'), delta('rs_a:1', 'Second.'), end('rs_a:1', 'rs_a', 'cipher-a'),
  start('rs_b:0', 'rs_b'), delta('rs_b:0', 'Third.'), end('rs_b:0', 'rs_b', 'cipher-b'),
];

function echo(blocks: ThinkingBlock[], npm = '@ai-sdk/openai') {
  return translateMessages([{ role: 'assistant', content: blocks }], npm);
}

const expected = [{
  role: 'assistant', content: [
    { type: 'reasoning', text: 'First.', providerOptions: { openai: { itemId: 'rs_a' } } },
    { type: 'reasoning', text: 'Second.', providerOptions: { openai: { itemId: 'rs_a', reasoningEncryptedContent: 'cipher-a' } } },
    { type: 'reasoning', text: 'Third.', providerOptions: { openai: { itemId: 'rs_b', reasoningEncryptedContent: 'cipher-b' } } },
  ],
}];

describe('OpenAI thinking round-trip metadata', () => {
  it('restores original parts, item identities and separate signatures from one display block', async () => {
    const blocks = await display(originalParts);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].thinking).toBe('First.\n\nSecond.\n\nThird.');
    // Persisted JSON is sufficient: there is no identity-keyed lookup in this echo.
    expect(echo(JSON.parse(JSON.stringify(blocks)))).toEqual(expected);
  });

  it('attributes interleaved deltas to their original parts, including late signatures', async () => {
    const blocks = await display([
      start('rs_a:0', 'rs_a'), delta('rs_a:0', 'one-'),
      start('rs_b:0', 'rs_b'), delta('rs_b:0', 'two-'),
      delta('rs_a:0', 'A'), delta('rs_b:0', 'B'),
      end('rs_a:0', 'rs_a', 'cipher-a'), end('rs_b:0', 'rs_b', 'cipher-b'),
    ]);
    expect(blocks).toHaveLength(1);
    expect(echo(blocks)).toEqual([{
      role: 'assistant', content: [
        { type: 'reasoning', text: 'one-A', providerOptions: { openai: { itemId: 'rs_a', reasoningEncryptedContent: 'cipher-a' } } },
        { type: 'reasoning', text: 'two-B', providerOptions: { openai: { itemId: 'rs_b', reasoningEncryptedContent: 'cipher-b' } } },
      ],
    }]);
  });

  it('keeps empty encrypted reasoning and whitespace-only summaries', async () => {
    const blocks = await display([
      start('rs_empty:0', 'rs_empty'), end('rs_empty:0', 'rs_empty', 'cipher-empty'),
      start('rs_space:0', 'rs_space'), delta('rs_space:0', ' \n '), end('rs_space:0', 'rs_space', 'cipher-space'),
    ]);
    expect(echo(blocks)).toEqual([{
      role: 'assistant', content: [
        { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_empty', reasoningEncryptedContent: 'cipher-empty' } } },
        { type: 'reasoning', text: ' \n ', providerOptions: { openai: { itemId: 'rs_space', reasoningEncryptedContent: 'cipher-space' } } },
      ],
    }]);
  });

  it('preserves unicode even when a surrogate pair is split across stream chunks', async () => {
    const blocks = await display([
      start('rs_a:0', 'rs_a'), delta('rs_a:0', '\ud83d'), delta('rs_a:0', '\ude80 café'),
      end('rs_a:0', 'rs_a', 'cipher-unicode'),
    ]);
    expect(echo(blocks)).toEqual([{
      role: 'assistant', content: [{
        type: 'reasoning', text: '🚀 café',
        providerOptions: { openai: { itemId: 'rs_a', reasoningEncryptedContent: 'cipher-unicode' } },
      }],
    }]);
  });

  it('restores original summaries when the client sanitizes malformed display Unicode', async () => {
    const blocks = await display([
      start('rs_a:0', 'rs_a'), delta('rs_a:0', 'Broken \ud83d char.'), end('rs_a:0', 'rs_a', 'cipher-original'),
    ]);
    // Claude Code 2.1.263 applies toWellFormed recursively to outgoing request strings.
    const sanitized = blocks.map(block => ({
      ...block, thinking: block.thinking.toWellFormed(), signature: block.signature.toWellFormed(),
    }));
    expect(echo(sanitized)).toEqual([{
      role: 'assistant', content: [{
        type: 'reasoning', text: 'Broken \ud83d char.',
        providerOptions: { openai: { itemId: 'rs_a', reasoningEncryptedContent: 'cipher-original' } },
      }],
    }]);
  });

  it('does not send our envelope as another provider’s signature on a model switch', async () => {
    const blocks = await display(originalParts);
    expect(echo(blocks, '@ai-sdk/google')).toEqual([{
      role: 'assistant', content: [{ type: 'reasoning', text: 'First.\n\nSecond.\n\nThird.' }],
    }]);
    expect(echo(blocks, '@ai-sdk/openai-compatible')).toEqual([{
      role: 'assistant', content: [{ type: 'reasoning', text: 'First.\n\nSecond.\n\nThird.' }],
    }]);
  });

  it('restores original summaries rather than edited, truncated, or missing display text', async () => {
    const [block] = await display(originalParts);
    expect(echo([{ ...block, thinking: block.thinking.replace('First', 'Other') }])).toEqual(expected);
    expect(echo([{ ...block, thinking: block.thinking.slice(0, -1) }])).toEqual(expected);
    expect(echo([{ ...block, thinking: '' }])).toEqual(expected);
  });

  it('drops malformed and unknown-version envelopes rather than forwarding them as ciphertext', () => {
    for (const signature of ['clodex:openai-thinking:v2:unknown', 'clodex:openai-thinking:v1:!!', 'clodex:openai-thinking:v1:e30']) {
      expect(echo([{ type: 'thinking', thinking: 'hello', signature }])).toEqual([]);
    }
  });

  it('rejects malformed originals instead of sending the envelope as provider ciphertext', () => {
    // Independent v1 fixture, not an envelope produced by the encoder under test.
    // A valid control prevents a reject-everything oracle.
    const signature = (parts: unknown) => 'clodex:openai-thinking:v1:' + JSON.stringify({ parts });
    const part = { itemId: 'rs_fixture', text: 'abc', encryptedContent: 'fixture-cipher' };
    const block: ThinkingBlock = { type: 'thinking', thinking: 'abc', signature: signature([part]) };
    expect(echo([block])).toEqual([{
      role: 'assistant', content: [{
        type: 'reasoning', text: 'abc',
        providerOptions: { openai: { itemId: 'rs_fixture', reasoningEncryptedContent: 'fixture-cipher' } },
      }],
    }]);
    expect(echo([{ ...block, signature: block.signature.replace(':v1:', ':v2:') }])).toEqual([]);
    const invalidParts = [
      null, {}, [], [null],
      [{ ...part, itemId: '' }], [{ ...part, itemId: 1 }],
      [{ ...part, text: null }], [{ ...part, text: 1 }], [{ ...part, text: {} }],
      [{ ...part, encryptedContent: 1 }], [{ ...part, encryptedContent: null }],
      [part, { itemId: 'rs_missing_text', encryptedContent: 'other-cipher' }],
    ];
    for (const parts of invalidParts) {
      expect(echo([{ ...block, signature: signature(parts) }]), JSON.stringify(parts)).toEqual([]);
    }
  });

  it('retains legacy raw OpenAI signatures and independent non-OpenAI thinking blocks', async () => {
    expect(echo([{ type: 'thinking', thinking: 'Legacy summary', signature: 'legacy-cipher' }])).toEqual([{
      role: 'assistant', content: [{ type: 'reasoning', text: 'Legacy summary', providerOptions: { openai: { reasoningEncryptedContent: 'legacy-cipher' } } }],
    }]);
    const blocks = await display([
      { type: 'reasoning-start', id: 'a' }, delta('a', 'Google one'),
      { type: 'reasoning-end', id: 'a', providerMetadata: { google: { thoughtSignature: 'google-one' } } },
      { type: 'reasoning-start', id: 'b' }, delta('b', 'Google two'),
      { type: 'reasoning-end', id: 'b', providerMetadata: { google: { thoughtSignature: 'google-two' } } },
    ]);
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'Google one', signature: 'google-one' },
      { type: 'thinking', thinking: 'Google two', signature: 'google-two' },
    ]);
  });
});
