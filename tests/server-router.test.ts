import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse, streamAnthropicResponse } from '../src/sdk-adapter.js';
import { generateOpenAiResponse, streamOpenAiResponse } from '../src/openai-adapter.js';
import { resolveProviderCredential } from '../src/env.js';

const TEST_HELPER_REF = `helper:v1:${'a'.repeat(64)}:oauth:provider:oauth-provider`;

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    resolveProviderCredential: vi.fn(),
  };
});

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: unknown) => ({ spec })),
  };
});

vi.mock('../src/sdk-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    streamAnthropicResponse: vi.fn(async () => {}),
    generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'sdk ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  };
});

vi.mock('../src/openai-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/openai-adapter.js')>();
  return {
    ...actual,
    streamOpenAiResponse: vi.fn(async () => {}),
    generateOpenAiResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: modelId,
      choices: [{ message: { content: 'openai sdk ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })),
  };
});

interface UpstreamRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  xApiKey: string | undefined;
  xPlan?: string;
  body: any;
}

async function readRequestBody(req: Parameters<typeof createServer>[0] extends (req: infer R, res: any) => any ? R : never): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : null;
}

async function startUpstream(responseBody: any): Promise<{ baseUrl: string; requests: UpstreamRequest[]; close: () => Promise<void> }> {
  const requests: UpstreamRequest[] = [];
  const server = createServer(async (req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization,
      xApiKey: Array.isArray(req.headers['x-api-key'])
        ? req.headers['x-api-key'][0]
        : req.headers['x-api-key'],
      xPlan: Array.isArray(req.headers['x-plan'])
        ? req.headers['x-plan'][0]
        : req.headers['x-plan'],
      body: await readRequestBody(req),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing upstream address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

async function startSequencedUpstream(
  responses: Array<{ status: number; body: unknown }>,
): Promise<{ baseUrl: string; requests: UpstreamRequest[]; close: () => Promise<void> }> {
  const requests: UpstreamRequest[] = [];
  const server = createServer(async (req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization,
      body: await readRequestBody(req),
    });
    const response = responses[Math.min(requests.length - 1, responses.length - 1)]!;
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing upstream address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))),
  };
}

const handles: Array<ServerHandle | { close: () => Promise<void> }> = [];

function model(
  id: string,
  modelFormat: ServerModelInfo['modelFormat'],
  sourceBackend: ServerModelInfo['sourceBackend'],
  urls: { baseUrl?: string; completionsUrl?: string } = {},
): ServerModelInfo {
  return {
    id,
    name: id,
    isFree: false,
    brand: 'Other',
    sourceBackend,
    modelFormat,
    ...urls,
  };
}

function defaultCatalog(upstreamBaseUrl: string) {
  return createGatewayModelCatalog([
    model('claude-native', 'anthropic', 'zen', { baseUrl: upstreamBaseUrl }),
    model('openai-format', 'openai', 'go', { completionsUrl: `${upstreamBaseUrl}/v1/chat/completions` }),
    model('bad-format', 'unsupported', 'zen'),
  ]);
}

