import { describe, expect, it } from 'vitest';
import {
  isTargetCompatibleModel,
  providersForTarget,
  routableModelsForTarget,
} from '../src/target-compatibility.js';
import type { LocalProvider, LocalProviderModel } from '../src/types.js';

const openAiModel: LocalProviderModel = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  family: 'gpt',
  brand: 'GPT',
  modelFormat: 'openai',
  upstreamModelId: 'gpt-4o',
  npm: '@ai-sdk/openai',
};

const anthropicModel: LocalProviderModel = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  family: 'claude',
  brand: 'Claude',
  modelFormat: 'anthropic',
  upstreamModelId: 'claude-sonnet-4-6',
  npm: '@ai-sdk/anthropic',
};

const openAiModelWithoutNpm: LocalProviderModel = {
  ...openAiModel,
  id: 'no-sdk-model',
  npm: undefined,
};

describe('target compatibility matrix', () => {
  it('keeps OpenAI SDK and Anthropic passthrough routes compatible for both targets', () => {
    for (const target of ['claude', 'server'] as const) {
      expect(isTargetCompatibleModel({
        target,
        providerId: 'openai',
        authType: 'api',
        model: openAiModel,
      }).compatible, target).toBe(true);
      expect(isTargetCompatibleModel({
        target,
        providerId: 'anthropic',
        authType: 'api',
        model: anthropicModel,
      }).compatible, target).toBe(true);
    }
  });

  it('rejects OpenAI-format models without an SDK provider package', () => {
    expect(isTargetCompatibleModel({
      target: 'claude',
      providerId: 'openai',
      authType: 'api',
      model: openAiModelWithoutNpm,
    })).toMatchObject({ compatible: false });
  });

  it('filters providers and models per target', () => {
    const providers: LocalProvider[] = [
      { id: 'openai', name: 'OpenAI', apiKey: 'k', authType: 'api', models: [openAiModel] },
      { id: 'openai-oauth', name: 'OpenAI OAuth (ChatGPT)', apiKey: 'tok', authType: 'oauth', models: [openAiModel] },
      { id: 'broken', name: 'Broken', apiKey: 'k', authType: 'api', models: [openAiModelWithoutNpm] },
    ];

    for (const target of ['claude', 'server'] as const) {
      expect(providersForTarget(providers, target).map(p => p.id).sort(), target).toEqual(['openai', 'openai-oauth']);
    }
    expect(routableModelsForTarget(providers[2]!, 'claude')).toHaveLength(0);
  });
});
