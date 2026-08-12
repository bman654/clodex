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
import {
  OPENCODE_GO_ANTHROPIC_BASE_URL,
  OPENCODE_GO_COMPLETIONS_BASE_URL,
} from '../src/data/opencode-go-models.js';

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
      preserveModelPricing: true,
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
    expect(loaded.providers[0]?.preserveModelPricing).toBe(true);
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

  it('diagnoses an invalid top-level model cache while retaining the provider', () => {
    const path = join(home, 'providers.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      providers: [{
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        enabled: true,
        authRef: 'keyring:provider:groq',
        authType: 'api',
        api: { npm: '@ai-sdk/groq' },
        addedAt: '2026-06-09T00:00:00.000Z',
        modelsCache: { fetchedAt: 42, models: [] },
      }],
    }));
    const diagnostics: string[] = [];

    const loaded = loadRegistry(path, message => diagnostics.push(message));

    expect(loaded.providers).toHaveLength(1);
    expect(loaded.providers[0]?.modelsCache).toBeUndefined();
    expect(diagnostics).toEqual([
      'Provider registry dropped an invalid model cache for provider "groq".',
    ]);
  });

  it('diagnoses an inconsistent materialized account instead of silently dropping it', () => {
    const path = join(home, 'providers.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 5,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: 'keyring:provider:work',
        defaultAuthRef: 'keyring:provider:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:provider:work',
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: {
              fetchedAt: '2026-08-09T00:00:00.000Z',
              models: [{ id: 'work-model' }],
            },
          },
        },
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-08-09T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-08-09T00:00:00.000Z',
          models: [{ id: 'different-model' }],
        },
      }],
    }));
    const diagnostics: string[] = [];

    expect(loadRegistry(path, message => diagnostics.push(message)).providers).toEqual([]);
    expect(diagnostics).toEqual([
      'Provider registry dropped invalid provider "openai-oauth" because its OAuth account selection storage is inconsistent.',
    ]);
  });

  it('diagnoses malformed registry JSON before falling back to empty', () => {
    const path = join(home, 'providers.json');
    writeFileSync(path, '{not-json');
    const diagnostics: string[] = [];

    expect(loadRegistry(path, message => diagnostics.push(message)).providers).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(`Could not read the provider registry at ${path}; treating it as empty:`);
  });

  it('loads both selected and parked provider-default catalogs from schema v5', () => {
    const path = join(home, 'providers.json');
    const workCache = {
      fetchedAt: '2026-08-09T01:00:00.000Z',
      models: [{ id: 'work-model' }],
    };
    const defaultCache = {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{ id: 'default-model' }],
    };
    writeFileSync(path, JSON.stringify({
      schemaVersion: 5,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: 'keyring:provider:work',
        defaultAuthRef: 'keyring:provider:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:provider:work',
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: workCache,
          },
        },
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-08-09T00:00:00.000Z',
        modelsCache: workCache,
        defaultModelsCache: defaultCache,
      }],
    }));

    const provider = loadRegistryStrict(path).providers[0]!;
    expect(provider.modelsCache?.models[0]?.id).toBe('work-model');
    expect(provider.defaultModelsCache?.models[0]?.id).toBe('default-model');
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
          modalities: ['text', 'image'],
          compatibility: {
            reasoningEffortMap: { high: 'max' },
            thinkingFormat: 'deepseek',
          },
        }],
      },
    });
    const locals = materializeRegistry(registry, () => 'sk-test');
    expect(locals).toHaveLength(1);
    expect(locals[0]?.models[0]?.upstreamModelId).toBe('gpt-5.5');
    expect(locals[0]?.models[0]?.modalities).toEqual(['text', 'image']);
    expect(locals[0]?.models[0]?.compatibility).toEqual({
      reasoningEffortMap: { high: 'max' },
      thinkingFormat: 'deepseek',
    });
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

  it('pins OpenCode OpenAI-compatible models to the reviewed completions authority', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://provider-sentinel.invalid/v1' },
      addedAt: '2026-08-11T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-08-11T00:00:00.000Z',
        models: [{
          id: 'compatible-sentinel',
          name: 'Compatible Sentinel',
          upstreamModelId: 'compatible-sentinel',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
          apiUrl: 'https://model-sentinel.invalid/v1',
        }],
      },
    });

    const model = materializeRegistry(registry, () => 'credential-sentinel')[0]?.models[0];

    expect(model?.apiBaseUrl).toBe(OPENCODE_GO_COMPLETIONS_BASE_URL);
    expect(model?.completionsUrl).toBe(`${OPENCODE_GO_COMPLETIONS_BASE_URL}/chat/completions`);
  });

  it('pins OpenCode Anthropic models to the reviewed Anthropic authority', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://provider-sentinel.invalid/v1' },
      addedAt: '2026-08-11T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-08-11T00:00:00.000Z',
        models: [{
          id: 'anthropic-sentinel',
          name: 'Anthropic Sentinel',
          upstreamModelId: 'anthropic-sentinel',
          modelFormat: 'anthropic',
          npm: '@ai-sdk/anthropic',
          apiUrl: 'https://model-sentinel.invalid/v1',
        }],
      },
    });

    const model = materializeRegistry(registry, () => 'credential-sentinel')[0]?.models[0];

    expect(model?.apiBaseUrl).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
    expect(model?.baseUrl).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
  });

  it('fails closed for an unsupported OpenCode SDK package', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://provider-sentinel.invalid/v1' },
      addedAt: '2026-08-11T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-08-11T00:00:00.000Z',
        models: [{
          id: 'unsupported-sentinel',
          name: 'Unsupported Sentinel',
          upstreamModelId: 'unsupported-sentinel',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai',
          apiUrl: 'https://model-sentinel.invalid/v1',
        }],
      },
    });

    expect(materializeRegistry(registry, () => 'credential-sentinel')).toEqual([]);
  });

  it('scopes immutable endpoint selection to OpenCode while preserving ordinary custom endpoints', () => {
    const registry = emptyRegistry();
    registry.providers.push(
      {
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode-provider-sentinel.invalid/v1' },
        addedAt: '2026-08-11T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-08-11T00:00:00.000Z',
          models: [{
            id: 'opencode-sentinel',
            name: 'OpenCode Sentinel',
            upstreamModelId: 'opencode-sentinel',
            modelFormat: 'openai',
            npm: '@ai-sdk/openai-compatible',
            apiUrl: 'https://opencode-model-sentinel.invalid/v1',
          }],
        },
      },
      {
        id: 'ordinary-provider',
        templateId: 'custom-openai',
        name: 'Ordinary Provider',
        enabled: true,
        authRef: 'keyring:provider:ordinary-provider',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://ordinary-provider.invalid/v1' },
        addedAt: '2026-08-11T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-08-11T00:00:00.000Z',
          models: [{
            id: 'ordinary-sentinel',
            name: 'Ordinary Sentinel',
            upstreamModelId: 'ordinary-sentinel',
            modelFormat: 'openai',
            npm: '@ai-sdk/openai-compatible',
            apiUrl: 'https://ordinary-model.invalid/v1',
          }],
        },
      },
    );

    const locals = materializeRegistry(registry, () => 'credential-sentinel');

    expect(locals[0]?.models[0]?.apiBaseUrl).toBe(OPENCODE_GO_COMPLETIONS_BASE_URL);
    expect(locals[1]?.models[0]?.apiBaseUrl).toBe('https://ordinary-model.invalid/v1');
    expect(locals[1]?.models[0]?.completionsUrl).toBe('https://ordinary-model.invalid/v1/chat/completions');
  });

  it('pins OpenCode endpoints for a record that drifts its id but keeps the template', () => {
    // Nothing couples `id` to `templateId`, and `authRef` still names the
    // keyring slot holding the OpenCode credential — so an id-drifted record
    // is the same secret pointed at a different address.
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'opencode-go-mirror',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://provider-sentinel.invalid/v1' },
      addedAt: '2026-08-11T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-08-11T00:00:00.000Z',
        models: [
          {
            id: 'compatible-sentinel',
            name: 'Compatible Sentinel',
            upstreamModelId: 'compatible-sentinel',
            modelFormat: 'openai',
            npm: '@ai-sdk/openai-compatible',
            apiUrl: 'https://model-sentinel.invalid/v1',
          },
          {
            id: 'anthropic-sentinel',
            name: 'Anthropic Sentinel',
            upstreamModelId: 'anthropic-sentinel',
            modelFormat: 'anthropic',
            npm: '@ai-sdk/anthropic',
            apiUrl: 'https://model-sentinel.invalid/v1',
          },
          {
            id: 'unsupported-sentinel',
            name: 'Unsupported Sentinel',
            upstreamModelId: 'unsupported-sentinel',
            modelFormat: 'openai',
            npm: '@ai-sdk/openai',
            apiUrl: 'https://model-sentinel.invalid/v1',
          },
        ],
      },
    });

    const models = materializeRegistry(registry, () => 'credential-sentinel')[0]?.models;

    // Destination assertions first, so a regression names the address the
    // credential would have reached rather than the fail-closed count.
    expect(models?.[0]?.apiBaseUrl).toBe(OPENCODE_GO_COMPLETIONS_BASE_URL);
    expect(models?.[0]?.completionsUrl).toBe(`${OPENCODE_GO_COMPLETIONS_BASE_URL}/chat/completions`);
    expect(models?.[1]?.apiBaseUrl).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
    expect(models?.[1]?.baseUrl).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
    expect(models?.map(model => model.id)).toEqual(['compatible-sentinel', 'anthropic-sentinel']);
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
