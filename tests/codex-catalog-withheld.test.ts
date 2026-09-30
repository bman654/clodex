import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexClientVersionWarning, compareCodexClientVersions } from '../src/codex-client-version.js';
import { CODEX_RESPONSES_LITE_VERSION } from '../src/constants.js';
import { buildDesiredPatchConfig } from '../src/patcher.js';
import { refreshProviderModels, refreshProviderModelsWithCredential } from '../src/registry/refresh-models.js';
import { loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { setActiveOAuthAccount } from '../src/registry/crud.js';
import { applySelectedOAuthAccount, materializeRegistry, projectProviderCachedModels } from '../src/registry/materialize.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';

// The request version clodex sends is a build-time constant. Overriding it here
// stands in for installing a clodex release with a different pin; the getter is
// read at every use, so a test can change releases between refresh and projection.
const pin = vi.hoisted(() => ({ override: undefined as string | undefined }));
vi.mock('../src/constants.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/constants.js')>();
  return {
    ...actual,
    get CODEX_RESPONSES_LITE_VERSION() {
      return pin.override ?? actual.CODEX_RESPONSES_LITE_VERSION;
    },
  };
});
const CLAUDE_VERSION = '2.1.999';
vi.mock('../src/launch.js', () => ({ getInstalledClaudeVersion: () => '2.1.999' }));
vi.mock('../src/registry/pricing.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/pricing.js')>(),
  enrichPricingAsync: vi.fn(),
}));

const CODEX_MODELS = 'https://chatgpt.com/backend-api/codex/models';
const GENERAL_MODELS = 'https://chatgpt.com/backend-api/models';

/**
 * A catalog row plus the client version the fake backend actually gates it on.
 * The live endpoint lists a model only when `client_version` reaches that gate,
 * which can be above the `minimal_client_version` it publishes (#298).
 */
interface Row {
  slug: string;
  gate: string;
  minimal_client_version?: string;
  use_responses_lite?: boolean;
}

// Measured on a Plus account on 2026-09-29: gpt-6.1-sol publishes 0.153.0 but is
// omitted from the catalog, and its requests refused, below 0.159.0.
const SOL_61: Row = { slug: 'gpt-6.1-sol', gate: '0.159.0', minimal_client_version: '0.153.0', use_responses_lite: true };
const SOL_6: Row = { slug: 'gpt-6-sol', gate: '0.155.0', minimal_client_version: '0.155.0', use_responses_lite: true };
const GPT_55: Row = { slug: 'gpt-5.5', gate: '0.124.0', minimal_client_version: '0.124.0', use_responses_lite: false };

type Reply = (init?: RequestInit) => Promise<Response>;

interface CatalogOptions {
  /** Bearer tokens the fake accepts; any other request is answered 401. */
  tokens?: string[];
  /** Replaces the answer at Claude Code's version (discovery's own fetch). */
  firstReply?: Reply;
  /** Replaces the answer at any other version (the version clodex sends). */
  pinnedReply?: Reply;
  /** Answers the general ChatGPT catalog (the tier-2 fallback), which otherwise fails. */
  generalReply?: Reply;
}

/** Answer the Codex catalog per `client_version`, like the live endpoint. */
function serveCatalog(rows: Row[], { tokens = ['fake-token'], firstReply, pinnedReply, generalReply }: CatalogOptions = {}) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const endpoint = `${url.origin}${url.pathname}`;
    if (endpoint !== CODEX_MODELS && !(endpoint === GENERAL_MODELS && generalReply)) {
      throw new Error(`unexpected fetch ${url.href}`);
    }
    const auth = new Headers(init?.headers).get('authorization');
    if (!tokens.some(token => auth === `Bearer ${token}`)) {
      return new Response('{"detail":"Unauthorized"}', { status: 401 });
    }
    if (endpoint === GENERAL_MODELS) return generalReply!(init);
    const version = url.searchParams.get('client_version') ?? '';
    if (version === CLAUDE_VERSION && firstReply) return firstReply(init);
    if (version !== CLAUDE_VERSION && pinnedReply) return pinnedReply(init);
    return Response.json({
      models: rows
        .filter(({ gate }) => (compareCodexClientVersions(version, gate) ?? -1) >= 0)
        .map(({ gate: _gate, ...row }) => ({ ...row, title: row.slug })),
    });
  });
}
function requestHeaders(call: number): Record<string, string> {
  return Object.fromEntries(new Headers(vi.mocked(fetch).mock.calls[call]?.[1]?.headers));
}
function requestedVersions(): string[] {
  return vi.mocked(fetch).mock.calls
    .map(([input]) => new URL(String(input)))
    .filter(url => `${url.origin}${url.pathname}` === CODEX_MODELS)
    .map(url => url.searchParams.get('client_version') ?? '');
}

