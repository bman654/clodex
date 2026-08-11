import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

const state = vi.hoisted(() => ({
  registry: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));
const credential = vi.hoisted(() => ({
  resolve: vi.fn(),
  accountId: vi.fn(),
  providerData: vi.fn(),
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderCredentialWithSource: credential.resolve,
  resolveProviderOAuthAccountId: credential.accountId,
  resolveProviderOAuthProviderData: credential.providerData,
}));

vi.mock('../src/registry/io.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/io.js')>(),
  loadRegistry: vi.fn(() => structuredClone(state.registry)),
}));

import { loadRegistryProviders } from '../src/registry/load.js';

function oauthProvider(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'openai-oauth',
    templateId: 'openai',
    name: 'OpenAI (ChatGPT)',
    enabled: true,
    authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
    authType: 'oauth',
    api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
    modelsCache: {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{
        id: 'gpt-test',
        name: 'GPT Test',
        upstreamModelId: 'gpt-test',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
      }],
    },
    addedAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('runtime registry credential attribution', () => {
  beforeEach(() => {
    state.registry = { schemaVersion: 1, providers: [oauthProvider()] };
    credential.resolve.mockReset();
    credential.accountId.mockReset().mockResolvedValue('selected-account-id');
    credential.providerData.mockReset().mockResolvedValue({ plan: 'pro' });
  });

  it('rejects a provider-override token before pairing it with selected-account metadata or models', async () => {
    state.registry = {
      schemaVersion: 3,
      providers: [oauthProvider({
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
      })],
    };
    credential.resolve.mockResolvedValue({
      credential: 'provider-override-token',
      credentialOverride: {
        variable: 'CLODEX_KEY_OPENAI_OAUTH',
        fingerprint: 'a'.repeat(64),
      },
    });

    const providers = await loadRegistryProviders();

    expect(providers).toHaveLength(0);
    expect(providers.blockedProviders.get('openai-oauth')).toMatch(
      /CLODEX_KEY_OPENAI_OAUTH is a process-scoped credential with no isolated model catalog.*Save that credential/s,
    );
    expect(credential.resolve).toHaveBeenCalledWith(
      'openai-oauth',
      'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
      undefined,
    );
    expect(credential.accountId).not.toHaveBeenCalled();
    expect(credential.providerData).not.toHaveBeenCalled();
    expect(state.registry.providers[0]?.modelsCache?.models[0]?.id).toBe('gpt-test');
  });

  it('does not pair an API-key provider override with its persisted catalog', async () => {
    state.registry = {
      schemaVersion: 1,
      providers: [oauthProvider({
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        authRef: 'keyring:provider:groq',
        authType: 'api',
        api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      })],
    };
    credential.resolve.mockResolvedValue({
      credential: 'provider-override-token',
      credentialOverride: {
        variable: 'CLODEX_KEY_GROQ',
        fingerprint: 'c'.repeat(64),
      },
    });

    const providers = await loadRegistryProviders();

    expect(providers).toHaveLength(0);
    expect(providers.blockedProviders.get('groq')).toMatch(
      /CLODEX_KEY_GROQ is a process-scoped credential with no isolated model catalog/,
    );
    expect(state.registry.providers[0]?.modelsCache?.models[0]?.id).toBe('gpt-test');
    expect(credential.accountId).not.toHaveBeenCalled();
    expect(credential.providerData).not.toHaveBeenCalled();
  });

  it('does not pair a provider override with a temporary account slot cache', async () => {
    const previous = process.env.CLODEX_OAUTH_ACCOUNT;
    state.registry = {
      schemaVersion: 4,
      providers: [oauthProvider({
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
          alt: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:alt::credential::v1:a',
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: {
              fetchedAt: '2026-08-09T01:00:00.000Z',
              models: [{
                id: 'alt-only',
                name: 'Alt only',
                upstreamModelId: 'alt-only',
                modelFormat: 'openai',
              }],
            },
          },
        },
      })],
    };
    process.env.CLODEX_OAUTH_ACCOUNT = 'alt';
    credential.resolve.mockResolvedValue({
      credential: 'provider-override-token',
      credentialOverride: {
        variable: 'CLODEX_KEY_OPENAI_OAUTH',
        fingerprint: 'd'.repeat(64),
      },
    });

    try {
      const providers = await loadRegistryProviders();
      expect(providers).toHaveLength(0);
      expect(providers.blockedProviders.get('openai-oauth')).toMatch(
        /CLODEX_KEY_OPENAI_OAUTH is a process-scoped credential with no isolated model catalog/,
      );
      expect(credential.resolve).toHaveBeenCalledWith(
        'openai-oauth',
        'keyring:oauth:provider:openai-oauth:account:alt::credential::v1:a',
        undefined,
      );
      expect(state.registry.providers[0]?.authAccounts?.alt?.modelsCache?.models[0]?.id)
        .toBe('alt-only');
      expect(state.registry.providers[0]?.modelsCache?.models[0]?.id).toBe('gpt-test');
    } finally {
      if (previous === undefined) delete process.env.CLODEX_OAUTH_ACCOUNT;
      else process.env.CLODEX_OAUTH_ACCOUNT = previous;
    }
  });

  it('isolates an enabled overridden provider while retaining unrelated runtime providers', async () => {
    state.registry = {
      schemaVersion: 1,
      providers: [
        oauthProvider(),
        oauthProvider({
          id: 'groq',
          templateId: 'groq',
          name: 'Groq',
          authRef: 'keyring:provider:groq',
          authType: 'api',
          api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
        }),
      ],
    };
    credential.resolve.mockImplementation(async (providerId: string) => providerId === 'openai-oauth'
      ? {
          credential: 'provider-override-token',
          credentialOverride: {
            variable: 'CLODEX_KEY_OPENAI_OAUTH',
            fingerprint: 'f'.repeat(64),
          },
        }
      : { credential: 'stored-groq-key' });

    const providers = await loadRegistryProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: 'groq', apiKey: 'stored-groq-key' });
    expect(providers.blockedProviders.get('openai-oauth')).toContain('no isolated model catalog');
    expect(providers.blockedProviders.has('groq')).toBe(false);
  });

  it('does not let an override on a disabled provider block other runtime providers', async () => {
    state.registry = {
      schemaVersion: 1,
      providers: [
        oauthProvider({ enabled: false }),
        oauthProvider({
          id: 'groq',
          templateId: 'groq',
          name: 'Groq',
          authRef: 'keyring:provider:groq',
          authType: 'api',
          api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
        }),
      ],
    };
    credential.resolve.mockImplementation(async (providerId: string) => providerId === 'openai-oauth'
      ? {
          credential: 'disabled-provider-override',
          credentialOverride: {
            variable: 'CLODEX_KEY_OPENAI_OAUTH',
            fingerprint: 'e'.repeat(64),
          },
        }
      : { credential: 'stored-groq-key' });

    const providers = await loadRegistryProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: 'groq', apiKey: 'stored-groq-key' });
    expect(providers[0]?.models.map(model => model.id)).toEqual(['gpt-test']);
  });

  it('retains selected-account metadata when the stored credential wins', async () => {
    credential.resolve.mockResolvedValue({ credential: 'stored-oauth-token' });

    const providers = await loadRegistryProviders();

    expect(providers[0]).toMatchObject({
      apiKey: 'stored-oauth-token',
      oauthAccountId: 'selected-account-id',
      providerData: { plan: 'pro' },
    });
    expect(credential.accountId).toHaveBeenCalledWith(
      'keyring:oauth:provider:openai-oauth::credential::v1:default',
      undefined,
    );
  });

  it('fails a broken OAuth selection before resolving the provider override', async () => {
    state.registry = {
      schemaVersion: 3,
      providers: [oauthProvider({
        activeAuthAccount: 'ghost',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
      })],
    };
    credential.resolve.mockResolvedValue({
      credential: 'provider-override-token',
      credentialOverride: {
        variable: 'CLODEX_KEY_OPENAI_OAUTH',
        fingerprint: 'b'.repeat(64),
      },
    });

    await expect(loadRegistryProviders()).rejects.toThrow(/no longer exists/);
    expect(credential.resolve).not.toHaveBeenCalled();
  });
});
