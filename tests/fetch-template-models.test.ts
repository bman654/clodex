import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import type { ProviderTemplate } from '../src/provider-templates.js';
import { clearTraceSecrets, getProviderDebugLogPath } from '../src/trace-log.js';

function template(partial: Partial<ProviderTemplate> & Pick<ProviderTemplate, 'id' | 'name' | 'npm'>): ProviderTemplate {
  return {
    authType: 'api',
    modelSource: 'api-list',
    supported: true,
    ...partial,
  };
}

const anthropicTemplate = template({
  id: 'anthropic',
  name: 'Anthropic',
  npm: '@ai-sdk/anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
});

const openaiCompatTemplate = template({
  id: 'custom-compat',
  name: 'Custom Compat',
  npm: '@ai-sdk/openai-compatible',
  defaultBaseUrl: 'https://api.compat.example/v1',
});

describe('fetchTemplateModels', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    clearTraceSecrets();
    vi.unstubAllGlobals();
  });

  it('uses x-api-key for Anthropic, not Bearer auth', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
      }),
    } as Response);

    const result = await fetchTemplateModels(anthropicTemplate, 'sk-ant-test-key');
    expect(result.error).toBeUndefined();
    expect(result.models.map(m => m.id)).toEqual(['claude-sonnet-4-6']);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'sk-ant-test-key',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
    const call = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect((call.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('uses Bearer auth for OpenAI-compatible providers', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'model-a', name: 'model-a' }] }),
    } as Response);

    await fetchTemplateModels(openaiCompatTemplate, 'sk-test-key');

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-key',
        }),
      }),
    );
  });

  it('redacts an opaque API key echoed in a traced response body', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clodex-trace-redaction-'));
    const previousHome = process.env.CLODEX_HOME;
    const previousTrace = process.env.CLODEX_TRACE;
    const secret = 'opaque.credential+$value[42]';
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ echo: secret }),
    } as Response);

    process.env.CLODEX_HOME = home;
    process.env.CLODEX_TRACE = '1';
    try {
      await fetchTemplateModels(openaiCompatTemplate, secret);

      const trace = readFileSync(getProviderDebugLogPath(), 'utf8');
      expect(trace).toContain('{"echo":"[REDACTED]"}');
      expect(trace).not.toContain(secret);
    } finally {
      if (previousHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousHome;
      if (previousTrace === undefined) delete process.env.CLODEX_TRACE;
      else process.env.CLODEX_TRACE = previousTrace;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges extra headers for custom endpoints needing plan/auth-tracking headers', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'model-a', name: 'model-a' }] }),
    } as Response);

    await fetchTemplateModels(openaiCompatTemplate, 'sk-test-key', undefined, { 'X-Plan': 'coding' });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-key',
          'X-Plan': 'coding',
        }),
      }),
    );
  });

  it('preserves provider-supported request parameters from model list rows', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{
          id: 'z-ai/glm-5.2',
          name: 'Z.ai: GLM 5.2',
          supported_parameters: ['tools', 'reasoning', 'include_reasoning'],
        }],
      }),
    } as Response);

    const result = await fetchTemplateModels(openaiCompatTemplate, 'sk-test');

    expect(result.error).toBeUndefined();
    expect(result.models[0]).toMatchObject({
      id: 'z-ai/glm-5.2',
      supportedParameters: ['tools', 'reasoning', 'include_reasoning'],
    });
  });

  it('uses provider-specific modelsPath and omits Authorization for anonymous fetches', async () => {
    const anonymousTemplate = template({
      id: 'anon-free',
      name: 'Anon Free',
      npm: '@ai-sdk/openai-compatible',
      defaultBaseUrl: 'https://api.anon.example/api/gateway',
      modelsPath: '/models',
      apiKeyOptional: true,
      anonymousFreeModels: true,
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{
          id: 'tencent/hy3:free',
          name: 'Tencent: Hy3 (free)',
          isFree: true,
          context_length: 262144,
          pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
        }],
      }),
    } as Response);

    const result = await fetchTemplateModels(anonymousTemplate, '');

    expect(result.error).toBeUndefined();
    expect(result.models[0]).toMatchObject({
      id: 'tencent/hy3:free',
      isFree: true,
      freeStatus: 'verified_free',
      contextWindow: 262144,
      cost: { input: 0, output: 0, cache_read: 0 },
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.anon.example/api/gateway/models',
      expect.objectContaining({
        headers: expect.not.objectContaining({
          Authorization: expect.any(String),
        }),
      }),
    );
  });

  it('derives verified free status from zero pricing even when provider flag is false', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{
          id: 'vendor/free-preview',
          name: 'Vendor: Free Preview',
          isFree: false,
          context_length: 1048576,
          pricing: { prompt: '0', completion: '0' },
        }],
      }),
    } as Response);

    const result = await fetchTemplateModels(openaiCompatTemplate, 'sk-test');

    expect(result.models[0]).toMatchObject({
      id: 'vendor/free-preview',
      isFree: true,
      freeStatus: 'verified_free',
      cost: { input: 0, output: 0 },
    });
  });
});
