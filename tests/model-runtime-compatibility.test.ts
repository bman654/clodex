import { describe, expect, it } from 'vitest';
import {
  applyAnthropicEffortResolution,
  transformAnthropicMessagesRequestBody,
  transformOpenAiCompatibleRequestBody,
} from '../src/model-runtime-compatibility.js';

describe('transformOpenAiCompatibleRequestBody', () => {
  it('applies OpenAI-compatible field and message compatibility rules without mutating input', () => {
    const input = {
      store: false,
      prompt_cache_retention: '24h',
      max_completion_tokens: 8192,
      reasoning_effort: 'max',
      messages: [
        { role: 'developer', content: 'system instructions' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
        { role: 'assistant', content: 'answer', reasoning_content: 'kept' },
      ],
    };

    const result = transformOpenAiCompatibleRequestBody(input, {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    });

    expect(result).toEqual({
      max_tokens: 8192,
      reasoning_effort: 'max',
      thinking: { type: 'enabled' },
      messages: [
        { role: 'system', content: 'system instructions' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1' }],
          reasoning_content: '',
        },
        { role: 'assistant', content: 'answer', reasoning_content: 'kept' },
      ],
    });
    expect(input).toEqual({
      store: false,
      prompt_cache_retention: '24h',
      max_completion_tokens: 8192,
      reasoning_effort: 'max',
      messages: [
        { role: 'developer', content: 'system instructions' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
        { role: 'assistant', content: 'answer', reasoning_content: 'kept' },
      ],
    });
  });

  it('enables Qwen thinking only when an effort is present', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'high', messages: [] },
      { thinkingFormat: 'qwen' },
    )).toEqual({
      reasoning_effort: 'high',
      enable_thinking: true,
      messages: [],
    });

    expect(transformOpenAiCompatibleRequestBody(
      { messages: [] },
      { thinkingFormat: 'qwen' },
    )).toEqual({ messages: [] });
  });

  it('can normalize output tokens in either direction', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { max_tokens: 2048 },
      { maxTokensField: 'max_completion_tokens' },
    )).toEqual({ max_completion_tokens: 2048 });
  });

  it('strips temperature only when authoritative compatibility says it is unsupported', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { temperature: 0.7, messages: [] },
      { supportsTemperature: false },
    )).toEqual({ messages: [] });
    expect(transformOpenAiCompatibleRequestBody(
      { temperature: 0.7, messages: [] },
      {},
    )).toEqual({ temperature: 0.7, messages: [] });
  });

  it('strips reasoning_effort when authoritative compatibility says it is unsupported', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'max', messages: [] },
      { supportsReasoningEffort: false },
    )).toEqual({ messages: [] });
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'max', messages: [] },
      {},
    )).toEqual({ reasoning_effort: 'max', messages: [] });
  });
});

describe('transformAnthropicMessagesRequestBody', () => {
  const compatibility = {
    anthropicThinkingBudgetMap: { high: 16_000, max: 31_999 },
  };

  it('maps exact Messages effort to a thinking budget without mutating input', () => {
    const input = {
      model: 'qwen3.6-plus',
      output_config: { effort: 'high', extra: true },
      messages: [{ role: 'user', content: 'hello' }],
    };
    const result = transformAnthropicMessagesRequestBody(input, compatibility);

    expect(result).toEqual({
      model: 'qwen3.6-plus',
      output_config: { extra: true },
      thinking: { type: 'enabled', budget_tokens: 16_000 },
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(input).toEqual({
      model: 'qwen3.6-plus',
      output_config: { effort: 'high', extra: true },
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('does not inject a budget when effort is omitted', () => {
    const input = { model: 'qwen3.6-plus', messages: [] };
    expect(transformAnthropicMessagesRequestBody(input, compatibility)).toBe(input);
  });

  it.each([
    ['up', 'xhigh', 31_999],
    ['down', 'xhigh', 16_000],
  ] as const)('rounds %s and reports the decision', (policy, effort, budget) => {
    const resolutions: unknown[] = [];
    expect(transformAnthropicMessagesRequestBody(
      { output_config: { effort }, messages: [] },
      compatibility,
      policy,
      resolution => resolutions.push(resolution),
    )).toEqual({
      thinking: { type: 'enabled', budget_tokens: budget },
      messages: [],
    });
    expect(resolutions).toMatchObject([{
      kind: 'rounded',
      requestedEffort: effort,
      resolvedEffort: policy === 'up' ? 'max' : 'high',
      policy,
    }]);
  });

  it('uses provider default without silently retaining the unsupported effort', () => {
    expect(transformAnthropicMessagesRequestBody(
      { output_config: { effort: 'medium', extra: true }, messages: [] },
      compatibility,
      'provider-default',
    )).toEqual({ output_config: { extra: true }, messages: [] });
  });

  it('rejects unsupported exact and invalid efforts with a safe 400 error', () => {
    expect(() => transformAnthropicMessagesRequestBody(
      { output_config: { effort: 'medium' } },
      compatibility,
      'exact',
    )).toThrow(/unsupported/);
    expect(() => transformAnthropicMessagesRequestBody(
      { output_config: { effort: 'turbo' } },
      compatibility,
      'up',
    )).toThrow(/Invalid effort level/);
    for (const effort of [' high ', '', '   ']) {
      expect(() => transformAnthropicMessagesRequestBody(
        { output_config: { effort } },
        compatibility,
        'up',
      )).toThrow(/Invalid effort level/);
    }
  });

  it('applies a generic rounded Messages effort and preserves unrelated output config', () => {
    const body = { output_config: { effort: 'xhigh', format: { type: 'json_schema' } }, messages: [] };
    expect(applyAnthropicEffortResolution(body, undefined, {
      kind: 'rounded',
      policy: 'down',
      requestedEffort: 'xhigh',
      resolvedEffort: 'high',
      saturated: false,
    })).toEqual({
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      messages: [],
    });
    expect(body.output_config.effort).toBe('xhigh');
  });

  it('preserves independently supplied thinking when provider-default omits effort', () => {
    expect(applyAnthropicEffortResolution({
      output_config: { effort: 'medium' },
      thinking: { type: 'enabled', budget_tokens: 8_000 },
      messages: [],
    }, compatibility, {
      kind: 'provider-default',
      policy: 'provider-default',
      requestedEffort: 'medium',
      resolvedEffort: undefined,
    })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8_000 },
      messages: [],
    });
  });
});
