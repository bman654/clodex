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
