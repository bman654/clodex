import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createServer } from 'node:http';
import { openCodeGoSessionHeaders, OPENCODE_GO_ANTHROPIC_BASE_URL } from '../src/data/opencode-go-models.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return { ...actual, createLanguageModel: vi.fn().mockResolvedValue({}) };
});

vi.mock('../src/sdk-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'msg-sdk',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'sdk ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  };
});

const SESSION_ID = '927b8642-15d2-4535-ab27-1430ae54c4aa';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Capture the header the upstream actually receives, on a local listener. */
async function startUpstream(): Promise<{ baseUrl: string; sessions: Array<string | undefined>; close: () => Promise<void> }> {
  const sessions: Array<string | undefined> = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    const raw = req.headers['x-opencode-session'];
    sessions.push(Array.isArray(raw) ? raw[0] : raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg-go', type: 'message', role: 'assistant', model: 'deepseek-v4.1-flash',
      content: [{ type: 'text', text: 'go ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing upstream address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sessions,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      res => {
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

const messagesBody = { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: false };

describe('openCodeGoSessionHeaders', () => {
  it('names Go by provider id, by trimmed-fork backend, or by base URL, and nothing else', () => {
    expect(openCodeGoSessionHeaders({ providerId: 'opencode-go' }, SESSION_ID))
      .toEqual({ 'x-opencode-session': SESSION_ID });
    expect(openCodeGoSessionHeaders({ sourceBackend: 'opencode-go' }, SESSION_ID))
      .toEqual({ 'x-opencode-session': SESSION_ID });
    expect(openCodeGoSessionHeaders({ providerId: 'custom', baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL }, SESSION_ID))
      .toEqual({ 'x-opencode-session': SESSION_ID });
    expect(openCodeGoSessionHeaders({ providerId: 'custom', apiUrl: `${OPENCODE_GO_ANTHROPIC_BASE_URL}/v1` }, SESSION_ID))
      .toEqual({ 'x-opencode-session': SESSION_ID });
    expect(openCodeGoSessionHeaders({ providerId: 'openai-oauth' }, SESSION_ID)).toBeUndefined();
    expect(openCodeGoSessionHeaders({ providerId: 'custom', baseUrl: 'https://opencode.ai/zen/v1' }, SESSION_ID))
      .toBeUndefined();
    expect(openCodeGoSessionHeaders({ providerId: 'custom', baseUrl: 'https://opencode.ai.example/zen/go' }, SESSION_ID))
      .toBeUndefined();
  });

  it('falls back to one stable per-process id when the client sent no session', () => {
    const first = openCodeGoSessionHeaders({ providerId: 'opencode-go' }, undefined)!['x-opencode-session'];
    const second = openCodeGoSessionHeaders({ providerId: 'opencode-go' }, undefined)!['x-opencode-session'];
    expect(first).toMatch(UUID_RE);
    expect(second).toBe(first);
  });
});

describe('proxy mode sends x-opencode-session to OpenCode Go', () => {
  afterEach(() => {
    vi.mocked(createLanguageModel).mockClear();
    vi.mocked(generateAnthropicResponse).mockClear();
  });

  it('on the Anthropic Messages passthrough, carrying the client session id', async () => {
    const upstream = await startUpstream();
    const route: ProxyRoute = {
      aliasId: 'clodex:opencode-go:deepseek-v4.1-flash',
      realModelId: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      upstreamUrl: upstream.baseUrl,
      apiKey: 'go-key',
      modelFormat: 'anthropic',
      providerId: 'opencode-go',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await post(handle.port, '/v1/messages', { model: route.aliasId, ...messagesBody }, {
        authorization: `Bearer ${handle.token}`,
        'x-claude-code-session-id': SESSION_ID,
      });
      expect(res.status, res.body).toBe(200);
      expect(upstream.sessions).toEqual([SESSION_ID]);
    } finally {
      handle.close();
      await upstream.close();
    }
  });

  it('on the Anthropic Messages passthrough without a client session, using the process fallback', async () => {
    const upstream = await startUpstream();
    const route: ProxyRoute = {
      aliasId: 'clodex:opencode-go:deepseek-v4.1-flash',
      realModelId: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      upstreamUrl: upstream.baseUrl,
      apiKey: 'go-key',
      modelFormat: 'anthropic',
      providerId: 'opencode-go',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await post(handle.port, '/v1/messages', { model: route.aliasId, ...messagesBody }, {
        authorization: `Bearer ${handle.token}`,
      });
      expect(res.status, res.body).toBe(200);
      expect(upstream.sessions).toHaveLength(1);
      expect(upstream.sessions[0]).toMatch(UUID_RE);
    } finally {
      handle.close();
      await upstream.close();
    }
  });

  it('on the SDK (Chat Completions) route, as a per-request header', async () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:opencode-go:deepseek-v4-pro',
      realModelId: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      upstreamUrl: '',
      apiKey: 'go-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://opencode.ai/zen/go/v1',
      providerId: 'opencode-go',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await post(handle.port, '/v1/messages', { model: route.aliasId, ...messagesBody }, {
        authorization: `Bearer ${handle.token}`,
        'x-claude-code-session-id': SESSION_ID,
      });
      expect(res.status, res.body).toBe(200);
      expect(generateAnthropicResponse).toHaveBeenCalledOnce();
      const params = vi.mocked(generateAnthropicResponse).mock.calls[0]![1] as { headers?: Record<string, string> };
      expect(params.headers).toEqual({ 'x-opencode-session': SESSION_ID });
    } finally {
      handle.close();
    }
  });

  it('not on a non-Go SDK route', async () => {
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
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await post(handle.port, '/v1/messages', { model: route.aliasId, ...messagesBody }, {
        authorization: `Bearer ${handle.token}`,
        'x-claude-code-session-id': SESSION_ID,
      });
      expect(res.status, res.body).toBe(200);
      const params = vi.mocked(generateAnthropicResponse).mock.calls[0]![1] as { headers?: Record<string, string> };
      expect(params.headers).toBeUndefined();
    } finally {
      handle.close();
    }
  });
});

describe('API server sends x-opencode-session to OpenCode Go', () => {
  const handles: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    vi.mocked(createLanguageModel).mockClear();
    vi.mocked(generateAnthropicResponse).mockClear();
    while (handles.length) await handles.pop()!.close();
  });

  it('on the Anthropic Messages passthrough', async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const server: ServerHandle = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'go-key',
      serverPassword: null,
      catalog: createGatewayModelCatalog([{
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        isFree: false,
        brand: 'Other',
        providerId: 'opencode-go',
        sourceBackend: 'opencode-go',
        modelFormat: 'anthropic',
        baseUrl: upstream.baseUrl,
      }]),
    });
    handles.push(server);
    const res = await post(new URL(server.url).port as unknown as number, '/anthropic/v1/messages', {
      model: 'deepseek-v4.1-flash', ...messagesBody,
    }, { 'x-claude-code-session-id': SESSION_ID });
    expect(res.status, res.body).toBe(200);
    expect(upstream.sessions).toEqual([SESSION_ID]);
  });

  it('on the SDK (Chat Completions) route', async () => {
    const server: ServerHandle = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'go-key',
      serverPassword: null,
      catalog: createGatewayModelCatalog([{
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        isFree: false,
        brand: 'Other',
        providerId: 'opencode-go',
        sourceBackend: 'opencode-go',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai-compatible',
        apiUrl: 'https://opencode.ai/zen/go/v1',
      }]),
    });
    handles.push(server);
    const res = await post(new URL(server.url).port as unknown as number, '/anthropic/v1/messages', {
      model: 'deepseek-v4-pro', ...messagesBody,
    }, { 'x-claude-code-session-id': SESSION_ID });
    expect(res.status, res.body).toBe(200);
    expect(generateAnthropicResponse).toHaveBeenCalledOnce();
    const params = vi.mocked(generateAnthropicResponse).mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(params.headers).toEqual({ 'x-opencode-session': SESSION_ID });
  });
});
