import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_RESPONSES_LITE_VERSION } from '../src/constants.js';
import { refreshProviderModels, refreshProviderModelsWithCredential } from '../src/registry/refresh-models.js';
import { loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { applySelectedOAuthAccount, materializeRegistry, projectProviderCachedModels } from '../src/registry/materialize.js';
import type { RegistryProvider } from '../src/registry/types.js';

vi.mock('../src/launch.js', () => ({ getInstalledClaudeVersion: () => '2.1.999' }));
vi.mock('../src/registry/pricing.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/pricing.js')>(),
  enrichPricingAsync: vi.fn(),
}));

let home: string;
let provider: RegistryProvider;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clodex-codex-minimum-'));
  vi.stubEnv('CLODEX_HOME', home);
  vi.stubEnv('CLODEX_OAUTH_ACCOUNT', '');
  vi.stubGlobal('fetch', vi.fn());
  provider = {
    id: 'openai-oauth', templateId: 'openai', name: 'OpenAI (ChatGPT)', enabled: true,
    authRef: 'keyring:test-only', authType: 'oauth', api: { npm: '@ai-sdk/openai' },
    addedAt: '2026-09-22T00:00:00.000Z',
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function persistProvider() {
  withRegistryWriteLockSync(() => saveRegistry({ schemaVersion: 1, providers: [provider] }));
}
function catalog(body: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body)));
}
async function refresh() {
  return refreshProviderModels(reloaded().id, 'fake-token');
}
function reloaded() {
  return loadRegistryStrict().providers[0]!;
}
function offeredIds() {
  const registry = loadRegistryStrict();
  registry.providers = registry.providers.map(item => applySelectedOAuthAccount(item));
  return materializeRegistry(registry, () => 'fake-token')
    .flatMap(local => local.models.map(model => model.id));
}

