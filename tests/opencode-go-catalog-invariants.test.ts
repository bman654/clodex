import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenCodeGoModels } from '../src/data/opencode-go-models.js';

/**
 * The reviewed catalog, one row per model: id, wire format, resolver family,
 * and the field the upstream streams reasoning in (undefined where the resolver
 * reports none).
 *
 * A per-model table rather than a spot-check, because the generated file now
 * carries resolver metadata: a regeneration that re-points a transport, drops a
 * model, or adopts a field for the wrong entry should fail here with the id
 * named. If you are here after `pnpm update:opencode-go`, read the diff and
 * update this table on purpose — do not relax it.
 */
const REVIEWED_CATALOG: Array<[string, 'anthropic' | 'openai', string, string | undefined]> = [
  ['deepseek-v4-flash', 'openai', 'deepseek-flash', 'reasoning_content'],
  ['deepseek-v4-pro', 'openai', 'deepseek-thinking', 'reasoning_content'],
  ['glm-5.1', 'openai', 'glm', 'reasoning_content'],
  ['glm-5.2', 'openai', 'glm', 'reasoning_content'],
  ['gpt-5.6-luna', 'openai', 'gpt-luna', undefined],
  ['hy3', 'openai', 'Hy', undefined],
  ['kimi-k2.6', 'openai', 'kimi-k2', 'reasoning_content'],
  ['kimi-k2.7-code', 'openai', 'kimi-k2', 'reasoning_content'],
  ['kimi-k3', 'openai', 'kimi-k3', 'reasoning_content'],
  ['mimo-v2.5', 'openai', 'mimo-v2.5', 'reasoning_content'],
  ['mimo-v2.5-pro', 'openai', 'mimo-v2.5-pro', 'reasoning_content'],
  ['minimax-m2.7', 'openai', 'minimax-m2.7', undefined],
  ['minimax-m3', 'anthropic', 'minimax-m3', undefined],
  ['qwen3.6-plus', 'openai', 'qwen3.6', undefined],
  ['qwen3.7-max', 'anthropic', 'qwen3.7-max', undefined],
  ['qwen3.7-plus', 'anthropic', 'qwen3.7-plus', undefined],
  ['qwen3.8-max', 'anthropic', 'qwen3.8-max', undefined],
];

/**
 * The three models the pinned resolver routes differently from clodex. Each
 * conserves the live-validated Chat Completions route; the updater's cross-check
 * refuses to regenerate if any of these divergences changes shape, and this
 * pins the catalog side of the same contract.
 */
const CONSERVED_TRANSPORT_OVERRIDES = ['gpt-5.6-luna', 'minimax-m2.7', 'qwen3.6-plus'];

/**
 * Structural invariants over the WHOLE catalog, not a spot-check of two
 * entries. `buildOpenCodeGoModels()` blind-casts generated JSON, so a botched
 * regeneration would otherwise ship: these assertions are what stands between
 * a bad snapshot day and a broken base URL, SDK package, or effort ladder.
 */
