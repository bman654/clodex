// tests/proxy.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aliasModelId, startProxy, startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { makeRouteResolver, resolveCatalogModelAliases } from '../src/catalog.js';
import { getProxyDebugLogPath } from '../src/trace-log.js';
import { anthropicMessagesEndpoint, estimateAnthropicInputTokens } from '../src/anthropic-endpoints.js';
import type { LocalProvider, ModelAlias } from '../src/types.js';
import { buildOpenCodeGoModels } from '../src/data/opencode-go-models.js';
import { NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE } from '../src/anthropic-beta-policy.js';
import { MAX_EFFORT_RESOLUTION_WARNINGS } from '../src/effort-policy.js';
import { resolveAnthropicAuthMode } from '../src/anthropic-auth-mode.js';

/** POST JSON to a local proxy via node:http (avoids vi.stubGlobal('fetch') interception). */
function postToProxy(
  port: number,
  token: string,
  body: unknown,
  relayRequestId?: string,
  path = '/v1/messages',
  claudeSessionId?: string,
  anthropicBeta?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload),
          ...(relayRequestId ? { 'x-relay-request-id': relayRequestId } : {}),
          ...(claudeSessionId ? { 'x-claude-code-session-id': claudeSessionId } : {}),
          ...(anthropicBeta ? { 'anthropic-beta': anthropicBeta } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('Anthropic endpoint routing', () => {
  it('matches messages and count_tokens exactly, including query strings', () => {
    expect(anthropicMessagesEndpoint('/v1/messages?beta=true')).toBe('messages');
    expect(anthropicMessagesEndpoint('/v1/messages/count_tokens?beta=true')).toBe('count_tokens');
    expect(anthropicMessagesEndpoint('/v1/messages/batches')).toBeNull();
    expect(anthropicMessagesEndpoint('/v1/messages-not-real')).toBeNull();
  });

  it('estimates only input-context fields', () => {
    const base = estimateAnthropicInputTokens({
      model: 'clodex:test:model',
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(base).toBeGreaterThan(0);
    expect(estimateAnthropicInputTokens({
      model: 'a-different-model',
      stream: true,
      max_tokens: 128_000,
      messages: [{ role: 'user', content: 'hello world' }],
    })).toBe(base);
  });

  it('counts images at a flat vision estimate instead of base64 bytes/4', () => {
    const data = 'A'.repeat(400_000);
    const withImage = estimateAnthropicInputTokens({
      messages: [{ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        ] },
      ] }],
    });
    // bytes/4 on the raw payload alone would be ~100k tokens
    expect(withImage).toBeLessThan(5_000);
    expect(withImage).toBeGreaterThanOrEqual(1_600);
  });
});

describe('aliasModelId', () => {
  it('returns claude-* ids unchanged', () => {
    expect(aliasModelId('claude-sonnet-4', 'Anthropic')).toBe('claude-sonnet-4');
  });

  it('prefixes non-claude ids with anthropic-{providerId}__', () => {
    expect(aliasModelId('grok-4.3', 'xai')).toBe('anthropic-xai__grok-4.3');
  });

  it('uses stable provider id slug in alias', () => {
    expect(aliasModelId('deepseek-v4', 'go')).toBe('anthropic-go__deepseek-v4');
  });
});

