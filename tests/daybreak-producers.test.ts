// From the catalog response to every alias resolver, through what clodex
// persists: refresh → providers.json → account selection → materialization →
// config.json → normalization → proxy, switch-menu and endpoint-server resolvers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshOpenAiOAuthModels } from '../src/registry/openai-oauth-catalog.js';
import { saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { loadRegistryProvidersSync } from '../src/registry/load.js';
import { savePreferences, loadPreferences } from '../src/config.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import { makeRouteResolver, resolveCatalogModelAliases } from '../src/catalog.js';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

vi.mock('../src/launch.js', async original => ({
  ...await original<typeof import('../src/launch.js')>(),
  getInstalledClaudeVersion: () => '2.1.300',
}));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CLODEX_OAUTH_ACCOUNT;
});

const BLUE = { cyber: 'daybreak_blue' };
const favorite = { providerId: 'openai-oauth', modelId: 'gpt-6-luna' };

function persist(registry: ProviderRegistry): void {
  withRegistryWriteLockSync(() => saveRegistry(registry));
}

function cache(models: CachedModel[]) {
  return { fetchedAt: '2026-10-13T00:00:00Z', models };
}

function provider(models: CachedModel[]): RegistryProvider {
  return {
    id: 'openai-oauth', templateId: 'openai-oauth', name: 'OpenAI (ChatGPT)', enabled: true,
    api: { npm: '@ai-sdk/openai' }, authRef: 'keyring:provider:openai-oauth', authType: 'oauth',
    addedAt: '2026-10-13T00:00:00Z', modelsCache: cache(models),
  };
}

function resolveAll() {
  const providers = loadRegistryProvidersSync((_id, ref) => `fake-${ref}`, { agent: 'claude' });
  const prefs = loadPreferences();
  const { routes, aliases } = buildHttpProxyRoutes(providers, prefs.favoriteModels!, prefs.modelAliases);
  const endpoint = resolveCatalogModelAliases(prefs.modelAliases, makeRouteResolver(providers), routes);
  const models = localProvidersToServerModels(providers);
  const gateway = createGatewayModelCatalog(models, undefined, prefs.modelAliases);
  return { providers, routes, aliases, endpoint, models, gateway };
}

function storeAliases(): void {
  savePreferences({
    favoriteModels: [favorite],
    modelAliases: [{ name: 'blue', ...favorite, daybreak: true }, { name: 'plain', ...favorite }],
  });
}

/** Refresh the catalog from a fake ChatGPT answer. `generalOnly` fails the Codex listing. */
async function discover(programs: string[], generalOnly = false, standardShape = false): Promise<CachedModel[]> {
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    if (generalOnly && String(url).includes('/codex/models')) return new Response('unavailable', { status: 503 });
    const row = { available_access_programs: { cyber: programs } };
    const body = standardShape
      ? { data: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', ...row }] }
      : { models: [{ slug: 'gpt-6-luna', title: 'GPT-6 Luna', ...row }] };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return (await refreshOpenAiOAuthModels('fake')).models;
}

describe('Daybreak eligibility from refresh to every resolver', () => {
  it.each([false, true])(
    'survives the general ChatGPT listing fallback (OpenAI-standard shape: %s)',
    async standardShape => {
      persist({ schemaVersion: 1, providers: [provider(await discover(['standard', 'daybreak_blue'], true, standardShape))] });
      storeAliases();
      const out = resolveAll();
      expect(out.routes).toHaveLength(1);
      expect(out.aliases.find(alias => alias.name === 'blue')?.accessPrograms).toEqual(BLUE);
      expect(out.endpoint.find(alias => alias.name === 'blue')?.accessPrograms).toEqual(BLUE);
      expect(out.gateway.get('blue')?.accessPrograms).toEqual(BLUE);
      expect(out.gateway.get('plain')?.accessPrograms).toBeUndefined();
      expect(out.models[0]!.accessPrograms).toBeUndefined();
    },
  );

  it('leaves a model id named like an alias to the model, as the endpoint server always has', async () => {
    persist({ schemaVersion: 1, providers: [provider(await discover(['standard', 'daybreak_blue']))] });
    savePreferences({ favoriteModels: [favorite], modelAliases: [{ name: 'gpt-6-luna', ...favorite, daybreak: true }] });
    const out = resolveAll();
    expect(out.gateway.get('gpt-6-luna')?.id).toBe('gpt-6-luna');
    expect(out.gateway.get('gpt-6-luna')?.accessPrograms).toBeUndefined();
    expect(out.models[0]!.accessPrograms).toBeUndefined();
  });

  it('uses the selected ChatGPT account\'s own eligibility', async () => {
    const eligible = await discover(['standard', 'daybreak_blue']);
    const ineligible = await discover(['standard']);
    const registryProvider = provider(eligible);
    registryProvider.authAccounts = {
      limited: { authRef: 'keyring:provider:openai-oauth:limited', addedAt: registryProvider.addedAt, modelsCache: cache(ineligible) },
      blue: { authRef: 'keyring:provider:openai-oauth:blue', addedAt: registryProvider.addedAt, modelsCache: cache(eligible) },
    };
    persist({ schemaVersion: 4, providers: [registryProvider] });
    storeAliases();

    process.env.CLODEX_OAUTH_ACCOUNT = 'limited';
    const limited = resolveAll();
    expect(limited.providers[0]!.authRef).toBe(registryProvider.authAccounts.limited!.authRef);
    expect(limited.aliases.find(alias => alias.name === 'blue')?.unavailableReason).toContain("isn't available");
    expect(limited.endpoint.find(alias => alias.name === 'blue')?.unavailableReason).toContain("isn't available");
    expect(limited.gateway.get('blue')).toBeUndefined();
    expect(limited.gateway.refusal?.('blue')).toContain("isn't available");

    process.env.CLODEX_OAUTH_ACCOUNT = 'blue';
    const blue = resolveAll();
    expect(blue.providers[0]!.authRef).toBe(registryProvider.authAccounts.blue!.authRef);
    expect(blue.aliases.find(alias => alias.name === 'blue')?.accessPrograms).toEqual(BLUE);
    expect(blue.endpoint.find(alias => alias.name === 'blue')?.accessPrograms).toEqual(BLUE);
    expect(blue.gateway.get('blue')?.accessPrograms).toEqual(BLUE);
  });
});
