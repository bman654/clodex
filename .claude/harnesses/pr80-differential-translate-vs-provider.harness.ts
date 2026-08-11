import { describe, it, expect } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { translateRequest } from '../src/sdk-adapter.js';

/**
 * Differential test for PR 80.
 *
 * Question: on payloads that clodex's REAL pipeline actually produces, can
 * PR 80's compare-time strip ever change the outcome of a comparison?
 *
 * Method: generate many varied Anthropic conversations, push each through the
 * real translateRequest + the real @ai-sdk/openai responses provider, capture
 * the wire `input`, then run BOTH normalizers (main's and PR 80's) over every
 * item and diff the canonical bytes.
 */

// ── main's normalizeToolCallJson (verbatim) ──────────────────────────────────
const canonicalize = (v: any): any => Array.isArray(v) ? v.map(canonicalize)
  : (!v || typeof v !== 'object') ? v
  : Object.keys(v).sort().reduce((o: any, k) => {
      if (v[k] !== undefined) o[k] = canonicalize(v[k]);
      return o;
    }, {});
const canonicalJson = (v: any) => JSON.stringify(canonicalize(v));

function normMain(value: any): any {
  if (Array.isArray(value)) return value.map(normMain);
  if (!value || typeof value !== 'object') return value;
  const rec = value; const out: any = {};
  for (const [k, c] of Object.entries(rec)) out[k] = normMain(c);
  const jf = rec.type === 'function_call' ? 'arguments'
    : rec.type === 'custom_tool_call' ? 'input' : undefined;
  if (jf && typeof rec[jf] === 'string') {
    try { out[jf] = canonicalJson(JSON.parse(rec[jf])); } catch { /* keep exact */ }
  }
  if (rec.type === 'reasoning') {
    if (Array.isArray(rec.content) && rec.content.length === 0) delete out.content;
    if (typeof rec.encrypted_content === 'string' && rec.encrypted_content) delete out.summary;
  }
  return out;
}

// ── PR 80's normalizeToolCallJson (main + the new block) ─────────────────────
function normPr80(value: any): any {
  if (Array.isArray(value)) return value.map(normPr80);
  if (!value || typeof value !== 'object') return value;
  const rec = value; const out: any = {};
  for (const [k, c] of Object.entries(rec)) out[k] = normPr80(c);
  const jf = rec.type === 'function_call' ? 'arguments'
    : rec.type === 'custom_tool_call' ? 'input' : undefined;
  if (jf && typeof rec[jf] === 'string') {
    try { out[jf] = canonicalJson(JSON.parse(rec[jf])); } catch { /* keep exact */ }
  }
  if (
    rec.type === 'function_call' || rec.type === 'custom_tool_call'
    || rec.type === 'function_call_output' || rec.type === 'custom_tool_call_output'
    || rec.type === 'reasoning'
  ) {
    delete out.id; delete out.status; delete out.phase;
    for (const [key, child] of Object.entries(out)) { if (child == null) delete out[key]; }
  }
  if (rec.type === 'reasoning') {
    if (Array.isArray(rec.content) && rec.content.length === 0) delete out.content;
    if (typeof rec.encrypted_content === 'string' && rec.encrypted_content) delete out.summary;
  }
  return out;
}

function conv(seed: number) {
  const inputs = [
    { path: 'a.ts' },
    { path: 'b.ts', offset: null },
    { pattern: 'x', glob: null, head_limit: null },
    { command: 'ls', timeout: null, description: '' },
    { todos: [] },
    { query: 'q', allowed_domains: [], blocked_domains: [] },
    { nested: { a: null, b: [1, null, 3] }, flag: false },
    {},
  ];
  const msgs: any[] = [
    { role: 'user', content: [{ type: 'text', text: 'go ' + seed }] },
  ];
  const n = (seed % 3) + 1;
  const assistant: any[] = [];
  if (seed % 2 === 0) {
    assistant.push({ type: 'thinking', thinking: 'think ' + seed, signature: 'blob' + seed });
  }
  if (seed % 5 === 0) assistant.push({ type: 'text', text: 'preamble' });
  for (let i = 0; i < n; i += 1) {
    assistant.push({
      type: 'tool_use',
      id: 'toolu_' + seed + '_' + i + (seed % 7 === 0 ? '::ts::sig' : ''),
      name: ['Read', 'Bash', 'Grep', 'TodoWrite', 'WebSearch'][(seed + i) % 5],
      input: inputs[(seed + i) % inputs.length],
    });
  }
  msgs.push({ role: 'assistant', content: assistant });
  msgs.push({
    role: 'user',
    content: assistant.filter(b => b.type === 'tool_use').map(b => ({
      type: 'tool_result', tool_use_id: b.id,
      content: [{ type: 'text', text: 'result' }],
    })),
  });
  return msgs;
}

describe('PR80 differential: can the new strip ever change a comparison?', () => {
  it('runs the real pipeline over many conversations and diffs both normalizers', async () => {
    let captured: any;
    const stubFetch = (async (_u: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(
        'data: {"type":"response.completed","response":{"id":"r","output":[],'
        + '"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as any;
    const openai = createOpenAI({ apiKey: 'sk-t', fetch: stubFetch });
    const model = openai.responses('gpt-5.6');

    const tools = [
      { name: 'Read', description: 'r', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' } } } },
      { name: 'Bash', description: 'b', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' }, description: { type: 'string' } } } },
      { name: 'Grep', description: 'g', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' }, head_limit: { type: 'number' } } } },
      { name: 'TodoWrite', description: 't', input_schema: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] } },
      { name: 'WebSearch', description: 'w', input_schema: { type: 'object', properties: { query: { type: 'string' }, allowed_domains: { type: 'array' }, blocked_domains: { type: 'array' } } } },
    ];

    let items = 0; let typed = 0; const diffs: any[] = [];
    const seenKeys = new Set<string>();
    for (let seed = 0; seed < 60; seed += 1) {
      const body: any = { model: 'gpt-5.6', messages: conv(seed), tools, max_tokens: 32 };
      const params = translateRequest(body, '@ai-sdk/openai', { openAiOAuth: true } as any);
      const r = streamText({ model, ...(params as any), onError: () => {} });
      for await (const _ of r.stream) { /* drain */ }
      for (const item of captured.input as any[]) {
        items += 1;
        if (item && typeof item === 'object' && typeof item.type === 'string') {
          typed += 1;
          Object.keys(item).forEach(k => seenKeys.add(item.type + '.' + k));
        }
        const a = canonicalJson(normMain(item));
        const b = canonicalJson(normPr80(item));
        if (a !== b) diffs.push({ seed, a: a.slice(0, 300), b: b.slice(0, 300) });
      }
    }
    // eslint-disable-next-line no-console
    console.log(`ITEMS=${items} TYPED=${typed} DIFFS=${diffs.length}`);
    // eslint-disable-next-line no-console
    console.log('KEYS SEEN=' + JSON.stringify([...seenKeys].sort()));
    if (diffs.length) console.log('SAMPLE DIFF=' + JSON.stringify(diffs[0], null, 2));
    expect(items).toBeGreaterThan(200);
    expect(diffs.length).toBe(0);
  }, 120_000);
});
