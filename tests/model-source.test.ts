import { describe, it, expect } from 'vitest';
import { resolveModelSource } from '../src/registry/model-source.js';
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

describe('resolveModelSource', () => {
  it('returns api-list for the openai template', () => {
    expect(resolveModelSource(stub({ id: 'openai', templateId: 'openai' }))).toBe('api-list');
  });

  it('returns manual-only for google-vertex import id', () => {
    expect(resolveModelSource(stub({ id: 'google-vertex', templateId: 'google-vertex' }))).toBe('manual-only');
  });

  it('returns manual-only for bedrock template', () => {
    expect(resolveModelSource(stub({ id: 'bedrock', templateId: 'bedrock' }))).toBe('manual-only');
  });

  it.each(['bedrock', 'vertex', 'azure'])(
    'keeps canonical OpenCode identity ahead of the foreign %s manual-only template',
    templateId => {
      expect(resolveModelSource(stub({ id: 'opencode-go', templateId }))).toBe('api-list');
    },
  );

  it.each(['@ai-sdk/amazon-bedrock', '@ai-sdk/google-vertex', '@ai-sdk/azure'])(
    'keeps canonical OpenCode identity ahead of foreign manual-only npm %s',
    npm => {
      expect(resolveModelSource(stub({
        id: 'opencode-go',
        templateId: 'bedrock',
        api: { npm },
      }))).toBe('api-list');
    },
  );

  it('recognizes a supported retained-template migration before manual-only npm metadata', () => {
    expect(resolveModelSource(stub({
      id: 'opencode-go-imported',
      templateId: 'opencode-go',
      api: { npm: '@ai-sdk/amazon-bedrock' },
    }))).toBe('api-list');
  });

  it('keeps an ordinary provider with manual-only npm metadata manual-only', () => {
    expect(resolveModelSource(stub({
      id: 'imported-bedrock',
      templateId: 'custom-openai',
      api: { npm: '@ai-sdk/amazon-bedrock' },
    }))).toBe('manual-only');
  });

  it('returns api-list for custom endpoints', () => {
    expect(resolveModelSource(stub({ id: 'my-server', templateId: 'custom-openai' }))).toBe('api-list');
  });
});
