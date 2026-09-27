// Reasoning isolation, and the OpenRouter `x-session-id` header, on the wire.
//
// The original patch carried two independent things: a process-wide registry that
// re-injected a model turn's reasoning into whatever later request reused its
// tool-call id, and a session header for OpenRouter routes. Only the header
// survived review. These cases pin what replaced them.
//
// C01 and C05 reach the adapter through `writeAnthropicStream` and
// `translateMessages` only. That is deliberate: a registry checked through its own
// exports disappears together with the registry, so an import of it would let the
// unsafe shape pass unreported. Both cases read what a request actually carries.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { localModelToRoute } from '../src/catalog.js';
import {
  claudeSessionPromptCacheKey,
  streamAnthropicResponse,
  translateMessages,
  translateRequest,
  writeAnthropicStream,
  type AnthropicRequest,
} from '../src/sdk-adapter.js';
import { effortProviderOptions, getReasoningCapabilities } from '../src/provider-factory.js';
import { cachedModelToLocal } from '../src/registry/materialize.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';
import type { LocalProvider } from '../src/types.js';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const SESSION = '927b8642-15d2-4535-ab27-1430ae54c4aa';
const OTHER_SESSION = '11111111-1111-4111-8111-111111111111';
const OPENROUTER_METADATA = { providerId: 'custom-openrouter', apiBaseUrl: 'https://openrouter.ai/api/v1' };

function oneTurn(content: string): AnthropicRequest {
  return { model: MODEL, system: 'system prompt', messages: [{ role: 'user', content }] };
}

const TOOL = {
  name: 'Read',
  description: 'read a file',
  input_schema: { type: 'object', properties: { file: { type: 'string' } } },
};

interface WireRequest { headers: Record<string, string | string[] | undefined> }

/**
 * One request through the production streaming path against a loopback upstream.
 * `fetch` is not stubbed: the header has to survive the SDK's own header merge
 * before it is on the wire, which is the only place a dropped or renamed header
 * would show. The listener is closed in `finally`, and nothing leaves the host.
 */
async function captureWire(
  body: AnthropicRequest,
  options: Parameters<typeof translateRequest>[2],
  modelId = MODEL,
): Promise<WireRequest> {
  const received: WireRequest[] = [];
  const upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({ headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      res.end([
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const { port } = upstream.address() as AddressInfo;
    const provider = createOpenAICompatible({
      name: 'openrouter',
      apiKey: 'synthetic-test-key',
      baseURL: `http://127.0.0.1:${port}/api/v1`,
    });
    const params = translateRequest(body, '@ai-sdk/openai-compatible', options);
    await streamAnthropicResponse(provider(modelId), params, modelId, () => {});
    if (received.length !== 1) throw new Error(`expected one wire request, got ${received.length}`);
    return received[0]!;
  } finally {
    await new Promise<void>(resolve => { upstream.close(() => resolve()); });
  }
}

describe('reasoning stays inside the conversation that produced it', () => {
  // C01. The id shape is the one a vLLM/SGLang-style parser emits: no unique
  // prefix, so two conversations in one process really can collide on it.
  it('does not carry one conversation\'s reasoning into another that reuses its tool-call id', async () => {
    const toolId = 'functions.Read:0';

    async function* firstConversation(): AsyncGenerator<unknown> {
      yield { type: 'reasoning-delta', text: 'First conversation, private reasoning.' };
      yield { type: 'tool-input-start', id: toolId, toolName: 'Read' };
      yield { type: 'tool-input-end', id: toolId };
      yield { type: 'tool-call', toolCallId: toolId, toolName: 'Read', input: { file: 'a.ts' } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }
    await writeAnthropicStream(firstConversation() as never, MODEL, () => {});

    const second = translateMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file: 'b.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolId, content: 'b.ts contents' }],
      },
    ], '@ai-sdk/openai-compatible') as Array<{ role: string; content: Array<{ type: string }> }>;

    const assistant = second[0]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content.filter(part => part.type === 'reasoning')).toEqual([]);
    expect(JSON.stringify(second)).not.toContain('First conversation, private reasoning.');
  });

  // C05, the control. History that already carries its thinking keeps exactly the
  // reasoning it arrived with, and translating it twice yields the same request:
  // nothing hidden accumulates between rounds.
  it('keeps ordinary thinking-plus-tool history intact and stable across rounds', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Plan the edit, then run the tool.', signature: 'claude-signature' },
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'a.ts contents' }],
      },
    ];

    const first = translateMessages(history, '@ai-sdk/openai-compatible') as Array<{ content: Array<{ type: string }> }>;
    const second = translateMessages(history, '@ai-sdk/openai-compatible');

    expect(second).toEqual(first);
    const assistant = first[0]!;
    expect(assistant.content.filter(part => part.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'Plan the edit, then run the tool.' },
    ]);
    expect(assistant.content.at(-1)!.type).toBe('tool-call');
  });
});

