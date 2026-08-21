// REVIEW HARNESS (not for merge) — Claude Code 2.1.239 PATCH 10 anchor repair.
//
// 2.1.239 moved BOTH ends of the child-env builder in one release: the head's
// opening `let` gained an optional call and a DESTRUCTURING declarator (so the
// declarator run now carries braces), and the tail's GitHub-Actions input scrub
// — the statement the anchor ended on — was deleted. PATCH 10 is required, so
// `clodex patch` refused all eight published builds of 2.1.239.
//
// This drives the REAL applyClodexPatches over EVERY REAL 2.1.239 bundle, then
// EXTRACTS the patched builder and EXECUTES it. Reading a regex replacement is
// not evidence the code runs. Every free identifier is bound explicitly and
// recovered from the builder's own text, so a name the harness failed to
// account for surfaces as a ReferenceError rather than passing silently.
//
// `vitest.config.ts` scopes collection to `tests/`, so this file is never
// collected by `pnpm test`. Run it with a throwaway config of your own — it is
// two lines and deliberately not committed, because a config globbing the whole
// folder would try to collect harnesses that no longer compile:
//
//   cat > /tmp/h.config.ts <<'EOF'
//   import { defineConfig } from 'vitest/config';
//   export default defineConfig({ test: { include: ['.claude/harnesses/cc239-*.harness.ts'] } });
//   EOF
//   REVIEW_BUNDLE_DIR=<bundle dir> pnpm vitest run --config /tmp/h.config.ts
//
// `node scripts/extract-cc-bundles.mjs` fills the bundle dir from pristine
// *.orig backups. To cover all eight platforms, hard-link each platform's
// released binary into a scratch dir as `claude-2.1.239-<platform>.orig` and
// point TWEAKCC_CONFIG_DIR at it — the extractor never writes to its inputs.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
import { applyClodexPatches } from '../../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../../src/network-env.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';
const MARKER = '/*ccpatch:child-network-env*/';
const CONFIG = { 'clodex:openai:gpt-5.6-sol': { alias: 'sol', display: 'GPT-5.6 Sol' } };

function bundles(): string[] {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR).filter(f => f.includes('2.1.239') && f.endsWith('.js')).sort();
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

/** Every free identifier the 2.1.239 builder reads, recovered from its own text. */
function freeNames(builder: string): Record<string, string> {
  const pick = (label: string, re: RegExp, group = 1): string => {
    const m = builder.match(re);
    expect(m, `could not locate ${label}`).toBeTruthy();
    return m![group]!;
  };
  return {
    // `let e=sUn.of(lr().host)` — the per-host registry and the host resolver.
    registry: pick('host registry', /\}let [\w$]+=([\w$]+)\.of\(([\w$]+)\(\)\.host\)/, 1),
    hostOf: pick('host resolver', /\}let [\w$]+=([\w$]+)\.of\(([\w$]+)\(\)\.host\)/, 2),
    remoteFlag: pick('remote flag', /=([\w$]+)\(_clodexChildEnv\.CLAUDE_CODE_REMOTE\)\?/),
    remoteEnv: pick('remote env builder', /\(_clodexChildEnv\.CLAUDE_CODE_REMOTE\)\?([\w$]+)\(/),
    scrubFlag: pick(
      'credential-scrub flag',
      /,[\w$]+=([\w$]+)\(\),[\w$]+=_clodexChildEnv\.CLAUDE_CODE_OAUTH_TOKEN/,
    ),
    predicateA: pick(
      'secret predicate A',
      /Object\.keys\(_clodexChildEnv\)\.some\(([\w$]+)\)\|\|Object\.keys\(_clodexChildEnv\)\.some\(([\w$]+)\)/,
      1,
    ),
    predicateB: pick(
      'secret predicate B',
      /Object\.keys\(_clodexChildEnv\)\.some\(([\w$]+)\)\|\|Object\.keys\(_clodexChildEnv\)\.some\(([\w$]+)\)/,
      2,
    ),
    liveEnv: pick('live env accessor', /([\w$]+)\.CLAUDE_BG_SOCKET_TOKENS_PATH!==void 0/),
    denyList: pick('dynamic deny list', /,[\w$]+=([\w$]+)\(_clodexChildEnv\),/),
    // 2.1.239 added a second computed deny list right after the first.
    denyList2: pick('second dynamic deny list', /,[\w$]+=([\w$]+)\(\),[\w$]+=!1;/),
    staticList: pick('static deny list', /=([\w$]+)\.some\(\(/),
    extraPredicate: pick('conditional predicate', /if\(([\w$]+)\([\w$]+\)\)delete [\w$]+\[[\w$]+\]\}/),
    finalList: pick(
      'post-scrub deny list',
      /for\(let [\w$]+ of ([\w$]+)\)delete [\w$]+\[[\w$]+\];return [\w$]+\}$/,
    ),
  };
}