/** Second answers that carry no evidence about which models the version clodex sends is offered. */
const UNUSABLE_ANSWERS: Array<[string, Reply]> = [
  ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ['HTTP 500', async () => new Response('upstream error', { status: 500 })],
  ['HTTP 503', async () => new Response('upstream unavailable', { status: 503 })],
  ['HTTP 429', async () => new Response('rate limited', { status: 429 })],
  ['HTTP 403', async () => new Response('forbidden', { status: 403 })],
  ['malformed JSON', async () => new Response('{"models": [', { status: 200 })],
  ['an empty catalog', async () => Response.json({ models: [] })],
  ['a catalog of null entries', async () => Response.json({ models: [null] })],
  ['a data-shaped catalog of null entries', async () => Response.json({ data: [null] })],
  ['entries with no string id', async () => Response.json({ models: [null, 5, {}, [], { slug: ['gpt-5.5'] }, { slug: 7 }] })],
  ['data entries with no string id', async () => Response.json({ data: [{ id: 5 }, { id: ['gpt-5.5'] }, { name: 'x' }] })],
  ['an empty-string id', async () => Response.json({ models: [{ slug: '' }] })],
  ['a whitespace-only id', async () => Response.json({ models: [{ slug: '  ' }] })],
  // Partially malformed: a valid id alongside a row that names nothing usable.
  ['a valid id and a non-string id', async () => Response.json({ models: [{ slug: 'gpt-6-sol' }, { slug: ['gpt-6.1-sol'] }] })],
  ['a valid id and a null row', async () => Response.json({ models: [{ slug: 'gpt-6-sol' }, null] })],
  ['a valid id and a whitespace-only id', async () => Response.json({ models: [{ slug: 'gpt-6-sol' }, { slug: ' ' }] })],
  ['a valid id and an empty-string id', async () => Response.json({ models: [{ slug: 'gpt-6-sol' }, { slug: '' }] })],
  ['valid ids and an id with trailing whitespace', async () => Response.json({ models: [{ slug: 'gpt-6-sol' }, { slug: 'gpt-6.1-sol ' }, { slug: 'gpt-5.5' }] })],
  ['a data-shaped id with leading whitespace', async () => Response.json({ data: [{ id: ' gpt-6.1-sol' }] })],
  ['a data-shaped valid id and a numeric id', async () => Response.json({ data: [{ id: 'gpt-6-sol' }, { id: 5 }] })],
  ['a body that is not a catalog', async () => Response.json({ detail: 'unavailable' })],
];

