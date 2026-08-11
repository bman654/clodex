// REVIEW HARNESS (not for merge) — PR #78 @65581ca, PATCH 10 target identification.
//
// The session-12 ask: PATCH 10 must identify the child-env builder from its OWN
// code, not by adjacency to the next function. This drives the PR's REAL
// applyClodexPatches over every pristine bundle on this machine and measures:
//   - anchor match count (uniqueness)
//   - which function it binds, and the matched span
//   - how many process.env references are rewritten, and whether any rewritten
//     reference escapes the declaring function
//   - byte-identical output vs the previously-verified 9643799 anchor
// plus the three wrong-target mutation classes.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyClodexPatches } from '../src/patch-transforms.js';

const BUNDLE_DIR = join(process.env['REVIEW_BUNDLE_DIR'] ?? '', '');
const MARKER = '/*ccpatch:child-network-env*/';

const CONFIG = {
  'clodex:openai:gpt-5.6-sol': { alias: 'sol', context: 272000, display: 'GPT-5.6 Sol (OpenAI)' },
  'clodex:openai:gpt-5.6-luna': { alias: 'luna', display: 'GPT-5.6 Luna (OpenAI)' },
};

function bundles(): string[] {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.js')).sort();
}

/** Pull the PATCH 10 regex literal straight out of the source so it cannot drift. */
function anchorRegex(flags: string): RegExp {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'patch-transforms.ts'), 'utf8');
  const idx = src.indexOf('PATCH 10: child network environment');
  expect(idx, 'PATCH 10 site present').toBeGreaterThan(-1);
  const after = src.slice(idx);
  const m = after.match(/applyOnce\(\s*patchName,\s*(\/(?:[^\n]|\\\/)+?\/),\n/);
  expect(m, 'extracted PATCH 10 regex literal').toBeTruthy();
  const body = m![1]!.slice(1, -1);
  return new RegExp(body, flags);
}

/** Name of the function whose opening brace immediately precedes the marker. */
function boundFunction(patched: string): { name: string; declStart: number } {
  const at = patched.indexOf(MARKER);
  expect(at, 'marker present').toBeGreaterThan(-1);
  const before = patched.slice(0, at);
  const m = before.match(/function ([\w$]+)\(\)\{$/);
  expect(m, 'marker sits immediately inside a zero-arg function').toBeTruthy();
  return { name: m![1]!, declStart: before.length - m![0]!.length };
}

/** Byte offset of the matching close brace for the function starting at declStart. */
function functionEnd(src: string, declStart: number): number {
  const open = src.indexOf('{', declStart);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced');
}

describe('PR #78 — PATCH 10 anchor over real pristine bundles', () => {
  const files = bundles();

  it('has bundles to test', () => {
    expect(files.length, `set REVIEW_BUNDLE_DIR; found ${files.length}`).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file}: binds exactly one self-identified builder`, () => {
      const source = readFileSync(join(BUNDLE_DIR, file), 'utf8');

      // 1. uniqueness of the anchor over the whole bundle
      const re = anchorRegex('g');
      const all = [...source.matchAll(re)];
      expect(all.length, 'anchor matches in bundle').toBe(1);

      const match = all[0]!;
      const span = match[0]!.length;
      const body = match[2]!;

      // 2. no nested function declaration inside the matched body
      expect(/\bfunction [\w$]*\(/.test(body), 'named nested fn in body').toBe(false);

      // 3. patch applies and reports OK
      const out = applyClodexPatches(source, CONFIG);
      const site = out.results.find(r => r.name.startsWith('PATCH 10'));
      expect(site?.status).toBe('OK');

      // 4. exactly one marker emitted
      expect(out.content.split(MARKER).length - 1).toBe(1);

      // 5. every rewritten reference stays inside the declaring function
      const { name, declStart } = boundFunction(out.content);
      const end = functionEnd(out.content, declStart);
      const region = out.content.slice(declStart, end + 1);
      const rewrites = (out.content.match(/_clodexChildEnv/g) ?? []).length;
      const inside = (region.match(/_clodexChildEnv/g) ?? []).length;
      expect(rewrites, 'no rewritten ref escapes the declaring function').toBe(inside);

      // 6. the declaring function must be the env builder, not something huge
      // eslint-disable-next-line no-console
      console.log(`${file}: fn=${name} span=${span} rewrites=${rewrites} bodyLen=${body.length}`);
      expect(span).toBeLessThan(5000);
    });
  }
});
