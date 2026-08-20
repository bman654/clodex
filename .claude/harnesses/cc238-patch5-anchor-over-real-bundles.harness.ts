// REVIEW HARNESS (not for merge) — Claude Code 2.1.238, PATCH 5 target identification.
//
// 2.1.238's per-platform builds gave the /model picker's choke-point function different minified
// identifiers (`(e,t,r){let n=…}` on five of the eight published builds, `(e,t,n){let r=…}` on
// linux-arm64, linux-arm64-musl and win32-arm64), and the old anchor spelled `r`/`e`/`t` out. This
// drives the REAL applyClodexPatches over every pristine bundle on this machine and measures:
//   - the whole-bundle count of the model selection PATCH 5 keys on, and that the anchor binds at
//     exactly that offset (the property that makes counting it meaningful)
//   - anchor match count and matched span
//   - that the bound function loops through Claude Code's own option appender — the helper named
//     in its loop must splice into the options list and build entries from the real
//     `{value:"sonnet"…}` / `{value:"opusplan"…}` factories. That is evidence from content rather
//     than from position, which the oracle it replaced was not: that one took "the function
//     following the built-in option factory" and blessed a competitor inserted into the gap. It is
//     NOT proof that the bound function is the picker — the evidence belongs to the appender, so
//     any other caller of the genuine appender would inherit it. What it does reject is the
//     realistic impostor, which brings its own appender.
//   - that the array pushed into is the one that function RETURNS
//   - that the patched function, EXECUTED with stubs, yields the custom entries
//   - idempotency: a second pass over the patched source changes nothing
// plus two adversarial passes over the same real bundles:
//   - the OLD anchor, asserted to miss EXACTLY linux-arm64, linux-arm64-musl and win32-arm64
//   - the strongest wrong-target attack: a competitor carrying its OWN opus/sonnet selection and
//     the exact surrounding shape, with the real picker moved out of the match by one space. The
//     anchor alone binds that competitor; PATCH 5 must refuse instead.
//
// Needs real bundles — `node scripts/extract-cc-bundles.mjs /tmp/cc-bundles` — and, like every
// harness here, a config of its own because vitest.config.ts only collects tests/:
//
//   printf "export default { test: { include: ['.claude/harnesses/**/*.harness.ts'], testTimeout: 300000 } };\n" \
//     > /tmp/harness.vitest.config.ts
//   REVIEW_BUNDLE_DIR=/tmp/cc-bundles npx vitest run --root . --config /tmp/harness.vitest.config.ts \
//     .claude/harnesses/cc238-patch5-anchor-over-real-bundles.harness.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyClodexPatches } from '../../src/patch-transforms.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';

/** The anchor as it stood before this fix — kept verbatim as the regression proof. */
const OLD_ANCHOR = /(\?\[[\w$]+,r\]:\[r\];for\(let [\w$]+ of [\w$]+\)[\w$]+\(e,[\w$]+,t\);)/;

/** The 2.1.238 builds whose picker the old anchor could not find. */
const EXPECTED_OLD_MISSES = ['linux-arm64@2.1.238', 'linux-arm64-musl@2.1.238', 'win32-arm64@2.1.238'];

/** Every build published for 2.1.238. A corpus missing any of them is not a comprehensive run. */
const REQUIRED_238 = [
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl',
  'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64',
].map(p => `${p}@2.1.238`);

const CONFIG = {
  'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000, display: 'GPT-5.6 Sol (OpenAI (ChatGPT))' },
  'clodex:openai-oauth:gpt-5.6-luna': { alias: 'luna', display: 'GPT-5.6 Luna (OpenAI (ChatGPT))' },
};

function bundles(): string[] {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.js')).sort();
}

/**
 * `<platform>@<version>` for a per-platform extraction, in either filename order, else null for a
 * host-only historical bundle. Extractions of the same release under two names are byte-identical
 * duplicates, so platform claims are asserted on this label, not on the filename.
 */
function label(file: string): string | null {
  const version = /(\d+\.\d+\.\d+)/.exec(file)?.[1];
  const platform = /(darwin|linux|win32)-(arm64|x64)(-musl)?/.exec(file)?.[0];
  return version && platform ? `${platform}@${version}` : null;
}

