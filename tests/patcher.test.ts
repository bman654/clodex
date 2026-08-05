import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as p from '@clack/prompts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPatch,
  buildPatchModelConfig,
  buildDesiredPatchConfig,
  computePatchConfigHash,
  evaluatePatchState,
  getPatchManifestPath,
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
import {
  builtInPatchProofsChanged,
  captureBuiltInPatchProofs,
} from '../src/built-in-patch-proofs.js';

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

const tweakccMocks = vi.hoisted(() => ({
  tryDetectInstallation: vi.fn(),
  readContent: vi.fn(),
  writeContent: vi.fn(),
}));

vi.mock('tweakcc', () => tweakccMocks);

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
    ['openai-oauth:gpt-5.6-sol', {
      contextWindow: 272_000,
      displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
      effort: {
        levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
      },
    }],
    ['openai-oauth:gpt-5.6-luna', {
      contextWindow: 272_000,
      displayName: 'GPT-5.6 Luna (OpenAI (ChatGPT))',
      effort: {
        levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
      },
    }],
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
      effort: {
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'high',
      },
    });
    expect(config['clodex:openai-oauth:gpt-5.6-luna']).toEqual({
      context: 272_000,
      display: 'GPT-5.6 Luna (OpenAI (ChatGPT))',
      effort: {
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'high',
      },
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

  it.each([
    {
      name: 'an incomplete base',
      levels: ['high', 'xhigh'],
      defaultLevel: 'high',
    },
    {
      name: 'a transport-only default',
      levels: ['none', 'low', 'medium', 'high'],
      defaultLevel: 'none',
    },
  ])('omits client effort metadata for $name', ({ levels, defaultLevel }) => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'reasoning-model' }],
      [],
      () => ({
        contextWindow: 200_000,
        effort: { levels, defaultLevel },
      }),
    );
    expect(config['clodex:openai:reasoning-model']).toEqual({});
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

describe('buildDesiredPatchConfig', () => {
  const previousHome = process.env.CLODEX_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-desired-patch-'));
    process.env.CLODEX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeInputs(
    model: Record<string, unknown>,
    provider: {
      id?: string;
      templateId?: string;
      name?: string;
      npm?: string;
    } = {},
  ): void {
    const providerId = provider.id ?? 'openai';
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        favoriteModels: [{ providerId, modelId: model.id }],
      }),
    );
    writeFileSync(
      join(home, 'providers.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: [{
          id: providerId,
          templateId: provider.templateId ?? 'openai',
          name: provider.name ?? 'OpenAI',
          enabled: true,
          authRef: 'env:OPENAI_API_KEY',
          api: { npm: provider.npm ?? '@ai-sdk/openai' },
          modelsCache: {
            fetchedAt: '2026-07-27T00:00:00.000Z',
            models: [model],
          },
          addedAt: '2026-07-27T00:00:00.000Z',
        }],
      }),
    );
  }

  it('preserves the native high default when provider metadata defaults to medium', () => {
    writeInputs({
      id: 'gpt-5.6-sol',
      upstreamModelId: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['clodex:openai:gpt-5.6-sol']?.effort).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'high',
    });
  });

  it('does not leak provider-only extended levels through the production config path', () => {
    writeInputs({
      id: 'gpt-5.5',
      upstreamModelId: 'gpt-5.5',
      name: 'GPT-5.5',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['clodex:openai:gpt-5.5']?.effort).toEqual({
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'high',
    });
  });

  it('uses the catalog id when an older cache entry lacks upstreamModelId', () => {
    writeInputs({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['clodex:openai:gpt-5.5']?.effort).toEqual({
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'high',
    });
  });

  it('omits effort when enriched catalog metadata explicitly disables reasoning', () => {
    writeInputs({
      id: 'kimi-k2',
      upstreamModelId: 'kimi-k2',
      name: 'Kimi K2',
      contextWindow: 128_000,
      modelFormat: 'openai',
    }, {
      id: 'qiniu-ai',
      templateId: 'qiniu-ai',
      name: 'Qiniu',
      npm: '@ai-sdk/openai-compatible',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['clodex:qiniu-ai:kimi-k2']?.effort).toBeUndefined();
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

  it('changes when only the supported effort levels change', () => {
    const base = {
      'clodex:p:m1': {
        effort: {
          levels: ['low', 'medium', 'high'],
          defaultLevel: 'medium',
        },
      },
    };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({
        'clodex:p:m1': {
          effort: {
            levels: ['low', 'medium', 'high', 'xhigh'],
            defaultLevel: 'medium',
          },
        },
      }),
    );
  });

  it('changes when only the default effort level changes', () => {
    const base = {
      'clodex:p:m1': {
        effort: {
          levels: ['low', 'medium', 'high'],
          defaultLevel: 'medium',
        },
      },
    };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({
        'clodex:p:m1': {
          effort: {
            levels: ['low', 'medium', 'high'],
            defaultLevel: 'high',
          },
        },
      }),
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

  it('changes with enabled local patch bytes while preserving the disabled hash', () => {
    const config = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    const disabled = computePatchConfigHash(config);

    expect(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION, undefined)).toBe(disabled);
    expect(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION, 'v1:first')).not.toBe(disabled);
    expect(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION, 'v1:first')).not.toBe(
      computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION, 'v1:second'),
    );
  });
});

