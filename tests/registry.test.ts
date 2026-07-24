import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  emptyRegistry,
  isValidProviderId,
  loadRegistry,
  materializeRegistry,
  saveRegistry,
  slugifyProviderId,
  toggleProviderEnabled,
} from '../src/registry/index.js';
import { loadRegistryStrict } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';

describe('provider id validation', () => {
  it('accepts stable slugs', () => {
    expect(isValidProviderId('groq')).toBe(true);
    expect(isValidProviderId('openai')).toBe(true);
    expect(isValidProviderId('custom-together-ai')).toBe(true);
    expect(isValidProviderId('go')).toBe(true);
  });

  it('rejects invalid ids', () => {
    expect(isValidProviderId('OpenAI')).toBe(false);
    expect(isValidProviderId('has space')).toBe(false);
    expect(isValidProviderId('bad:id')).toBe(false);
    expect(isValidProviderId('-leading')).toBe(false);
    expect(isValidProviderId('trailing-')).toBe(false);
  });

  it('slugifies display names', () => {
    expect(slugifyProviderId('Together AI')).toBe('together-ai');
    expect(slugifyProviderId('My vLLM Server')).toBe('my-vllm-server');
  });
});

describe('registry io', () => {
  let home: string;
  const prev = process.env.CLODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-registry-'));
    process.env.CLODEX_HOME = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it('round-trips registry json', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:groq',
      api: { npm: '@ai-sdk/groq' },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'llama-3.3-70b',
          name: 'Llama 3.3 70B',
          upstreamModelId: 'llama-3.3-70b',
          modelFormat: 'openai',
          npm: '@ai-sdk/groq',
        }],
      },
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));
    const loaded = loadRegistry();
    expect(loaded.providers).toHaveLength(1);
    expect(loaded.providers[0]?.id).toBe('groq');
    expect(loaded.providers[0]?.modelsCache?.models[0]?.npm).toBe('@ai-sdk/groq');
  });

  it('writes providers.json with restrictive permissions', () => {
    withRegistryWriteLockSync(() => saveRegistry(emptyRegistry()));
    const path = join(home, 'providers.json');
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('skips invalid provider entries on load', () => {
    const path = join(home, 'providers.json');
    const raw = {
      schemaVersion: 1,
      providers: [
        { id: 'BAD ID', templateId: 'x', name: 'X', enabled: true, authRef: 'k', api: {}, addedAt: 't' },
        {
          id: 'groq',
          templateId: 'groq',
          name: 'Groq',
          enabled: true,
          authRef: 'keyring:provider:groq',
          api: { npm: '@ai-sdk/groq' },
          addedAt: '2026-06-09T00:00:00.000Z',
        },
      ],
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRegistry(path);
    expect(loaded.providers).toHaveLength(1);
    expect(loaded.providers[0]?.id).toBe('groq');
  });

  it('does not publish a migration from partially invalid registry data', () => {
    const path = join(home, 'providers.json');
    const raw = {
      schemaVersion: 1,
      providers: [
        {
          id: 'openai',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring:oauth:provider:openai',
          authType: 'oauth',
          api: { npm: '@ai-sdk/openai' },
          addedAt: '2026-06-09T00:00:00.000Z',
        },
        {
          id: 'BAD ID',
          templateId: 'invalid',
          name: 'Invalid',
          enabled: true,
          authRef: 'keyring:provider:invalid',
          api: {},
          addedAt: '2026-06-09T00:00:00.000Z',
        },
      ],
    };
    const serialized = JSON.stringify(raw);
    mkdirSync(home, { recursive: true });
    writeFileSync(path, serialized);

    expect(loadRegistry(path).providers[0]?.id).toBe('openai-oauth');
    expect(() => loadRegistryStrict(path)).toThrow(
      'Provider registry contains an invalid provider entry.',
    );
    expect(() => toggleProviderEnabled('openai-oauth')).toThrow(
      'Provider registry contains an invalid provider entry.',
    );
    expect(readFileSync(path, 'utf8')).toBe(serialized);
  });

  it.each([
    ['subscriptionFilter', { subscriptionFilter: 'paid' }],
    ['authType', { authType: 'token' }],
    ['refreshedAt', { refreshedAt: 42 }],
    ['modelsCache metadata', { modelsCache: { fetchedAt: 42, models: [] } }],
    ['modelsCache entries', { modelsCache: {
      fetchedAt: '2026-06-09T00:00:00.000Z',
      models: [{ id: 'model-a' }, null],
    } }],
  ])('rejects malformed present %s without rewriting the registry', (_field, malformed) => {
    const path = join(home, 'providers.json');
    const raw = {
      schemaVersion: 1,
      providers: [{
        id: 'example',
        templateId: 'example',
        name: 'Example',
        enabled: true,
        authRef: 'keyring:provider:example',
        api: { npm: '@example/sdk' },
        addedAt: '2026-06-09T00:00:00.000Z',
        ...malformed,
      }],
    };
    const serialized = JSON.stringify(raw);
    mkdirSync(home, { recursive: true });
    writeFileSync(path, serialized);

    expect(() => loadRegistryStrict(path)).toThrow(
      'Provider registry contains an invalid provider entry.',
    );
    expect(() => toggleProviderEnabled('example')).toThrow(
      'Provider registry contains an invalid provider entry.',
    );
    expect(readFileSync(path, 'utf8')).toBe(serialized);
  });

  it('accepts unknown provider and model fields during strict loading', () => {
    const path = join(home, 'providers.json');
    const raw = {
      schemaVersion: 1,
      providers: [{
        id: 'example',
        templateId: 'example',
        name: 'Example',
        enabled: true,
        authRef: 'keyring:provider:example',
        api: { npm: '@example/sdk' },
        addedAt: '2026-06-09T00:00:00.000Z',
        futureProviderField: { revision: 2 },
        modelsCache: {
          fetchedAt: '2026-06-09T00:00:00.000Z',
          models: [{
            id: 'model-a',
            name: 'Model A',
            upstreamModelId: 'model-a',
            modelFormat: 'openai',
            futureModelField: 'supported',
          }],
        },
      }],
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(path, JSON.stringify(raw));

    expect(loadRegistryStrict(path).providers[0]?.id).toBe('example');
  });

  it('applies supported migrations only after strict validation', () => {
    const path = join(home, 'providers.json');
    const raw = {
      schemaVersion: 1,
      providers: [{
        id: 'openai',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai',
        authType: 'oauth',
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-06-09T00:00:00.000Z',
      }],
    };
    const serialized = JSON.stringify(raw);
    mkdirSync(home, { recursive: true });
    writeFileSync(path, serialized);

    expect(loadRegistryStrict(path).providers[0]?.id).toBe('openai-oauth');
    expect(readFileSync(path, 'utf8')).toBe(serialized);
  });

  it('serializes migration writes and reloads state after acquiring the lock', () => {
    const path = join(home, 'providers.json');
    const lockPath = `${path}.lock`;
    const raw = {
      schemaVersion: 1,
      providers: [{
        id: 'openai',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai',
        authType: 'oauth',
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-06-09T00:00:00.000Z',
      }],
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(path, JSON.stringify(raw));
    writeFileSync(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      token: 'dead-owner',
    }));

    const loaded = loadRegistry(path);
    const persisted = JSON.parse(readFileSync(path, 'utf8'));

    expect(loaded.providers[0]?.id).toBe('openai-oauth');
    expect(persisted.providers[0]?.id).toBe('openai-oauth');
    expect(existsSync(lockPath)).toBe(false);
  });

});

describe('materializeRegistry', () => {
  it('materializes enabled providers with credentials and models', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'openai',
      templateId: 'openai',
      name: 'OpenAI',
      enabled: true,
      authRef: 'keyring:provider:openai',
      authType: 'oauth',
      api: { npm: '@ai-sdk/openai' },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'gpt-5.5-fast',
          name: 'GPT-5.5 Fast',
          upstreamModelId: 'gpt-5.5',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai',
        }],
      },
    });
    const locals = materializeRegistry(registry, () => 'sk-test');
    expect(locals).toHaveLength(1);
    expect(locals[0]?.models[0]?.upstreamModelId).toBe('gpt-5.5');
    expect(locals[0]?.apiKey).toBe('sk-test');
    expect(locals[0]?.authType).toBe('oauth');
  });

  it('returns empty when credential missing', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:groq',
      authType: 'api',
      api: { npm: '@ai-sdk/groq' },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'llama',
          name: 'Llama',
          upstreamModelId: 'llama',
          modelFormat: 'openai',
          npm: '@ai-sdk/groq',
        }],
      },
    });
    expect(materializeRegistry(registry, () => null)).toHaveLength(0);
  });

  it('materializes explicit anonymous access without consulting a credential resolver', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'anonymous-provider',
      templateId: 'anonymous-provider',
      name: 'Anonymous Provider',
      enabled: true,
      authRef: 'none:anonymous',
      authType: 'none',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://anonymous.example/v1' },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'free-model',
          name: 'Free Model',
          upstreamModelId: 'free-model',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
        }],
      },
    });

    const locals = materializeRegistry(registry, () => {
      throw new Error('anonymous access must not resolve a credential');
    });

    expect(locals).toHaveLength(1);
    expect(locals[0]?.apiKey).toBe('');
    expect(locals[0]?.authRef).toBe('none:anonymous');
  });

  it('normalizes the current-main anonymous custom endpoint representation', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'legacy-custom',
      templateId: 'custom-openai',
      name: 'Legacy Custom',
      enabled: true,
      authRef: 'keyring:provider:legacy-custom',
      api: {
        npm: '@ai-sdk/openai-compatible',
        url: 'https://legacy-custom.example/v1',
      },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'local-model',
          name: 'Local Model',
          upstreamModelId: 'local-model',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
        }],
      },
    });

    const locals = materializeRegistry(registry, () => 'local');

    expect(locals).toHaveLength(1);
    expect(locals[0]?.apiKey).toBe('');
    expect(locals[0]?.authRef).toBe('none:anonymous');
    expect(locals[0]?.authType).toBe('none');
  });

  it('rejects an ambiguous local sentinel with a mismatched credential reference', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'legacy-custom',
      templateId: 'custom-openai',
      name: 'Legacy Custom',
      enabled: true,
      authRef: 'keyring:provider:other-provider',
      api: {
        npm: '@ai-sdk/openai-compatible',
        url: 'https://legacy-custom.example/v1',
      },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'local-model',
          name: 'Local Model',
          upstreamModelId: 'local-model',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
        }],
      },
    });

    expect(materializeRegistry(registry, () => 'local')).toHaveLength(0);
  });

  it('does not materialize a current-main anonymous candidate when its credential is missing', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'legacy-custom',
      templateId: 'custom-openai',
      name: 'Legacy Custom',
      enabled: true,
      authRef: 'keyring:provider:legacy-custom',
      api: {
        npm: '@ai-sdk/openai-compatible',
        url: 'https://legacy-custom.example/v1',
      },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'local-model',
          name: 'Local Model',
          upstreamModelId: 'local-model',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
        }],
      },
    });

    expect(materializeRegistry(registry, () => null)).toHaveLength(0);
  });

  it('preserves a real credential on a custom endpoint without authType', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'legacy-custom',
      templateId: 'custom-openai',
      name: 'Legacy Custom',
      enabled: true,
      authRef: 'keyring:provider:legacy-custom',
      api: {
        npm: '@ai-sdk/openai-compatible',
        url: 'https://legacy-custom.example/v1',
      },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'local-model',
          name: 'Local Model',
          upstreamModelId: 'local-model',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
        }],
      },
    });

    const locals = materializeRegistry(registry, () => 'sk-real-key');

    expect(locals).toHaveLength(1);
    expect(locals[0]?.apiKey).toBe('sk-real-key');
    expect(locals[0]?.authRef).toBe('keyring:provider:legacy-custom');
    expect(locals[0]?.authType).toBeUndefined();
  });

  it('marks NVIDIA imported models as free provider access', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'nvidia',
      templateId: 'nvidia',
      name: 'NVIDIA NIM',
      enabled: true,
      authRef: 'keyring:provider:nvidia',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://integrate.api.nvidia.com/v1' },
      addedAt: '2026-07-06T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-07-06T00:00:00.000Z',
        models: [{
          id: 'nvidia/llama-3.1-nemotron',
          name: 'NVIDIA Nemotron',
          upstreamModelId: 'nvidia/llama-3.1-nemotron',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
        }],
      },
    });

    const locals = materializeRegistry(registry, () => 'nvapi-test');

    expect(locals[0]?.models[0]).toMatchObject({
      isFree: true,
      freeStatus: 'free_provider',
    });
  });

  it('honors per-model npm and apiUrl overrides', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'custom-proxy',
      templateId: 'custom-openai',
      name: 'Custom Proxy',
      enabled: true,
      authRef: 'keyring:provider:custom-proxy',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://default.example/v1' },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'model-a',
          name: 'Model A',
          upstreamModelId: 'model-a',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
          apiUrl: 'https://override.example/v1',
        }],
      },
    });
    const locals = materializeRegistry(registry, () => 'key');
    expect(locals[0]?.models[0]?.apiBaseUrl).toBe('https://override.example/v1');
    expect(locals[0]?.models[0]?.completionsUrl).toBe('https://override.example/v1/chat/completions');
  });
});