/** Both PATCH 5 regexes, read out of the production source so they cannot drift from it. */
function liveRegexes(): { anchor: string; selection: string } {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'patch-transforms.ts'), 'utf8');
  const selection = /const modelSelections = \[\.\.\.js\.matchAll\((\/(?:[^\n]|\\\/)+?\/)g\)\]/.exec(src);
  expect(selection, 'extracted the model-selection regex literal').toBeTruthy();
  const at = src.indexOf('applyOnce(\n        pickerSite,');
  expect(at, 'PATCH 5 applyOnce present').toBeGreaterThan(-1);
  const anchor = src.slice(at).match(/\n\s*(\/(?:[^\n]|\\\/)+?\/),\n/);
  expect(anchor, 'extracted the PATCH 5 anchor literal').toBeTruthy();
  return { anchor: anchor![1]!.slice(1, -1), selection: selection![1]!.slice(1, -1) };
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

function functionText(src: string, name: string): string | null {
  const at = src.indexOf(`function ${name}(`);
  return at < 0 ? null : enclosingFunction(src, at + 9).text;
}

/**
 * Assert from CONTENT that `builder` loops through Claude Code's own option appender: the helper it
 * names must insert into the options list and assemble entries from the built-in option factories.
 * Nothing here reads position, so a function merely inserted NEXT TO the picker cannot borrow its
 * identity — which the position-derived oracle this replaced allowed.
 *
 * Read the guarantee precisely: the evidence belongs to the appender, not to `builder`, so a
 * different function that calls the SAME appender would satisfy this too. It rejects a competitor
 * that brings its own appender; it is not a proof of picker-ness on its own.
 */
