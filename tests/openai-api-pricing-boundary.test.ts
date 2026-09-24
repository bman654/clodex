import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTemplateById, type ProviderTemplate } from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { addProviderFromTemplate } from '../src/registry/add-template.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { loadRegistryProvidersSync } from '../src/registry/load.js';
import { projectProviderCachedModels } from '../src/registry/materialize.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';
import { getProvidersPath } from '../src/paths.js';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { installParentNoticeSink } from '../src/parent-notice.js';
import { resetPricingBoundaryWarnings } from '../src/pricing-boundary.js';
import { pricingBoundaryWarning, resolveContextStop } from '../src/context-modes.js';

// Only external boundaries are replaced: no registry, materialization, SDK,
// routing or warning function is mocked. Never touch the real credential store.
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  provisionProviderCredential: vi.fn(async () => true),
  saveProviderCredential: vi.fn(async () => true),
  deleteProviderCredential: vi.fn(async () => true),
}));
vi.mock('../src/registry/pricing.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/pricing.js')>(),
  enrichPricingAsync: vi.fn(),
}));

const openai = getTemplateById('openai')!;
const realFetch = globalThis.fetch;
const ids = ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-4.1'];
let home: string;
let server: ServerHandle | undefined;
let inputTokens: number;

function oldCache(id: string, extra: Partial<CachedModel> = {}): CachedModel {
  return { id, name: id, upstreamModelId: id, modelFormat: 'openai', ...extra };
}