let home: string;
let provider: RegistryProvider;
beforeEach(() => {
  pin.override = undefined;
  home = mkdtempSync(join(tmpdir(), 'clodex-codex-withheld-'));
  vi.stubEnv('CLODEX_HOME', home);
  vi.stubEnv('CLODEX_OAUTH_ACCOUNT', '');
  vi.stubGlobal('fetch', vi.fn());
  provider = {
    id: 'openai-oauth', templateId: 'openai', name: 'OpenAI (ChatGPT)', enabled: true,
    authRef: 'keyring:test-only', authType: 'oauth', api: { npm: '@ai-sdk/openai' },
    addedAt: '2026-09-29T00:00:00.000Z',
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  pin.override = undefined;
  rmSync(home, { recursive: true, force: true });
});

function persistProvider() {
  withRegistryWriteLockSync(() => saveRegistry({ schemaVersion: 1, providers: [provider] }));
}
function reloaded() {
  return loadRegistryStrict().providers[0]!;
}
function saved(id: string): CachedModel | undefined {
  return reloaded().modelsCache!.models.find(model => model.id === id);
}
async function refresh() {
  return refreshProviderModels(reloaded().id, 'fake-token');
}
function offeredIds() {
  const registry = loadRegistryStrict();
  registry.providers = registry.providers.map(item => applySelectedOAuthAccount(item));
  const materialized = materializeRegistry(registry, () => 'fake-token')
    .flatMap(local => local.models.map(model => model.id));
  expect(projectProviderCachedModels(applySelectedOAuthAccount(reloaded())).map(model => model.id))
    .toEqual(materialized);
  return materialized;
}

describe('refresh at the request version -> persisted marker -> selectable OAuth catalog', () => {
  it('marks and hides nothing when the catalog lists every model at the version clodex sends', async () => {
    persistProvider();
    serveCatalog([SOL_61, SOL_6, GPT_55]);
    const result = await refresh();
    expect(result).toMatchObject({ ok: true, modelCount: 3 });
    expect(result.reason).toBeUndefined();
    expect(requestedVersions()).toEqual([CLAUDE_VERSION, CODEX_RESPONSES_LITE_VERSION]);
    expect(reloaded().modelsCache!.models.map(model => model.withheldAtClientVersion))
      .toEqual([undefined, undefined, undefined]);
    expect(offeredIds()).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5']);
  });

  it('hides a Responses-Lite model withheld at the version clodex sends, though its minimum is lower', async () => {
    pin.override = '0.156.0';
    persistProvider();
    serveCatalog([SOL_61, SOL_6, GPT_55]);
    const result = await refresh();
    expect(result.ok).toBe(true);
    expect(requestedVersions()).toEqual([CLAUDE_VERSION, '0.156.0']);
    expect(requestHeaders(1)).toEqual(requestHeaders(0));
    expect(requestHeaders(1).authorization).toBe('Bearer fake-token');
    expect(result.reason).toBe(
      'Hidden ChatGPT-plan models: gpt-6.1-sol (requires a version newer than 0.156.0). '
      + 'clodex sends Codex client version 0.156.0 for Responses-Lite; '
      + 'the ChatGPT catalog does not offer them to this version. '
      + 'Update clodex to a release supporting their required version to use them.',
    );
    // The row stays cached with the catalog's own minimum and the version it was withheld at.
    expect(saved('gpt-6.1-sol')).toMatchObject({ minimalClientVersion: '0.153.0', withheldAtClientVersion: '0.156.0' });
    // A Lite model the pinned catalog also lists is neither marked nor hidden.
    expect(saved('gpt-6-sol')?.withheldAtClientVersion).toBeUndefined();
    expect(offeredIds()).toEqual(['gpt-6-sol', 'gpt-5.5']);
  });

  it('never hides a model that does not use Responses-Lite, even when withheld', async () => {
    pin.override = '0.156.0';
    persistProvider();
    serveCatalog([
      { ...GPT_55, gate: '1.0.0' },
      // No catalog flag and no Lite seed.
      { slug: 'gpt-5.4', gate: '1.0.0', minimal_client_version: '0.124.0' },
      // An explicit catalog `false` overrides the seed's Lite flag.
      { slug: 'gpt-6-astra', gate: '1.0.0', minimal_client_version: '0.153.0', use_responses_lite: false },
      SOL_6,
    ]);
    const result = await refresh();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    // The catalog's answer is recorded; only the Lite check keeps these rows offered.
    for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-6-astra']) {
      expect(saved(id)?.withheldAtClientVersion, id).toBe('0.156.0');
    }
    expect(offeredIds()).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-6-astra', 'gpt-6-sol']);
  });

  it.each(UNUSABLE_ANSWERS)('marks nothing and keeps the refresh when the second fetch returns %s', async (_label, reply) => {
    pin.override = '0.156.0';
    persistProvider();
    serveCatalog([SOL_61, SOL_6, GPT_55], { pinnedReply: reply });
    const result = await refresh();
    expect(result).toMatchObject({ ok: true, modelCount: 3 });
    expect(result.skipped).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(requestedVersions()).toEqual([CLAUDE_VERSION, '0.156.0']);
    expect(reloaded().modelsCache!.models.map(model => model.withheldAtClientVersion))
      .toEqual([undefined, undefined, undefined]);
    expect(offeredIds()).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5']);
  });

  it('marks nothing when the second fetch times out, using the same deadline as the first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    pin.override = '0.156.0';
    persistProvider();
    let pinnedSignal: AbortSignal | undefined;
    serveCatalog([SOL_61, SOL_6, GPT_55], { pinnedReply: init => new Promise<never>((_resolve, reject) => {
      pinnedSignal = init?.signal ?? undefined;
      pinnedSignal?.addEventListener('abort', () => reject(pinnedSignal!.reason), { once: true });
    }) });
    let settled = false;
    const pending = refresh().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(pinnedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ ok: true, modelCount: 3 });
    expect(result.reason).toBeUndefined();
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBeUndefined();
    expect(offeredIds()).toContain('gpt-6.1-sol');
  });

  it('offers the model again, without a refresh, once a release sends a newer version', async () => {
    pin.override = '0.156.0';
    persistProvider();
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-6.1-sol' }],
    }));
    serveCatalog([SOL_61, SOL_6, GPT_55]);
    await refresh();
    const fetches = vi.mocked(fetch).mock.calls.length;
    const favorite = 'clodex:openai-oauth:gpt-6.1-sol';

    // Hidden at and below the version it was withheld at: an older release is not newer.
    for (const release of ['0.155.0', '0.156.0']) {
      pin.override = release;
      expect(offeredIds(), release).toEqual(['gpt-6-sol', 'gpt-5.5']);
      expect(buildDesiredPatchConfig().metaById[favorite], release).toBeUndefined();
    }
    for (const release of ['0.156.1', '0.159.0']) {
      pin.override = release;
      expect(offeredIds(), release).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5']);
      expect(buildDesiredPatchConfig().metaById[favorite]?.contextWindow, release).toBe(272_000);
    }
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetches);
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBe('0.156.0');

    // A refresh that cannot reach the catalog reports from the cached rows, for the release in use.
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const outage = await refresh();
    expect(outage).toMatchObject({ ok: true, skipped: true });
    expect(outage.reason).toContain('kept your existing cached model list');
    expect(outage.reason).not.toContain('Hidden');
    pin.override = '0.156.0';
    expect((await refresh()).reason).toContain('gpt-6.1-sol (requires a version newer than 0.156.0)');
  });

  it('keeps the published-minimum wording for a model whose minimum is the stronger bound', async () => {
    persistProvider();
    const future: Row = { slug: 'future-model', gate: '0.1000.0', minimal_client_version: '0.1000.0', use_responses_lite: true };
    serveCatalog([future, SOL_6]);
    const alone = await refresh();
    expect(saved('future-model')?.withheldAtClientVersion).toBe(CODEX_RESPONSES_LITE_VERSION);
    expect(alone.reason).toBe(
      'Hidden ChatGPT-plan models: future-model (requires 0.1000.0). '
      + `clodex sends Codex client version ${CODEX_RESPONSES_LITE_VERSION} for Responses-Lite; `
      + 'their catalog minimum exceeds this version. '
      + 'Update clodex to a release supporting their required version to use them.',
    );

    const next: Row = { slug: 'next-model', gate: '0.160.0', minimal_client_version: '0.150.0', use_responses_lite: true };
    serveCatalog([future, next, SOL_6]);
    const mixed = await refresh();
    expect(mixed.reason).toContain(
      'Hidden ChatGPT-plan models: future-model (requires 0.1000.0), '
      + `next-model (requires a version newer than ${CODEX_RESPONSES_LITE_VERSION}). `
      + `clodex sends Codex client version ${CODEX_RESPONSES_LITE_VERSION} for Responses-Lite; `
      + 'the ChatGPT catalog does not offer them to this version.',
    );
    expect(offeredIds()).toEqual(['gpt-6-sol']);
  });

  it('reports the stronger bound when an older release reads a row withheld at a newer version', () => {
    pin.override = '0.156.0';
    const row = (minimalClientVersion: string): CachedModel => ({
      id: 'next-model', name: 'Next', upstreamModelId: 'next-model', modelFormat: 'openai',
      useResponsesLite: true, minimalClientVersion, withheldAtClientVersion: '0.159.0',
    });
    expect(codexClientVersionWarning([row('0.157.0')])).toContain('next-model (requires a version newer than 0.159.0)');
    // Withheld at X means newer than X, which is stronger than a minimum of X.
    expect(codexClientVersionWarning([row('0.159.0')])).toContain('next-model (requires a version newer than 0.159.0)');
    expect(codexClientVersionWarning([row('0.160.0')])).toContain('next-model (requires 0.160.0)');
  });

  it('compares only the Codex catalog, never the general-catalog fallback', async () => {
    pin.override = '0.156.0';
    persistProvider();
    vi.mocked(fetch).mockImplementation(async input => {
      const url = new URL(String(input));
      if (`${url.origin}${url.pathname}` === CODEX_MODELS) return new Response('', { status: 404 });
      return Response.json({ data: [{ id: 'gpt-6.1-sol', use_responses_lite: true, minimal_client_version: '0.153.0' }] });
    });
    const result = await refresh();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(requestedVersions()).toEqual([CLAUDE_VERSION]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBeUndefined();
    expect(offeredIds()).toEqual(['gpt-6.1-sol']);
  });

  it('treats caches without the marker, or with a malformed one, exactly as before', () => {
    pin.override = '0.156.0';
    const cases: Array<[Partial<CachedModel>, boolean]> = [
      // Written by a release that recorded only the catalog minimum: offered, as before.
      [{ minimalClientVersion: '0.153.0', useResponsesLite: true }, true],
      // Written before minimums were recorded: the seed's observed gate (0.159.0) applies, as before.
      [{}, false],
      [{ minimalClientVersion: '0.153.0', useResponsesLite: true, withheldAtClientVersion: 'newest' }, true],
      // Hand-edited or corrupt JSON can hold any type here.
      [{ minimalClientVersion: '0.153.0', useResponsesLite: true, withheldAtClientVersion: 159 as unknown as string }, true],
      // An array would pass a string-coercing version check, so the type is checked first.
      [{ minimalClientVersion: '0.153.0', useResponsesLite: true, withheldAtClientVersion: ['0.160.0'] as unknown as string }, true],
    ];
    for (const [fields, offered] of cases) {
      provider.modelsCache = { fetchedAt: provider.addedAt, models: [{
        id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', upstreamModelId: 'gpt-6.1-sol', modelFormat: 'openai', ...fields,
      }] };
      persistProvider();
      expect(offeredIds(), JSON.stringify(fields)).toEqual(offered ? ['gpt-6.1-sol'] : []);
    }
  });

  it('records the marker in a named account cache without changing the default catalog', async () => {
    pin.override = '0.156.0';
    provider.authAccounts = { work: { authRef: 'keyring:work', addedAt: provider.addedAt } };
    persistProvider();
    serveCatalog([SOL_6]);
    await refresh();
    serveCatalog([SOL_61, SOL_6], { tokens: ['work-token'] });
    const result = await refreshProviderModelsWithCredential(provider.id, async () => 'work-token', 'work');
    expect(result.reason).toContain('gpt-6.1-sol (requires a version newer than 0.156.0)');
    expect(reloaded().authAccounts?.work?.modelsCache?.models[0]?.withheldAtClientVersion).toBe('0.156.0');
    expect(offeredIds()).toEqual(['gpt-6-sol']);
    vi.stubEnv('CLODEX_OAUTH_ACCOUNT', 'work');
    expect(offeredIds()).toEqual(['gpt-6-sol']);
    pin.override = '0.159.0';
    expect(offeredIds()).toEqual(['gpt-6.1-sol', 'gpt-6-sol']);
  });
  it('hides a withheld Responses-Lite model that publishes no minimum at all', async () => {
    persistProvider();
    serveCatalog([{ slug: 'next-model', gate: '0.160.0', use_responses_lite: true }, SOL_6]);
    const result = await refresh();
    expect(saved('next-model')).toMatchObject({ withheldAtClientVersion: CODEX_RESPONSES_LITE_VERSION });
    expect(saved('next-model')?.minimalClientVersion).toBeUndefined();
    expect(result.reason).toContain(`next-model (requires a version newer than ${CODEX_RESPONSES_LITE_VERSION})`);
    expect(offeredIds()).toEqual(['gpt-6-sol']);
  });

  it('reads a second answer in the standard data shape', async () => {
    pin.override = '0.156.0';
    persistProvider();
    serveCatalog([SOL_61, SOL_6, GPT_55], {
      pinnedReply: async () => Response.json({ data: [{ id: 'gpt-6-sol' }, { id: 'gpt-5.5' }] }),
    });
    expect((await refresh()).reason).toContain('gpt-6.1-sol (requires a version newer than 0.156.0)');
    expect(offeredIds()).toEqual(['gpt-6-sol', 'gpt-5.5']);
  });

  it('fails the refresh and keeps the cache when discovery returns a null row, as before', async () => {
    pin.override = '0.156.0';
    persistProvider();
    serveCatalog([SOL_61, SOL_6, GPT_55]);
    await refresh();
    const before = reloaded().modelsCache;
    serveCatalog([], { firstReply: async () => Response.json({ models: [null, { slug: 'gpt-6-sol' }] }) });
    const result = await refresh();
    expect(result.ok).toBe(false);
    expect(reloaded().modelsCache).toEqual(before);
    expect(offeredIds()).toEqual(['gpt-6-sol', 'gpt-5.5']);
  });

  it('compares the marker with the version clodex sends by precedence, not as text', () => {
    const withheldAt = (version: string): CachedModel => ({
      id: 'next-model', name: 'Next', upstreamModelId: 'next-model', modelFormat: 'openai',
      useResponsesLite: true, withheldAtClientVersion: version,
    });
    const cases: Array<[pinned: string, marker: string, offered: boolean]> = [
      ['0.999.0', '0.1000.0', false],
      ['0.1000.0', '0.999.0', true],
      ['0.160.0-rc.1', '0.160.0-rc.2', false],
      ['0.160.0', '0.160.0-rc.2', true],
    ];
    for (const [pinned, marker, offered] of cases) {
      pin.override = pinned;
      provider.modelsCache = { fetchedAt: provider.addedAt, models: [withheldAt(marker)] };
      persistProvider();
      expect(offeredIds(), `${pinned} vs ${marker}`).toEqual(offered ? ['next-model'] : []);
    }
  });
});

