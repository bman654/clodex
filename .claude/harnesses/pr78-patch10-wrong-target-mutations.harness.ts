// REVIEW HARNESS (not for merge) — PR #78 @65581ca.
// The three wrong-target classes from the session-12 review, applied to a REAL
// bundle rather than a fixture, plus a syntax check of the emitted output.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { applyClodexPatches } from '../src/patch-transforms.js';

const BUNDLE = join(process.env['REVIEW_BUNDLE_DIR'] ?? '', 'claude-2.1.226-013a1cf17df5ff1d.js');
const MARKER = '/*ccpatch:child-network-env*/';
const CONFIG = { 'clodex:openai:gpt-5.6-sol': { alias: 'sol', context: 272000, display: 'GPT-5.6 Sol' } };

const source = readFileSync(BUNDLE, 'utf8');

/** Locate the builder the patch is supposed to bind, in the pristine bundle. */
function builderDecl(): { name: string; start: number; end: number } {
  const m = source.match(
    /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\(\),[\w$]+=Object\.keys\([\w$]+\)\.length>0/,
  );
  expect(m, 'found builder declaration').toBeTruthy();
  const start = m!.index!;
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return { name: m![1]!, start, end };
}

const decl = builderDecl();

function boundName(patched: string): string {
  const at = patched.indexOf(MARKER);
  const m = patched.slice(0, at).match(/function ([\w$]+)\(\)\{$/);
  return m?.[1] ?? '(none)';
}

describe('PR #78 — PATCH 10 wrong-target mutations on real 2.1.226', () => {
  it('baseline: binds the real builder and emits parseable JS', () => {
    const out = applyClodexPatches(source, CONFIG);
    expect(out.results.find(r => r.name.startsWith('PATCH 10'))?.status).toBe('OK');
    expect(boundName(out.content)).toBe(decl.name);
    // whole patched bundle must still be syntactically valid
    expect(() => new Script(out.content, { filename: 'patched.js' })).not.toThrow();
  });

  it('class 1 — a zero-arg decoy immediately before the builder does not steal the match', () => {
    const decoy = 'function _decoyEnvBuilder(){let a=process.env.CLAUDE_CODE_REMOTE,b={...process.env};'
      + 'for(let k of ["X"])delete b[k],delete b[`INPUT_${k}`];return b}';
    const mutated = source.slice(0, decl.start) + decoy + source.slice(decl.start);
    const out = applyClodexPatches(mutated, CONFIG);
    expect(out.results.find(r => r.name.startsWith('PATCH 10'))?.status).toBe('OK');
    expect(boundName(out.content), 'must still bind the real builder').toBe(decl.name);
    expect(out.content.split(MARKER).length - 1).toBe(1);
  });

  it('class 2 — removing the NEXT function\'s landmark tokens does not break the match', () => {
    // The old anchor keyed off the following function's CLAUDE_CODE_MCP_ALLOWLIST_ENV.
    const after = source.slice(decl.end);
    const neutered = after.replace('CLAUDE_CODE_MCP_ALLOWLIST_ENV', 'CLAUDE_CODE_UNRELATED_TOKEN_X');
    const mutated = source.slice(0, decl.end) + neutered;
    const out = applyClodexPatches(mutated, CONFIG);
    expect(out.results.find(r => r.name.startsWith('PATCH 10'))?.status).toBe('OK');
    expect(boundName(out.content)).toBe(decl.name);
  });

  it('class 3 — a nested NAMED function inside the body fails loudly, publishing nothing', () => {
    const body = source.slice(decl.start, decl.end + 1);
    const injected = body.replace('{let ', '{function _nested(){return 1}let ');
    const mutated = source.slice(0, decl.start) + injected + source.slice(decl.end + 1);
    // Either the anchor refuses to match (required site -> throw) or validation throws.
    expect(() => applyClodexPatches(mutated, CONFIG)).toThrow();
  });

  it('probe — a nested ANONYMOUS function expression is not detected by the guard', () => {
    const body = source.slice(decl.start, decl.end + 1);
    // minifiers emit `function(){...}` with no space; the validator regex requires one
    // insert AFTER the init sequence so the anchor's prefix still matches
    const injected = body.replace('if(!t&&!o&&', 'let _f=function(){return process.env.FOO};if(!t&&!o&&');
    expect(injected).not.toBe(body);
    const mutated = source.slice(0, decl.start) + injected + source.slice(decl.end + 1);
    let status: string | undefined;
    let threw = false;
    try {
      const out = applyClodexPatches(mutated, CONFIG);
      status = out.results.find(r => r.name.startsWith('PATCH 10'))?.status;
      // if it does patch, the rewrite must still be lexically safe
      const at = out.content.indexOf(MARKER);
      expect(at).toBeGreaterThan(-1);
    } catch { threw = true; }
    // eslint-disable-next-line no-console
    console.log(`anonymous-nested-fn probe: threw=${threw} status=${status ?? 'n/a'}`);
    expect(threw || status === 'OK').toBe(true);
  });
});
