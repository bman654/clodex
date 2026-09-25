// REVIEW HARNESS (not for merge) — PATCH 11, the /model picker's served-catalog path.
//
// PATCH 5 patches the LEGACY option builder. Claude Code only reaches that builder when no model
// catalog is served: the picker's entry point binds one builder's result and `??`s it with the
// other's, and on an account that IS served a catalog the first one wins, the legacy builder is
// never called, and every row PATCH 5 injected is unreachable. PATCH 11 injects at the entry point,
// where both paths converge.
//
// This drives the REAL applyClodexPatches over every pristine bundle on this machine and measures:
//   - the whole-bundle count of the PATCH 11 anchor, read out of patch-transforms.ts so it cannot
//     drift from what ships, and the matched span
//   - that the bound function is the PICKER's entry point from CONTENT: the custom-model env option
//     Claude Code itself appends to this very array is inside the same function
//   - THE LOAD-BEARING CLAIM: the identifier after `??` names the very function PATCH 5 patches —
//     which is what makes "PATCH 5's rows are unreachable on the catalog path" a fact about this
//     bundle rather than a story about a different one
//   - that the rows are pushed into the array that function RETURNS
//   - that the patched entry point, EXECUTED with stubs, yields the aliases on BOTH paths: catalog
//     served (legacy builder never called) and catalog absent (legacy builder called)
//   - that the patched bundle still parses
//   - idempotency: a second pass reports SKIP and changes nothing
//
// Needs real bundles — `node scripts/extract-cc-bundles.mjs /tmp/cc-bundles` — and, like every
// harness here, a config of its own because vitest.config.ts only collects tests/:
//
//   printf "export default { test: { include: ['.claude/harnesses/**/*.harness.ts'], testTimeout: 300000 } };\n" \
//     > /tmp/harness.vitest.config.ts
//   REVIEW_BUNDLE_DIR=/tmp/cc-bundles npx vitest run --root . --config /tmp/harness.vitest.config.ts \
//     .claude/harnesses/cc282-patch11-catalog-picker-over-real-bundles.harness.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { applyClodexPatches } from '../../src/patch-transforms.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';

const CONFIG = {
  'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000, display: 'GPT-5.6 Sol (OpenAI (ChatGPT))' },
  'clodex:openai-oauth:gpt-5.6-luna': { alias: 'luna', display: 'GPT-5.6 Luna (OpenAI (ChatGPT))' },
};

function bundles(): string[] {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.js')).sort();
}

function version(file: string): string {
  return /(\d+\.\d+\.\d+)/.exec(file)?.[1] ?? file;
}

/** PATCH 11's anchor, read out of the production source so it cannot drift from it. */
function liveAnchor(): string {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'patch-transforms.ts'), 'utf8');
  const at = src.indexOf('applyOnce(\n        catalogSite,');
  expect(at, 'PATCH 11 applyOnce present').toBeGreaterThan(-1);
  const anchor = src.slice(at).match(/\n\s*(\/(?:[^\n]|\\\/)+?\/),\n/);
  expect(anchor, 'extracted the PATCH 11 anchor literal').toBeTruthy();
  return anchor![1]!.slice(1, -1);
}

/** The enclosing `function NAME(...){...}` containing a byte offset. */
function enclosingFunction(src: string, at: number): { name: string; text: string } {
  const start = src.lastIndexOf('function ', at);
  const name = /^function ([\w$]+)\(/.exec(src.slice(start))?.[1];
  expect(name, 'sits inside a named function').toBeTruthy();
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { name: name!, text: src.slice(start, i + 1) };
  }
  throw new Error('unbalanced');
}

/**
 * Every `function NAME(...)` declaration in the bundle. Plural on purpose: the bundle is code-split
 * into ~2,000 modules and the minifier reuses names across them — `h7e` is declared three times in
 * 2.1.260 — so taking the first one reads a different module's function and proves nothing.
 */
function functionTexts(src: string, name: string): string[] {
  const texts: string[] = [];
  const needle = `function ${name}(`;
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    texts.push(enclosingFunction(src, at + 9).text);
  }
  return texts;
}

/**
 * The patched entry point, rebuilt as a standalone declaration.
 *
 * Found by PATCH 11's own marker rather than by re-running the anchor: the injected rows sit
 * between the `??` and the custom-model env read, which is inside the anchor's bounded lookahead,
 * so the anchor deliberately does NOT match its own output. (Re-patching is guarded by the marker,
 * which `applyOnce` checks before the regex.)
 */
