// PATCH 10 on the child-env builder as Claude Code 2.1.321 spells it.
//
// 2.1.321 moved the builder's three env sources into a helper,
// `return{proxyEnv:…getAgentProxyEnv?.()??{},settingsEnvForChildren:…,ownEnv:process.env}`, and the
// builder destructures them (`let{proxyEnv:e,settingsEnvForChildren:r,ownEnv:s}=re()`). The builder
// then spells neither `getAgentProxyEnv` nor `...process.env`, and its returned copy is chosen by a
// condition (`d=(N||a)&&x()!=="windows"?b:{...c}`) rather than opened with `{`. The head, the body
// check and the tail all refused, and `clodex patch` refused all eight published builds.
//
// The parent env now reaches the copy through the `ownEnv` binding, not through a `process.env`
// read. Rewriting `process.env` alone would leave that copy holding clodex's bridge values, so the
// scrub branch below is what proves the binding is redirected.

import { describe, it, expect } from 'vitest';
import { applyClodexPatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../src/network-env.js';
import { CLAUDE_FIXTURE } from './fixtures/claude-bundle.js';

const CONFIG: PatchScriptModelConfig = {
  'clodex:openai-oauth:gpt-6.1-sol': { alias: 'sol', context: 272_000 },
};
const PATCH_10 = 'PATCH 10: child network environment';
const REFUSED = 'clodex patch: required patch failed: ' + PATCH_10;
const MARKER = '/*ccpatch:child-network-env*/';

const HELPER =
  'function envSources(){let h=settings;return{proxyEnv:h.getAgentProxyEnv?.()??{},'
  + 'settingsEnvForChildren:h.settingsEnvForChildren,ownEnv:process.env}}';

// The real builder's control flow, cut down to the branches that decide which object the child
// gets: the base copy `i` is the destructured `ownEnv` itself unless a parameter or settings env
// forces a copy; the passthrough returns `process.env`; the returned `v` is either `b` (a fresh
// object whenever it is chosen) or a copy of `i`.
const BUILDER =
  'function childEnv(x){let{proxyEnv:e,settingsEnvForChildren:c,ownEnv:w}=envSources(),'
  + 't=Object.keys(e).length>0,n=Object.keys(c).length>0,i=w,a=n||x!==void 0;'
  + 'if(a){i={...x,...w};for(let[p,A]of Object.entries(c))i[p]=A}'
  + 'let g=accessor.CLAUDE_CODE_REMOTE===!0,r=g&&t,b=r?{...i,...e}:i,s=g?remote(b):{};'
  + 'let o=[process.env.CLAUDE_CODE_OAUTH_TOKEN,process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE,'
  + '"OTEL_"],u=["CLAUDE_CODE_OAUTH_TOKEN"];'
  + 'if(x===void 0&&!t&&!n&&!o[0])return process.env;'
  + 'let z={...e,...s},v=(r||a)&&platform()!=="windows"?b:{...i};Object.assign(v,z);'
  + 'for(let k of u)delete v[k];return v}';

const ORIGINAL_BUILDER = CLAUDE_FIXTURE.split('\n').find(line => line.startsWith('function childEnv('))!
  .replace(/function mcpAllow\(.*$/, '');

/** The shared fixture with its child-env builder spelled the 2.1.321 way. */
function fixture321(builder = BUILDER, helper = HELPER): string {
  expect(CLAUDE_FIXTURE).toContain(ORIGINAL_BUILDER);
  return CLAUDE_FIXTURE.replace(ORIGINAL_BUILDER, helper + builder);
}

const CONTRACT = JSON.stringify({
  version: 1,
  original: { HTTPS_PROXY: 'http://corp-proxy.example:8080', NODE_EXTRA_CA_CERTS: null },
  injected: { HTTPS_PROXY: 'http://127.0.0.1:3457', NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem' },
});

const injectedEnv = (): NodeJS.ProcessEnv => ({
  PATH: '/usr/bin',
  HTTPS_PROXY: 'http://127.0.0.1:3457',
  NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
  [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
});

interface Run {
  settingsEnvForChildren?: NodeJS.ProcessEnv;
  base?: NodeJS.ProcessEnv;
  platform?: string;
}

/** Run the patched helper and builder with `process.env` bound to `env`. */
function executeChildEnv(source: string, env: NodeJS.ProcessEnv, run: Run = {}): NodeJS.ProcessEnv {
  const line = source.split('\n').find(l => l.startsWith('function envSources('));
  expect(line, 'the helper and builder must still be on one line').toBeDefined();
  const childEnv = Function(
    'process', 'settings', 'accessor', 'remote', 'platform',
    `${line!};return childEnv;`,
  )(
    { env },
    { getAgentProxyEnv: () => ({}), settingsEnvForChildren: run.settingsEnvForChildren ?? {} },
    {},
    () => ({}),
    () => run.platform ?? 'macos',
  ) as (base?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  return childEnv(run.base);
}

const patched = (source = fixture321()): string => applyClodexPatches(source, CONFIG).content;

function expectRestored(env: NodeJS.ProcessEnv): void {
  expect(env).toMatchObject({ PATH: '/usr/bin', HTTPS_PROXY: 'http://corp-proxy.example:8080' });
  expect(env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
  expect(env[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
}

describe('PATCH 10 on the 2.1.321 helper-fed child-env builder', () => {
  it('patches the builder and redirects the destructured parent env to the restored one', () => {
    const source = fixture321();
    expect(source, 'the builder must not spell the agent-proxy name').not.toMatch(
      /function childEnv\([^]*getAgentProxyEnv[^]*return v\}/,
    );
    expect(source, 'nor spread process.env').not.toMatch(/function childEnv\([^]*\.\.\.process\.env/);

    const result = applyClodexPatches(source, CONFIG);

    expect(result.results.find(r => r.name === PATCH_10)?.status).toBe('OK');
    expect(result.content.split(MARKER)).toHaveLength(2);
    expect(result.content).toContain('function childEnv(x){' + MARKER);
    expect(result.content).toContain(
      'let{proxyEnv:e,settingsEnvForChildren:c,_clodexOwnEnv:w=_clodexChildEnv}=envSources(),',
    );
    expect(result.content).toContain('return _clodexChildEnv;let z=');
    expect(result.content, 'the helper is left alone').toContain(HELPER);
  });

  it('is idempotent', () => {
    const once = patched();
    const twice = applyClodexPatches(once, CONFIG);
    expect(twice.results.find(r => r.name === PATCH_10)?.status).toBe('SKIP');
    expect(twice.content).toBe(once);
  });

  describe('executing the patched builder', () => {
    it('passthrough: restores the external network environment', () => {
      expectRestored(executeChildEnv(patched(), injectedEnv()));
    });

    // Neither a parameter nor settings env, so the copy is taken from the `ownEnv` binding
    // itself. This is the branch a `process.env`-only rewrite leaves holding the bridge values.
    it('copy of the destructured env (scrub forced): restores and still scrubs', () => {
      const env = executeChildEnv(patched(), { ...injectedEnv(), CLAUDE_CODE_OAUTH_TOKEN: 'secret' });
      expectRestored(env);
      expect(env['CLAUDE_CODE_OAUTH_TOKEN'], 'native filtering still runs').toBeUndefined();
    });

    it('same branch on Windows, where the copy is always taken', () => {
      const env = executeChildEnv(
        patched(),
        { ...injectedEnv(), CLAUDE_CODE_OAUTH_TOKEN: 'secret' },
        { platform: 'windows' },
      );
      expectRestored(env);
    });

    it('settings-env branch: restores, and a settings-level proxy stays authoritative', () => {
      const parent = injectedEnv();
      expectRestored(executeChildEnv(patched(), parent, { settingsEnvForChildren: { FROM_SETTINGS: 'yes' } }));
      const held = executeChildEnv(patched(), parent, {
        settingsEnvForChildren: { HTTPS_PROXY: 'http://settings-level:9999' },
      });
      expect(held['HTTPS_PROXY']).toBe('http://settings-level:9999');
      expect(parent, 'the parent environment is never mutated').toEqual(injectedEnv());
    });

    it('base-env branch: the restored env wins over a base carrying the injected proxy', () => {
      const env = executeChildEnv(patched(), injectedEnv(), {
        base: { FROM_BASE: 'yes', HTTPS_PROXY: 'http://127.0.0.1:3457' },
      });
      expectRestored(env);
      expect(env['FROM_BASE']).toBe('yes');
    });

    it('no contract: leaves the network variables alone and still scrubs', () => {
      const parent = { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:3457', CLAUDE_CODE_OAUTH_TOKEN: 's' };
      const env = executeChildEnv(patched(), parent);
      expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:3457');
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    });
  });

  // The override replaces the helper's value with the restored `process.env`, which is only the
  // same thing while the helper sets `ownEnv` to `process.env`.
  it('refuses when the called helper hands over anything but process.env', () => {
    const helper = HELPER.replace('ownEnv:process.env', 'ownEnv:{...process.env}');
    expect(helper).not.toBe(HELPER);
    expect(() => patched(fixture321(BUILDER, helper))).toThrow(
      'target validation failed: body destructures ownEnv from envSources(), '
      + 'which does not return ownEnv:process.env',
    );
  });

  // The spelling elsewhere in the bundle is not evidence about the helper the builder calls.
  it('is not satisfied by ownEnv:process.env in some other function', () => {
    const helper = 'function unrelated(){return{ownEnv:process.env}}'
      + HELPER.replace('ownEnv:process.env', 'ownEnv:{...process.env}');
    expect(() => patched(fixture321(BUILDER, helper))).toThrow(
      'which does not return ownEnv:process.env',
    );
  });

  const NOT_THE_BINDING = 'target validation failed: body reads ownEnv other than through one '
    + 'destructured binding opening the builder';

  it('refuses a builder that reads ownEnv as a member instead of destructuring it', () => {
    const builder = BUILDER.replace(
      'let{proxyEnv:e,settingsEnvForChildren:c,ownEnv:w}=envSources(),',
      'let q=envSources(),{proxyEnv:e,settingsEnvForChildren:c}=q,w=q.ownEnv,',
    );
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder))).toThrow(NOT_THE_BINDING);
  });

  it('refuses a builder that mentions ownEnv a second time', () => {
    const builder = BUILDER.replace('Object.assign(v,z);', 'Object.assign(v,z);log({ownEnv:w});');
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder))).toThrow(NOT_THE_BINDING);
  });

  it('refuses a binding that already carries a default', () => {
    const builder = BUILDER.replace('ownEnv:w}', 'ownEnv:w=process.env}');
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder))).toThrow(NOT_THE_BINDING);
  });

  it('refuses the destructure when it is not the first declarator', () => {
    const builder = BUILDER.replace('let{proxyEnv:e,', 'let q=1,{proxyEnv:e,');
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder))).toThrow(NOT_THE_BINDING);
  });

  it('refuses the destructure when it opens a later let statement', () => {
    const builder = BUILDER.replace(
      'let{proxyEnv:e,settingsEnvForChildren:c,ownEnv:w}=envSources(),',
      'let{proxyEnv:e,settingsEnvForChildren:c}=envSources();let{ownEnv:w}=envSources(),',
    );
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder))).toThrow(NOT_THE_BINDING);
  });

  // The check reads the helper's own body: a neighbour after it, or a longer key ending in
  // ownEnv, must not stand in for what the helper hands over.
  it('is not satisfied by ownEnv:process.env just after the helper', () => {
    const helper = HELPER.replace('ownEnv:process.env', 'ownEnv:{...process.env}')
      + 'const unrelated=()=>({ownEnv:process.env});';
    expect(() => patched(fixture321(BUILDER, helper))).toThrow('which does not return ownEnv:process.env');
  });

  it('is not satisfied by a longer key ending in ownEnv inside the helper', () => {
    const helper = HELPER.replace('ownEnv:process.env', 'myownEnv:process.env,ownEnv:{...process.env}');
    expect(() => patched(fixture321(BUILDER, helper))).toThrow('which does not return ownEnv:process.env');
  });

  it('refuses a key that merely ends in ownEnv', () => {
    const builder = BUILDER.replace('ownEnv:w}', 'myownEnv:w}');
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder, HELPER.replace('ownEnv:', 'myownEnv:ownEnv,ownEnv:')))).toThrow(
      NOT_THE_BINDING,
    );
  });

  // `{ownEnv:w}===x` is an object literal; rewritten to `{_clodexOwnEnv:w=…}` it still parses
  // and silently assigns to `w`, so it must never be taken for the binding.
  it('refuses an object literal compared with ===', () => {
    const builder = BUILDER
      .replace('let{proxyEnv:e,settingsEnvForChildren:c,ownEnv:w}=envSources(),',
        'let{proxyEnv:e,settingsEnvForChildren:c}=envSources(),w={...process.env},')
      .replace('Object.assign(v,z);', 'Object.assign(v,z);check(0,{ownEnv:w}===z);');
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder))).toThrow(NOT_THE_BINDING);
  });

  it('does not take a key that merely ends in proxyEnv for the head pin', () => {
    const builder = BUILDER.replace('let{proxyEnv:e,', 'let{agentproxyEnv:e,');
    const helper = HELPER.replace('{proxyEnv:', '{agentproxyEnv:');
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder, helper))).toThrow(REFUSED);
  });

  // The tail now admits a declarator whose initializer reaches its object literal through a
  // condition, so the whole-bundle passthrough count must see that shape too, or a decoy with it
  // could go uncounted.
  it('counts a passthrough whose next declarator is conditional, and refuses two', () => {
    const decoy = 'function zzDecoy(q){if(q)return process.env;let r=q?q:{};return r}';
    expect(() => patched(decoy + '\n' + fixture321())).toThrow(REFUSED);
  });

  it('still refuses when the builder neither spreads process.env nor destructures ownEnv', () => {
    const builder = BUILDER
      .replace('let{proxyEnv:e,settingsEnvForChildren:c,ownEnv:w}=envSources(),',
        'let{proxyEnv:e,settingsEnvForChildren:c}=envSources(),w=other(),');
    expect(builder).not.toBe(BUILDER);
    expect(() => patched(fixture321(builder))).toThrow(
      'target validation failed: body does not contain ...process.env',
    );
  });
});
