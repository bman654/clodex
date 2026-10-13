import { afterEach, describe, expect, it, vi } from 'vitest';
import * as p from '@clack/prompts';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { startProxyCatalog } from '../src/proxy.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import {
  buildConfiguredHttpProxyOptions,
  formatHttpProxyModelLines,
  reportSkippedHttpProxyFavorites,
} from '../src/http-proxy/index.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { makeRouteResolver, resolveCatalogModelAliases } from '../src/catalog.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import { normalizeModelAliases } from '../src/model-aliases.js';
import type { LocalProvider } from '../src/types.js';

// Model construction and generation are the seams: each request's language
// model records the spec it was built from, so a test can see which program the
// model that served THAT request carries — including one the gateway cached.
vi.mock('../src/provider-factory.js', async original => ({
  ...await original<typeof import('../src/provider-factory.js')>(),
  createLanguageModel: vi.fn(async (spec: unknown) => ({ spec })),
}));
vi.mock('../src/sdk-adapter.js', async original => ({
  ...await original<typeof import('../src/sdk-adapter.js')>(),
  generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, model: string) => ({
    id: 'msg_test', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  })),
}));

const provider: LocalProvider = {
  id: 'openai-oauth',
  name: 'OpenAI (ChatGPT)',
  apiKey: 'tok',
  authType: 'oauth',
  models: [
    {
      id: 'gpt-6-luna', upstreamModelId: 'gpt-6-luna', name: 'GPT-6 Luna', family: 'gpt', brand: 'OpenAI',
      modelFormat: 'openai', npm: '@ai-sdk/openai', contextWindow: 272_000,
      cyberAccessPrograms: ['standard', 'daybreak_blue'],
    },
    {
      id: 'gpt-6.1-sol', upstreamModelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', family: 'gpt', brand: 'OpenAI',
      modelFormat: 'openai', npm: '@ai-sdk/openai', contextWindow: 272_000,
      cyberAccessPrograms: ['standard'],
    },
  ],
};
const favorites = provider.models.map(model => ({ providerId: provider.id, modelId: model.id }));
// Exactly as `clodex models --alias … [--daybreak]` stores them in config.json.
const storedAliases = [
  { name: 'blue', providerId: 'openai-oauth', modelId: 'gpt-6-luna', daybreak: true },
  { name: 'plain', providerId: 'openai-oauth', modelId: 'gpt-6-luna' },
  { name: 'sol-blue', providerId: 'openai-oauth', modelId: 'gpt-6.1-sol', daybreak: true },
];
const BLUE = { cyber: 'daybreak_blue' };
const SOL_REFUSAL = "Daybreak isn't available for gpt-6.1-sol on this ChatGPT account";

/** The program carried by the model that served the latest request. */
function servedProgram(): unknown {
  const model = vi.mocked(generateAnthropicResponse).mock.calls.at(-1)![0] as unknown as {
    spec: { accessPrograms?: unknown };
  };
  return model.spec.accessPrograms;
}

