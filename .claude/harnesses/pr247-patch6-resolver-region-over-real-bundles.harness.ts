// REVIEW HARNESS (PR #247) — PATCH 6's alias-resolver region over every real bundle.
//
// PR #247 scopes PATCH 6's "is this alias already present?" test from the WHOLE bundle to a region,
// because `case"<word>":return` is not a rare string — zod's schema walker ships
// `case"union":return ...`, so an alias named `union` read as natively resolved, its case was never
// injected, its built-in postcondition could not be captured, and the whole LOCAL PATCH SET was
// abandoned. The reviewed head spelled the region as:
//
//   RESOLVER_ANCHOR = /(case"best":\{[^{}]*\})/
//   RESOLVER_SWITCH = /case"best":\{[^{}]*\}[\s\S]{0,2000}?default:return/
//   const resolver  = js.match(RESOLVER_SWITCH)?.[0] ?? ''
//
// PINNED TO THAT HEAD ON PURPOSE. The regexes below are copies, not imports, because they are
// locals inside `applyClodexPatches` and cannot be imported. Review asked for the fixed `{0,2000}`
// to become a budget that accounts for the injected cases, so when #247 lands, RE-POINT the two
// constants below at whatever shipped and re-run. LENS 2 is the block that proves why the fixed
// bound was wrong; it should turn GREEN-as-idempotent once the budget is dynamic.
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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyClodexPatches } from '../../src/patch-transforms.js';
import { captureBuiltInPatchProofs } from '../../src/built-in-patch-proofs.js';

const ROOT = process.env.REVIEW_BUNDLE_DIR
  ?? join(process.env.HOME ?? '', '.cache', 'clodex-review-bundles');

/** The two regexes exactly as the PR head spells them. */
const RESOLVER_ANCHOR = /(case"best":\{[^{}]*\})/;
const RESOLVER_SWITCH = /case"best":\{[^{}]*\}[\s\S]{0,2000}?default:return/;

/** The presence predicate as it stood on `main` — whole bundle. */
const mainMissing = (js: string, aliases: string[]) =>
  aliases.filter(a => !new RegExp('case' + JSON.stringify(a) + ':return').test(js));
/** The presence predicate as this PR spells it — region only. */
const prMissing = (js: string, aliases: string[]) => {
  const resolver = js.match(RESOLVER_SWITCH)?.[0] ?? '';
  return aliases.filter(a => !new RegExp('case' + JSON.stringify(a) + ':return').test(resolver));
};

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

