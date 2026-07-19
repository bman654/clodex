// tests/catalog.test.ts
import { describe, it, expect } from 'vitest';
import { MAX_MODEL_CATALOG } from '../src/constants.js';
import { buildCatalogRoutes, localModelToRoute, makeRouteResolver } from '../src/catalog.js';
import type { ModelInfo } from '../src/types.js';
import type { FavoriteModel, LocalProvider } from '../src/types.js';

describe('buildCatalogRoutes', () => {
  const starting = {
    aliasId: 'claude-sonnet-4',
    realModelId: 'claude-sonnet-4',
    displayName: 'Sonnet (Groq)',
    upstreamUrl: 'https://api.groq.com',
    apiKey: 'k',
    modelFormat: 'openai' as const,
  };

  const resolve = (providerId: string, modelId: string) =>
    providerId === 'groq' && modelId === 'llama-3.3-70b'
      ? { ...starting, aliasId: 'anthropic-groq__llama-3.3-70b', realModelId: modelId }
      : undefined;

  it('dedupes starting model and caps catalog size', () => {
    const favorites: FavoriteModel[] = [
      { providerId: 'groq', modelId: 'llama-3.3-70b' },
      { providerId: 'zen', modelId: 'claude-sonnet-4' },
    ];
    const { routes, droppedFavorites } = buildCatalogRoutes(starting, favorites, resolve, MAX_MODEL_CATALOG);
    expect(routes[0]).toEqual(starting);
    expect(routes).toHaveLength(2);
    expect(droppedFavorites).toEqual([{ providerId: 'zen', modelId: 'claude-sonnet-4' }]);
  });
});


describe('localModelToRoute', () => {
  it('uses upstreamModelId for SDK calls while keeping catalog id as alias', () => {
    const provider: LocalProvider = {
      id: 'openai',
      name: 'OpenAI',
      apiKey: 'sk-test',
      models: [{
        id: 'gpt-5.5-fast',
        name: 'GPT-5.5 Fast',
        family: 'gpt',
        brand: 'GPT',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-5.5',
        completionsUrl: 'https://api.openai.com/v1/chat/completions',
        npm: '@ai-sdk/openai',
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({
      aliasId: 'anthropic-openai__gpt-5.5-fast[1m]',
      realModelId: 'gpt-5.5',
    });
  });

  it('preserves OAuth provider data for catalog routes', () => {
    const provider: LocalProvider = {
      id: 'openai-oauth',
      name: 'OpenAI OAuth (ChatGPT)',
      apiKey: 'oauth-token',
      authType: 'oauth',
      providerData: { plan: 'pro' },
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        family: 'gpt',
        brand: 'GPT',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-5.6-sol',
        npm: '@ai-sdk/openai',
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({
      modelFormat: 'openai',
      authType: 'oauth',
      providerData: { plan: 'pro' },
    });
  });

  it('propagates Responses-Lite / WebSocket capability flags onto the route', () => {
    const provider: LocalProvider = {
      id: 'openai-oauth',
      name: 'OpenAI OAuth (ChatGPT)',
      apiKey: 'oauth-token',
      authType: 'oauth',
      models: [{
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        family: 'gpt',
        brand: 'GPT',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-5.6-luna',
        npm: '@ai-sdk/openai',
        useResponsesLite: true,
        preferWebSockets: true,
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({ useResponsesLite: true, preferWebSockets: true });
  });

  it('passes through custom endpoint headers for catalog routes', () => {
    const provider: LocalProvider = {
      id: 'custom-zai',
      name: 'Z.AI Coding Plan',
      apiKey: 'sk-test',
      headers: { 'X-Plan': 'coding' },
      models: [{
        id: 'glm-5.2',
        name: 'GLM-5.2',
        family: 'glm',
        brand: 'Other',
        modelFormat: 'openai',
        upstreamModelId: 'glm-5.2',
        npm: '@ai-sdk/openai-compatible',
        apiBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({ headers: { 'X-Plan': 'coding' } });
  });

  it('returns null when routing fields are missing for non-SDK openai models', () => {
    const provider: LocalProvider = {
      id: 'p',
      name: 'P',
      apiKey: 'k',
      models: [{
        id: 'm',
        name: 'M',
        family: '',
        brand: 'Other',
        modelFormat: 'openai',
        upstreamModelId: 'm',
      }],
    };
    expect(localModelToRoute(provider, provider.models[0]!)).toBeNull();
  });

  it('builds SDK routes without completionsUrl when npm is set', () => {
    const provider: LocalProvider = {
      id: 'cerebras',
      name: 'Cerebras',
      apiKey: 'sk-test',
      models: [{
        id: 'llama-3.3-70b',
        name: 'Llama 3.3 70B',
        family: 'llama',
        brand: 'Other',
        modelFormat: 'openai',
        upstreamModelId: 'llama-3.3-70b',
        npm: '@ai-sdk/cerebras',
      }],
    };
    const route = localModelToRoute(provider, provider.models[0]!);
    expect(route).toMatchObject({
      aliasId: 'anthropic-cerebras__llama-3.3-70b',
      realModelId: 'llama-3.3-70b',
      npm: '@ai-sdk/cerebras',
      upstreamUrl: '',
    });
  });
});