interface Scenario {
  scrub?: boolean;
  /** Extra keys the static deny list should strip, proving native filtering survives. */
  staticDeny?: string[];
}

function runBuilder(
  patched: string,
  env: Record<string, string>,
  opts: Scenario = {},
): Record<string, string> {
  const builder = patchedBuilderSource(patched);
  const names = freeNames(builder);
  const bindings: Record<string, unknown> = {
    process: { env },
    [names['registry']!]: { of: () => ({ getAgentProxyEnv: () => ({}), settingsColorEnv: {} }) },
    [names['hostOf']!]: () => ({ host: 'default' }),
    [names['remoteFlag']!]: () => false,
    [names['remoteEnv']!]: (x: unknown) => x,
    [names['scrubFlag']!]: () => Boolean(opts.scrub),
    [names['predicateA']!]: () => false,
    [names['predicateB']!]: () => false,
    [names['liveEnv']!]: env,
    [names['denyList']!]: () => [],
    [names['denyList2']!]: () => [],
    [names['staticList']!]: opts.staticDeny ?? [],
    [names['extraPredicate']!]: () => false,
    [names['finalList']!]: ['ANTHROPIC_API_KEY'],
  };
  const params = Object.keys(bindings);
  const factory = new Function(...params, `return (${builder})`);
  const fn = factory(...params.map(p => bindings[p])) as () => Record<string, string>;
  return fn();
}

const CONTRACT = JSON.stringify({
  version: 1,
  original: { HTTPS_PROXY: 'http://corp-proxy:3128', NODE_EXTRA_CA_CERTS: null },
  injected: { HTTPS_PROXY: 'http://127.0.0.1:49653', NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem' },
});

// Without REVIEW_BUNDLE_DIR the whole suite skips, which is the intended way to
// run the rest of the folder. But a dir that is SET and holds no 2.1.239 bundle
// is a mistake — skipping there reports green-looking skips for a proof that
// never ran.
//
// Check the PLATFORM ROSTER, not the file count. Platform builds of one release
// can be minified differently — 2.1.238's picker helper and 2.1.239's builder
// name both differ across builds — so the whole point is that each of the eight
// is exercised. Counting files alone passes on eight copies of one bundle, so
// hash the contents — and hash rather than compare sizes, because two of
// 2.1.239's bundles (linux-arm64 and linux-arm64-musl) are different bundles
// that happen to be exactly the same length.
const PLATFORMS = [
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl',
  'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64',
];

describe.runIf(BUNDLE_DIR)('bundle availability', () => {
  it('finds one 2.1.239 bundle per published platform', () => {
    expect(
      PLATFORMS.filter(p => !FILES.some(f => f === `claude-2.1.239-${p}.js`)),
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

describe.skipIf(FILES.length === 0)('Claude Code 2.1.239 — the patched builder, executed', () => {
  for (const file of FILES) {
    describe(file, () => {
      const pristine = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const patched = applyClodexPatches(pristine, CONFIG).content;

      it('applies every patch site, PATCH 10 included', () => {
        const out = applyClodexPatches(pristine, CONFIG);
        expect(out.results.filter(r => r.status !== 'OK')).toEqual([]);
        expect(out.content.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
      });

      it('produces a bundle that still parses', () => {
        expect(() => new vm.Script(patched)).not.toThrow();
      });

      it('binds the builder that owns the destructured settings-colour env', () => {
        const builder = patchedBuilderSource(patched);
        expect(builder).toContain('settingsColorEnv');
        // No rewritten reference may escape the declaring function.
        expect(patched.split('_clodexChildEnv').length - 1)
          .toBe(builder.split('_clodexChildEnv').length - 1);
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

      it('full-copy branch (credential scrub) also reverts and still scrubs secrets', () => {
        const out = runBuilder(patched, {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'sk-secret',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
          HTTPS_PROXY: 'http://127.0.0.1:49653',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        }, { scrub: true, staticDeny: ['ANTHROPIC_API_KEY'] });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['ANTHROPIC_API_KEY'], 'native filtering still runs').toBeUndefined();
        expect(out['CLAUDE_CODE_OAUTH_TOKEN'], 'credential scrub still runs').toBeUndefined();
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

      it('no contract: returns the live process.env object, byte-for-byte unchanged', () => {
        const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:49653' };
        expect(runBuilder(patched, env)).toBe(env);
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
