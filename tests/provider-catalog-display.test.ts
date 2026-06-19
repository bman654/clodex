import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as env from '../src/env.js';
import * as models from '../src/models.js';
import {
  formatRegistryAuthLabel,
  providersForPicker,
  resolveLocalProviderApiKey,
  resolveProvidersForDisplay,
  resolveZenGoAvailability,
  zenGoAsLocalProvider,
} from '../src/provider-catalog.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import { zenRegistryStub } from '../src/registry/builtins.js';
import { BACKENDS } from '../src/constants.js';
import type { ModelInfo } from '../src/types.js';

function mockZenGoModels(zen: ModelInfo[], go: ModelInfo[] = []) {
  vi.spyOn(models, 'getModels').mockImplementation(async backend => ({
    models: backend.id === 'zen' ? zen : backend.id === 'go' ? go : [],
    fromCache: false,
  }));
}

describe('providersForPicker', () => {
  const zenModel: ModelInfo = {
    id: 'claude-sonnet',
    name: 'Sonnet',
    brand: 'Claude',
    modelFormat: 'anthropic',
    sourceBackend: 'zen',
    isFree: true,
    contextWindow: 200000,
  };

  it('does not prepend zen stub when registry already has zen', () => {
    const zenFromRegistry = {
      id: 'zen',
      name: 'OpenCode Zen',
      apiKey: 'registry-key',
      models: [zenModel],
    } as import('../src/types.js').LocalProvider;

    const list = providersForPicker({
      localProviders: [zenFromRegistry],
      zenModels: [zenModel],
      goModels: [],
    });

    expect(list.filter(p => p.id === 'zen')).toHaveLength(1);
    expect(list[0]?.apiKey).toBe('registry-key');
  });
});

describe('resolveLocalProviderApiKey', () => {
  it('returns inline apiKey when present', async () => {
    const provider = zenGoAsLocalProvider('zen', []);
    provider.apiKey = 'direct-key';
    expect(await resolveLocalProviderApiKey(provider)).toBe('direct-key');
  });

  it('resolves zen stub via global OpenCode authRef when apiKey empty', async () => {
    vi.spyOn(env, 'resolveProviderCredential').mockResolvedValue('opencode-key');
    const provider = zenGoAsLocalProvider('zen', []);
    provider.apiKey = '';

    expect(await resolveLocalProviderApiKey(provider)).toBe('opencode-key');
    expect(env.resolveProviderCredential).toHaveBeenCalledWith('zen', 'keyring:global:opencode');
  });
});

describe('formatRegistryAuthLabel', () => {
  it('distinguishes OAuth, API key, and OpenCode key', () => {
    expect(formatRegistryAuthLabel({
      authRef: 'keyring:oauth:provider:xai',
      authType: 'oauth',
    })).toBe('keychain (OAuth)');
    expect(formatRegistryAuthLabel({
      authRef: 'keyring:provider:groq',
      authType: 'api',
    })).toBe('keychain (API key)');
    expect(formatRegistryAuthLabel({
      authRef: 'keyring:global:opencode',
    })).toBe('keychain (OpenCode API key)');
  });
});

describe('resolveProvidersForDisplay', () => {
  let home: string;
  const prevHome = process.env.RELAY_AI_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relay-ai-display-'));
    process.env.RELAY_AI_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RELAY_AI_HOME;
    else process.env.RELAY_AI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('shows Zen and Go as one OpenCode provider when the API key exists', async () => {
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
    saveRegistry(registry);

    vi.spyOn(env, 'readGlobalOpencodeCredential').mockResolvedValue('opencode-key');
    mockZenGoModels([
      { id: 'claude-sonnet', name: 'Sonnet', brand: 'Claude', modelFormat: 'anthropic', sourceBackend: 'zen', isFree: true, contextWindow: 200000 },
    ], [
      { id: 'deepseek', name: 'DeepSeek', brand: 'DeepSeek', modelFormat: 'openai', sourceBackend: 'go', isFree: false, contextWindow: 200000 },
    ]);

    const entries = await resolveProvidersForDisplay();
    expect(entries.map(e => e.id)).toEqual(['groq', 'opencode-cloud']);
    expect(entries[1]?.name).toBe('OpenCode Zen / Go');
    expect(entries[1]?.cloudBuiltin).toBe('opencode');
    expect(entries[1]?.modelCount).toBe(2);
  });

  it('does not show separate Zen and Go rows when registry stubs exist', async () => {
    const registry = emptyRegistry();
    registry.providers.push(zenRegistryStub(), {
      ...zenRegistryStub(),
      id: 'go',
      templateId: 'go',
      name: 'OpenCode Go',
    });
    saveRegistry(registry);

    vi.spyOn(env, 'readGlobalOpencodeCredential').mockResolvedValue('opencode-key');
    mockZenGoModels([
      { id: 'claude-sonnet', name: 'Sonnet', brand: 'Claude', modelFormat: 'anthropic', sourceBackend: 'zen', isFree: true, contextWindow: 200000 },
    ]);

    const entries = await resolveProvidersForDisplay();
    expect(entries.map(e => e.id)).toEqual(['opencode-cloud']);
    expect(entries[0]?.inRegistry).toBe(true);
  });
});

describe('resolveZenGoAvailability', () => {
  let home: string;
  const prevHome = process.env.RELAY_AI_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relay-ai-zen-go-'));
    process.env.RELAY_AI_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RELAY_AI_HOME;
    else process.env.RELAY_AI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports zen available when OpenCode key works even without registry stub', async () => {
    saveRegistry(emptyRegistry());
    vi.spyOn(env, 'readGlobalOpencodeCredential').mockResolvedValue('opencode-key');
    mockZenGoModels([
      { id: 'm1', name: 'M1', brand: 'Claude', modelFormat: 'anthropic', sourceBackend: 'zen', isFree: true, contextWindow: 1 },
    ]);

    expect(await resolveZenGoAvailability()).toEqual({ zen: true, go: false });
    expect(models.getModels).toHaveBeenCalledWith(BACKENDS.zen);
  });
});
