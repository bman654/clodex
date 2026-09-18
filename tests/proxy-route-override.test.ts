import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return { ...actual, createLanguageModel: vi.fn().mockResolvedValue({}) };
});

vi.mock('../src/sdk-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'msg-route-override',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'adapter ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  };
});

function post(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('adapter route override', () => {
  afterEach(() => {
    vi.mocked(createLanguageModel).mockClear();
    vi.mocked(generateAnthropicResponse).mockClear();
  });

  it('A1 chooses the override route while echoing the model from the request body', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'default-route',
      realModelId: 'deepseek/deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      upstreamUrl: '',
      apiKey: 'deepseek-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://openrouter.example/v1',
      providerId: 'custom-openrouter',
    };
    const kimiRoute: ProxyRoute = {
      aliasId: 'kimi-k3',
      realModelId: 'moonshotai/kimi-k3',
      displayName: 'Kimi K3',
      upstreamUrl: '',
      apiKey: 'kimi-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://openrouter.example/v1',
      providerId: 'custom-openrouter',
    };
    const handle = await startProxyCatalog([defaultRoute, kimiRoute], defaultRoute.aliasId, false);

    try {
      const response = await post(handle.port, {
        model: 'claude-fable-5-1',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }, {
        authorization: `Bearer ${handle.token}`,
        'x-clodex-route-override': 'kimi-k3',
      });

      expect(response.status).toBe(200);
      expect(vi.mocked(createLanguageModel).mock.calls[0]![0]).toMatchObject({
        modelId: 'moonshotai/kimi-k3',
      });
      expect(JSON.parse(response.body)).toMatchObject({ model: 'claude-fable-5-1' });
    } finally {
      handle.close();
    }
  });
});