describe('SDK anonymous route handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not reject empty upstream keys before SDK routing', async () => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-kilo__tencent/hy3:free',
      realModelId: 'tencent/hy3:free',
      displayName: 'Tencent Hy3',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-for-test',
      baseURL: 'https://api.kilo.ai/api/gateway',
      providerId: 'kilo',
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    const res = await postToProxy(handle.port, handle.token, {
      model: route.aliasId,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    handle.close();
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('Missing API key');
  });

  it('forwards anonymous Anthropic routes without authentication headers', async () => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-local__anonymous-model',
      realModelId: 'anonymous-model',
      displayName: 'Anonymous Model',
      upstreamUrl: 'https://anonymous.example',
      apiKey: '',
      authType: 'none',
      modelFormat: 'anthropic',
      providerId: 'local',
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        id: 'msg_anonymous',
        type: 'message',
        role: 'assistant',
        model: route.realModelId,
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('x-api-key')).toBe(false);
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });

  it('forwards single-route anonymous messages and token counts without credential headers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/messages/count_tokens')) {
        return new Response('{"input_tokens":17}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_anonymous',
          type: 'message',
          role: 'assistant',
          model: 'anonymous-model',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxy(
      'https://anonymous.example',
      'anonymous-model',
      false,
      undefined,
      {
        providerId: 'local',
        authType: 'none',
        modelFormat: 'anthropic',
        headers: {
          Authorization: 'Bearer configured-value',
          Cookie: 'session=configured-value',
          'X-Auth-Token': 'configured-value',
          'X-Custom': 'preserved',
        },
      },
      '',
    );

    try {
      const messages = await postToProxy(handle.port, handle.token, {
        model: 'anonymous-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const tokens = await postToProxy(handle.port, handle.token, {
        model: 'anonymous-model',
        messages: [{ role: 'user', content: 'count this' }],
      }, undefined, '/v1/messages/count_tokens');

      expect(messages.status).toBe(200);
      expect(tokens.status).toBe(200);
      expect(JSON.parse(tokens.body)).toEqual({ input_tokens: 17 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      expect(calls.map(([url]) => url)).toEqual([
        'https://anonymous.example/v1/messages',
        'https://anonymous.example/v1/messages/count_tokens',
      ]);
      for (const [, init] of calls) {
        const headers = new Headers(init.headers);
        expect(headers.has('authorization')).toBe(false);
        expect(headers.has('x-api-key')).toBe(false);
        expect(headers.has('cookie')).toBe(false);
        expect(headers.has('x-auth-token')).toBe(false);
        expect(headers.get('x-custom')).toBe('preserved');
      }
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });

  it.each(['custom-anthropic', 'anthropic'])(
    'keeps %s single-route inference x-api-key-only for messages and token counts',
    async templateId => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return new Response(
          url.endsWith('/v1/messages/count_tokens')
            ? '{"input_tokens":17}'
            : JSON.stringify({
                id: 'msg_custom',
                type: 'message',
                role: 'assistant',
                model: 'custom-model',
                content: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const handle = await startProxy(
        'https://custom.example',
        'custom-model',
        false,
        undefined,
        {
          providerId: 'custom-endpoint',
          authType: 'api',
          anthropicAuthMode: resolveAnthropicAuthMode({ templateId }),
          modelFormat: 'anthropic',
        },
        'custom-key',
      );

      try {
        const messages = await postToProxy(handle.port, handle.token, {
          model: 'custom-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        });
        const tokens = await postToProxy(handle.port, handle.token, {
          model: 'custom-model',
          messages: [{ role: 'user', content: 'count this' }],
        }, undefined, '/v1/messages/count_tokens');

        expect(messages.status).toBe(200);
        expect(tokens.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
          const headers = new Headers(init.headers);
          expect(headers.get('x-api-key')).toBe('custom-key');
          expect(headers.has('authorization')).toBe(false);
        }
      } finally {
        handle.close();
        vi.unstubAllGlobals();
      }
    },
  );

  it('answers count_tokens locally when the route declares no upstream support', async () => {
    // Speaking the Messages API does not imply implementing count_tokens.
    // Forwarding it to an upstream without the endpoint answers Claude Code's
    // token accounting with a 404 instead of a number, which is the failure
    // this capability exists to avoid.
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxy(
      'https://anonymous.example',
      'anonymous-model',
      false,
      undefined,
      {
        providerId: 'local',
        authType: 'none',
        modelFormat: 'anthropic',
        compatibility: { supportsCountTokens: false },
      },
      '',
    );

    try {
      const tokens = await postToProxy(handle.port, handle.token, {
        model: 'anonymous-model',
        messages: [{ role: 'user', content: 'count this' }],
      }, undefined, '/v1/messages/count_tokens');

      expect(tokens.status).toBe(200);
      expect(JSON.parse(tokens.body).input_tokens).toBeGreaterThan(0);
      // The point of the capability: upstream is never asked.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });
});

describe('catalog model aliases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects unresolved configured model ids without using the default route', async () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'missing-route', routeId: 'clodex:test:not-a-route' }],
    );

    try {
      for (const testCase of [
        { model: 'clodex:test:unavailable-model', path: '/v1/messages' },
        { model: 'missing-route', path: '/v1/messages' },
        { model: 'missing-route[1m]', path: '/v1/messages' },
        { model: 'missing-route[1M]', path: '/v1/messages' },
        { model: 'models/missing-route[1m]', path: '/v1/messages' },
        { model: 'models/clodex:test:unavailable-model[1M]', path: '/v1/messages' },
        { model: 'missing-route', path: '/v1/messages/count_tokens' },
        { model: 'models/clodex:test:unavailable-model[1M]', path: '/v1/messages/count_tokens' },
      ]) {
        const response = await postToProxy(handle.port, handle.token, {
          model: testCase.model,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }, undefined, testCase.path);

        expect(response.status, `${testCase.path} ${testCase.model}`).toBe(400);
        expect(JSON.parse(response.body)).toEqual({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `Clodex model route '${testCase.model}' is unavailable. Run \`clodex models --list\` to inspect saved routes and aliases.`,
          },
        });
        expect(response.body).not.toContain('clodex patch');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });

  it('rejects unresolved canonical ids when model aliases are not configured', async () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
        const response = await postToProxy(handle.port, handle.token, {
          model: 'clodex:test:unavailable-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }, undefined, path);
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body).error.type).toBe('invalid_request_error');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });

  it('rejects a configured alias whose saved targets conflict instead of using the default route', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'clodex:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const firstRoute: ProxyRoute = {
      ...defaultRoute,
      aliasId: 'clodex:first:model-a',
      realModelId: 'model-a',
      displayName: 'Model A',
      upstreamUrl: 'https://first.example',
      providerId: 'first',
    };
    const secondRoute: ProxyRoute = {
      ...defaultRoute,
      aliasId: 'clodex:second:model-b',
      realModelId: 'model-b',
      displayName: 'Model B',
      upstreamUrl: 'https://second.example',
      providerId: 'second',
    };
    const routeByTarget = new Map([
      ['first:model-a', firstRoute],
      ['second:model-b', secondRoute],
    ]);
    const modelAliases = resolveCatalogModelAliases([
      { name: 'Orbit', providerId: 'first', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'second', modelId: 'model-b' },
    ], (providerId, modelId) => routeByTarget.get(`${providerId}:${modelId}`));
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const handle = await startProxyCatalog(
      [defaultRoute, firstRoute, secondRoute],
      defaultRoute.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      modelAliases,
    );

    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: 'orbit',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(400);
      const message = JSON.parse(response.body).error.message as string;
      expect(message).toContain('orbit');
      expect(message).toMatch(/conflict/i);
      expect(message).not.toContain('clodex patch');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });

  it('routes only the canonical alias and blocks every equivalent saved spelling', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'clodex:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const aliasRoute: ProxyRoute = {
      ...defaultRoute,
      aliasId: 'clodex:test:alias-model',
      realModelId: 'alias-model',
      displayName: 'Alias Model',
      upstreamUrl: 'https://alias.example',
    };
    const modelAliases = resolveCatalogModelAliases([
      { name: 'LuNa', providerId: 'test-provider', modelId: 'alias-model' },
      { name: 'LUNA', providerId: 'test-provider', modelId: 'alias-model' },
    ], (_providerId, modelId) => (
      modelId === 'alias-model' ? aliasRoute : undefined
    ));
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ type: 'message', model: 'alias-model' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const handle = await startProxyCatalog(
      [defaultRoute, aliasRoute],
      defaultRoute.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      modelAliases,
    );

    try {
      const canonical = await postToProxy(handle.port, handle.token, {
        model: 'luna',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      expect(canonical.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      for (const savedName of ['LuNa', 'LUNA']) {
        const blocked = await postToProxy(handle.port, handle.token, {
          model: savedName,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        });
        expect(blocked.status, savedName).toBe(400);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });

  it('routes alias names to their target route without rewriting the requested model id', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'anthropic-test-provider__default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const providers: LocalProvider[] = [{
      id: 'Test-Provider',
      name: 'Test Provider',
      apiKey: 'provider-key',
      models: [{
        id: 'Solver-V1',
        name: 'Solver V1',
        family: 'test',
        brand: 'Other',
        modelFormat: 'anthropic',
        upstreamModelId: 'Solver-V1',
        baseUrl: 'https://upstream-solver.example',
        contextWindow: 1_000_000,
      }],
    }];
    const savedAliases: ModelAlias[] = [{
      name: 'sol',
      providerId: 'Test-Provider',
      modelId: 'Solver-V1',
    }];
    const resolveRoute = makeRouteResolver(providers);
    const aliasTarget = resolveRoute('Test-Provider', 'Solver-V1');
    const modelAliases = resolveCatalogModelAliases(savedAliases, resolveRoute);
    expect(aliasTarget?.aliasId).toBe('anthropic-test-provider__Solver-V1[1m]');
    expect(modelAliases).toEqual([{
      name: 'sol',
      routeId: 'anthropic-test-provider__Solver-V1[1m]',
    }]);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'solver-v1', content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog(
      [defaultRoute, aliasTarget!],
      defaultRoute.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      modelAliases,
    );

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: 'sol',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      // Resolved to the alias target (not the default route's missing SDK → 502)
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain('upstream-solver.example');
      expect(JSON.parse(init.body as string).model).toBe('Solver-V1');

      // GET /v1/models/<alias> resolves too
      const modelLookup = await new Promise<number>((resolve, reject) => {
        http.get(
          { hostname: '127.0.0.1', port: handle.port, path: '/v1/models/sol' },
          res2 => { res2.resume(); resolve(res2.statusCode ?? 0); },
        ).on('error', reject);
      });
      expect(modelLookup).toBe(200);
    } finally {
      handle.close();
    }
  });

  it('ignores aliases whose target route is absent', async () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'ghost', routeId: 'clodex:test:not-a-route' }],
    );

    try {
      const status = await new Promise<number>((resolve, reject) => {
        http.get(
          { hostname: '127.0.0.1', port: handle.port, path: '/v1/models/ghost' },
          res2 => { res2.resume(); resolve(res2.statusCode ?? 0); },
        ).on('error', reject);
      });
      expect(status).toBe(404);
    } finally {
      handle.close();
    }
  });
});

