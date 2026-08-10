import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import snapshot from '../src/data/opencode-go-cli-snapshot.json';
// The updater is a maintainer-facing JavaScript entry point, intentionally not
// part of the published TypeScript API surface.
// @ts-expect-error no declaration file for the maintenance script
import {
  canonicalizeResolvedModels,
  convertResolvedModels,
  parseOpenCodeVerboseOutput,
  run,
  snapshotFrom,
} from '../scripts/update-opencode-go-models.mjs';

function resolvedModel(
  id: string,
  npm: string,
  variants: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    providerID: 'opencode-go',
    name: id,
    family: id.split('-')[0],
    api: { id, url: 'https://opencode.ai/zen/go/v1', npm },
    status: 'active',
    release_date: '2026-08-09',
    headers: {},
    options: {},
    cost: { input: 1, output: 2, cache: { read: 0.25, write: 0 } },
    limit: { context: 200_000, output: 10_000 },
    capabilities: {
      reasoning: true,
      attachment: false,
      temperature: true,
      toolcall: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, pdf: false, video: false },
      output: { text: true, image: false, audio: false, pdf: false, video: false },
    },
    variants,
  };
}

function reviewedQwenModels(): Record<string, unknown>[] {
  return ['qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-max'].map(id =>
    resolvedModel(id, '@ai-sdk/anthropic', {
      high: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
      max: { thinking: { type: 'enabled', budgetTokens: 31_999 } },
    }));
}

function withReviewedQwenModels(models: Record<string, unknown>[]): Record<string, unknown>[] {
  const ids = new Set(models.map(model => model.id));
  return [...models, ...reviewedQwenModels().filter(model => !ids.has(model.id))];
}

