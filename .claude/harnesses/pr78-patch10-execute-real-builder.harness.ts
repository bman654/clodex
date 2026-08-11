// REVIEW HARNESS (not for merge) — PR #78 @65581ca.
// Extracts the PATCHED child-env builder out of the real 2.1.226 bundle and
// EXECUTES it against synthetic environments, exercising both the early-return
// branch and the full-copy branch.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyClodexPatches } from '../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../src/network-env.js';

const BUNDLE = join(process.env['REVIEW_BUNDLE_DIR'] ?? '', 'claude-2.1.226-013a1cf17df5ff1d.js');
const MARKER = '/*ccpatch:child-network-env*/';
const CONFIG = { 'clodex:openai:gpt-5.6-sol': { alias: 'sol', display: 'GPT-5.6 Sol' } };

const patched = applyClodexPatches(readFileSync(BUNDLE, 'utf8'), CONFIG).content;

function patchedBuilderSource(): string {
  const at = patched.indexOf(MARKER);
  const declStart = patched.slice(0, at).lastIndexOf('function ');
  let depth = 0;
  const open = patched.indexOf('{', declStart);
  for (let i = open; i < patched.length; i++) {
    if (patched[i] === '{') depth++;
    else if (patched[i] === '}') { depth--; if (depth === 0) return patched.slice(declStart, i + 1); }
  }
  throw new Error('unbalanced');
}

const BUILDER = patchedBuilderSource();

interface Scenario { hostManaged?: boolean; scrub?: boolean }

function runBuilder(env: Record<string, string>, opts: Scenario = {}): Record<string, string> {
  const fakeProcess = { env };
  const factory = new Function(
    'bht', 'tTs', 'yr', 'mxu', 'jP_', 'rTs', 'slo', 'Yin', 'GP_', 'te', 'process',
    `return (${BUILDER})`,
  );
  const fn = factory(
    () => ({}),                                    // bht -> no injected env
    {},                                            // tTs
    (v: unknown) => v === true || v === '1' || v === 'true',  // yr
    (x: unknown) => x,                             // mxu
    () => Boolean(opts.scrub),                     // jP_ -> credential scrub branch
    (k: string) => k.startsWith('CLAUDE_CODE_ARTIFACT') && k.endsWith('_BASE_URL'), // rTs
    () => [],                                      // slo
    [],                                            // Yin
    ['ANTHROPIC_API_KEY'],                         // GP_
    env,                                           // te (live accessor)
    fakeProcess,
  );
  return fn() as Record<string, string>;
}

const CONTRACT = JSON.stringify({
  version: 1,
  original: { HTTPS_PROXY: 'http://corp-proxy:3128', NODE_EXTRA_CA_CERTS: null },
  injected: { HTTPS_PROXY: 'http://127.0.0.1:49653', NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem' },
});

describe('PR #78 — the patched 2.1.226 builder, executed', () => {
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
      HTTPS_PROXY: 'http://127.0.0.1:49653',
      NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
      [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
    }, { scrub: true });
    expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
    expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
    expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
    expect(out['ANTHROPIC_API_KEY'], 'credential scrub still runs').toBeUndefined();
  });

  it('does NOT revert a value some other layer changed after the injection', () => {
    const out = runBuilder({
      HTTPS_PROXY: 'http://settings-level:9999',   // no longer equals the injected value
      NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
      [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
    });
    expect(out['HTTPS_PROXY'], 'settings override stays authoritative').toBe('http://settings-level:9999');
    expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
  });

  it('no contract: returns the live process.env object, byte-for-byte unchanged', () => {
    const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:49653' };
    const out = runBuilder(env);
    expect(out).toBe(env);   // same reference — identical to unpatched behaviour
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
      let out: Record<string, string>;
      expect(() => { out = runBuilder(env); }).not.toThrow();
      out = runBuilder(env);
      expect(out['HTTPS_PROXY']).toBe('http://127.0.0.1:49653');
      expect(out[NETWORK_ENV_CONTRACT_VAR], 'contract var never leaks to children').toBeUndefined();
    });
  }
});