describe('refresh -> persisted cache -> selectable OAuth catalog', () => {
  it.each(['models', 'data'] as const)(
    'warns and hides future models from the %s shape, preserving cached minimums', async shape => {
      persistProvider();
      const rows = [
        { id: 'future-model', minimal_client_version: '0.1000.0', use_responses_lite: true },
        { id: 'gpt-6-sol', minimal_client_version: '0.999.0', use_responses_lite: true },
        { id: 'equal-model', minimal_client_version: CODEX_RESPONSES_LITE_VERSION, use_responses_lite: true },
        { id: 'old-model', minimal_client_version: '0.9.0', use_responses_lite: true },
        { id: 'unknown-model', use_responses_lite: true },
        { id: 'bad-model', minimal_client_version: 999, use_responses_lite: true },
        { id: 'gpt-6-luna', minimal_client_version: null },
      ];
      catalog({ [shape]: rows.map(row => ({ ...row, slug: row.id })) });
      const result = await refresh();
      expect(result.ok).toBe(true);
      expect(result.reason).toContain('Hidden ChatGPT-plan models:');
      expect(result.reason).toContain('future-model (requires 0.1000.0)');
      expect(result.reason).toContain('gpt-6-sol (requires 0.999.0)');
      expect(result.reason).toContain(
        `clodex sends Codex client version ${CODEX_RESPONSES_LITE_VERSION} for Responses-Lite; `
        + 'their catalog minimum exceeds this version.',
      );
      expect(result.reason).toContain('Update clodex');
      expect(result.reason).not.toContain('old-model');
      expect(result.reason).not.toContain('equal-model');
      const saved = reloaded().modelsCache!.models;
      expect(saved).toHaveLength(7);
      expect(saved.find(model => model.id === 'future-model')?.minimalClientVersion).toBe('0.1000.0');
      expect(saved.find(model => model.id === 'gpt-6-sol')?.minimalClientVersion).toBe('0.999.0');
      expect(saved.find(model => model.id === 'gpt-6-luna')?.minimalClientVersion).toBe('0.155.0');
      expect(saved.find(model => model.id === 'bad-model')?.minimalClientVersion).toBeUndefined();
      expect(offeredIds()).toEqual(['equal-model', 'old-model', 'unknown-model', 'bad-model', 'gpt-6-luna']);
      expect(projectProviderCachedModels(reloaded()).map(model => model.id)).toEqual(offeredIds());
    },
  );

  it('applies the same warning and projection to the general-catalog fallback', async () => {
    persistProvider();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));
    catalog({ data: [{ id: 'future-model', minimal_client_version: '1.0.0', use_responses_lite: true }] });
    expect((await refresh()).reason).toContain('future-model (requires 1.0.0)');
    expect(offeredIds()).toEqual([]);
    expect(reloaded().modelsCache!.models[0]?.minimalClientVersion).toBe('1.0.0');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('warns on discovery outage without replacing an incompatible cached model with seeds', async () => {
    persistProvider();
    catalog({ models: [{ slug: 'future-model', minimal_client_version: '1.0.0', use_responses_lite: true }] });
    await refresh();
    const before = reloaded().modelsCache;
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const result = await refresh();
    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(result.reason).toContain('kept your existing cached model list');
    expect(result.reason).toContain('future-model (requires 1.0.0)');
    expect(reloaded().modelsCache).toEqual(before);
    expect(offeredIds()).toEqual([]);
  });

  it('keeps built-in minimums in an offline first refresh', async () => {
    persistProvider();
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const result = await refresh();
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('built-in fallback');
    expect(result.reason).not.toContain('Hidden');
    expect(reloaded().modelsCache!.models.find(model => model.id === 'gpt-6-sol')?.minimalClientVersion)
      .toBe('0.155.0');
    expect(offeredIds()).toContain('gpt-6-sol');
  });

  it('does not warn or hide models with supported, absent, or malformed minimums', async () => {
    persistProvider();
    catalog({ models: [
      { slug: 'gpt-6-sol', minimal_client_version: '0.9.0' },
      { slug: 'equal', minimal_client_version: `${CODEX_RESPONSES_LITE_VERSION}+build.1`, use_responses_lite: true },
      { slug: 'prerelease', minimal_client_version: `${CODEX_RESPONSES_LITE_VERSION}-rc.1`, use_responses_lite: true },
      { slug: 'absent', use_responses_lite: true },
      { slug: 'malformed', minimal_client_version: 'newest', use_responses_lite: true },
    ] });
    expect((await refresh()).reason).toBeUndefined();
    expect(reloaded().modelsCache!.models[0]?.minimalClientVersion).toBe('0.9.0');
    expect(offeredIds()).toEqual(['gpt-6-sol', 'equal', 'prerelease', 'absent', 'malformed']);
  });

  it.each([
    ['future-model', false, false],
    ['future-model', undefined, false],
    ['future-model', true, true],
    ['gpt-6-sol', false, false],
    ['gpt-6-sol', undefined, true],
    ['gpt-6-sol', true, true],
  ] as const)(
    'uses the resolved Lite flag for %s with catalog flag %s (hidden: %s)',
    async (id, lite, hidden) => {
      persistProvider();
      catalog({ models: [{ slug: id, minimal_client_version: '1.0.0', use_responses_lite: lite }] });
      const result = await refresh();
      const saved = reloaded().modelsCache!.models[0]!;
      expect(saved.minimalClientVersion).toBe('1.0.0');
      expect(saved.useResponsesLite).toBe(lite ?? (id === 'gpt-6-sol' ? true : undefined));
      if (hidden) {
        expect(result.reason).toContain(`${id} (requires 1.0.0)`);
      } else {
        expect(result.reason).toBeUndefined();
      }
      expect(offeredIds()).toEqual(hidden ? [] : [id]);
      expect(projectProviderCachedModels(reloaded()).map(model => model.id)).toEqual(hidden ? [] : [id]);
    },
  );

  it('clears incompatibility when a later catalog lowers the minimum', async () => {
    persistProvider();
    catalog({ models: [{ slug: 'gpt-6-sol', minimal_client_version: '1.0.0' }] });
    await refresh();
    expect(offeredIds()).toEqual([]);
    catalog({ models: [{ slug: 'gpt-6-sol', minimal_client_version: '0.155.0' }] });
    expect((await refresh()).reason).toBeUndefined();
    expect(offeredIds()).toEqual(['gpt-6-sol']);
  });

  it('fills known minimums in caches written before discovery preserved them', () => {
    provider.modelsCache = { fetchedAt: provider.addedAt, models: [{
      id: 'gpt-6-sol', name: 'GPT-6 Sol', upstreamModelId: 'gpt-6-sol', modelFormat: 'openai',
    }] };
    persistProvider();
    expect(projectProviderCachedModels(reloaded())[0]?.minimalClientVersion).toBe('0.155.0');
    expect(reloaded().modelsCache!.models[0]?.minimalClientVersion).toBeUndefined();
    expect(offeredIds()).toEqual(['gpt-6-sol']);
  });

  it('does not apply ChatGPT version restrictions to API-key providers', async () => {
    provider.id = 'openai';
    provider.authType = 'api';
    provider.modelsCache = { fetchedAt: provider.addedAt, models: [{
      id: 'future-model', name: 'Future', upstreamModelId: 'future-model',
      modelFormat: 'openai', minimalClientVersion: '1.0.0', useResponsesLite: true,
    }] };
    persistProvider();
    expect(offeredIds()).toEqual(['future-model']);
  });

  it('uses the same restriction for a legacy openai OAuth identity', async () => {
    provider.id = 'openai';
    persistProvider();
    catalog({ models: [{ slug: 'future-model', minimal_client_version: '1.0.0', use_responses_lite: true }] });
    expect((await refresh()).reason).toContain('Hidden ChatGPT-plan models');
    expect(offeredIds()).toEqual([]);
  });

  it('persists minimums in a named account cache without changing the default catalog', async () => {
    provider.authAccounts = { work: { authRef: 'keyring:work', addedAt: provider.addedAt } };
    persistProvider();
    catalog({ models: [{ slug: 'default-model', minimal_client_version: '0.9.0' }] });
    await refresh();
    catalog({ models: [{ slug: 'future-model', minimal_client_version: '1.0.0', use_responses_lite: true }] });
    const result = await refreshProviderModelsWithCredential(provider.id, async () => 'fake-token', 'work');
    expect(result.reason).toContain('future-model (requires 1.0.0)');
    expect(reloaded().authAccounts?.work?.modelsCache?.models[0]?.minimalClientVersion).toBe('1.0.0');
    expect(offeredIds()).toEqual(['default-model']);
    vi.stubEnv('CLODEX_OAUTH_ACCOUNT', 'work');
    expect(offeredIds()).toEqual([]);
  });

  it('makes control characters in model ids inert in warning output', async () => {
    persistProvider();
    catalog({ models: [{ slug: 'future\u001b[31m\nmodel', minimal_client_version: '1.0.0', use_responses_lite: true }] });
    const { reason } = await refresh();
    expect(reason).toContain('future [31m model (requires 1.0.0)');
    expect(reason).not.toMatch(/[\u001b\n]/);
  });
});
