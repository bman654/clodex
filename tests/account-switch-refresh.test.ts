import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProviderCredentialWithSource } from '../src/env.js';
import { setActiveOAuthAccount } from '../src/registry/crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { refreshProviderModelsWithCredential } from '../src/registry/refresh-models.js';

vi.mock('../src/registry/fetch-template-models.js', () => ({
  fetchTemplateModels: vi.fn(),
}));

import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';

describe('account-switch catalog lifecycle', () => {
  let home = '';
  const previousHome = process.env.CLODEX_HOME;
  const previousProviderOverride = process.env.CLODEX_KEY_GROQ;
  const previousAccountOverride = process.env.CLODEX_OAUTH_ACCOUNT;
  const previousStoredWorkToken = process.env.CLODEX_TEST_WORK_TOKEN;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-switch-refresh-'));
    process.env.CLODEX_HOME = home;
    delete process.env.CLODEX_KEY_GROQ;
    delete process.env.CLODEX_OAUTH_ACCOUNT;
    delete process.env.CLODEX_TEST_WORK_TOKEN;
    vi.mocked(fetchTemplateModels).mockReset();

    const registry = emptyRegistry();
    registry.providers.push({
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:default',
      authType: 'oauth',
      authAccounts: {
        work: {
          authRef: 'env:CLODEX_TEST_WORK_TOKEN',
          addedAt: '2026-08-09T00:00:00.000Z',
        },
        alt: {
          authRef: 'keyring:provider:alt',
          addedAt: '2026-08-09T00:00:00.000Z',
        },
      },
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      modelsCache: {
        fetchedAt: '2026-08-09T00:00:00.000Z',
        models: [{
          id: 'default-only-model',
          name: 'Default-only model',
          upstreamModelId: 'default-only-model',
          modelFormat: 'openai',
        }],
      },
      addedAt: '2026-08-09T00:00:00.000Z',
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    if (previousProviderOverride === undefined) delete process.env.CLODEX_KEY_GROQ;
    else process.env.CLODEX_KEY_GROQ = previousProviderOverride;
    if (previousAccountOverride === undefined) delete process.env.CLODEX_OAUTH_ACCOUNT;
    else process.env.CLODEX_OAUTH_ACCOUNT = previousAccountOverride;
    if (previousStoredWorkToken === undefined) delete process.env.CLODEX_TEST_WORK_TOKEN;
    else process.env.CLODEX_TEST_WORK_TOKEN = previousStoredWorkToken;
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps the switched cache empty when a provider-key override later disappears', async () => {
    expect(await setActiveOAuthAccount('groq', 'work')).toMatchObject({ changed: true });
    expect(loadRegistry().providers[0]).toMatchObject({
      authRef: 'env:CLODEX_TEST_WORK_TOKEN',
      defaultAuthRef: 'keyring:provider:default',
      activeAuthAccount: 'work',
    });
    expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
    process.env.CLODEX_KEY_GROQ = 'transient-provider-token';

    const result = await refreshProviderModelsWithCredential(
      'groq',
      provider => resolveProviderCredentialWithSource(provider.id, provider.authRef),
      null,
    );
    delete process.env.CLODEX_KEY_GROQ;

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: expect.stringContaining('CLODEX_KEY_GROQ is a process-scoped provider credential override'),
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
  });

  it('stores a one-process account catalog without repopulating the switched account cache', async () => {
    expect(await setActiveOAuthAccount('groq', 'work')).toMatchObject({ changed: true });
    process.env.CLODEX_OAUTH_ACCOUNT = 'alt';
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      models: [{
        id: 'alt-model',
        name: 'Alt model',
        upstreamModelId: 'alt-model',
        modelFormat: 'openai',
      }],
      baseUrl: 'https://api.groq.com/openai/v1',
    });

    const result = await refreshProviderModelsWithCredential(
      'groq',
      async () => 'transient-alt-token',
      'alt',
    );
    delete process.env.CLODEX_OAUTH_ACCOUNT;

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(fetchTemplateModels).toHaveBeenCalledOnce();
    const persisted = loadRegistry().providers[0]!;
    expect(persisted.authRef).toBe('env:CLODEX_TEST_WORK_TOKEN');
    expect(persisted.defaultAuthRef).toBe('keyring:provider:default');
    expect(persisted.modelsCache).toBeUndefined();
    expect(persisted.authAccounts?.alt?.modelsCache?.models[0]?.id).toBe('alt-model');
  });

  it('rebuilds the switched account cache while bypassing both process overrides', async () => {
    expect(await setActiveOAuthAccount('groq', 'work')).toMatchObject({ changed: true });
    process.env.CLODEX_OAUTH_ACCOUNT = 'alt';
    process.env.CLODEX_KEY_GROQ = 'temporary-provider-token';
    process.env.CLODEX_TEST_WORK_TOKEN = 'persisted-work-token';
    vi.mocked(fetchTemplateModels).mockResolvedValue({
      models: [{
        id: 'work-model',
        name: 'Work model',
        upstreamModelId: 'work-model',
        modelFormat: 'openai',
      }],
      baseUrl: 'https://api.groq.com/openai/v1',
    });

    const result = await refreshProviderModelsWithCredential(
      'groq',
      async provider => {
        expect(provider.authRef).toBe('env:CLODEX_TEST_WORK_TOKEN');
        return resolveProviderCredentialWithSource(
          provider.id,
          provider.authRef,
          undefined,
          { ignoreProviderOverride: true },
        );
      },
      null,
      { ignoreProviderOverride: true },
    );

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(fetchTemplateModels).toHaveBeenCalledOnce();
    const persisted = loadRegistry().providers[0]!;
    expect(persisted.authRef).toBe('env:CLODEX_TEST_WORK_TOKEN');
    expect(persisted.defaultAuthRef).toBe('keyring:provider:default');
    expect(persisted.modelsCache?.models.map(model => model.id)).toEqual([
      'work-model',
    ]);
    expect(persisted.authAccounts?.work?.modelsCache?.models[0]?.id).toBe('work-model');
  });

  it('restores the exact parked default when the persisted selection is cleared', async () => {
    expect(await setActiveOAuthAccount('groq', 'work')).toMatchObject({ changed: true });

    expect(await setActiveOAuthAccount('groq', undefined)).toMatchObject({ changed: true });

    const persisted = loadRegistry().providers[0]!;
    expect(persisted.authRef).toBe('keyring:provider:default');
    expect(persisted.defaultAuthRef).toBeUndefined();
    expect(persisted.defaultModelsCache).toBeUndefined();
    expect(persisted.activeAuthAccount).toBeUndefined();
    expect(persisted.modelsCache?.models.map(model => model.id)).toEqual([
      'default-only-model',
    ]);
  });
});
