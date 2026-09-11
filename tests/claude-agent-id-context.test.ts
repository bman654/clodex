import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createLanguageModel } from '../src/provider-factory.js';
import { extractClaudeAgentIds, generateAnthropicResponse } from '../src/sdk-adapter.js';
import {
  responsesWebSocketDiagnosticContextForTests,
  type ResponsesWebSocketDiagnosticContext,
} from '../src/oauth/responses-websocket.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';

// The SDK call runs inside the request's AsyncLocalStorage context, so a mocked
// adapter can read exactly what proxy.ts / router.ts plumbed for the WebSocket
// fetch — the same store the partition key is computed from.
const seenContexts: Array<ResponsesWebSocketDiagnosticContext | undefined> = [];

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return { ...actual, createLanguageModel: vi.fn().mockResolvedValue({}) };
});

vi.mock('../src/sdk-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  const ws = await import('../src/oauth/responses-websocket.js');
  return {
    ...actual,
    generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => {
      seenContexts.push(ws.responsesWebSocketDiagnosticContextForTests());
      return {
        id: 'msg-sdk',
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [{ type: 'text', text: 'sdk ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }),
  };
});

const SESSION_ID = '927b8642-15d2-4535-ab27-1430ae54c4aa';
const AGENT_ID = 'agent-a1b2c3d4e5f60718';
const PARENT_ID = 'agent-main';

function post(port: number, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path, method: 'POST',
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

describe('extractClaudeAgentIds', () => {
  it('reads both headers, first value only, and rejects shapes that are not an agent id', () => {
    expect(extractClaudeAgentIds({ 'x-claude-code-agent-id': AGENT_ID, 'x-claude-code-parent-agent-id': PARENT_ID }))
      .toEqual({ claudeAgentId: AGENT_ID, claudeParentAgentId: PARENT_ID });
    expect(extractClaudeAgentIds({ 'x-claude-code-agent-id': [AGENT_ID, 'agent-other'] }))
      .toEqual({ claudeAgentId: AGENT_ID, claudeParentAgentId: undefined });
    expect(extractClaudeAgentIds({})).toEqual({ claudeAgentId: undefined, claudeParentAgentId: undefined });
    expect(extractClaudeAgentIds({ 'x-claude-code-agent-id': '' })).toEqual({ claudeAgentId: undefined, claudeParentAgentId: undefined });
    expect(extractClaudeAgentIds({ 'x-claude-code-agent-id': 'has space' }).claudeAgentId).toBeUndefined();
    expect(extractClaudeAgentIds({ 'x-claude-code-agent-id': 'a\x1fb' }).claudeAgentId).toBeUndefined();
    expect(extractClaudeAgentIds({ 'x-claude-code-agent-id': 'x'.repeat(129) }).claudeAgentId).toBeUndefined();
  });
});

describe('Claude agent id reaches the WebSocket request context', () => {
  afterEach(() => {
    seenContexts.length = 0;
    vi.mocked(createLanguageModel).mockClear();
    vi.mocked(generateAnthropicResponse).mockClear();
  });

  const route: ProxyRoute = {
    aliasId: 'clodex:openai-oauth:gpt-5.6-luna',
    realModelId: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    upstreamUrl: '',
    apiKey: 'token',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai',
    providerId: 'openai-oauth',
    authType: 'oauth',
  };

  it('from the proxy relay, for a subagent request', async () => {
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await post(handle.port, '/v1/messages', { model: route.aliasId, ...messagesBody }, {
        authorization: `Bearer ${handle.token}`,
        'x-claude-code-session-id': SESSION_ID,
        'x-claude-code-agent-id': AGENT_ID,
        'x-claude-code-parent-agent-id': PARENT_ID,
      });
      expect(res.status, res.body).toBe(200);
      expect(seenContexts).toEqual([expect.objectContaining({
        claudeSessionId: SESSION_ID,
        claudeAgentId: AGENT_ID,
        claudeParentAgentId: PARENT_ID,
      })]);
    } finally {
      handle.close();
    }
  });

  it('from the proxy relay, absent for the main agent', async () => {
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await post(handle.port, '/v1/messages', { model: route.aliasId, ...messagesBody }, {
        authorization: `Bearer ${handle.token}`,
        'x-claude-code-session-id': SESSION_ID,
      });
      expect(res.status, res.body).toBe(200);
      expect(seenContexts).toHaveLength(1);
      expect(seenContexts[0]).toMatchObject({ claudeSessionId: SESSION_ID });
      expect(seenContexts[0]?.claudeAgentId).toBeUndefined();
      expect(seenContexts[0]?.claudeParentAgentId).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  it('from the API server, for a subagent request', async () => {
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'token',
      serverPassword: null,
      catalog: createGatewayModelCatalog([{
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openai-oauth',
        sourceBackend: 'openai-oauth',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        authType: 'oauth',
      }]),
    });
    try {
      const res = await post(Number(new URL(server.url).port), '/anthropic/v1/messages', {
        model: 'gpt-5.6-luna', ...messagesBody,
      }, {
        'x-claude-code-session-id': SESSION_ID,
        'x-claude-code-agent-id': AGENT_ID,
        'x-claude-code-parent-agent-id': PARENT_ID,
      });
      expect(res.status, res.body).toBe(200);
      expect(seenContexts).toEqual([expect.objectContaining({
        claudeSessionId: SESSION_ID,
        claudeAgentId: AGENT_ID,
        claudeParentAgentId: PARENT_ID,
      })]);
    } finally {
      await server.close();
    }
  });
});