function post(port: number, path: string, token: string, model: string) {
  return new Promise<{ status: number; body: { model?: string; error?: { message?: string } } }>((resolve, reject) => {
    const body = JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${token}`,
        'x-api-key': token,
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A request through the real CONNECT + TLS MITM, as Claude Code sends it in proxy mode. */
async function mitmPost(port: number, model: string): Promise<{ status: number; body: string }> {
  const socket = net.connect(port, '127.0.0.1');
  socket.setTimeout(5000, () => socket.destroy(new Error(`MITM request timed out for ${model}`)));
  await once(socket, 'connect');
  socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
  let head = Buffer.alloc(0);
  while (!head.includes(Buffer.from('\r\n\r\n'))) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    head = Buffer.concat([head, chunk]);
  }
  expect(head.toString()).toContain('200 Connection Established');
  const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca: ensureHttpProxyCertificates().caCert });
  await once(secure, 'secureConnect');
  let text = '';
  secure.on('data', chunk => {
    text += chunk;
    const split = text.indexOf('\r\n\r\n');
    if (split < 0) return;
    const length = /content-length: (\d+)/i.exec(text.slice(0, split));
    const complete = length
      ? Buffer.byteLength(text.slice(split + 4)) >= Number(length[1])
      : text.endsWith('\r\n0\r\n\r\n');
    if (complete) secure.destroy();
  });
  const body = JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'hi' }] });
  secure.write(
    'POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  await once(secure, 'close');
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]), body: text.slice(text.indexOf('\r\n\r\n') + 4) };
}

afterEach(() => vi.clearAllMocks());

describe('Daybreak aliases in proxy mode', () => {
  it('send the program only through the opted-in alias, and refuse an ineligible one with the reason', async () => {
    const loaded = { ...buildHttpProxyRoutes([provider], favorites, storedAliases), favoriteCount: favorites.length };
    const proxy = await startHttpProxy(buildConfiguredHttpProxyOptions(loaded, 0));
    try {
      expect((await mitmPost(proxy.port, 'blue')).status).toBe(200);
      expect(servedProgram()).toEqual(BLUE);
      expect((await mitmPost(proxy.port, 'plain')).status).toBe(200);
      expect(servedProgram()).toBeUndefined();
      expect((await mitmPost(proxy.port, 'clodex:openai-oauth:gpt-6-luna')).status).toBe(200);
      expect(servedProgram()).toBeUndefined();

      const refused = await mitmPost(proxy.port, 'sol-blue');
      expect(refused.status).toBe(400);
      expect(refused.body).toContain(SOL_REFUSAL);
      expect(vi.mocked(generateAnthropicResponse)).toHaveBeenCalledTimes(3);
    } finally {
      await proxy.close();
    }
  });
});

describe('clodex models --list', () => {
  it('shows which aliases send Daybreak and which are refused', () => {
    const { routes, aliases } = buildHttpProxyRoutes([provider], favorites, storedAliases);
    const lines = formatHttpProxyModelLines(routes, aliases).map(stripVTControlCharacters);
    expect(lines.find(line => line.startsWith('  blue '))).toContain('· Daybreak Blue →');
    expect(lines.find(line => line.startsWith('  plain '))).not.toContain('Daybreak');
    expect(lines.find(line => line.startsWith('  sol-blue '))).toContain(`(inactive: ${SOL_REFUSAL})`);
  });

  it('warns about an alias it will refuse', () => {
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    try {
      reportSkippedHttpProxyFavorites({
        ...buildHttpProxyRoutes([provider], favorites, storedAliases),
        favoriteCount: favorites.length,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"sol-blue" — ${SOL_REFUSAL}`));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Daybreak aliases in the endpoint switch menu', () => {
  it('send the program only through the opted-in alias, and refuse an ineligible one with the reason', async () => {
    const resolve = makeRouteResolver([provider]);
    const routes = provider.models.map(model => resolve(provider.id, model.id)!);
    const handle = await startProxyCatalog(
      routes, routes[0]!.aliasId, false, undefined, undefined, undefined,
      resolveCatalogModelAliases(storedAliases, resolve, routes),
    );
    try {
      expect((await post(handle.port, '/v1/messages', handle.token, 'blue')).status).toBe(200);
      expect(servedProgram()).toEqual(BLUE);
      expect((await post(handle.port, '/v1/messages', handle.token, 'plain')).status).toBe(200);
      expect(servedProgram()).toBeUndefined();
      expect((await post(handle.port, '/v1/messages', handle.token, routes[0]!.aliasId)).status).toBe(200);
      expect(servedProgram()).toBeUndefined();

      const refused = await post(handle.port, '/v1/messages', handle.token, 'sol-blue');
      expect(refused.status).toBe(400);
      expect(refused.body.error?.message).toContain(SOL_REFUSAL);
    } finally {
      handle.close();
    }
  });
});

describe('Daybreak aliases on the endpoint server', () => {
  async function withGateway(run: (port: number) => Promise<void>): Promise<void> {
    const models = localProvidersToServerModels([provider]);
    const aliases = normalizeModelAliases(storedAliases).aliases;
    const handle = await startServer({
      host: '127.0.0.1', port: 0, apiKey: 'tok', serverPassword: null,
      catalog: createGatewayModelCatalog(models, undefined, aliases),
      aliasNames: new Set(aliases.map(alias => alias.name)),
    });
    try {
      await run(handle.port);
    } finally {
      await handle.close();
    }
  }

  // The server caches one language model per route. Whichever of an alias and
  // its plain target is asked for first must not decide what the other sends.
  it.each([
    [['blue', 'plain', 'clodex:openai-oauth:gpt-6-luna']],
    [['plain', 'clodex:openai-oauth:gpt-6-luna', 'blue']],
  ])('send the program only through the opted-in alias, in order %j', async order => {
    await withGateway(async port => {
      for (const model of order) {
        const response = await post(port, '/anthropic/v1/messages', 'tok', model);
        expect(response.status).toBe(200);
        expect(response.body.model).toBe(model);
        expect(servedProgram()).toEqual(model === 'blue' ? BLUE : undefined);
      }
    });
  });

  it('does not serve an alias whose Daybreak opt-in cannot be met', async () => {
    await withGateway(async port => {
      const refused = await post(port, '/anthropic/v1/messages', 'tok', 'sol-blue');
      expect(refused.status).toBe(400);
      expect(vi.mocked(generateAnthropicResponse)).not.toHaveBeenCalled();
    });
  });
});
