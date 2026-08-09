import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE } from '../src/anthropic-beta-policy.js';

const TEST_HELPER_REF = `helper:v1:${'a'.repeat(64)}:oauth:provider:openai-oauth`;

describe('provider-catalog-display', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;
  const prevHelper = process.env.CLODEX_CREDENTIAL_HELPER;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-display-'));
    process.env.CLODEX_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prevHome;
    if (prevHelper === undefined) delete process.env.CLODEX_CREDENTIAL_HELPER;
    else process.env.CLODEX_CREDENTIAL_HELPER = prevHelper;
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

  it('carries only proven native Claude Code beta provenance into server routes', () => {
    const model = {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      family: 'claude',
      brand: 'Anthropic',
      modelFormat: 'anthropic' as const,
      upstreamModelId: 'claude-sonnet-4-6',
      baseUrl: 'https://api.anthropic.com',
    };
    const models = localProvidersToServerModels([
      {
        id: 'claude-code',
        name: 'Claude Code',
        apiKey: 'oauth-token',
        authType: 'oauth',
        models: [model],
      },
      {
        id: 'generic-oauth',
        name: 'Generic OAuth',
        apiKey: 'oauth-token',
        authType: 'oauth',
        models: [{ ...model, id: 'generic-sonnet' }],
      },
    ]);

    expect(models[0]?.anthropicBetaProvenance).toBe(
      NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE,
    );
    expect(models[1]?.anthropicBetaProvenance).toBeUndefined();
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

    it('counts only effective committed OpenCode Go cache membership', async () => {
      const registry = emptyRegistry();
      registry.providers.push({
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
        addedAt: new Date().toISOString(),
        modelsCache: {
          fetchedAt: new Date().toISOString(),
          models: [
            { id: 'qwen3.6-plus', name: 'Qwen', upstreamModelId: 'qwen3.6-plus', modelFormat: 'openai' },
            { id: 'gpt-5.6-luna', name: 'Luna', upstreamModelId: 'gpt-5.6-luna', modelFormat: 'openai' },
            { id: 'unknown', name: 'Unknown', upstreamModelId: 'unknown', modelFormat: 'openai' },
          ],
        },
      }, {
        id: 'custom-go',
        templateId: 'custom-openai',
        name: 'Custom Go',
        enabled: true,
        authRef: 'keyring:provider:custom-go',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
        addedAt: new Date().toISOString(),
        modelsCache: {
          fetchedAt: new Date().toISOString(),
          models: [
            { id: 'qwen3.6-plus', name: 'Qwen', upstreamModelId: 'qwen3.6-plus', modelFormat: 'openai' },
            { id: 'gpt-5.6-luna', name: 'Luna', upstreamModelId: 'gpt-5.6-luna', modelFormat: 'openai' },
            { id: 'unknown', name: 'Unknown', upstreamModelId: 'unknown', modelFormat: 'openai' },
          ],
        },
      });
      withRegistryWriteLockSync(() => saveRegistry(registry));

      const entries = await resolveProvidersForDisplay();
      expect(entries.map(entry => [entry.id, entry.modelCount])).toEqual([
        ['custom-go', 3],
        ['opencode-go', 1],
      ]);
    });
  });
});
