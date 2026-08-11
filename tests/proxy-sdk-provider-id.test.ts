import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse, streamAnthropicResponse } from '../src/sdk-adapter.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';

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
    streamAnthropicResponse: vi.fn(async (
      _model: unknown,
      _params: unknown,
      _modelId: string,
      write: (chunk: string) => void,
    ) => { write('event: ping\ndata: {"type":"ping"}\n\n'); }),
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
});

describe('translated route response identity', () => {
  const route: ProxyRoute = {
    aliasId: 'clodex:kilo:tencent/hy3',
    realModelId: 'tencent/hy3',
    displayName: 'Tencent Hy3',
    upstreamUrl: '',
    apiKey: '',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
    baseURL: 'https://api.kilo.ai/api/gateway',
    providerId: 'kilo',
    authType: 'none',
  };

  afterEach(() => {
    vi.mocked(createLanguageModel).mockClear();
    vi.mocked(generateAnthropicResponse).mockClear();
    vi.mocked(streamAnthropicResponse).mockClear();
  });

  // The third positional argument is the id `sdk-adapter` stamps into the
  // response `message.model` (streaming) and `model` (non-streaming), so it is
  // exactly the identity the client is told answered.
  const respondedModelId = (mock: { mock: { calls: unknown[][] } }): unknown =>
    mock.mock.calls[0]?.[2];

  it('reports the routed model, not the request id, on a non-stream default-route fallback', async () => {
    // The requested id named no route we honoured, so the default route
    // answered. Echoing the request back would tell the client it reached a
    // model it never reached — and patched Claude Code keys its context window
    // off that id. The Anthropic passthrough already refuses to do this; the
    // translated path has to agree.
    const handle = await startProxyCatalog([route], route.aliasId, false);
    const res = await postToProxy(handle.port, handle.token, {
      model: 'some-unconfigured-model',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    handle.close();

    expect(res.status, res.body).toBe(200);
    expect(respondedModelId(vi.mocked(generateAnthropicResponse))).toBe('tencent/hy3');
  });

  it('reports the routed model on a streaming default-route fallback too', async () => {
    // Same invariant on the other constructor: `streamAnthropicResponse`
    // stamps `message_start`, so a stream that fell back must not announce the
    // phantom id either.
    const handle = await startProxyCatalog([route], route.aliasId, false);
    const res = await postToProxy(handle.port, handle.token, {
      model: 'some-unconfigured-model',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    handle.close();

    expect(res.status, res.body).toBe(200);
    expect(respondedModelId(vi.mocked(streamAnthropicResponse))).toBe('tencent/hy3');
  });

  it('still echoes an explicitly resolved alias in both directions', async () => {
    // The other half: a request that named a route we honoured keeps its
    // public identity, which is the behaviour the echo exists for.
    for (const stream of [false, true]) {
      vi.mocked(generateAnthropicResponse).mockClear();
      vi.mocked(streamAnthropicResponse).mockClear();
      const handle = await startProxyCatalog([route], route.aliasId, false);
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream,
      });
      handle.close();

      expect(res.status, res.body).toBe(200);
      const mock = stream
        ? vi.mocked(streamAnthropicResponse)
        : vi.mocked(generateAnthropicResponse);
      expect(respondedModelId(mock), `stream=${stream}`).toBe(route.aliasId);
    }
  });
});
