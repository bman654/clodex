import { describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { collectOpenAiStream, generateOpenAiResponse, streamOpenAiResponse, translateOpenAiRequest } from '../src/openai-adapter.js';
import { resetServiceTierWarningForTests } from '../src/sdk-adapter.js';
import { installParentNoticeSink } from '../src/parent-notice.js';

/** Observes the parent-notice channel, which is where request-time warnings go
 *  now: `clodex claude` mutes the parent's stdio for Claude Code's TUI, so a
 *  console.error here would never reach a user. */
function captureNotices(): { lines: string[]; release: () => void } {
  const lines: string[] = [];
  return { lines, release: installParentNoticeSink(line => lines.push(line)) };
}

vi.mock('ai', () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  tool: vi.fn((spec: unknown) => spec),
  jsonSchema: vi.fn((schema: unknown) => schema),
}));

describe('configured upstream retries', () => {
  it('passes the retry budget to streaming responses', async () => {
    const previous = process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
    process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = '4';
    async function* stream() {
      yield { type: 'finish', finishReason: 'stop' };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);

    try {
      await streamOpenAiResponse({} as never, { messages: [] }, 'test-model', () => {});

      expect(vi.mocked(streamText).mock.calls[0]![0].maxRetries).toBe(4);
    } finally {
      if (previous === undefined) delete process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
      else process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = previous;
      vi.mocked(streamText).mockReset();
    }
  });

  it('passes the retry budget to collected stream responses', async () => {
    const previous = process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
    process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = '4';
    async function* stream() {
      yield { type: 'finish', finishReason: 'stop' };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);

    try {
      await generateOpenAiResponse(
        {} as never,
        { messages: [] },
        'test-model',
        { forceStream: true },
      );

      expect(vi.mocked(streamText).mock.calls[0]![0].maxRetries).toBe(4);
    } finally {
      if (previous === undefined) delete process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
      else process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = previous;
      vi.mocked(streamText).mockReset();
    }
  });

  it('passes the retry budget to non-streaming responses', async () => {
    const previous = process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
    process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = '4';
    vi.mocked(generateText).mockResolvedValue({
      text: 'done',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);

    try {
      await generateOpenAiResponse({} as never, { messages: [] }, 'test-model');

      expect(vi.mocked(generateText).mock.calls[0]![0].maxRetries).toBe(4);
    } finally {
      if (previous === undefined) delete process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
      else process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = previous;
      vi.mocked(generateText).mockReset();
    }
  });
});

describe('streamOpenAiResponse', () => {
  it('propagates an SDK error instead of completing a failed stream', async () => {
    const upstreamError = { statusCode: 429, message: 'rate limited' };
    async function* stream() {
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'error', error: upstreamError };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    let output = '';

    await expect(streamOpenAiResponse(
      {} as never,
      { messages: [] },
      'gpt-test',
      chunk => { output += chunk; },
    )).rejects.toBe(upstreamError);

    expect(output).toContain('partial');
    expect(output).not.toContain('[DONE]');
  });
});

describe('translateOpenAiRequest OAuth shaping', () => {
  it('moves the system prompt into providerOptions and drops the output limit for OAuth routes', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    try {
      delete process.env.CLODEX_SERVICE_TIER;
      const params = translateOpenAiRequest({
        model: 'gpt-test',
        max_tokens: 100,
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'hi' },
        ],
      }, { openAiOAuth: true });

      expect(params.instructions).toBeUndefined();
      expect(params.maxOutputTokens).toBeUndefined();
      expect(params.providerOptions).toEqual({
        openai: {
          store: false,
          include: ['reasoning.encrypted_content'],
          instructions: 'Be terse.',
        },
      });
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
    }
  });

  it('applies CLODEX_SERVICE_TIER on the OAuth route of the OpenAI-format endpoint too', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    try {
      process.env.CLODEX_SERVICE_TIER = 'fast';
      const oauth = translateOpenAiRequest({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }, { openAiOAuth: true });
      expect((oauth.providerOptions?.openai as Record<string, unknown>)?.serviceTier).toBe('priority');
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
    }
  });

  it('defaults OAuth instructions when the request has no system prompt', async () => {
    const params = translateOpenAiRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    }, { openAiOAuth: true });

    expect((params.providerOptions as any)?.openai?.instructions).toBe('You are a coding assistant.');
  });

  it('keeps standard instructions and output limit for non-OAuth routes', async () => {
    const params = translateOpenAiRequest({
      model: 'gpt-test',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(params.instructions).toBe('Be terse.');
    expect(params.maxOutputTokens).toBe(100);
    expect(params.providerOptions).toBeUndefined();
  });
});

