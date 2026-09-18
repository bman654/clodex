// REVIEW HARNESS — PATCH 6's alias-resolver region over every real bundle.
//
// LAST VERIFIED: clodex main @ 6d5b2bd (PR #247 merged as e55555f, PR #250 merged as 2608576),
// against 57 cached Claude Code bundles spanning 2.1.208 → 2.1.276. Re-stamp this line whenever
// you re-run it against a newer release.
//
// The span is read from FILENAMES, not from directory names: `~/.cache/clodex-review-bundles`
// files 21 of the 57 under a directory that is not their release (`2.1.263/` alone holds
// 2.1.208 … 2.1.261), so a per-release claim taken off a directory name is wrong for over a third
// of the corpus. `versionOf()` below prefers `claude-<x.y.z>[-<hash>].js` and falls back to the
// directory only for older extractions whose filenames carry a platform and nothing else.
//
// WHAT THIS PINS NOW. PATCH 6 scopes its "is this alias already present?" test from the WHOLE
// bundle to a region, because `case"<word>":return` is not a rare string — zod's schema walker
// ships `case"union":return ...`, so an alias named `union` read as natively resolved, its case was
// never injected, its built-in postcondition could not be captured, and the whole LOCAL PATCH SET
// was abandoned. The region is spelled, at head:
//
//   RESOLVER_ANCHOR = /(case"best":\{[^{}]*\})/
//   RESOLVER_BUDGET = 2000 + ALIASES.reduce((n, a) => n + 2 * a.length + 17, 0)
//   RESOLVER_SWITCH = new RegExp('case"best":\\{[^{}]*\\}[\\s\\S]{0,' + RESOLVER_BUDGET + '}?default:return')
//   const resolver  = js.match(RESOLVER_SWITCH)?.[0] ?? ''
//
// The bound is DYNAMIC: 2000 of drift headroom plus exactly the bytes of the cases PATCH 6 itself
// injects. The harness pins three things about it —
//   * the region still binds once, in the tier resolver, on every cached build;
//   * a re-patch is IDEMPOTENT no matter how much alias text the config carries (under the old
//     FIXED 2000 it was not — that is the bug #247 fixed, preserved below as history); and
//   * what actually makes a growable bound safe is that `case"best":{` is UNIQUE, not that the
//     quantifier is lazy. See LENS 2c.
//
// The regexes below are COPIES, not imports, because they are locals inside `applyClodexPatches`
// and cannot be imported. `describe('harness copy vs. the shipped bound')` is what keeps the copy
// honest: it compares the copy's verdict against the shipped predicate's verdict, read back off a
// real patch, on inputs that DISCRIMINATE the two.
//
// HOW FAR THAT GOES, precisely — the earlier wording here ("if you change the shipped formula,
// that block reds") was an overclaim and is corrected. The pristine and already-injected inputs
// alone could NOT tell the shipped coefficients from different ones, because on every cached build
// the switch's own `default:return` is ADJACENT to the anchor: the lazy match stops at byte 0 and
// the size of the bound is never consulted. Both `+ 17` → `+ 16` and `2 * a.length` → `a.length`
// left this whole harness green. The `near the exact boundary` block was added for exactly that
// gap: it drives the region onto the boundary and one byte past it, where a shipped bound smaller
// or larger than documented flips the shipped predicate's verdict. It does so at THREE
// configurations (20 × 64, 1 × 64, 1 × 3 chars), because one configuration pins only one total —
// `1000 + Σ(2·len + 67)` also totals 4900 at 20 × 64 and passed a single-config version. Three
// independent (count, total length) rows fix the headroom, the per-alias constant and the
// per-character slope of any LINEAR formula; it is still not a proof that every conceivable
// non-linear rewrite reds.
//
// Everything here EXECUTES the real applyClodexPatches / captureBuiltInPatchProofs.
//
// Run (needs bundles: `node scripts/extract-cc-bundles.mjs`, then point REVIEW_BUNDLE_DIR at them):
//   printf "export default { test: { include: ['.claude/harnesses/*.harness.ts'], testTimeout: 600000 } };\n" \
//     > /tmp/h247.config.ts
//   export CLODEX_HOME=$(mktemp -d) CLAUDE_CODE_ENTRYPOINT=cli
//   export REVIEW_BUNDLE_DIR=~/.cache/clodex-review-bundles
//   npx vitest run --config /tmp/h247.config.ts .claude/harnesses/pr247-patch6-resolver-region-over-real-bundles.harness.ts
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyClodexPatches } from '../../src/patch-transforms.js';
import { captureBuiltInPatchProofs } from '../../src/built-in-patch-proofs.js';
import { canonicalModelAliasName } from '../../src/model-aliases.js';

const ROOT = process.env.REVIEW_BUNDLE_DIR
  ?? join(process.env.HOME ?? '', '.cache', 'clodex-review-bundles');

/** The anchor exactly as the shipped code spells it. */
const RESOLVER_ANCHOR = /(case"best":\{[^{}]*\})/;

/** Bytes of one injected `case"<a>":return "<a>";`. Grounded against real output below. */
const caseCost = (a: string) => 2 * a.length + 17;

/** The shipped bound, mirrored: 2000 of drift headroom + the bytes PATCH 6 injects itself. */
const DRIFT_HEADROOM = 2000;
const resolverBudget = (aliases: string[]) =>
  DRIFT_HEADROOM + aliases.reduce((n, a) => n + caseCost(a), 0);
const resolverSwitch = (aliases: string[]) =>
  new RegExp('case"best":\\{[^{}]*\\}[\\s\\S]{0,' + resolverBudget(aliases) + '}?default:return');

/**
 * The bound as the PRE-#247 head spelled it — a FIXED 2000 that the injected cases had to fit
 * inside. Kept ONLY to demonstrate the bug #247 fixed; nothing at head behaves this way.
 */
const FIXED_2000_SWITCH = /case"best":\{[^{}]*\}[\s\S]{0,2000}?default:return/;

const caseRe = (a: string) => new RegExp('case' + JSON.stringify(a) + ':return');

/**
 * Whole-bundle equality WITHOUT handing vitest two 36 MB strings to diff.
 *
 * `expect(twice.content).toBe(once.content)` over real bundles is not merely untidy when it fails:
 * rendering the character diff exhausted V8's heap and killed the run, which then reported
 * `Tests (204)` with NO pass/fail counts and NO failing test name. The regression these assertions
 * exist to catch — reverting #247's dynamic bound — is exactly what triggers it, so the harness was
 * silently failing to report its own headline finding. Compare length and digest first and only
 * look at bytes around the first difference, so a regression reports legibly.
 */
