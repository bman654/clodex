// REVIEW HARNESS — Claude Code 2.1.321 PATCH 10 anchor repair.
//
// 2.1.321 moved the child-env builder's three env sources into a helper,
// `function re(){let n=l.of(F().host);return{proxyEnv:n.getAgentProxyEnv?.()??{},
// settingsEnvForChildren:n.settingsEnvForChildren,ownEnv:process.env}}`, which the builder
// destructures (`let{proxyEnv:e,settingsEnvForChildren:r,ownEnv:s}=re(),…`) and spreads `s` where
// it used to spread `process.env`. Its returned copy is chosen by a condition
// (`d=(N||a)&&x()!=="windows"?b:{...c}`). The head, the body check and the tail all refused, so
// `clodex patch` refused every platform.
//
// This drives the REAL applyClodexPatches over EVERY REAL 2.1.321 bundle, then extracts the
// patched builder AND the real helper it destructures and EXECUTES them together. The helper is
// executed rather than stubbed, so `ownEnv` really is the bound `process.env`: a patch that rewrote
// only `process.env` reads would leave the copy branches holding the injected proxy, and the
// copy-branch scenarios below would go red.
//
// Stubs are keyed by the darwin-arm64 build's spelling and mapped to the other builds by
// first-appearance token index; every build must share the token skeleton, which is asserted.
//
//   cat > /tmp/h321.config.ts <<'EOF2'
//   import { defineConfig } from 'vitest/config';
//   export default defineConfig({ test: { include: ['.claude/harnesses/cc321-*.harness.ts'] } });
//   EOF2
//   REVIEW_BUNDLE_DIR=<dir with the eight 2.1.321 bundles> pnpm vitest run --config /tmp/h321.config.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { applyClodexPatches } from '../../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../../src/network-env.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';
const MARKER = '/*ccpatch:child-network-env*/';
const CONFIG = { 'clodex:openai:gpt-5.6-sol': { alias: 'sol', display: 'GPT-5.6 Sol' } };
const REFERENCE = 'darwin-arm64.js';

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

const TOKEN = /[A-Za-z_$][\w$]*/g;

function distinctTokens(src: string): string[] {
  const seen: string[] = [];
  for (const m of src.matchAll(TOKEN)) if (!seen.includes(m[0])) seen.push(m[0]);
  return seen;
}

function canonical(src: string): string {
  const seen = new Map<string, number>();
  return src.replace(TOKEN, t => {
    if (!seen.has(t)) seen.set(t, seen.size);
    return `#${seen.get(t)}`;
  });
}

const SENTINEL_PROXY_VALUE = '\u0000clodex-harness-proxy-sentinel';

/**
 * What the darwin-arm64 2.1.321 builder and its env helper read from the rest of the bundle, by
 * their own spelling, recovered by reading both in full. Every CONFIGURABLE stub answers "no", as
 * in cc304. `scrub` flips the flag that gates the credential tail; `denyKey` makes the tail's deny
 * predicate answer yes for exactly that name; `platform` is what the platform probe returns.
 */
function referenceBindings(
  scrub: boolean,
  denyKey: string | undefined,
  settingsEnv: Record<string, string>,
  platform: string,
): Record<string, unknown> {
  return {
    // The helper's own inputs. `re` itself is the REAL helper, extracted beside the builder.
    l: { of: () => ({ getAgentProxyEnv: () => ({}), settingsEnvForChildren: settingsEnv }) }, // host registry
    F: () => ({ host: 'default' }),          // host resolver
    TJ: (_o: object, k: string) => k,        // case-insensitive key resolver (non-Windows: identity)
    i: {},                                   // typed env accessor (every flag unset)
    Acn: () => ({}),                         // remote-mode proxy env builder
    gOo: () => scrub,                        // credential-scrub flag
    K: new Set<string>(),                    // static uppercase deny set
    Ant: () => false,                        // uppercase-name deny predicate
    Pwt: () => [],                           // dynamic deny list
    L1s: () => [],                           // second dynamic deny list
    xVs: () => [],                           // third dynamic deny list
    Rcn: () => false,                        // conditional dash-name gate
    V: new Set<string>(),                    // dash-name deny set
    Fme: (k: string) => k,                   // name normaliser
    Ibt: [],                                 // static deny list (iterated twice)
    UD: () => false,                         // extra early-out predicate
    iw: {},                                  // second typed accessor
    X: () => false,                          // sandbox-mode predicate
    j: () => false,                          // BUN_JSC_ predicate
    x: () => platform,                       // platform probe
    xcn: () => [],                           // scrubbed-name list
    h: () => false,                          // "keep this key" predicate
    SOo: () => false,                        // FORCE_COLOR gate
    tt: () => new Set<string>(),             // post-scrub deny set
    sWt: () => [],                           // sandbox-mode list
    k6: SENTINEL_PROXY_VALUE,                // agent-proxy sentinel value
    d6n: /(?!)/,                             // deny pattern that never matches
    c6n: (k: string) => denyKey !== undefined && k === denyKey, // deny predicate
    wOo: () => false,                        // sandbox deny predicate
    fun: () => false,                        // skip predicate
    oWt: () => false,                        // "needs truncation" predicate
    s6n: (_k: string, v: string) => ({ value: v, cut: false }),
    Ojs: () => undefined,                    // spill-over name builder
    Pjs: () => false,                        // spill-over collision check
    l6n: (_k: string, v: string) => v,       // value sanitiser: identity
    BD: () => false,                         // "looks secret" predicate
  };
}
/**
 * The patched builder preceded by the REAL helper it destructures, found by the name on the
 * right of the redirected `ownEnv` pattern. Executing the helper is what makes `ownEnv` the bound
 * `process.env` rather than whatever a stub happens to return.
 */
