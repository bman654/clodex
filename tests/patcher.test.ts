import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as p from '@clack/prompts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPatchModelConfig,
  computePatchConfigHash,
  evaluatePatchState,
  reportRejectedModelAliases,
  summarizePatchResults,
  tryAcquirePatchLock,
  type PatchManifest,
} from '../src/patcher.js';
import {
  applyClodexPatches,
  PATCH_TRANSFORMS_VERSION,
  PatchApplyError,
  type PatchScriptModelConfig,
} from '../src/patch-transforms.js';

/**
 * The digest a pre-versioning clodex wrote into `patch-state.json`: the bare
 * key-sorted 4-field tuple, with no version wrapper. This is DELIBERATELY FROZEN
 * — it models bytes that already exist on real users' disks, so it must NOT be
 * updated to track future changes to the production canonical tuple. (The
 * "version participates in the digest" property is pinned by the
 * transform-set-version test below, which is immune to tuple drift.)
 */
function computeLegacyPatchConfigHash(config: PatchScriptModelConfig): string {
  const canonical = Object.keys(config).sort().map(key => {
    const entry = config[key]!;
    return [key, entry.alias ?? null, entry.context ?? null, entry.display ?? null];
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

describe('buildPatchModelConfig', () => {
  const favorites = [
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    { providerId: 'openai', modelId: 'mystery-model' },
  ];
  const aliases = [
    { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
  ];
  const meta = new Map([
    ['openai-oauth:gpt-5.6-sol', { contextWindow: 272_000, displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))' }],
    ['openai-oauth:gpt-5.6-luna', { contextWindow: 272_000, displayName: 'GPT-5.6 Luna (OpenAI (ChatGPT))' }],
  ]);
  const rejectedAliases = [
    { name: 'Orbit', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    { name: 'ORBIT', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    { name: 'default', providerId: 'openai', modelId: 'davinci-002' },
    { name: 'bad:name', providerId: 'openai', modelId: 'mystery-model' },
    { name: 'ArChIvEd', providerId: 'openai', modelId: 'not-a-favorite' },
  ];
  const rejectedAliasRejections = [
    { alias: rejectedAliases[0]!, reason: 'conflicting-targets' as const },
    { alias: rejectedAliases[1]!, reason: 'conflicting-targets' as const },
    { alias: rejectedAliases[2]!, reason: 'reserved-name' as const },
    { alias: rejectedAliases[3]!, reason: 'invalid-name' as const },
    { alias: rejectedAliases[4]!, reason: 'target-not-favorite' as const },
  ];

  it('builds clodex-prefixed entries with aliases, context windows, and display labels', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      favorites,
      aliases,
      (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    );

    expect(config['clodex:openai-oauth:gpt-5.6-sol']).toEqual({
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
    });
    expect(config['clodex:openai-oauth:gpt-5.6-luna']).toEqual({
      context: 272_000,
      display: 'GPT-5.6 Luna (OpenAI (ChatGPT))',
    });
    // Unknown window → no context (Claude Code's 200k default) + warning entry
    expect(config['clodex:openai:mystery-model']).toEqual({});
    expect(unknownWindows).toEqual(['clodex:openai:mystery-model']);
  });

  it('omits context when the window equals the 200k default', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 200_000 }),
    );
    expect(config['clodex:openai:davinci-002']).toEqual({});
    expect(unknownWindows).toEqual([]);
  });

  it('omits a blank display label rather than baking an empty string', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 272_000, displayName: '   ' }),
    );
    expect(config['clodex:openai:davinci-002']).toEqual({ context: 272_000 });
  });

  it('canonicalizes aliases and omits ambiguous case-fold collisions', () => {
    const { config } = buildPatchModelConfig(
      favorites,
      [
        { name: 'Sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
        { name: 'LUNA', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
        { name: 'luna', providerId: 'openai', modelId: 'mystery-model' },
      ],
      (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    );

    expect(config['clodex:openai-oauth:gpt-5.6-sol']?.alias).toBe('sol');
    expect(config['clodex:openai-oauth:gpt-5.6-luna']?.alias).toBeUndefined();
    expect(config['clodex:openai:mystery-model']?.alias).toBeUndefined();
  });

  it('returns every rejected saved alias so the patch command can report it', () => {
    const desired = buildPatchModelConfig(
      favorites,
      rejectedAliases,
      (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    );

    expect(desired.rejectedAliases).toEqual(rejectedAliases);
    expect(desired.rejectedAliasRejections).toEqual(rejectedAliasRejections);
  });

  it('reports each rejected alias with its exact stored name and reason', () => {
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});

    try {
      reportRejectedModelAliases(rejectedAliasRejections);

      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
        'Saved model alias "Orbit" was not patched — conflicting targets. The saved entry was preserved.',
        'Saved model alias "ORBIT" was not patched — conflicting targets. The saved entry was preserved.',
        'Saved model alias "default" was not patched — reserved client name. The saved entry was preserved.',
        'Saved model alias "bad:name" was not patched — invalid name. The saved entry was preserved.',
        'Saved model alias "ArChIvEd" was not patched — target is not a saved favorite. The saved entry was preserved.',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('computePatchConfigHash', () => {
  it('is stable across key ordering and sensitive to changes', () => {
    const a = { 'clodex:p:m1': { alias: 'x', context: 1000 }, 'clodex:p:m2': {} };
    const b = { 'clodex:p:m2': {}, 'clodex:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(a)).toBe(computePatchConfigHash(b));
    expect(computePatchConfigHash(a)).not.toBe(
      computePatchConfigHash({ ...a, 'clodex:p:m1': { alias: 'y', context: 1000 } }),
    );
    expect(computePatchConfigHash(a)).not.toBe(
      computePatchConfigHash({ ...a, 'clodex:p:m1': { alias: 'x', context: 2000 } }),
    );
  });

  it('changes when only the display label changes (so an old patch reads as stale)', () => {
    const base = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } }),
    );
    expect(computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } })).not.toBe(
      computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (Q)' } }),
    );
  });

  it('differs from the legacy model-config-only hash', () => {
    const config = { 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } };
    expect(computePatchConfigHash(config)).not.toBe(computeLegacyPatchConfigHash(config));
  });

  it('changes when the transform-set version changes', () => {
    const config = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(config)).toBe(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION));
    expect(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION + 1)).not.toBe(
      computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION),
    );
  });
});

