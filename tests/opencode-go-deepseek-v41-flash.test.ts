import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import { startProxyCatalog } from '../src/proxy.js';
import { materializeRegistry } from '../src/registry/materialize.js';
import type { CachedModel, ProviderRegistry } from '../src/registry/types.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';

/**
 * #308: every DeepSeek V4.1 Flash request was reported failing with 422
 * "Endpoint is unavailable". clodex sent it to OpenCode Go's Anthropic Messages
 * endpoint; OpenCode documents it on Chat Completions.
 *
 * Everything here starts from the registry an EXISTING install holds — a model
 * cache written by an older clodex whose catalog said Messages — and nothing is
 * mocked between that registry and the HTTP request that leaves the process:
 * the real projection, materialization, route building, proxy adapter or API server,
 * translation and @ai-sdk/openai-compatible all run. Only `fetch` is replaced,
 * so the assertions read the exact URL, headers and body OpenCode would get.
 */

const SESSION_ID = '3d0f6f5e-8a2b-4c1d-9e7f-2b6a4c8d1e30';
const GO_KEY = 'go-key';
const GO_COMPLETIONS_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

/** A minimal row of the kind Go's /models discovery yields, before the catalog overlay. */
function discovered(id: string): CachedModel {
  return {
    id,
    name: id,
    upstreamModelId: id,
    family: id.split('-')[0] ?? id,
    brand: 'OpenCode',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
  };
}

/**
 * What `clodex providers refresh-models` persisted for V4.1 Flash before this
 * fix: the discovered row with that release's catalog entry layered over it.
 * The overlay below is the entry clodex 2.18.7 shipped, verbatim.
 */
const LEGACY_V41_FLASH_ROW: CachedModel = {
  ...discovered('deepseek-v4.1-flash'),
  name: 'DeepSeek V4.1 Flash',
  contextWindow: 1_000_000,
  cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
  modelFormat: 'anthropic',
  npm: '@ai-sdk/anthropic',
  apiUrl: 'https://opencode.ai/zen/go',
  reasoning: true,
  modalities: ['text', 'image'],
  compatibility: { supportsCountTokens: false, supportsReasoningEffort: false },
  upstreamModelId: 'deepseek-v4.1-flash',
  family: 'deepseek',
};

/** A model OpenCode does document on Messages, retained in the same cache. */
const LEGACY_QWEN_ROW: CachedModel = {
  ...discovered('qwen3.8-max'),
  name: 'Qwen3.8 Max',
  modelFormat: 'anthropic',
  npm: '@ai-sdk/anthropic',
  apiUrl: 'https://opencode.ai/zen/go',
  compatibility: { supportsCountTokens: false, supportsReasoningEffort: false },
};

function existingInstallRegistry(): ProviderRegistry {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      preserveModelPricing: true,
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
      modelsCache: {
        fetchedAt: '2026-09-20T00:00:00.000Z',
        models: [structuredClone(LEGACY_V41_FLASH_ROW), structuredClone(LEGACY_QWEN_ROW)],
      },
      addedAt: '2026-09-20T00:00:00.000Z',
    }],
  };
}

