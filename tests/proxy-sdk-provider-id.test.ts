import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';

const ORIGINAL_COMPACTION_FLAG = process.env.CLODEX_OPENAI_COMPACTION;
const ORIGINAL_COMPACTION_THRESHOLD = process.env.CLODEX_OPENAI_COMPACT_THRESHOLD;

vi.mock('../src/provider-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('../src/sdk-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    generateAnthropicResponse: vi.fn().mockResolvedValue({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  };
});

function postToProxy(port: number, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
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
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('SDK proxy provider identity', () => {
  afterEach(() => {
    vi.mocked(createLanguageModel).mockClear();
    vi.mocked(generateAnthropicResponse).mockClear();
    if (ORIGINAL_COMPACTION_FLAG === undefined) delete process.env.CLODEX_OPENAI_COMPACTION;
    else process.env.CLODEX_OPENAI_COMPACTION = ORIGINAL_COMPACTION_FLAG;
    if (ORIGINAL_COMPACTION_THRESHOLD === undefined) delete process.env.CLODEX_OPENAI_COMPACT_THRESHOLD;
    else process.env.CLODEX_OPENAI_COMPACT_THRESHOLD = ORIGINAL_COMPACTION_THRESHOLD;
  });

  it('passes stable provider id into the SDK provider factory', async () => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-kilo__tencent/hy3:free',
      realModelId: 'tencent/hy3:free',
      displayName: 'Tencent Hy3',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://api.kilo.ai/api/gateway',
      providerId: 'kilo',
      authType: 'none',
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    const res = await postToProxy(handle.port, handle.token, {
      model: route.aliasId,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    handle.close();

    expect(res.status, res.body).toBe(200);
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'kilo',
    }));
  });

  it('injects the opt-in native-compaction threshold in proxy mode', async () => {
    process.env.CLODEX_OPENAI_COMPACTION = '1';
    delete process.env.CLODEX_OPENAI_COMPACT_THRESHOLD;
    const route: ProxyRoute = {
      aliasId: 'anthropic-openai-oauth__gpt-5.6-sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      upstreamUrl: '',
      apiKey: 'oauth-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'openai-oauth',
      authType: 'oauth',
      oauthAccountId: 'acct-proxy-compaction',
      contextWindow: 272_000,
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    const res = await postToProxy(handle.port, handle.token, {
      model: route.aliasId,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    handle.close();

    expect(res.status, res.body).toBe(200);
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({
      openAiCompactThreshold: 244_800,
    }));
  });
});
