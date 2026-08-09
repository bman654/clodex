import { describe, it, expect, vi } from 'vitest';
import {
  createLanguageModel,
  deepMergeProviderOptions,
  effortProviderOptions,
  getPatchReasoningCapabilities,
  getReasoningCapabilities,
  isSdkMigratedNpm,
  maxToolsForNpm,
  modelPrefersResponsesApi,
  shouldUseOpenAiResponsesEndpoint,
  thinkingProviderOptions,
} from '../src/provider-factory.js';
import { VERTEX_ANTHROPIC_NPM } from '../src/constants.js';

async function expectCredentialHeadersStripped(
  fetchImpl: typeof fetch,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const transport = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', transport);
  try {
    await fetchImpl('https://anonymous.example/v1/messages', {
      headers: {
        Authorization: 'Bearer configured-value',
        'X-API-Key': 'configured-value',
        Cookie: 'session=configured-value',
        'Proxy-Authorization': 'Bearer configured-value',
        'X-Auth-Token': 'configured-value',
        'X-Client-Secret': 'configured-value',
        'X-Credential-Id': 'configured-value',
        'Content-Type': 'application/json',
        'X-Custom': 'preserved',
        ...extraHeaders,
      },
    });

    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    for (const name of [
      'authorization',
      'x-api-key',
      'cookie',
      'proxy-authorization',
      'x-auth-token',
      'x-client-secret',
      'x-credential-id',
    ]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-custom')).toBe('preserved');
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (![
        'authorization',
        'x-api-key',
        'cookie',
        'proxy-authorization',
        'x-auth-token',
        'x-client-secret',
        'x-credential-id',
      ].includes(name.toLowerCase())) {
        expect(headers.get(name)).toBe(value);
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('isSdkMigratedNpm', () => {
  it('returns true for any OpenCode-assigned npm except anthropic', () => {
    expect(isSdkMigratedNpm('@ai-sdk/openai')).toBe(true);
    expect(isSdkMigratedNpm('@ai-sdk/cerebras')).toBe(true);
    expect(isSdkMigratedNpm('@ai-sdk/perplexity')).toBe(true);
    expect(isSdkMigratedNpm('@openrouter/ai-sdk-provider')).toBe(true);
    expect(isSdkMigratedNpm('gitlab-ai-provider')).toBe(true);
    expect(isSdkMigratedNpm(VERTEX_ANTHROPIC_NPM)).toBe(true);
  });

  it('returns false for anthropic passthrough and missing npm', () => {
    expect(isSdkMigratedNpm('@ai-sdk/anthropic')).toBe(false);
    expect(isSdkMigratedNpm(undefined)).toBe(false);
    expect(isSdkMigratedNpm('')).toBe(false);
  });
});

describe('modelPrefersResponsesApi', () => {
  it('detects OpenAI and xAI responses-only models', () => {
    expect(modelPrefersResponsesApi('gpt-5.5')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.5-fast')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6-fast')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6-sol')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6-terra')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6-luna')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.2-pro')).toBe(true);
    expect(modelPrefersResponsesApi('grok-4.20-multi-agent')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-4o')).toBe(false);
    expect(modelPrefersResponsesApi('gpt-5.2')).toBe(false);
  });
});

describe('shouldUseOpenAiResponsesEndpoint', () => {
  it('defaults every OpenAI model to the Responses endpoint', () => {
    expect(shouldUseOpenAiResponsesEndpoint('gpt-4o')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-3.5-turbo')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-5.6-sol')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-7-does-not-exist-yet')).toBe(true);
  });

  it('keeps pre-chat legacy completion models on Chat Completions', () => {
    expect(shouldUseOpenAiResponsesEndpoint('davinci-002')).toBe(false);
    expect(shouldUseOpenAiResponsesEndpoint('babbage-002')).toBe(false);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-3.5-turbo-instruct')).toBe(false);
  });
});

describe('maxToolsForNpm', () => {
  it('caps Groq tool lists at 128', () => {
    expect(maxToolsForNpm('@ai-sdk/groq')).toBe(128);
  });

  it('does not cap non-Groq providers', () => {
    expect(maxToolsForNpm('@ai-sdk/openai')).toBeUndefined();
    expect(maxToolsForNpm(undefined)).toBeUndefined();
  });
});

describe('getReasoningCapabilities', () => {
  it('returns anthropic levels for claude-sonnet-4-6', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-sonnet-4-6');
    expect(caps.levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.supportsSummaries).toBe(true);
  });

  it('returns the documented legacy effort ladder for claude-opus-4-5', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-opus-4-5');
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('returns anthropic levels for Vertex Claude models', () => {
    const caps = getReasoningCapabilities(VERTEX_ANTHROPIC_NPM, 'claude-sonnet-4-6@default');
    expect(caps.levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'anthropic-thinking' });

    const legacy = getReasoningCapabilities(VERTEX_ANTHROPIC_NPM, 'claude-opus-4-5@20251101');
    expect(legacy.levels).toEqual(['low', 'medium', 'high']);
  });

  it('adds xhigh without dropping max for the documented newer Claude models', () => {
    for (const modelId of [
      'claude-opus-4-7',
      'claude-opus-4-8-20260801',
      'claude-fable-5',
      'claude-sonnet-5-20260801',
    ]) {
      expect(getReasoningCapabilities('@ai-sdk/anthropic', modelId).levels)
        .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    }
  });

  it('returns empty levels for non-reasoning anthropic model', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-haiku-4-5-20251001');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
    expect(caps.supportsSummaries).toBe(false);
  });

  it('does not infer effort support for undocumented future Claude families', () => {
    for (const modelId of [
      'claude-haiku-4-6',
      'claude-mythos-5',
      'claude-opus-5',
    ]) {
      expect(getReasoningCapabilities('@ai-sdk/anthropic', modelId).levels).toEqual([]);
      expect(effortProviderOptions('@ai-sdk/anthropic', 'high', modelId)).toBeUndefined();
    }
  });

  it('returns high/off only for mistral-large', () => {
    const caps = getReasoningCapabilities('@ai-sdk/mistral', 'mistral-large');
    expect(caps.levels).toEqual(['off', 'high']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('returns budget-mapped levels for gemini-2.5-pro', () => {
    const caps = getReasoningCapabilities('@ai-sdk/google', 'gemini-2.5-pro');
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('medium');
  });

  it('returns empty levels for unknown openai-compatible models', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'unknown');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
  });

  it('returns every documented GPT-5.6 effort level with the medium default', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai', 'gpt-5.6-sol');
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(caps.defaultLevel).toBe('medium');
  });

  it('retains every GPT-5.6 effort level in patched-client metadata', () => {
    const caps = getPatchReasoningCapabilities('@ai-sdk/openai', 'gpt-5.6-sol');
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(caps.defaultLevel).toBe('medium');
  });

  it('does not advertise GPT-5.5 levels that change on the patched-client wire', () => {
    const caps = getPatchReasoningCapabilities('@ai-sdk/openai', 'gpt-5.5');
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('medium');
  });

  it.each(['gpt-5', 'o1'])(
    'does not advertise effort when %s emits no provider option',
    modelId => {
      const caps = getPatchReasoningCapabilities('@ai-sdk/openai', modelId, {
        reasoning: true,
      });
      expect(caps.levels).toEqual([]);
      expect(caps.defaultLevel).toBe('');
      expect(caps.mode).toBe('internal-only');
    },
  );

  it('downgrades inferred Anthropic effort when no level has a valid wire option', () => {
    const caps = getPatchReasoningCapabilities('@ai-sdk/anthropic', 'claude-sonnet-4-5', {
      reasoning: true,
    });
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
    expect(caps.mode).toBe('internal-only');
  });

  it('does not advertise a Kimi level that duplicates another wire option', () => {
    const caps = getPatchReasoningCapabilities(
      '@ai-sdk/openai-compatible',
      'kimi-k2-thinking',
    );
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('does not advertise effort when model metadata explicitly disables reasoning', () => {
    const caps = getPatchReasoningCapabilities(
      '@ai-sdk/openai-compatible',
      'kimi-k2',
      { reasoning: false },
    );
    expect(caps.levels).toEqual([]);
    expect(caps.mode).toBe('none');
  });

  it('honors an explicit effort parameter even when broad reasoning metadata is false', () => {
    const caps = getPatchReasoningCapabilities(
      '@ai-sdk/openai-compatible',
      'custom-model',
      {
        reasoning: false,
        supportedParameters: ['reasoning_effort'],
      },
    );
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
  });

  it('returns empty levels for grok-build-0.1 (internal reasoning only)', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-build-0.1');
    expect(caps.levels).toEqual([]);
  });

  it('returns effort levels for grok-4.3, defaulting to low per xAI docs', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-4.3');
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('low');
  });

  it('returns effort levels for grok-4.5, defaulting to high per xAI docs', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-4.5');
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('returns high/max/off for deepseek-v4-flash', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'deepseek-v4-flash');
    expect(caps.levels).toEqual(['off', 'high', 'max']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('returns documented GLM-5.2 reasoning levels for OpenAI-compatible routes', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'glm-5.2');
    expect(caps.levels).toEqual(['high', 'xhigh']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'openai-reasoning-effort' });
  });

  it('maps DeepSeek effort to openaiCompatible reasoningEffort + thinking enabled', () => {
    const merged = deepMergeProviderOptions(
      effortProviderOptions('@ai-sdk/openai-compatible', 'max', 'deepseek-v4-flash'),
    );
    expect(merged?.openaiCompatible).toMatchObject({ reasoningEffort: 'max' });
    expect(merged?.deepseek).toMatchObject({ thinking: { type: 'enabled' } });
  });

  it('maps Claude low effort to DeepSeek high', () => {
    const opts = effortProviderOptions('@ai-sdk/openai-compatible', 'low', 'deepseek-v4-pro');
    expect(opts?.openaiCompatible).toMatchObject({ reasoningEffort: 'high' });
  });

  it('maps GLM-5.2 effort to OpenAI-compatible reasoningEffort', () => {
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'xhigh', 'glm-5.2')).toEqual({
      openaiCompatible: { reasoningEffort: 'max' },
    });
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'low', 'glm-5.2')).toBeUndefined();
  });


  it('honors a curated per-model effort map before family defaults', () => {
    const metadata = {
      providerId: 'opencode-go',
      reasoning: true,
      compatibility: {
        reasoningEffortMap: { low: null, high: 'max' },
      },
    };

    expect(getPatchReasoningCapabilities(
      '@ai-sdk/openai-compatible',
      'custom-reasoning-model',
      metadata,
    )).toMatchObject({
      levels: ['high'],
      defaultLevel: 'high',
      mode: 'controllable',
      source: 'provider-metadata',
    });
    expect(effortProviderOptions(
      '@ai-sdk/openai-compatible',
      'low',
      'custom-reasoning-model',
      metadata,
    )).toBeUndefined();
    expect(effortProviderOptions(
      '@ai-sdk/openai-compatible',
      'high',
      'custom-reasoning-model',
      metadata,
    )).toEqual({ opencodeGo: { reasoningEffort: 'max' } });
  });

  it('uses generic documented effort controls when compatibility explicitly enables them', () => {
    const metadata = {
      providerId: 'opencode-go',
      reasoning: true,
      compatibility: {
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen' as const,
      },
    };

    expect(getPatchReasoningCapabilities(
      '@ai-sdk/openai-compatible',
      'qwen-custom',
      metadata,
    )).toMatchObject({
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'medium',
      mode: 'controllable',
      source: 'provider-metadata',
    });
    expect(effortProviderOptions(
      '@ai-sdk/openai-compatible',
      'high',
      'qwen-custom',
      metadata,
    )).toEqual({ opencodeGo: { reasoningEffort: 'high' } });
  });

  it('uses exact sparse Anthropic budget ladders without inventing a default', () => {
    const metadata = {
      providerId: 'opencode-go',
      reasoning: true,
      compatibility: {
        anthropicThinkingBudgetMap: { high: 16_000, max: 31_999 },
        reasoningEffortDefault: null,
      },
    };
    expect(getPatchReasoningCapabilities(
      '@ai-sdk/anthropic',
      'qwen3.6-plus',
      metadata,
    )).toMatchObject({
      levels: ['high', 'max'],
      defaultLevel: '',
      mode: 'controllable',
      wireFormat: { kind: 'anthropic-thinking' },
    });
    expect(effortProviderOptions(
      '@ai-sdk/anthropic',
      'max',
      'qwen3.6-plus',
      metadata,
    )).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 31_999 } },
    });
  });

  it('treats an explicit Anthropic budget map as authoritative reasoning capability', () => {
    expect(getPatchReasoningCapabilities(
      '@ai-sdk/anthropic',
      'custom-budget-model',
      {
        reasoning: false,
        compatibility: {
          anthropicThinkingBudgetMap: { high: 8_000 },
          reasoningEffortDefault: null,
        },
      },
    )).toMatchObject({
      levels: ['high'],
      defaultLevel: '',
      mode: 'controllable',
      wireFormat: { kind: 'anthropic-thinking' },
    });
  });

  it('treats an explicit reasoning-effort disable as internal-only reasoning', () => {
    const metadata = {
      providerId: 'opencode-go',
      reasoning: true,
      compatibility: { supportsReasoningEffort: false },
    };

    expect(getReasoningCapabilities(
      '@ai-sdk/openai-compatible',
      'kimi-custom',
      metadata,
    )).toMatchObject({ levels: [], mode: 'internal-only', source: 'provider-metadata' });
    expect(effortProviderOptions(
      '@ai-sdk/openai-compatible',
      'high',
      'kimi-custom',
      metadata,
    )).toBeUndefined();
  });
});

