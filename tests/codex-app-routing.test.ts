import { describe, it, expect } from 'vitest';
import { buildCodexProxyRoutesForProvider } from '../src/codex/routing.js';
import type { LocalProvider } from '../src/types.js';

describe('buildCodexProxyRoutesForProvider', () => {
  it('includes all routable models', () => {
    const provider: LocalProvider = {
      id: 'anthropic',
      name: 'Anthropic',
      apiKey: 'k',
      models: [
        {
          id: 'claude-sonnet-4-6',
          name: 'Sonnet',
          family: 'claude',
          brand: 'Anthropic',
          modelFormat: 'anthropic',
          upstreamModelId: 'claude-sonnet-4-6',
        },
        {
          id: 'claude-haiku-4-5',
          name: 'Haiku',
          family: 'claude',
          brand: 'Anthropic',
          modelFormat: 'anthropic',
          upstreamModelId: 'claude-haiku-4-5',
        },
      ],
    };
    const routes = buildCodexProxyRoutesForProvider(provider, 'sk-test');
    expect(routes).toHaveLength(2);
    expect(routes.map(r => r.modelId).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
  });

  it('puts selected model first in route list', () => {
    const provider: LocalProvider = {
      id: 'anthropic',
      name: 'Anthropic',
      apiKey: 'k',
      models: [
        {
          id: 'claude-fable-5',
          name: 'Fable',
          family: 'claude',
          brand: 'Anthropic',
          modelFormat: 'anthropic',
          upstreamModelId: 'claude-fable-5',
        },
        {
          id: 'claude-haiku-4-5',
          name: 'Haiku',
          family: 'claude',
          brand: 'Anthropic',
          modelFormat: 'anthropic',
          upstreamModelId: 'claude-haiku-4-5',
        },
      ],
    };
    const routes = buildCodexProxyRoutesForProvider(provider, 'sk-test', 'claude-haiku-4-5');
    expect(routes[0]!.modelId).toBe('claude-haiku-4-5');
  });
});