function patchedHelperAndBuilder(patched: string): string {
  const builder = patchedBuilderSource(patched);
  const rhs = builder.match(/_clodexOwnEnv:[\w$]+=_clodexChildEnv\}=([\w$]+)\(\)/);
  expect(rhs, 'the builder destructures a helper call with ownEnv redirected').not.toBeNull();
  const builderAt = patched.indexOf(builder);
  const helperAt = patched.lastIndexOf(`function ${rhs![1]}(){`, builderAt);
  expect(helperAt, 'helper declared before the builder').toBeGreaterThan(-1);
  const helper = patched.slice(helperAt, builderAt);
  expect(helper, 'the helper sits immediately before the builder').toMatch(/^function [\w$]+\(\)\{(?:(?!function )[^;])*;return\{[^;]*\}\}$/);
  expect(helper).toContain('ownEnv:process.env}');
  return helper + builder;
}

// Patched once: every other build is compared against it and mapped through its names.
const REFERENCE_SOURCE = FILES.includes(REFERENCE)
  ? patchedHelperAndBuilder(
    applyClodexPatches(readFileSync(join(BUNDLE_DIR, REFERENCE), 'utf8'), CONFIG).content,
  )
  : '';
const REFERENCE_NAMES = distinctTokens(REFERENCE_SOURCE);

interface Scenario {
  scrub?: boolean;
  denyKey?: string;
  settingsEnv?: Record<string, string>;
  base?: Record<string, string>;
  platform?: string;
}

/** Execute the patched helper + builder with `process.env` bound to `env`. */
function runBuilder(
  source: string,
  env: Record<string, string>,
  opts: Scenario = {},
): Record<string, string> {
  const names = distinctTokens(source);
  const bindings: Record<string, unknown> = { process: { env } };
  const byName = referenceBindings(
    opts.scrub ?? false, opts.denyKey, opts.settingsEnv ?? {}, opts.platform ?? 'macos',
  );
  for (const [refName, value] of Object.entries(byName)) {
    const index = REFERENCE_NAMES.indexOf(refName);
    expect(index, `reference build has no token ${refName}`).toBeGreaterThan(-1);
    const name = names[index];
    expect(name, `no token at canonical index ${index}`).toBeDefined();
    bindings[name!] = value;
  }
  const builderName = source.match(/\}function ([\w$]+)\(/)![1]!;
  const params = Object.keys(bindings);
  const fn = new Function(...params, `${source};return ${builderName}`)(
    ...params.map(p => bindings[p]),
  ) as (base?: Record<string, string>) => Record<string, string>;
  return fn(opts.base);
}