describe('effortProviderOptions + deepMergeProviderOptions', () => {
  it.each(['none', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'preserves GPT-5.6 %s effort on the OpenAI wire',
    (effort) => {
      expect(effortProviderOptions('@ai-sdk/openai', effort, 'gpt-5.6-sol')).toEqual({
        openai: { reasoningEffort: effort },
      });
    },
  );

  it('keeps GPT-5.5 outside the GPT-5.6 wire-effort scope', () => {
    expect(effortProviderOptions('@ai-sdk/openai', 'xhigh', 'gpt-5.5')).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  // gpt-5.3-codex-spark 400s on `reasoning.summary`; the AI SDK adds
  // summary: 'detailed' for any effort but 'none' unless it is pinned to null.
  it.each(['low', 'medium', 'high', 'xhigh'])(
    'suppresses the reasoning summary for codex-spark at %s effort',
    (effort) => {
      expect(effortProviderOptions('@ai-sdk/openai', effort, 'gpt-5.3-codex-spark'))
        .toEqual({
          openai: {
            reasoningEffort: effort === 'xhigh' ? 'high' : effort,
            reasoningSummary: null,
          },
        });
    },
  );

  it('leaves the reasoning summary untouched for other Codex models', () => {
    expect(effortProviderOptions('@ai-sdk/openai', 'high', 'gpt-5.1-codex-max')).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  it('merges OpenAI thinking + effort without dropping store/include', () => {
    const merged = deepMergeProviderOptions(
      thinkingProviderOptions('@ai-sdk/openai'),
      effortProviderOptions('@ai-sdk/openai', 'high', 'gpt-5.4'),
    );
    expect(merged?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'high',
    });
  });

  it('merges Google thinking + effort budget', () => {
    const merged = deepMergeProviderOptions(
      thinkingProviderOptions('@ai-sdk/google'),
      effortProviderOptions('@ai-sdk/google', 'high', 'gemini-2.5-pro'),
    );
    expect(merged?.google?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
  });

  it('maps Vertex Claude effort to Anthropic thinking options', () => {
    expect(effortProviderOptions(VERTEX_ANTHROPIC_NPM, 'medium', 'claude-sonnet-4-6@default')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
    });
  });

  it('preserves native Claude adaptive max and model-gated xhigh effort', () => {
    expect(effortProviderOptions('@ai-sdk/anthropic', 'max', 'claude-opus-4-6')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'max' },
    });
    expect(effortProviderOptions('@ai-sdk/anthropic', 'xhigh', 'claude-opus-4-6')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'max' },
    });
    expect(effortProviderOptions('@ai-sdk/anthropic', 'xhigh', 'claude-opus-4-7')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'xhigh' },
    });
    expect(effortProviderOptions('@ai-sdk/anthropic', 'medium', 'claude-opus-4-5')).toEqual({
      anthropic: { effort: 'medium' },
    });
  });
});