describe('across refreshes: the marker is carried, replaced or cleared', () => {
  const failed: Reply = async () => new Response('upstream unavailable', { status: 503 });
  async function refreshHidden() {
    pin.override = '0.156.0';
    persistProvider();
    serveCatalog([SOL_61, SOL_6, GPT_55]);
    expect((await refresh()).reason).toContain('gpt-6.1-sol (requires a version newer than 0.156.0)');
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBe('0.156.0');
    expect(offeredIds()).toEqual(['gpt-6-sol', 'gpt-5.5']);
  }

  it.each(UNUSABLE_ANSWERS)('keeps an earlier marker, and its warning, when a later second fetch returns %s', async (_label, reply) => {
    await refreshHidden();
    serveCatalog([SOL_61, SOL_6, GPT_55], { pinnedReply: reply });
    const again = await refresh();
    expect(again).toMatchObject({ ok: true, modelCount: 3 });
    expect(again.skipped).toBeUndefined();
    expect(again.reason).toContain('gpt-6.1-sol (requires a version newer than 0.156.0)');
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBe('0.156.0');
    expect(saved('gpt-6-sol')?.withheldAtClientVersion).toBeUndefined();
    expect(offeredIds()).toEqual(['gpt-6-sol', 'gpt-5.5']);
  });

  it('keeps an earlier marker when a later second fetch times out', async () => {
    await refreshHidden();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    serveCatalog([SOL_61, SOL_6, GPT_55], { pinnedReply: init => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }) });
    const pending = refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).reason).toContain('gpt-6.1-sol (requires a version newer than 0.156.0)');
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBe('0.156.0');
    expect(offeredIds()).toEqual(['gpt-6-sol', 'gpt-5.5']);
  });

  it('clears the marker when the next second answer lists the model', async () => {
    await refreshHidden();
    serveCatalog([{ ...SOL_61, gate: '0.156.0' }, SOL_6, GPT_55]);
    expect((await refresh()).reason).toBeUndefined();
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBeUndefined();
    expect(offeredIds()).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5']);
  });

  it('clears a carried marker once a later second answer lists the model', async () => {
    await refreshHidden();
    serveCatalog([SOL_61, SOL_6, GPT_55], { pinnedReply: failed });
    await refresh();
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBe('0.156.0');
    serveCatalog([{ ...SOL_61, gate: '0.156.0' }, SOL_6, GPT_55]);
    await refresh();
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBeUndefined();
    expect(offeredIds()).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5']);
  });

  it('advances the marker when a newer release is still withheld', async () => {
    await refreshHidden();
    pin.override = '0.158.0';
    expect(offeredIds()).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5']);
    serveCatalog([SOL_61, SOL_6, GPT_55]);
    expect((await refresh()).reason).toContain('gpt-6.1-sol (requires a version newer than 0.158.0)');
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBe('0.158.0');
    expect(offeredIds()).toEqual(['gpt-6-sol', 'gpt-5.5']);
  });

  it('carries a marker below a newer release without hiding anything', async () => {
    await refreshHidden();
    pin.override = '0.159.0';
    serveCatalog([SOL_61, SOL_6, GPT_55], { pinnedReply: failed });
    expect((await refresh()).reason).toBeUndefined();
    expect(saved('gpt-6.1-sol')?.withheldAtClientVersion).toBe('0.156.0');
    expect(offeredIds()).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5']);
  });

  it('keeps an earlier marker through the general-catalog fallback', async () => {
    // gpt-6-sol's published and seeded minimum (0.155.0) is below the pin, so only the marker hides it.
    pin.override = '0.156.0';
    persistProvider();
    serveCatalog([{ ...SOL_6, gate: '0.157.0' }, GPT_55]);
    await refresh();
    expect(saved('gpt-6-sol')?.withheldAtClientVersion).toBe('0.156.0');
    serveCatalog([], {
      firstReply: async () => new Response('stalled', { status: 504 }),
      generalReply: async () => Response.json({ models: [
        { slug: 'gpt-6-sol', title: 'GPT-6 Sol' }, { slug: 'gpt-5.5', title: 'GPT-5.5' },
      ] }),
    });
    const fallback = await refresh();
    expect(fallback).toMatchObject({ ok: true, modelCount: 2 });
    expect(fallback.reason).toContain('gpt-6-sol (requires a version newer than 0.156.0)');
    expect(saved('gpt-6-sol')).toMatchObject({ minimalClientVersion: '0.155.0', withheldAtClientVersion: '0.156.0' });
    expect(offeredIds()).toEqual(['gpt-5.5']);
  });

  describe('only from the account being refreshed', () => {
    const tokens = ['fake-token', 'work-token'];
    const byAccount = async (item: RegistryProvider) => (item.authRef === 'keyring:work' ? 'work-token' : 'fake-token');
    const refreshWork = () => refreshProviderModelsWithCredential(provider.id, byAccount, 'work');
    const defaultSol = () => reloaded().modelsCache?.models.find(model => model.id === 'gpt-6.1-sol');
    const workSol = () => reloaded().authAccounts?.work?.modelsCache?.models.find(model => model.id === 'gpt-6.1-sol');
    beforeEach(() => {
      pin.override = '0.156.0';
      provider.authAccounts = { work: { authRef: 'keyring:work', addedAt: provider.addedAt } };
      persistProvider();
    });

    it('does not carry the default account marker into a slot with no cache of its own', async () => {
      serveCatalog([SOL_61, SOL_6], { tokens });
      await refresh();
      expect(defaultSol()?.withheldAtClientVersion).toBe('0.156.0');
      serveCatalog([SOL_61, SOL_6], { tokens, pinnedReply: failed });
      expect((await refreshWork()).ok).toBe(true);
      expect(workSol()).toBeDefined();
      expect(workSol()?.withheldAtClientVersion).toBeUndefined();
      expect(defaultSol()?.withheldAtClientVersion).toBe('0.156.0');
    });

    it('does not carry a slot marker into the default account', async () => {
      serveCatalog([SOL_61, SOL_6], { tokens });
      await refreshWork();
      expect(workSol()?.withheldAtClientVersion).toBe('0.156.0');
      expect(reloaded().modelsCache).toBeUndefined();
      serveCatalog([SOL_61, SOL_6], { tokens, pinnedReply: failed });
      expect((await refresh()).ok).toBe(true);
      expect(defaultSol()?.withheldAtClientVersion).toBeUndefined();
    });

    it("keeps a slot's own marker when its later second fetch fails", async () => {
      serveCatalog([SOL_61, SOL_6], { tokens });
      await refreshWork();
      serveCatalog([SOL_61, SOL_6], { tokens, pinnedReply: failed });
      expect((await refreshWork()).reason).toContain('gpt-6.1-sol (requires a version newer than 0.156.0)');
      expect(workSol()?.withheldAtClientVersion).toBe('0.156.0');
    });

    it('drops the previous account marker after switching to a slot with no cache', async () => {
      serveCatalog([SOL_61, SOL_6], { tokens });
      await refresh();
      expect(defaultSol()?.withheldAtClientVersion).toBe('0.156.0');
      expect((await setActiveOAuthAccount(provider.id, 'work')).updated).toBe(true);
      expect(reloaded().modelsCache).toBeUndefined();
      serveCatalog([SOL_61, SOL_6], { tokens, pinnedReply: failed });
      expect((await refreshProviderModelsWithCredential(provider.id, byAccount, null)).ok).toBe(true);
      expect(defaultSol()?.withheldAtClientVersion).toBeUndefined();
      expect(workSol()?.withheldAtClientVersion).toBeUndefined();
    });
  });
});