function provider(models: CachedModel[], npm = '@ai-sdk/openai'): RegistryProvider {
  return {
    id: 'openai', templateId: 'openai', name: 'OpenAI', enabled: true,
    authType: 'api', authRef: 'env:TEST_OPENAI_KEY', addedAt: '2026-09-01T00:00:00.000Z',
    api: { npm, url: 'https://api.openai.com/v1' },
    modelsCache: { fetchedAt: '2026-09-01T00:00:00.000Z', models },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clodex-api-pricing-'));
  vi.stubEnv('CLODEX_HOME', home);
  resetPricingBoundaryWarnings();
  inputTokens = 272_001;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    if (url === 'https://api.openai.com/v1/models') {
      return Response.json({ data: ids.map(id => ({ id })) });
    }
    if (url === 'https://compatible.example/v1/chat/completions') {
      return Response.json({
        id: 'chatcmpl_pricing_test', object: 'chat.completion', created: 1,
        model: JSON.parse(String(init?.body)).model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: inputTokens, completion_tokens: 1, total_tokens: inputTokens + 1 },
      });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'resp_pricing_test', model: body.model,
        output: [{
          type: 'message', id: 'msg_pricing_test', role: 'assistant',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
        }],
        usage: {
          input_tokens: inputTokens, input_tokens_details: { cached_tokens: 270_000 },
          output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    }
    throw new Error(`Unexpected external request: ${url}`);
  }));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('OpenAI API-key pricing boundaries', () => {
  it('discovers boundary families without reducing their full API windows', async () => {
    const result = await fetchTemplateModels(openai, 'synthetic-api-key');
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(ids.length);
    for (const model of result.models) {
      expect(model.pricingBoundary).toBe(model.id === 'gpt-4.1' ? undefined : 272_000);
      if (model.id !== 'gpt-4.1') {
        expect(model.pricingBoundaryNote).toContain('2x input and 1.5x output');
        expect(model.contextWindow).toBe(model.id.startsWith('gpt-6') ? 1_050_000 : 1_000_000);
        // Standard is already above the line for API-key models; recommending
        // that same stop would not help this user avoid the higher rate.
        expect(pricingBoundaryWarning(model.id, model, resolveContextStop(model)))
          .toContain('Choose a smaller context stop');
      }
    }
  });

  it('does not assign OpenAI pricing to a compatible provider with the same model ids', async () => {
    const compatible = { ...openai, id: 'custom-openai', npm: '@ai-sdk/openai-compatible' };
    const result = await fetchTemplateModels(compatible, 'synthetic-api-key');
    expect(result.models).toHaveLength(ids.length);
    expect(result.models.every(model => model.pricingBoundary === undefined
      && model.pricingBoundaryNote === undefined)).toBe(true);
  });

  // No shipped template uses static-seed today; pin the supported materializer
  // contract without claiming this is the user-facing reproduction.
  it('fills static-seed metadata while retaining explicit pricing and per-model SDK overrides', async () => {
    const template: ProviderTemplate = {
      ...openai, modelSource: 'static-seed', staticModels: [
        { id: 'gpt-6-sol', name: 'Sol' },
        { id: 'gpt-5.6-sol', name: 'Sol 5.6', pricingBoundary: 300_000, pricingBoundaryNote: 'explicit' },
        { id: 'gpt-6-luna', name: 'Compatible Luna', npm: '@ai-sdk/openai-compatible' },
        { id: 'gpt-4.1', name: 'GPT-4.1' },
      ],
    };
    const { models } = await fetchTemplateModels(template, 'synthetic-api-key');
    expect(models.map(model => model.pricingBoundary)).toEqual([272_000, 300_000, undefined, undefined]);
    expect(models[1]?.pricingBoundaryNote).toBe('explicit');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('persists the metadata through providers add and refresh-models', async () => {
    expect(await addProviderFromTemplate(openai, 'synthetic-api-key')).toMatchObject({ added: true });
    const added = loadRegistry().providers[0]!;
    expect(added.modelsCache!.models.find(model => model.id === 'gpt-6-sol')).toMatchObject({
      pricingBoundary: 272_000, contextWindow: 1_050_000,
    });
    // An old cache must gain the fields on explicit refresh as well as on read.
    withRegistryWriteLockSync(() => saveRegistry({ version: 1, providers: [{ ...added, modelsCache: {
      fetchedAt: '2026-09-01T00:00:00.000Z', models: ids.map(id => oldCache(id)),
    } }] }));
    expect(await refreshProviderModels('openai', 'synthetic-api-key')).toMatchObject({ ok: true });
    const refreshed = loadRegistry().providers[0]!.modelsCache!.models;
    expect(refreshed.find(model => model.id === 'gpt-5.6-sol')).toMatchObject({
      pricingBoundary: 272_000, contextWindow: 1_000_000,
    });
    expect(refreshed.find(model => model.id === 'gpt-4.1')?.pricingBoundary).toBeUndefined();
  });

  it('upgrades existing caches offline without rewriting them or overwriting explicit metadata', () => {
    const saved = provider([
      oldCache('gpt-6-sol', { contextWindow: 1_050_000 }),
      oldCache('gpt-5.6-sol', { contextWindow: 1_000_000, npm: '@ai-sdk/openai' }),
      oldCache('gpt-6-luna', { pricingBoundary: 300_000, pricingBoundaryNote: 'explicit' }),
      oldCache('gpt-4.1'),
      oldCache('gpt-6-astra', { npm: '@ai-sdk/openai-compatible' }),
    ]);
    withRegistryWriteLockSync(() => saveRegistry({ version: 1, providers: [saved] }));
    const bytes = readFileSync(getProvidersPath(), 'utf8');
    const projected = projectProviderCachedModels(loadRegistry().providers[0]!);
    expect(projected.map(model => model.pricingBoundary)).toEqual([
      272_000, 272_000, 300_000, undefined, undefined,
    ]);
    expect(projected[0]?.pricingBoundaryNote).toContain('2x input and 1.5x output');
    expect(projected[2]?.pricingBoundaryNote).toBe('explicit');
    const models = loadRegistryProvidersSync(() => 'synthetic-api-key')[0]!.models;
    expect(models[0]).toMatchObject({ contextWindow: 1_050_000, pricingBoundary: 272_000 });
    expect(models[1]).toMatchObject({ contextWindow: 1_000_000, pricingBoundary: 272_000 });
    expect(readFileSync(getProvidersPath(), 'utf8')).toBe(bytes);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(saved.modelsCache!.models[0]?.pricingBoundary).toBeUndefined();
  });

  it('still backfills an old cache when refresh cannot reach OpenAI', async () => {
    withRegistryWriteLockSync(() => saveRegistry({
      version: 1, providers: [provider([oldCache('gpt-6-sol', { contextWindow: 1_050_000 })])],
    }));
    const bytes = readFileSync(getProvidersPath(), 'utf8');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('offline'));
    expect(await refreshProviderModels('openai', 'synthetic-api-key')).toMatchObject({ ok: false });
    expect(readFileSync(getProvidersPath(), 'utf8')).toBe(bytes);
    expect(loadRegistryProvidersSync(() => 'synthetic-api-key')[0]!.models[0]).toMatchObject({
      contextWindow: 1_050_000, pricingBoundary: 272_000,
    });
  });

  it('uses the effective per-model SDK and upstream identity when projecting caches', () => {
    const projected = projectProviderCachedModels(provider([
      oldCache('gpt-6-sol'),
      oldCache('my-sol', { upstreamModelId: 'gpt-6-sol', npm: '@ai-sdk/openai' }),
      oldCache('gpt-6-luna', { upstreamModelId: 'gpt-4.1', npm: '@ai-sdk/openai' }),
    ], '@ai-sdk/openai-compatible'));
    expect(projected.map(model => model.pricingBoundary)).toEqual([undefined, 272_000, undefined]);
  });

  it('carries old-cache pricing boundaries into proxy routes without reducing the full context window', () => {
    withRegistryWriteLockSync(() => saveRegistry({
      version: 1, providers: [provider([
        oldCache('gpt-6-sol', { contextWindow: 1_050_000 }),
        oldCache('gpt-4.1', { contextWindow: 1_000_000 }),
      ])],
    }));
    const result = buildHttpProxyRoutes(loadRegistryProvidersSync(() => 'synthetic-api-key'), [
      { providerId: 'openai', modelId: 'gpt-6-sol' },
      { providerId: 'openai', modelId: 'gpt-4.1' },
    ]);
    expect(result.unavailable).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.routes).toHaveLength(2);
    expect(result.routes[0]).toMatchObject({
      realModelId: 'gpt-6-sol', contextWindow: 1_050_000, pricingBoundary: 272_000,
    });
    expect(result.routes[1]).toMatchObject({ realModelId: 'gpt-4.1', contextWindow: 1_000_000 });
    expect(result.routes[1]?.pricingBoundary).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['discovered', 'old cache', 'compatible provider'] as const)(
    'warns only for OpenAI through the real gateway and SDK (%s), including cached prompt tokens',
    async source => {
      const models = source === 'discovered'
        ? (await fetchTemplateModels(openai, 'synthetic-api-key')).models
        : ids.map(id => oldCache(id));
      const saved = source === 'compatible provider'
        ? { ...provider(models), id: 'custom', templateId: 'custom-openai', api: {
            npm: '@ai-sdk/openai-compatible', url: 'https://compatible.example/v1',
          } }
        : provider(models);
      withRegistryWriteLockSync(() => saveRegistry({ version: 1, providers: [saved] }));
      const catalog = createGatewayModelCatalog(localProvidersToServerModels(
        loadRegistryProvidersSync(() => 'synthetic-api-key'),
      ));
      server = await startServer({
        host: '127.0.0.1', port: 0, apiKey: '', serverPassword: null, catalog,
      });
      const notices: string[] = [];
      const release = installParentNoticeSink(message => notices.push(message));
      try {
        const request = async (model: string) => {
          const response = await realFetch(`${server!.url}/anthropic/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }),
          });
          const body = await response.json();
          expect(response.status, JSON.stringify(body)).toBe(200);
          expect(body).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
        };
        inputTokens = 272_000;
        await request('gpt-6-sol');
        expect(notices).toEqual([]);
        inputTokens = 272_001;
        await request('gpt-6-sol');
        await request('gpt-5.6-sol');
        await request('gpt-4.1');
        await request('gpt-6-sol'); // existing once-per-model latch
        if (source === 'compatible provider') {
          expect(notices).toEqual([]);
          return;
        }
        expect(notices).toHaveLength(2);
        expect(notices[0]).toContain('gpt-6-sol request counted 272,001 input tokens');
        expect(notices[1]).toContain('gpt-5.6-sol request counted 272,001 input tokens');
        expect(notices.every(message => message.includes('272,000-token pricing boundary'))).toBe(true);
        expect(notices.every(message => message.includes('Choose a smaller context stop'))).toBe(true);
      } finally {
        release();
      }
    },
  );
});
