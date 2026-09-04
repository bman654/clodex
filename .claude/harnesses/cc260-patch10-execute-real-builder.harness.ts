// REVIEW HARNESS (not for merge) — Claude Code 2.1.260 PATCH 10 anchor repair.
//
// 2.1.260 rewrote the remote-mode check the head anchor ended on: through
// 2.1.259 it was `<fn>(process.env.CLAUDE_CODE_REMOTE)?`, and 2.1.260 reads the
// flag off the typed env accessor and compares it inline
// (`i=a.CLAUDE_CODE_REMOTE===!0`). PATCH 10 is required, so `clodex patch`
// refused all eight published builds.
//
// This drives the REAL applyClodexPatches over EVERY REAL 2.1.260 bundle, then
// EXTRACTS the patched builder and EXECUTES it. Reading a regex replacement is
// not evidence the code runs.
//
// `freeBindings` is a HAND-MAINTAINED table, keyed by the first-appearance index
// of each identifier token rather than by its spelling, so one reviewed table
// covers all eight builds. Know its limit: a binding is only proven present and
// correctly mapped when a scenario below REACHES it. Deleting an entry the
// scenarios never evaluate leaves this file green — measured, by deleting the
// unix-socket sentinel (index 118) and getting 170/170. The three landmark-index
// assertions and the token count catch gross drift, not that.
//
//   cat > /tmp/h260.config.ts <<'EOF'
//   import { defineConfig } from 'vitest/config';
//   export default defineConfig({ test: { include: ['.claude/harnesses/cc260-*.harness.ts'] } });
//   EOF
//   REVIEW_BUNDLE_DIR=~/.cache/clodex-review-bundles/2.1.260 pnpm vitest run --config /tmp/h260.config.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { applyClodexPatches } from '../../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../../src/network-env.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';
const MARKER = '/*ccpatch:child-network-env*/';
const CONFIG = { 'clodex:openai:gpt-5.6-sol': { alias: 'sol', display: 'GPT-5.6 Sol' } };

const PLATFORMS = [
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl',
  'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64',
];

function bundles(): string[] {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.js')).sort();
}
const FILES = bundles();

