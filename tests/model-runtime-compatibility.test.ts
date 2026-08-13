import { describe, expect, it } from 'vitest';
import { transformOpenAiCompatibleRequestBody } from '../src/model-runtime-compatibility.js';

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

  it('omits unsupported reasoning effort and thinking without mutating input', () => {
    const input = { reasoning_effort: 'high' };
    const result = transformOpenAiCompatibleRequestBody(input, {
      supportsReasoningEffort: false,
      thinkingFormat: 'deepseek',
    });

    expect(result).toEqual({});
    expect(input).toEqual({ reasoning_effort: 'high' });
  });

  it('deletes a mapped provider-disabled reasoning level', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'high' },
      { reasoningEffortMap: { high: null }, thinkingFormat: 'deepseek' },
    )).toEqual({});
  });

  it('replaces a mapped reasoning level with the provider value', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'high' },
      { reasoningEffortMap: { high: 'max' }, thinkingFormat: 'qwen' },
    )).toEqual({ reasoning_effort: 'max', enable_thinking: true });
  });

  it('preserves an unmapped provider-native reasoning level', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'native' },
      { reasoningEffortMap: { high: 'max' }, thinkingFormat: 'qwen' },
    )).toEqual({ reasoning_effort: 'native', enable_thinking: true });
  });

  it('preserves non-string reasoning effort values', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 3 },
      { reasoningEffortMap: { '3': 'max' }, thinkingFormat: 'qwen' },
    )).toEqual({ reasoning_effort: 3 });
  });

  it('lets unsupported reasoning effort take precedence over a conflicting map', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'high' },
      {
        supportsReasoningEffort: false,
        reasoningEffortMap: { high: 'max' },
        thinkingFormat: 'qwen',
      },
    )).toEqual({});
  });

  it('omits unsupported temperature while preserving other fields without mutating input', () => {
    const input = {
      model: 'kimi-k3',
      temperature: 0.2,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
    };
    const result = transformOpenAiCompatibleRequestBody(input, { supportsTemperature: false });

    expect(result).toEqual({
      model: 'kimi-k3',
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(input).toEqual({
      model: 'kimi-k3',
      temperature: 0.2,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
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
});
