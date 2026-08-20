// REVIEW HARNESS (not for merge) — PATCH 11 per-model auto-compact window.
//
// Drives the REAL applyClodexPatches over a REAL bundle, then EXTRACTS the
// patched auto-compact resolver and EXECUTES it. Reading a regex replacement is
// not evidence the code runs, and the fixture in tests/patcher.test.ts is a
// hand-written stand-in that cannot show the anchor bound the right function in
// a shipped bundle.
//
// Every free identifier is recovered from the resolver's own text, so a name the
// harness failed to account for surfaces as a ReferenceError rather than passing
// silently.
//
//   REVIEW_BUNDLE_DIR=<bundle dir> npx vitest run \
//     .claude/harnesses/patch11-autocompact-execute-real-resolver.harness.ts
//
// Fill the bundle dir with `node scripts/extract-cc-bundles.mjs`.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { applyClodexPatches } from '../../src/patch-transforms.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';
const MARKER = '/*ccpatch:autocompact*/';
const CONFIG = {
  'clodex:openai-oauth:gpt-5.6-sol': {
    alias: 'sol',
    display: 'GPT-5.6 Sol',
    context: 828_400,
    autoCompact: 745_560,
  },
};

function findBundle(): string | null {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return null;
  const hit = readdirSync(BUNDLE_DIR).find(f => f.endsWith('.js'));
  return hit ? join(BUNDLE_DIR, hit) : null;
}

const BUNDLE = findBundle();
const pristine = BUNDLE ? readFileSync(BUNDLE, 'utf8') : '';
const patched = pristine ? applyClodexPatches(pristine, CONFIG).content : '';

function patchedResolverSource(): string {
  const at = patched.indexOf(MARKER);
  expect(at, 'patch marker present').toBeGreaterThan(-1);
  const declStart = patched.slice(0, at).lastIndexOf('function ');
  let depth = 0;
  const open = patched.indexOf('{', declStart);
  for (let i = open; i < patched.length; i++) {
    if (patched[i] === '{') depth++;
    else if (patched[i] === '}') {
      depth--;
      if (depth === 0) return patched.slice(declStart, i + 1);
    }
  }
  throw new Error('unbalanced');
}

/**
 * The two numeric bounds the environment branch clamps against, recovered from the
 * resolver's own text. Everything else is intercepted as a callable by the scope
 * proxy below; these two are read as numbers, so a stub function would silently
 * produce NaN instead of failing.
 */
function envBounds(resolver: string): [string, string] {
  const m = resolver.match(
    /\(\s*"CLAUDE_CODE_AUTO_COMPACT_WINDOW"\s*,[^,]+,\s*([\w$]+)\s*,\s*([\w$]+)\s*\)/,
  );
  expect(m, 'could not locate the environment-branch bounds').toBeTruthy();
  return [m![1]!, m![2]!];
}

interface Resolved {
  window: number;
  configured: number;
  source: string;
}

/**
 * Execute the extracted resolver with every free identifier intercepted. `with` plus
 * a proxy whose `has` always answers true routes every unbound name here, so a name
 * this harness did not anticipate cannot fall through to a real global and pass
 * vacuously. Tail predicates answer false so the assertions isolate the injected
 * block and the two rungs that outrank it.
 */
function runResolver(
  model: string,
  configured: number | undefined,
  opts: { modelMax?: number; envWindow?: string } = {},
): Resolved {
  const resolver = patchedResolverSource();
  const [minName, maxName] = envBounds(resolver);
  const modelMax = opts.modelMax ?? 997_500;
  const known: Record<string, unknown> = {
    Math,
    Number,
    Object,
    String,
    [minName]: 100_000,
    [maxName]: 1_000_000,
    process: {
      env: opts.envWindow === undefined ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: opts.envWindow },
    },
  };
  const scope = new Proxy(known, {
    has: () => true,
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === Symbol.unscopables as unknown as string) return undefined;
      // Anything else is a call the resolver makes on its way down the chain.
      // Two args is the model-max lookup; a set-membership test answers false.
      // Self-returning so a one-argument call yields an object with the shapes the
      // tail rungs read, rather than undefined that throws before reaching them.
      const stub = (...args: unknown[]) => (args.length >= 2 ? modelMax : stub);
      stub.has = () => false;
      stub.includes = () => false;
      stub.window = null;
      stub.replacesDefault = false;
      stub.status = 'invalid';
      stub.effective = 0;
      return stub;
    },
  });

  const factory = new Function('scope', `with (scope) { return (${resolver}); }`);
  const fn = factory(scope) as (model: string, configured?: number) => Resolved;
  return fn(model, configured);
}

describe.runIf(BUNDLE_DIR)('bundle availability', () => {
  it('finds a bundle in REVIEW_BUNDLE_DIR', () => {
    expect(BUNDLE, `no *.js in ${BUNDLE_DIR}`).toBeTruthy();
  });
});

describe.skipIf(!pristine)('PATCH 11 against a real bundle, executed', () => {
  it('applies every patch site, PATCH 11 included', () => {
    const out = applyClodexPatches(pristine, CONFIG);
    expect(out.results.filter(r => r.status !== 'OK')).toEqual([]);
    expect(out.content.match(/\/\*ccpatch:autocompact\*\//g)).toHaveLength(1);
  });

  it('produces a bundle that still parses', () => {
    expect(() => new vm.Script(patched)).not.toThrow();
  });

  // The anchor must bind the auto-compact resolver, not some same-shaped sibling.
  it('binds the function that owns the auto-compact environment read', () => {
    const resolver = patchedResolverSource();
    expect(resolver).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(resolver).toContain('source:"settings"');
    // The injected table must not escape the declaring function.
    expect(patched.split('_cca').length - 1).toBe(resolver.split('_cca').length - 1);
  });

  it('returns the per-model window for a configured model', () => {
    expect(runResolver('sol', undefined)).toEqual({
      window: 745_560,
      configured: 745_560,
      source: 'model-default',
    });
  });

  it('clamps the per-model window to the model maximum', () => {
    expect(runResolver('sol', undefined, { modelMax: 300_000 }).window).toBe(300_000);
  });

  it('yields to an explicit setting', () => {
    expect(runResolver('sol', 400_000).source).toBe('settings');
  });

  it('yields to the process-wide environment override', () => {
    expect(runResolver('sol', undefined, { envWindow: '150000' }).source).not.toBe('model-default');
  });

  it('leaves an unconfigured model on its own path', () => {
    expect(runResolver('claude-opus-5', undefined).source).not.toBe('model-default');
  });

  it('matches on the canonical id as well as the alias', () => {
    expect(runResolver('clodex:openai-oauth:gpt-5.6-sol', undefined).source).toBe('model-default');
  });

  it('is case- and whitespace-insensitive on the model name', () => {
    expect(runResolver('  SOL  ', undefined).source).toBe('model-default');
  });

  // A prototype key must not resolve through the baked table.
  it('does not resolve Object.prototype keys as models', () => {
    for (const hostile of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(runResolver(hostile, undefined).source, hostile).not.toBe('model-default');
    }
  });
});
