import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as env from '../src/env.js';
import {
  formatRegistryAuthLabel,
  providersForPicker,
  resolveLocalProviderApiKey,
  resolveProvidersForDisplay,
} from '../src/provider-catalog.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';

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

    it('returns "anonymous" for providers declared authType none', async () => {
      const provider = { id: 'local', name: 'Local', apiKey: '', authType: 'none', models: [] } as any;
      expect(await resolveLocalProviderApiKey(provider)).toBe('anonymous');
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
      expect(await resolveLocalProviderApiKey(provider)).toBe('anonymous');
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
      expect(formatRegistryAuthLabel({
        id: 'legacy-local',
        authRef: 'keyring:provider:legacy-local',
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
  });
});
