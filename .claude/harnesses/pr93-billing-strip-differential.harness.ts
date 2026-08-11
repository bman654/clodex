/**
 * PR#93 review harness (NOT for merge).
 * Differential: real translateRequest at main(827215a) vs PR head, over a
 * generated corpus, diffing canonical emitted bytes + a key census.
 */
import { describe, it, expect } from 'vitest';
import { translateRequest as headTranslate } from '../src/sdk-adapter.js';
import { translateRequest as mainTranslate } from '../src/sdk-adapter-main827215a.js';

type Body = Record<string, any>;

const BILL = 'x-anthropic-billing-header: cc_version=2.1.207.9bb; cc_entrypoint=cli; cch=AAAAA;';
const BILL2 = 'x-anthropic-billing-header: cc_version=2.1.207.9bb; cc_entrypoint=cli; cch=BBBBB;';
const SYS = 'You are Claude Code.\nFollow the user instructions.';

const TOOLS = [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

function baseBody(system: any, extra: Body = {}): Body {
  return {
    model: 'gpt-5.6-terra',
    system,
    messages: [{ role: 'user', content: 'hello' }],
    tools: TOOLS,
    max_tokens: 4096,
    ...extra,
  };
}

// ── corpus ────────────────────────────────────────────────────────────────────
const SYSTEMS: Array<[string, any]> = [
  ['undefined', undefined],
  ['null', null],
  ['empty-string', ''],
  ['string-plain', SYS],
  ['string-billing-then-newline-then-sys', `${BILL}\n${SYS}`],
  ['string-billing-only-no-newline', BILL],
  ['string-billing-trailing-newline', `${BILL}\n`],
  ['array-empty', []],
  ['array-billing-block-then-sys', [{ type: 'text', text: BILL }, { type: 'text', text: SYS }]],
  ['array-billing-block-only', [{ type: 'text', text: BILL }]],
  ['array-sys-then-billing (not first)', [{ type: 'text', text: SYS }, { type: 'text', text: BILL }]],
  ['array-two-billing-blocks', [{ type: 'text', text: BILL }, { type: 'text', text: BILL2 }, { type: 'text', text: SYS }]],
  ['array-billing-inline-newline', [{ type: 'text', text: `${BILL}\n${SYS}` }]],
  ['array-raw-strings', [BILL, SYS]],
  ['array-cachecontrol-on-billing', [{ type: 'text', text: BILL, cache_control: { type: 'ephemeral' } }, { type: 'text', text: SYS }]],
  ['array-cachecontrol-on-sys', [{ type: 'text', text: BILL }, { type: 'text', text: SYS, cache_control: { type: 'ephemeral' } }]],
  ['array-cachecontrol-both', [{ type: 'text', text: BILL, cache_control: { type: 'ephemeral' } }, { type: 'text', text: SYS, cache_control: { type: 'ephemeral' } }]],
  ['array-block-no-text', [{ type: 'text' }, { type: 'text', text: SYS }]],
  ['array-whitespace-block', [{ type: 'text', text: '   ' }, { type: 'text', text: SYS }]],
  // adversarial near-misses (must NOT be stripped)
  ['near-miss-leading-space', [{ type: 'text', text: ` ${BILL}` }, { type: 'text', text: SYS }]],
  ['near-miss-uppercase', [{ type: 'text', text: BILL.toUpperCase() }, { type: 'text', text: SYS }]],
  ['near-miss-no-colon', [{ type: 'text', text: 'x-anthropic-billing-header cc_version=1;' }, { type: 'text', text: SYS }]],
  ['near-miss-user-doc-about-header', [{ type: 'text', text: `x-anthropic-billing-header: is a header.\nDocument it carefully.` }]],
  ['near-miss-mentions-mid-block', [{ type: 'text', text: `Never emit x-anthropic-billing-header: anywhere.` }]],
];

const MODELS = ['gpt-5.6-terra', 'gpt-5.6', 'gpt-5.5', 'gpt-4.1', 'kimi-k3', 'qwen3.8-max'];
const NPMS = ['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/anthropic', '@ai-sdk/google'];
const SESSIONS: Array<[string, Body]> = [
  ['no-session', {}],
  ['with-session', { metadata: { user_id: JSON.stringify({ session_id: '3f6a1c2e-1111-4222-8333-444455556666' }) } }],
];

function canon(v: any): string {
  return JSON.stringify(v, (_k, val) => {
    if (typeof val === 'function') return `[fn ${val.name}]`;
    if (val === undefined) return '__undef__';
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]]));
    }
    return val;
  });
}

function shot(p: any) {
  return canon({
    instructions: p.instructions,
    messages: p.messages,
    allowSystemInMessages: p.allowSystemInMessages,
    toolKeys: Object.keys(p.tools ?? {}).sort(),
    toolChoice: p.toolChoice,
    maxOutputTokens: p.maxOutputTokens,
    temperature: p.temperature,
    providerOptions: p.providerOptions,
  });
}

