import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/launch.js', async original => ({
  ...await original<typeof import('../src/launch.js')>(),
  getInstalledClaudeVersion: () => '2.1.300',
}));

const { refreshOpenAiOAuthModels } = await import('../src/registry/openai-oauth-catalog.js');
const { cachedModelToLocal } = await import('../src/registry/materialize.js');
type CachedModel = import('../src/registry/types.js').CachedModel;
type RegistryProvider = import('../src/registry/types.js').RegistryProvider;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function serveCatalog(models: Record<string, unknown>[]): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ models }), { status: 200 })) as typeof fetch;
}

describe('ChatGPT Codex catalog', () => {
  it('records the access programs each model offers this account', async () => {
    serveCatalog([
      // Seeded id: the live answer is merged over the seed.
      { slug: 'gpt-6-luna', title: 'GPT-6 Luna', available_access_programs: { cyber: ['standard', 'daybreak_blue'] } },
      { slug: 'gpt-6.1-sol', title: 'GPT-6.1 Sol', available_access_programs: { cyber: ['standard'] } },
      // Not seeded: built from the live row alone.
      { slug: 'gpt-new', title: 'GPT New', available_access_programs: { cyber: ['daybreak_red', 'daybreak_purple'] } },
      { slug: 'gpt-quiet', title: 'GPT Quiet' },
    ]);
    const { models, source } = await refreshOpenAiOAuthModels('tok');
    expect(source).toBe('live');
    const programs = Object.fromEntries(models.map(model => [model.id, model.cyberAccessPrograms]));
    expect(programs).toEqual({
      'gpt-6-luna': ['standard', 'daybreak_blue'],
      'gpt-6.1-sol': ['standard'],
      'gpt-new': ['daybreak_red'],
      'gpt-quiet': undefined,
    });
  });

  it('has no program information when only the seed is available', async () => {
    globalThis.fetch = vi.fn(async () => new Response('down', { status: 503 })) as typeof fetch;
    const { models, source } = await refreshOpenAiOAuthModels('tok');
    expect(source).toBe('seed');
    expect(models.every(model => model.cyberAccessPrograms === undefined)).toBe(true);
  });
});

describe('the saved catalog', () => {
  const provider = {
    id: 'openai-oauth',
    templateId: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    enabled: true,
    authRef: 'keyring:provider:openai-oauth',
    authType: 'oauth',
    api: { npm: '@ai-sdk/openai' },
  } as RegistryProvider;
  const cached = (cyberAccessPrograms: unknown): CachedModel => ({
    id: 'gpt-6-luna', name: 'GPT-6 Luna', upstreamModelId: 'gpt-6-luna', modelFormat: 'openai',
    npm: '@ai-sdk/openai', cyberAccessPrograms,
  } as CachedModel);

  it('carries the programs onto the model routes are built from', () => {
    expect(cachedModelToLocal(cached(['standard', 'daybreak_blue']), provider)?.cyberAccessPrograms)
      .toEqual(['standard', 'daybreak_blue']);
    expect(cachedModelToLocal(cached(undefined), provider)?.cyberAccessPrograms).toBeUndefined();
  });

  it('re-validates programs read back from disk', () => {
    expect(cachedModelToLocal(cached(['daybreak_blue', 'nonsense', 3]), provider)?.cyberAccessPrograms)
      .toEqual(['daybreak_blue']);
    expect(cachedModelToLocal(cached('daybreak_blue'), provider)?.cyberAccessPrograms).toBeUndefined();
  });
});