const CONTRACT = JSON.stringify({
  version: 1,
  original: { HTTPS_PROXY: 'http://corp-proxy:3128', NODE_EXTRA_CA_CERTS: null },
  injected: { HTTPS_PROXY: 'http://127.0.0.1:49653', NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem' },
});

const injected = (): Record<string, string> => ({
  PATH: '/usr/bin',
  HTTPS_PROXY: 'http://127.0.0.1:49653',
  NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
  [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
});

function expectRestored(out: Record<string, string>): void {
  expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
  expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
  expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
  expect(out['PATH']).toBe('/usr/bin');
}

describe.runIf(BUNDLE_DIR)('bundle availability', () => {
  it('finds one 2.1.321 bundle per published platform', () => {
    expect(
      PLATFORMS.filter(p => !FILES.includes(`${p}.js`)),
      `missing platform bundles in ${BUNDLE_DIR}`,
    ).toEqual([]);
  });

  it('every bundle is 2.1.321', () => {
    for (const f of FILES) {
      expect(readFileSync(join(BUNDLE_DIR, f), 'utf8').slice(0, 2_000_000), f).toContain('// Version: 2.1.321');
    }
  });
});

describe.skipIf(FILES.length === 0)('Claude Code 2.1.321 — the patched builder, executed', () => {
  for (const file of FILES) {
    describe(file, () => {
      const { results, markers, bundleRefs, source } = (() => {
        const outcome = applyClodexPatches(readFileSync(join(BUNDLE_DIR, file), 'utf8'), CONFIG);
        const patched = outcome.content;
        return {
          results: outcome.results,
          markers: patched.match(/\/\*ccpatch:child-network-env\*\//g)?.length ?? 0,
          bundleRefs: patched.split('_clodexChildEnv').length - 1,
          source: patchedHelperAndBuilder(patched),
        };
      })();

      it('applies every patch site, PATCH 10 included', () => {
        expect(results.filter(r => r.status !== 'OK')).toEqual([]);
        expect(markers).toBe(1);
      });

      it('produces a helper + builder that still compiles', () => {
        expect(() => new Function(source)).not.toThrow();
      });

      it('binds the helper-fed builder, and nothing escapes it', () => {
        const builder = source.slice(source.indexOf('}function ') + 1);
        expect(builder).toMatch(/^function [\w$]+\(([\w$]+)\)\{\/\*ccpatch:child-network-env\*\//);
        expect(builder, 'the builder itself spells neither the proxy getter nor a process.env spread')
          .not.toMatch(/getAgentProxyEnv|\.\.\.process\.env/);
        expect(builder).toMatch(/let\{proxyEnv:[\w$]+,settingsEnvForChildren:[\w$]+,_clodexOwnEnv:[\w$]+=_clodexChildEnv\}=/);
        expect(builder.match(/(?<![\w$])ownEnv/g), 'no read of the helper\'s own ownEnv survives').toBeNull();
        expect(bundleRefs).toBe(builder.split('_clodexChildEnv').length - 1);
        expect(builder.match(/process\.env/g)).toHaveLength(1);
        expect(builder).toContain('let _clodexChildEnv=process.env,');
      });

      it('has the same identifier-token skeleton as the reference build', () => {
        expect(canonical(source), `${file} and ${REFERENCE} have different token skeletons`)
          .toBe(canonical(REFERENCE_SOURCE));
      });

      it('early-return branch: reverts to the external proxy and drops the CA + contract', () => {
        expectRestored(runBuilder(source, injected()));
      });

      // No parameter and no settings env, so the copy is taken straight from the helper's
      // `ownEnv`. A rewrite of `process.env` reads alone leaves the injected proxy here.
      for (const platform of ['macos', 'windows']) {
        it(`ownEnv-copy branch (credential scrub, ${platform}): reverts and still scrubs`, () => {
          const env = { ...injected(), SCRUBBED: 'secret', CLAUDE_CODE_SUBSCRIPTION_TYPE: 'max' };
          const out = runBuilder(source, env, { scrub: true, denyKey: 'SCRUBBED', platform });
          expectRestored(out);
          expect(out['CLAUDE_CODE_SUBSCRIPTION_TYPE'], 'native filtering still runs').toBeUndefined();
          expect(out['SCRUBBED'], 'the credential-scrub tail ran').toBeUndefined();
          expect(env[NETWORK_ENV_CONTRACT_VAR], 'the parent env is never mutated').toBe(CONTRACT);
        });
      }

      it('base-env branch: the restored env wins over a base carrying the injected proxy', () => {
        const parent = injected();
        const out = runBuilder(source, parent, {
          base: { FROM_BASE: 'yes', HTTPS_PROXY: 'http://127.0.0.1:49653' },
        });
        expectRestored(out);
        expect(out['FROM_BASE'], 'base-only keys reach the child').toBe('yes');
        expect(parent, 'the parent environment is never mutated').toEqual(injected());
      });

      it('settings-env branch: reverts the injection and still lays settings on top', () => {
        const out = runBuilder(source, injected(), { settingsEnv: { FROM_SETTINGS: 'yes' } });
        expectRestored(out);
        expect(out['FROM_SETTINGS'], 'settings env reaches the child').toBe('yes');
      });

      it('settings-env branch: a settings-level proxy stays authoritative over the revert', () => {
        const out = runBuilder(source, injected(), {
          settingsEnv: { HTTPS_PROXY: 'http://settings-level:9999' },
        });
        expect(out['HTTPS_PROXY']).toBe('http://settings-level:9999');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
      });

      it('no contract: hands back the parent env untouched', () => {
        const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:49653' };
        expect(runBuilder(source, env)).toEqual(env);
        expect(runBuilder(source, env, { scrub: true })).toEqual(env);
      });

      const hostile = [
        'not json', '[]', 'null', '{}', '{"version":2,"original":{},"injected":{}}',
        '{"version":1,"original":{"HTTPS_PROXY":1},"injected":{"HTTPS_PROXY":"x"}}',
        '{"version":1,"original":{"__proto__":"x"},"injected":{"__proto__":"y"}}',
      ];
      for (const raw of hostile) {
        it(`hostile contract ${JSON.stringify(raw).slice(0, 46)} never throws and never reverts`, () => {
          const out = runBuilder(source, {
            PATH: '/usr/bin',
            HTTPS_PROXY: 'http://127.0.0.1:49653',
            [NETWORK_ENV_CONTRACT_VAR]: raw,
          }, { scrub: true });
          expect(out['HTTPS_PROXY']).toBe('http://127.0.0.1:49653');
          expect(out[NETWORK_ENV_CONTRACT_VAR], 'contract never reaches the child').toBeUndefined();
        });
      }
    });
  }
});
