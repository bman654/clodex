import { describe, it, expect } from 'vitest';
import {
  effectiveProviderBaseUrl,
  isProviderConfiguredForTemplate,
  isRetainedOpenCodeGoProvider,
  resolveProviderTemplate,
} from '../src/registry/resolve-template.js';
import type { RegistryProvider } from '../src/registry/types.js';

function stub(partial: Partial<RegistryProvider> & Pick<RegistryProvider, 'id' | 'templateId'>): RegistryProvider {
  return {
    name: partial.id,
    enabled: true,
    authRef: 'keyring:provider:test',
    api: {},
    addedAt: '2026-06-09T00:00:00.000Z',
    ...partial,
  };
}

describe('resolveProviderTemplate', () => {
  it('resolves the openai template by id', () => {
    const template = resolveProviderTemplate(stub({ id: 'openai', templateId: 'openai' }));
    expect(template?.defaultBaseUrl).toBe('https://api.openai.com/v1');
  });

  it('returns undefined for unknown templates', () => {
    expect(resolveProviderTemplate(stub({ id: 'groq', templateId: 'groq' }))).toBeUndefined();
  });
});

describe('configured built-in template identity', () => {
  it('retains OpenCode Go across either canonical identity field', () => {
    const canonicalId = stub({ id: 'opencode-go', templateId: 'custom-openai' });
    const retainedTemplate = stub({ id: 'imported-opencode', templateId: 'opencode-go' });

    expect(isRetainedOpenCodeGoProvider(canonicalId)).toBe(true);
    expect(isRetainedOpenCodeGoProvider(retainedTemplate)).toBe(true);
    expect(isProviderConfiguredForTemplate(canonicalId, 'opencode-go')).toBe(true);
    expect(isProviderConfiguredForTemplate(retainedTemplate, 'opencode-go')).toBe(true);
  });

  it('keeps ordinary templates keyed only to their exact provider id', () => {
    const custom = stub({ id: 'custom-openai-endpoint', templateId: 'openai' });

    expect(isProviderConfiguredForTemplate(custom, 'openai')).toBe(false);
    expect(isProviderConfiguredForTemplate(
      stub({ id: 'openai', templateId: 'custom-openai' }),
      'openai',
    )).toBe(true);
  });
});

describe('effectiveProviderBaseUrl', () => {
  it('ignores empty url string and uses template default', () => {
    const provider = stub({
      id: 'openai',
      templateId: 'openai',
      api: { npm: '@ai-sdk/openai', url: '' },
    });
    const template = resolveProviderTemplate(provider);
    expect(effectiveProviderBaseUrl(provider, template)).toBe('https://api.openai.com/v1');
  });

  it('uses npm fallback for anthropic without template', () => {
    const provider = stub({
      id: 'anthropic',
      templateId: 'anthropic',
      api: { npm: '@ai-sdk/anthropic' },
    });
    expect(effectiveProviderBaseUrl(provider)).toBe('https://api.anthropic.com');
  });
});
