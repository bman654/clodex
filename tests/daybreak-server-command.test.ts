// `clodex server --endpoint --quick` end to end: a real config.json, the real
// command, gateway and router, the real provider factory, AI SDK and ChatGPT
// WebSocket transport. Only the provider catalog load and the network socket
// are replaced.
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LocalProvider } from '../src/types.js';

const state = vi.hoisted(() => ({
  handle: null as null | { port: number },
  frames: [] as Record<string, unknown>[],
}));

class FakeSocket extends EventEmitter {
  close = vi.fn();
  terminate = vi.fn();
  constructor(public url: string, public options: unknown) {
    super();
    setImmediate(() => this.emit('open'));
  }
  send = vi.fn((data: string, callback?: (error?: Error) => void) => {
    callback?.();
    state.frames.push(JSON.parse(data) as Record<string, unknown>);
    const id = `resp_${state.frames.length}`;
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `msg_${id}`, role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `msg_${id}`, role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    setImmediate(() => { for (const event of events) this.emit('message', Buffer.from(JSON.stringify(event))); });
  });
}
vi.mock('ws', () => ({ WebSocket: FakeSocket, default: FakeSocket }));

const provider: LocalProvider = {
  id: 'openai-oauth', name: 'OpenAI (ChatGPT)', apiKey: 'tok', authType: 'oauth',
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

vi.mock('../src/provider-catalog.js', async original => ({
  ...await original<typeof import('../src/provider-catalog.js')>(),
  fetchProviderCatalog: vi.fn(async () => [provider]),
  resolveLocalProviderApiKey: vi.fn(async () => 'tok'),
}));

vi.mock('../src/server/router.js', async original => {
  const actual = await original<typeof import('../src/server/router.js')>();
  return {
    ...actual,
    startServer: vi.fn(async (options: Parameters<typeof actual.startServer>[0]) => {
      const handle = await actual.startServer(options);
      state.handle = handle;
      return handle;
    }),
  };
});

function post(
  port: number,
  model: string,
  path = '/anthropic/v1/messages',
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'hi' }] });
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'anything' },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeAll(() => {
  const home = process.env.CLODEX_HOME;
  if (!home || home.endsWith('/.clodex')) throw new Error(`refusing to write config into ${home}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    favoriteModels: provider.models.map(model => ({ providerId: provider.id, modelId: model.id })),
    modelAliases: [
      { name: 'blue', providerId: 'openai-oauth', modelId: 'gpt-6-luna', daybreak: true },
      { name: 'plain', providerId: 'openai-oauth', modelId: 'gpt-6-luna' },
      { name: 'sol-blue', providerId: 'openai-oauth', modelId: 'gpt-6.1-sol', daybreak: true },
    ],
  }));
});

describe('clodex server --endpoint with Daybreak aliases', () => {
  it('sends the program only for the opted-in alias and reports the one it cannot serve', { timeout: 60_000 }, async () => {
    const warn = vi.spyOn(p.log, 'warn');
    const { runServerCommand } = await import('../src/server/index.js');
    const exited = runServerCommand({ quick: true, noDiscovery: true, port: 0, maskGatewayIds: false });
    await vi.waitFor(() => expect(state.handle).not.toBeNull(), { timeout: 30_000 });
    const port = state.handle!.port;
    try {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        `"sol-blue" — Daybreak isn't available for gpt-6.1-sol on this ChatGPT account`,
      ));

      // Plain first, so a cache keyed only on the model would hand the alias
      // the plain model (and the reverse order would leak the program).
      for (const model of ['plain', 'blue', 'clodex:openai-oauth:gpt-6-luna']) {
        expect((await post(port, model)).status).toBe(200);
      }
      expect(state.frames.map(frame => frame.access_programs)).toEqual([undefined, { cyber: 'daybreak_blue' }, undefined]);

      // The OpenAI-format route shares the gateway and its model cache.
      for (const model of ['plain', 'blue', 'clodex:openai-oauth:gpt-6-luna']) {
        expect((await post(port, model, '/openai/v1/chat/completions')).status).toBe(200);
      }
      expect(state.frames.slice(3).map(frame => frame.access_programs))
        .toEqual([undefined, { cyber: 'daybreak_blue' }, undefined]);

      for (const path of ['/anthropic/v1/messages', '/openai/v1/chat/completions']) {
        const refused = await post(port, 'sol-blue', path);
        expect(refused.status).toBe(400);
        expect(refused.body).toContain("Daybreak isn't available for gpt-6.1-sol on this ChatGPT account");
      }
      expect(state.frames).toHaveLength(6);
    } finally {
      process.emit('SIGINT');
      await expect(exited).resolves.toBe(0);
    }
  });
});