describe('createLanguageModel', () => {
  it('prefers the current OpenAI OAuth token account claim over stored metadata', async () => {
    vi.resetModules();
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));

    const header = Buffer.from('{}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'acct-123' })).toString('base64url');
    const accessToken = `${header}.${payload}.sig`;

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.5',
      apiKey: accessToken,
      authType: 'oauth',
      oauthAccountId: 'stored-acct-456',
    });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: accessToken,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      fetch: expect.any(Function),
      headers: {
        'ChatGPT-Account-Id': 'acct-123',
        originator: 'clodex',
      },
    });
    expect(responses).toHaveBeenCalledWith('gpt-5.5');
    vi.doUnmock('@ai-sdk/openai');
  });

  it('falls back to the stored OpenAI account id when the current token has no account claim', async () => {
    vi.resetModules();
    const responses = vi.fn((modelId: string) => ({
      modelId,
      provider: 'openai-responses',
    }));
    const chat = vi.fn((modelId: string) => ({
      modelId,
      provider: 'openai-chat',
    }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.5',
      apiKey: 'opaque-access-token',
      authType: 'oauth',
      oauthAccountId: 'stored-acct-456',
    });

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'ChatGPT-Account-Id': 'stored-acct-456',
        }),
      }),
    );
    vi.doUnmock('@ai-sdk/openai');
  });

  it('installs credential-header stripping for anonymous OpenAI providers', async () => {
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'anonymous-model',
      apiKey: '',
      authType: 'none',
      headers: {
        Authorization: 'Bearer configured-value',
        'X-Plan': 'free',
      },
    });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: '',
      headers: {
        Authorization: 'Bearer configured-value',
        'X-Plan': 'free',
      },
      fetch: expect.any(Function),
    });
    expect(responses).toHaveBeenCalledWith('anonymous-model');
    const options = createOpenAI.mock.calls[0]?.[0] as {
      fetch: typeof fetch;
      headers: Record<string, string>;
    };
    await expectCredentialHeadersStripped(options.fetch, options.headers);
    vi.doUnmock('@ai-sdk/openai');
  });

  it('forwards configured headers for authenticated OpenAI providers', async () => {
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'authenticated-model',
      apiKey: 'provider-key',
      authType: 'api',
      headers: { 'X-Plan': 'paid' },
    });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'provider-key',
      headers: { 'X-Plan': 'paid' },
    });
    expect(responses).toHaveBeenCalledWith('authenticated-model');
    vi.doUnmock('@ai-sdk/openai');
  });

  it('ignores discovery baseURL for @ai-sdk/anthropic (SDK default includes /v1)', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId, provider: 'anthropic' }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
    });

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(createAnthropic).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.anthropic.com' }),
    );
    vi.doUnmock('@ai-sdk/anthropic');
  });

  it('normalizes custom anthropic baseURL to include /v1', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.com',
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.com/v1',
    });
    vi.doUnmock('@ai-sdk/anthropic');
  });

  it('routes Claude Code Anthropic OAuth through Bearer auth with compatibility headers', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId, provider: 'anthropic-oauth' }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'oauth-token',
      authType: 'oauth',
      providerId: 'claude-code',
      oauthAccountId: '11111111-1111-4111-8111-111111111111',
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      authToken: 'oauth-token',
      headers: expect.objectContaining({
        'User-Agent': 'claude-cli/2.1.195 (external, cli)',
        'x-app': 'cli',
        'X-Claude-Code-Session-Id': expect.any(String),
      }),
    });
    expect(createAnthropic).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'oauth-token' }),
    );
    expect(anthropicFactory).toHaveBeenCalledWith('claude-sonnet-4-6');
    vi.doUnmock('@ai-sdk/anthropic');
  });

  it('forwards custom headers for openai-compatible custom endpoints', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'glm-5.2',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      providerId: 'custom-zai',
      headers: { 'X-Plan': 'coding' },
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'custom-zai',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      headers: { 'X-Plan': 'coding' },
    });
    vi.doUnmock('@ai-sdk/openai-compatible');
  });

  it('installs the per-model compatibility request transformer for openai-compatible providers', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'deepseek-v4-pro',
      apiKey: 'sk-test',
      baseURL: 'https://mixed.example/v1',
      providerId: 'opencode-go',
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
        thinkingFormat: 'deepseek',
      },
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith(expect.objectContaining({
      name: 'opencode-go',
      apiKey: 'sk-test',
      baseURL: 'https://mixed.example/v1',
      transformRequestBody: expect.any(Function),
    }));
    const options = createOpenAICompatible.mock.calls[0]?.[0] as {
      transformRequestBody: (body: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(options.transformRequestBody({
      store: false,
      max_completion_tokens: 4096,
      reasoning_effort: 'high',
      messages: [{ role: 'developer', content: 'instructions' }],
    })).toEqual({
      max_tokens: 4096,
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
      messages: [{ role: 'system', content: 'instructions' }],
    });
    vi.doUnmock('@ai-sdk/openai-compatible');
  });

  it('omits apiKey for anonymous openai-compatible providers', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'tencent/hy3:free',
      apiKey: '',
      authType: 'none',
      baseURL: 'https://api.kilo.ai/api/gateway',
      providerId: 'kilo',
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'kilo',
      baseURL: 'https://api.kilo.ai/api/gateway',
      fetch: expect.any(Function),
    });
    const options = createOpenAICompatible.mock.calls[0]?.[0] as { fetch: typeof fetch };
    await expectCredentialHeadersStripped(options.fetch);
    vi.doUnmock('@ai-sdk/openai-compatible');
  });

  it('strips generated credential headers for anonymous Anthropic providers', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'anonymous-model',
      apiKey: '',
      authType: 'none',
      baseURL: 'https://anonymous.example',
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: '',
      baseURL: 'https://anonymous.example/v1',
      fetch: expect.any(Function),
    });
    expect(anthropicFactory).toHaveBeenCalledWith('anonymous-model');

    const options = createAnthropic.mock.calls[0]?.[0] as { fetch: typeof fetch };
    await expectCredentialHeadersStripped(options.fetch);
    vi.doUnmock('@ai-sdk/anthropic');
  });

  it('merges custom headers into a non-OAuth custom anthropic endpoint', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'glm-5.2',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/anthropic',
      headers: { 'X-Plan': 'coding' },
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/anthropic/v1',
      headers: { 'X-Plan': 'coding' },
    });
    vi.doUnmock('@ai-sdk/anthropic');
  });
});