describe('PATCH_TRANSFORMS_VERSION', () => {
  // Folding the version into the config hash only helps if somebody actually
  // bumps it. Nothing else couples an edit of patch-transforms.ts to the
  // constant, and a forgotten bump reproduces exactly the silent staleness this
  // mechanism exists to prevent — with a fully green suite. So pin the file.
  //
  // WHEN THIS FAILS: patch-transforms.ts changed. Decide, deliberately:
  //   * transform set changed materially (site added/removed, or a site's regex,
  //     replacement, or ordering changed) -> bump PATCH_TRANSFORMS_VERSION AND
  //     update the digest below, in the same commit;
  //   * comment/formatting/type-only edit -> update the digest below and leave
  //     the version alone (no need to make every install repatch).
  //
  // Scope caveat: this hashes THIS FILE only. patch-transforms.ts imports
  // `isReservedModelAlias`, so a change reaching the transforms from
  // model-aliases.ts will not trip this guard. That import feeds a `fail()` gate
  // only, so it can turn a patch into a hard PatchApplyError but cannot silently
  // alter the bytes of a patch that succeeds — the failure mode this guard exists
  // to prevent. It catches the common case (a direct edit), not every possible one.
  it('is re-pinned deliberately whenever patch-transforms.ts changes', () => {
    // Normalize line endings: a Windows checkout with core.autocrlf=true would
    // otherwise fail this guard with zero source change, which is exactly the
    // "re-pin without thinking" reflex the guard is meant to avoid.
    const source = readFileSync(
      new URL('../src/patch-transforms.ts', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const digest = createHash('sha256').update(source).digest('hex');
    expect({ version: PATCH_TRANSFORMS_VERSION, digest }).toEqual({
      version: 1,
      digest: 'fd5d2e0f6493d35fb9548d61a5517e0197bdab4a586dbe61e0560766d70204fc',
    });
  });
});

describe('evaluatePatchState', () => {
  const manifest: PatchManifest = {
    binaryPath: '/opt/claude/claude',
    claudeVersion: '2.1.183',
    configHash: 'hash-1',
    patchedSize: 1234,
    patchedSha256: 'sha',
    backupPath: '/backups/claude-2.1.183.orig',
    patchedAt: '2026-07-19T00:00:00.000Z',
  };

  it('reports unpatched without a manifest or for a different binary', () => {
    expect(evaluatePatchState(null, { binaryPath: '/opt/claude/claude', claudeVersion: '2.1.183', configHash: 'hash-1' })).toBe('unpatched');
    expect(evaluatePatchState(manifest, { binaryPath: '/other/claude', claudeVersion: '2.1.183', configHash: 'hash-1' })).toBe('unpatched');
  });

  it('reports current when version, size, and config hash match', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-1',
      binarySize: 1234,
    })).toBe('current');
  });

  it('reports stale-config when the desired config hash changed', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-2',
      binarySize: 1234,
    })).toBe('stale-config');
  });

  it('reports stale-config for a manifest hashed before transform-set versioning', () => {
    const config = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    const legacyManifest = { ...manifest, configHash: computeLegacyPatchConfigHash(config) };
    expect(evaluatePatchState(legacyManifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: computePatchConfigHash(config),
      binarySize: 1234,
    })).toBe('stale-config');
  });

  it('reports stale-binary when claude was updated or replaced', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.2.0',
      configHash: 'hash-1',
    })).toBe('stale-binary');
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-1',
      binarySize: 9999,
    })).toBe('stale-binary');
  });
});