describe('OpenRouter x-session-id on the wire', () => {
  // C02. The raw Claude UUID must not leave the machine: a stable, user-correlatable
  // identifier is not something this header needs to be, and the repo already hashes
  // the same id for the OpenAI route's prompt_cache_key.
  it('sends the hashed session key, stable per session and distinct across sessions', async () => {
    const options = { claudeSessionId: SESSION, reasoningMetadata: OPENROUTER_METADATA };
    const first = await captureWire(oneTurn('hello'), options);
    const sameSession = await captureWire(oneTurn('hello again'), options);
    const otherSession = await captureWire(oneTurn('hello'), { ...options, claudeSessionId: OTHER_SESSION });

    const key = claudeSessionPromptCacheKey(SESSION);
    expect(first.headers['x-session-id']).toBe(key);
    expect(first.headers['x-session-id']).not.toBe(SESSION);
    expect(JSON.stringify(first.headers)).not.toContain(SESSION);
    expect(sameSession.headers['x-session-id']).toBe(key);
    expect(otherSession.headers['x-session-id']).toBe(claudeSessionPromptCacheKey(OTHER_SESSION));
    expect(otherSession.headers['x-session-id']).not.toBe(key);
  });

  // C03. The fallback is derived from the cacheable prefix, so it must survive a
  // second call unchanged and must move when that prefix moves. A key regenerated
  // per call would satisfy a format check alone.
  it('falls back to one stable key per cacheable prefix and moves when the prefix moves', async () => {
    const options = { reasoningMetadata: { providerId: 'openrouter' } };
    const body: AnthropicRequest = { ...oneTurn('hello'), tools: [TOOL] };

    const first = await captureWire(body, options);
    const again = await captureWire(body, options);
    const otherSystem = await captureWire({ ...body, system: 'a different system prompt' }, options);
    const otherTools = await captureWire({ ...body, tools: [] }, options);

    expect(again.headers['x-session-id']).toBe(first.headers['x-session-id']);
    expect(otherSystem.headers['x-session-id']).not.toBe(first.headers['x-session-id']);
    expect(otherTools.headers['x-session-id']).not.toBe(first.headers['x-session-id']);
  });
});

describe('OpenRouter recognition stays endpoint-derived', () => {
  // C04. A provider id comes from the display name the user typed, so a name alone
  // must not reach reasoning capabilities, effort mapping or provider headers: a
  // non-OpenRouter gateway called "OpenRouter" has to be indistinguishable from the
  // same gateway called anything else.
  it('treats a compatible provider merely named OpenRouter like any other', () => {
    const named = { providerId: 'custom-openrouter', apiBaseUrl: 'https://llm.internal.example/v1' };
    const plain = { providerId: 'custom-internal', apiBaseUrl: 'https://llm.internal.example/v1' };

    expect(getReasoningCapabilities('@ai-sdk/openai-compatible', 'tencent/hy3', named))
      .toEqual(getReasoningCapabilities('@ai-sdk/openai-compatible', 'tencent/hy3', plain));
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'high', 'tencent/hy3', named))
      .toEqual(effortProviderOptions('@ai-sdk/openai-compatible', 'high', 'tencent/hy3', plain));

    const params = translateRequest(
      { model: 'tencent/hy3', messages: [{ role: 'user', content: 'hello' }] },
      '@ai-sdk/openai-compatible',
      { claudeSessionId: SESSION, reasoningMetadata: named },
    );
    expect(params.headers).toBeUndefined();
  });

  it('treats a gateway model id prefixed openrouter/ like any other', () => {
    const params = translateRequest(
      { model: 'openrouter/tencent/hy3', messages: [{ role: 'user', content: 'hello' }] },
      '@ai-sdk/openai-compatible',
      { claudeSessionId: SESSION, reasoningMetadata: { providerId: 'custom-internal' } },
    );

    expect(params.headers).toBeUndefined();
    expect(getReasoningCapabilities('@ai-sdk/openai-compatible', 'openrouter/tencent/hy3', { providerId: 'custom-internal' }))
      .toEqual(getReasoningCapabilities('@ai-sdk/openai-compatible', 'tencent/hy3', { providerId: 'custom-internal' }));
  });

  // The other half of C04: recognition narrowed back to the endpoint must not cost
  // the header on a custom endpoint that really is OpenRouter. Driven through the
  // registry and catalog, because a hand-written metadata object would prove
  // nothing about where `apiBaseUrl` comes from.
  it('keeps the header for a custom endpoint whose url is the real OpenRouter host', () => {
    const provider: RegistryProvider = {
      id: 'custom-openrouter',
      templateId: 'custom-openrouter',
      name: 'OpenRouter',
      enabled: true,
      authRef: 'keyring:provider:custom-openrouter',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://openrouter.ai/api/v1' },
      addedAt: '2026-09-27T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-09-27T00:00:00.000Z',
        models: [{
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek: V4.1 Flash',
          upstreamModelId: 'deepseek/deepseek-v4.1-flash',
          modelFormat: 'openai',
        } satisfies CachedModel],
      },
    };
    const model = cachedModelToLocal(provider.modelsCache.models[0]!, provider)!;
    const local: LocalProvider = {
      id: provider.id,
      name: provider.name,
      apiKey: 'synthetic-test-key',
      authType: provider.authType,
      models: [model],
    };
    const route = localModelToRoute(local, model)!;

    expect(route.providerId).toBe('custom-openrouter');
    expect(route.baseURL).toBe('https://openrouter.ai/api/v1');

    const params = translateRequest(oneTurn('hello'), route.npm!, {
      claudeSessionId: SESSION,
      reasoningMetadata: {
        providerId: route.providerId,
        apiBaseUrl: route.baseURL,
        upstreamModelId: route.realModelId,
      },
    });
    expect(params.headers?.['x-session-id']).toBe(claudeSessionPromptCacheKey(SESSION));
  });
});