function assertIsPickerBuilder(source: string, builder: { name: string; text: string }): void {
  const appender = /for\(let ([\w$]+) of [\w$]+\)([\w$]+)\(/.exec(builder.text)?.[2];
  expect(appender, `${builder.name} loops through an appender`).toBeTruthy();
  const body = functionText(source, appender!);
  expect(body, `${appender} is a declared function`).toBeTruthy();
  expect(body!.includes('.splice('), `${appender} inserts into the options list`).toBe(true);
  const factories = [...new Set([...body!.matchAll(/([\w$]+)\(/g)].map(m => m[1]!))]
    .filter(n => n !== appender)
    .filter(n => /\{value:"(opus|sonnet|opusplan)"/.test(functionText(source, n) ?? ''));
  expect(factories.length, `${appender} builds Claude Code's own model options`).toBeGreaterThan(0);
}

describe('Claude Code 2.1.238 — PATCH 5 anchor over real pristine bundles', () => {
  const files = bundles();

  it('has every published 2.1.238 build, plus history', () => {
    expect(files.length, `set REVIEW_BUNDLE_DIR; found ${files.length}`).toBeGreaterThan(5);
    const present = new Set(files.map(label).filter(Boolean) as string[]);
    expect([...REQUIRED_238].filter(id => !present.has(id)), 'missing 2.1.238 builds').toEqual([]);
    expect(files.filter(f => label(f) === null).length, 'historical bundles').toBeGreaterThan(5);
  });

  it('counting the model selection can only mean what PATCH 5 relies on', () => {
    const { anchor, selection } = liveRegexes();
    // The anchor BEGINS with the counted selection. That is the whole argument for "exactly one
    // selection ⇒ the anchor cannot bind anywhere else".
    expect(anchor.startsWith(selection), `anchor ${anchor} must start with ${selection}`).toBe(true);
  });

  it('the OLD anchor missed exactly the three builds this fix is for', () => {
    const misses = new Set<string>();
    const unlabelled: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      if ([...source.matchAll(new RegExp(OLD_ANCHOR.source, 'g'))].length === 1) continue;
      const id = label(file);
      if (id) misses.add(id);
      else unlabelled.push(file);
    }
    // Both directions: no unexpected miss, and every claimed miss really is one.
    expect(unlabelled, 'a historical host bundle must not miss').toEqual([]);
    expect([...misses].sort()).toEqual([...EXPECTED_OLD_MISSES].sort());
  });

  for (const file of files) {
    it(`${file}: binds the one picker builder and pushes into the array it returns`, () => {
      const source = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const { anchor, selection } = liveRegexes();

      // 1. the selection is unique, the anchor matches once, and it binds THERE
      const selections = [...source.matchAll(new RegExp(selection, 'g'))];
      expect(selections.length, 'model selections in bundle').toBe(1);
      const all = [...source.matchAll(new RegExp(anchor, 'g'))];
      expect(all.length, 'anchor matches').toBe(1);
      expect(all[0]!.index, 'anchor binds at the model selection').toBe(selections[0]!.index);
      expect(all[0]![0]!.length, 'matched span').toBeLessThan(200);

      // 2. the patch reports OK and injects exactly once
      const out = applyClodexPatches(source, CONFIG);
      expect(out.results.find(r => r.name.startsWith('PATCH 5'))?.status).toBe('OK');
      const injections = [...out.content.matchAll(/\{value:"sol",label:"Sol"/g)];
      expect(injections.length, 'exactly one injection').toBe(1);

      // 3. the bound function is the picker on its own content, and the array it pushes into is
      //    the one that function returns
      const fn = enclosingFunction(out.content, injections[0]!.index!);
      assertIsPickerBuilder(out.content, fn);
      const pushVar = /\)\)([\w$]+)\.push\(_o\)/.exec(fn.text)?.[1];
      const returnVar = /return ([\w$]+)\}$/.exec(fn.text)?.[1];
      expect(pushVar, 'push target captured from the build').toBeTruthy();
      expect(pushVar, 'pushes into the array the builder returns').toBe(returnVar);

      // 4. EXECUTE the patched builder. Every free identifier is stubbed from the function's own
      //    text, so an unaccounted name is a ReferenceError rather than a vacuous pass.
      const free = [...new Set([...fn.text.matchAll(/([\w$]+)\(/g)].map(m => m[1]!))]
        .filter(n => n !== fn.name && n !== 'function' && n !== 'for' && n !== 'if');
      const build = Function(...free, `${fn.text};return ${fn.name};`)(
        ...free.map(() => (...args: unknown[]) => {
          if (args.length === 3) {
            (args[0] as { value: string }[]).push({ value: String(args[1]) });
            return undefined;
          }
          return 'opus';
        }),
      ) as (options: { value: string }[], a: unknown, b: unknown) => { value: string }[];

      const result = build([{ value: null as unknown as string }], 'ctx', 'opus');
      const values = result.map(o => o.value);
      expect(values, 'both aliases reach the picker').toEqual(expect.arrayContaining(['sol', 'luna']));
      expect(values.filter(v => v === 'sol'), 'the dedupe guard holds').toHaveLength(1);
      expect(build(result, 'ctx', 'opus').filter(o => o.value === 'sol'), 'second pass adds nothing')
        .toHaveLength(1);

      // 5. idempotent: re-patching the patched source is a SKIP, not a FAIL
      const again = applyClodexPatches(out.content, CONFIG);
      expect(again.results.find(r => r.name.startsWith('PATCH 5'))?.status).toBe('SKIP');
      expect(again.content).toBe(out.content);

      // eslint-disable-next-line no-console
      console.log(`${file}: fn=${fn.name} options=${pushVar} span=${all[0]![0]!.length}`);
    });

    it(`${file}: refuses a model-selecting twin when the picker drifts out of the match`, () => {
      const source = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const { anchor } = liveRegexes();
      const match = [...source.matchAll(new RegExp(anchor, 'g'))][0]!;

      // The strongest competitor: exact surrounding shape AND its own opus/sonnet selection,
      // inserted immediately before the real builder, whose loop is then put cosmetically out of
      // reach. This is the composition that patched the impostor and reported OK.
      const twin = 'function zzTwin(a,b,c){let d=zzCur(),f=(d==="opus"||d==="sonnet")&&d!==c?[d,c]:[c];'
        + 'for(let g of f)zzAppend(a,g,b);return a}';
      const declStart = source.lastIndexOf('function ', match.index!);
      const drifted = source.slice(0, declStart)
        + twin
        + source.slice(declStart, match.index!)
        + match[0]!.replace('for(let', 'for (let')
        + source.slice(match.index! + match[0]!.length);

      // Sanity: the anchor ALONE now binds the twin — the attack is live, not hypothetical.
      const bound = [...drifted.matchAll(new RegExp(anchor, 'g'))];
      expect(bound.length, 'the anchor alone finds one site').toBe(1);
      expect(enclosingFunction(drifted, bound[0]!.index!).name, 'and it is the twin').toBe('zzTwin');
      // And the identity oracle used above must REJECT the twin, which brings its own appender.
      // The earlier, position-derived oracle blessed it, because the twin sits where it looked.
      expect(() => assertIsPickerBuilder(drifted, enclosingFunction(drifted, bound[0]!.index!)),
        'the content oracle rejects the twin').toThrow();

      // Production must refuse rather than patch it.
      const out = applyClodexPatches(drifted, CONFIG);
      expect(out.results.find(r => r.name.startsWith('PATCH 5'))).toEqual({
        status: 'FAIL',
        name: 'PATCH 5: model picker options',
        extra: 'model selection appears 2 times (expected 1)',
      });
      expect(out.content, 'nothing was injected').not.toContain('{value:"sol",label:"Sol"');
      expect(out.content, 'the twin is left exactly as it was').toContain(twin);
      expect(out.content, 'the drifted picker is left exactly as it was')
        .toContain(match[0]!.replace('for(let', 'for (let'));
    });
  }
});