describe('PATCH_TRANSFORMS_VERSION', () => {
  // Folding the version into the config hash only helps if somebody actually
  // bumps it. Nothing else couples an edit of the transform sources to the
  // constant, and a forgotten bump reproduces exactly the silent staleness this
  // mechanism exists to prevent — with a fully green suite. So pin the sources.
  //
  // WHEN THIS FAILS: a transform source changed. Decide, deliberately:
  //   * transform set changed materially (site added/removed, or a site's regex,
  //     replacement, or ordering changed) -> bump PATCH_TRANSFORMS_VERSION AND
  //     update the digest below, in the same commit;
  //   * comment/formatting/type-only edit -> update the digest below and leave
  //     the version alone (no need to make every install repatch).
  //
  // Scope caveat: this hashes the transform file and the constants that are
  // emitted into its child-network patch. patch-transforms.ts also imports
  // `isReservedModelAlias`, so a change reaching the transforms from
  // model-aliases.ts will not trip this guard. That import feeds a `fail()` gate
  // only, so it can turn a patch into a hard PatchApplyError but cannot silently
  // alter the bytes of a patch that succeeds — the failure mode this guard exists
  // to prevent. It catches the common case (a direct edit), not every possible one.
  it('is re-pinned deliberately whenever patch-transforms.ts changes', () => {
    // Normalize line endings: a Windows checkout with core.autocrlf=true would
    // otherwise fail this guard with zero source change, which is exactly the
    // "re-pin without thinking" reflex the guard is meant to avoid.
    const source = [
      '../src/patch-transforms.ts',
      '../src/network-env.ts',
    ].map(path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n'))
      .join('\n');
    const digest = createHash('sha256').update(source).digest('hex');
    expect({ version: PATCH_TRANSFORMS_VERSION, digest }).toEqual({
      version: 3,
      digest: 'da3c4bffe8ddd7e014fe3f7a2e8be118497817083e346cc76791e8b86a3163a4',
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

  it('rejects reserved aliases', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { alias: 'sonnet' },
    })).toThrow(/reserved alias/);
  });

  it('rejects an explicit context on a [1m]-suffixed id (the suffix already forces 1M)', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model[1m]': { context: 1_000_000 },
    })).toThrow(/keeps the \[1m\] suffix/);
  });

  it.each([
    {
      levels: ['low', 'high'],
      defaultLevel: 'high',
    },
    {
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'max',
    },
  ])('rejects effort metadata outside the native client contract', effort => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { effort },
    })).toThrow(/must include low, medium, and high with a native default/);
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
const CLAUDE_CORE_FIXTURE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
  'function childEnv(){let e=extra(),t=Object.keys(e).length>0,n=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{},s=process.env.CLAUDE_CODE_OAUTH_TOKEN!==void 0;if(!t&&!s)return process.env;let u={...process.env,...e,...n};delete u.CLAUDE_CODE_OAUTH_TOKEN;return u}function mcpAllow(){let e=process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV;return e}',
].join('\n');

