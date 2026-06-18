import { describe, expect, it } from 'vitest';
import {
  effortProviderOptions,
  resolveReasoningCapabilities,
} from '../src/reasoning-capabilities.js';

describe('resolveReasoningCapabilities', () => {
  it('uses OpenRouter supported_parameters as the source for controllable reasoning', () => {
    const caps = resolveReasoningCapabilities({
      providerId: 'openrouter',
      npm: '@openrouter/ai-sdk-provider',
      modelId: 'z-ai/glm-5.2',
      supportedParameters: ['tools', 'reasoning', 'include_reasoning'],
    });

    expect(caps.mode).toBe('controllable');
    expect(caps.source).toBe('provider-metadata');
    expect(caps.confidence).toBe('documented');
    expect(caps.levels).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(caps.defaultLevel).toBe('medium');
    expect(caps.supportsSummaries).toBe(false);
    expect(caps.wireFormat).toEqual({ kind: 'openrouter-reasoning' });
  });

  it('does not expose controls for OpenRouter models without the reasoning parameter', () => {
    const caps = resolveReasoningCapabilities({
      providerId: 'openrouter',
      npm: '@openrouter/ai-sdk-provider',
      modelId: 'openrouter/fusion',
      supportedParameters: ['tools'],
    });

    expect(caps.mode).toBe('none');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
  });
});

describe('effortProviderOptions', () => {
  it('maps OpenRouter effort to providerOptions.openrouter.reasoning', () => {
    expect(
      effortProviderOptions('@openrouter/ai-sdk-provider', 'high', 'z-ai/glm-5.2', {
        providerId: 'openrouter',
        supportedParameters: ['reasoning'],
      }),
    ).toEqual({
      openrouter: {
        reasoning: {
          effort: 'high',
          exclude: false,
        },
      },
    });
  });
});
