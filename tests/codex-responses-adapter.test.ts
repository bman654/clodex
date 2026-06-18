import { describe, expect, it, vi } from 'vitest';
import {
  translateResponsesInput,
  translateResponsesRequest,
  translateResponsesTools,
  responsesErrorBody,
} from '../src/codex-responses-adapter.js';

describe('translateResponsesRequest', () => {
  it('maps string input to user message', () => {
    const params = translateResponsesRequest({
      model: 'claude-sonnet-4-6',
      input: 'hello',
      instructions: 'be helpful',
    }, '@ai-sdk/anthropic');
    expect(params.system).toBe('be helpful');
    expect(params.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('merges developer role and instructions into system', () => {
    const params = translateResponsesRequest({
      model: 'm',
      input: [
        { role: 'developer', content: 'dev rules' },
        { role: 'user', content: 'hi' },
      ],
      instructions: 'extra',
    }, '@ai-sdk/anthropic');
    expect(params.system).toBe('dev rules\nextra');
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]!.role).toBe('user');
  });

  it('prepends user placeholder when first message is assistant', () => {
    const params = translateResponsesInput([
      { role: 'assistant', content: 'prior' },
    ], undefined, '@ai-sdk/anthropic');
    expect(params.messages[0]!.role).toBe('user');
    expect(params.messages[1]!.role).toBe('assistant');
  });

  it('maps function_call and function_call_output for tool round-trip', () => {
    const params = translateResponsesInput([
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
    ], undefined, '@ai-sdk/xai');
    expect(params.messages).toHaveLength(3);
    expect(params.messages[0]!.role).toBe('user');
    const assistant = params.messages[1] as { role: string; content: unknown[] };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'tool-call', toolCallId: 'call_1', toolName: 'Read' });
    const toolMsg = params.messages[2] as { role: string; content: unknown[] };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'call_1' });
  });

  it('decodes thought signature from call_id for Google', () => {
    const params = translateResponsesInput([
      { type: 'function_call_output', call_id: 'call_1__ts__U0lH', output: 'ok' },
    ], undefined, '@ai-sdk/google');
    // name unknown without prior call — still parses call_id
    expect(params.messages[0]).toMatchObject({ role: 'tool' });
  });

  it('maps reasoning item before function_call for DeepSeek round-trip', () => {
    const params = translateResponsesInput([
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'planning tool use' }],
      },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ], undefined, '@ai-sdk/openai-compatible');
    const assistant = params.messages[1] as { role: string; content: unknown[] };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'reasoning', text: 'planning tool use' });
    expect(assistant.content[1]).toMatchObject({ type: 'tool-call', toolCallId: 'call_1' });
  });

  it('forwards max_output_tokens', () => {
    const params = translateResponsesRequest({
      model: 'm',
      input: 'x',
      max_output_tokens: 8192,
    }, '@ai-sdk/anthropic');
    expect(params.maxOutputTokens).toBe(8192);
  });

  it('merges OpenAI effort with encrypted reasoning options', () => {
    const params = translateResponsesRequest({
      model: 'gpt-5.5',
      input: 'x',
      reasoning: { effort: 'high' },
    }, '@ai-sdk/openai');
    expect(params.providerOptions?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'high',
    });
  });

  it('merges Google effort with includeThoughts', () => {
    const params = translateResponsesRequest({
      model: 'gemini-2.5-pro',
      input: 'x',
      reasoning: { effort: 'high' },
    }, '@ai-sdk/google');
    expect(params.providerOptions?.google?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
  });

  it('maps OpenRouter effort through provider metadata', () => {
    const params = translateResponsesRequest({
      model: 'z-ai/glm-5.2',
      input: 'x',
      reasoning: { effort: 'high' },
    }, '@openrouter/ai-sdk-provider', {
      providerId: 'openrouter',
      supportedParameters: ['reasoning'],
    });
    expect(params.providerOptions?.openrouter).toEqual({
      reasoning: {
        effort: 'high',
        exclude: false,
      },
    });
  });

  it('leaves providerOptions unchanged when reasoning is absent', () => {
    const params = translateResponsesRequest({
      model: 'gpt-5.5',
      input: 'x',
    }, '@ai-sdk/openai');
    expect(params.providerOptions).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    });
  });

  it('builds tools from Responses format', () => {
    const tools = translateResponsesTools([
      { type: 'function', name: 'Bash', description: 'run', parameters: { type: 'object', properties: {} } },
    ]);
    expect(tools && Object.keys(tools)).toEqual(['Bash']);
  });
});

describe('responsesErrorBody', () => {
  it('returns failed status with error field', () => {
    const body = responsesErrorBody('m', 'Unauthorized', 401);
    expect(body.status).toBe('failed');
    expect(body.created_at).toEqual(expect.any(Number));
    expect(body.error).toMatchObject({ message: 'Unauthorized' });
  });
});

