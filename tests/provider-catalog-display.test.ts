import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as env from '../src/env.js';
import {
  formatRegistryAuthLabel,
  localProvidersToServerModels,
  providersForPicker,
  resolveLocalProviderApiKey,
  resolveProvidersForDisplay,
} from '../src/provider-catalog.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { getProvidersPath } from '../src/paths.js';

const TEST_HELPER_REF = `helper:v1:${'a'.repeat(64)}:oauth:provider:openai-oauth`;

describe('provider-catalog-display', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;
  const prevHelper = process.env.CLODEX_CREDENTIAL_HELPER;
  const prevProviderOverride = process.env.CLODEX_KEY_OPENAI_OAUTH;
  const prevAccountOverride = process.env.CLODEX_OAUTH_ACCOUNT;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-display-'));
    process.env.CLODEX_HOME = home;
    delete process.env.CLODEX_KEY_OPENAI_OAUTH;
    delete process.env.CLODEX_OAUTH_ACCOUNT;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prevHome;
    if (prevHelper === undefined) delete process.env.CLODEX_CREDENTIAL_HELPER;
    else process.env.CLODEX_CREDENTIAL_HELPER = prevHelper;
    if (prevProviderOverride === undefined) delete process.env.CLODEX_KEY_OPENAI_OAUTH;
    else process.env.CLODEX_KEY_OPENAI_OAUTH = prevProviderOverride;
    if (prevAccountOverride === undefined) delete process.env.CLODEX_OAUTH_ACCOUNT;
    else process.env.CLODEX_OAUTH_ACCOUNT = prevAccountOverride;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('providersForPicker', () => {
    it('sorts providers and models by name', () => {
      const list = providersForPicker([
        { id: 'b', name: 'B Provider', apiKey: '', models: [{ id: 'b2', name: 'Z Model', family: '', modelFormat: 'openai', contextWindow: 1 }, { id: 'b1', name: 'A Model', family: '', modelFormat: 'openai', contextWindow: 1 }] },
        { id: 'a', name: 'A Provider', apiKey: '', models: [] }
      ] as any);

      expect(list[0]?.id).toBe('a');
      expect(list[1]?.id).toBe('b');
      expect(list[1]?.models[0]?.id).toBe('b1');
    });
  });

  describe('resolveLocalProviderApiKey', () => {
    it('returns inline apiKey when present', async () => {
      const provider = { id: 'groq', name: 'Groq', apiKey: 'direct-key', models: [] } as any;
      expect(await resolveLocalProviderApiKey(provider)).toBe('direct-key');
    });

    it('resolves fallback via global OpenCode authRef when apiKey empty', async () => {
      vi.spyOn(env, 'resolveProviderCredential').mockResolvedValue('opencode-key');
      const registry = emptyRegistry();
      registry.providers.push({
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        enabled: true,
        authRef: 'keyring:provider:groq',
        api: { npm: '@ai-sdk/groq' },
        addedAt: new Date().toISOString(),
        modelsCache: { fetchedAt: new Date().toISOString(), models: [] },
      });
      withRegistryWriteLockSync(() => saveRegistry(registry));

      const provider = { id: 'groq', name: 'Groq', apiKey: '', models: [] } as any;
      expect(await resolveLocalProviderApiKey(provider)).toBe('opencode-key');
      expect(env.resolveProviderCredential).toHaveBeenCalledWith('groq', 'keyring:provider:groq');
    });

    it('returns an empty credential for providers declared authType none', async () => {
      const provider = { id: 'local', name: 'Local', apiKey: '', authType: 'none', models: [] } as any;
      expect(await resolveLocalProviderApiKey(provider)).toBe('');
    });

    it('does not resurrect a direct key for an explicitly anonymous provider', async () => {
      const provider = {
        id: 'local',
        name: 'Local',
        apiKey: 'stale-key',
        authRef: 'none:anonymous',
        authType: 'none',
        models: [],
      } as any;
      expect(await resolveLocalProviderApiKey(provider)).toBe('');
    });

    it('falls back to the OAuth keyring ref when there is no registry authRef and no zen/go/anonymous special case', async () => {
      vi.spyOn(env, 'resolveProviderCredential').mockResolvedValue('oauth-key');
      const provider = { id: 'openai', name: 'OpenAI', apiKey: '', models: [] } as any;
      expect(await resolveLocalProviderApiKey(provider)).toBe('oauth-key');
      expect(env.resolveProviderCredential).toHaveBeenCalledWith('openai', 'keyring:oauth:provider:openai');
    });

    it('uses the materialized authRef even when the current environment selects another store', async () => {
      vi.spyOn(env, 'resolveProviderCredential').mockResolvedValue('oauth-key');
      const provider = {
        id: 'openai-oauth',
        name: 'OpenAI (ChatGPT)',
        apiKey: '',
        authType: 'oauth',
        authRef: 'keyring:oauth:provider:openai-oauth',
        models: [],
      } as any;
      process.env.CLODEX_CREDENTIAL_HELPER = process.execPath;
      expect(await resolveLocalProviderApiKey(provider)).toBe('oauth-key');
      expect(env.resolveProviderCredential).toHaveBeenCalledWith(
        'openai-oauth',
        'keyring:oauth:provider:openai-oauth',
      );
    });
  });

  it('propagates exact credential references to server models for OAuth retry', () => {
    const models = localProvidersToServerModels([{
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      apiKey: 'access-token',
      authRef: TEST_HELPER_REF,
      authType: 'oauth',
      models: [{
        id: 'gpt-oauth-route',
        name: 'OAuth Route',
        family: 'gpt',
        brand: 'GPT',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-oauth-route',
      }],
    }]);

    expect(models[0]?.authRef).toBe(TEST_HELPER_REF);
  });

  it('propagates count-token compatibility to standalone server models', () => {
    const models = localProvidersToServerModels([{
      id: 'anthropic-compatible',
      name: 'Anthropic Compatible',
      apiKey: 'api-key',
      models: [{
        id: 'claude-count-tokens-disabled',
        name: 'Claude Count Tokens Disabled',
        family: 'claude',
        brand: 'Anthropic',
        modelFormat: 'anthropic',
        upstreamModelId: 'claude-count-tokens-disabled',
        compatibility: { supportsCountTokens: false },
      }],
    }]);

    expect(models[0]?.compatibility).toEqual({ supportsCountTokens: false });
    expect(models[0]?.id).toBe('claude-count-tokens-disabled');
  });

  describe('formatRegistryAuthLabel', () => {
    it('distinguishes OAuth, API key, and env refs', () => {
      expect(formatRegistryAuthLabel({
        authRef: 'keyring:oauth:provider:xai',
        authType: 'oauth',
      } as any)).toBe('keychain (OAuth)');
      expect(formatRegistryAuthLabel({
        authRef: 'keyring:provider:groq',
        authType: 'api',
      } as any)).toBe('keychain (API key)');
      expect(formatRegistryAuthLabel({
        authRef: TEST_HELPER_REF,
        authType: 'oauth',
      } as any)).toBe('helper (OAuth)');
      expect(formatRegistryAuthLabel({
        authRef: `helper:v1:${'b'.repeat(64)}:provider:groq`,
        authType: 'api',
      } as any)).toBe('helper (API key)');
      expect(formatRegistryAuthLabel({
        authRef: 'env:OPENAI_API_KEY',
      } as any)).toBe('env:OPENAI_API_KEY');
      expect(formatRegistryAuthLabel({
        authRef: 'none:anonymous',
        authType: 'none',
      } as any)).toBe('anonymous');
    });
  });

  describe('resolveProvidersForDisplay', () => {
    it('lists registry providers', async () => {
      const registry = emptyRegistry();
      registry.providers.push({
        id: 'groq',
        templateId: 'groq',
        name: 'Groq',
        enabled: true,
        authRef: 'keyring:provider:groq',
        api: { npm: '@ai-sdk/groq' },
        addedAt: new Date().toISOString(),
        modelsCache: { fetchedAt: new Date().toISOString(), models: [] },
      });
      withRegistryWriteLockSync(() => saveRegistry(registry));

      const entries = await resolveProvidersForDisplay();
      expect(entries.map(e => e.id)).toEqual(['groq']);
      expect(entries[0]?.name).toBe('Groq');
      expect(entries[0]?.inRegistry).toBe(true);
    });

    function saveSlotted(
      activeAuthAccount?: string,
      overrides: { enabled?: boolean; authType?: 'oauth' | 'api' | 'none' } = {},
    ): void {
      const registry = emptyRegistry();
      registry.providers.push({
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: overrides.enabled ?? true,
        authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: overrides.authType ?? 'oauth',
        authAccounts: {
          zachspartofaday: { authRef: 'keyring:oauth:provider:openai-oauth:account:zachspartofaday::credential::v1:z', addedAt: new Date().toISOString() },
        },
        ...(activeAuthAccount ? { activeAuthAccount } : {}),
        api: { npm: '@ai-sdk/openai' },
        addedAt: new Date().toISOString(),
      });
      if (activeAuthAccount) registry.schemaVersion = 3;
      if (activeAuthAccount && activeAuthAccount !== 'zachspartofaday'
        && (overrides.authType ?? 'oauth') === 'oauth') {
        // A current writer refuses to publish a broken v5 selector. Persist
        // genuine legacy v3 repair input to exercise the display path.
        writeFileSync(getProvidersPath(), `${JSON.stringify(registry, null, 2)}\n`);
        return;
      }
      withRegistryWriteLockSync(() => saveRegistry(registry));
    }

    it('marks which account a launch will actually use', async () => {
      saveSlotted('zachspartofaday');
      const entries = await resolveProvidersForDisplay();
      expect(entries[0]?.authLabel).toContain('accounts: (provider default), zachspartofaday (active)');
    });

    it('marks the provider default as active when nothing is stored', async () => {
      // Listing the slots without saying which one runs is what let a session
      // run as an unintended identity for hours without anything showing it.
      saveSlotted(undefined);
      const entries = await resolveProvidersForDisplay();
      expect(entries[0]?.authLabel).toContain('accounts: (provider default) (active), zachspartofaday');
    });

    it('reports the environment override, not the stored selection', async () => {
      // CLODEX_OAUTH_ACCOUNT wins at launch, so it must win here: showing the
      // stored one while a variable overrides it misreports the live identity
      // in exactly the persistent shell this listing exists to clarify.
      saveSlotted(undefined);
      process.env['CLODEX_OAUTH_ACCOUNT'] = 'zachspartofaday';
      try {
        const entries = await resolveProvidersForDisplay();
        expect(entries[0]?.authLabel).toContain('zachspartofaday (active, from CLODEX_OAUTH_ACCOUNT)');
        expect(entries[0]?.authLabel).not.toContain('(provider default) (active)');
      } finally {
        delete process.env['CLODEX_OAUTH_ACCOUNT'];
      }
    });

    it.each([true, false])(
      'counts only models cached for the temporary account when enabled=%s',
      async enabled => {
      const model = (id: string) => ({
        id,
        name: id,
        upstreamModelId: id,
        modelFormat: 'openai' as const,
      });
      const registry = emptyRegistry();
      registry.schemaVersion = 4;
      const workCache = {
        fetchedAt: '2026-08-09T00:00:00.000Z',
        models: [model('work-a'), model('work-b')],
      };
      registry.providers.push({
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled,
        authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: workCache,
          },
          alt: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:alt::credential::v1:a',
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: {
              fetchedAt: '2026-08-09T00:00:00.000Z',
              models: [model('alt-only')],
            },
          },
        },
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-08-09T00:00:00.000Z',
        modelsCache: workCache,
      });
      withRegistryWriteLockSync(() => saveRegistry(registry));
      process.env.CLODEX_OAUTH_ACCOUNT = 'alt';

      expect((await resolveProvidersForDisplay())[0]?.modelCount).toBe(1);
      },
    );

    it('counts only authority-backed retained models while preserving ordinary unknown models', async () => {
      const registry = emptyRegistry();
      registry.providers.push({
        id: 'imported-opencode',
        templateId: 'opencode-go',
        name: 'Imported OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:imported-opencode',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            upstreamModelId: 'deepseek-v4-pro',
            modelFormat: 'openai',
          }, {
            id: 'stale-future-model',
            name: 'Stale future model',
            upstreamModelId: 'stale-future-model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      });
      registry.providers.push({
        id: 'custom-provider',
        templateId: 'custom-openai',
        name: 'Custom provider',
        enabled: true,
        authRef: 'keyring:provider:custom-provider',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://custom.invalid/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'custom-unknown-model',
            name: 'Custom unknown model',
            upstreamModelId: 'custom-unknown-model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      });
      withRegistryWriteLockSync(() => saveRegistry(registry));

      const entries = await resolveProvidersForDisplay();
      expect(entries.find(entry => entry.id === 'imported-opencode')?.modelCount).toBe(1);
      expect(entries.find(entry => entry.id === 'custom-provider')?.modelCount).toBe(1);
    });

    it('does not count an OAuth account cache for a provider-key credential', async () => {
      const registry = emptyRegistry();
      registry.schemaVersion = 4;
      const workCache = {
        fetchedAt: '2026-08-09T00:00:00.000Z',
        models: [{
          id: 'work-only',
          name: 'Work only',
          upstreamModelId: 'work-only',
          modelFormat: 'openai' as const,
        }],
      };
      registry.providers.push({
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: workCache,
          },
        },
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-08-09T00:00:00.000Z',
        modelsCache: workCache,
      });
      withRegistryWriteLockSync(() => saveRegistry(registry));
      process.env.CLODEX_KEY_OPENAI_OAUTH = 'provider-override-token';

      expect((await resolveProvidersForDisplay())[0]?.modelCount).toBe(0);
    });

    it('reports the provider key as active without marking a slot active', async () => {
      saveSlotted('zachspartofaday');
      process.env.CLODEX_KEY_OPENAI_OAUTH = 'provider-override-token';

      const label = (await resolveProvidersForDisplay())[0]?.authLabel ?? '';

      expect(label).toContain('CLODEX_KEY_OPENAI_OAUTH (configured provider override');
      expect(label).toContain('no isolated model catalog');
      expect(label).toContain('zachspartofaday (selected; CLODEX_KEY_OPENAI_OAUTH configured; launch blocked');
      expect(label).not.toContain('zachspartofaday (active)');
      expect(label.match(/\(active\)/g)).toBeNull();
      expect(label).not.toContain('provider-override-token');
    });

    it('keeps a broken OAuth selection ahead of the configured provider key', async () => {
      saveSlotted('ghost');
      process.env.CLODEX_KEY_OPENAI_OAUTH = 'provider-override-token';

      const label = (await resolveProvidersForDisplay())[0]?.authLabel ?? '';

      expect(label).toContain('CLODEX_KEY_OPENAI_OAUTH is configured but blocked');
      expect(label).toContain('ghost (selected, MISSING — every launch fails)');
      expect(label).not.toContain('active provider override');
    });

    it('reports an environment override that names no existing slot as broken', async () => {
      // Corrected. This previously asserted the listing shows `zachspartofaday (active)`
      // — but applySelectedOAuthAccount THROWS on an override naming a missing
      // slot, so the listing was promising a launch that does not happen.
      saveSlotted('zachspartofaday');
      process.env['CLODEX_OAUTH_ACCOUNT'] = 'ghost';
      try {
        const label = (await resolveProvidersForDisplay())[0]?.authLabel ?? '';
        expect(label).toContain('ghost (selected via CLODEX_OAUTH_ACCOUNT, MISSING');
        expect(label).not.toContain('zachspartofaday (active)');
      } finally {
        delete process.env['CLODEX_OAUTH_ACCOUNT'];
      }
    });

    it('projects an invalid environment override for a disabled OAuth provider', async () => {
      saveSlotted('zachspartofaday', { enabled: false });
      process.env['CLODEX_OAUTH_ACCOUNT'] = 'ghost';
      try {
        const label = (await resolveProvidersForDisplay())[0]?.authLabel ?? '';
        expect(label).toContain('ghost (selected via CLODEX_OAUTH_ACCOUNT, MISSING');
        expect(label).toContain('will fail if this provider is enabled');
        expect(label).not.toContain('every launch fails');
      } finally {
        delete process.env['CLODEX_OAUTH_ACCOUNT'];
      }
    });

    it('does not claim a non-OAuth provider is merely disabled', async () => {
      saveSlotted('zachspartofaday', { authType: 'api' });
      const label = (await resolveProvidersForDisplay())[0]?.authLabel ?? '';
      expect(label).toContain('zachspartofaday (stored; provider is not OAuth)');
      expect(label).not.toContain('provider disabled');
    });

    it('does not confuse a slot literally named default with the provider default', async () => {
      // `default` is a valid slot name. Labelling the provider's own
      // credential "default" too would render two identical entries and mark
      // both active, leaving the listing unable to answer its only question.
      const registry = emptyRegistry();
      registry.schemaVersion = 3;
      registry.providers.push({
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: 'oauth',
        authAccounts: {
          default: { authRef: 'keyring:oauth:provider:openai-oauth:account:default::credential::v1:d', addedAt: new Date().toISOString() },
        },
        activeAuthAccount: 'default',
        api: { npm: '@ai-sdk/openai' },
        addedAt: new Date().toISOString(),
      });
      withRegistryWriteLockSync(() => saveRegistry(registry));

      const label = (await resolveProvidersForDisplay())[0]?.authLabel ?? '';
      expect(label).toContain('accounts: (provider default), default (active)');
      expect(label.match(/\(active\)/g)).toHaveLength(1);
    });
  });
});