describe('token counting', () => {
  it('applies the beta policy per catalog route for messages and count_tokens', async () => {
    const opencodeMessagesModel = buildOpenCodeGoModels().find(
      model => model.id === 'qwen3.6-plus',
    );
    if (!opencodeMessagesModel) throw new Error('missing qwen3.6-plus fixture');
    if (opencodeMessagesModel.modelFormat !== 'anthropic' || !opencodeMessagesModel.apiUrl) {
      throw new Error('qwen3.6-plus is not a Messages route');
    }
    const opencodeLocalModel: LocalProvider['models'][number] = {
      id: opencodeMessagesModel.id,
      name: opencodeMessagesModel.name,
      family: opencodeMessagesModel.family ?? opencodeMessagesModel.id,
      brand: 'Qwen',
      modelFormat: 'anthropic',
      upstreamModelId: opencodeMessagesModel.upstreamModelId ?? opencodeMessagesModel.id,
      baseUrl: opencodeMessagesModel.apiUrl,
      contextWindow: opencodeMessagesModel.contextWindow,
      reasoning: opencodeMessagesModel.reasoning,
      compatibility: opencodeMessagesModel.compatibility,
    };

    const providers: LocalProvider[] = [
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        apiKey: 'go-key',
        authType: 'api',
        models: [opencodeLocalModel],
      },
      {
        id: 'custom-messages',
        name: 'Custom Messages',
        apiKey: 'custom-key',
        authType: 'api',
        headers: { 'Anthropic-Beta': 'configured-beta-2026-01-01' },
        models: [{
          id: 'custom-native',
          name: 'Custom Native',
          family: 'custom',
          brand: 'Other',
          modelFormat: 'anthropic',
          upstreamModelId: 'custom-native-wire',
          baseUrl: 'https://custom-messages.example',
        }],
      },
      {
        id: 'oauth-messages',
        name: 'OAuth Messages',
        apiKey: 'oauth-token',
        authType: 'oauth',
        models: [{
          id: 'oauth-native',
          name: 'OAuth Native',
          family: 'claude',
          brand: 'Anthropic',
          modelFormat: 'anthropic',
          upstreamModelId: 'claude-sonnet-4-6',
          baseUrl: 'https://api.anthropic.com',
        }],
      },
      {
        id: 'anonymous-messages',
        name: 'Anonymous Messages',
        apiKey: '',
        authType: 'none',
        models: [{
          id: 'anonymous-native',
          name: 'Anonymous Native',
          family: 'custom',
          brand: 'Other',
          modelFormat: 'anthropic',
          upstreamModelId: 'anonymous-native',
          baseUrl: 'https://anonymous-messages.example',
        }],
      },
      {
        id: 'claude-code',
        name: 'Claude Code',
        apiKey: 'native-oauth-token',
        authType: 'oauth',
        models: [{
          id: 'claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          family: 'claude',
          brand: 'Anthropic',
          modelFormat: 'anthropic',
          upstreamModelId: 'claude-sonnet-4-6',
          baseUrl: 'https://api.anthropic.com',
        }],
      },
    ];
    const resolveRoute = makeRouteResolver(providers);
    const opencodeRoute = resolveRoute('opencode-go', opencodeLocalModel.id);
    const countRoute = resolveRoute('custom-messages', 'custom-native');
    const oauthRoute = resolveRoute('oauth-messages', 'oauth-native');
    const anonymousRoute = resolveRoute('anonymous-messages', 'anonymous-native');
    const nativeRoute = resolveRoute('claude-code', 'claude-sonnet-4-6');
    if (!opencodeRoute || !countRoute || !oauthRoute || !anonymousRoute || !nativeRoute) {
      throw new Error('missing catalog route');
    }
    expect(oauthRoute.anthropicBetaProvenance).toBeUndefined();
    expect(nativeRoute.anthropicBetaProvenance).toBe(
      NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE,
    );

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const isCount = String(url).includes('/count_tokens');
      return new Response(JSON.stringify(isCount
        ? { input_tokens: 17 }
        : {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'upstream-model',
            content: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const handle = await startProxyCatalog(
      [opencodeRoute, countRoute, oauthRoute, anonymousRoute, nativeRoute],
      opencodeRoute.aliasId,
      false,
    );

    try {
      for (const [route, path, expectedBeta] of [
        [opencodeRoute, '/v1/messages', null],
        [countRoute, '/v1/messages/count_tokens', 'configured-beta-2026-01-01'],
        [oauthRoute, '/v1/messages/count_tokens', null],
        [anonymousRoute, '/v1/messages/count_tokens', null],
      ] as const) {
        const response = await postToProxy(handle.port, handle.token, {
          model: route.aliasId,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }, undefined, path, undefined, 'client-beta-2026-01-01');

        expect(response.status).toBe(200);
        const [, init] = fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
        expect(new Headers(init.headers).get('anthropic-beta')).toBe(expectedBeta);
      }

      const nativeResponse = await postToProxy(handle.port, handle.token, {
        model: nativeRoute.aliasId,
        messages: [{ role: 'user', content: 'count this upstream' }],
      }, undefined, '/v1/messages/count_tokens', undefined,
      ' client-beta-2026-01-01, other-beta-2026-01-02,client-beta-2026-01-01 ');

      expect(nativeResponse.status).toBe(200);
      const [, nativeInit] = fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
      const nativeHeaders = new Headers(nativeInit.headers);
      expect(nativeHeaders.get('anthropic-beta')).toBe(
        'client-beta-2026-01-01,other-beta-2026-01-02',
      );
      expect(nativeHeaders.get('user-agent')).toContain('claude-cli/');
      expect(nativeHeaders.get('x-app')).toBe('cli');
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });

  it('returns a local estimate for translated OAuth routes before resolving credentials', async () => {
    const refreshToken = vi.fn(async () => {
      throw new Error('credential resolution must not run for local token counts');
    });
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
      authType: 'oauth',
      refreshToken,
    };
    const handle = await startProxyCatalog(
      [route], route.aliasId, false, undefined, undefined, undefined, undefined, 'exact',
    );

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        output_config: { effort: 'turbo' },
        messages: [{ role: 'user', content: 'count this context locally' }],
      }, undefined, '/v1/messages/count_tokens?beta=true');

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ input_tokens: expect.any(Number) });
      expect(JSON.parse(res.body).input_tokens).toBeGreaterThan(0);
      expect(refreshToken).not.toHaveBeenCalled();
    } finally {
      handle.close();
    }
  });

  it('forwards native Anthropic token counts with the real upstream model id', async () => {
    const fetchMock = vi.fn(async () => new Response('{"input_tokens":17}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const route: ProxyRoute = {
      aliasId: 'clodex:anthropic:sonnet',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'anthropic',
    };
    const handle = await startProxyCatalog(
      [route], route.aliasId, false, undefined, undefined, undefined, undefined, 'exact',
    );

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        output_config: { effort: 123 },
        messages: [{ role: 'user', content: 'count upstream' }],
      }, undefined, '/v1/messages/count_tokens');

      expect(res.status).toBe(200);
      expect(res.headers['x-clodex-effort-resolution']).toBeUndefined();
      expect(JSON.parse(res.body)).toEqual({ input_tokens: 17 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages/count_tokens',
        expect.objectContaining({
          body: expect.stringContaining('"model":"claude-sonnet-4-6"'),
        }),
      );
      expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"effort":123');
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });
});