describe('tryAcquirePatchLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clodex-patch-lock-'));
    lockPath = join(dir, 'patch.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires and releases the lock', () => {
    const release = tryAcquirePatchLock(lockPath);
    expect(release).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses the lock while a live process holds it', () => {
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    expect(tryAcquirePatchLock(lockPath, { isAlive: () => true })).toBeNull();
    release!();
  });

  it('steals a lock left by a dead process', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }));
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => false });
    expect(release).not.toBeNull();
    release!();
  });

  it('steals a stale lock older than the timeout even when the pid is alive', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 11 * 60 * 1000 }));
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    release!();
  });

  it('steals an unreadable lock file', () => {
    writeFileSync(lockPath, 'not-json');
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    release!();
  });
});

describe('applyClodexPatches input validation', () => {
  it('rejects an empty model config', () => {
    expect(() => applyClodexPatches('var x = 1;', {})).toThrow(/MODEL_CONFIG is empty/);
  });

  it('rejects unsafe aliases', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { alias: 'Bad Alias!' },
    })).toThrow(/not a safe lowercase alias/);
  });

  it('rejects reserved and duplicate aliases', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { alias: 'sonnet' },
    })).toThrow(/reserved alias/);

    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model-a': { alias: 'custom' },
      'clodex:openai:model-b': { alias: 'CUSTOM' },
    })).toThrow(/assigned to multiple models/);
  });

  it('rejects an explicit context on a [1m]-suffixed id (the suffix already forces 1M)', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model[1m]': { context: 1_000_000 },
    })).toThrow(/keeps the \[1m\] suffix/);
  });

  it('throws PatchApplyError carrying per-site results when a required anchor is missing', () => {
    let caught: unknown;
    try {
      applyClodexPatches('var x = 1;', { 'clodex:openai:model': { alias: 'mm' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PatchApplyError);
    expect((caught as Error).message).toContain('required patch failed: PATCH 1');
    expect((caught as PatchApplyError).results).toEqual([
      { status: 'FAIL', name: 'PATCH 1: Agent tool model enum', extra: 'anchor not found' },
    ]);
  });
});

describe('summarizePatchResults', () => {
  it('formats per-site lines plus the applied/skipped/failed summary', () => {
    expect(summarizePatchResults([
      { status: 'OK', name: 'PATCH 1: Agent tool model enum' },
      { status: 'SKIP', name: 'PATCH 6: alias resolver switch', extra: 'no aliases configured' },
      { status: 'FAIL', name: 'PATCH 5: model picker options', extra: 'anchor not found' },
    ])).toEqual([
      '  OK   PATCH 1: Agent tool model enum',
      '  SKIP PATCH 6: alias resolver switch — no aliases configured',
      '  FAIL PATCH 5: model picker options — anchor not found',
      'clodex patch: 1 applied, 1 skipped, 1 failed',
      'clodex patch: FAILED patches: PATCH 5: model picker options',
    ]);
  });
});

// A minified stand-in for the Claude Code bundle carrying every anchor the
// patch transforms key on, so they can be executed end to end.
const CLAUDE_FIXTURE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');

function runPatchScript(config: Parameters<typeof applyClodexPatches>[1], source = CLAUDE_FIXTURE): string {
  return applyClodexPatches(source, config).content;
}

describe('patch script identity naming', () => {
  const config = {
    'clodex:openai-oauth:gpt-5.6-sol': {
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
    },
    'clodex:openai:mystery': { context: 128_000, display: 'Mystery (OpenAI)' },
  };

  it('injects the ALIAS — not the canonical id — as the model identity', () => {
    const out = runPatchScript(config);

    // PATCH 1: Agent-tool zod enum (the same enum agent/skill `model:` frontmatter
    // is validated against) gets "sol", never the canonical id.
    expect(out).toContain('.enum(["sonnet","opus","haiku","fable","sol","clodex:openai:mystery"]).optional().describe(');
    // PATCH 3: known-alias validator list.
    expect(out).toContain('["sonnet","opus","haiku","fable","opusplan","sol","clodex:openai:mystery"]');
    // The aliased model's canonical id never appears as an identity in either
    // list (it survives only as an extra key in the context table).
    expect(out).not.toMatch(/\.enum\(\[[^\]]*gpt-5\.6-sol/);
    expect(out).not.toMatch(/KNOWN=\[[^\]]*gpt-5\.6-sol/);
  });

  it('resolves an alias to ITSELF so the sent name and the context-map key stay identical', () => {
    const out = runPatchScript(config);
    // PATCH 6 must emit the case (not skip it — default: returns null) but map
    // the alias to itself rather than to the canonical id.
    expect(out).toContain('case"sol":return "sol";');
    expect(out).not.toContain('case"sol":return "clodex:openai-oauth:gpt-5.6-sol"');
  });

  it('keys the context-window table by the alias (and still by the canonical id)', () => {
    const out = runPatchScript(config);
    const table = out.match(/\/\*ccpatch:ctx\*\/var _ccw=\((\{[^}]*\})\)/)?.[1];
    expect(table).toBeTruthy();
    const parsed = JSON.parse(table!) as Record<string, number>;
    expect(parsed['sol']).toBe(272_000);
    expect(parsed['clodex:openai-oauth:gpt-5.6-sol']).toBe(272_000);
    expect(parsed['clodex:openai:mystery']).toBe(128_000);
  });

  it('falls back to the canonical id as the identity when a model has no alias', () => {
    const out = runPatchScript({ 'clodex:openai:mystery': { context: 128_000 } });
    expect(out).toContain('.enum(["sonnet","opus","haiku","fable","clodex:openai:mystery"])');
    expect(out).toContain('"clodex:openai:mystery"');
    // No alias → nothing to resolve and no picker entry.
    expect(out).not.toContain('case"clodex:openai:mystery":return');
    expect(out).not.toContain('value:"clodex:openai:mystery"');
  });

  it('uses the real display label in the /model picker and the Agent tool description', () => {
    const out = runPatchScript(config);
    expect(out).toContain('{value:"sol",label:"Sol",description:"GPT-5.6 Sol (OpenAI (ChatGPT))"}');
    expect(out).not.toContain('Custom model (');
    expect(out).toContain('Additional custom models: sol = GPT-5.6 Sol (OpenAI (ChatGPT)); '
      + 'clodex:openai:mystery = Mystery (OpenAI).');
  });

  it('falls back to the old "Custom model (id)" description when no label is known', () => {
    const out = runPatchScript({ 'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000 } });
    expect(out).toContain('{value:"sol",label:"Sol",description:"Custom model (clodex:openai-oauth:gpt-5.6-sol)"}');
    expect(out).toContain('Additional custom models: sol.');
  });

  it('supports aliases that match object prototype property names', () => {
    const out = runPatchScript({
      'clodex:openai:model': {
        alias: 'constructor',
        context: 128_000,
        display: 'Model',
      },
    });

    expect(out).toContain('case"constructor":return "constructor";');
    expect(out).toContain('{value:"constructor",label:"Constructor",description:"Model"}');
  });

  it('is idempotent — re-running the same patch changes nothing', () => {
    const once = runPatchScript(config);
    expect(runPatchScript(config, once)).toBe(once);
  });

  it('reports OK per site on a fresh run and SKIP/refresh on a re-run', () => {
    const fresh = applyClodexPatches(CLAUDE_FIXTURE, config);
    expect(fresh.results.map(r => [r.name, r.status])).toEqual([
      ['PATCH 1: Agent tool model enum', 'OK'],
      ['PATCH 3: known-alias validator list', 'OK'],
      ['PATCH 6: alias resolver switch', 'OK'],
      ['PATCH 5: model picker options', 'OK'],
      ['PATCH 4: Agent tool model description', 'OK'],
      ['PATCH 7: per-model context window', 'OK'],
    ]);
    const rerun = applyClodexPatches(fresh.content, config);
    expect(rerun.results.map(r => [r.name, r.status])).toEqual([
      ['PATCH 1: Agent tool model enum', 'SKIP'],
      ['PATCH 3: known-alias validator list', 'SKIP'],
      ['PATCH 6: alias resolver switch', 'SKIP'],
      ['PATCH 5: model picker options', 'SKIP'],
      ['PATCH 4: Agent tool model description', 'SKIP'],
      // PATCH 7 re-runs through the in-place refresh path; an unchanged config
      // rewrites the identical table, which reports as already patched.
      ['PATCH 7: per-model context window (refresh)', 'SKIP'],
    ]);
  });

  it('refreshes the baked context table in place when only the window changes', () => {
    const once = runPatchScript(config);
    const updated = runPatchScript(
      { ...config, 'clodex:openai:mystery': { context: 131_072, display: 'Mystery (OpenAI)' } },
      once,
    );
    const table = updated.match(/\/\*ccpatch:ctx\*\/var _ccw=\((\{[^}]*\})\)/)?.[1];
    const parsed = JSON.parse(table!) as Record<string, number>;
    expect(parsed['clodex:openai:mystery']).toBe(131_072);
    expect(parsed['sol']).toBe(272_000);
  });
});