describe('opencode-go catalog invariants', () => {
  const models = buildOpenCodeGoModels();

  it('carries exactly the reviewed models, transports, families, and reasoning fields', () => {
    expect(models.map(model => model.id)).toEqual(REVIEWED_CATALOG.map(([id]) => id));
    const byId = new Map(models.map(model => [model.id, model]));
    for (const [id, modelFormat, family, interleavedReasoningField] of REVIEWED_CATALOG) {
      const model = byId.get(id)!;
      expect(model.modelFormat, id).toBe(modelFormat);
      expect(model.family, id).toBe(family);
      expect(model.interleavedReasoningField, id).toBe(interleavedReasoningField);
      expect(model.upstreamModelId, id).toBe(id);
    }
  });

  it('keeps the three reviewed transport overrides on Chat Completions', () => {
    const byId = new Map(models.map(model => [model.id, model]));
    for (const id of CONSERVED_TRANSPORT_OVERRIDES) {
      expect(byId.get(id), id).toMatchObject({
        modelFormat: 'openai',
        npm: '@ai-sdk/openai-compatible',
        apiUrl: 'https://opencode.ai/zen/go/v1',
      });
    }
  });

  it('every entry routes to opencode.ai over https', () => {
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const url = new URL(model.apiUrl!);
      expect(url.protocol, model.id).toBe('https:');
      expect(url.hostname, model.id).toBe('opencode.ai');
    }
  });

  it('npm and apiUrl agree with modelFormat on every entry', () => {
    // The pairing is what makes protocol selection safe: an anthropic-format
    // entry pointed at the completions URL, or an openai-format entry on the
    // Anthropic SDK, is a request built for the wrong protocol.
    for (const model of models) {
      if (model.modelFormat === 'anthropic') {
        expect(model.npm, model.id).toBe('@ai-sdk/anthropic');
        expect(model.apiUrl, model.id).toBe('https://opencode.ai/zen/go');
      } else {
        expect(model.modelFormat, model.id).toBe('openai');
        expect(model.npm, model.id).toBe('@ai-sdk/openai-compatible');
        expect(model.apiUrl, model.id).toBe('https://opencode.ai/zen/go/v1');
      }
    }
  });

  it('every entry carries a usable context window and a printable name', () => {
    // contextWindow flows into the patched client's context map, where a
    // garbage value breaks auto-compaction rather than failing loudly.
    for (const model of models) {
      expect(Number.isInteger(model.contextWindow), model.id).toBe(true);
      expect(model.contextWindow!, model.id).toBeGreaterThan(0);
      expect(model.contextWindow!, model.id).toBeLessThanOrEqual(10_000_000);
      expect(model.name?.trim(), model.id).toBeTruthy();
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x1f\x7f]/.test(model.name ?? ''), model.id).toBe(false);
    }
  });

  it('no anthropic-format entry advertises an effort ladder it cannot send', () => {
    // Effort reaches an upstream through effortProviderOptions and the
    // thinkingFormat transform, both of which act on an
    // OpenAiCompatibleRequestBody. A passthrough Messages body is forwarded
    // untouched, so a graded effort on this route can never reach the wire.
    for (const model of models.filter(entry => entry.modelFormat === 'anthropic')) {
      expect(model.compatibility?.supportsReasoningEffort, model.id).toBe(false);
      // The same route cannot answer count_tokens upstream either.
      expect(model.compatibility?.supportsCountTokens, model.id).toBe(false);
    }
  });

  it('no entry maps an effort level to a value outside its own ladder', () => {
    // Guards the shape rather than the contents: a mapped value must be a
    // non-empty string, so a typo like `high: ''` cannot silently drop a level
    // into "no opinion" while the level still shows in the picker.
    for (const model of models) {
      for (const [level, mapped] of Object.entries(model.compatibility?.reasoningEffortMap ?? {})) {
        if (mapped === null) continue;
        expect(typeof mapped, `${model.id}.${level}`).toBe('string');
        expect(mapped.trim(), `${model.id}.${level}`).not.toBe('');
      }
    }
  });

  it('keeps prototype names unmapped while regenerating every reviewed model under --verify-ladders', () => {
    const mappedIds = [
      'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.1', 'glm-5.2', 'gpt-5.6-luna',
      'hy3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'mimo-v2.5', 'mimo-v2.5-pro',
      'minimax-m2.7', 'minimax-m3', 'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus',
      'qwen3.8-max',
    ];
    const hostileNames = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
    const effortValues = {
      'deepseek-v4-flash': ['high', 'max'],
      'deepseek-v4-pro': ['high', 'max'],
      'glm-5.2': ['high', 'max'],
      'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      hy3: ['none', 'low', 'high'],
      'kimi-k3': ['max'],
    };
    const feedModels = Object.fromEntries([
      ...mappedIds.map(id => [id, {
        name: `Fixture ${id}`,
        limit: { context: 128_000 },
        cost: { input: 0.1, output: 0.2 },
        modalities: { input: ['text'] },
        reasoning: false,
        ...(effortValues[id as keyof typeof effortValues]
          ? { reasoning_options: [{ type: 'effort', values: effortValues[id as keyof typeof effortValues] }] }
          : id === 'qwen3.6-plus' ? { reasoning_options: [{ type: 'toggle' }] } : {}),
      }]),
      ...hostileNames.map(id => [id, {
        name: `Hostile ${id}`,
        limit: { context: 128_000 },
        cost: { input: 0.1, output: 0.2 },
        modalities: { input: ['text'] },
        reasoning: false,
      }]),
    ]);
    const feed = { 'opencode-go': { models: feedModels } };
    const workspace = mkdtempSync(join(tmpdir(), 'clodex-opencode-go-updater-'));
    const updaterPath = fileURLToPath(new URL('../scripts/update-opencode-go-models.mjs', import.meta.url));
    try {
      mkdirSync(join(workspace, 'src', 'data'), { recursive: true });
      writeFileSync(
        join(workspace, 'src', 'data', 'opencode-go-models.ts'),
        "export const OPENCODE_GO_SOURCE_FETCHED_AT = 'before';\n",
      );
      // The feed is reached only by the explicit advisory mode now that the
      // default regeneration is offline, so the bootstrap hands the updater the
      // argv a real `pnpm update:opencode-go -- --verify-ladders` would give it.
      // Every assertion below is the one this test has always made.
      const childScript = [
        `process.argv = [process.argv[0], ${JSON.stringify(updaterPath)}, '--verify-ladders'];`,
        'globalThis.fetch = async () => ({',
        '  ok: true,',
        '  json: async () => JSON.parse(process.env.CLODEX_TEST_FEED),',
        '});',
        `await import(${JSON.stringify(updaterPath)});`,
      ].join('\n');
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, CLODEX_TEST_FEED: JSON.stringify(feed) },
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('not transport-mapped');
      for (const hostileName of hostileNames) {
        expect(result.stdout).toContain(hostileName);
      }
      const regenerated = JSON.parse(
        readFileSync(join(workspace, 'src', 'data', 'opencode-go-models.json'), 'utf8'),
      ) as Array<{ id: string }>;
      expect(regenerated.map(model => model.id).sort()).toEqual([...mappedIds].sort());
      for (const hostileName of hostileNames) {
        expect(regenerated.some(model => model.id === hostileName)).toBe(false);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