const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The re-patch tests below all start from the same state: a live binary holding
 * a previous clodex patch, plus an ESTABLISHED pristine backup — content-addressed
 * (so no version probe is needed to trust it) and recorded in the manifest. That
 * is what makes `applyPatch` plan a `restore`, i.e. seed the candidate from the
 * backup rather than from the patched binary. Spelling it out matters: with a
 * manifest that does not identify the live bytes as clodex's own patch, the
 * planner would fall through to inspecting them and could snapshot a PATCHED
 * binary as "pristine" — the exact thing the backup rules exist to prevent.
 */
const PATCHED_BINARY = 'previously-patched-native';
const PRISTINE_BINARY = 'pristine-native';
const PRISTINE_BACKUP_NAME = `claude-test-version-${digestOf(PRISTINE_BINARY).slice(0, 16)}.orig`;

function priorPatchManifest(binaryPath: string, backupPath: string): PatchManifest {
  return {
    binaryPath,
    claudeVersion: 'test-version',
    configHash: 'previous-config-hash',
    patchedSize: Buffer.byteLength(PATCHED_BINARY),
    patchedSha256: digestOf(PATCHED_BINARY),
    backupPath,
    pristineSha256: digestOf(PRISTINE_BINARY),
    patchedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('applyPatch', () => {
  it('does not write the binary or a current manifest when effort anchors fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-effort-anchor-failure-'));
    const binaryPath = join(dir, 'claude');
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    writeFileSync(binaryPath, 'pristine-native');
    process.env.CLODEX_HOME = join(dir, 'app-home');
    process.env.TWEAKCC_CONFIG_DIR = join(dir, 'tweakcc-home');

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => {
        expect(path).not.toBe(binaryPath);
        expect(readFileSync(path, 'utf8')).toBe('pristine-native');
        return {
          path,
          version: 'test-version',
          kind: 'native',
        };
      },
    );
    tweakccMocks.readContent.mockResolvedValue(CLAUDE_CORE_FIXTURE);

    try {
      const outcome = await applyPatch(
        binaryPath,
        'test-version',
        {
          config: {
            'clodex:test:extended': {
              alias: 'extended',
              effort: {
                levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultLevel: 'high',
              },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: null },
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('required effort patches failed');
      expect(outcome.detailLines).toContain(
        'clodex patch: FAILED patches: PATCH 8a: effort capability; '
          + 'PATCH 8b: xhigh effort capability; '
          + 'PATCH 8c: max effort capability; PATCH 9: default effort',
      );
      expect(tweakccMocks.writeContent).not.toHaveBeenCalled();
      expect(readFileSync(binaryPath, 'utf8')).toBe('pristine-native');
      expect(existsSync(getPatchManifestPath())).toBe(false);
    } finally {
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the working binary and manifest when a re-patch fails validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-repatch-validation-failure-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const pristinePath = join(tweakccHome, PRISTINE_BACKUP_NAME);
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const previousManifest = '{"existing":"manifest"}\n';
    mkdirSync(tweakccHome, { recursive: true });
    writeFileSync(binaryPath, 'previously-patched-native');
    writeFileSync(pristinePath, 'pristine-native');
    process.env.CLODEX_HOME = dir;
    process.env.TWEAKCC_CONFIG_DIR = tweakccHome;
    writeFileSync(getPatchManifestPath(), previousManifest);

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => {
        expect(path).not.toBe(binaryPath);
        expect(readFileSync(path, 'utf8')).toBe('pristine-native');
        return {
          path,
          version: 'test-version',
          kind: 'native',
        };
      },
    );
    tweakccMocks.readContent.mockResolvedValue(CLAUDE_CORE_FIXTURE);

    try {
      const outcome = await applyPatch(
        binaryPath,
        'test-version',
        {
          config: {
            'clodex:test:extended': {
              alias: 'extended',
              effort: {
                levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultLevel: 'high',
              },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: priorPatchManifest(binaryPath, pristinePath) },
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('required effort patches failed');
      expect(tweakccMocks.writeContent).not.toHaveBeenCalled();
      expect(readFileSync(binaryPath, 'utf8')).toBe('previously-patched-native');
      expect(readFileSync(pristinePath, 'utf8')).toBe('pristine-native');
      expect(readFileSync(getPatchManifestPath(), 'utf8')).toBe(previousManifest);
      expect(readFileSync(join(tweakccHome, 'native-binary.backup'), 'utf8')).toBe('pristine-native');
    } finally {
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the working binary and manifest when candidate repacking fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-repatch-write-failure-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const pristinePath = join(tweakccHome, PRISTINE_BACKUP_NAME);
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const previousManifest = '{"existing":"manifest"}\n';
    mkdirSync(tweakccHome, { recursive: true });
    writeFileSync(binaryPath, 'previously-patched-native');
    writeFileSync(pristinePath, 'pristine-native');
    process.env.CLODEX_HOME = dir;
    process.env.TWEAKCC_CONFIG_DIR = tweakccHome;
    writeFileSync(getPatchManifestPath(), previousManifest);

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => ({
        path,
        version: 'test-version',
        kind: 'native',
      }),
    );
    tweakccMocks.readContent.mockResolvedValue(CLAUDE_FIXTURE);
    tweakccMocks.writeContent.mockRejectedValue(new Error('candidate repack failed'));

    try {
      const outcome = await applyPatch(
        binaryPath,
        'test-version',
        {
          config: {
            'clodex:test:extended': {
              alias: 'extended',
              effort: {
                levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultLevel: 'high',
              },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: priorPatchManifest(binaryPath, pristinePath) },
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('candidate repack failed');
      expect(tweakccMocks.writeContent).toHaveBeenCalledOnce();
      expect(readFileSync(binaryPath, 'utf8')).toBe('previously-patched-native');
      expect(readFileSync(pristinePath, 'utf8')).toBe('pristine-native');
      expect(readFileSync(getPatchManifestPath(), 'utf8')).toBe(previousManifest);
    } finally {
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes the replacement and updates the manifest after a successful re-patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-repatch-success-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const pristinePath = join(tweakccHome, PRISTINE_BACKUP_NAME);
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const previousManifest = '{"existing":"manifest"}\n';
    const replacement = 'newly-patched-native';
    mkdirSync(tweakccHome, { recursive: true });
    writeFileSync(binaryPath, 'previously-patched-native');
    writeFileSync(pristinePath, 'pristine-native');
    process.env.CLODEX_HOME = dir;
    process.env.TWEAKCC_CONFIG_DIR = tweakccHome;
    writeFileSync(getPatchManifestPath(), previousManifest);

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => ({
        path,
        version: 'test-version',
        kind: 'native',
      }),
    );
    tweakccMocks.readContent.mockResolvedValue(CLAUDE_FIXTURE);
    tweakccMocks.writeContent.mockImplementation(
      async ({ path }: { path: string }) => {
        writeFileSync(path, replacement);
      },
    );

    try {
      const outcome = await applyPatch(
        binaryPath,
        'test-version',
        {
          config: {
            'clodex:test:extended': {
              alias: 'extended',
              effort: {
                levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultLevel: 'high',
              },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: priorPatchManifest(binaryPath, pristinePath) },
      );

      const manifestBytes = readFileSync(getPatchManifestPath(), 'utf8');
      const manifest = JSON.parse(manifestBytes) as PatchManifest;
      expect(outcome.ok).toBe(true);
      expect(readFileSync(binaryPath, 'utf8')).toBe(replacement);
      expect(readFileSync(pristinePath, 'utf8')).toBe('pristine-native');
      expect(readFileSync(join(tweakccHome, 'native-binary.backup'), 'utf8')).toBe('pristine-native');
      expect(manifestBytes).not.toBe(previousManifest);
      expect(manifest).toMatchObject({
        binaryPath,
        claudeVersion: 'test-version',
        configHash: 'desired-config-hash',
        patchedSize: Buffer.byteLength(replacement),
        patchedSha256: createHash('sha256').update(replacement).digest('hex'),
        backupPath: pristinePath,
      });
    } finally {
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const CLAUDE_FIXTURE = [
  CLAUDE_CORE_FIXTURE,
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

const CLAUDE_PROXY_EFFORT_FIXTURE = [
  CLAUDE_CORE_FIXTURE,
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

function runPatchScript(config: Parameters<typeof applyClodexPatches>[1], source = CLAUDE_FIXTURE): string {
  return applyClodexPatches(source, config).content;
}

function executeChildEnv(
  source: string,
  env: NodeJS.ProcessEnv,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const declaration = source
    .split('\n')
    .find(line => line.startsWith('function childEnv('));
  expect(declaration).toBeDefined();
  const childEnv = Function(
    'process',
    'extra',
    'flag',
    'remote',
    `${declaration};return childEnv;`,
  )(
    { env },
    () => extraEnv,
    () => false,
    () => ({}),
  ) as () => NodeJS.ProcessEnv;
  return childEnv();
}

type CapabilityFunctionName = 'OI' | 'I_e' | 'eqe';

function executeCapability(
  source: string,
  functionName: CapabilityFunctionName,
  modelId: string,
  nativeFallback: boolean,
  denied = false,
): boolean {
  const declaration = source
    .split('\n')
    .find(line => line.startsWith(`function ${functionName}(`));
  expect(declaration).toBeDefined();
  const capability = Function(
    'SNr',
    'Ede',
    'proxyMode',
    `${declaration};return ${functionName};`,
  )(
    () => denied,
    () => undefined,
    () => nativeFallback,
  ) as (id: string) => boolean;
  return capability(modelId);
}

function executeDefaultEffort(
  source: string,
  modelId: string,
  nativeDefault: string,
): string {
  const declaration = source
    .split('\n')
    .find(line => line.startsWith('function ait('));
  expect(declaration).toBeDefined();
  const defaultEffort = Function(
    'lo',
    'ww',
    `${declaration};return ait;`,
  )(
    (id: string) => id,
    () => ({ default_effort: nativeDefault }),
  ) as (id: string) => string;
  return defaultEffort(modelId);
}

const CAPABILITY_GATES: Array<{
  name: string;
  functionName: CapabilityFunctionName;
}> = [
  { name: 'base effort', functionName: 'OI' },
  { name: 'xhigh effort', functionName: 'I_e' },
  { name: 'max effort', functionName: 'eqe' },
];

describe('patch script identity naming', () => {
  const config = {
    'clodex:openai-oauth:gpt-5.6-sol': {
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
      effort: {
        levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
      },
    },
    'clodex:openai:mystery': { context: 128_000, display: 'Mystery (OpenAI)' },
  };

  const capabilityConfig = {
    'clodex:openai:gpt-5.5': {
      alias: 'standard',
      effort: {
        levels: ['low', 'medium', 'high'],
        defaultLevel: 'high',
      },
    },
    'clodex:openai:gpt-5.6-sol': {
      alias: 'extended',
      effort: {
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'high',
      },
    },
    'clodex:openai:no-effort': {
      alias: 'disabled',
    },
  };

  function runCapabilityPatch(): string {
    return runPatchScript(capabilityConfig, CLAUDE_PROXY_EFFORT_FIXTURE);
  }

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

  it('enables GPT-5.6 effort, xhigh, max, and the native high default for its alias', () => {
    const out = runPatchScript(config);
    expect(out).toContain('/*ccpatch:effort*/');
    expect(out).toContain('/*ccpatch:xhigh-effort*/');
    expect(out).toContain('/*ccpatch:max-effort*/');
    expect(out).toContain('/*ccpatch:default-effort*/');
    expect(out).toContain('"sol":"high"');
  });

  it.each([
    {
      name: 'base only',
      levels: ['low', 'medium', 'high'],
      xhigh: false,
      max: false,
    },
    {
      name: 'xhigh',
      levels: ['low', 'medium', 'high', 'xhigh'],
      xhigh: true,
      max: false,
    },
    {
      name: 'max',
      levels: ['low', 'medium', 'high', 'max'],
      xhigh: false,
      max: true,
    },
  ])('exposes $name effort capabilities independently', ({ levels, xhigh, max }) => {
    const out = runPatchScript({
      'clodex:openai:reasoning-model': {
        effort: { levels, defaultLevel: 'high' },
      },
    });
    expect(out).toContain('/*ccpatch:effort*/');
    expect(out).toContain('/*ccpatch:default-effort*/');
    const xhighVerdicts = out.match(
      /\/\*ccpatch:xhigh-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/,
    )?.[1];
    const maxVerdicts = out.match(
      /\/\*ccpatch:max-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/,
    )?.[1];
    expect(JSON.parse(xhighVerdicts!)).toEqual({
      'clodex:openai:reasoning-model': xhigh,
      'clodex:openai:reasoning-model[1m]': xhigh,
    });
    expect(JSON.parse(maxVerdicts!)).toEqual({
      'clodex:openai:reasoning-model': max,
      'clodex:openai:reasoning-model[1m]': max,
    });
  });

  it.each([
    { name: 'xhigh effort', functionName: 'I_e' as const },
    { name: 'max effort', functionName: 'eqe' as const },
  ])('overrides native true with an explicit false $name verdict', ({ functionName }) => {
    expect(executeCapability(runCapabilityPatch(), functionName, 'standard', true)).toBe(false);
  });

  it.each(CAPABILITY_GATES)(
    'overrides native false with an explicit true $name verdict',
    ({ functionName }) => {
      expect(executeCapability(runCapabilityPatch(), functionName, 'extended', false)).toBe(true);
      expect(executeCapability(runCapabilityPatch(), functionName, 'extended[1m]', false)).toBe(true);
    },
  );

  it.each(CAPABILITY_GATES)(
    'keeps configured no-effort identities false at the $name gate',
    ({ functionName }) => {
      const out = runCapabilityPatch();
      expect(executeCapability(out, functionName, 'disabled', true)).toBe(false);
      expect(executeCapability(out, functionName, 'clodex:openai:no-effort', true)).toBe(false);
      expect(executeCapability(out, functionName, 'clodex:openai:no-effort[1m]', true)).toBe(false);
    },
  );

  it.each(CAPABILITY_GATES)(
    'falls through only for an unconfigured identity at the $name gate',
    ({ functionName }) => {
      const out = runCapabilityPatch();
      expect(executeCapability(out, functionName, 'unconfigured', false)).toBe(false);
      expect(executeCapability(out, functionName, 'unconfigured', true)).toBe(true);
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'falls through for unconfigured object prototype identity %s',
    modelId => {
      const out = runCapabilityPatch();
      for (const { functionName } of CAPABILITY_GATES) {
        expect(executeCapability(out, functionName, modelId, false)).toBe(false);
        expect(executeCapability(out, functionName, modelId, true)).toBe(true);
      }
      expect(executeDefaultEffort(out, modelId, 'medium')).toBe('medium');
    },
  );

  it.each(CAPABILITY_GATES)(
    'keeps the native denylist ahead of the configured $name verdict',
    ({ functionName }) => {
      const out = runCapabilityPatch();
      for (const modelId of ['extended', 'extended[1m]']) {
        expect(executeCapability(
          out,
          functionName,
          modelId,
          false,
          true,
        )).toBe(false);
      }
    },
  );

  it.each([
    'sol',
    'sol[1m]',
    'clodex:openai-oauth:gpt-5.6-sol',
    'clodex:openai-oauth:gpt-5.6-sol[1m]',
  ])('returns high for configured default key %s against native medium', modelId => {
    expect(executeDefaultEffort(runPatchScript(config), modelId, 'medium')).toBe('high');
  });

  it('falls through to the native default for an unconfigured identity', () => {
    expect(executeDefaultEffort(runPatchScript(config), 'unconfigured', 'medium')).toBe('medium');
  });

  it('restores the original network environment for child commands', () => {
    const out = runPatchScript(config);
    const originalNetwork = {
      HTTPS_PROXY: 'http://corp-proxy.example:8080',
      NO_PROXY: '.internal.example',
      NODE_EXTRA_CA_CERTS: '/tmp/corporate-ca.pem',
    };
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      HTTP_PROXY: 'http://127.0.0.1:3457',
      https_proxy: 'http://127.0.0.1:3457',
      http_proxy: 'http://127.0.0.1:3457',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
      CLODEX_ORIGINAL_NETWORK_ENV: JSON.stringify(originalNetwork),
    });

    expect(env).toMatchObject({ PATH: '/usr/bin', ...originalNetwork });
    expect(env['HTTP_PROXY']).toBeUndefined();
    expect(env['https_proxy']).toBeUndefined();
    expect(env['http_proxy']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
    expect(env['CLODEX_ORIGINAL_NETWORK_ENV']).toBeUndefined();
  });

  it('keeps the native child environment unchanged without a wrapper snapshot', () => {
    const out = runPatchScript(config);
    const env = {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.example:8080',
    };

    expect(executeChildEnv(out, env)).toBe(env);
  });

  it('removes bridge network settings when the original environment had none', () => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      HTTP_PROXY: 'http://127.0.0.1:3457',
      https_proxy: 'http://127.0.0.1:3457',
      http_proxy: 'http://127.0.0.1:3457',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
      CLODEX_ORIGINAL_NETWORK_ENV: '{}',
    });

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('falls back to the canonical id as the identity when a model has no alias', () => {
    const out = runPatchScript({ 'clodex:openai:mystery': { context: 128_000 } });
    expect(out).toContain('.enum(["sonnet","opus","haiku","fable","clodex:openai:mystery"])');
    expect(out).toContain('"clodex:openai:mystery"');
    // No alias → nothing to resolve and no picker entry.
    expect(out).not.toContain('case"clodex:openai:mystery":return');
    expect(out).not.toContain('value:"clodex:openai:mystery"');
  });

  it('patches the 2.1.224+ minified enum shape (model:xr([...]))', () => {
    const modern = CLAUDE_FIXTURE.replace(
      '.enum(["sonnet","opus","haiku","fable"])',
      'model:xr(["sonnet","opus","haiku","fable"])',
    );
    expect(modern).not.toBe(CLAUDE_FIXTURE);
    const out = runPatchScript({ 'clodex:openai:mystery': { context: 128_000 } }, modern);
    expect(out).toContain('model:xr(["sonnet","opus","haiku","fable","clodex:openai:mystery"]).optional().describe(');
  });

  it('supports a configured alias that matches an object prototype name', () => {
    const out = runPatchScript({
      'clodex:openai:model': { alias: 'constructor' },
    });
    expect(out).toContain('case"constructor":return "constructor";');
    for (const { functionName } of CAPABILITY_GATES) {
      expect(executeCapability(out, functionName, 'constructor', true)).toBe(false);
    }
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
      ['PATCH 8a: effort capability', 'OK'],
      ['PATCH 8b: xhigh effort capability', 'OK'],
      ['PATCH 8c: max effort capability', 'OK'],
      ['PATCH 9: default effort', 'OK'],
      ['PATCH 10: child network environment', 'OK'],
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
      ['PATCH 8a: effort capability (refresh)', 'SKIP'],
      ['PATCH 8b: xhigh effort capability (refresh)', 'SKIP'],
      ['PATCH 8c: max effort capability (refresh)', 'SKIP'],
      ['PATCH 9: default effort (refresh)', 'SKIP'],
      ['PATCH 10: child network environment', 'SKIP'],
    ]);
  });

  it('captures every successful built-in postcondition before local patches run', () => {
    const patched = applyClodexPatches(CLAUDE_FIXTURE, config);
    const proofs = captureBuiltInPatchProofs(patched.content, config, patched.results);

    expect(proofs).toHaveLength(patched.results.length);
    expect(builtInPatchProofsChanged(patched.content, proofs)).toBe(false);
    expect(builtInPatchProofsChanged(
      patched.content.replace('"fable","sol"', '"sol"'),
      proofs,
    )).toBe(true);
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

  it('keeps identity and context patches when every effort anchor drifts', () => {
    const patched = applyClodexPatches(CLAUDE_CORE_FIXTURE, config);

    expect(patched.content).toContain('.enum(["sonnet","opus","haiku","fable","sol","clodex:openai:mystery"])');
    expect(patched.content).toContain('/*ccpatch:ctx*/');
    expect(patched.results.slice(0, 6).map(result => [result.name, result.status])).toEqual([
      ['PATCH 1: Agent tool model enum', 'OK'],
      ['PATCH 3: known-alias validator list', 'OK'],
      ['PATCH 6: alias resolver switch', 'OK'],
      ['PATCH 5: model picker options', 'OK'],
      ['PATCH 4: Agent tool model description', 'OK'],
      ['PATCH 7: per-model context window', 'OK'],
    ]);
    expect(patched.results.slice(6, -1)).toEqual([
      { status: 'FAIL', name: 'PATCH 8a: effort capability', extra: 'anchor not found' },
      { status: 'FAIL', name: 'PATCH 8b: xhigh effort capability', extra: 'anchor not found' },
      { status: 'FAIL', name: 'PATCH 8c: max effort capability', extra: 'anchor not found' },
      { status: 'FAIL', name: 'PATCH 9: default effort', extra: 'anchor not found' },
    ]);
    expect(patched.results.at(-1)).toEqual({
      status: 'OK',
      name: 'PATCH 10: child network environment',
    });
  });

  it('refreshes every baked effort table when extended capabilities are removed', () => {
    const once = runPatchScript(config);
    const updatedConfig: Parameters<typeof applyClodexPatches>[1] = {
      ...config,
      'clodex:openai-oauth:gpt-5.6-sol': {
        ...config['clodex:openai-oauth:gpt-5.6-sol'],
        effort: {
          levels: ['low', 'medium', 'high'],
          defaultLevel: 'high',
        },
      },
    };
    const updated = runPatchScript(updatedConfig, once);

    const base = updated.match(/\/\*ccpatch:effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const xhigh = updated.match(/\/\*ccpatch:xhigh-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const max = updated.match(/\/\*ccpatch:max-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const defaults = updated.match(/\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];

    expect(JSON.parse(base!)).toEqual({
      sol: true,
      'sol[1m]': true,
      'clodex:openai-oauth:gpt-5.6-sol': true,
      'clodex:openai-oauth:gpt-5.6-sol[1m]': true,
      'clodex:openai:mystery': false,
      'clodex:openai:mystery[1m]': false,
    });
    expect(JSON.parse(xhigh!)).toEqual({
      sol: false,
      'sol[1m]': false,
      'clodex:openai-oauth:gpt-5.6-sol': false,
      'clodex:openai-oauth:gpt-5.6-sol[1m]': false,
      'clodex:openai:mystery': false,
      'clodex:openai:mystery[1m]': false,
    });
    expect(JSON.parse(max!)).toEqual({
      sol: false,
      'sol[1m]': false,
      'clodex:openai-oauth:gpt-5.6-sol': false,
      'clodex:openai-oauth:gpt-5.6-sol[1m]': false,
      'clodex:openai:mystery': false,
      'clodex:openai:mystery[1m]': false,
    });
    expect(JSON.parse(defaults!)).toEqual({
      sol: 'high',
      'sol[1m]': 'high',
      'clodex:openai-oauth:gpt-5.6-sol': 'high',
      'clodex:openai-oauth:gpt-5.6-sol[1m]': 'high',
    });
  });

  it('keeps capability denials and clears defaults when effort is removed', () => {
    const once = runPatchScript(config);
    const { effort: _effort, ...withoutEffort } = config['clodex:openai-oauth:gpt-5.6-sol'];
    const updated = runPatchScript({
      ...config,
      'clodex:openai-oauth:gpt-5.6-sol': withoutEffort,
    }, once);

    const base = updated.match(/\/\*ccpatch:effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const xhigh = updated.match(/\/\*ccpatch:xhigh-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const max = updated.match(/\/\*ccpatch:max-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const defaults = updated.match(/\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];

    const disabledVerdicts = {
      sol: false,
      'sol[1m]': false,
      'clodex:openai-oauth:gpt-5.6-sol': false,
      'clodex:openai-oauth:gpt-5.6-sol[1m]': false,
      'clodex:openai:mystery': false,
      'clodex:openai:mystery[1m]': false,
    };
    expect(JSON.parse(base!)).toEqual(disabledVerdicts);
    expect(JSON.parse(xhigh!)).toEqual(disabledVerdicts);
    expect(JSON.parse(max!)).toEqual(disabledVerdicts);
    expect(JSON.parse(defaults!)).toEqual({});

    for (const { functionName } of CAPABILITY_GATES) {
      expect(executeCapability(updated, functionName, 'sol', true)).toBe(false);
      expect(executeCapability(updated, functionName, 'sol[1m]', true)).toBe(false);
      expect(executeCapability(
        updated,
        functionName,
        'clodex:openai-oauth:gpt-5.6-sol',
        true,
      )).toBe(false);
      expect(executeCapability(
        updated,
        functionName,
        'clodex:openai-oauth:gpt-5.6-sol[1m]',
        true,
      )).toBe(false);
    }
    expect(executeDefaultEffort(updated, 'sol', 'medium')).toBe('medium');
    expect(executeDefaultEffort(updated, 'sol[1m]', 'medium')).toBe('medium');
    expect(executeDefaultEffort(
      updated,
      'clodex:openai-oauth:gpt-5.6-sol',
      'medium',
    )).toBe('medium');
    expect(executeDefaultEffort(
      updated,
      'clodex:openai-oauth:gpt-5.6-sol[1m]',
      'medium',
    )).toBe('medium');
  });
});