// A fresh reviewer's repro: a partially malformed second answer must hide nothing new, and a
// partially malformed discovery answer must not replace a known-good cache.
describe('partial or malformed catalog answers', () => {
  const BETA: Row = { slug: 'new-lite-beta', gate: '0.100.0', minimal_client_version: '0.100.0', use_responses_lite: true };
  const second = (models: unknown[]): CatalogOptions => ({ pinnedReply: async () => Response.json({ models }) });

  it('does not hide a model when the second answer mixes a valid slug with a non-string one', async () => {
    persistProvider();
    serveCatalog([BETA, SOL_6], second([{ slug: 'gpt-6-sol' }, { slug: ['new-lite-beta'] }]));
    expect((await refresh()).ok).toBe(true);
    expect(saved('new-lite-beta')?.withheldAtClientVersion).toBeUndefined();
    expect(offeredIds()).toEqual(['new-lite-beta', 'gpt-6-sol']);
  });

  it('does not hide anything when the only id in the second answer is whitespace', async () => {
    persistProvider();
    serveCatalog([BETA, SOL_6], second([{ slug: '  ' }]));
    expect((await refresh()).ok).toBe(true);
    expect(offeredIds()).toEqual(['new-lite-beta', 'gpt-6-sol']);
  });

  it('treats duplicate valid ids as one offer, not as a malformed answer', async () => {
    persistProvider();
    serveCatalog([BETA, SOL_6], second([{ slug: 'gpt-6-sol' }, { slug: 'gpt-6-sol' }]));
    expect((await refresh()).ok).toBe(true);
    expect(saved('new-lite-beta')?.withheldAtClientVersion).toBe(CODEX_RESPONSES_LITE_VERSION);
    expect(offeredIds()).toEqual(['gpt-6-sol']);
  });

  it('does not replace a known-good cache from a partially malformed discovery answer', async () => {
    persistProvider();
    serveCatalog([BETA, SOL_6]);
    expect((await refresh()).ok).toBe(true);
    expect(offeredIds()).toEqual(['new-lite-beta', 'gpt-6-sol']);
    serveCatalog([BETA, SOL_6], { firstReply: async () => Response.json({ models: [null, { slug: 'gpt-6-sol' }] }) });
    await refresh();
    expect(offeredIds()).toEqual(['new-lite-beta', 'gpt-6-sol']);
  });

  it('does not carry a marker for a model that discovery no longer lists', async () => {
    persistProvider();
    serveCatalog([BETA, SOL_6], second([{ slug: 'gpt-6-sol' }]));
    expect((await refresh()).ok).toBe(true);
    expect(saved('new-lite-beta')?.withheldAtClientVersion).toBe(CODEX_RESPONSES_LITE_VERSION);
    serveCatalog([SOL_6], { pinnedReply: async () => new Response('unavailable', { status: 503 }) });
    expect((await refresh()).ok).toBe(true);
    expect(reloaded().modelsCache!.models.map(model => model.id)).toEqual(['gpt-6-sol']);
    expect(offeredIds()).toEqual(['gpt-6-sol']);
  });
});