const fingerprint = (s: string) => `${s.length}:${createHash('sha256').update(s).digest('hex')}`;

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function expectSameBundle(actual: string, expected: string, what: string): void {
  if (fingerprint(actual) === fingerprint(expected)) return;
  const at = firstDifference(actual, expected);
  expect.fail(
    `${what}: bundles differ (length ${actual.length} vs ${expected.length}), first at offset ${at}\n`
    + `  actual  : ${JSON.stringify(actual.slice(at, at + 160))}\n`
    + `  expected: ${JSON.stringify(expected.slice(at, at + 160))}`,
  );
}

function expectDifferentBundles(actual: string, other: string, what: string): void {
  if (fingerprint(actual) !== fingerprint(other)) return;
  expect.fail(`${what}: bundles are identical (${actual.length} bytes) but were expected to differ`);
}

/**
 * The version a bundle actually IS. NOT its directory: `2.1.263/` holds 21 bundles from other
 * releases (2.1.208 … 2.1.261), so any per-version claim read off a directory name is wrong for
 * over a third of the corpus. Prefer the version embedded in the FILENAME
 * (`claude-<x.y.z>[-<hash>].js`) and fall back to the directory only for the older extractions
 * whose filenames carry a platform and nothing else (`darwin-arm64.js`).
 */
function versionOf(name: string): string {
  const [dir, file] = name.split('/');
  const m = /(\d+\.\d+\.\d+)/.exec(file ?? '') ?? /(\d+\.\d+\.\d+)/.exec(dir ?? '');
  if (!m) throw new Error(`cannot determine a Claude Code version for bundle ${name}`);
  return m[1];
}

const cmpVersion = (a: string, b: string): number => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  return x![0]! - y![0]! || x![1]! - y![1]! || x![2]! - y![2]!;
};

/**
 * `bytes` of plausible upstream churn to sit between the injected cases and `default:return`:
 * native-looking cases that no alias can collide with, no second anchor, no early `default:return`.
 */
function driftOf(bytes: number): string {
  let out = '';
  for (let i = 0; ; i++) {
    const tag = String(i).padStart(3, '0');
    const one = `case"drift${tag}":return "native${tag}";`;
    if (out.length + one.length > bytes) break;
    out += one;
  }
  const left = bytes - out.length;
  return out + (left >= 4 ? `/*${'d'.repeat(left - 4)}*/` : ';'.repeat(left));
}

/** The presence predicate as it stood BEFORE the region existed — whole bundle. */
const mainMissing = (js: string, aliases: string[]) =>
  aliases.filter(a => !caseRe(a).test(js));
/** The presence predicate as head spells it — region only, dynamic bound. */
const prMissing = (js: string, aliases: string[]) => {
  const resolver = js.match(resolverSwitch(aliases))?.[0] ?? '';
  return aliases.filter(a => !caseRe(a).test(resolver));
};
/** The same predicate under the OLD fixed bound. History only. */
const fixed2000Missing = (js: string, aliases: string[]) => {
  const resolver = js.match(FIXED_2000_SWITCH)?.[0] ?? '';
  return aliases.filter(a => !caseRe(a).test(resolver));
};

const configFor = (aliases: string[]) =>
  Object.fromEntries(aliases.map((a, i) => [`clodex:openai-oauth:m${i}`, { alias: a }]));

const occurrences = (haystack: string, needle: string) => {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
};

/**
 * The aliases the SHIPPED predicate judged missing — read back off a real `applyClodexPatches` run
 * rather than recomputed, so this is evidence about the shipped local and not a second copy of it.
 *
 * PATCH 6 emits exactly one `case"<a>":return "<a>";` per alias its `missing` filter kept, so the
 * DELTA in that string's occurrence count across the patch is the filter's verdict, one alias at a
 * time. Counting occurrences in the output alone would not do: the aliases already present in the
 * region are exactly the ones the filter DROPPED, and they are still in the output.
 */
function shippedMissing(js: string, aliases: string[]): string[] {
  const out = applyClodexPatches(js, configFor(aliases)).content;
  return aliases.filter(a => {
    const needle = `case${JSON.stringify(a)}:return ${JSON.stringify(a)};`;
    const delta = occurrences(out, needle) - occurrences(js, needle);
    expect(delta).toBeGreaterThanOrEqual(0);
    expect(delta).toBeLessThanOrEqual(1);
    return delta === 1;
  });
}