function patchedBuilderSource(patched: string): string {
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
 * Every identifier-like token in the builder, in source order. Minified builds of
 * one release name the same locals differently, so the roster below is keyed by
 * FIRST-APPEARANCE INDEX rather than by spelling — `canonical()` is what shows that
 * index means the same thing on every build.
 */
const TOKEN = /[A-Za-z_$][\w$]*/g;

function distinctTokens(src: string): string[] {
  const seen: string[] = [];
  for (const m of src.matchAll(TOKEN)) if (!seen.includes(m[0])) seen.push(m[0]);
  return seen;
}

/**
 * The builder with every identifier-like token replaced by its first-appearance
 * index. This is a TEXTUAL skeleton, not semantic alpha-equivalence: `TOKEN` also
 * matches property names and identifier-like text inside strings and regex
 * literals. Two builders with the same skeleton are the same tokens in the same
 * order, which is what makes one index-keyed binding table valid for all of them.
 */
function canonical(src: string): string {
  const seen = new Map<string, number>();
  return src.replace(TOKEN, t => {
    if (!seen.has(t)) seen.set(t, seen.size);
    return `#${seen.get(t)}`;
  });
}

const SENTINEL_PROXY_VALUE = '\u0000clodex-harness-proxy-sentinel';
const SENTINEL_SOCKET_VALUE = '\u0000clodex-harness-socket-sentinel';

/**
 * What the builder reads from the rest of the bundle, by first-appearance index,
 * recovered by reading the 2.1.260 builder in full. Every CONFIGURABLE stub answers
 * "no": no name is denied, no value is rewritten, nothing is claimed as a
 * credential. Claude Code's own hard-coded deletions still run and are asserted
 * separately below; the network-restoration scenarios use keys those rules do not
 * touch. `scrub` flips the one flag that decides whether the full
 * credential-filtering tail runs at all, because with it off the builder returns
 * before reaching it. `denyKey`, when set, makes one of the tail's deny predicates
 * answer yes for exactly that name. Without it the scrub flag is unobservable: the
 * only key that FORCES these scenarios onto the full-copy path is
 * `CLAUDE_CODE_SUBSCRIPTION_TYPE`, which Claude Code deletes unconditionally, so it
 * disappears whether the tail ran or not.
 */
function freeBindings(scrub: boolean, denyKey?: string): Record<number, unknown> {
  return {
    51: { of: () => ({ getAgentProxyEnv: () => ({}), settingsColorEnv: {} }) }, // host registry
    52: () => ({ host: 'default' }),          // host resolver
    62: {},                                   // typed env accessor (CLAUDE_CODE_REMOTE unset)
    65: (x: unknown) => x,                    // remote-mode proxy env builder
    68: () => scrub,                          // credential-scrub flag
    72: new Set<string>(),                    // static uppercase deny set
    75: () => false,                          // OTEL/artifact name predicate
    79: () => [],                             // dynamic deny list
    81: () => [],                             // second dynamic deny list
    83: [],                                   // static deny list (iterated twice)
    96: () => false,                          // BUN_JSC_ predicate
    102: () => [],                            // scrubbed-name list
    106: () => false,                         // conditional extra predicate
    108: () => new Set<string>(),             // post-scrub deny set
    110: () => [],                            // sandbox-mode list
    113: SENTINEL_PROXY_VALUE,                // agent-proxy sentinel value
    118: SENTINEL_SOCKET_VALUE,               // unix-socket credential sentinel
    122: /(?!)/,                              // deny pattern that never matches
    123: (k: string) => denyKey !== undefined && k === denyKey, // deny predicate
    124: () => false,                         // sandbox deny predicate
    125: () => false,                         // skip predicate
    128: () => false,                         // "needs truncation" predicate
    130: (_k: string, v: string) => ({ value: v, cut: false }),
    134: () => undefined,                     // spill-over name builder
    135: () => false,                         // spill-over collision check
    137: (_k: string, v: string) => v,        // value sanitiser: identity
    138: () => false,                         // "looks secret" predicate
  };
}

interface Scenario { scrub?: boolean; denyKey?: string }

/** Execute the patched builder with `process.env` bound to `env`. */
function runBuilder(
  patched: string,
  env: Record<string, string>,
  opts: Scenario = {},
): Record<string, string> {
  const builder = patchedBuilderSource(patched);
  const names = distinctTokens(builder);
  const bindings: Record<string, unknown> = { process: { env } };
  for (const [index, value] of Object.entries(freeBindings(opts.scrub ?? false, opts.denyKey))) {
    const name = names[Number(index)];
    expect(name, `no token at canonical index ${index}`).toBeDefined();
    bindings[name!] = value;
  }
  const params = Object.keys(bindings);
  const fn = new Function(...params, `return (${builder})`)(
    ...params.map(p => bindings[p]),
  ) as () => Record<string, string>;
  return fn();
}

const CONTRACT = JSON.stringify({
  version: 1,
  original: { HTTPS_PROXY: 'http://corp-proxy:3128', NODE_EXTRA_CA_CERTS: null },
  injected: { HTTPS_PROXY: 'http://127.0.0.1:49653', NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem' },
});

describe.runIf(BUNDLE_DIR)('bundle availability', () => {
  it('finds one 2.1.260 bundle per published platform', () => {
    expect(
      PLATFORMS.filter(p => !FILES.includes(`${p}.js`)),
      `missing platform bundles in ${BUNDLE_DIR}`,
    ).toEqual([]);
  });

  it('holds eight distinct bundles, not one bundle copied eight times', () => {
    const digests = new Set(
      FILES.map(f => createHash('sha256').update(readFileSync(join(BUNDLE_DIR, f))).digest('hex')),
    );
    expect(digests.size, 'distinct bundle contents').toBe(FILES.length);
  });
});

describe.skipIf(FILES.length === 0)('Claude Code 2.1.260 — the patched builder, executed', () => {
  for (const file of FILES) {
    describe(file, () => {
      const pristine = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const outcome = applyClodexPatches(pristine, CONFIG);
      const patched = outcome.content;

      it('applies every patch site, PATCH 10 included', () => {
        expect(outcome.results.filter(r => r.status !== 'OK')).toEqual([]);
        expect(patched.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
      });

      // A whole-bundle syntax check is not available and would not be honest if it
      // were: `readContent` concatenates ~1,600 separate modules, so the PRISTINE
      // text does not parse as one file either. The changed span is what this patch
      // can break, so that is what is checked — and `new Function` inside every
      // execution test below compiles the same text again for real.
      it('produces a builder that still compiles', () => {
        const builder = patchedBuilderSource(patched);
        expect(() => new Function(`return (${builder})`)).not.toThrow();
      });

      it('binds the builder that folds in the agent-proxy env, and nothing escapes it', () => {
        const builder = patchedBuilderSource(patched);
        expect(builder).toContain('getAgentProxyEnv');
        expect(builder).toContain('settingsColorEnv');
        // 2.1.260's remote flag comes off the typed accessor, not process.env, so
        // the rewrite must have left it alone.
        expect(builder).toMatch(/[\w$]+\.CLAUDE_CODE_REMOTE===!0/);
        expect(builder).not.toContain('_clodexChildEnv.CLAUDE_CODE_REMOTE');
        // No rewritten reference may escape the declaring function.
        expect(patched.split('_clodexChildEnv').length - 1)
          .toBe(builder.split('_clodexChildEnv').length - 1);
        // Every `process.env` read inside the builder was redirected: the only one
        // left is the prologue's own snapshot, `let _clodexChildEnv=process.env`.
        expect(builder.match(/process\.env/g)).toHaveLength(1);
        expect(builder).toContain('let _clodexChildEnv=process.env,');
      });

      it('has the same identifier-token skeleton as every other published build', () => {
        const mine = canonical(patchedBuilderSource(patched));
        for (const other of FILES) {
          if (other === file) continue;
          const theirs = canonical(patchedBuilderSource(
            applyClodexPatches(readFileSync(join(BUNDLE_DIR, other), 'utf8'), CONFIG).content,
          ));
          expect(mine, `${file} and ${other} have different token skeletons`).toBe(theirs);
        }
      });

      it('carries the roster the binding table was written against', () => {
        // If a release shifts these, every index in `freeBindings` means something
        // else and the execution proofs below would be binding the wrong stubs.
        const names = distinctTokens(patchedBuilderSource(patched));
        expect(names[55]).toBe('getAgentProxyEnv');
        expect(names[58]).toBe('settingsColorEnv');
        expect(names[63]).toBe('CLAUDE_CODE_REMOTE');
        expect(names).toHaveLength(139);
      });

      it('early-return branch: reverts to the external proxy and drops the CA + contract', () => {
        const out = runBuilder(patched, {
          PATH: '/usr/bin',
          HTTPS_PROXY: 'http://127.0.0.1:49653',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['PATH']).toBe('/usr/bin');
      });

      // `CLAUDE_CODE_SUBSCRIPTION_TYPE` forces the full-copy path AND is deleted
      // unconditionally, so it alone cannot show the scrub flag doing anything —
      // with it as the only witness, forcing the flag off left this green. `SCRUBBED`
      // is deleted only by the deny predicate in the tail the flag gates, so both the
      // flag and its binding are load-bearing here.
      it('full-copy branch (credential scrub) also reverts and still scrubs secrets', () => {
        const env = {
          PATH: '/usr/bin',
          SCRUBBED: 'secret',
          CLAUDE_CODE_SUBSCRIPTION_TYPE: 'max',
          HTTPS_PROXY: 'http://127.0.0.1:49653',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        };
        const out = runBuilder(patched, env, { scrub: true, denyKey: 'SCRUBBED' });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['CLAUDE_CODE_SUBSCRIPTION_TYPE'], 'native filtering still runs').toBeUndefined();
        expect(out['SCRUBBED'], 'the credential-scrub tail ran').toBeUndefined();
        expect(out['PATH']).toBe('/usr/bin');

        // The same env with the scrub flag off must NOT reach that tail — otherwise
        // the assertion above passes no matter what the flag does.
        const unscrubbed = runBuilder(patched, env, { scrub: false, denyKey: 'SCRUBBED' });
        expect(unscrubbed['SCRUBBED'], 'the tail is gated on the scrub flag').toBe('secret');
      });

      it('does NOT revert a value some other layer changed after the injection', () => {
        const out = runBuilder(patched, {
          HTTPS_PROXY: 'http://settings-level:9999',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        });
        expect(out['HTTPS_PROXY'], 'settings override stays authoritative')
          .toBe('http://settings-level:9999');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
      });

      it('no contract: hands back the parent env untouched', () => {
        const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:49653' };
        const out = runBuilder(patched, env);
        expect(out['HTTPS_PROXY']).toBe('http://127.0.0.1:49653');
        expect(out['PATH']).toBe('/usr/bin');
      });

      const hostile = [
        'not json', '[]', 'null', '{}', '{"version":2,"original":{},"injected":{}}',
        '{"version":1,"original":null,"injected":{}}',
        '{"version":1,"original":{"HTTPS_PROXY":1},"injected":{"HTTPS_PROXY":"x"}}',
        '{"version":1,"original":{"HTTPS_PROXY":"a"}}',
        '{"version":1,"injected":{"HTTPS_PROXY":"a"}}',
        '{"version":1,"original":{"__proto__":"x"},"injected":{"__proto__":"y"}}',
        '""', '0',
      ];
      for (const raw of hostile) {
        it(`hostile contract ${JSON.stringify(raw).slice(0, 46)} never throws and never reverts`, () => {
          const out = runBuilder(patched, {
            PATH: '/usr/bin',
            HTTPS_PROXY: 'http://127.0.0.1:49653',
            [NETWORK_ENV_CONTRACT_VAR]: raw,
          });
          expect(out['HTTPS_PROXY']).toBe('http://127.0.0.1:49653');
          expect(out[NETWORK_ENV_CONTRACT_VAR], 'contract never reaches the child').toBeUndefined();
        });
      }
    });
  }
});