describe('translated request cancellation', () => {
  it('aborts the SDK provider request and records translation cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-cancel-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let upstreamReceivedResolve!: () => void;
    const upstreamReceived = new Promise<void>(resolve => { upstreamReceivedResolve = resolve; });
    let upstreamClosedResolve!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { upstreamClosedResolve = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        upstreamReceivedResolve();
      });
      req.socket.once('close', upstreamClosedResolve);
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const payload = JSON.stringify({
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'cancel this request' }],
        stream: true,
      });
      const request = http.request({
        hostname: '127.0.0.1',
        port: handle.port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${handle.token}`,
          'Content-Length': Buffer.byteLength(payload),
          'x-relay-request-id': 'req-cancel-1',
        },
      });
      request.on('error', () => {});
      request.end(payload);
      await upstreamReceived;
      request.destroy();
      await upstreamClosed;

      await vi.waitFor(() => {
        const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(entries).toContainEqual(expect.objectContaining({
          event: 'translation_cancelled',
          requestId: 'req-cancel-1',
          phase: 'translating',
        }));
      });
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('SDK translated error logging', () => {
  it('returns an HTTP error when request translation throws instead of leaving the client pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-translation-error-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'http://127.0.0.1:1/v1',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: {},
        stream: true,
      }, 'req-translate-error');

      expect(res.status).toBe(502);
      expect(res.body).toContain('error');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-translate-error',
        phase: 'preparing_translation',
        sdkParts: 0,
        translatedBytes: 0,
      }));
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a pre-stream HTTP failure and logs the AI SDK response body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-error-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const previousRequestPreview = process.env['CLODEX_LOG_REQUEST_PREVIEW'];
    process.env['CLODEX_LOG_REQUEST_PREVIEW'] = '1';
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ error: { message: 'translated request rejected', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }, 'req-error-1');

      expect(res.status).toBe(400);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(res.body).toContain('translated request rejected');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const errorEntry = entries.find(entry => entry.event === 'upstream_error');
      expect(errorEntry).toMatchObject({
        event: 'upstream_error',
        requestId: 'req-error-1',
        modelId: route.aliasId,
        provider: 'test-provider',
        route: 'translated',
        statusCode: 400,
        isRetryable: false,
        attemptCount: 1,
      });
      expect(errorEntry.errorContent).toContain('translated request rejected');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-error-1',
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_started',
        requestId: 'req-error-1',
        lastPartType: 'start',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-error-1',
        lastPartType: 'error',
      }));
    } finally {
      if (previousRequestPreview === undefined) delete process.env['CLODEX_LOG_REQUEST_PREVIEW'];
      else process.env['CLODEX_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('returns HTTP 429 with a clamped retry-after header after upstream rate limiting', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(429, {
        'Content-Type': 'application/json',
        // retry-after-ms drives the AI SDK's internal backoff (1ms keeps the
        // SDK's own retries fast); retry-after is what clodex forwards to the
        // client, and 3600 must come out clamped to 60.
        'retry-after-ms': '1',
        'retry-after': '3600',
        'Connection': 'close',
      });
      res.end(JSON.stringify({ error: { message: 'rate limited, slow down', type: 'rate_limit_error' } }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:rate-limited-model',
      realModelId: 'rate-limited-model',
      displayName: 'Rate Limited Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('60');
      expect(res.body).toContain('rate limited');
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 20_000);

  it('records the bounded WebSocket transport code in the translation lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-transport-error-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Connection': 'close',
      });
      res.end(JSON.stringify({
        error: {
          type: 'transport_error',
          code: 'websocket_transport_error',
          message: 'transport unavailable',
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'gpt-5.6-test',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'test transport failure' }],
        stream: true,
      }, 'req-transport-error');

      expect(res.status).toBe(400);
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-transport-error',
        errorCode: 'websocket_transport_error',
      }));
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('translates an OpenAI context overflow into an Anthropic prompt-too-long error', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        error: {
          message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:small-context',
      realModelId: 'small-context',
      displayName: 'Small Context Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
      contextWindow: 10,
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'This prompt is too long.' }],
        stream: true,
      }, 'req-context-overflow');

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body) as {
        type: string;
        error: { type: string; message: string };
        request_id: string;
      };
      expect(body).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' },
        request_id: 'req-context-overflow',
      });
      expect(body.error.message).toMatch(/^prompt is too long: \d+ tokens > 10 maximum$/);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 20_000);

  it('logs SDK input and translated output through successful stream completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-success-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
      res.end([
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const requestBody = {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      };
      const countResponse = await postToProxy(
        handle.port,
        handle.token,
        requestBody,
        undefined,
        '/v1/messages/count_tokens',
      );
      const expectedInputTokens = JSON.parse(countResponse.body).input_tokens;
      const claudeSessionId = '00000000-0000-4000-8000-000000000003';
      const res = await postToProxy(
        handle.port,
        handle.token,
        requestBody,
        'req-success-1',
        '/v1/messages',
        claudeSessionId,
      );

      expect(res.status).toBe(200);
      expect(res.body).toContain('event: message_stop');
      const messageStartBlock = res.body
        .split('\n\n')
        .find(block => block.startsWith('event: message_start'))!;
      const messageStart = JSON.parse(messageStartBlock.split('\n')[1]!.replace('data: ', ''));
      expect(messageStart.message.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      const messageDeltaBlock = res.body
        .split('\n\n')
        .find(block => block.startsWith('event: message_delta'))!;
      const messageDelta = JSON.parse(messageDeltaBlock.split('\n')[1]!.replace('data: ', ''));
      expect(messageDelta.usage).toEqual({
        input_tokens: expectedInputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-success-1',
        claudeSessionId,
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_started',
        requestId: 'req-success-1',
        claudeSessionId,
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_completed',
        requestId: 'req-success-1',
        claudeSessionId,
        lastPartType: 'finish',
      }));
      const completed = entries.find(entry => entry.event === 'translation_completed');
      expect(completed.sdkParts).toBeGreaterThan(0);
      expect(completed.translatedBytes).toBeGreaterThan(0);
      expect(completed.translatedChunks).toBeGreaterThan(0);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('emits keepalive pings while a tool-call argument is buffered with no downstream output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-keepalive-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    // A tool call whose arguments stream as many small deltas over ~800ms. The
    // adapter buffers every tool-input-delta and only flushes input_json_delta at
    // completion, so nothing is written downstream during that window — the exact
    // shape that tripped Claude Code's ~180s read-idle abort in production.
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'c', object: 'chat.completion.chunk', created: 1, model: 'translated-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(chunk(
          { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'myTool', arguments: '{"v":"' } }] },
          null,
        ));
        let emitted = 0;
        const argTimer = setInterval(() => {
          emitted += 1;
          if (emitted <= 32) {
            res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: 'a' } }] }, null));
            return;
          }
          clearInterval(argTimer);
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, null));
          res.write(chunk({}, 'tool_calls'));
          res.write('data: [DONE]\n\n');
          res.end();
        }, 25);
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const prevKeepAlive = process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS;
    process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS = '100';
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'call a tool with a big argument' }],
        stream: true,
      }, 'req-keepalive-1');

      expect(res.status).toBe(200);
      // At least one ping must have been injected during the buffering window.
      const pingCount = res.body.split('event: ping').length - 1;
      expect(pingCount).toBeGreaterThanOrEqual(1);
      // The real tool input must still flush intact once the call completes, and
      // pings must not corrupt the surrounding SSE framing.
      expect(res.body).toContain('input_json_delta');
      expect(res.body).toContain('event: message_stop');
      // Pings are written to the wire but deliberately bypass onOutput, so they
      // are NOT counted in translation accounting: every real SSE frame carries
      // one `event:` line, and the surplus over translatedChunks is exactly the
      // pings — keeping diagnostic outputIdleMs honest about real buffering.
      const totalEventFrames = res.body.split('event: ').length - 1;
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const completed = entries.find(entry => entry.event === 'translation_completed');
      expect(completed?.lastPartType).toBe('finish');
      expect(totalEventFrames - completed.translatedChunks).toBe(pingCount);
    } finally {
      if (prevKeepAlive === undefined) delete process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS;
      else process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS = prevKeepAlive;
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('logs dispatch and completion for a non-streaming translated request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-nonstream-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        id: 'chatcmpl-nonstream',
        object: 'chat.completion',
        created: 1,
        model: 'translated-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }, 'req-nonstream-1');

      expect(res.status).toBe(200);
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-nonstream-1',
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_completed',
        requestId: 'req-nonstream-1',
        phase: 'waiting_for_sdk',
      }));
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('anthropic passthrough debug logging', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('logs upstream non-OK status and body', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      anthropicBetaProvenance: NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE,
      providerData: {},
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limit exceeded' } }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, true);
    const res = await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    handle.close();
    expect(res.status).toBe(429);
    const log = readFileSync(getProxyDebugLogPath(), 'utf8');
    expect(log).toContain('anthropic upstream 429');
    expect(log).toContain('rate limit exceeded');
  });

  it('forwards matching Claude Code OAuth session id in body metadata and header', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      anthropicBetaProvenance: NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE,
      providerData: {
        cliUserID: 'a'.repeat(64),
        accountUUID: '11111111-1111-4111-8111-111111111111',
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limit exceeded' } }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, true);
    await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    handle.close();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as { metadata?: { user_id?: string } };
    const userId = JSON.parse(body.metadata!.user_id!) as { session_id: string };
    expect(headers['X-Claude-Code-Session-Id']).toBe(userId.session_id);
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['User-Agent']).toContain('claude-cli/');
    expect(headers['x-app']).toBe('cli');
  });

  it('prepends Claude Code OAuth billing line to upstream system prompt', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      anthropicBetaProvenance: NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE,
      providerData: {
        cliUserID: 'a'.repeat(64),
        accountUUID: '11111111-1111-4111-8111-111111111111',
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ type: 'message', content: [] }),
      text: async () => JSON.stringify({ type: 'message', content: [] }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, false);
    await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    handle.close();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { system?: Array<{ type: string; text: string }> };
    expect(body.system?.[0]?.text).toBe('x-anthropic-billing-header: cc_version=2.1.195.0; cc_entrypoint=cli;');
    expect(body.system?.[1]?.text).toBe('You are helpful.');
  });
});

describe('global unsupported effort policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects exact policy before OAuth resolution or upstream dispatch', async () => {
    const refreshToken = vi.fn(async () => 'secret-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const route: ProxyRoute = {
      aliasId: 'anthropic-opencode-go__qwen3.6-plus',
      realModelId: 'qwen3.6-plus',
      displayName: 'Qwen 3.6 Plus',
      upstreamUrl: 'https://opencode.example',
      apiKey: 'stale-token',
      authType: 'oauth',
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      providerId: 'opencode-go',
      compatibility: { anthropicThinkingBudgetMap: { high: 16_000, max: 31_999 } },
      refreshToken,
    };
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      'exact',
    );
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { type: 'invalid_request_error', message: expect.stringContaining('unsupported') },
      });
      expect(refreshToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      handle.close();
    }
  });

  it.each([
    ['claude-opus-4-6', 'max'],
    ['claude-opus-4-5', 'medium'],
  ] as const)('accepts native %s effort %s exactly and relays it unchanged', async (modelId, effort) => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(
      JSON.stringify({ id: 'msg_effort', type: 'message', model: modelId, content: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const route: ProxyRoute = {
      aliasId: modelId,
      realModelId: modelId,
      displayName: modelId,
      upstreamUrl: 'https://api.anthropic.example',
      apiKey: 'provider-key',
      authType: 'api',
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      providerId: 'anthropic',
    };
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      'exact',
    );

    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        output_config: { effort },
        messages: [{ role: 'user', content: 'use assigned effort' }],
      });
      expect(response.status).toBe(200);
      expect(response.headers['x-clodex-effort-resolution']).toBeUndefined();
      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: modelId,
        output_config: { effort },
      });
    } finally {
      handle.close();
    }
  });

  it('applies every global policy to a Luna alias targeting DeepSeek on the real SDK wire', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        id: 'chatcmpl-effort',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:opencode-go:deepseek-v4-flash',
      realModelId: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      upstreamUrl: '',
      apiKey: 'provider-key',
      authType: 'api',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'opencode-go',
      compatibility: { reasoningEffortMap: { high: 'high', max: 'max' } },
    };

    try {
      for (const testCase of [
        { policy: 'up' as const, status: 200, resolved: 'max', wire: 'max' },
        { policy: 'down' as const, status: 200, resolved: 'high', wire: 'high' },
        { policy: 'provider-default' as const, status: 200, resolved: 'provider-default', wire: undefined },
        { policy: 'exact' as const, status: 400, resolved: undefined, wire: undefined },
      ]) {
        upstreamBodies.length = 0;
        const handle = await startProxyCatalog(
          [route],
          route.aliasId,
          false,
          undefined,
          undefined,
          undefined,
          [{ name: 'luna', routeId: route.aliasId }],
          testCase.policy,
        );
        try {
          const response = await postToProxy(handle.port, handle.token, {
            model: 'luna',
            output_config: { effort: 'xhigh' },
            messages: [{ role: 'user', content: 'exercise the aliased SDK route' }],
          });
          expect(response.status).toBe(testCase.status);
          if (testCase.resolved) {
            expect(response.headers['x-clodex-effort-resolution']).toContain(
              `resolved=${testCase.resolved}`,
            );
          } else {
            expect(response.headers['x-clodex-effort-resolution']).toBeUndefined();
          }
          if (testCase.status === 400) {
            expect(upstreamBodies).toHaveLength(0);
          } else {
            expect(upstreamBodies).toHaveLength(1);
            expect(upstreamBodies[0]!.model).toBe('deepseek-v4-flash');
            expect(upstreamBodies[0]!.reasoning_effort).toBe(testCase.wire);
          }
        } finally {
          handle.close();
        }
      }
      expect(stderr).toHaveBeenCalledTimes(3);
    } finally {
      stderr.mockRestore();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 20_000);

  it.each([' high ', '', '   ', 123, null])(
    'rejects non-canonical effort %j before OAuth resolution or upstream dispatch',
    async invalidEffort => {
      const refreshToken = vi.fn(async () => 'secret-token');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const route: ProxyRoute = {
        aliasId: 'anthropic-opencode-go__qwen3.6-plus',
        realModelId: 'qwen3.6-plus',
        displayName: 'Qwen 3.6 Plus',
        upstreamUrl: 'https://must-not-fetch.example',
        apiKey: 'stale-token',
        authType: 'oauth',
        modelFormat: 'anthropic',
        npm: '@ai-sdk/anthropic',
        providerId: 'opencode-go',
        compatibility: { anthropicThinkingBudgetMap: { high: 16_000, max: 31_999 } },
        refreshToken,
      };
      const handle = await startProxyCatalog([route], route.aliasId, false);
      try {
        const response = await postToProxy(handle.port, handle.token, {
          model: route.aliasId,
          output_config: { effort: invalidEffort },
          messages: [{ role: 'user', content: 'do not dispatch' }],
        });
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toMatchObject({
          error: { type: 'invalid_request_error', message: expect.stringContaining('effort') },
        });
        expect(refreshToken).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        handle.close();
      }
    },
  );

  it('rounds an alias request upward and converts the Qwen effort to its exact budget', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'qwen3.6-plus',
        output_config: { format: { type: 'json_schema' } },
        thinking: { type: 'enabled', budget_tokens: 31_999 },
      });
      return new Response(JSON.stringify({
        id: 'msg_qwen',
        type: 'message',
        role: 'assistant',
        model: 'qwen3.6-plus',
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const route: ProxyRoute = {
      aliasId: 'anthropic-opencode-go__qwen3.6-plus',
      realModelId: 'qwen3.6-plus',
      displayName: 'Qwen 3.6 Plus',
      upstreamUrl: 'https://opencode.example',
      apiKey: '',
      authType: 'none',
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      providerId: 'opencode-go',
      compatibility: { anthropicThinkingBudgetMap: { high: 16_000, max: 31_999 } },
    };
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'luna-xhigh', routeId: route.aliasId }],
      'up',
    );
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: 'luna-xhigh',
        output_config: { effort: 'xhigh', format: { type: 'json_schema' } },
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(200);
      expect(response.headers['x-clodex-effort-resolution']).toContain('resolved=max');
      expect(response.headers['x-clodex-effort-resolution']).toContain('target=qwen3.6-plus');
      const repeated = await postToProxy(handle.port, handle.token, {
        model: 'luna-xhigh',
        output_config: { effort: 'xhigh', format: { type: 'json_schema' } },
        messages: [{ role: 'user', content: 'same decision again' }],
      });
      expect(repeated.status).toBe(200);
      expect(repeated.headers['x-clodex-effort-resolution']).toContain('resolved=max');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
    }
  });

  it('bounds unique effort warnings while retaining a diagnostic response header', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_qwen', type: 'message', role: 'assistant', model: 'qwen',
      content: [], usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const routes: ProxyRoute[] = Array.from(
      { length: MAX_EFFORT_RESOLUTION_WARNINGS + 1 },
      (_, index) => ({
        aliasId: `anthropic-opencode-go__qwen-${index}`,
        realModelId: `qwen-${index}`,
        displayName: `Qwen ${index}`,
        upstreamUrl: 'https://opencode.example',
        apiKey: '',
        authType: 'none',
        modelFormat: 'anthropic',
        npm: '@ai-sdk/anthropic',
        providerId: 'opencode-go',
        compatibility: { anthropicThinkingBudgetMap: { high: 16_000, max: 31_999 } },
      }),
    );
    const handle = await startProxyCatalog(routes, routes[0]!.aliasId, false, undefined,
      undefined, undefined, undefined, 'up');
    try {
      let finalHeader: string | string[] | undefined;
      for (const route of routes) {
        const response = await postToProxy(handle.port, handle.token, {
          model: route.aliasId,
          output_config: { effort: 'xhigh' },
          messages: [{ role: 'user', content: 'bounded warning' }],
        });
        expect(response.status).toBe(200);
        finalHeader = response.headers['x-clodex-effort-resolution'];
      }
      expect(stderr).toHaveBeenCalledTimes(MAX_EFFORT_RESOLUTION_WARNINGS);
      expect(finalHeader).toContain(`target=qwen-${MAX_EFFORT_RESOLUTION_WARNINGS}`);
      expect(fetchMock).toHaveBeenCalledTimes(routes.length);
    } finally {
      handle.close();
    }
  });

  it('omits an unsupported request under provider-default without replacing independent thinking', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'qwen3.6-plus',
        thinking: { type: 'enabled', budget_tokens: 4_096 },
      });
      expect(JSON.parse(String(init?.body)).output_config).toBeUndefined();
      return new Response(JSON.stringify({
        id: 'msg_qwen_default', type: 'message', role: 'assistant',
        model: 'qwen3.6-plus', content: [], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const route: ProxyRoute = {
      aliasId: 'anthropic-opencode-go__qwen3.6-plus', realModelId: 'qwen3.6-plus',
      displayName: 'Qwen 3.6 Plus', upstreamUrl: 'https://opencode.example', apiKey: '',
      authType: 'none', modelFormat: 'anthropic', npm: '@ai-sdk/anthropic',
      compatibility: { anthropicThinkingBudgetMap: { high: 16_000, max: 31_999 } },
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        output_config: { effort: 'medium' },
        thinking: { type: 'enabled', budget_tokens: 4_096 },
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(200);
      expect(response.headers['x-clodex-effort-resolution']).toContain('resolved=provider-default');
    } finally {
      handle.close();
    }
  });
});

describe('OAuth route credential resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('resolves the current token before dispatch and updates the route cache', async () => {
    const refreshToken = vi.fn(async () => 'fresh-oauth-token');
    const route: ProxyRoute = {
      aliasId: 'claude-oauth-route',
      realModelId: 'claude-oauth-route',
      displayName: 'OAuth Route',
      upstreamUrl: 'https://api.example.test',
      apiKey: 'stale-oauth-token',
      modelFormat: 'anthropic',
      providerId: 'oauth-provider',
      authType: 'oauth',
      providerData: {},
      refreshToken,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ type: 'message', content: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }, undefined, '/v1/messages', undefined, 'client-beta-2026-01-01');

      expect(response.status).toBe(200);
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(route.apiKey).toBe('fresh-oauth-token');
      const [, init] = vi.mocked(fetch).mock.calls[0]!;
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer fresh-oauth-token',
      );
      expect(new Headers(init?.headers).get('anthropic-beta')).toBeNull();
      expect(new Headers(init?.headers).get('user-agent')).toBeNull();
      expect(new Headers(init?.headers).get('x-app')).toBeNull();
      expect(new Headers(init?.headers).get('x-claude-code-session-id')).toBeNull();
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('metadata');
    } finally {
      handle.close();
    }
  });

  it('rebuilds the translated SDK route and retries once after an OAuth 401', async () => {
    const refreshToken = vi.fn(async (rejectedAccessToken?: string) =>
      rejectedAccessToken === undefined
        ? 'rejected-oauth-token'
        : 'fresh-oauth-token',
    );
    const route: ProxyRoute = {
      aliasId: 'anthropic-oauth-provider__gpt-3-5-turbo-instruct',
      realModelId: 'gpt-3.5-turbo-instruct',
      displayName: 'OAuth Retry Route',
      upstreamUrl: '',
      apiKey: 'launch-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'oauth-provider',
      authType: 'oauth',
      refreshToken,
    };
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('authorization');
        if (authorization === 'Bearer rejected-oauth-token') {
        return new Response(
            JSON.stringify({ error: { message: 'expired token' } }),
            {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
          return new Response(
          [
            'data: {"id":"chatcmpl-retry","object":"chat.completion.chunk","created":1,"model":"gpt-3.5-turbo-instruct","choices":[{"index":0,"delta":{"role":"assistant","content":"recovered"},"finish_reason":null}]}',
            'data: {"id":"chatcmpl-retry","object":"chat.completion.chunk","created":1,"model":"gpt-3.5-turbo-instruct","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('recovered');
      expect(refreshToken).toHaveBeenNthCalledWith(1);
      expect(refreshToken).toHaveBeenNthCalledWith(2, 'rejected-oauth-token');
      expect(route.apiKey).toBe('fresh-oauth-token');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.map(([, init]) =>
          new Headers(init?.headers).get('authorization'),
        ),
      ).toEqual(['Bearer rejected-oauth-token', 'Bearer fresh-oauth-token']);
    } finally {
      handle.close();
    }
  });

  it('surfaces a second translated OAuth 401 without another retry', async () => {
    const refreshToken = vi.fn(async (rejectedAccessToken?: string) =>
      rejectedAccessToken === undefined
        ? 'rejected-oauth-token'
        : 'fresh-oauth-token',
    );
    const route: ProxyRoute = {
      aliasId: 'anthropic-oauth-provider__gpt-3-5-turbo-second-401',
      realModelId: 'gpt-3.5-turbo-instruct',
      displayName: 'OAuth Second 401 Route',
      upstreamUrl: '',
      apiKey: 'launch-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'oauth-provider',
      authType: 'oauth',
      refreshToken,
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'expired token' } }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(refreshToken).toHaveBeenCalledTimes(2);
      expect(route.apiKey).toBe('fresh-oauth-token');
    } finally {
      handle.close();
    }
  });

  it('refuses to retry a translated OAuth 401 with an unchanged token', async () => {
    const refreshToken = vi.fn(async (rejectedAccessToken?: string) =>
      rejectedAccessToken ?? 'rejected-oauth-token',
    );
    const route: ProxyRoute = {
      aliasId: 'anthropic-oauth-provider__gpt-3-5-turbo-unchanged',
      realModelId: 'gpt-3.5-turbo-instruct',
      displayName: 'OAuth Unchanged Token Route',
      upstreamUrl: '',
      apiKey: 'launch-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'oauth-provider',
      authType: 'oauth',
      refreshToken,
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'expired token' } }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(refreshToken).toHaveBeenCalledTimes(2);
      expect(route.apiKey).toBe('rejected-oauth-token');
    } finally {
      handle.close();
    }
  });
});
