// REVIEW HARNESS (not for merge) — Claude Code 2.1.228 PATCH 10 anchor repair.
//
// 2.1.228 hoisted the settings-colour env into its own declarator inside the
// child-env builder's `let` statement, so an anchor that counted declarators
// reported "anchor not found" and — PATCH 10 being required — `clodex patch`
// refused to patch 2.1.228 at all.
//
// This drives the REAL applyClodexPatches over the REAL 2.1.228 bundle, then
// EXTRACTS the patched builder and EXECUTES it. Reading a regex replacement is
// not evidence the code runs. Every free identifier is bound explicitly, so a
// name the harness failed to account for surfaces as a ReferenceError rather
// than passing silently.
//
//   REVIEW_BUNDLE_DIR=<bundle dir> pnpm vitest run --config vitest.harness.config.ts \
//     .claude/harnesses/cc228-patch10-execute-real-builder.harness.ts
//
// `node scripts/extract-cc-bundles.mjs` fills the bundle dir from the pristine
// *.orig backups; a version never patched on this machine has no backup yet, so
// extract that one straight from ~/.local/share/claude/versions/<v> (it is
// pristine by definition) with the same tweakcc `readContent` call.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { applyClodexPatches } from '../../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../../src/network-env.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';
const MARKER = '/*ccpatch:child-network-env*/';
const CONFIG = { 'clodex:openai:gpt-5.6-sol': { alias: 'sol', display: 'GPT-5.6 Sol' } };

function findBundle(): string | null {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return null;
  const hit = readdirSync(BUNDLE_DIR).find(f => f.includes('2.1.228') && f.endsWith('.js'));
  return hit ? join(BUNDLE_DIR, hit) : null;
}

const BUNDLE = findBundle();
const pristine = BUNDLE ? readFileSync(BUNDLE, 'utf8') : '';
const patched = pristine ? applyClodexPatches(pristine, CONFIG).content : '';

function patchedBuilderSource(): string {
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

/** Every free identifier the 2.1.228 builder reads, recovered from its own text. */
function freeNames(builder: string): Record<string, string> {
  const pick = (label: string, re: RegExp, group = 1): string => {
    const m = builder.match(re);
    expect(m, `could not locate ${label}`).toBeTruthy();
    return m![group]!;
  };
  return {
    injected: pick('injected-env builder', /\*\/[\s\S]*?\}let ([\w$]+)=([\w$]+)\(\),/, 2),
    settings: pick('settings-colour env holder', /,[\w$]+=([\w$]+)\.settingsColorEnv,/),
    remoteFlag: pick('remote flag', /=([\w$]+)\(_clodexChildEnv\.CLAUDE_CODE_REMOTE\)\?/),
    remoteEnv: pick('remote env builder', /\(_clodexChildEnv\.CLAUDE_CODE_REMOTE\)\?([\w$]+)\(/),
    scrubFlag: pick(
      'credential-scrub flag',
      /,[\w$]+=([\w$]+)\(\),[\w$]+=_clodexChildEnv\.CLAUDE_CODE_OAUTH_TOKEN/,
    ),
    predicateA: pick('secret predicate A', /if\(([\w$]+)\([\w$]+\)\|\|([\w$]+)\([\w$]+\)\)delete/, 1),
    predicateB: pick('secret predicate B', /if\(([\w$]+)\([\w$]+\)\|\|([\w$]+)\([\w$]+\)\)delete/, 2),
    denyList: pick('dynamic deny list', /,[\w$]+=([\w$]+)\(_clodexChildEnv\),/),
    staticList: pick('static deny list', /=([\w$]+)\.some\(\(/),
    inputList: pick(
      'action-input deny list',
      /for\(let [\w$]+ of ([\w$]+)\)delete [\w$]+\[[\w$]+\],delete [\w$]+\[`INPUT_/,
    ),
    liveEnv: pick('live env accessor', /([\w$]+)\.CLAUDE_BG_SOCKET_TOKENS_PATH/),
  };
}

interface Scenario {
  scrub?: boolean;
  /** Extra keys the static deny list should strip, proving native filtering survives. */
  staticDeny?: string[];
}

function runBuilder(env: Record<string, string>, opts: Scenario = {}): Record<string, string> {
  const builder = patchedBuilderSource();
  const names = freeNames(builder);
  const bindings: Record<string, unknown> = {
    process: { env },
    [names['injected']!]: () => ({}),
    [names['settings']!]: { settingsColorEnv: {} },
    [names['remoteFlag']!]: () => false,
    [names['remoteEnv']!]: (x: unknown) => x,
    [names['scrubFlag']!]: () => Boolean(opts.scrub),
    [names['predicateA']!]: () => false,
    [names['predicateB']!]: () => false,
    [names['denyList']!]: () => [],
    [names['staticList']!]: opts.staticDeny ?? [],
    [names['inputList']!]: ['ANTHROPIC_API_KEY'],
    [names['liveEnv']!]: env,
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

describe.skipIf(!pristine)('Claude Code 2.1.228 — the patched builder, executed', () => {
  it('applies every patch site, PATCH 10 included', () => {
    const out = applyClodexPatches(pristine, CONFIG);
    expect(out.results.filter(r => r.status !== 'OK')).toEqual([]);
    expect(out.content.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
  });

  it('produces a bundle that still parses', () => {
    expect(() => new vm.Script(patched)).not.toThrow();
  });

  it('binds the builder that owns the settings-colour declarator', () => {
    const builder = patchedBuilderSource();
    expect(builder).toContain('.settingsColorEnv');
    // No rewritten reference may escape the declaring function.
    expect(patched.split('_clodexChildEnv').length - 1)
      .toBe(builder.split('_clodexChildEnv').length - 1);
  });

  it('early-return branch: reverts to the external proxy and drops the CA + contract', () => {
    const out = runBuilder({
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
    const out = runBuilder({
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
    const out = runBuilder({
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
    const out = runBuilder(env);
    expect(out).toBe(env);
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
      const env = {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://127.0.0.1:49653',
        [NETWORK_ENV_CONTRACT_VAR]: raw,
      };
      const out = runBuilder(env);
      expect(out['HTTPS_PROXY']).toBe('http://127.0.0.1:49653');
      expect(out[NETWORK_ENV_CONTRACT_VAR], 'contract never reaches the child').toBeUndefined();
    });
  }
});
