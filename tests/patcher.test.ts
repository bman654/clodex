import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tweakccRecognizesModuleName } from '../src/bun-entry-module.js';
import {
  CLAUDE_CORE_FIXTURE,
  CLAUDE_FIXTURE,
  CLAUDE_PROXY_EFFORT_FIXTURE,
  CLAUDE_SPLIT_ENTRY_ID,
  CLAUDE_SPLIT_MODULES,
} from './fixtures/claude-bundle.js';
import {
  buildFakeNativeClaude,
  MACHO_MAGIC,
  parseBunBlob,
  rebuildFakeNativeClaude,
} from './bun-blob-fixture.js';
import { execFileSync } from 'node:child_process';
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
import {
  NETWORK_ENV_CONTRACT_VAR,
  networkEnvBaseline,
} from '../src/network-env.js';

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

// The entry-module shim re-signs a Mach-O candidate after repacking it; nothing here should ever
// shell out for real, and asserting on the call is how the resign decision gets discriminated.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

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

  it('filters only stale retained favorites while preserving ordinary unknowns and input order', () => {
    const favorites = [
      { providerId: 'opencode-go', modelId: 'stale-future-model' },
      { providerId: 'imported-opencode', modelId: 'deepseek-v4-pro' },
      { providerId: 'custom-provider', modelId: 'custom-unknown-model' },
      { providerId: 'imported-opencode', modelId: 'stale-future-model' },
      { providerId: 'opencode-go', modelId: 'qwen3.8-max' },
    ];
    const aliases = [
      { name: 'stale', providerId: 'opencode-go', modelId: 'stale-future-model' },
      { name: 'deep', providerId: 'imported-opencode', modelId: 'deepseek-v4-pro' },
      { name: 'custom', providerId: 'custom-provider', modelId: 'custom-unknown-model' },
      { name: 'stale-imported', providerId: 'imported-opencode', modelId: 'stale-future-model' },
      { name: 'qwen', providerId: 'opencode-go', modelId: 'qwen3.8-max' },
    ];
    writeFileSync(join(home, 'config.json'), JSON.stringify({ favoriteModels: favorites, modelAliases: aliases }));
    writeFileSync(join(home, 'providers.json'), JSON.stringify({
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'qwen3.8-max',
            upstreamModelId: 'qwen3.8-max',
            name: 'Qwen 3.8 Max',
            modelFormat: 'openai',
          }, {
            id: 'stale-future-model',
            upstreamModelId: 'stale-future-model',
            name: 'Stale future model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }, {
        id: 'imported-opencode',
        templateId: 'opencode-go',
        name: 'Imported OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:imported-opencode',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'deepseek-v4-pro',
            upstreamModelId: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            modelFormat: 'openai',
          }, {
            id: 'stale-future-model',
            upstreamModelId: 'stale-future-model',
            name: 'Stale future model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }, {
        id: 'custom-provider',
        templateId: 'custom-openai',
        name: 'Custom provider',
        enabled: true,
        authRef: 'keyring:provider:custom-provider',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://custom.invalid/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'custom-unknown-model',
            upstreamModelId: 'custom-unknown-model',
            name: 'Custom unknown model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }],
    }));
    const configBefore = readFileSync(join(home, 'config.json'), 'utf8');
    const providersBefore = readFileSync(join(home, 'providers.json'), 'utf8');

    const desired = buildDesiredPatchConfig();

    expect(Object.keys(desired.config)).toEqual([
      'clodex:imported-opencode:deepseek-v4-pro',
      'clodex:custom-provider:custom-unknown-model',
      'clodex:opencode-go:qwen3.8-max',
    ]);
    expect(desired.config['clodex:imported-opencode:deepseek-v4-pro']?.alias).toBe('deep');
    expect(desired.config['clodex:custom-provider:custom-unknown-model']?.alias).toBe('custom');
    expect(desired.config['clodex:opencode-go:qwen3.8-max']?.alias).toBe('qwen');
    expect(desired.config['clodex:opencode-go:stale-future-model']).toBeUndefined();
    expect(desired.config['clodex:imported-opencode:stale-future-model']).toBeUndefined();
    expect(desired.rejectedAliases).toEqual(expect.arrayContaining([
      aliases[0],
      aliases[3],
    ]));
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(configBefore);
    expect(readFileSync(join(home, 'providers.json'), 'utf8')).toBe(providersBefore);
  });

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
      version: 10,
      digest: 'b7897568a924dfa98b828d6cf4f136638777e5d11216e38a8e7408b9b5639b16',
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

  /**
   * Claude Code 2.1.229 renamed the module tweakcc identifies the bundle by, so extraction and
   * repacking both stopped finding it. The stand-in below reproduces that: it resolves the module
   * BY NAME, exactly as tweakcc does, and — also exactly as tweakcc does — repacks the original
   * contents rather than erroring when no name matches.
   *
   * Without this, the shim is unpinned: removing both calls from `applyPatch` leaves every other
   * patcher test green, because they all hand `readContent` a fixture instead of a binary.
   */
  it('patches a binary whose entry module tweakcc cannot name, and publishes the real name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-entry-module-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const RENAMED_ENTRY = '/$bunfs/root/cli';
    const pristine = Buffer.concat([MACHO_MAGIC, buildFakeNativeClaude('test-version', [
      { name: RENAMED_ENTRY, contents: CLAUDE_FIXTURE },
      { name: '/$bunfs/root/image-processor.js', contents: 'native helper' },
    ])]);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(execFileSync).mockClear();
    mkdirSync(tweakccHome, { recursive: true });
    writeFileSync(binaryPath, pristine, { mode: 0o755 });
    process.env.CLODEX_HOME = dir;
    process.env.TWEAKCC_CONFIG_DIR = tweakccHome;

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => ({ path, version: 'test-version', kind: 'native' }),
    );
    tweakccMocks.readContent.mockImplementation(async ({ path }: { path: string }) => {
      const parsed = parseBunBlob(readFileSync(path));
      const index = parsed.names.findIndex(tweakccRecognizesModuleName);
      if (index < 0) {
        throw new Error(`Failed to extract JavaScript from native installation: ${path}`);
      }
      return parsed.contents[index]!;
    });
    tweakccMocks.writeContent.mockImplementation(
      async ({ path }: { path: string }, content: string) => {
        const parsed = parseBunBlob(readFileSync(path));
        const target = parsed.names.findIndex(tweakccRecognizesModuleName);
        writeFileSync(
          path,
          Buffer.concat([MACHO_MAGIC, rebuildFakeNativeClaude(
            readFileSync(path),
            'test-version',
            (index, previous) => (index === target ? content : previous),
          )]),
          { mode: 0o755 },
        );
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
        { trace: false, manifest: null },
      );

      expect(outcome.ok).toBe(true);
      const published = parseBunBlob(readFileSync(binaryPath));
      // The published binary must carry Claude Code's own module name: its sibling native modules
      // resolve against the entry module's directory.
      expect(published.names[published.entryPointId]).toBe(RENAMED_ENTRY);
      expect(published.names.some(name => name.includes('clodex'))).toBe(false);
      // ...and the bundle inside it must actually be the patched one, which pins the shim around
      // the repack: without it the stand-in silently republishes the original contents.
      expect(published.contents[published.entryPointId]).toContain('/*ccpatch:');
      expect(published.contents[published.entryPointId]).not.toBe(CLAUDE_FIXTURE);
      // The untouched sibling survives the round trip.
      expect(published.contents[1]).toBe('native helper');

      // The pristine backup is the install's own bytes, not a shimmed or re-signed variant.
      const backup = readFileSync(join(tweakccHome, 'native-binary.backup'));
      expect(backup.equals(pristine)).toBe(true);
      const manifest = JSON.parse(readFileSync(getPatchManifestPath(), 'utf8')) as PatchManifest;
      expect(readFileSync(manifest.backupPath).equals(pristine)).toBe(true);
      expect(manifest.pristineSha256).toBe(createHash('sha256').update(pristine).digest('hex'));

      // Exactly one re-sign, for the repack. Signing after the read would have replaced Claude
      // Code's own signature and made the bytes above stop matching the install they came from.
      const signings = vi.mocked(execFileSync).mock.calls.filter(([command]) => command === 'codesign');
      expect(signings).toHaveLength(1);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Claude Code 2.1.242 code-split its bundle. What used to be one module became a small entry that
   * imports ~1,370 `chunk-*.js` siblings, and tweakcc reads and writes only the module it
   * recognizes by name — so `clodex patch` saw a stub with none of its anchors in it and PATCH 1
   * failed on every platform and every executable format at once.
   *
   * The stand-in below reproduces the shape exactly, including the part that makes the write hard:
   * `writeContent` puts the WHOLE buffer into the one module it recognizes, whatever that buffer
   * is. Since the write stopped rebuilding the blob that buffer is a placeholder, and the patched
   * sources are published over it — so a regression that drops the publish leaves the entry module
   * holding the placeholder rather than its patched source, which the entry assertion below
   * catches.
   */
  it('patches a code-split binary whose anchors live in chunks tweakcc never returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-split-bundle-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const pristine = Buffer.concat([MACHO_MAGIC, buildFakeNativeClaude(
      'test-version',
      CLAUDE_SPLIT_MODULES,
      { entryPointId: CLAUDE_SPLIT_ENTRY_ID },
    )]);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(execFileSync).mockReset();
    // What the binary looked like at the moment it was signed. A signature taken BEFORE the
    // pointer edit covers bytes the published file no longer has, and macOS refuses to start it —
    // a failure that counting `codesign` calls cannot see, because the count is the same.
    let signedBytes: Buffer | null = null;
    vi.mocked(execFileSync).mockImplementation(((command: string, args: string[]) => {
      if (command === 'codesign') signedBytes = readFileSync(args[args.length - 1]!);
      return '';
    }) as unknown as typeof execFileSync);
    mkdirSync(tweakccHome, { recursive: true });
    writeFileSync(binaryPath, pristine, { mode: 0o755 });
    process.env.CLODEX_HOME = dir;
    process.env.TWEAKCC_CONFIG_DIR = tweakccHome;

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => ({ path, version: 'test-version', kind: 'native' }),
    );
    tweakccMocks.readContent.mockImplementation(async ({ path }: { path: string }) => {
      const parsed = parseBunBlob(readFileSync(path));
      const index = parsed.names.findIndex(tweakccRecognizesModuleName);
      if (index < 0) {
        throw new Error(`Failed to extract JavaScript from native installation: ${path}`);
      }
      return parsed.contents[index]!;
    });
    tweakccMocks.writeContent.mockImplementation(
      async ({ path }: { path: string }, content: string) => {
        const parsed = parseBunBlob(readFileSync(path));
        writeFileSync(
          path,
          Buffer.concat([MACHO_MAGIC, rebuildFakeNativeClaude(
            readFileSync(path),
            'test-version',
            // EVERY recognized module, exactly as tweakcc does — it has no way to say "this one".
            (index, previous) => (tweakccRecognizesModuleName(parsed.names[index]!)
              ? content
              : previous),
          )]),
          { mode: 0o755 },
        );
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
              context: 272_000,
              display: 'Extended (test)',
              effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high' },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: null },
      );

      expect(outcome.ok ? 'ok' : outcome.message).toBe('ok');

      const published = parseBunBlob(readFileSync(binaryPath));
      expect(published.names[published.entryPointId]).toBe('/$bunfs/root/cli');
      // Every chunk got its OWN patch — the enum in one module, the alias resolver in another,
      // the context and effort tables in a third.
      expect(published.contents[0]).toContain('"extended"');
      expect(published.contents[0]).toContain('Additional custom models: extended = Extended (test).');
      expect(published.contents[2]).toContain('case"extended":return "extended";');
      expect(published.contents[6]).toContain('/*ccpatch:ctx*/');
      expect(published.contents[6]).toContain('/*ccpatch:effort*/');
      // ...and the entry module is still the entry module, not every chunk concatenated into it.
      expect(published.contents[CLAUDE_SPLIT_ENTRY_ID])
        .toBe(CLAUDE_SPLIT_MODULES[CLAUDE_SPLIT_ENTRY_ID]!.contents);
      // The modules Bun does not execute as JavaScript are untouched — including the vendored one
      // at index 1 that carries a copy of the enum anchor. Patch it and the anchor matches twice
      // and the whole patch refuses, which is the only thing keeping the bundle selection honest.
      // Index 5 is different in kind: a real JavaScript helper that IS in the bundle and carries a
      // near-miss, so it proves the transforms left it alone rather than that it was excluded.
      for (const untouched of [1, 4, 5]) {
        expect(published.contents[untouched]).toBe(CLAUDE_SPLIT_MODULES[untouched]!.contents);
      }

      // The pristine backup is the install's own bytes, not a shimmed or re-signed variant.
      expect(readFileSync(join(tweakccHome, 'native-binary.backup')).equals(pristine)).toBe(true);
      // One re-sign, and the bytes it covered already carried the repointed modules.
      const signings = vi.mocked(execFileSync).mock.calls.filter(([command]) => command === 'codesign');
      expect(signings).toHaveLength(1);
      expect(signedBytes).not.toBeNull();
      const atSigning = parseBunBlob(signedBytes!);
      expect(atSigning.contents[0]).toContain('"extended"');
      expect(atSigning.contents[CLAUDE_SPLIT_ENTRY_ID])
        .toBe(CLAUDE_SPLIT_MODULES[CLAUDE_SPLIT_ENTRY_ID]!.contents);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


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
    // Only the 2.1.228- and 2.1.239-shaped fixtures read this; the base fixture
    // ignores it. `getExtra` stands in for the optional call 2.1.239 introduced.
    'settings',
    `${declaration};return childEnv;`,
  )(
    { env },
    () => extraEnv,
    () => false,
    () => ({}),
    { settingsColorEnv: {}, getExtra: () => extraEnv },
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

/**
 * Run the patched /model picker builder and return the option values it yields.
 * Reading the injected snippet is not evidence it runs: the snippet names the
 * options array, and a build that calls that array something other than `e` is
 * exactly where a hardcoded name becomes a ReferenceError inside the picker.
 */
function executePicker(source: string, functionName = 'opts'): string[] {
  // Sliced by brace matching, not by line prefix: the decoy fixture puts a second
  // function on the same line as the real one.
  const start = source.indexOf(`function ${functionName}(`);
  expect(start, `${functionName} present`).toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  expect(end, `${functionName} is balanced`).toBeGreaterThan(start);
  const declaration = source.slice(start, end);
  const build = Function(
    'cur',
    'Dlh',
    `${declaration};return ${functionName};`,
  )(
    () => 'opus',
    (options: { value: string }[], name: string) => options.push({ value: name }),
  ) as (options: { value: string }[], ctx: unknown, current: unknown) => { value: string }[];
  return build([], 'ctx', 'opus').map(option => option.value);
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

  // Claude Code 2.1.228 hoisted the settings-colour env into its own declarator
  // inside the child builder's `let` statement, between the first
  // `Object.keys(...).length>0` binding and the CLAUDE_CODE_REMOTE ternary. An
  // anchor that counted declarators reported "anchor not found", and because
  // PATCH 10 is required, `clodex patch` refused to patch 2.1.228 at all.
  const CLAUDE_FIXTURE_228 = CLAUDE_FIXTURE.replace(
    'let e=extra(),t=Object.keys(e).length>0,n=Object.keys(e).length>0,',
    'let e=extra(),t=Object.keys(e).length>0,c=settings.settingsColorEnv,n=Object.keys(c).length>0,',
  );

  // Claude Code 2.1.239 moved BOTH ends of the same builder in one release, and
  // `clodex patch` refused every one of the eight published builds:
  //   * head — the agent-proxy env moved behind an optional call on a registry
  //     lookup (`e.getAgentProxyEnv?.()??{}`) and the settings-colour env became
  //     a DESTRUCTURING declarator, so the opening `let` now carries braces;
  //   * tail — the GitHub-Actions input scrub (``delete v[`INPUT_${k}`]``) that
  //     the anchor ended on was deleted outright.
  const CLAUDE_FIXTURE_239 = CLAUDE_FIXTURE
    .replace(
      'let e=extra(),t=Object.keys(e).length>0,n=Object.keys(e).length>0,',
      'let h=settings,e=h.getExtra?.()??{},t=Object.keys(e).length>0,'
      + '{settingsColorEnv:c}=h,n=Object.keys(c).length>0,',
    )
    .replace('delete v[k],delete v[`INPUT_${k}`];return v}', 'delete v[k];return v}');

  // The tolerated run admits `[^;{}]` characters or one balanced `{...}` group,
  // so it cannot reach out of the `let` statement it starts in — consuming the
  // enclosing function's closing brace would need an UNMATCHED one. Widen it to
  // `[\s\S]` and the anchor starts at the NEAREST preceding function whose head
  // happens to fit, swallowing everything up to the real builder's tail — so a
  // decoy that opens with the same two bindings must not be able to steal the
  // match. Without this fixture the only test that reddens on that mutation is
  // the sha256 transform-source pin, which is a tripwire, not a behavioural test.
  const CLAUDE_FIXTURE_DECOY = CLAUDE_FIXTURE_228.replace(
    'function childEnv(){',
    'function zzDecoy(){let q=extra(),w=Object.keys(q).length>0,z=w?1:2;return z}'
    + 'function childEnv(){',
  );

  it('does not let a preceding decoy with the same opening bindings steal the match', () => {
    expect(CLAUDE_FIXTURE_DECOY, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE_228);

    const out = runPatchScript(config, CLAUDE_FIXTURE_DECOY);

    expect(out.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
    expect(out).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    expect(out, 'the decoy is left exactly as it was').toContain(
      'function zzDecoy(){let q=extra(),w=Object.keys(q).length>0,z=w?1:2;return z}',
    );
  });

  it('patches a child builder that declares extra bindings before the remote check', () => {
    expect(CLAUDE_FIXTURE_228, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE);

    const result = applyClodexPatches(CLAUDE_FIXTURE_228, config);

    expect(result.results.at(-1)).toEqual({
      status: 'OK',
      name: 'PATCH 10: child network environment',
    });
    expect(result.content.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
    expect(result.content).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    // The added declarator survives, and the body still reads the local copy.
    expect(result.content).toContain('c=settings.settingsColorEnv');
    expect(result.content).toContain('let v={..._clodexChildEnv,...e,...s}');
  });

  it('restores the original network environment through the extra-binding builder', () => {
    const out = runPatchScript(config, CLAUDE_FIXTURE_228);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: {
          HTTPS_PROXY: 'http://corp-proxy.example:8080',
          NODE_EXTRA_CA_CERTS: null,
        },
        injected: {
          HTTPS_PROXY: 'http://127.0.0.1:3457',
          NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
        },
      }),
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://corp-proxy.example:8080',
    });
    expect(env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
    expect(env[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
  });

  it('patches a child builder whose opening let destructures and whose tail lost a scrub', () => {
    expect(CLAUDE_FIXTURE_239, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE);
    expect(CLAUDE_FIXTURE_239, 'the 2.1.239 head rewrite must be present')
      .toContain('{settingsColorEnv:c}=h');
    expect(CLAUDE_FIXTURE_239, 'the 2.1.239 tail rewrite must be present')
      .not.toContain('INPUT_$');

    const result = applyClodexPatches(CLAUDE_FIXTURE_239, config);

    expect(result.results.at(-1)).toEqual({
      status: 'OK',
      name: 'PATCH 10: child network environment',
    });
    expect(result.content.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
    expect(result.content).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    // The rewritten head survives verbatim and the body reads the local copy.
    expect(result.content).toContain('let h=settings,e=h.getExtra?.()??{}');
    expect(result.content).toContain('let v={..._clodexChildEnv,...e,...s}');
  });

  it('restores the original network environment through the destructuring builder', () => {
    const env = executeChildEnv(runPatchScript(config, CLAUDE_FIXTURE_239), {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: {
          HTTPS_PROXY: 'http://corp-proxy.example:8080',
          NODE_EXTRA_CA_CERTS: null,
        },
        injected: {
          HTTPS_PROXY: 'http://127.0.0.1:3457',
          NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
        },
      }),
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://corp-proxy.example:8080',
    });
    expect(env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
    expect(env[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
  });

  // The passthrough early-out identifies the builder, so a bundle carrying two
  // of them means clodex can no longer tell which function it is looking at.
  // `js.match` would silently hand the leftmost one to the anchor.
  it('refuses to guess when a second child-env passthrough appears in the bundle', () => {
    const twin = 'function twinEnv(){if(cond)return process.env;let w={...process.env};return w}';
    const source = CLAUDE_FIXTURE_239.replace('function mcpAllow(){', twin + 'function mcpAllow(){');

    expect(source, 'fixture drifted from the shape this test mutates').toContain(twin);
    // Without the twin the very same fixture patches, so the refusal below is
    // attributable to the second passthrough and not to an unrelated mismatch.
    expect(runPatchScript(config, CLAUDE_FIXTURE_239)).toContain(
      'function childEnv(){/*ccpatch:child-network-env*/',
    );

    let thrown: unknown;
    try {
      applyClodexPatches(source, config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PatchApplyError);
    expect((thrown as PatchApplyError).message).toBe(
      'clodex patch: required patch failed: PATCH 10: child network environment',
    );
    expect((thrown as PatchApplyError).results.at(-1)).toEqual({
      status: 'FAIL',
      name: 'PATCH 10: child network environment',
      extra: 'child env passthrough appears 2 times (expected 1)',
    });
  });

  // Swallowing a NEIGHBOUR is the other direction, and the `}<space>function`
  // guard in the anchor does not stop it: a neighbour introduced as
  // `};var x=()=>{` never matches that guard. If upstream ever minifies the
  // builder's own `return <copy>}` into the comma form `return f(),<copy>}` —
  // a shape that already occurs 400+ times elsewhere in the real 2.1.239
  // bundle — the lazy tail runs past the true end and rewrites the neighbour's
  // `process.env` to a name that is out of scope there, which throws at
  // runtime. Walking the block is what catches it; without that it reports OK.
  it('refuses to run past the builder into a neighbouring arrow function', () => {
    const source = CLAUDE_FIXTURE_239.replace(
      'for(let k of u)delete v[k];return v}',
      'for(let k of u)delete v[k];return finalize(),v};var zzNext=()=>{let v={...process.env};return v}',
    );

    expect(source, 'fixture drifted from the shape this test mutates').not.toBe(CLAUDE_FIXTURE_239);
    expect(source, 'the neighbour must not be introduced by `function`, or the anchor guard hides the case')
      .toContain('};var zzNext=()=>{');

    expect(() => runPatchScript(config, source)).toThrow(
      'clodex patch: child network environment target validation failed',
    );
  });

  // The count identifies the builder, so it has to be taken over Claude Code's
  // own bytes. Earlier sites splice the user's model DISPLAY text into the
  // bundle, so counting the partly-patched buffer lets a model label decide
  // whether clodex can patch at all.
  it('counts the passthrough over the release, not over spliced-in model labels', () => {
    const withHostileLabel = {
      'clodex:openai:gpt-5.6-sol': {
        alias: 'sol',
        display: 'Sol )return process.env;let x={ (OpenAI)',
      },
    };

    const out = applyClodexPatches(CLAUDE_FIXTURE_239, withHostileLabel);

    expect(out.content, 'the label really does reach the bundle')
      .toContain(')return process.env;let x={');
    expect(out.results.at(-1)).toEqual({
      status: 'OK',
      name: 'PATCH 10: child network environment',
    });
    expect(out.content).toContain('function childEnv(){/*ccpatch:child-network-env*/');
  });

  // A `}` inside a string literal is not a closing brace. Counting `{`/`}` as
  // characters says otherwise and refuses a builder clodex can patch perfectly
  // well, so the end-of-function check walks the block instead of tallying.
  it('patches a child builder that carries a closing brace inside a string', () => {
    const source = CLAUDE_FIXTURE_239.replace(
      'for(let k of u)delete v[k];return v}',
      'let z="}";for(let k of u)delete v[k];return v}',
    );

    expect(source, 'fixture drifted from the shape this test mutates').not.toBe(CLAUDE_FIXTURE_239);

    const result = applyClodexPatches(source, config);

    expect(result.results.at(-1)).toEqual({
      status: 'OK',
      name: 'PATCH 10: child network environment',
    });
    expect(result.content).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    // The whole function was rewritten: nothing after the string brace kept a
    // live `process.env`, which is what a truncated match would leave behind.
    expect(result.content).toContain('let v={..._clodexChildEnv,...e,...s}');
  });

  // The pair that defeats a character tally: a string brace offsets the `{` of a
  // nested `return <copy>}`, so the tally reads a truncated match as balanced and
  // the patch reports OK while leaving the rest of the function unrewritten.
  it('refuses a truncated match that a brace tally would read as balanced', () => {
    const source = CLAUDE_FIXTURE_239.replace(
      'for(let k of u)delete v[k];return v}',
      'let z="}";if(o[0]){return v}for(let k of u)delete v[k];return v}',
    );

    expect(source, 'fixture drifted from the shape this test mutates').not.toBe(CLAUDE_FIXTURE_239);
    // Prove the tally really is fooled, so this test cannot pass for some other
    // reason: over the region a truncated match would capture, `{` and `}` balance.
    const truncated = source.slice(
      source.indexOf('function childEnv(){') + 'function childEnv(){'.length,
      source.indexOf('if(o[0]){return v}') + 'if(o[0]){return v'.length,
    );
    expect([...truncated].reduce((d, c) => d + (c === '{' ? 1 : c === '}' ? -1 : 0), 0)).toBe(0);

    expect(() => runPatchScript(config, source)).toThrow(
      'clodex patch: child network environment target validation failed',
    );
  });

  // The tail is found lazily, so a nested `return <copy>}` earlier in the body
  // would end the match inside the function and the replacement would truncate
  // it into unparseable JavaScript. Walking the block turns that into a loud
  // refusal instead.
  it('refuses a match that would end at a nested return of the merged copy', () => {
    const source = CLAUDE_FIXTURE_239.replace(
      'for(let k of u)delete v[k];return v}',
      'if(o[0]){delete v.CLAUDE_CODE_OAUTH_TOKEN;return v}for(let k of u)delete v[k];return v}',
    );

    expect(source, 'fixture drifted from the shape this test mutates').not.toBe(CLAUDE_FIXTURE_239);
    expect(() => runPatchScript(config, source)).toThrow(
      'clodex patch: child network environment target validation failed',
    );
  });

  // The tail is `return <copy>}` with <copy> BACK-REFERENCED from the merged copy
  // the builder declares. Spell it `return [\w$]+` instead and a nested return of
  // any OTHER variable ends the match early, which the brace-balance check then
  // refuses — so a builder clodex can patch today would stop being patchable.
  it('skips a nested return of a different variable to reach the real tail', () => {
    const source = CLAUDE_FIXTURE_239.replace(
      'for(let k of u)delete v[k];return v}',
      'if(o[0]){delete v.CLAUDE_CODE_OAUTH_TOKEN;return e}for(let k of u)delete v[k];return v}',
    );

    expect(source, 'fixture drifted from the shape this test mutates').not.toBe(CLAUDE_FIXTURE_239);

    const result = applyClodexPatches(source, config);

    expect(result.results.at(-1)).toEqual({
      status: 'OK',
      name: 'PATCH 10: child network environment',
    });
    expect(result.content).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    // The nested early return is inside the patched body, so the match ran past it
    // to the builder's own closing brace rather than stopping short.
    expect(result.content).toContain('if(o[0]){delete v.CLAUDE_CODE_OAUTH_TOKEN;return e}');
  });

  // Each literal is an independent statement about what the target function does.
  // The anchor alone cannot tell the child-env builder from another function that
  // merges process.env, so dropping any one of these must refuse rather than
  // patch a lookalike.
  it.each([
    ['the OAuth credential it scrubs', 'CLAUDE_CODE_OAUTH_TOKEN', 'SOMETHING_ELSE_TOKEN'],
    ['the subscription type it scrubs', 'CLAUDE_CODE_SUBSCRIPTION_TYPE', 'SOMETHING_ELSE_TYPE'],
    ['the background PTY token it scrubs', 'CLAUDE_BG_PTY_AUTH', 'SOMETHING_ELSE_AUTH'],
    ['the OTEL prefix it strips', '"OTEL_"', '"UNRELATED_"'],
    ['the OTEL diagnostic flag it strips', 'CLAUDE_CODE_OTEL_DIAG_STDERR', 'SOMETHING_ELSE_DIAG'],
  ])('refuses a child builder that no longer references %s', (_name, literal, replacement) => {
    // Replace EVERY occurrence: the check is `body.includes(literal)`, so one
    // surviving mention anywhere in the body keeps the guard satisfied and the
    // test passes without testing anything.
    const source = CLAUDE_FIXTURE_239.split(literal).join(replacement);

    expect(source, 'fixture drifted from the shape this test mutates').not.toBe(CLAUDE_FIXTURE_239);
    expect(source, 'no occurrence of the literal may survive').not.toContain(literal);
    expect(() => runPatchScript(config, source)).toThrow(
      'clodex patch: child network environment target validation failed',
    );
  });

  it('targets the child builder when a token-bearing function follows it', () => {
    const source = CLAUDE_FIXTURE.replace(
      '}function mcpAllow(){',
      '}function adjacent(){let e=process.env.CLAUDE_CODE_REMOTE;'
      + 'return process.env.CLAUDE_CODE_OAUTH_TOKEN}function mcpAllow(){',
    );
    const out = runPatchScript(config, source);

    expect(out.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
    expect(out).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    expect(out).toContain('function adjacent(){let e=process.env.CLAUDE_CODE_REMOTE;');
    expect(out).not.toContain('function adjacent(){/*ccpatch:child-network-env*/');
  });

  it.each([
    ['named', 'function nested(){}'],
    ['anonymous', 'let nested=function(){};'],
  ])('rejects a %s nested function in the child-environment patch target', (_name, nested) => {
    const source = CLAUDE_FIXTURE.replace(
      's=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};let o=',
      `s=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};${nested}let o=`,
    );

    expect(() => runPatchScript(config, source)).toThrow(
      'clodex patch: child network environment target validation failed',
    );
  });

  it('rejects a child builder whose merge spread no longer reads process.env', () => {
    const source = CLAUDE_FIXTURE.replace(
      'let v={...process.env,...e,...s}',
      'let v={...te,...e,...s}',
    );

    expect(() => runPatchScript(config, source)).toThrow(
      'clodex patch: child network environment target validation failed',
    );
  });

  it('restores the original network environment for child commands', () => {
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
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: {
          HTTPS_PROXY: 'http://corp-proxy.example:8080',
          HTTP_PROXY: null,
          https_proxy: null,
          http_proxy: null,
          NO_PROXY: '.internal.example',
          no_proxy: null,
          NODE_EXTRA_CA_CERTS: '/tmp/corporate-ca.pem',
        },
        injected: {
          HTTPS_PROXY: 'http://127.0.0.1:3457',
          HTTP_PROXY: 'http://127.0.0.1:3457',
          https_proxy: 'http://127.0.0.1:3457',
          http_proxy: 'http://127.0.0.1:3457',
          NO_PROXY: 'localhost',
          no_proxy: 'localhost',
          NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
        },
      }),
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://corp-proxy.example:8080',
      NO_PROXY: '.internal.example',
      NODE_EXTRA_CA_CERTS: '/tmp/corporate-ca.pem',
    });
    expect(env['HTTP_PROXY']).toBeUndefined();
    expect(env['https_proxy']).toBeUndefined();
    expect(env['http_proxy']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
    expect(env[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
  });

  it('restores the original network environment on the merge branch', () => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: {
          HTTPS_PROXY: 'http://proxy.example.test:8080',
          NODE_EXTRA_CA_CERTS: '/tmp/external-ca.pem',
        },
        injected: {
          HTTPS_PROXY: 'http://127.0.0.1:3457',
          NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
        },
      }),
    }, {
      CHILD_ENV_MARKER: 'merge-branch',
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      CHILD_ENV_MARKER: 'merge-branch',
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      NODE_EXTRA_CA_CERTS: '/tmp/external-ca.pem',
    });
    expect(env[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
  });

  it('keeps the native child environment unchanged without a wrapper snapshot', () => {
    const out = runPatchScript(config);
    const env = {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.example:8080',
    };

    expect(executeChildEnv(out, env)).toBe(env);
  });

  it('preserves a network value replaced after the bridge was injected', () => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://settings-proxy.example:9000',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: { HTTPS_PROXY: 'http://corp-proxy.example:8080' },
        injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
      }),
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://settings-proxy.example:9000',
    });
  });

  it('removes a matching bridge value when the external environment had none', () => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: { HTTPS_PROXY: null },
        injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
      }),
    });

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it.each([
    ['array', '[]'],
    ['null', 'null'],
    ['non-string value', JSON.stringify({
      version: 1,
      original: { HTTPS_PROXY: null },
      injected: { HTTPS_PROXY: 42 },
    })],
    ['invalid JSON', '{'],
  ])('fails open for %s child-network metadata', (_name, contract) => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      [NETWORK_ENV_CONTRACT_VAR]: contract,
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
    });
  });

  it.each([
    ['valid pair', {
      version: 1,
      original: { HTTPS_PROXY: 'http://proxy.example.test:8080' },
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
    }],
    ['missing injected key', {
      version: 1,
      original: { HTTPS_PROXY: null },
      injected: {},
    }],
    ['missing original key', {
      version: 1,
      original: {},
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
    }],
    ['unknown original key', {
      version: 1,
      original: { HTTPS_PROXY: null, EXTRA_PROXY: null },
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457', EXTRA_PROXY: null },
    }],
    ['unknown injected key', {
      version: 1,
      original: { EXTRA_PROXY: null },
      injected: { EXTRA_PROXY: 'http://127.0.0.1:3457' },
    }],
    ['invalid original value', {
      version: 1,
      original: { HTTPS_PROXY: 42 },
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
    }],
    ['invalid injected value', {
      version: 1,
      original: { HTTPS_PROXY: null },
      injected: { HTTPS_PROXY: false },
    }],
    ['invalid version', {
      version: 2,
      original: { HTTPS_PROXY: null },
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
    }],
  ])('matches the host contract reader for %s', (_name, contract) => {
    const out = runPatchScript(config);
    const baseEnv = {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify(contract),
    };

    expect(executeChildEnv(out, baseEnv, { CHILD_ENV_MARKER: 'merge-branch' })).toEqual({
      ...networkEnvBaseline(baseEnv),
      CHILD_ENV_MARKER: 'merge-branch',
    });
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

  const PICKER_STD =
    'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}';
  const pickerSite = (result: ReturnType<typeof applyClodexPatches>) =>
    result.results.find(site => site.name.startsWith('PATCH 5'));

  // Claude Code 2.1.238 shipped per-platform builds whose minifier named this
  // same function differently: `(e,t,r){let n=...}` on five of the eight published
  // builds, but `(e,t,n){let r=...}` on linux-arm64, linux-arm64-musl and
  // win32-arm64. An anchor that spelled those identifiers out silently dropped the
  // picker entries on the other three.
  const CLAUDE_FIXTURE_238_ARM = CLAUDE_FIXTURE.replace(
    PICKER_STD,
    'function opts(e,t,n){let r=cur(),o=(r==="opus"||r==="sonnet")&&r!==n?[r,n]:[n];for(let i of o)Dlh(e,i,t);return e}',
  );

  // The same build shape, but with the OPTIONS ARRAY itself renamed. Nothing in
  // the bundle guarantees it is called `e` — the injected snippet has to use the
  // name this build gave it, or the picker throws a ReferenceError at runtime
  // while `clodex patch` still reports OK.
  const CLAUDE_FIXTURE_238_RENAMED_ARRAY = CLAUDE_FIXTURE.replace(
    PICKER_STD,
    'function opts(a,t,n){let r=cur(),o=(r==="opus"||r==="sonnet")&&r!==n?[r,n]:[n];for(let i of o)Dlh(a,i,t);return a}',
  );

  // The strongest competitor: the exact ternary → loop → three-argument-appender
  // shape AND its own opus/sonnet selection, so nothing in the anchor itself can
  // tell it from the picker. A review put one of these immediately before the real
  // builder and moved the real builder out of the match with a single space
  // (`for(` → `for (`); PATCH 5 reported OK and injected into the impostor. The
  // whole-bundle selection count is what turns that into a refusal.
  const DECOY_SELECTING =
    'function zzTwin(a,b,c){let d=cur(),f=(d==="opus"||d==="sonnet")&&d!==c?[d,c]:[c];for(let g of f)Dlh(a,g,b);return a}';
  const CLAUDE_FIXTURE_TWIN = CLAUDE_FIXTURE.replace(PICKER_STD, DECOY_SELECTING + PICKER_STD);
  const CLAUDE_FIXTURE_TWIN_DRIFTED = CLAUDE_FIXTURE_TWIN.replace(
    'for(let i of o)Dlh(e,i,t);return e}',
    'for (let i of o)Dlh(e,i,t);return e}',
  );

  // A competitor with the same shape but selecting on something that is not a
  // model family: rejected by the discriminator rather than by the count.
  const DECOY_GENERIC =
    'function zzGeneric(a,b,c){let d=cur(),f=(d==="fast")&&d!==c?[d,c]:[c];for(let g of f)Dlh(a,g,b);return a}';
  const CLAUDE_FIXTURE_GENERIC_DECOY = CLAUDE_FIXTURE.replace(
    PICKER_STD,
    DECOY_GENERIC + PICKER_STD,
  );
  // The same competitor, with the real picker put cosmetically out of reach.
  const CLAUDE_FIXTURE_DECOY_ONLY = CLAUDE_FIXTURE_GENERIC_DECOY.replace(
    'for(let i of o)Dlh(e,i,t);return e}',
    'for (let i of o)Dlh(e,i,t);return e}',
  );

  it('patches a build whose picker builder minified to different identifiers', () => {
    expect(CLAUDE_FIXTURE_238_ARM, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE);

    const result = applyClodexPatches(CLAUDE_FIXTURE_238_ARM, config);

    expect(pickerSite(result)).toEqual({ status: 'OK', name: 'PATCH 5: model picker options' });
    expect(executePicker(result.content)).toContain('sol');
  });

  it('binds the injected entries to the options array this build actually named', () => {
    expect(CLAUDE_FIXTURE_238_RENAMED_ARRAY, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE);

    const result = applyClodexPatches(CLAUDE_FIXTURE_238_RENAMED_ARRAY, config);

    expect(pickerSite(result)?.status).toBe('OK');
    expect(result.content).toContain('a.push(_o)');
    expect(result.content).not.toContain('e.push(_o)');
    // The proof that matters: the patched builder RUNS and yields the entries.
    // `cur()` and the third argument both stub to "opus", so the builder appends
    // that one built-in before our entries; the unaliased model gets no picker
    // entry.
    expect(executePicker(result.content)).toEqual(['opus', 'sol']);
  });

  it.each([
    ['alongside the picker', () => CLAUDE_FIXTURE_TWIN],
    ['while the picker itself drifts out of the match', () => CLAUDE_FIXTURE_TWIN_DRIFTED],
  ])('refuses to patch anything when a second builder also selects a model, %s', (_case, fixture) => {
    const source = fixture();
    expect(source, 'fixture drifted from the shape this test mutates').not.toBe(CLAUDE_FIXTURE);

    const result = applyClodexPatches(source, config);

    expect(pickerSite(result)).toEqual({
      status: 'FAIL',
      name: 'PATCH 5: model picker options',
      extra: 'model selection appears 2 times (expected 1)',
    });
    expect(result.content, 'nothing was injected').not.toContain('{value:"sol",label:"Sol"');
    expect(result.content, 'the competitor is left exactly as it was').toContain(DECOY_SELECTING);
  });

  it('ignores a same-shaped builder that does not select between opus and sonnet', () => {
    expect(CLAUDE_FIXTURE_GENERIC_DECOY, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE);

    const result = applyClodexPatches(CLAUDE_FIXTURE_GENERIC_DECOY, config);

    expect(pickerSite(result)?.status).toBe('OK');
    expect(result.content.match(/\{value:"sol",label:"Sol"/g)).toHaveLength(1);
    expect(result.content, 'the competitor is left exactly as it was').toContain(DECOY_GENERIC);
    expect(executePicker(result.content)).toContain('sol');
    expect(executePicker(result.content, 'zzGeneric'), 'the competitor gained no entries')
      .not.toContain('sol');
  });

  it('reports a miss rather than patching a same-shaped builder when the picker drifts', () => {
    expect(CLAUDE_FIXTURE_DECOY_ONLY, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE_GENERIC_DECOY);

    const result = applyClodexPatches(CLAUDE_FIXTURE_DECOY_ONLY, config);

    // A structure-only anchor reports OK here, having patched zzGeneric.
    expect(pickerSite(result)).toEqual({
      status: 'FAIL',
      name: 'PATCH 5: model picker options',
      extra: 'anchor not found',
    });
    expect(result.content).not.toContain('{value:"sol",label:"Sol"');
    expect(result.content, 'the competitor is left exactly as it was').toContain(DECOY_GENERIC);
  });

  // The back-references decide WHICH variable is captured as the options array.
  // Loosen them and each of these builders matches, with the capture landing on a
  // variable that is not the list — so the patch must refuse them. The selection
  // count cannot catch these: each fixture still has exactly one selection.
  it.each([
    [
      'the loop variable is not the appender\'s middle argument',
      'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];for(let i of o)Dlh(e,t,i);return e}',
    ],
    [
      'the fallback array does not repeat the pair',
      'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[t];for(let i of o)Dlh(e,i,t);return e}',
    ],
  ])('refuses a builder whose shape does not line up: %s', (_case, builder) => {
    const source = CLAUDE_FIXTURE.replace(PICKER_STD, builder);
    expect(source, 'fixture drifted from the shape this test mutates').not.toBe(CLAUDE_FIXTURE);

    const result = applyClodexPatches(source, config);

    expect(pickerSite(result)).toEqual({
      status: 'FAIL',
      name: 'PATCH 5: model picker options',
      extra: 'anchor not found',
    });
    expect(result.content).not.toContain('{value:"sol",label:"Sol"');
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

  it('splices the model list at the template\'s real close even when it holds an escaped backtick', () => {
    // The anchor ends at the template's closing backtick and deliberately says nothing about what
    // FOLLOWS it — requiring `)` is exactly what drifted when 2.1.242 started concatenating a
    // conditional sentence onto the same string. But a wildcard that stops at the first backtick
    // BYTE stops mid-escape on a description containing `` \` ``, and splicing there turns the
    // once-escaped backtick into a live terminator: a syntax error in a module Bun loads at
    // startup. The wildcard skips backslash pairs so it cannot stop there.
    //
    // No shipped release has an escaped backtick here, so this pins a corner that must stay
    // fail-safe rather than one that fires today.
    const escaped = CLAUDE_FIXTURE.replace(
      'Optional model override for this agent',
      'Optional model override for this agent, or \\` inherit \\` instead',
    );
    expect(escaped, 'fixture drifted from the shape this test rewrites').not.toBe(CLAUDE_FIXTURE);

    const out = applyClodexPatches(escaped, config);
    expect(out.results.find(r => r.name.startsWith('PATCH 4'))!.status).toBe('OK');
    // The addition lands after the LAST segment of the description, not after the backslash.
    expect(out.content).toContain('inherit \\` instead. Defaults to inherit. Additional custom models:');
    // ...and the result is still parseable JavaScript: the template still has exactly one opener
    // and one closer, so nothing after it became live tokens.
    const described = /describe\(`(?:[^`\\]|\\.)*`/.exec(out.content)![0];
    expect(() => new Function('describe', `return ${described});`)).not.toThrow();
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
