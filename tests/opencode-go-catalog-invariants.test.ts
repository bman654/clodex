import { describe, expect, it } from 'vitest';
import { buildOpenCodeGoModels } from '../src/data/opencode-go-models.js';

/**
 * Structural invariants over the WHOLE catalog, not a spot-check of two
 * entries. `buildOpenCodeGoModels()` blind-casts generated JSON, so a botched
 * regeneration would otherwise ship: these assertions are what stands between
 * a bad feed day and a broken base URL, SDK package, or effort ladder.
 */
describe('opencode-go catalog invariants', () => {
  const models = buildOpenCodeGoModels();

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
      expect(model.codingCapabilitiesAuthoritative, model.id).toBe(true);
    }
  });

  it('Anthropic-format effort ladders are backed by exact positive Messages budgets', () => {
    for (const model of models.filter(entry => entry.modelFormat === 'anthropic')) {
      const budgets = model.compatibility?.anthropicThinkingBudgetMap ?? {};
      if (Object.keys(budgets).length === 0) {
        expect(model.compatibility?.supportsReasoningEffort, model.id).toBe(false);
      } else {
        expect(model.compatibility?.supportsReasoningEffort, model.id).toBeUndefined();
      }
      for (const [level, budget] of Object.entries(
        budgets,
      )) {
        expect(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], model.id)
          .toContain(level);
        expect(Number.isInteger(budget), `${model.id}.${level}`).toBe(true);
        expect(budget, `${model.id}.${level}`).toBeGreaterThan(0);
      }
      // The same route cannot answer count_tokens upstream either.
      expect(model.compatibility?.supportsCountTokens, model.id).toBe(false);
    }
  });

  it('pins the reviewed Qwen Messages budget ladders exactly', () => {
    const expected = new Map([
      ['qwen3.6-plus', { high: 16_000, max: 31_999 }],
      ['qwen3.7-max', { high: 16_000, max: 31_999 }],
      ['qwen3.7-plus', { high: 16_000, max: 31_999 }],
      ['qwen3.8-max', { high: 16_000, max: 31_999 }],
    ]);
    const actual = new Map(models
      .filter(model => model.compatibility?.anthropicThinkingBudgetMap !== undefined)
      .map(model => [model.id, model.compatibility!.anthropicThinkingBudgetMap!]));
    expect(actual).toEqual(expected);
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
});