function bundles(): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const v of readdirSync(ROOT)) {
    const d = join(ROOT, v);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) if (f.endsWith('.js')) out.push({ name: `${v}/${f}`, path: join(d, f) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const BUNDLES = bundles();

/**
 * A corpus is not optional. Every lens below reads at least one real bundle, so with zero of them
 * this file would collect a pile of green-looking nothing — fail LOUDLY and say how to fix it
 * instead. (An UNDERSIZED corpus is a different matter: see `has a corpus`, which skips.)
 */
if (BUNDLES.length === 0) {
  throw new Error(
    `no Claude Code bundles under ${ROOT} — this harness cannot run vacuously.\n`
    + '  Extract them with `node scripts/extract-cc-bundles.mjs`, or point REVIEW_BUNDLE_DIR at a\n'
    + '  directory of <version>/<build>.js files.',
  );
}

/**
 * How many builds make the per-bundle sweep meaningful. Below this the sweep still RUNS — a
 * partial corpus is genuinely useful — but `has a corpus` reports a skip so nobody reads a green
 * run as "verified across every published build". 50 is roughly two years of releases; the
 * maintainer cache carries 57.
 */
const MIN_CORPUS = 50;

/** The newest bundle, used as the base for every synthetic lens. */
const BASE = BUNDLES.at(-1)!;

const CONFIG = {
  'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000, display: 'GPT-5.6 Sol' },
  'clodex:openai-oauth:gpt-5.6-luna': { alias: 'luna', display: 'GPT-5.6 Luna' },
};
const ALIASES = ['sol', 'luna'];

/**
 * `MODEL_ALIAS_PATTERN` (src/model-aliases.ts) is /^[a-z0-9][a-z0-9._-]{0,63}$/ and
 * `MAX_MODEL_CATALOG` (src/constants.ts) is 20, so the largest alias set clodex's own favorites
 * UI can hand the patcher is 20 aliases of 64 characters. NOTE: `applyClodexPatches` itself
 * enforces NEITHER cap — it only requires `/^[a-z0-9][a-z0-9._-]*(\[1m\])?$/` — so a hand-written
 * patch config can exceed this. It is the realistic ceiling, not a hard one.
 */
const MAX_LEGAL_ALIASES = Array.from({ length: 20 }, (_, i) =>
  `a${String(i).padStart(2, '0')}`.padEnd(64, 'x'));
const MAX_LEGAL_BUDGET = resolverBudget(MAX_LEGAL_ALIASES); // 2000 + 20 * 145 = 4900

/** 14 × 64 chars: 2030 bytes of cases, i.e. just past a fixed 2000 but a legal config. */
const LONG_ALIASES = MAX_LEGAL_ALIASES.slice(0, 14);

/**
 * Walk back from `case"best":{` to the enclosing `function NAME(` and return its header text.
 * Minified bundles put the whole resolver on one line, so this is text, not an AST — it is only
 * used to NAME the site and to enumerate the switch's own cases.
 */
function enclosing(js: string, at: number): { name: string; cases: string[]; head: string } {
  const pre = js.slice(Math.max(0, at - 1500), at);
  const head = pre.slice(pre.lastIndexOf('function '));
  return {
    name: head.match(/^function ([\w$]+)\(/)?.[1] ?? '<anonymous>',
    cases: [...head.matchAll(/case"([^"]+)":/g)].map(m => m[1]!),
    head,
  };
}

describe(`real bundles (${BUNDLES.length})`, () => {
  it('has a corpus', ctx => {
    // Never vacuous: zero bundles already threw at import, and this re-states it as an assertion
    // so the intent survives a refactor of the guard above.
    expect(BUNDLES.length).toBeGreaterThan(0);
    if (BUNDLES.length < MIN_CORPUS) {
      const note = `PARTIAL CORPUS: ${BUNDLES.length} bundle(s) under ${ROOT}, want >= ${MIN_CORPUS}. `
        + 'The per-bundle sweep below still ran over what is present, but a green run does NOT '
        + 'mean "verified across every published Claude Code build". Run '
        + '`node scripts/extract-cc-bundles.mjs` for more.';
      // eslint-disable-next-line no-console
      console.warn(note);
      ctx.skip();
    }
    expect(BUNDLES.length).toBeGreaterThanOrEqual(MIN_CORPUS);
  });

  for (const b of BUNDLES) {
    describe(b.name, () => {
      const js = readFileSync(b.path, 'utf8');

      it('anchor and region each bind exactly once, at the same offset, in the model resolver', () => {
        expect(js.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);
        expect(js.match(new RegExp(resolverSwitch(ALIASES).source, 'g'))).toHaveLength(1);

        const anchor = js.match(RESOLVER_ANCHOR)![0];
        const region = js.match(resolverSwitch(ALIASES))![0];
        const aAt = js.indexOf(anchor);
        const rAt = js.indexOf(region);
        expect(rAt).toBe(aAt);                                   // same span start
        expect(region.startsWith(anchor)).toBe(true);            // region is anchor + gap + tail
        expect(region.endsWith('default:return')).toBe(true);

        // The gap between the anchor and the `default:return` the region ends on.
        const gap = region.length - anchor.length - 'default:return'.length;
        expect(gap).toBe(0);                                     // pristine: default is adjacent

        // Because the gap is 0, the region is the SAME span at every budget the shipped formula
        // can produce — the lazy match stops at the adjacent `default:return` long before the
        // bound is relevant. This is what makes the size of the bound a non-event on a pristine
        // build, and it is measured, not assumed.
        expect(js.match(resolverSwitch(MAX_LEGAL_ALIASES))![0]).toBe(region);
        expect(js.match(FIXED_2000_SWITCH)![0]).toBe(region);

        // Enclosing function, and that it is the tier resolver.
        const fn = enclosing(js, aAt);
        expect(fn.head).toMatch(/switch\(/);
        expect(fn.cases).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'opusplan']);
        // The region's terminator belongs to THIS switch: no other `switch(` opens between
        // the anchor's end and it (gap is 0, so this is trivially true, asserted anyway).
        expect(region.slice(anchor.length, region.length - 'default:return'.length)).not.toMatch(/switch\(/);
      });

      it('the cases the region EXCLUDES are all reserved names an alias cannot take', () => {
        const fn = enclosing(js, js.indexOf(js.match(RESOLVER_ANCHOR)![0]));
        const RESERVED = new Set(['sonnet', 'opus', 'haiku', 'fable', 'best', 'default', 'opusplan', 'inherit']);
        for (const c of fn.cases) expect(RESERVED.has(c)).toBe(true);
        // and applyClodexPatches hard-fails on any of them as an alias
        for (const c of fn.cases) {
          expect(() => applyClodexPatches(js, { 'x:y': { alias: c } }))
            .toThrow(/reserved alias/);
        }
      });

      it('patches once per alias, inside the resolver, and is idempotent', () => {
        const out = applyClodexPatches(js, CONFIG);
        const p6 = out.results.find(r => r.name.startsWith('PATCH 6'))!;
        expect(p6.status).toBe('OK');

        for (const a of ALIASES) {
          const needle = `case${JSON.stringify(a)}:return ${JSON.stringify(a)};`;
          expect(out.content.split(needle)).toHaveLength(2);   // exactly one occurrence
        }
        // the injected cases sit between the anchor and the switch's own default
        const anchor = js.match(RESOLVER_ANCHOR)![0];
        const at = out.content.indexOf(anchor) + anchor.length;
        const injected = out.content.slice(at, at + 200);
        expect(injected.startsWith('case"sol":return "sol";case"luna":return "luna";default:return')).toBe(true);

        // built-in proofs capture cleanly
        expect(() => captureBuiltInPatchProofs(out.content, CONFIG, out.results)).not.toThrow();

        // second pass changes nothing (this is what patcher.ts's verification requires)
        const again = applyClodexPatches(out.content, CONFIG);
        expectSameBundle(again.content, out.content, `${b.name}: second pass`);
        expect(again.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('SKIP');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The copy this file carries has to mean the same thing as the shipped bound.
// ---------------------------------------------------------------------------
describe('harness copy vs. the shipped bound', () => {
  const base = readFileSync(BASE.path, 'utf8');

  it('caseCost() is the real byte cost of an injected case, not an estimate', () => {
    const anchor = base.match(RESOLVER_ANCHOR)![0];
    const out = applyClodexPatches(base, configFor(ALIASES));
    const at = out.content.indexOf(anchor) + anchor.length;
    const injected = out.content.slice(at, out.content.indexOf('default:return', at));
    expect(injected).toBe('case"sol":return "sol";case"luna":return "luna";');
    expect(injected.length).toBe(ALIASES.reduce((n, a) => n + caseCost(a), 0));
  });

  // The DISCRIMINATING input: a bundle already patched with 14 × 64-char aliases. The injected
  // cases are 2030 bytes, so the region overruns a FIXED 2000 but sits inside the dynamic bound.
  // The two copies therefore disagree here, and only one of them can match the shipped code.
  it('agrees with the shipped predicate on an input that separates the two bounds', () => {
    const cfg = configFor(LONG_ALIASES);
    const once = applyClodexPatches(base, cfg).content;

    // The old bound loses the region entirely and every alias reads as missing …
    expect(once.match(FIXED_2000_SWITCH)).toBeNull();
    expect(fixed2000Missing(once, LONG_ALIASES)).toEqual(LONG_ALIASES);
    // … while the dynamic bound still sees them all.
    expect(once.match(resolverSwitch(LONG_ALIASES))).not.toBeNull();
    expect(prMissing(once, LONG_ALIASES)).toEqual([]);

    // And the shipped code, read back off a real re-patch, sides with the dynamic bound.
    expect(shippedMissing(once, LONG_ALIASES)).toEqual([]);
  });

  it('agrees with the shipped predicate on a pristine bundle, where both bounds coincide', () => {
    expect(prMissing(base, LONG_ALIASES)).toEqual(LONG_ALIASES);
    expect(fixed2000Missing(base, LONG_ALIASES)).toEqual(LONG_ALIASES);
    expect(shippedMissing(base, LONG_ALIASES)).toEqual(LONG_ALIASES);

    expect(prMissing(base, ALIASES)).toEqual(ALIASES);
    expect(shippedMissing(base, ALIASES)).toEqual(ALIASES);
  });

  it('agrees with the shipped predicate on a PARTIALLY patched region', () => {
    // `sol` already present, `luna` not: the region-scoped predicate must report exactly `luna`.
    const half = applyClodexPatches(base, { 'clodex:openai-oauth:a': { alias: 'sol' } }).content;
    expect(prMissing(half, ALIASES)).toEqual(['luna']);
    expect(shippedMissing(half, ALIASES)).toEqual(['luna']);
  });

  /**
   * THE NEAR-BOUNDARY DIFFERENTIAL — what makes the rest of this block mean anything.
   *
   * Every input above is either pristine (the switch's own `default:return` is ADJACENT to the
   * anchor on every cached build, so the lazy match stops at byte 0 and the bound is never
   * consulted) or already-injected text with thousands of bytes of slack. On all of them any
   * coefficient agrees with any other, so the block could not tell the shipped formula from a
   * different one: `+ 17` → `+ 16` and `2 * a.length` → `a.length` both left it fully green.
   *
   * These drive the region ONTO the boundary — the bytes PATCH 6 really injected plus exactly the
   * documented headroom — and one byte past it, at three configurations. On the boundary the
   * shipped predicate must say "present"; one byte past it, "missing". A shipped bound smaller than
   * documented flips the first; larger flips the second.
   */
  describe('near the exact boundary, where coefficients stop being interchangeable', () => {
    const anchor = base.match(RESOLVER_ANCHOR)![0];
    /** BASE with `bytes` of upstream churn between the injected cases and `default:return`. */
    const drifted = (bytes: number) =>
      base.replace(anchor + 'default:return', anchor + driftOf(bytes) + 'default:return');
    /** The gap the region has to span, in already-patched bytes. */
    const gap = (js: string) => {
      const at = js.indexOf(anchor) + anchor.length;
      return js.indexOf('default:return', at) - at;
    };

    it('the drift fixtures are exactly the size asked for, and not a second anchor', () => {
      for (const bytes of [DRIFT_HEADROOM, DRIFT_HEADROOM + 1]) {
        expect(driftOf(bytes)).toHaveLength(bytes);
        expect(driftOf(bytes)).not.toContain('default:return');
        expect(drifted(bytes).match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);
      }
    });

    // ONE configuration pins one TOTAL, not the formula: `1000 + Σ(2·len + 67)` also totals 4900
    // at 20 × 64 and passed a single-config version of this block. Three unknowns (headroom,
    // per-alias constant, per-character slope) need three configurations with independent
    // (count, total length) rows — 20 × 64, 1 × 64, 1 × 3.
    for (const [label, aliases] of [
      ['20 x 64 chars', MAX_LEGAL_ALIASES],
      ['1 x 64 chars', MAX_LEGAL_ALIASES.slice(0, 1)],
      ['1 x 3 chars', ['sol']],
    ] as const) {
      describe(label, () => {
        const cfg = configFor([...aliases]);
        /** What PATCH 6 really injected, read back off a real patch — NOT the formula under test. */
        const injected = gap(applyClodexPatches(base, cfg).content);

        it('the boundary fixture really sits on the boundary', () => {
          expect(injected).toBe(aliases.reduce(
            (n, a) => n + `case${JSON.stringify(a)}:return ${JSON.stringify(a)};`.length, 0));
          expect(gap(applyClodexPatches(drifted(DRIFT_HEADROOM), cfg).content))
            .toBe(injected + DRIFT_HEADROOM);
          expect(gap(applyClodexPatches(drifted(DRIFT_HEADROOM + 1), cfg).content))
            .toBe(injected + DRIFT_HEADROOM + 1);
        });

        it('ON the boundary both predicates say every alias is already present', () => {
          const once = applyClodexPatches(drifted(DRIFT_HEADROOM), cfg).content;
          expect(prMissing(once, [...aliases])).toEqual([]);
          expect(shippedMissing(once, [...aliases])).toEqual([]);
        });

        it('ONE BYTE past it both predicates say every alias is missing', () => {
          const once = applyClodexPatches(drifted(DRIFT_HEADROOM + 1), cfg).content;
          expect(prMissing(once, [...aliases])).toEqual(aliases);
          expect(shippedMissing(once, [...aliases])).toEqual(aliases);
        });

        it('so the re-patch is still the no-op patcher.ts demands, with the region full', () => {
          const once = applyClodexPatches(drifted(DRIFT_HEADROOM), cfg);
          const twice = applyClodexPatches(once.content, cfg);
          expectSameBundle(twice.content, once.content, `${label}: re-patch on the boundary`);
          expect(twice.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('SKIP');
          for (const a of aliases) {
            expect(twice.content.split(`case${JSON.stringify(a)}:return ${JSON.stringify(a)};`))
              .toHaveLength(2);
          }
          expect(() => captureBuiltInPatchProofs(twice.content, cfg, twice.results)).not.toThrow();
        });
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The regression PATCH 6's region fixes, and the whole-bundle-vs-region delta.
// ---------------------------------------------------------------------------
describe('regression: an alias colliding with an unrelated switch', () => {
  const base = readFileSync(BASE.path, 'utf8');

  it('a whole-bundle predicate drops the case, the region-scoped one injects it', () => {
    // zod's schema walker, verbatim shape, in the real bundle already:
    expect(base).toMatch(/case"union":return/);
    expect(mainMissing(base, ['union'])).toEqual([]);       // whole bundle: "already present" -> dropped
    expect(prMissing(base, ['union'])).toEqual(['union']);  // region: missing -> injected
    expect(shippedMissing(base, ['union'])).toEqual(['union']);

    const cfg = { 'clodex:openai-oauth:m': { alias: 'union' } };
    const out = applyClodexPatches(base, cfg);
    expect(out.content).toContain('case"union":return "union";');
    expect(() => captureBuiltInPatchProofs(out.content, cfg, out.results)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// LENS 1 — the `?? ''` fallback. What drift produces it, and what it costs.
// ---------------------------------------------------------------------------
describe('LENS 1: RESOLVER_SWITCH fails while RESOLVER_ANCHOR still matches', () => {
  const base = readFileSync(BASE.path, 'utf8');
  const anchor = base.match(RESOLVER_ANCHOR)![0];

  /** Drift A: upstream wraps the default body in a block -> `default:{return …}`. */
  const driftA = base.replace(anchor + 'default:return', anchor + 'default:{return');
  /**
   * Drift B: upstream inserts a case whose body overruns the budget. The filler is derived from
   * the DYNAMIC budget for this config, so it stays an overrun if the formula changes.
   */
  const pairs = Math.ceil((resolverBudget(ALIASES) + 100) / 2);
  const filler = 'case"x":{let q=' + '0+'.repeat(pairs) + '0;return q}';
  const driftB = base.replace(anchor + 'default:return', anchor + filler + 'default:return');

  it('the drift fixtures really are drift', () => {
    expectDifferentBundles(driftA, base, 'drift A');
    expectDifferentBundles(driftB, base, 'drift B');
    expect(filler.length).toBeGreaterThan(resolverBudget(ALIASES));
  });

  for (const [label, drifted] of [
    ['A: default:{return', driftA],
    ['B: gap beyond the dynamic budget', driftB],
  ] as const) {
    describe(label, () => {
      it('anchor still matches, region does not -> resolver is the empty string', () => {
        expectDifferentBundles(drifted, base, label);
        expect(drifted.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);
        expect(drifted.match(resolverSwitch(ALIASES))).toBeNull();
        expect(prMissing(drifted, ALIASES)).toEqual(ALIASES); // every alias reads as missing
      });

      it('(a) FIRST patch is unaffected — output identical to a correctly-scoped run', () => {
        const out = applyClodexPatches(drifted, CONFIG);
        expect(out.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('OK');
        for (const a of ALIASES) {
          expect(out.content.split(`case${JSON.stringify(a)}:return ${JSON.stringify(a)};`)).toHaveLength(2);
        }
        expect(() => captureBuiltInPatchProofs(out.content, CONFIG, out.results)).not.toThrow();
      });

      it('(b) RE-PATCH of already-patched bytes injects DUPLICATE cases', () => {
        const once = applyClodexPatches(drifted, CONFIG);
        const twice = applyClodexPatches(once.content, CONFIG);
        expectDifferentBundles(twice.content, once.content, `${label}: re-patch`); // NOT idempotent
        expect(twice.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('OK'); // not SKIP
        expect(twice.content.split('case"sol":return "sol";')).toHaveLength(3); // two copies
      });

      it('(c) proof capture over the duplicated bytes THROWS — the local patch set is discarded', () => {
        const once = applyClodexPatches(drifted, CONFIG);
        const twice = applyClodexPatches(once.content, CONFIG);
        expect(() => captureBuiltInPatchProofs(twice.content, CONFIG, twice.results))
          .toThrow(/could not capture built-in postcondition/);
      });

      it('a whole-bundle predicate is idempotent on the same drifted bytes (this is the delta)', () => {
        const once = applyClodexPatches(drifted, CONFIG);
        // A whole-bundle predicate over the once-patched content finds nothing missing:
        expect(mainMissing(once.content, ALIASES)).toEqual([]);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// LENS 2 — the bound and the cases PATCH 6 injects into it.
//
// HISTORY: the reviewed head of #247 spelled this bound as a FIXED 2000, which the injected cases
// had to fit inside. A legal favorites config (20 aliases at the 64-char maximum is 2900 bytes)
// spent the whole bound, the region stopped matching on the PATCHED output, every alias read as
// missing, the cases went in a second time, and the built-in verification — which requires a
// re-run over patched output to be a no-op — rolled the local patch set back. That is what the
// merged fix changed, and what these tests now assert the ABSENCE of.
// ---------------------------------------------------------------------------
describe('LENS 2: the budget grows with the cases PATCH 6 injects', () => {
  const base = readFileSync(BASE.path, 'utf8');

  it('the alias text that used to overrun a fixed 2000 (history)', () => {
    const short = Array.from({ length: 20 }, (_, i) => `a${i}`);
    expect(short.reduce((s, a) => s + caseCost(a), 0)).toBeLessThan(2000);

    // MODEL_ALIAS_PATTERN is /^[a-z0-9][a-z0-9._-]{0,63}$/ — 64 chars is legal.
    expect(LONG_ALIASES.every(a => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(a))).toBe(true);
    expect(LONG_ALIASES.reduce((s, a) => s + caseCost(a), 0)).toBeGreaterThan(2000);
    // …and the largest set the favorites UI can produce is larger still.
    expect(MAX_LEGAL_ALIASES.reduce((s, a) => s + caseCost(a), 0)).toBe(2900);
  });

  it('after patching with those aliases the OLD fixed region no longer matches (the bug)', () => {
    const cfg = configFor(LONG_ALIASES);
    const once = applyClodexPatches(base, cfg);
    expect(once.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('OK');
    for (const a of LONG_ALIASES) {
      expect(once.content).toContain(`case${JSON.stringify(a)}:return ${JSON.stringify(a)};`);
    }

    expect(once.content.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);
    expect(once.content.match(FIXED_2000_SWITCH)).toBeNull();      // old bound: region lost
    expect(once.content.match(resolverSwitch(LONG_ALIASES))).not.toBeNull(); // new bound: intact
  });

  it('at head the re-run is IDEMPOTENT — no duplicate cases, no rollback', () => {
    const cfg = configFor(LONG_ALIASES);
    const once = applyClodexPatches(base, cfg);
    const twice = applyClodexPatches(once.content, cfg);

    expectSameBundle(twice.content, once.content, 're-patch at 14 x 64-char aliases');
    expect(twice.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('SKIP');
    for (const a of LONG_ALIASES) {
      expect(twice.content.split(`case${JSON.stringify(a)}:return ${JSON.stringify(a)};`)).toHaveLength(2);
    }
    expect(() => captureBuiltInPatchProofs(twice.content, cfg, twice.results)).not.toThrow();
  });

  it('idempotent at the largest alias set the favorites UI can produce, too', () => {
    const cfg = configFor(MAX_LEGAL_ALIASES);
    const once = applyClodexPatches(base, cfg);
    const twice = applyClodexPatches(once.content, cfg);
    expectSameBundle(twice.content, once.content, 're-patch at the 20 x 64-char maximum');
    expect(twice.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('SKIP');
    expect(() => captureBuiltInPatchProofs(twice.content, cfg, twice.results)).not.toThrow();
  });

  it('the drift headroom left over is exactly 2000 for every alias config', () => {
    // This is the property the dynamic bound buys: the cases PATCH 6 injects no longer eat into
    // the allowance reserved for upstream churn, whatever the config looks like.
    const rows: string[] = [];
    for (const len of [8, 16, 24, 32, 40, 48, 56, 64]) {
      for (const n of [1, 5, 10, 20]) {
        const aliases = Array.from({ length: n }, (_, i) => `a${String(i).padStart(2, '0')}`.padEnd(len, 'x'));
        const spent = aliases.reduce((s, a) => s + caseCost(a), 0);
        expect(resolverBudget(aliases) - spent).toBe(DRIFT_HEADROOM);
        rows.push(`n=${String(n).padStart(2)} len=${String(len).padStart(2)} spent=${String(spent).padStart(4)} budget=${resolverBudget(aliases)}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(rows.join('\n'));
    expect(rows).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// LENS 2b — can the region end at a FOREIGN switch's default:return?
// ---------------------------------------------------------------------------
describe('LENS 2b: lazy match reaching a different switch', () => {
  it('synthetic: it absolutely can', () => {
    const js = 'function R(e){switch(e){case"best":{return 1}default:}}'
      + 'function S(t){switch(t){case"sol":return 9;default:return null}}';
    const region = js.match(resolverSwitch(['sol']))![0];
    expect(region).toContain('case"sol":return 9;'); // foreign switch swallowed
    expect(prMissing(js, ['sol'])).toEqual([]);      // alias `sol` reads as already present
  });

  it('real bundles: the foreign margin, per release, against the budget actually in force', ctx => {
    // NOTE: this replaces an earlier claim that the next `default:return` is "always far outside
    // the 2000 bound". With a DYNAMIC budget there is no single bound to compare against, and the
    // qualified statement is weaker than the old one — see the assertions below.
    const rows = BUNDLES.map(b => {
      const js = readFileSync(b.path, 'utf8');
      const anchor = js.match(RESOLVER_ANCHOR)![0];
      const end = js.indexOf(anchor) + anchor.length;
      const i1 = js.indexOf('default:return', end);
      const i2 = js.indexOf('default:return', i1 + 1);
      return {
        name: b.name,
        version: versionOf(b.name),
        own: i1 - end,
        foreign: i2 - end,
        // Everything drift A would make the region swallow BEYOND its own default:return.
        window: js.slice(i1 + 'default:return'.length, i2),
      };
    });
    const minForeign = Math.min(...rows.map(r => r.foreign));
    const maxForeign = Math.max(...rows.map(r => r.foreign));
    const byVersion = [...new Set(rows.map(r => r.version))].sort(cmpVersion);
    // eslint-disable-next-line no-console
    console.log(
      `corpus: ${rows.length} bundles, ${byVersion[0]} -> ${byVersion.at(-1)}\n`
      + `own default:return distance — always ${[...new Set(rows.map(r => r.own))].join(',')}\n`
      + `next FOREIGN default:return — min ${minForeign}, max ${maxForeign}\n`
      + byVersion.map(v => {
        const m = [...new Set(rows.filter(r => r.version === v).map(r => r.foreign))].sort((a, b) => a - b);
        return `  ${v.padEnd(9)} foreign ${m.join(',')}`;
      }).join('\n') + '\n'
      + `budget in force: typical(${ALIASES.join(',')})=${resolverBudget(ALIASES)}  `
      + `max legal(20x64)=${MAX_LEGAL_BUDGET}`,
    );

    // (1) The reason the foreign margin does not matter today: the switch's OWN `default:return`
    //     is ADJACENT to the anchor on every cached build, so the lazy match stops there and the
    //     size of the bound is never consulted. Reaching a foreign switch needs LENS 1's drift A
    //     first.
    for (const r of rows) expect(r.own).toBe(0);

    // (2) For a realistic config the margin is comfortably outside the bound even if drift A
    //     happened tomorrow.
    expect(minForeign).toBeGreaterThan(resolverBudget(ALIASES));

    // (3) The residual exposure, stated per RELEASE rather than as one corpus-wide number, because
    //     the corpus-wide minimum (3128, on 2.1.208–2.1.211) is not representative of anything
    //     anyone runs. The margin grew across the corpus and crossed the maximal budget at
    //     2.1.257: every build from there on measures 5489–5758, all of it above 4900, so on any
    //     currently-shipping Claude Code the maximal budget cannot reach the next switch even
    //     with drift A. The builds where it could are all 2.1.252 and older.
    //
    //     A per-release claim needs the whole corpus — margins vary by two thousand bytes across
    //     releases and only the newest builds sit above 4900. Skip rather than mislead.
    if (BUNDLES.length < MIN_CORPUS) {
      // eslint-disable-next-line no-console
      console.warn(
        `PARTIAL CORPUS (${BUNDLES.length} < ${MIN_CORPUS}): not evaluating the per-release margin `
        + `claim. Smallest margin here is ${minForeign} vs. a maximal budget of ${MAX_LEGAL_BUDGET}.`,
      );
      ctx.skip();
    }
    const atRisk = rows.filter(r => r.foreign < MAX_LEGAL_BUDGET);
    const current = rows.filter(r => cmpVersion(r.version, '2.1.257') >= 0);
    expect(atRisk.length).toBeGreaterThan(0);             // the exposure is real on OLD builds …
    expect(current.length).toBeGreaterThan(0);
    for (const r of current) expect(r.foreign).toBeGreaterThan(MAX_LEGAL_BUDGET); // … and not new ones
    for (const r of atRisk) expect(cmpVersion(r.version, '2.1.257')).toBeLessThan(0);

    // (4) And on the at-risk builds the exposure is not merely small, it is CLOSED. Swallowing a
    //     foreign switch can only cost an alias its case if the swallowed text contains
    //     `case"<alias>":return` for a configured alias — and the alias PATCH 6 builds that needle
    //     from is always LOWERCASED first (`rawAlias.trim().toLowerCase()`, src/patch-transforms.ts;
    //     `canonicalModelAliasName` does the same on the config side). Every case name in every
    //     at-risk window is camelCase, so no configuration can produce a matching needle — not a
    //     favorites alias and not a hand-written patch config either, since both are lowercased on
    //     the way in. NOTE: the alias validator does NOT reject uppercase, it canonicalises it, so
    //     the lowercasing is the whole mechanism. If a future build puts an all-lowercase
    //     `case"<word>":return` in that window, this reds and the exposure becomes real.
    const swallowed = new Set<string>();
    for (const r of atRisk) {
      for (const m of r.window.matchAll(/case"([^"]*)":return/g)) swallowed.add(m[1]!);
    }
    expect([...swallowed].sort()).toEqual(['policySettings', 'projectSettings']);
    for (const name of swallowed) {
      // No alias, however spelled, canonicalises to the text in the window.
      expect(canonicalModelAliasName(name)).not.toBe(name);
    }
  });

  it('composite: drift A + a maximal alias config really does swallow the next switch', ctx => {
    // The exposure from (3) above, executed rather than argued. The bundle with the smallest
    // foreign margin is not necessarily BASE, so pick the worst one deliberately.
    let worst: { js: string; margin: number } | undefined;
    for (const b of BUNDLES) {
      const js = readFileSync(b.path, 'utf8');
      const anchor = js.match(RESOLVER_ANCHOR)![0];
      const end = js.indexOf(anchor) + anchor.length;
      const i2 = js.indexOf('default:return', js.indexOf('default:return', end) + 1);
      const margin = i2 - end;
      if (!worst || margin < worst.margin) worst = { js, margin };
    }
    if (worst!.margin >= MAX_LEGAL_BUDGET) {
      // No bundle present is close enough for any legal budget to reach its next switch, so there
      // is nothing to demonstrate. On the maintainer corpus there is.
      // eslint-disable-next-line no-console
      console.warn(
        `No bundle in this corpus has a foreign margin below the maximal legal budget `
        + `(${worst!.margin} >= ${MAX_LEGAL_BUDGET}) — nothing to demonstrate. This is expected on a `
        + 'partial corpus; on the full one the smallest margin is 3128.',
      );
      ctx.skip();
    }
    const { js, margin } = worst!;
    const anchor = js.match(RESOLVER_ANCHOR)![0];
    const drifted = js.replace(anchor + 'default:return', anchor + 'default:{return');

    // Typical config: bound is below the margin, so the region simply does not match — LENS 1's
    // already-pinned `?? ''` behaviour, which is loud (duplicate cases, then a rollback).
    expect(margin).toBeGreaterThan(resolverBudget(ALIASES));
    expect(drifted.match(resolverSwitch(ALIASES))).toBeNull();

    // Maximal config: the bound now exceeds the margin, and the region ends inside a DIFFERENT
    // switch. Nothing here is silent — an alias wrongly read as present loses its case, its
    // built-in postcondition cannot be captured, and the whole local patch set is discarded with a
    // FAIL line. What separates the two configs is the size of the bound, and what stops the wider
    // one from costing an alias anything is asserted at the end of this test.
    expect(MAX_LEGAL_BUDGET).toBeGreaterThan(margin);
    const wide = drifted.match(resolverSwitch(MAX_LEGAL_ALIASES));
    expect(wide).not.toBeNull();
    // The region now ends on the FIRST `default:return` after the drifted one — i.e. the foreign
    // switch's, exactly `margin` bytes further on (+1 for the `{` drift A inserted).
    const from = drifted.indexOf(anchor) + anchor.length;
    const foreignAt = drifted.indexOf('default:return', from);
    expect(foreignAt - from).toBe(margin + 1);
    expect(wide![0].length).toBe(anchor.length + (foreignAt - from) + 'default:return'.length);
    expect(wide![0].slice(anchor.length)).toMatch(/switch\(/); // a foreign switch is inside it

    // …and it still costs no alias its case. That rests on a CONJUNCTION — PATCH 6 lowercases an
    // alias before building its needle, AND its presence test matches case-sensitively — so it is
    // executed against the SHIPPED predicate rather than argued from the first half alone.
    //
    // The config has to be WIDE for this to mean anything. With one alias the shipped budget is
    // ~2050, short of every foreign margin in the corpus, so the region never reaches the swallowed
    // labels and "reported missing" holds whether or not matching is case-sensitive. (An earlier
    // version of this check did exactly that, and stayed green under a case-insensitive mutation.)
    // Padding with 19 maximal aliases lifts the budget past the margin.
    const swallowed = [...wide![0].matchAll(/case"([^"]*)":return/g)].map(m => m[1]!);
    expect(swallowed.length).toBeGreaterThan(0);
    for (const name of swallowed) {
      const alias = canonicalModelAliasName(name);
      expect(alias).not.toBe(name);
      const wideAliases = [...MAX_LEGAL_ALIASES.slice(0, -1), alias];
      expect(resolverBudget(wideAliases)).toBeGreaterThan(margin + 1);

      // Control: spelled EXACTLY as the alias, the same label IS read as present — proof that the
      // shipped region, at this config, really reaches it.
      // Rewrite the occurrence INSIDE the region only; the label also appears elsewhere in the bundle.
      const label = `case${JSON.stringify(name)}:return`;
      const inRegion = drifted.indexOf(label, from);
      expect(inRegion).toBeGreaterThan(from);
      expect(inRegion).toBeLessThan(foreignAt);
      const lowered = drifted.slice(0, inRegion) + `case${JSON.stringify(alias)}:return`
        + drifted.slice(inRegion + label.length);
      expect(shippedMissing(lowered, wideAliases)).not.toContain(alias);

      // The real bytes: camelCase label, lowercase needle, case-sensitive match -> still missing.
      expect(shippedMissing(drifted, wideAliases)).toContain(alias);
    }
  });
});

// ---------------------------------------------------------------------------
// LENS 2c — why a GROWABLE bound is safe at all.
//
// Not because the quantifier is lazy. Laziness fixes where the region ENDS only once its START is
// fixed; raising the bound can make an EARLIER `case"best":{` viable, and then both ends move. The
// load-bearing property is that the region's prefix IS the anchor, so a second viable start means a
// second anchor match — and applyOnce with `required: true` aborts the whole patch on `count > 1`.
// ---------------------------------------------------------------------------
describe('LENS 2c: a growable bound is safe because the anchor is UNIQUE', () => {
  const base = readFileSync(BASE.path, 'utf8');

  /** A decoy anchor whose own `default:return` sits ~2500 chars away: out of reach at a small
   *  budget, in reach at a large one. */
  const DECOY = 'function D(e){switch(e){case"best":{return 0}' + 'z'.repeat(2500) + 'default:return null}}';

  it('counterexample: with two anchors, raising the bound MOVES the region, both ends', () => {
    const real = 'function R(e){switch(e){case"best":{return 1}case"sol":return 9;default:return null}}';
    const js = DECOY + real;

    const small = js.match(resolverSwitch(ALIASES))!;            // budget 2048
    const large = js.match(resolverSwitch(MAX_LEGAL_ALIASES))!;  // budget 4900
    const smallAt = small.index!;
    const largeAt = large.index!;

    // Both are successful matches; the larger bound did not merely turn a miss into a hit.
    expect(smallAt).toBeGreaterThan(largeAt);                          // START moved earlier
    expect(smallAt + small[0].length).not.toBe(largeAt + large[0].length); // END moved too
    // And the alias fell out of the region — exactly the failure PATCH 6's region exists to stop.
    expect(small[0]).toContain('case"sol":return 9;');
    expect(large[0]).not.toContain('case"sol":return 9;');
    expect(prMissing(js, ['sol'])).toEqual([]);
    expect(prMissing(js, MAX_LEGAL_ALIASES.concat('sol'))).toContain('sol');
  });

  it('…which is unreachable, because two anchors abort the patch before any of that runs', () => {
    expect(DECOY.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);
    const two = DECOY + base;
    expect(two.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(2);

    expect(() => applyClodexPatches(two, CONFIG)).toThrow(/ambiguous anchor: PATCH 6/);
    // The abort does not depend on the budget: it is the anchor count, not the region, that fails.
    expect(() => applyClodexPatches(two, configFor(MAX_LEGAL_ALIASES)))
      .toThrow(/ambiguous anchor: PATCH 6/);
  });

  it('every cached bundle carries exactly one case"best":{ candidate', () => {
    for (const b of BUNDLES) {
      const js = readFileSync(b.path, 'utf8');
      expect(js.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);
      // Not just one that the anchor's `[^{}]*}` body happens to accept — one, full stop.
      expect(js.match(/case"best":\{/g)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// LENS 3 — a decoy for `case"best":{`.
// ---------------------------------------------------------------------------
describe('LENS 3: decoy for the anchor', () => {
  const base = readFileSync(BASE.path, 'utf8');

  it('a second case"best":{ makes PATCH 6 ambiguous and aborts the whole patch', () => {
    const decoy = 'function D(e){switch(e){case"best":{return 0}default:return null}}';
    expect(() => applyClodexPatches(decoy + base, CONFIG))
      .toThrow(/ambiguous anchor: PATCH 6/);
  });

  it('a decoy that REPLACES the real site binds the wrong switch — a pre-existing anchor property', () => {
    const anchor = base.match(RESOLVER_ANCHOR)![0];
    // move the real site out of the anchor's reach by breaking `case"best":{`
    const withoutReal = base.replace(anchor, anchor.replace('case"best":{', 'case"best" :{'));
    const decoy = 'function D(e){switch(e){case"best":{return 0}default:return null}}';
    const out = applyClodexPatches(decoy + withoutReal, CONFIG);
    expect(out.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('OK');
    expect(out.content.slice(0, 200)).toContain('case"sol":return "sol";'); // injected into the decoy
  });
});

// ---------------------------------------------------------------------------
// LENS 5 — upstream adds `case"sol":return X;` BEFORE case"best", user has alias `sol`.
// ---------------------------------------------------------------------------
describe('LENS 5: a native non-reserved case ahead of case"best"', () => {
  const base = readFileSync(BASE.path, 'utf8');
  const withNative = base.replace('case"best":{', 'case"sol":return NATIVE(n);case"best":{');

  it('the region excludes it — the case is injected anyway, a whole-bundle predicate would skip', () => {
    expect(prMissing(withNative, ['sol'])).toEqual(['sol']);
    expect(shippedMissing(withNative, ['sol'])).toEqual(['sol']);
    expect(mainMissing(withNative, ['sol'])).toEqual([]);
  });

  it('the injected duplicate is DEAD CODE: the earlier native case wins at runtime', () => {
    const out = applyClodexPatches(withNative, { 'clodex:p:m': { alias: 'sol' } });
    const i = out.content.indexOf('case"sol":return NATIVE(n);');
    const j = out.content.indexOf('case"sol":return "sol";');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i); // injected copy is LATER in source order
    // executable proof that the first label wins
    const fn = new Function('e', 'switch(e){case"sol":return "native";case"best":{return "b"}case"sol":return "sol";default:return null}');
    expect(fn('sol')).toBe('native');
  });

  it('a whole-bundle predicate LOSES the built-in postcondition here; the region keeps it', () => {
    const cfg = { 'clodex:p:m': { alias: 'sol' } };
    const prOut = applyClodexPatches(withNative, cfg);
    expect(() => captureBuiltInPatchProofs(prOut.content, cfg, prOut.results)).not.toThrow();

    // Under a whole-bundle predicate the case is never injected, so the proof needle is absent.
    const wholeBundleOut = withNative; // PATCH 6 would be a no-op for `sol`
    expect(wholeBundleOut).not.toContain('case"sol":return "sol";');
    expect(() => captureBuiltInPatchProofs(wholeBundleOut, cfg, [
      { status: 'OK', name: 'PATCH 6: alias resolver switch' } as never,
    ])).toThrow(/could not capture built-in postcondition/);
  });
});