async function startTestServer(options: Partial<Parameters<typeof startServer>[0]> = {}): Promise<ServerHandle> {
  const upstream = await startUpstream({
    id: 'chatcmpl-test',
    choices: [{ message: { content: 'upstream ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  });
  handles.push(upstream);

  const handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    apiKey: 'real-opencode-key',
    serverPassword: null,
    catalog: defaultCatalog(upstream.baseUrl),
    ...options,
  });
  handles.push(handle);
  return handle;
}

async function closeHandle(handle: ServerHandle | { close: () => Promise<void> }): Promise<void> {
  await handle.close();
}

afterEach(async () => {
  vi.mocked(createLanguageModel).mockClear();
  vi.mocked(resolveProviderCredential).mockReset();
  vi.mocked(generateAnthropicResponse).mockClear();
  vi.mocked(streamAnthropicResponse).mockClear();
  vi.mocked(generateOpenAiResponse).mockClear();
  vi.mocked(streamOpenAiResponse).mockClear();
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) await closeHandle(handle);
  }
});

describe('server router', () => {
  it('logs inference routing metadata without request content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-server-audit-'));
    const inferenceLogPath = join(dir, 'requests.jsonl');
    const auditUpstream = await startUpstream({
      id: 'msg-audit',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    });
    handles.push(auditUpstream);
    const auditCatalog = createGatewayModelCatalog([
      model('claude-native', 'anthropic', 'zen', { baseUrl: auditUpstream.baseUrl }),
      {
        id: 'llama-test',
        name: 'Llama Test',
        isFree: false,
        brand: 'Meta',
        providerId: 'groq',
        sourceBackend: 'groq',
        modelFormat: 'openai',
        npm: '@ai-sdk/groq',
        apiKey: 'groq-key',
      },
      {
        id: 'oauth-tier',
        name: 'OAuth Tier',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openai-oauth',
        sourceBackend: 'openai-oauth',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        authType: 'oauth',
        apiKey: 'synthetic-oauth-token',
      },
      {
        id: 'api-tier',
        name: 'API Tier',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openai',
        sourceBackend: 'openai',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        authType: 'api',
        apiKey: 'synthetic-api-key',
      },
    ]);

    const previousTier = process.env.CLODEX_SERVICE_TIER;
    process.env.CLODEX_SERVICE_TIER = 'fast';
    try {
      const server = await startTestServer({ catalog: auditCatalog, inferenceLogPath });
      for (const request of [
        { model: 'claude-native', output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'private prompt' }] },
        { model: 'anthropic-groq__llama-test', output_config: { effort: 'medium' }, messages: [{ role: 'user', content: 'another private prompt' }] },
        { model: 'oauth-tier', messages: [{ role: 'user', content: 'OAuth audit fixture' }] },
        { model: 'api-tier', messages: [{ role: 'user', content: 'API audit fixture' }] },
      ]) {
        const response = await fetch(`${server.url}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
        expect(response.status).toBe(200);
      }

      for (const modelId of ['oauth-tier', 'api-tier']) {
        const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'OpenAI audit fixture' }] }),
        });
        expect(response.status).toBe(200);
      }

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries.slice(0, 2)).toEqual([
        expect.objectContaining({ modelId: 'claude-native', effort: 'high', provider: 'zen', route: 'passthrough' }),
        expect.objectContaining({ modelId: 'anthropic-groq__llama-test', effort: 'medium', provider: 'groq', route: 'translated' }),
      ]);
      expect(entries).toHaveLength(6);
      expect(entries[2]).toMatchObject({ modelId: 'oauth-tier', serviceTier: 'priority', provider: 'openai-oauth' });
      expect(entries[3]).toMatchObject({ modelId: 'api-tier', provider: 'openai' });
      expect(entries[3]).not.toHaveProperty('serviceTier');
      expect(entries[4]).toMatchObject({ modelId: 'oauth-tier', serviceTier: 'priority', provider: 'openai-oauth' });
      expect(entries[5]).toMatchObject({ modelId: 'api-tier', provider: 'openai' });
      expect(entries[5]).not.toHaveProperty('serviceTier');
      expect(readFileSync(inferenceLogPath, 'utf8')).not.toContain('private prompt');
    } finally {
      if (previousTier === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = previousTier;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves health and model list endpoints', async () => {
    const catalog = defaultCatalog('https://upstream.example.test');
    const internalModel = catalog.get('claude-native');
    if (!internalModel) throw new Error('missing test model');
    internalModel.authRef = TEST_HELPER_REF;
    internalModel.oauthAccountId = 'private-account-id';
    internalModel.providerData = {
      accountUUID: 'private-account-uuid',
      cliUserID: 'private-user-id',
    };
    const server = await startTestServer({ catalog });

    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const models = await fetch(`${server.url}/models`);
    expect(models.status).toBe(200);
    const modelList = await models.json();
    expect(modelList).toEqual({
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-native' }),
        expect.objectContaining({ id: 'openai-format' }),
      ]),
    });
    expect(JSON.stringify(modelList)).not.toContain(TEST_HELPER_REF);
    expect(JSON.stringify(modelList)).not.toContain('private-account');
    expect(JSON.stringify(modelList)).not.toContain('private-user');
    expect(modelList.models).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ authRef: expect.anything() }),
        expect.objectContaining({ oauthAccountId: expect.anything() }),
        expect.objectContaining({ providerData: expect.anything() }),
      ]),
    );

    const anthropic = await fetch(`${server.url}/anthropic/v1/models`);
    expect(anthropic.status).toBe(200);
    expect(await anthropic.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-native' }),
        expect.objectContaining({ id: 'anthropic-go__openai-format' }),
      ]),
    });

    const openai = await fetch(`${server.url}/openai/v1/models`);
    expect(openai.status).toBe(200);
    expect(await openai.json()).toMatchObject({ object: 'list' });
  });

  it('returns 401 for protected endpoints when password is missing or wrong', async () => {
    const server = await startTestServer({ serverPassword: 'secret' });

    const missing = await fetch(`${server.url}/openai/v1/models`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { message: 'Unauthorized' } });

    const wrong = await fetch(`${server.url}/openai/v1/models`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.status).toBe(401);

    const right = await fetch(`${server.url}/openai/v1/models`, {
      headers: { 'x-api-key': 'secret' },
    });
    expect(right.status).toBe(200);
  });

  it('forwards Anthropic-native messages to the backend v1/messages endpoint with the real API key', async () => {
    const upstream = await startUpstream({
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native ok' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('claude-native', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
      ]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'msg-test' });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/messages',
      authorization: 'Bearer real-opencode-key',
      body: { model: 'claude-native', messages: [{ role: 'user', content: 'hi' }] },
    });
  });

  it('forwards anonymous Anthropic-native messages without authentication headers', async () => {
    const upstream = await startUpstream({
      id: 'msg-anonymous',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'anonymous ok' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        id: 'anonymous-model',
        name: 'Anonymous Model',
        isFree: true,
        brand: 'Other',
        providerId: 'local',
        sourceBackend: 'local',
        modelFormat: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKey: '',
        authType: 'none',
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anonymous-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'msg-anonymous' });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/messages',
      authorization: undefined,
      xApiKey: undefined,
    });
  });

  it('forwards anonymous OpenAI chat completions without authentication headers', async () => {
    const upstream = await startUpstream({
      id: 'chatcmpl-anonymous',
      choices: [{ message: { content: 'anonymous ok' }, finish_reason: 'stop' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        id: 'anonymous-chat-model',
        name: 'Anonymous Chat Model',
        isFree: true,
        brand: 'Other',
        providerId: 'local',
        sourceBackend: 'go',
        modelFormat: 'openai',
        completionsUrl: `${upstream.baseUrl}/v1/chat/completions`,
        apiKey: '',
        authType: 'none',
        headers: {
          Authorization: 'Bearer configured-value',
          'X-Plan': 'free',
        },
      }]),
    });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anonymous-chat-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-anonymous' });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: undefined,
      xApiKey: undefined,
      xPlan: 'free',
    });
  });

  it('resolves the current stored token before Anthropic passthrough dispatch', async () => {
    const upstream = await startUpstream({
      id: 'msg-oauth',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native oauth ok' }],
    });
    handles.push(upstream);
    vi.mocked(resolveProviderCredential).mockResolvedValue('current-oauth-token');
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('claude-oauth', 'anthropic', 'oauth-provider', {
          baseUrl: upstream.baseUrl,
        }),
        providerId: 'oauth-provider',
        authType: 'oauth',
        authRef: TEST_HELPER_REF,
        apiKey: 'launch-token',
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-oauth',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveProviderCredential).toHaveBeenCalledWith(
      'oauth-provider',
      TEST_HELPER_REF,
    );
    expect(upstream.requests[0]?.authorization).toBe('Bearer current-oauth-token');
  });

  it('retries native Anthropic passthrough once with the replacement credential', async () => {
    const upstream = await startSequencedUpstream([
      { status: 401, body: { error: { message: 'rejected token' } } },
      {
        status: 200,
        body: {
          id: 'msg-oauth-retry',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'native oauth recovered' }],
        },
      },
    ]);
    handles.push(upstream);
    vi.mocked(resolveProviderCredential)
      .mockResolvedValueOnce('rejected-token')
      .mockResolvedValueOnce('replacement-token');
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('claude-oauth-retry', 'anthropic', 'oauth-provider', {
          baseUrl: upstream.baseUrl,
        }),
        providerId: 'oauth-provider',
        authType: 'oauth',
        authRef: TEST_HELPER_REF,
        apiKey: 'launch-token',
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-oauth-retry',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'msg-oauth-retry' });
    expect(upstream.requests.map(request => request.authorization)).toEqual([
      'Bearer rejected-token',
      'Bearer replacement-token',
    ]);
    expect(resolveProviderCredential).toHaveBeenNthCalledWith(
      2,
      'oauth-provider',
      TEST_HELPER_REF,
      undefined,
      { rejectedAccessToken: 'rejected-token' },
    );
  });

  // OpenAI-format Anthropic translation now routes through the Vercel AI SDK adapter
  // (createLanguageModel + streamAnthropicResponse/generateAnthropicResponse), which
  // requires an SDK `npm` on the model. Translation correctness is covered by
  // sdk-adapter.test.ts (and was validated against live providers). Here we only
  // assert the router's guard: an OpenAI-format model with no SDK provider is rejected.
  it('rejects Anthropic messages for OpenAI-format models without an SDK provider', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-format',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('No SDK provider') },
    });
  });

  it('returns Anthropic prompt-too-long shape for a translated context overflow', async () => {
    const contextCatalog = createGatewayModelCatalog([{
      id: 'small-context',
      name: 'Small Context',
      isFree: false,
      brand: 'Test',
      providerId: 'test-provider',
      sourceBackend: 'test-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiKey: 'provider-key',
      contextWindow: 10,
    }]);
    vi.mocked(generateAnthropicResponse).mockRejectedValueOnce({
      statusCode: 400,
      data: {
        error: {
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window of this model.',
        },
      },
    });
    const server = await startTestServer({ catalog: contextCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-test-provider__small-context',
        messages: [{ role: 'user', content: 'This prompt is too long.' }],
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as {
      type: string;
      error: { type: string; message: string };
      request_id: string;
    };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/^prompt is too long: \d+ tokens > 10 maximum$/);
    expect(body.request_id).toEqual(expect.any(String));
  });

  it('sets a clamped retry-after header on translated 429s from both endpoints', async () => {
    const sdkCatalog = createGatewayModelCatalog([{
      id: 'sdk-model',
      name: 'SDK Model',
      isFree: false,
      brand: 'Test',
      providerId: 'test-provider',
      sourceBackend: 'test-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiKey: 'provider-key',
    }]);
    const rateLimitError = (retryAfter: string) => new APICallError({
      message: 'rate limited',
      url: 'https://upstream/v1/responses',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'retry-after': retryAfter },
      responseBody: JSON.stringify({ error: { message: 'rate limited' } }),
    });
    const server = await startTestServer({ catalog: sdkCatalog });

    // Anthropic-format endpoint: an oversized upstream hint comes out clamped.
    vi.mocked(generateAnthropicResponse).mockRejectedValueOnce(rateLimitError('3600'));
    const anthropicResponse = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-test-provider__sdk-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(anthropicResponse.status).toBe(429);
    expect(anthropicResponse.headers.get('retry-after')).toBe('60');

    // OpenAI-format endpoint: an in-range hint is forwarded as-is.
    vi.mocked(generateOpenAiResponse).mockRejectedValueOnce(rateLimitError('7'));
    const openAiResponse = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sdk-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(openAiResponse.status).toBe(429);
    expect(openAiResponse.headers.get('retry-after')).toBe('7');
  });

  it('omits the retry-after header on non-429 upstream errors', async () => {
    const sdkCatalog = createGatewayModelCatalog([{
      id: 'sdk-model',
      name: 'SDK Model',
      isFree: false,
      brand: 'Test',
      providerId: 'test-provider',
      sourceBackend: 'test-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiKey: 'provider-key',
    }]);
    // Even with a retry-after header present upstream, a non-429 stays terminal
    // with no backoff hint.
    vi.mocked(generateAnthropicResponse).mockRejectedValueOnce(new APICallError({
      message: 'forbidden',
      url: 'https://upstream/v1/responses',
      requestBodyValues: {},
      statusCode: 403,
      responseHeaders: { 'retry-after': '30' },
      responseBody: JSON.stringify({ error: { message: 'forbidden' } }),
    }));
    const server = await startTestServer({ catalog: sdkCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-test-provider__sdk-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('forces internal streaming for non-streaming requests on OpenAI OAuth routes', async () => {
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'gpt-oauth',
      name: 'GPT OAuth',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai-oauth',
      sourceBackend: 'openai-oauth',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'oauth',
      apiKey: 'oauth-access-token',
    }]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const messagesResponse = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai-oauth__gpt-oauth',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(messagesResponse.status).toBe(200);
    expect(vi.mocked(generateAnthropicResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: true }),
    );

    const chatResponse = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oauth',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(chatResponse.status).toBe(200);
    expect(vi.mocked(generateOpenAiResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: true }),
    );
  });

  it('uses the exact OAuth reference and rebuilds the cached model when the token changes', async () => {
    vi.mocked(resolveProviderCredential)
      .mockResolvedValueOnce('oauth-token-a')
      .mockResolvedValueOnce('oauth-token-b');
    const oauthCatalog = createGatewayModelCatalog([
      {
        id: 'oauth-refresh-route',
        name: 'OAuth Refresh Route',
        isFree: false,
        brand: 'Other',
        providerId: 'oauth-provider',
        sourceBackend: 'oauth-provider',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        authType: 'oauth',
        authRef: TEST_HELPER_REF,
        apiKey: 'launch-token',
      },
    ]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const messagesResponse = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-oauth-provider__oauth-refresh-route',
        messages: [{ role: 'user', content: 'first' }],
      }),
    });
    expect(messagesResponse.status).toBe(200);

    const chatResponse = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'oauth-refresh-route',
        messages: [{ role: 'user', content: 'second' }],
      }),
    });
    expect(chatResponse.status).toBe(200);

    expect(resolveProviderCredential).toHaveBeenNthCalledWith(
      1,
      'oauth-provider',
      TEST_HELPER_REF,
    );
    expect(resolveProviderCredential).toHaveBeenNthCalledWith(
      2,
      'oauth-provider',
      TEST_HELPER_REF,
    );
    expect(createLanguageModel).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(createLanguageModel).mock.calls.map(call => (call[0] as any).apiKey),
    ).toEqual(['oauth-token-a', 'oauth-token-b']);
  });

  it('does not expose credential-state paths when token resolution fails', async () => {
    vi.mocked(resolveProviderCredential).mockRejectedValue(
      new Error('Timed out waiting for provider registry lock: /private/state/providers.json.lock'),
    );
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'oauth-resolution-failure',
      name: 'OAuth Resolution Failure',
      isFree: false,
      brand: 'Other',
      providerId: 'oauth-provider',
      sourceBackend: 'oauth-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'oauth',
      authRef: TEST_HELPER_REF,
      apiKey: 'launch-token',
    }]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-oauth-provider__oauth-resolution-failure',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(response.status).toBe(401);
    const responseBody = JSON.stringify(await response.json());
    expect(responseBody).toContain('OAuth credential is unavailable for oauth-provider');
    expect(responseBody).not.toContain('/private/state');
  });

  it('refreshes once after a translated Anthropic-facing OAuth 401', async () => {
    vi.mocked(generateAnthropicResponse).mockClear();
    vi.mocked(generateAnthropicResponse).mockRejectedValueOnce(
      Object.assign(new Error('rejected token'), { statusCode: 401 }),
    );
    vi.mocked(resolveProviderCredential)
      .mockResolvedValueOnce('rejected-token')
      .mockResolvedValueOnce('refreshed-token');
    const oauthCatalog = createGatewayModelCatalog([
      {
        id: 'oauth-retry-anthropic',
        name: 'OAuth Retry Anthropic',
        isFree: false,
        brand: 'Other',
        providerId: 'oauth-provider',
        sourceBackend: 'oauth-provider',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        authType: 'oauth',
        authRef: TEST_HELPER_REF,
        apiKey: 'launch-token',
      },
    ]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-oauth-provider__oauth-retry-anthropic',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(generateAnthropicResponse).toHaveBeenCalledTimes(2);
    expect(resolveProviderCredential).toHaveBeenNthCalledWith(
      1,
      'oauth-provider',
      TEST_HELPER_REF,
    );
    expect(resolveProviderCredential).toHaveBeenNthCalledWith(
      2,
      'oauth-provider',
      TEST_HELPER_REF,
      undefined,
      { rejectedAccessToken: 'rejected-token' },
    );
    expect(
      vi.mocked(createLanguageModel).mock.calls.map(call => (call[0] as any).apiKey),
    ).toEqual(['rejected-token', 'refreshed-token']);
  });

  it('surfaces a second translated Anthropic-facing OAuth 401 without another retry', async () => {
    vi.mocked(generateAnthropicResponse).mockClear();
    vi.mocked(generateAnthropicResponse)
      .mockRejectedValueOnce(Object.assign(new Error('rejected token'), { statusCode: 401 }))
      .mockRejectedValueOnce(Object.assign(new Error('rejected token'), { statusCode: 401 }));
    vi.mocked(resolveProviderCredential)
      .mockResolvedValueOnce('rejected-token')
      .mockResolvedValueOnce('refreshed-token');
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'oauth-second-401-anthropic',
      name: 'OAuth Second 401 Anthropic',
      isFree: false,
      brand: 'Other',
      providerId: 'oauth-provider',
      sourceBackend: 'oauth-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'oauth',
      authRef: TEST_HELPER_REF,
      apiKey: 'launch-token',
    }]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-oauth-provider__oauth-second-401-anthropic',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(response.status).toBe(401);
    expect(generateAnthropicResponse).toHaveBeenCalledTimes(2);
    expect(resolveProviderCredential).toHaveBeenCalledTimes(2);
  });

  it('does not retry a translated OAuth stream after output has started', async () => {
    vi.mocked(streamAnthropicResponse).mockImplementationOnce(
      async (_model, _params, _modelId, write) => {
        write('event: message_start\ndata: {"type":"message_start"}\n\n');
        throw Object.assign(new Error('rejected token'), { statusCode: 401 });
      },
    );
    vi.mocked(resolveProviderCredential).mockResolvedValue('rejected-token');
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'oauth-stream-rejected',
      name: 'OAuth Stream Rejected',
      isFree: false,
      brand: 'Other',
      providerId: 'oauth-provider',
      sourceBackend: 'oauth-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'oauth',
      authRef: TEST_HELPER_REF,
      apiKey: 'launch-token',
    }]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-oauth-provider__oauth-stream-rejected',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('message_start');
    expect(body).toContain('event: error');
    expect(streamAnthropicResponse).toHaveBeenCalledTimes(1);
    expect(resolveProviderCredential).toHaveBeenCalledTimes(1);
  });

  it('refreshes once after a translated OpenAI-facing OAuth 401', async () => {
    vi.mocked(generateOpenAiResponse).mockClear();
    vi.mocked(generateOpenAiResponse).mockRejectedValueOnce(
      Object.assign(new Error('rejected token'), { statusCode: 401 }),
    );
    vi.mocked(resolveProviderCredential)
      .mockResolvedValueOnce('rejected-token')
      .mockResolvedValueOnce('refreshed-token');
    const oauthCatalog = createGatewayModelCatalog([
      {
        id: 'oauth-retry-openai',
        name: 'OAuth Retry OpenAI',
        isFree: false,
        brand: 'Other',
        providerId: 'oauth-provider',
        sourceBackend: 'oauth-provider',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        authType: 'oauth',
        authRef: TEST_HELPER_REF,
        apiKey: 'launch-token',
      },
    ]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'oauth-retry-openai',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(generateOpenAiResponse).toHaveBeenCalledTimes(2);
    expect(resolveProviderCredential).toHaveBeenNthCalledWith(
      1,
      'oauth-provider',
      TEST_HELPER_REF,
    );
    expect(resolveProviderCredential).toHaveBeenNthCalledWith(
      2,
      'oauth-provider',
      TEST_HELPER_REF,
      undefined,
      { rejectedAccessToken: 'rejected-token' },
    );
    expect(
      vi.mocked(createLanguageModel).mock.calls.map(call => (call[0] as any).apiKey),
    ).toEqual(['rejected-token', 'refreshed-token']);
  });

  it('surfaces a second translated OpenAI-facing OAuth 401 without another retry', async () => {
    vi.mocked(generateOpenAiResponse).mockClear();
    vi.mocked(generateOpenAiResponse)
      .mockRejectedValueOnce(Object.assign(new Error('rejected token'), { statusCode: 401 }))
      .mockRejectedValueOnce(Object.assign(new Error('rejected token'), { statusCode: 401 }));
    vi.mocked(resolveProviderCredential)
      .mockResolvedValueOnce('rejected-token')
      .mockResolvedValueOnce('refreshed-token');
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'oauth-second-401-openai',
      name: 'OAuth Second 401 OpenAI',
      isFree: false,
      brand: 'Other',
      providerId: 'oauth-provider',
      sourceBackend: 'oauth-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'oauth',
      authRef: TEST_HELPER_REF,
      apiKey: 'launch-token',
    }]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'oauth-second-401-openai',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(response.status).toBe(401);
    expect(generateOpenAiResponse).toHaveBeenCalledTimes(2);
    expect(resolveProviderCredential).toHaveBeenCalledTimes(2);
  });

  it('does not force streaming for non-streaming requests on API-key routes', async () => {
    const apiKeyCatalog = createGatewayModelCatalog([{
      id: 'gpt-api',
      name: 'GPT API',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'api',
      apiKey: 'sk-test',
    }]);
    const server = await startTestServer({ catalog: apiKeyCatalog });

    const messagesResponse = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai__gpt-api',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(messagesResponse.status).toBe(200);
    expect(vi.mocked(generateAnthropicResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: false }),
    );

    const chatResponse = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-api',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(chatResponse.status).toBe(200);
    expect(vi.mocked(generateOpenAiResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: false }),
    );
  });

  it('forwards OpenAI chat completions for OpenAI-format models unchanged', async () => {
    const upstream = await startUpstream({
      id: 'chatcmpl-test',
      choices: [{ message: { content: 'openai ok' }, finish_reason: 'stop' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('openai-format', 'openai', 'go', { completionsUrl: `${upstream.baseUrl}/v1/chat/completions` }),
      ]),
    });

    const body = { model: 'openai-format', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 };
    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test' });
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: 'Bearer real-opencode-key',
      body,
    });
  });

  it('applies direct OpenAI model compatibility before forwarding Chat Completions', async () => {
    const upstream = await startUpstream({
      id: 'chatcmpl-compatible',
      choices: [{ message: { content: 'compatible ok' }, finish_reason: 'stop' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        id: 'openai-compatible',
        name: 'OpenAI Compatible',
        isFree: false,
        brand: 'Other',
        providerId: 'ordinary',
        sourceBackend: 'ordinary',
        modelFormat: 'openai',
        completionsUrl: `${upstream.baseUrl}/v1/chat/completions`,
        compatibility: {
          supportsStore: false,
          maxTokensField: 'max_tokens',
          supportsReasoningEffort: false,
        },
        upstreamModelId: 'upstream-compatible',
      }]),
    });

    const body = {
      model: 'openai-compatible',
      messages: [{ role: 'user', content: 'hi' }],
      store: true,
      reasoning_effort: 'high',
      max_completion_tokens: 100,
      temperature: 0.2,
    };
    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body).toEqual({
      model: 'upstream-compatible',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.2,
    });
  });

  it('omits disabled Kimi reasoning levels while forwarding direct Chat Completions', async () => {
    const upstream = await startUpstream({
      id: 'chatcmpl-kimi',
      choices: [{ message: { content: 'kimi ok' }, finish_reason: 'stop' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        id: 'kimi-k3',
        name: 'Kimi K3',
        isFree: false,
        brand: 'Other',
        providerId: 'opencode-go',
        sourceBackend: 'go',
        modelFormat: 'openai',
        completionsUrl: `${upstream.baseUrl}/v1/chat/completions`,
        compatibility: {
          reasoningEffortMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
            max: 'max',
          },
          supportsTemperature: false,
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: 'max_tokens',
        },
        upstreamModelId: 'kimi-k3-upstream',
      }]),
    });

    const body = {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    };
    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body).toEqual({
      model: 'kimi-k3-upstream',
      messages: body.messages,
    });
  });

  it('caches SDK language models per provider-qualified route, not just raw model id', async () => {
    const duplicateCatalog = createGatewayModelCatalog([
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openai',
        providerLabel: 'OpenAI',
        sourceBackend: 'openai',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        apiKey: 'openai-key',
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o via OpenRouter',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openrouter',
        providerLabel: 'OpenRouter',
        sourceBackend: 'openrouter',
        modelFormat: 'openai',
        npm: '@openrouter/ai-sdk-provider',
        apiKey: 'openrouter-key',
      },
    ]);
    const server = await startTestServer({ catalog: duplicateCatalog });

    for (const modelId of ['anthropic-openai__gpt-4o', 'anthropic-openrouter__gpt-4o']) {
      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
    }

    expect(vi.mocked(createLanguageModel)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createLanguageModel).mock.calls.map(call => (call[0] as any).providerId)).toEqual([
      'openai',
      'openrouter',
    ]);
  });

  it('exposes SDK-only registry models through OpenAI chat completions', async () => {
    const sdkOnlyCatalog = createGatewayModelCatalog([{
      id: 'gpt-5',
      name: 'GPT-5',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      providerLabel: 'OpenAI',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
    }]);
    const server = await startTestServer({ catalog: sdkOnlyCatalog });

    const models = await fetch(`${server.url}/openai/v1/models`);
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({
      object: 'list',
      data: [
        expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
      ],
    });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', choices: [{ message: { content: 'openai sdk ok' } }] });
  });

  it('translates OpenAI requests for Anthropic-native models', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native', messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', choices: [{ message: { content: 'openai sdk ok' } }] });
  });

  it('rejects unsupported model formats', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bad-format', messages: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('Unsupported model format') },
    });
  });

  describe('saved alias and masked-id request resolution', () => {
    const lunaModel: ServerModelInfo = {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai-oauth',
      providerLabel: 'OpenAI (ChatGPT)',
      sourceBackend: 'openai-oauth',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiKey: 'oauth-token',
    };
    const gateway = { maskGatewayIds: true as const };
    const aliases = [{ name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }];

    async function startAliasServer(): Promise<ServerHandle> {
      return startTestServer({
        catalog: createGatewayModelCatalog([lunaModel], gateway, aliases),
        gateway,
        aliasNames: new Set(aliases.map(alias => alias.name)),
      });
    }

    it('resolves a bare saved alias and echoes it back verbatim in the response model', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'luna', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(response.status).toBe(200);
      // Echo invariant: the alias the client sent, not the canonical/display id.
      expect(await response.json()).toMatchObject({ id: 'msg-test', model: 'luna' });
    });

    it('resolves masked and canonical clodex ids when masking is on', async () => {
      const server = await startAliasServer();

      for (const requestId of [
        'anthropic-htuao-ianepo__anul-6.5-tpg', // masked form of anthropic-openai-oauth__gpt-5.6-luna
        'clodex:openai-oauth:gpt-5.6-luna',
      ]) {
        const response = await fetch(`${server.url}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: requestId, messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(response.status, requestId).toBe(200);
      }
    });

    it('resolves a saved alias on the OpenAI chat completions endpoint too', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'luna', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', model: 'luna' });
    });

    it('rejects conflicting saved aliases on both request formats without selecting a provider', async () => {
      const solModel: ServerModelInfo = {
        ...lunaModel,
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
      };
      const conflictingAliases = [
        { name: 'Orbit', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
        { name: 'ORBIT', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
      ];
      const server = await startTestServer({
        catalog: createGatewayModelCatalog(
          [lunaModel, solModel],
          gateway,
          conflictingAliases,
        ),
        gateway,
        aliasNames: new Set(),
        modelAliasRejections: [
          {
            alias: conflictingAliases[0]!,
            reason: 'conflicting-targets',
          },
          {
            alias: conflictingAliases[1]!,
            reason: 'conflicting-targets',
          },
        ],
      });
      await vi.waitFor(async () => {
        const health = await fetch(`${server.url}/health`);
        expect(health.status).toBe(200);
      });

      for (const path of [
        '/anthropic/v1/messages',
        '/openai/v1/chat/completions',
      ]) {
        expect(server.server.listening, path).toBe(true);
        const response = await fetch(`${server.url}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'orbit',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });

        expect(response.status, path).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            message: "Clodex model route 'orbit' is unavailable: conflicting targets. Run `clodex models --list` to inspect saved routes and aliases.",
          },
        });
      }

      expect(createLanguageModel).not.toHaveBeenCalled();
      expect(generateAnthropicResponse).not.toHaveBeenCalled();
      expect(streamAnthropicResponse).not.toHaveBeenCalled();
      expect(generateOpenAiResponse).not.toHaveBeenCalled();
      expect(streamOpenAiResponse).not.toHaveBeenCalled();
    });

    it('distinguishes capacity-skipped and unavailable configured aliases at request time', async () => {
      const server = await startTestServer({
        catalog: createGatewayModelCatalog([lunaModel], gateway),
        gateway,
        aliasNames: new Set(),
        modelAliasRejections: [
          {
            alias: { name: 'LaterAlias', providerId: 'openai-oauth', modelId: 'gpt-later' },
            reason: 'target-not-exposed',
          },
          {
            alias: { name: 'MissingAlias', providerId: 'openai-oauth', modelId: 'gpt-missing' },
            reason: 'target-unavailable',
          },
        ],
      });

      for (const path of [
        '/anthropic/v1/messages',
        '/openai/v1/chat/completions',
      ]) {
        for (const testCase of [
          {
            model: 'LaterAlias',
            reason: 'target is outside the active Claude Code catalog',
          },
          {
            model: 'MissingAlias',
            reason: 'target is unavailable or unsupported',
          },
        ]) {
          const response = await fetch(`${server.url}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: testCase.model, messages: [] }),
          });

          expect(response.status, `${path} ${testCase.model}`).toBe(400);
          expect(await response.json()).toMatchObject({
            error: {
              message: `Clodex model route '${testCase.model}' is unavailable: ${testCase.reason}. Run \`clodex models --list\` to inspect saved routes and aliases.`,
            },
          });
        }
      }
    });

    it('still rejects unknown model ids with 400', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nova', messages: [] }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { message: 'Unknown model: nova' } });
    });

    it('does not advertise alias names in the discovery model list', async () => {
      const server = await startAliasServer();

      const listing = await fetch(`${server.url}/anthropic/v1/models`);
      expect(listing.status).toBe(200);
      const payload = await listing.json() as { data: Array<{ id: string }> };
      expect(payload.data.map(entry => entry.id)).toEqual(['anthropic-htuao-ianepo__anul-6.5-tpg']);
    });
  });
});

