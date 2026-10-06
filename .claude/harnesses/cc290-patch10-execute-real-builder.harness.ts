// REVIEW HARNESS (not for merge) — Claude Code 2.1.290 PATCH 10 anchor repair.
//
// 2.1.290 restructured the tail of the child-env builder. Through 2.1.289 the
// statement after the passthrough early-out declared the merged copy FIRST and
// the builder returned it (`let E={...process.env,...s,...r,...d},…return E}`).
// 2.1.290 applies the settings env for children to a base copy before the
// passthrough and then declares an overlay first and the copy second
// (`let Z={...r,...m},E={...i};…return E}`), so the anchor's back-referenced
// tail (`return Z}`) found nothing. PATCH 10 is required, so `clodex patch`
// refused all eight published builds.
//
// This drives the REAL applyClodexPatches over EVERY REAL 2.1.290 bundle, then
// EXTRACTS the patched builder and EXECUTES it — on BOTH sides of the new
// settings-env branch (`i=process.env` vs `i={...process.env}` plus settings).
//
// `freeBindings` is a HAND-MAINTAINED table, keyed by the first-appearance index
// of each identifier token rather than by its spelling, so one reviewed table
// covers all eight builds. A binding is only proven present and correctly mapped
// when a scenario below REACHES it; the landmark-index assertions and the token
// count catch gross drift, not that.
//
//   cat > /tmp/h290.config.ts <<'EOF'
//   import { defineConfig } from 'vitest/config';
//   export default defineConfig({ test: { include: ['.claude/harnesses/cc290-*.harness.ts'] } });
//   EOF
//   REVIEW_BUNDLE_DIR=~/.cache/clodex-review-bundles/2.1.290 pnpm vitest run --config /tmp/h290.config.ts
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
 * recovered by reading the 2.1.290 builder in full. Every CONFIGURABLE stub answers
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
function freeBindings(
  scrub: boolean,
  denyKey: string | undefined,
  settingsEnv: Record<string, string>,
): Record<number, unknown> {
  return {
    51: { of: () => ({ getAgentProxyEnv: () => ({}), settingsEnvForChildren: settingsEnv }) }, // host registry
    52: () => ({ host: 'default' }),          // host resolver
    65: (_o: object, k: string) => k,         // case-insensitive key resolver (non-Windows: identity)
    67: {},                                   // typed env accessor (CLAUDE_CODE_REMOTE unset)
    70: (x: unknown) => x,                    // remote-mode proxy env builder
    73: () => scrub,                          // credential-scrub flag
    76: new Set<string>(),                    // static uppercase deny set
    79: () => false,                          // OTEL/artifact name predicate
    83: () => [],                             // dynamic deny list
    85: () => [],                             // second dynamic deny list
    87: () => false,                          // conditional dash-name gate
    88: new Set<string>(),                    // dash-name deny set
    89: (k: string) => k,                     // name normaliser
    91: [],                                   // static deny list (iterated twice)
    108: () => false,                         // extra early-out predicate
    128: {},                                  // second typed accessor
    131: () => false,                         // sandbox-mode predicate
    133: () => false,                         // BUN_JSC_ predicate
    141: () => [],                            // scrubbed-name list
    147: () => new Set<string>(),             // post-scrub deny set
    149: () => [],                            // sandbox-mode list
    150: SENTINEL_PROXY_VALUE,                // agent-proxy sentinel value
    155: SENTINEL_SOCKET_VALUE,               // unix-socket credential sentinel
    157: /(?!)/,                              // deny pattern that never matches
    158: (k: string) => denyKey !== undefined && k === denyKey, // deny predicate
    159: () => false,                         // sandbox deny predicate
    160: () => false,                         // skip predicate
    163: () => false,                         // "needs truncation" predicate
    165: (_k: string, v: string) => ({ value: v, cut: false }),
    169: () => undefined,                     // spill-over name builder
    170: () => false,                         // spill-over collision check
    173: (_k: string, v: string) => v,        // value sanitiser: identity
    174: () => false,                         // "looks secret" predicate
  };
}

interface Scenario { scrub?: boolean; denyKey?: string; settingsEnv?: Record<string, string> }

/** Execute the patched builder with `process.env` bound to `env`. */
function runBuilder(
  patched: string,
  env: Record<string, string>,
  opts: Scenario = {},
): Record<string, string> {
  const builder = patchedBuilderSource(patched);
  const names = distinctTokens(builder);
  const bindings: Record<string, unknown> = { process: { env } };
  for (const [index, value] of Object.entries(freeBindings(opts.scrub ?? false, opts.denyKey, opts.settingsEnv ?? {}))) {
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
  it('finds one 2.1.290 bundle per published platform', () => {
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

describe.skipIf(FILES.length === 0)('Claude Code 2.1.290 — the patched builder, executed', () => {
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
        expect(builder).toContain('settingsEnvForChildren');
        // The remote flag comes off the typed accessor, not process.env, so the
        // rewrite must have left it alone.
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
        expect(names[58]).toBe('settingsEnvForChildren');
        expect(names[68]).toBe('CLAUDE_CODE_REMOTE');
        expect(names).toHaveLength(175);
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

      // 2.1.290 copies the parent env and lays the settings env for children over it
      // BEFORE the passthrough. Both sides of that branch must read the RESTORED env.
      it('settings-env branch: reverts the injection and still lays settings on top', () => {
        const out = runBuilder(patched, {
          PATH: '/usr/bin',
          HTTPS_PROXY: 'http://127.0.0.1:49653',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        }, { settingsEnv: { FROM_SETTINGS: 'yes' } });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['FROM_SETTINGS'], 'settings env reaches the child').toBe('yes');
        expect(out['PATH']).toBe('/usr/bin');
      });

      it('settings-env branch: a settings-level proxy stays authoritative over the revert', () => {
        const out = runBuilder(patched, {
          HTTPS_PROXY: 'http://127.0.0.1:49653',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        }, { settingsEnv: { HTTPS_PROXY: 'http://settings-level:9999' } });
        expect(out['HTTPS_PROXY']).toBe('http://settings-level:9999');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
      });

      it('settings-env branch: the parent process.env is never mutated', () => {
        const env = {
          HTTPS_PROXY: 'http://127.0.0.1:49653',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        };
        const before = { ...env };
        runBuilder(patched, env, { settingsEnv: { FROM_SETTINGS: 'yes' } });
        expect(env).toEqual(before);
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
