import { describe, it, expect } from 'vitest';
import { localProviderToRegistry } from '../src/registry/convert.js';
import type { LocalProvider } from '../src/types.js';

const sampleProvider: LocalProvider = {
  id: 'groq',
  name: 'Groq',
  apiKey: 'gsk-test',
  models: [{
    id: 'llama-3.3-70b',
    name: 'Llama 3.3 70B',
    family: 'llama',
    brand: 'Other',
    modelFormat: 'openai',
    upstreamModelId: 'llama-3.3-70b',
    npm: '@ai-sdk/groq',
    isFree: true,
    freeStatus: 'verified_free',
    codingCapabilitiesAuthoritative: true,
    modalities: ['text', 'image'],
    compatibility: {
      reasoningEffortMap: { high: 'max' },
      thinkingFormat: 'deepseek',
    },
  }],
};

describe('localProviderToRegistry', () => {
  it('converts normalized local provider to registry entry', () => {
    const entry = localProviderToRegistry(sampleProvider);
    expect(entry).toMatchObject({
      id: 'groq',
      templateId: 'groq',
      authRef: 'keyring:provider:groq',
      enabled: true,
    });
    expect(entry?.modelsCache?.models[0]?.upstreamModelId).toBe('llama-3.3-70b');
    expect(entry?.modelsCache?.models[0]?.isFree).toBe(true);
    expect(entry?.modelsCache?.models[0]?.freeStatus).toBe('verified_free');
    expect(entry?.modelsCache?.models[0]?.codingCapabilitiesAuthoritative).toBe(true);
    expect(entry?.modelsCache?.models[0]?.modalities).toEqual(['text', 'image']);
    expect(entry?.modelsCache?.models[0]?.compatibility).toEqual({
      reasoningEffortMap: { high: 'max' },
      thinkingFormat: 'deepseek',
    });
  });

  it('rejects invalid provider ids', () => {
    expect(localProviderToRegistry({ ...sampleProvider, id: 'Bad ID' })).toBeNull();
  });
});
