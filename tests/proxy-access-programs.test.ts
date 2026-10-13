import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createLanguageModel } from '../src/provider-factory.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';

vi.mock('../src/provider-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return { ...actual, createLanguageModel: vi.fn().mockResolvedValue({}) };
});

vi.mock('../src/sdk-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    generateAnthropicResponse: vi.fn().mockResolvedValue({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: 'x',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  };
});

function post(port: number, token: string, model: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const route: ProxyRoute = {
  aliasId: 'clodex:openai-oauth:gpt-5.6-sol',
  realModelId: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  upstreamUrl: '',
  apiKey: 'tok',
  modelFormat: 'openai',
  npm: '@ai-sdk/openai',
  providerId: 'openai-oauth',
  authType: 'oauth',
};

describe('alias-scoped access programs', () => {
  afterEach(() => vi.mocked(createLanguageModel).mockClear());

  it.each([
    ['sol', { cyber: 'daybreak_blue' }],
    ['plain', undefined],
    [route.aliasId, undefined],
  ])('model %s -> accessPrograms %j', async (model, expected) => {
    const handle = await startProxyCatalog([route], route.aliasId, false, undefined, undefined, undefined, [
      { name: 'sol', routeId: route.aliasId, accessPrograms: { cyber: 'daybreak_blue' } },
      { name: 'plain', routeId: route.aliasId },
    ]);
    try {
      expect(await post(handle.port, handle.token, model)).toBe(200);
    } finally {
      handle.close();
    }
    const spec = vi.mocked(createLanguageModel).mock.calls[0]![0];
    expect(spec.accessPrograms).toEqual(expected);
  });
});