describe('writeResponsesStream', () => {
  it('emits full text SSE sequence', async () => {
    const { writeResponsesStream } = await import('../src/codex-responses-adapter.js');
    const chunks: string[] = [];
    const write = (c: string) => chunks.push(c);

    async function* stream() {
      yield { type: 'text-start' };
      yield { type: 'text-delta', text: 'Hello' };
      yield { type: 'text-delta', text: ' world' };
      yield { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 2 } };
    }

    await writeResponsesStream(stream(), 'test-model', write);
    const joined = chunks.join('');
    expect(joined).toContain('response.created');
    expect(joined).toContain('response.output_text.delta');
    expect(joined).toContain('response.output_text.done');
    expect(joined).toContain('response.content_part.done');
    expect(joined).toContain('response.output_item.done');
    expect(joined).toContain('response.completed');
    expect(joined).toContain('Hello world');
  });

  it('emits function call SSE sequence with arguments.done', async () => {
    const { writeResponsesStream } = await import('../src/codex-responses-adapter.js');
    const chunks: string[] = [];
    const write = (c: string) => chunks.push(c);

    async function* stream() {
      yield { type: 'tool-input-start', id: 'fc_1', toolName: 'Bash' };
      yield { type: 'tool-input-delta', delta: '{"cmd":' };
      yield { type: 'tool-input-delta', delta: '"ls"}' };
      yield { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 2 } };
    }

    await writeResponsesStream(stream(), 'test-model', write);
    const joined = chunks.join('');
    expect(joined).toContain('response.function_call_arguments.delta');
    expect(joined).toContain('response.function_call_arguments.done');
    expect(joined).toContain('function_call');
    expect(joined).toContain('\\"cmd\\":\\"ls\\"');
  });

  it('emits each parallel function call instead of overwriting the first one', async () => {
    const { writeResponsesStream } = await import('../src/codex-responses-adapter.js');
    const chunks: string[] = [];
    const write = (c: string) => chunks.push(c);

    async function* stream() {
      yield { type: 'tool-input-start', id: 'fc_1', toolName: 'Read' };
      yield { type: 'tool-input-delta', id: 'fc_1', delta: '{"path":"a"}' };
      yield { type: 'tool-input-start', id: 'fc_2', toolName: 'Grep' };
      yield { type: 'tool-input-delta', id: 'fc_2', delta: '{"pattern":"x"}' };
      yield { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 2 } };
    }

    await writeResponsesStream(stream(), 'test-model', write);
    const outputDone = parseSseEvents(chunks.join(''))
      .filter(event => event.event === 'response.output_item.done')
      .map(event => event.data.item);

    expect(outputDone).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', id: 'fc_1', name: 'Read', arguments: '{"path":"a"}' }),
      expect.objectContaining({ type: 'function_call', id: 'fc_2', name: 'Grep', arguments: '{"pattern":"x"}' }),
    ]));
  });

  it('emits reasoning output item for tool-loop round-trip', async () => {
    const { writeResponsesStream } = await import('../src/codex-responses-adapter.js');
    const chunks: string[] = [];
    const write = (c: string) => chunks.push(c);

    async function* stream() {
      yield { type: 'reasoning-start', id: 'r1' };
      yield { type: 'reasoning-delta', id: 'r1', text: 'think step' };
      yield { type: 'tool-input-start', id: 'fc_1', toolName: 'Bash' };
      yield { type: 'tool-input-delta', delta: '{}' };
      yield { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 2 } };
    }

    await writeResponsesStream(stream(), 'deepseek-v4-flash-free', write);
    const joined = chunks.join('');
    expect(joined).toContain('"type":"reasoning"');
    expect(joined).toContain('think step');
    expect(joined).toContain('function_call');
  });
});

describe('generateResponsesResponse', () => {
  it('encodes non-streaming tool-call provider signatures for Gemini round-trip', async () => {
    vi.resetModules();
    vi.doMock('ai', () => ({
      generateText: vi.fn(async () => ({
        text: '',
        reasoningText: '',
        toolCalls: [{
          toolCallId: 'call_1',
          toolName: 'Read',
          input: { path: 'a' },
          providerMetadata: { google: { thoughtSignature: 'SIG' } },
        }],
        usage: { inputTokens: 1, outputTokens: 2 },
      })),
      streamText: vi.fn(),
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { generateResponsesResponse } = await import('../src/codex-responses-adapter.js');
    const body = await generateResponsesResponse({} as never, { messages: [] }, 'gemini-2.5-pro');
    const toolCall = (body.output as any[]).find(item => item.type === 'function_call');
    expect(toolCall.call_id).toBe('call_1__ts__U0lH');

    vi.doUnmock('ai');
    vi.resetModules();
  });
});

function parseSseEvents(raw: string): Array<{ event: string; data: any }> {
  return raw.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event: '))?.slice('event: '.length) ?? '';
    const data = lines.find(line => line.startsWith('data: '))?.slice('data: '.length) ?? '{}';
    return { event, data: JSON.parse(data) };
  });
}