describe('anthropic count_tokens', () => {
  // `clodex server --endpoint` and the clodex-claude wrapper both point
  // ANTHROPIC_BASE_URL at this gateway (src/wrapper-env.ts), so Claude Code's
  // token-accounting preflight lands here. Before the route existed it fell
  // through to the catch-all 404 and Claude Code got no number at all.

  it('answers count_tokens locally when the model declares no upstream support', async () => {
    const upstream = await startUpstream({ input_tokens: 999 });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('opencode-anthropic', 'anthropic', 'go', { baseUrl: upstream.baseUrl }),
        compatibility: { supportsCountTokens: false },
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'opencode-anthropic',
        messages: [{ role: 'user', content: 'count this' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-relay-token-count-source')).toBe('local-estimate');
    const payload = await response.json() as { input_tokens: number };
    expect(payload.input_tokens).toBeGreaterThan(0);
    // The point of the capability: the upstream is never asked.
    expect(upstream.requests).toHaveLength(0);
  });

  it('answers count_tokens locally for translated (SDK) models', async () => {
    const upstream = await startUpstream({ input_tokens: 999 });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('openai-format', 'openai', 'go', { completionsUrl: `${upstream.baseUrl}/v1/chat/completions` }),
      ]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-format',
        messages: [{ role: 'user', content: 'count this' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-relay-token-count-source')).toBe('local-estimate');
    expect((await response.json() as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    expect(upstream.requests).toHaveLength(0);
  });

  it('forwards count_tokens upstream when the capability is unset', async () => {
    const upstream = await startUpstream({ input_tokens: 42 });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('claude-native', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
      ]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ input_tokens: 42 });
    expect(response.headers.get('x-relay-token-count-source')).toBeNull();
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      authorization: 'Bearer real-opencode-key',
      body: { model: 'claude-native', messages: [{ role: 'user', content: 'hi' }] },
    });
  });

  it('forwards count_tokens upstream when the capability is explicitly true', async () => {
    const upstream = await startUpstream({ input_tokens: 7 });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('claude-supported', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
        compatibility: { supportsCountTokens: true },
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-supported', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ input_tokens: 7 });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.url).toBe('/v1/messages/count_tokens');
  });

  it('sends the upstream wire id, not the catalog id, when forwarding', async () => {
    const upstream = await startUpstream({ input_tokens: 3 });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('catalog-id', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
        upstreamModelId: 'wire-id',
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'catalog-id', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]).toMatchObject({ body: { model: 'wire-id' } });
  });

  it('rejects an unknown model on the count_tokens route', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: 'Unknown model: nope' } });
  });

  it('rejects an unsupported model format on the count_tokens route', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bad-format', messages: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: 'Unsupported model format: unsupported' },
    });
  });

  it('rejects invalid JSON on the count_tokens route', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: 'Invalid JSON body' } });
  });

  it('does not widen routing to neighbouring paths or other methods', async () => {
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('opencode-anthropic', 'anthropic', 'go', { baseUrl: 'http://127.0.0.1:1' }),
        compatibility: { supportsCountTokens: false },
      }]),
    });
    const body = JSON.stringify({ model: 'opencode-anthropic', messages: [] });

    const suffixed = await fetch(`${server.url}/anthropic/v1/messages/count_tokens/extra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(suffixed.status).toBe(404);

    const unprefixed = await fetch(`${server.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(unprefixed.status).toBe(404);

    const wrongMethod = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`);
    expect(wrongMethod.status).toBe(404);
  });

  it('requires authorization before answering count_tokens', async () => {
    const server = await startTestServer({
      serverPassword: 'secret',
      catalog: createGatewayModelCatalog([{
        ...model('opencode-anthropic', 'anthropic', 'go', { baseUrl: 'http://127.0.0.1:1' }),
        compatibility: { supportsCountTokens: false },
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'opencode-anthropic', messages: [] }),
    });

    expect(response.status).toBe(401);
  });
});

describe('endpoint-mode Anthropic beta and identity are negative-only', () => {
  /** Upstream that records the full header map of every request it receives. */
  async function startHeaderCapturingUpstream(body: unknown): Promise<{
    baseUrl: string;
    requests: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: any }>;
    close: () => Promise<void>;
  }> {
    const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: any }> = [];
    const server = createServer(async (req, res) => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: await readRequestBody(req) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream address');
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      requests,
      close: () => new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve()))),
    };
  }

  function expectNoNativeIdentity(headers: Record<string, string | string[] | undefined>): void {
    for (const name of ['x-app', 'x-claude-code-session-id']) {
      expect(headers[name]).toBeUndefined();
    }
    // The HTTP client's own UA is expected; a simulated native-client UA is not.
    expect(String(headers['user-agent'] ?? '')).not.toContain('claude');
  }

  it.each([
    ['/anthropic/v1/messages', '/v1/messages'],
    ['/anthropic/v1/messages/count_tokens', '/v1/messages/count_tokens'],
  ])('drops the client beta and synthesizes nothing on %s', async (endpoint, upstreamPath) => {
    const upstream = await startHeaderCapturingUpstream({
      id: 'msg-negative', type: 'message', role: 'assistant',
      model: 'claude-oauth', content: [], input_tokens: 3,
    });
    handles.push(upstream);
    vi.mocked(resolveProviderCredential).mockResolvedValue('current-oauth-token');
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('claude-oauth', 'anthropic', 'oauth-provider', { baseUrl: upstream.baseUrl }),
        // Every tempting label, at the endpoint boundary this time.
        providerId: 'claude-code',
        authType: 'oauth',
        authRef: TEST_HELPER_REF,
        apiKey: 'launch-token',
        providerData: { cliUserID: 'a'.repeat(64), nativeClaude: true },
      }]),
    });

    const response = await fetch(`${server.url}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'client-alpha,client-beta',
      },
      body: JSON.stringify({
        model: 'claude-oauth',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    const sent = upstream.requests[0]!;
    // Destination and count routing conserved.
    expect(sent.url).toBe(upstreamPath);
    expect(sent.headers.authorization).toBe('Bearer current-oauth-token');
    expect(sent.headers['x-api-key']).toBeUndefined();
    // Negative: no client beta, no synthesized identity, verbatim body.
    expect(sent.headers['anthropic-beta']).toBeUndefined();
    expectNoNativeIdentity(sent.headers);
    expect(sent.body.system).toBe('You are helpful.');
    expect(sent.body).not.toHaveProperty('metadata');
    expect(JSON.stringify(sent.body)).not.toContain('x-anthropic-billing-header');
  });

  it('emits the configured beta and echoes the requested model on the endpoint path', async () => {
    const upstream = await startHeaderCapturingUpstream({
      id: 'msg-cfg', type: 'message', role: 'assistant',
      model: 'upstream-real-id', content: [],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('claude-cfg', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
        upstreamModelId: 'upstream-real-id',
        headers: { 'Anthropic-Beta': 'cfg-a, cfg-b', 'anthropic-beta': 'cfg-b', 'X-Plan': 'coding' },
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'client-alpha' },
      body: JSON.stringify({ model: 'claude-cfg', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    const sent = upstream.requests[0]!;
    expect(sent.headers['anthropic-beta']).toBe('cfg-a,cfg-b');
    expect(sent.headers['x-plan']).toBe('coding');
    expectNoNativeIdentity(sent.headers);
    // Response-model echo conserved: the client sees the id it asked for.
    expect((await response.json() as { model: string }).model).toBe('claude-cfg');
    expect(sent.body.model).toBe('upstream-real-id');
  });

  // ── Capability betas: earned per request, never allowlisted ──────────────
  const ONE_M_BETA = 'context-1m-2025-08-07';
  const TOOL_SEARCH_FIRST_PARTY = 'advanced-tool-use-2025-11-20';
  const TOOL_SEARCH_GATEWAY = 'tool-search-tool-2025-10-19';
  const TOOL_SEARCH_TOOLS = [
    { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
  ];

  it.each([
    ['/anthropic/v1/messages', '/v1/messages'],
    ['/anthropic/v1/messages/count_tokens', '/v1/messages/count_tokens'],
  ])('carries the earned [1m] and tool-search betas on %s', async (endpoint, upstreamPath) => {
    const upstream = await startHeaderCapturingUpstream({
      id: 'msg-cap', type: 'message', role: 'assistant',
      model: 'claude-cap', content: [], input_tokens: 3,
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('claude-cap[1m]', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
        contextWindow: 1_000_000,
      }]),
    });

    const response = await fetch(`${server.url}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': `${ONE_M_BETA},${TOOL_SEARCH_FIRST_PARTY},client-alpha`,
      },
      body: JSON.stringify({
        model: 'claude-cap[1m]',
        messages: [{ role: 'user', content: 'hi' }],
        tools: TOOL_SEARCH_TOOLS,
      }),
    });

    expect(response.status).toBe(200);
    const sent = upstream.requests[0]!;
    expect(sent.url).toBe(upstreamPath);
    expect(sent.headers['anthropic-beta'])
      .toBe(`${ONE_M_BETA},${TOOL_SEARCH_FIRST_PARTY}`);
    // The arbitrary token riding alongside is still refused, and nothing else
    // about the negative-only contract changed.
    expect(String(sent.headers['anthropic-beta'])).not.toContain('client-alpha');
    expectNoNativeIdentity(sent.headers);
    // The wire model still drops the [1m] surface marker.
    expect(sent.body.model).toBe('claude-cap');
  });

  it.each([
    // Setup adapted (was `undefined`): with no configured window this id
    // resolves to 1M through the same heuristic the advertisement surface uses,
    // so the route DID advertise 1M and the old fixture only refused because
    // the predicate resolved the window differently than advertisement did. An
    // explicit 200K makes the label true again and keeps the property — the
    // window decides, not the `[1m]` spelling. The admitted direction is
    // covered by "carries the earned [1m] beta from the advertised id alone".
    ['the route does not advertise 1M', 'claude-cap[1m]', 200_000],
    ['the request is not on the [1m] surface', 'claude-cap', 1_000_000],
  ])('refuses the [1m] beta when %s', async (_label, modelId, contextWindow) => {
    const upstream = await startHeaderCapturingUpstream({
      id: 'msg-neg', type: 'message', role: 'assistant', model: modelId, content: [],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model(modelId, 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': ONE_M_BETA },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.headers['anthropic-beta']).toBeUndefined();
  });

  it('carries the earned [1m] beta from the advertised id alone', async () => {
    // No configured context window: the id is the only evidence, and the
    // predicate must read it exactly as the advertisement surface does.
    const upstream = await startHeaderCapturingUpstream({
      id: 'msg-idonly', type: 'message', role: 'assistant', model: 'claude-idonly', content: [],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('claude-idonly[1m]', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
      ]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': ONE_M_BETA },
      body: JSON.stringify({ model: 'claude-idonly[1m]', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.headers['anthropic-beta']).toBe(ONE_M_BETA);
  });

  it('refuses both tool-search betas for an ordinary tool request', async () => {
    const upstream = await startHeaderCapturingUpstream({
      id: 'msg-ord', type: 'message', role: 'assistant', model: 'claude-ord', content: [],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('claude-ord', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
      ]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': `${TOOL_SEARCH_FIRST_PARTY},${TOOL_SEARCH_GATEWAY}`,
      },
      body: JSON.stringify({
        model: 'claude-ord',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.headers['anthropic-beta']).toBeUndefined();
  });

  it('unions the configured beta with the earned capability, configured first', async () => {
    const upstream = await startHeaderCapturingUpstream({
      id: 'msg-union', type: 'message', role: 'assistant', model: 'claude-union', content: [],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('claude-union[1m]', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
        contextWindow: 1_000_000,
        headers: { 'Anthropic-Beta': 'cfg-a, cfg-b', 'X-Plan': 'coding' },
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': `${ONE_M_BETA},client-alpha`,
      },
      body: JSON.stringify({
        model: 'claude-union[1m]',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    const sent = upstream.requests[0]!;
    expect(sent.headers['anthropic-beta']).toBe(`cfg-a,cfg-b,${ONE_M_BETA}`);
    expect(sent.headers['x-plan']).toBe('coding');
  });

  it('keeps direct OpenAI chat completions negative', async () => {
    const upstream = await startHeaderCapturingUpstream({
      id: 'chatcmpl-negative',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('openai-direct', 'openai', 'go', {
          completionsUrl: `${upstream.baseUrl}/v1/chat/completions`,
        }),
      ]),
    });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'client-alpha' },
      body: JSON.stringify({ model: 'openai-direct', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    const sent = upstream.requests[0]!;
    expect(sent.headers['anthropic-beta']).toBeUndefined();
    expectNoNativeIdentity(sent.headers);
  });

  it('never wires providerData into SDK creation for an OpenAI-ingress Anthropic model', async () => {
    vi.mocked(resolveProviderCredential).mockResolvedValue('current-oauth-token');
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([{
        ...model('claude-sdk', 'anthropic', 'oauth-provider', { baseUrl: 'https://api.anthropic.com' }),
        npm: '@ai-sdk/anthropic',
        providerId: 'claude-code',
        authType: 'oauth',
        authRef: TEST_HELPER_REF,
        providerData: { cliUserID: 'a'.repeat(64), nativeClaude: true },
      }]),
    });

    await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sdk', messages: [{ role: 'user', content: 'hi' }] }),
    });

    for (const [spec] of vi.mocked(createLanguageModel).mock.calls) {
      expect(spec).not.toHaveProperty('providerData');
      expect(JSON.stringify(spec)).not.toContain('cliUserID');
      expect(JSON.stringify(spec)).not.toContain('nativeClaude');
    }
  });
});

describe('global effort policy at the request boundary', () => {
  /** deepseek-v4-flash's real reviewed shape: two rungs, nothing below `high`. */
  const SPARSE_COMPATIBILITY = {
    reasoningEffortMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
  } as const;
  const SPARSE_PROFILE = {
    modelId: 'sparse-model',
    transport: 'openai-completions',
    defaultLevel: null,
    levels: [
      { level: 'high' as const, native: { kind: 'reasoning-effort' as const, value: 'high' } },
      { level: 'max' as const, native: { kind: 'reasoning-effort' as const, value: 'max' } },
    ],
  };
  /** gpt-5.6-luna's real shape: `off` leaves as the native spelling `none`. */
  const RENAMING_COMPATIBILITY = {
    reasoningEffortMap: {
      off: 'none', minimal: null, low: 'low', medium: 'medium',
      high: 'high', xhigh: 'xhigh', max: 'max',
    },
  } as const;
  const RENAMING_PROFILE = {
    modelId: 'renaming-model',
    transport: 'openai-completions',
    defaultLevel: null,
    levels: [
      { level: 'off' as const, native: { kind: 'reasoning-effort' as const, value: 'none' } },
      { level: 'low' as const, native: { kind: 'reasoning-effort' as const, value: 'low' } },
      { level: 'high' as const, native: { kind: 'reasoning-effort' as const, value: 'high' } },
    ],
  };

  async function directServer(
    effortPolicy: 'provider-default' | 'up' | 'down' | 'exact' | undefined,
  ) {
    const upstream = await startUpstream({
      id: 'chatcmpl-effort',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      effortPolicy,
      catalog: createGatewayModelCatalog([
        {
          ...model('sparse-model', 'openai', 'go', {
            completionsUrl: `${upstream.baseUrl}/v1/chat/completions`,
          }),
          compatibility: SPARSE_COMPATIBILITY,
          effortProfile: SPARSE_PROFILE,
        },
        {
          ...model('renaming-model', 'openai', 'go', {
            completionsUrl: `${upstream.baseUrl}/v1/chat/completions`,
          }),
          compatibility: RENAMING_COMPATIBILITY,
          effortProfile: RENAMING_PROFILE,
        },
        {
          // Same wire map, no reviewed profile: the policy must not touch it.
          ...model('unprofiled-model', 'openai', 'go', {
            completionsUrl: `${upstream.baseUrl}/v1/chat/completions`,
          }),
          compatibility: SPARSE_COMPATIBILITY,
        },
      ]),
    });
    return { server, upstream };
  }

  async function translatedServer(
    profile: 'sparse' | 'renaming',
    effortPolicy: 'provider-default' | 'up' | 'down' | 'exact' | undefined,
  ) {
    const id = `translated-${profile}-model`;
    const compatibility = profile === 'sparse' ? SPARSE_COMPATIBILITY : RENAMING_COMPATIBILITY;
    const effortProfile = profile === 'sparse' ? SPARSE_PROFILE : RENAMING_PROFILE;
    return startTestServer({
      effortPolicy,
      catalog: createGatewayModelCatalog([{
        ...model(id, 'openai', 'go'),
        npm: '@ai-sdk/openai-compatible',
        apiBaseUrl: 'https://example.invalid/v1',
        apiKey: 'provider-key',
        providerId: 'go',
        compatibility,
        effortProfile: { ...effortProfile, modelId: id },
      }]),
    });
  }

  async function post(server: ServerHandle, body: Record<string, unknown>) {
    return fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
  }

  it('omits an unsupported effort by default and lets the provider decide', async () => {
    const { server, upstream } = await directServer(undefined);
    expect((await post(server, { model: 'sparse-model', reasoning_effort: 'low' })).status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('rounds an unsupported effort onto the ladder when asked to', async () => {
    const { server, upstream } = await directServer('up');
    expect((await post(server, { model: 'sparse-model', reasoning_effort: 'low' })).status).toBe(200);
    expect(upstream.requests[0]!.body.reasoning_effort).toBe('high');

    const down = await directServer('down');
    expect((await post(down.server, { model: 'sparse-model', reasoning_effort: 'xhigh' })).status).toBe(200);
    expect(down.upstream.requests[0]!.body.reasoning_effort).toBe('high');
  });

  it('refuses an unsupported effort under exact without reaching the upstream', async () => {
    const { server, upstream } = await directServer('exact');
    const response = await post(server, { model: 'sparse-model', reasoning_effort: 'low' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: 'Effort "low" is not supported by sparse-model. Supported levels: high, max.',
      },
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it('maps translated exact refusal to HTTP 400 before SDK dispatch', async () => {
    const server = await translatedServer('sparse', 'exact');
    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'translated-sparse-model',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'low' },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: 'Effort "low" is not supported by translated-sparse-model. Supported levels: high, max.',
      },
    });
    expect(generateAnthropicResponse).not.toHaveBeenCalled();
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('sends the native spelling for a supported level', async () => {
    const { server, upstream } = await directServer('provider-default');
    expect((await post(server, { model: 'renaming-model', reasoning_effort: 'off' })).status).toBe(200);
    expect(upstream.requests[0]!.body.reasoning_effort).toBe('none');
  });

  it('forwards an already-native value untouched instead of translating it twice', async () => {
    // `none` is what the upstream expects and is ALSO a global level name. A
    // client that already wrote the native value must reach the upstream with
    // it, not have it re-resolved into something else.
    const { server, upstream } = await directServer('up');
    expect((await post(server, { model: 'renaming-model', reasoning_effort: 'none' })).status).toBe(200);
    expect(upstream.requests[0]!.body.reasoning_effort).toBe('none');
  });

  it('treats off and none equivalently on translated and direct paths under default and exact policy', async () => {
    for (const policy of ['provider-default', 'exact'] as const) {
      const translated = await translatedServer('renaming', policy);
      for (const effort of ['off', 'none'] as const) {
        const response = await fetch(`${translated.url}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'translated-renaming-model',
            max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
            output_config: { effort },
          }),
        });
        expect(response.status, `translated ${policy}/${effort}`).toBe(200);
        const params = vi.mocked(generateAnthropicResponse).mock.calls.at(-1)?.[1] as {
          providerOptions?: Record<string, Record<string, unknown>>;
        };
        expect(params.providerOptions?.go?.reasoningEffort, `translated ${policy}/${effort}`).toBe('none');
      }

      const direct = await directServer(policy);
      for (const effort of ['off', 'none'] as const) {
        const response = await post(direct.server, { model: 'renaming-model', reasoning_effort: effort });
        expect(response.status, `direct ${policy}/${effort}`).toBe(200);
        expect(direct.upstream.requests.at(-1)!.body.reasoning_effort, `direct ${policy}/${effort}`).toBe('none');
      }
    }
  });

  it('leaves a model without a reviewed profile on its existing behavior', async () => {
    // Same map, no profile: `low` is dropped by the wire map exactly as before,
    // and `up` does not round it, because there is nothing to round against.
    const { server, upstream } = await directServer('up');
    expect((await post(server, { model: 'unprofiled-model', reasoning_effort: 'low' })).status).toBe(200);
    expect(upstream.requests[0]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('reads the other accepted spelling and never leaves both fields set', async () => {
    const { server, upstream } = await directServer('up');
    const response = await post(server, {
      model: 'sparse-model',
      reasoning: { effort: 'low', summary: 'auto' },
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.body.reasoning_effort).toBe('high');
    expect(upstream.requests[0]!.body.reasoning).toEqual({ summary: 'auto' });
  });

  it('normalizes a nested already-native effort before direct forwarding', async () => {
    const { server, upstream } = await directServer('exact');
    const response = await post(server, {
      model: 'renaming-model',
      reasoning: { effort: 'none', summary: 'auto' },
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.body.reasoning_effort).toBe('none');
    expect(upstream.requests[0]!.body.reasoning).toEqual({ summary: 'auto' });
  });

  it('normalizes conflicting direct spellings with top-level precedence', async () => {
    const { server, upstream } = await directServer('exact');
    const response = await post(server, {
      model: 'renaming-model',
      reasoning_effort: 'none',
      reasoning: { effort: 'high', summary: 'auto' },
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.body.reasoning_effort).toBe('none');
    expect(upstream.requests[0]!.body.reasoning).toEqual({ summary: 'auto' });
  });

  it('strips blank direct effort spellings while preserving nested reasoning members', async () => {
    const { server, upstream } = await directServer(undefined);
    const response = await post(server, {
      model: 'sparse-model',
      reasoning_effort: '  ',
      reasoning: { effort: '\t', summary: 'auto' },
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.body).not.toHaveProperty('reasoning_effort');
    expect(upstream.requests[0]!.body.reasoning).toEqual({ summary: 'auto' });
  });

  it('never invents a reasoning field on the token-count path', async () => {
    const upstream = await startUpstream({ input_tokens: 42 });
    handles.push(upstream);
    const server = await startTestServer({
      effortPolicy: 'up',
      catalog: createGatewayModelCatalog([{
        ...model('counting-model', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
        // A route with no clodex-operable effort control, which is exactly the
        // shape every Anthropic-format OpenCode Go entry has.
        effortProfile: { ...SPARSE_PROFILE, modelId: 'counting-model', levels: [] },
      }]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'counting-model',
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'low' },
      }),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    const body = upstream.requests[0]!.body;
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('thinking');
    // The count sizes the request the client actually intends to send, so its
    // own effort field travels unchanged.
    expect(body.output_config).toEqual({ effort: 'low' });
  });
});