const CONFIG = {
  'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000, display: 'GPT-5.6 Sol' },
  'clodex:openai-oauth:gpt-5.6-luna': { alias: 'luna', display: 'GPT-5.6 Luna' },
};
const ALIASES = ['sol', 'luna'];

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
  it('has a corpus', () => { expect(BUNDLES.length).toBeGreaterThan(50); });

  for (const b of BUNDLES) {
    describe(b.name, () => {
      const js = readFileSync(b.path, 'utf8');

      it('anchor and region each bind exactly once, at the same offset, in the model resolver', () => {
        expect(js.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);
        expect(js.match(new RegExp(RESOLVER_SWITCH.source, 'g'))).toHaveLength(1);

        const anchor = js.match(RESOLVER_ANCHOR)![0];
        const region = js.match(RESOLVER_SWITCH)![0];
        const aAt = js.indexOf(anchor);
        const rAt = js.indexOf(region);
        expect(rAt).toBe(aAt);                                   // same span start
        expect(region.startsWith(anchor)).toBe(true);            // region is anchor + gap + tail
        expect(region.endsWith('default:return')).toBe(true);

        // The gap between the anchor and the `default:return` the region ends on.
        const gap = region.length - anchor.length - 'default:return'.length;
        expect(gap).toBe(0);                                     // pristine: default is adjacent

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
        expect(again.content).toBe(out.content);
        expect(again.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('SKIP');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The regression the PR fixes, and the main-vs-PR delta.
// ---------------------------------------------------------------------------
describe('regression: an alias colliding with an unrelated switch', () => {
  const base = readFileSync(BUNDLES.at(-1)!.path, 'utf8');

  it('main drops the case, the PR injects it', () => {
    // zod's schema walker, verbatim shape, in the real bundle already:
    expect(base).toMatch(/case"union":return/);
    expect(mainMissing(base, ['union'])).toEqual([]);   // main: "already present" -> dropped
    expect(prMissing(base, ['union'])).toEqual(['union']); // PR: missing -> injected

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
  const base = readFileSync(BUNDLES.at(-1)!.path, 'utf8');
  const anchor = base.match(RESOLVER_ANCHOR)![0];

  /** Drift A: upstream wraps the default body in a block -> `default:{return …}`. */
  const driftA = base.replace(anchor + 'default:return', anchor + 'default:{return');
  /** Drift B: upstream inserts a case whose body exceeds the 2000-char budget. */
  const filler = 'case"x":{let q=' + '0+'.repeat(1100) + '0;return q}';
  const driftB = base.replace(anchor + 'default:return', anchor + filler + 'default:return');

  for (const [label, drifted] of [['A: default:{return', driftA], ['B: >2000-char gap', driftB]] as const) {
    describe(label, () => {
      it('anchor still matches, region does not -> resolver is the empty string', () => {
        expect(drifted).not.toBe(base);
        expect(drifted.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);
        expect(drifted.match(RESOLVER_SWITCH)).toBeNull();
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
        expect(twice.content).not.toBe(once.content);           // NOT idempotent
        expect(twice.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('OK'); // not SKIP
        expect(twice.content.split('case"sol":return "sol";')).toHaveLength(3); // two copies
      });

      it('(c) proof capture over the duplicated bytes THROWS — the local patch set is discarded', () => {
        const once = applyClodexPatches(drifted, CONFIG);
        const twice = applyClodexPatches(once.content, CONFIG);
        expect(() => captureBuiltInPatchProofs(twice.content, CONFIG, twice.results))
          .toThrow(/could not capture built-in postcondition/);
      });

      it('main is idempotent on the same drifted bytes (this is a behaviour delta)', () => {
        const once = applyClodexPatches(drifted, CONFIG);
        // main's predicate over the once-patched content finds nothing missing:
        expect(mainMissing(once.content, ALIASES)).toEqual([]);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// LENS 2 — the {0,2000} bound, reached by clodex's OWN injected cases.
// ---------------------------------------------------------------------------
describe('LENS 2: the 2000-char budget is spent by the injected cases themselves', () => {
  const base = readFileSync(BUNDLES.at(-1)!.path, 'utf8');

  /** `case"A":return "A";` costs 2*len(A) + 17 characters. */
  const cost = (a: string) => 2 * a.length + 17;

  it('20 short aliases fit; a legal long-alias config does not', () => {
    const short = Array.from({ length: 20 }, (_, i) => `a${i}`);
    expect(short.reduce((s, a) => s + cost(a), 0)).toBeLessThan(2000);

    // MODEL_ALIAS_PATTERN is /^[a-z0-9][a-z0-9._-]{0,63}$/ — 64 chars is legal.
    const long = Array.from({ length: 14 }, (_, i) => `a${String(i).padStart(2, '0')}`.padEnd(64, 'x'));
    expect(long.every(a => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(a))).toBe(true);
    expect(long.reduce((s, a) => s + cost(a), 0)).toBeGreaterThan(2000);
  });

  it('after patching with those aliases the region no longer matches — and the re-run duplicates', () => {
    const long = Array.from({ length: 14 }, (_, i) => `a${String(i).padStart(2, '0')}`.padEnd(64, 'x'));
    const cfg = Object.fromEntries(long.map((a, i) => [`clodex:openai-oauth:m${i}`, { alias: a }]));
    const once = applyClodexPatches(base, cfg);
    expect(once.results.find(r => r.name.startsWith('PATCH 6'))!.status).toBe('OK');
    for (const a of long) expect(once.content).toContain(`case${JSON.stringify(a)}:return ${JSON.stringify(a)};`);

    // the region is now longer than the bound
    expect(once.content.match(RESOLVER_SWITCH)).toBeNull();
    expect(once.content.match(new RegExp(RESOLVER_ANCHOR.source, 'g'))).toHaveLength(1);

    // therefore the idempotency re-run duplicates every case
    const twice = applyClodexPatches(once.content, cfg);
    expect(twice.content).not.toBe(once.content);
    expect(twice.content.split(`case${JSON.stringify(long[0])}:return ${JSON.stringify(long[0])};`)).toHaveLength(3);
    expect(() => captureBuiltInPatchProofs(twice.content, cfg, twice.results))
      .toThrow(/could not capture built-in postcondition/);

    // main is idempotent on the same input
    const mainTwice = mainMissing(once.content, long);
    expect(mainTwice).toEqual([]);
  });

  it('the exact alias-count/length frontier', () => {
    const rows: string[] = [];
    for (const len of [8, 16, 24, 32, 40, 48, 56, 64]) {
      const perCase = 2 * len + 17;
      rows.push(`len=${len} perCase=${perCase} maxAliasesUnder2000=${Math.floor(2000 / perCase)}`);
    }
    // eslint-disable-next-line no-console
    console.log(rows.join('\n'));
    expect(rows).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// LENS 2b — can the region end at a FOREIGN switch's default:return?
// ---------------------------------------------------------------------------
describe('LENS 2b: lazy match reaching a different switch', () => {
  it('synthetic: it absolutely can', () => {
    const js = 'function R(e){switch(e){case"best":{return 1}default:}}'
      + 'function S(t){switch(t){case"sol":return 9;default:return null}}';
    const region = js.match(RESOLVER_SWITCH)![0];
    expect(region).toContain('case"sol":return 9;'); // foreign switch swallowed
    expect(prMissing(js, ['sol'])).toEqual([]);      // alias `sol` reads as already present
  });

  it('real bundles: the NEXT default:return is always far outside the 2000 bound', () => {
    const dists: Array<{ name: string; d2: number }> = [];
    for (const b of BUNDLES) {
      const js = readFileSync(b.path, 'utf8');
      const anchor = js.match(RESOLVER_ANCHOR)![0];
      const end = js.indexOf(anchor) + anchor.length;
      const i1 = js.indexOf('default:return', end);
      const i2 = js.indexOf('default:return', i1 + 1);
      dists.push({ name: b.name, d2: i2 - end });
    }
    const min = Math.min(...dists.map(d => d2Of(d)));
    // eslint-disable-next-line no-console
    console.log(`next foreign default:return — min ${min}, max ${Math.max(...dists.map(d2Of))}`);
    expect(min).toBeGreaterThan(2000);
    function d2Of(d: { d2: number }) { return d.d2; }
  });
});

// ---------------------------------------------------------------------------
// LENS 3 — a decoy for `case"best":{`.
// ---------------------------------------------------------------------------
describe('LENS 3: decoy for the anchor', () => {
  const base = readFileSync(BUNDLES.at(-1)!.path, 'utf8');

  it('a second case"best":{ makes PATCH 6 ambiguous and aborts the whole patch (main and PR alike)', () => {
    const decoy = 'function D(e){switch(e){case"best":{return 0}default:return null}}';
    expect(() => applyClodexPatches(decoy + base, CONFIG))
      .toThrow(/ambiguous anchor: PATCH 6/);
  });

  it('a decoy that REPLACES the real site binds the wrong switch — but that is the pre-existing anchor, unchanged by this PR', () => {
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
  const base = readFileSync(BUNDLES.at(-1)!.path, 'utf8');
  const withNative = base.replace('case"best":{', 'case"sol":return NATIVE(n);case"best":{');

  it('the region excludes it — PR injects a duplicate, main skips', () => {
    expect(prMissing(withNative, ['sol'])).toEqual(['sol']);
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

  it('main LOSES the built-in postcondition here; the PR keeps it', () => {
    const cfg = { 'clodex:p:m': { alias: 'sol' } };
    const prOut = applyClodexPatches(withNative, cfg);
    expect(() => captureBuiltInPatchProofs(prOut.content, cfg, prOut.results)).not.toThrow();

    // main's output: the case is never injected, so the proof needle is absent.
    const mainOut = withNative; // PATCH 6 would be a no-op for `sol`
    expect(mainOut).not.toContain('case"sol":return "sol";');
    expect(() => captureBuiltInPatchProofs(mainOut, cfg, [
      { status: 'OK', name: 'PATCH 6: alias resolver switch' } as never,
    ])).toThrow(/could not capture built-in postcondition/);
  });
});
