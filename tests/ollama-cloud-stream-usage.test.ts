import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse, streamAnthropicResponse } from '../src/sdk-adapter.js';
import { buildOllamaCloudModels } from '../src/data/ollama-cloud-models.js';
import type { ModelRuntimeCompatibility } from '../src/model-runtime-compatibility.js';

/**
 * ollama.com emits a streamed usage chunk (`choices: []` plus `usage`) only when the
 * request carries `stream_options.include_usage` (observed 2026-10-13 on all four
 * catalog models). The listener below reproduces that contract, so these tests assert
 * both what leaves the process and what Claude Code is told about token usage. No
 * mocks: a real `@ai-sdk/openai-compatible` model pointed at a local listener.
 */
interface Listener {
  baseUrl: string;
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

async function startListener(): Promise<Listener> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    bodies.push(body);
    if (body.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-usage',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: USAGE,
      }));
      return;
    }
    const base = { id: 'chatcmpl-usage', object: 'chat.completion.chunk', created: 0, model: body.model };
    const chunks: unknown[] = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    const options = body.stream_options as { include_usage?: unknown } | undefined;
    if (options?.include_usage === true) chunks.push({ ...base, choices: [], usage: USAGE });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

async function streamOnce(
  providerId: string,
  compatOverride?: ModelRuntimeCompatibility,
): Promise<{
  body: Record<string, unknown>;
  outputTokens: unknown;
}> {
  const listener = await startListener();
  try {
    const catalog = buildOllamaCloudModels()[0]!;
    const model = await createLanguageModel({
      npm: '@ai-sdk/openai-compatible',
      modelId: catalog.id,
      apiKey: 'test-key',
      baseURL: listener.baseUrl,
      providerId,
      authType: 'api',
      compatibility: compatOverride ?? catalog.compatibility,
    });
    let sse = '';
    await streamAnthropicResponse(
      model,
      { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16 },
      catalog.id,
      chunk => { sse += chunk; },
    );
    const delta = sse.split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice('data: '.length)) as { type?: string; usage?: { output_tokens?: unknown } })
      .find(event => event.type === 'message_delta');
    expect(listener.bodies).toHaveLength(1);
    return { body: listener.bodies[0]!, outputTokens: delta?.usage?.output_tokens };
  } finally {
    await listener.close();
  }
}

describe('Ollama Cloud streamed usage', () => {
  it('asks for the usage chunk and reports its real output token count', async () => {
    const { body, outputTokens } = await streamOnce('ollama-cloud');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(outputTokens).toBe(USAGE.completion_tokens);
  });

  it('asks for the usage chunk for any provider whose spec declares stream usage', async () => {
    // The same ollama-cloud compatibility under a different provider id still
    // sends stream_options: the flag on the catalog drives it, not the id.
    const { body, outputTokens } = await streamOnce('openai');
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(outputTokens).toBe(USAGE.completion_tokens);
  });

  it.each(['opencode-go', 'custom-local', 'openai'])(
    'leaves the %s request without stream_options when its catalog does not opt in',
    async providerId => {
      // A catalog without supportsStreamUsage, like the real opencode-go one.
      const { body } = await streamOnce(providerId, {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens' as const,
        supportsReasoningEffort: false,
      });
      expect(body.stream).toBe(true);
      expect(body).not.toHaveProperty('stream_options');
    },
  );

  it('does not add stream_options to a non-streamed Ollama Cloud request', async () => {
    const listener = await startListener();
    try {
      const catalog = buildOllamaCloudModels()[0]!;
      const model = await createLanguageModel({
        npm: '@ai-sdk/openai-compatible',
        modelId: catalog.id,
        apiKey: 'test-key',
        baseURL: listener.baseUrl,
        providerId: 'ollama-cloud',
        authType: 'api',
        compatibility: catalog.compatibility,
      });
      await generateAnthropicResponse(
        model,
        { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16 },
        catalog.id,
      );
      expect(listener.bodies).toHaveLength(1);
      expect(listener.bodies[0]).not.toHaveProperty('stream_options');
    } finally {
      await listener.close();
    }
  });
});