function patchedEntryPoint(patched: string): {
  name: string; catalogFn: string; legacyFn: string; declaration: string;
} {
  const marker = patched.indexOf('/*ccpatch:picker*/');
  expect(marker, 'the patched bundle carries PATCH 11\'s marker').toBeGreaterThan(-1);
  const start = patched.lastIndexOf('function ', marker);
  const tail = patched.indexOf('.push(_o)})', marker) + '.push(_o)})'.length;
  const head = patched.slice(start, tail);
  const name = /^function ([\w$]+)\(/.exec(head)![1]!;
  const optionsVar = /let [\w$]+=[\w$]+\([^)]*\),([\w$]+)=/.exec(head)![1]!;
  return {
    name,
    catalogFn: /let [\w$]+=([\w$]+)\(/.exec(head)![1]!,
    legacyFn: /\?\?([\w$]+)\(/.exec(head)![1]!,
    // Everything after the injected rows is the real function's own work against names a harness
    // does not stub, so this is exactly what PATCH 11 is responsible for: the two builders, the
    // `??`, and the rows.
    declaration: `${head};return ${optionsVar}}`,
  };
}

describe('PATCH 11 — the picker entry point over real pristine bundles', () => {
  const files = bundles();

  it('has a corpus at all', () => {
    expect(files.length, `set REVIEW_BUNDLE_DIR; found ${files.length}`).toBeGreaterThan(5);
  });

  it('binds exactly one function per bundle, and that function is the picker entry point', () => {
    const anchor = new RegExp(liveAnchor(), 'g');
    const seen: Array<[string, string]> = [];
    for (const file of files) {
      const source = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const matches = [...source.matchAll(anchor)];
      expect(matches.length, `${file}: anchor match count`).toBe(1);

      const entry = enclosingFunction(source, matches[0]!.index!);
      // Content, not position: the env var by which Claude Code itself appends a non-catalog row
      // to this array is inside the same function.
      expect(entry.text.includes('ANTHROPIC_CUSTOM_MODEL_OPTION'), `${file}: ${entry.name} is the picker entry point`)
        .toBe(true);
      // The rows go into the array this function returns.
      const optionsVar = matches[0]![4]!;
      expect(new RegExp(`return ${optionsVar}[;}]|\\(${optionsVar},`).test(entry.text),
        `${file}: ${optionsVar} is what ${entry.name} returns or hands on`).toBe(true);
      seen.push([version(file), entry.name]);
    }
    console.log('entry point per bundle:', JSON.stringify(seen));
  });

  it('the `??` fallback IS the builder PATCH 5 patches, so the catalog path skips PATCH 5 entirely', () => {
    const anchor = new RegExp(liveAnchor(), 'g');
    for (const file of files) {
      const source = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const match = [...source.matchAll(anchor)][0]!;
      const legacy = /\?\?([\w$]+)\(/.exec(match[0])?.[1];
      expect(legacy, `${file}: named a fallback builder`).toBeTruthy();
      const bodies = functionTexts(source, legacy!);
      expect(bodies.length, `${file}: ${legacy} is a declared function`).toBeGreaterThan(0);
      // PATCH 5's own discriminator: the opus/sonnet selection that makes a function the MODEL
      // picker's choke point. The legacy builder either spells it or calls the helper that does,
      // and that helper is reachable ONLY through this `??`.
      const selection = /\(([\w$]+)==="opus"\|\|\1==="sonnet"\)/;
      const isLegacyBuilder = bodies.some(body => selection.test(body)
        || [...body.matchAll(/(?<![\w$.])([\w$]+)\(/g)]
          .map(m => m[1]!)
          .some(name => functionTexts(source, name).some(text => selection.test(text))));
      expect(isLegacyBuilder, `${file}: ${legacy} is the legacy picker builder`).toBe(true);
    }
  });

  it('applies on every bundle, parses, and is idempotent', () => {
    for (const file of files) {
      const source = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const first = applyClodexPatches(source, CONFIG);
      const site = first.results.find(r => r.name === 'PATCH 11: catalog picker options');
      expect(site, `${file}: site reported`).toEqual({ status: 'OK', name: 'PATCH 11: catalog picker options' });
      // The bundle is ESM, so it cannot be handed to `new Script` whole; parse what PATCH 11
      // actually emitted — the entry point, rebuilt as a standalone declaration.
      expect(() => new Script(patchedEntryPoint(first.content).declaration),
        `${file}: the patched entry point parses`).not.toThrow();

      const second = applyClodexPatches(first.content, CONFIG);
      expect(second.content, `${file}: re-patch is a no-op`).toBe(first.content);
      expect(second.results.find(r => r.name === 'PATCH 11: catalog picker options')?.status,
        `${file}: re-patch skips`).toBe('SKIP');
    }
  });

  it('the PATCHED entry point runs and yields the aliases whether or not a catalog is served', () => {
    for (const file of files) {
      const source = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const patched = applyClodexPatches(source, CONFIG).content;
      const { name, catalogFn, legacyFn, declaration } = patchedEntryPoint(patched);

      for (const catalog of [[{ value: 'opus' }], null]) {
        const legacyCalls: number[] = [];
        const run = new Function(catalogFn, legacyFn, `${declaration};return ${name}(false,null)`) as (
          c: () => unknown, l: () => unknown,
        ) => Array<{ value: string }>;
        const rows = run(
          () => (catalog === null ? null : catalog.map(row => ({ ...row }))),
          () => { legacyCalls.push(1); return [{ value: 'sonnet' }]; },
        );

        expect(rows.map(r => r.value), `${file}: catalog ${catalog === null ? 'absent' : 'served'}`)
          .toEqual(expect.arrayContaining(['sol', 'luna']));
        // The point of the whole patch: on the served path the builder PATCH 5 patches never runs.
        expect(legacyCalls.length, `${file}: legacy builder calls`).toBe(catalog === null ? 1 : 0);
      }
    }
  });
});