describe('OpenCode Go CLI catalog generator', () => {
  it('canonicalizes ASCII ids by code unit without host locale/ICU ordering', () => {
    const rows = [
      { id: 'a0' },
      { id: 'a.' },
      { id: 'a-' },
    ];
    expect(JSON.parse(canonicalizeResolvedModels(rows)).map((row: { id: string }) => row.id))
      .toEqual(['a-', 'a.', 'a0']);
  });

  it('parses verbose labels plus JSON objects and rejects a mismatched label', () => {
    const first = resolvedModel('alpha', '@ai-sdk/openai-compatible');
    const second = resolvedModel('beta', '@ai-sdk/anthropic');
    const verbose = `opencode-go/alpha\n${JSON.stringify(first, null, 2)}\n`
      + `opencode-go/beta\n${JSON.stringify(second, null, 2)}\n`;

    expect(parseOpenCodeVerboseOutput(verbose).map((model: { id: string }) => model.id))
      .toEqual(['alpha', 'beta']);
    expect(() => parseOpenCodeVerboseOutput(verbose.replace('opencode-go/alpha', 'opencode-go/wrong')))
      .toThrow(/label wrong does not match object alpha/);
  });

  it('derives only supported transports and exact reasoning-effort variants', () => {
    const compatible = resolvedModel('chat', '@ai-sdk/openai-compatible', {
      none: { reasoningEffort: 'none' },
      high: { reasoningEffort: 'high' },
    });
    const messages = resolvedModel('qwen3.6-plus', '@ai-sdk/anthropic', {
      high: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
      max: { thinking: { type: 'enabled', budgetTokens: 31_999 } },
    });
    const responses = resolvedModel('responses', '@ai-sdk/openai', {
      max: {
        include: ['reasoning.encrypted_content'],
        reasoningEffort: 'max',
        reasoningSummary: 'auto',
      },
    });

    const result = convertResolvedModels(withReviewedQwenModels([responses, messages, compatible]));
    expect(result.omittedResponses).toEqual(['responses']);
    expect(result.supported).toHaveLength(5);
    expect(result.supported.find((model: { id: string }) => model.id === 'chat')).toMatchObject({
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      apiUrl: 'https://opencode.ai/zen/go/v1',
      compatibility: {
        reasoningEffortMap: { off: 'none', high: 'high' },
        reasoningEffortDefault: null,
      },
    });
    expect(result.supported.find((model: { id: string }) => model.id === 'qwen3.6-plus')).toMatchObject({
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      apiUrl: 'https://opencode.ai/zen/go',
      compatibility: {
        anthropicThinkingBudgetMap: { high: 16_000, max: 31_999 },
        reasoningEffortDefault: null,
        supportsCountTokens: false,
      },
    });
  });

  it('keeps non-budget Anthropic thinking variants as provenance only', () => {
    const messages = resolvedModel('messages', '@ai-sdk/anthropic', {
      none: { thinking: { type: 'disabled' } },
      thinking: { thinking: { type: 'adaptive' } },
    });
    expect(convertResolvedModels(withReviewedQwenModels([messages])).supported[0]).toMatchObject({
      compatibility: {
        supportsReasoningEffort: false,
        supportsCountTokens: false,
      },
    });
    expect(convertResolvedModels(withReviewedQwenModels([messages])).supported[0]?.compatibility)
      .not.toHaveProperty('anthropicThinkingBudgetMap');
  });

  it('fails closed instead of partially mapping mixed Anthropic thinking shapes', () => {
    const messages = resolvedModel('messages', '@ai-sdk/anthropic', {
      high: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
      thinking: { thinking: { type: 'adaptive' } },
    });
    expect(() => convertResolvedModels([messages])).toThrow(/cannot partially map mixed/);
  });

  it('requires explicit review for new or changed Anthropic thinking budgets', () => {
    expect(() => convertResolvedModels([resolvedModel('new-messages-model', '@ai-sdk/anthropic', {
      high: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
    })])).toThrow(/explicit reviewed mapping/);
    expect(() => convertResolvedModels([resolvedModel('qwen3.6-plus', '@ai-sdk/anthropic', {
      high: { thinking: { type: 'enabled', budgetTokens: 16_001 } },
      max: { thinking: { type: 'enabled', budgetTokens: 31_999 } },
    })])).toThrow(/changed from the reviewed mapping/);
  });

  it('requires every reviewed budget model to remain in the Anthropic Messages catalog', () => {
    expect(() => convertResolvedModels(
      snapshot.models.filter(model => model.id !== 'qwen3.6-plus'),
    )).toThrow(/missing or changed transport: qwen3\.6-plus/);

    const changedTransport = structuredClone(snapshot.models);
    const qwen = changedTransport.find(model => model.id === 'qwen3.6-plus');
    if (!qwen) throw new Error('missing qwen3.6-plus fixture');
    qwen.api.npm = '@ai-sdk/openai-compatible';
    qwen.variants = {
      high: { reasoningEffort: 'high' },
      max: { reasoningEffort: 'max' },
    };
    expect(() => convertResolvedModels(changedTransport))
      .toThrow(/missing or changed transport: qwen3\.6-plus/);
  });

  it('fails closed for an SDK transport the converter does not know', () => {
    expect(() => convertResolvedModels([resolvedModel('future', '@ai-sdk/future')]))
      .toThrow(/unsupported SDK transport/);
  });

  it.each([
    ['an Authorization header', (model: any) => { model.headers.Authorization = 'Bearer secret'; }, /headers|forbidden key/i],
    ['a secret option', (model: any) => { model.options.apiKey = 'secret'; }, /options|forbidden key/i],
    ['URL credentials', (model: any) => { model.api.url = 'https://user:pass@opencode.ai/zen/go/v1'; }, /api\.url must be exactly/i],
    ['an unknown model field', (model: any) => { model.telemetry = 'unexpected'; }, /unsupported key telemetry/i],
    ['an inactive status', (model: any) => { model.status = 'deprecated'; }, /status must be active/i],
    ['a string cost', (model: any) => { model.cost.input = '1'; }, /non-negative finite number/i],
    ['a control-character id', (model: any) => { model.id = 'bad\nid'; model.api.id = 'bad\nid'; }, /control character/i],
  ])('rejects %s at the committed snapshot boundary', (_name, mutate, expected) => {
    const model = resolvedModel('safe-model', '@ai-sdk/openai-compatible');
    mutate(model);
    expect(() => convertResolvedModels([model])).toThrow(expected);
  });

  it('rejects supported models without coding text/tool capabilities', () => {
    const model = resolvedModel('no-tools', '@ai-sdk/openai-compatible') as any;
    model.capabilities.toolcall = false;
    expect(() => convertResolvedModels([model])).toThrow(/text input, text output, and tool calls/);
  });

  it('rejects compatible variants whose extra request shape would be dropped', () => {
    const model = resolvedModel('chat', '@ai-sdk/openai-compatible', {
      high: { reasoningEffort: 'high', reasoningSummary: 'auto' },
    });
    expect(() => convertResolvedModels([model])).toThrow(/unsupported key reasoningSummary/);
  });

  it('validates release/version provenance before creating a safe snapshot', () => {
    const provenance = {
      openCodeVersion: '1.18.15',
      releaseTag: 'v1.18.14',
      releaseCommit: 'd7b115f623760e68a4749d16508a9eca350f246f',
      releaseAsset: 'opencode-darwin-arm64.zip',
      releaseAssetSha256: 'b'.repeat(64),
      rawCatalogSha256: '7'.repeat(64),
      capturedAt: '2026-08-09T17:47:18Z',
    };
    expect(() => snapshotFrom(
      [resolvedModel('chat', '@ai-sdk/openai-compatible')],
      provenance,
    )).toThrow(/release-tag must equal/);
  });

  it('pins the committed resolver hash and preserves unexpressed variants verbatim', async () => {
    const canonical = canonicalizeResolvedModels(snapshot.models);
    expect(snapshot._meta).toMatchObject({
      releaseTag: 'v1.18.15',
      releaseCommit: 'd7b115f623760e68a4749d16508a9eca350f246f',
      releaseAsset: 'opencode-darwin-arm64.zip',
      rawCatalogSha256: '7190dad062bbe077974f95c4dcf0ba945fc7beae274f7faf2f9c6ce217f65770',
      capturedAt: '2026-08-09T17:47:18Z',
    });
    expect(snapshot.models).toHaveLength(18);
    expect(snapshot.models.filter(model => model.api.npm === '@ai-sdk/openai-compatible')).toHaveLength(10);
    expect(snapshot.models.filter(model => model.api.npm === '@ai-sdk/anthropic')).toHaveLength(6);
    expect(snapshot.models.filter(model => model.api.npm === '@ai-sdk/openai')).toHaveLength(2);
    expect(createHash('sha256').update(canonical).digest('hex'))
      .toBe('fa41e01da5fe41fb08e75b37adf1c5404902489c4dc76d390e5209f555897cb4');
    expect(snapshot.models.find(model => model.id === 'qwen3.6-plus')?.variants).toEqual({
      high: { thinking: { budgetTokens: 16_000, type: 'enabled' } },
      max: { thinking: { budgetTokens: 31_999, type: 'enabled' } },
    });

    const generated = convertResolvedModels(snapshot.models);
    const committed = JSON.parse(await readFile('src/data/opencode-go-models.json', 'utf8'));
    expect(committed).toEqual(generated.supported);
    await expect(run(['--check'])).resolves.toBeUndefined();
  });
});
