import { describe, it, expect } from 'vitest';
import { effectiveProviderBaseUrl, resolveProviderTemplate } from '../src/registry/resolve-template.js';
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