function materializeExistingInstall() {
  return materializeRegistry(existingInstallRegistry(), () => GO_KEY);
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

type UpstreamMessage = Record<string, unknown>;

/**
 * Replace `fetch` and answer every request with the next queued Chat
 * Completions message. Whatever URL the request names is recorded and
 * answered, so a request sent to the wrong endpoint fails on the URL assertion
 * rather than on a network error.
 */
function stubUpstream(replies: UpstreamMessage[]): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    captured.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, any>,
    });
    const message = replies.shift() ?? { role: 'assistant', content: 'ok' };
    if (captured.at(-1)!.body.stream === true) {
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
        id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4.1-flash',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      const body = chunk({ role: 'assistant', reasoning_content: message.reasoning_content }, null)
        + chunk({ content: message.content }, null)
        + chunk({}, 'stop')
        + 'data: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      id: `chatcmpl-${captured.length}`,
      object: 'chat.completion',
      created: 0,
      model: 'deepseek-v4.1-flash',
      choices: [{
        index: 0,
        message,
        finish_reason: Array.isArray(message.tool_calls) ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return captured;
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

const READ_TOOL = {
  name: 'Read',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
};

const REASONED_TOOL_CALL: UpstreamMessage = {
  role: 'assistant',
  content: null,
  reasoning_content: 'I should read the file first.',
  tool_calls: [{
    id: 'call_00_v41',
    type: 'function',
    function: { name: 'Read', arguments: '{"file_path":"/tmp/a"}' },
  }],
};

/**
 * Drive one tool round trip the way Claude Code does: the first answer comes
 * back through clodex as Anthropic content, and the second request replays that
 * content — so the reasoning sent back is whatever clodex itself produced, not
 * a hand-built thinking block.
 */
async function toolRoundTrip(
  send: (body: Record<string, unknown>) => Promise<{ status: number; body: string }>,
  model: string,
  captured: CapturedRequest[],
): Promise<void> {
  // An earlier turn with no reasoning, as a turn from another model leaves.
  const history = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
    { role: 'user', content: 'read /tmp/a' },
  ];
  const first = await send({
    model,
    max_tokens: 1000,
    stream: false,
    tools: [READ_TOOL],
    output_config: { effort: 'high' },
    messages: history,
  });
  expect(first.status, first.body).toBe(200);
  // Checked before the answer is read: a request sent to any other endpoint
  // gets back a body that is not an Anthropic message at all.
  expect(captured.map(request => request.url)).toEqual([GO_COMPLETIONS_URL]);
  const content = (JSON.parse(first.body) as { content: Array<{ type: string; id?: string }> }).content;
  expect(content.map(block => block.type)).toEqual(['thinking', 'tool_use']);
  const toolUseId = content.find(block => block.type === 'tool_use')!.id!;

  const second = await send({
    model,
    max_tokens: 1000,
    stream: false,
    tools: [READ_TOOL],
    output_config: { effort: 'max' },
    messages: [
      ...history,
      { role: 'assistant', content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file contents' }] },
    ],
  });
  expect(second.status, second.body).toBe(200);
  expect(captured).toHaveLength(2);
}

/** The wire contract both bridge modes must meet for V4.1 Flash. */
function expectGoChatCompletionsWire(captured: CapturedRequest[]): void {
  for (const request of captured) {
    expect(request.url).toBe(GO_COMPLETIONS_URL);
    expect(request.headers.get('authorization')).toBe(`Bearer ${GO_KEY}`);
    expect(request.headers.get('x-api-key')).toBeNull();
    expect(request.headers.get('x-opencode-session')).toBe(SESSION_ID);
    expect(request.body.model).toBe('deepseek-v4.1-flash');
    // DeepSeek's thinking switch rides beside the graded effort.
    expect(request.body.thinking).toEqual({ type: 'enabled' });
    expect(request.body.max_tokens).toBe(1000);
    expect(request.body).not.toHaveProperty('max_completion_tokens');
    expect(request.body).not.toHaveProperty('store');
  }
  expect(captured.map(request => request.body.reasoning_effort)).toEqual(['high', 'max']);

  const assistants = (captured[1]!.body.messages as Array<Record<string, any>>)
    .filter(message => message.role === 'assistant');
  expect(assistants).toHaveLength(2);
  // A request that carries tools must hand back reasoning_content on every
  // assistant turn: empty where the turn had none ...
  expect(assistants[0]).toMatchObject({ content: 'Hello.', reasoning_content: '' });
  // ... and the model's own reasoning on the turn that produced the tool call.
  expect(assistants[1]).toMatchObject({
    reasoning_content: 'I should read the file first.',
    tool_calls: [{ id: 'call_00_v41', function: { name: 'Read' } }],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepSeek V4.1 Flash on an existing OpenCode Go install', () => {
  it('moves to Chat Completions at load time, without a model refresh', () => {
    const registry = existingInstallRegistry();
    // The persisted cache still names Messages — the projection must do the work.
    expect(registry.providers[0]!.modelsCache!.models[0]).toMatchObject({
      modelFormat: 'anthropic', npm: '@ai-sdk/anthropic', apiUrl: 'https://opencode.ai/zen/go',
    });

    const providers = materializeRegistry(registry, () => GO_KEY);
    const models = new Map(providers[0]!.models.map(model => [model.id, model]));
    expect(models.get('deepseek-v4.1-flash')).toMatchObject({
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      apiBaseUrl: 'https://opencode.ai/zen/go/v1',
      completionsUrl: GO_COMPLETIONS_URL,
      baseUrl: undefined,
      compatibility: {
        thinkingFormat: 'deepseek',
        requiresReasoningContentOnAssistantMessages: true,
        maxTokensField: 'max_tokens',
      },
    });
    // Image input stays: the feed lists it and the Chat Completions route carries it.
    expect(models.get('deepseek-v4.1-flash')?.modalities).toEqual(['text', 'image']);
    // Per model, not a blanket reroute: a model OpenCode documents on Messages stays there.
    expect(models.get('qwen3.8-max')).toMatchObject({
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      baseUrl: 'https://opencode.ai/zen/go',
    });

    const { routes } = buildHttpProxyRoutes(providers, [
      { providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' },
      { providerId: 'opencode-go', modelId: 'qwen3.8-max' },
    ]);
    expect(routes.map(route => [route.realModelId, route.modelFormat, route.npm, route.baseURL])).toEqual([
      ['deepseek-v4.1-flash', 'openai', '@ai-sdk/openai-compatible', 'https://opencode.ai/zen/go/v1'],
      ['qwen3.8-max', 'anthropic', '@ai-sdk/anthropic', 'https://opencode.ai/zen/go'],
    ]);
  });

  it('proxy mode sends it to Go Chat Completions with DeepSeek thinking and replayed reasoning', async () => {
    const captured = stubUpstream([REASONED_TOOL_CALL, { role: 'assistant', content: 'Read it.' }]);
    const { routes } = buildHttpProxyRoutes(materializeExistingInstall(), [
      { providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' },
    ]);
    const route = routes[0]!;
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      await toolRoundTrip(
        body => post(handle.port, '/v1/messages', body, {
          authorization: `Bearer ${handle.token}`,
          'x-claude-code-session-id': SESSION_ID,
        }),
        route.aliasId,
        captured,
      );
    } finally {
      handle.close();
    }
    expectGoChatCompletionsWire(captured);
  });

  it('proxy mode streams from the same endpoint with the same DeepSeek fields', async () => {
    // Claude Code streams nearly every turn; the request differs only in `stream`.
    const captured = stubUpstream([
      { role: 'assistant', reasoning_content: 'Thinking it over.', content: 'Streamed answer.' },
    ]);
    const { routes } = buildHttpProxyRoutes(materializeExistingInstall(), [
      { providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' },
    ]);
    const route = routes[0]!;
    const handle = await startProxyCatalog([route], route.aliasId, false);
    let res: { status: number; body: string };
    try {
      res = await post(handle.port, '/v1/messages', {
        model: route.aliasId,
        max_tokens: 1000,
        stream: true,
        tools: [READ_TOOL],
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: 'hi' }],
      }, { authorization: `Bearer ${handle.token}`, 'x-claude-code-session-id': SESSION_ID });
    } finally {
      handle.close();
    }
    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request!.url).toBe(GO_COMPLETIONS_URL);
    expect(request!.headers.get('authorization')).toBe(`Bearer ${GO_KEY}`);
    expect(request!.headers.get('x-api-key')).toBeNull();
    expect(request!.headers.get('x-opencode-session')).toBe(SESSION_ID);
    expect(request!.body).toMatchObject({
      model: 'deepseek-v4.1-flash',
      stream: true,
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
      max_tokens: 1000,
    });
    expect(res.status, res.body).toBe(200);
    // The reasoning reaches Claude Code as a thinking block, ahead of the text.
    expect(res.body).toContain('"type":"thinking"');
    expect(res.body).toContain('Thinking it over.');
    expect(res.body.indexOf('Thinking it over.')).toBeLessThan(res.body.indexOf('Streamed answer.'));
  });

  it('the API server sends it to Go Chat Completions the same way', async () => {
    const captured = stubUpstream([REASONED_TOOL_CALL, { role: 'assistant', content: 'Read it.' }]);
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'unused-server-key',
      serverPassword: null,
      catalog: createGatewayModelCatalog(localProvidersToServerModels(materializeExistingInstall())),
    });
    try {
      await toolRoundTrip(
        body => post(server.port, '/anthropic/v1/messages', body, { 'x-claude-code-session-id': SESSION_ID }),
        'clodex:opencode-go:deepseek-v4.1-flash',
        captured,
      );
    } finally {
      await server.close();
    }
    expectGoChatCompletionsWire(captured);
  });

  it('sends no effort for low, the level V4 Flash also leaves to the upstream default', async () => {
    const captured = stubUpstream([{ role: 'assistant', content: 'ok' }]);
    const { routes } = buildHttpProxyRoutes(materializeExistingInstall(), [
      { providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' },
    ]);
    const route = routes[0]!;
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await post(handle.port, '/v1/messages', {
        model: route.aliasId,
        max_tokens: 100,
        stream: false,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: 'hi' }],
      }, { authorization: `Bearer ${handle.token}`, 'x-claude-code-session-id': SESSION_ID });
      expect(res.status, res.body).toBe(200);
    } finally {
      handle.close();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(GO_COMPLETIONS_URL);
    expect(captured[0]!.body).not.toHaveProperty('reasoning_effort');
    expect(captured[0]!.body).not.toHaveProperty('thinking');
  });
});
