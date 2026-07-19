import { describe, it, expect } from 'vitest';
import { materializeRegistry } from '../src/registry/materialize.js';
import {
  findBlacklistEntry,
  hideReason,
  shouldHideModel,
} from '../src/model-compatibility.js';
import {
  findModelsDevModel,
  loadBundledModelsDevCache,
  readModelsDevCacheMeta,
  shouldHideByModelsDevCapabilities,
  stripModelsDevCacheMeta,
} from '../src/registry/models-dev.js';

describe('shouldHideModel', () => {
  it('allows unknown models by default', () => {
    expect(shouldHideModel({
      providerId: 'openai',
      modelId: 'gpt-9-hypothetical',
      agent: 'claude',
    })).toBe(false);
  });

  it('hides global blacklist ids regardless of provider', () => {
    expect(shouldHideModel({
      providerId: 'openai',
      modelId: 'z-ai/glm4.7',
      agent: 'claude',
    })).toBe(true);
  });

  it('exposes the blacklist reason', () => {
    const ctx = {
      providerId: 'openai',
      modelId: 'z-ai/glm4.7',
      agent: 'claude' as const,
    };
    expect(findBlacklistEntry(ctx)).not.toBeNull();
    expect(hideReason(ctx)).toContain('blacklist');
  });
});

describe('models.dev capability rules', () => {
  const cache = loadBundledModelsDevCache();

  it('ships a bundled snapshot with metadata', () => {
    const meta = readModelsDevCacheMeta(cache);
    expect(meta?.source).toBe('https://models.dev/api.json');
    expect((meta?.provider_count ?? 0) > 50).toBe(true);
    expect(stripModelsDevCacheMeta(cache).google?.models).toBeDefined();
  });

  it('hides audio-only output when catalogued', () => {
    const entry = findModelsDevModel('google', 'gemini-2.5-flash-preview-tts', cache);
    expect(entry).not.toBeNull();
    expect(shouldHideByModelsDevCapabilities(entry!)).toBe(true);
    expect(shouldHideModel({
      providerId: 'google',
      modelId: 'gemini-2.5-flash-preview-tts',
      agent: 'claude',
    })).toBe(true);
  });

  it('does not hide text-output models with missing tool_call field', () => {
    const entry = findModelsDevModel('google', 'gemini-2.5-pro', cache);
    expect(entry).not.toBeNull();
    expect(shouldHideByModelsDevCapabilities(entry!)).toBe(false);
  });
});

describe('materializeRegistry', () => {
  it('drops blacklisted models from provider cache', () => {
    const registry = {
      schema_version: '1' as const,
      providers: [{
        id: 'openai',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: 'keyring:provider:openai',
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-06-10T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-06-10T00:00:00.000Z',
          models: [
            {
              id: 'z-ai/glm4.7',
              name: 'GLM 4.7',
              upstreamModelId: 'z-ai/glm4.7',
              modelFormat: 'openai' as const,
              npm: '@ai-sdk/openai',
            },
            {
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              upstreamModelId: 'gpt-5.6-sol',
              modelFormat: 'openai' as const,
              npm: '@ai-sdk/openai',
            },
          ],
        },
      }],
    };
    const locals = materializeRegistry(registry, () => 'key', { agent: 'claude' });
    expect(locals).toHaveLength(1);
    expect(locals[0]?.models.map(m => m.id)).toEqual(['gpt-5.6-sol']);
  });
});