function cases() {
  const out: Array<{ label: string; body: Body; npm: string; opts: any }> = [];
  for (const [sLabel, system] of SYSTEMS) {
    for (const model of MODELS) {
      for (const npm of NPMS) {
        for (const [sessLabel, extra] of SESSIONS) {
          for (const oauth of [true, false]) {
            out.push({
              label: `${sLabel} | ${model} | ${npm} | ${sessLabel} | oauth=${oauth}`,
              body: baseBody(system, { ...extra, model }),
              npm,
              opts: { openAiOAuth: oauth },
            });
          }
        }
      }
    }
  }
  return out;
}

describe('PR93 differential', () => {
  it('OAuth route is byte-identical between main and head', () => {
    const diffs: string[] = [];
    let n = 0;
    for (const c of cases()) {
      if (!c.opts.openAiOAuth) continue;
      n++;
      const a = shot(mainTranslate(c.body as any, c.npm, c.opts));
      const b = shot(headTranslate(c.body as any, c.npm, c.opts));
      if (a !== b) diffs.push(`${c.label}\n  main: ${a}\n  head: ${b}`);
    }
    console.log(`[oauth] compared ${n} cases; diffs=${diffs.length}`);
    if (diffs.length) console.log(diffs.slice(0, 5).join('\n---\n'));
    expect(diffs).toEqual([]);
  });

  it('census: non-OAuth diffs are exactly the billing-block removals', () => {
    const changed: string[] = [];
    const unchanged: string[] = [];
    for (const c of cases()) {
      if (c.opts.openAiOAuth) continue;
      const a = shot(mainTranslate(c.body as any, c.npm, c.opts));
      const b = shot(headTranslate(c.body as any, c.npm, c.opts));
      (a === b ? unchanged : changed).push(c.label);
    }
    console.log(`[non-oauth] changed=${changed.length} unchanged=${unchanged.length}`);
    const changedSystems = new Set(changed.map(l => l.split(' | ')[0]));
    console.log('[non-oauth] system shapes that changed:', [...changedSystems].sort());
    const unchangedSystems = new Set(unchanged.map(l => l.split(' | ')[0]));
    console.log('[non-oauth] system shapes with >=1 unchanged case:', [...unchangedSystems].sort());
    expect(changed.length).toBeGreaterThan(0);
  });

  it('no near-miss system text is ever altered (over-strip check)', () => {
    const bad: string[] = [];
    for (const c of cases()) {
      if (!c.label.startsWith('near-miss')) continue;
      const a = shot(mainTranslate(c.body as any, c.npm, c.opts));
      const b = shot(headTranslate(c.body as any, c.npm, c.opts));
      if (a !== b) bad.push(`${c.label}\n  main: ${a}\n  head: ${b}`);
    }
    console.log(`[near-miss] altered=${bad.length}`);
    if (bad.length) console.log(bad.slice(0, 3).join('\n---\n'));
    expect(bad).toEqual([]);
  });

  it('OAuth never emits cache breakpoints or promptCacheOptions (head)', () => {
    const offenders: string[] = [];
    for (const c of cases()) {
      if (!c.opts.openAiOAuth) continue;
      const s = shot(headTranslate(c.body as any, c.npm, c.opts));
      if (s.includes('promptCacheBreakpoint') || s.includes('promptCacheOptions')) offenders.push(c.label);
    }
    console.log(`[oauth-breakpoints] offenders=${offenders.length}`);
    expect(offenders).toEqual([]);
  });

  it('breakpoint placement on gpt-5.6 public API: main vs head', () => {
    const rows: string[] = [];
    for (const [sLabel, system] of SYSTEMS) {
      const body = baseBody(system, { model: 'gpt-5.6' });
      const bp = (p: any) => (p.messages as any[])
        .filter(m => m.role === 'system')
        .map(m => `${JSON.stringify(String(m.content).slice(0, 28))}${m.providerOptions?.openai?.promptCacheBreakpoint ? '<BP>' : ''}`)
        .join(' , ');
      rows.push(`${sLabel}\n   main: [${bp(mainTranslate(body as any, '@ai-sdk/openai', {}))}]\n   head: [${bp(headTranslate(body as any, '@ai-sdk/openai', {}))}]`);
    }
    console.log(rows.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('inline system message positions unchanged', () => {
    const body = {
      model: 'gpt-5.6',
      system: [{ type: 'text', text: BILL }, { type: 'text', text: SYS }],
      messages: [
        { role: 'user', content: 'one' },
        { role: 'system', content: '<reminder>volatile</reminder>' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'two' },
        { role: 'system', content: '<reminder>volatile2</reminder>' },
      ],
      tools: TOOLS,
    };
    const roles = (p: any) => (p.messages as any[]).map(m => m.role).join(',');
    const m = mainTranslate(body as any, '@ai-sdk/openai', {});
    const h = headTranslate(body as any, '@ai-sdk/openai', {});
    console.log('main roles:', roles(m));
    console.log('head roles:', roles(h));
    // head drops the billing system message, so compare the tail after top-level systems
    expect(roles(h)).toBe('system,user,system,assistant,user,system');
    expect(roles(m)).toBe('system,system,user,system,assistant,user,system');
  });
});