describe('collectOpenAiStream', () => {
  it('aggregates text deltas, tool calls, finish reason, and usage', async () => {
    async function* stream() {
      yield { type: 'text-delta', text: 'Hello ' };
      yield { type: 'text-delta', text: 'world' };
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Austin' } };
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
    }

    const collected = await collectOpenAiStream(stream());

    expect(collected.text).toBe('Hello world');
    expect(collected.toolCalls).toEqual([{ toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Austin' } }]);
    expect(collected.finishReason).toBe('tool-calls');
    expect(collected.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  });

  it('propagates an SDK error part instead of returning a partial result', async () => {
    const upstreamError = { statusCode: 500, message: 'upstream exploded' };
    async function* stream() {
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'error', error: upstreamError };
    }

    await expect(collectOpenAiStream(stream())).rejects.toBe(upstreamError);
  });
});

describe('generateOpenAiResponse with forceStream', () => {
  it('streams upstream and synthesizes a complete non-streaming chat completion', async () => {
    async function* stream() {
      yield { type: 'text-delta', text: 'pong' };
      yield { type: 'tool-call', toolCallId: 'call_9', toolName: 'lookup', input: { q: 'x' } };
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    vi.mocked(generateText).mockClear();

    const response: any = await generateOpenAiResponse(
      {} as never,
      { messages: [] },
      'gpt-test',
      { forceStream: true },
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(response.object).toBe('chat.completion');
    expect(response.model).toBe('gpt-test');
    expect(response.choices).toEqual([{
      index: 0,
      message: {
        role: 'assistant',
        content: 'pong',
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
      finish_reason: 'stop',
    }]);
    expect(response.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it('uses a non-streaming upstream request when forceStream is not set', async () => {
    vi.mocked(streamText).mockClear();
    vi.mocked(generateText).mockResolvedValue({
      text: 'plain',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);

    const response: any = await generateOpenAiResponse({} as never, { messages: [] }, 'gpt-test');

    expect(streamText).not.toHaveBeenCalled();
    expect(response.choices[0].message.content).toBe('plain');
    expect(response.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });
});

describe('OpenAI-format service tier omission warning', () => {
  it('surfaces the structured tier omission warning on non-streaming responses, once per process', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    const notices = captureNotices();
    try {
      process.env.CLODEX_SERVICE_TIER = 'fast';
      resetServiceTierWarningForTests();
      vi.mocked(generateText).mockResolvedValue({
        text: 'plain',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [{ type: 'unsupported', feature: 'serviceTier' }],
      } as never);
      const params = translateOpenAiRequest({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }, { openAiOAuth: true });

      await generateOpenAiResponse({} as never, params, 'gpt-test');
      await generateOpenAiResponse({} as never, params, 'gpt-test');

      expect(notices.lines).toHaveLength(1);
      expect(notices.lines[0]).toContain('requested service tier was not sent');
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
      resetServiceTierWarningForTests();
      notices.release();
      vi.mocked(generateText).mockReset();
    }
  });

  it('surfaces the structured tier omission warning on force-stream responses, once per process', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    const notices = captureNotices();
    try {
      process.env.CLODEX_SERVICE_TIER = 'fast';
      resetServiceTierWarningForTests();
      async function* stream() {
        yield { type: 'finish', finishReason: 'stop' };
      }
      vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
      const params = translateOpenAiRequest({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }, { openAiOAuth: true });

      await generateOpenAiResponse({} as never, params, 'gpt-test', { forceStream: true });

      const onStepFinish = vi.mocked(streamText).mock.calls[0]![0].onStepFinish;
      expect(onStepFinish).toBeTypeOf('function');
      const step = { warnings: [{ type: 'unsupported', feature: 'serviceTier' }] } as never;
      onStepFinish?.(step);
      onStepFinish?.(step);

      expect(notices.lines).toHaveLength(1);
      expect(notices.lines[0]).toContain('requested service tier was not sent');
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
      resetServiceTierWarningForTests();
      notices.release();
      vi.mocked(streamText).mockReset();
    }
  });

  it('surfaces the structured tier omission warning on streaming responses, once per process', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    const notices = captureNotices();
    try {
      process.env.CLODEX_SERVICE_TIER = 'fast';
      resetServiceTierWarningForTests();
      async function* stream() {
        yield { type: 'finish', finishReason: 'stop' };
      }
      vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
      const params = translateOpenAiRequest({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }, { openAiOAuth: true });

      await streamOpenAiResponse({} as never, params, 'gpt-test', () => {});

      const onStepFinish = vi.mocked(streamText).mock.calls[0]![0].onStepFinish;
      expect(onStepFinish).toBeTypeOf('function');
      const step = { warnings: [{ type: 'unsupported', feature: 'serviceTier' }] } as never;
      onStepFinish?.(step);
      onStepFinish?.(step);

      expect(notices.lines).toHaveLength(1);
      expect(notices.lines[0]).toContain('requested service tier was not sent');
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
      resetServiceTierWarningForTests();
      notices.release();
      vi.mocked(streamText).mockReset();
    }
  });
});
