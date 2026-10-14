import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { loadRegistryProvidersSync } from '../src/registry/load.js';
import { getProvidersPath } from '../src/paths.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';

/**
 * A named ChatGPT account keeps its own catalog, and installs that refreshed it before
 * GPT-6.1 Sol's ChatGPT-plan band moved to 500K stored the API-key 272K band on that row.
 * Selecting the account, persistently or for one run, must not bring the old band back.
 */

let home: string;

function row(id: string, contextWindow: number): CachedModel {
  return {
    id,
    name: id,
    upstreamModelId: id,
    contextWindow,
    maxContextWindow: 872_000,
    pricingBoundary: 272_000,
    pricingBoundaryNote: 'Above it, OpenAI prices the full request at 2x input and 1.5x output.',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai',
  };
}

function providerWithWorkAccount(selection: 'persisted' | 'environment'): RegistryProvider {
  const addedAt = '2026-10-01T00:00:00.000Z';
  const work = {
    authRef: 'env:WORK_TOKEN',
    addedAt,
    modelsCache: { fetchedAt: addedAt, models: [row('gpt-6.1-sol', 500_000), row('gpt-6-sol', 272_000)] },
  };
  const provider: RegistryProvider = {
    id: 'openai-oauth', templateId: 'openai', name: 'OpenAI (ChatGPT)', enabled: true,
    authType: 'oauth', authRef: 'env:DEFAULT_TOKEN', api: { npm: '@ai-sdk/openai' }, addedAt,
    modelsCache: { fetchedAt: addedAt, models: [row('gpt-5.6-sol', 272_000)] },
    authAccounts: { work },
  };
  if (selection === 'persisted') {
    provider.activeAuthAccount = 'work';
    provider.defaultAuthRef = provider.authRef;
    provider.authRef = work.authRef;
    provider.modelsCache = work.modelsCache;
  } else {
    vi.stubEnv('CLODEX_OAUTH_ACCOUNT', 'work');
  }
  return provider;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clodex-oauth-pricing-slots-'));
  vi.stubEnv('CLODEX_HOME', home);
  vi.stubEnv('CLODEX_OAUTH_ACCOUNT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('GPT-6.1 Sol pricing on a named ChatGPT account', () => {
  it.each(['persisted', 'environment'] as const)(
    'replaces the stored 272K band when the account is selected (%s)',
    selection => {
      const registry = emptyRegistry();
      registry.providers.push(providerWithWorkAccount(selection));
      withRegistryWriteLockSync(() => saveRegistry(registry));
      const before = readFileSync(getProvidersPath(), 'utf8');

      const resolved: string[] = [];
      const [local] = loadRegistryProvidersSync((_id, authRef) => {
        resolved.push(authRef);
        return 'synthetic-token';
      });

      expect(resolved).toEqual(['env:WORK_TOKEN']);
      const byId = new Map(local?.models.map(model => [model.id, model]));
      expect([...byId.keys()]).toEqual(['gpt-6.1-sol', 'gpt-6-sol']);
      expect(byId.get('gpt-6.1-sol')).toMatchObject({ contextWindow: 500_000, pricingBoundary: 500_000 });
      expect(byId.get('gpt-6-sol')?.pricingBoundary).toBe(272_000);
      // Read-time only: the stored catalog is not rewritten.
      expect(readFileSync(getProvidersPath(), 'utf8')).toBe(before);
    },
  );
});
