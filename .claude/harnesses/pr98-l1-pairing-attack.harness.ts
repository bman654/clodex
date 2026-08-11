// PR #98 re-review, lens L1 — provider-override isolation.
// Adapted from vault harness pr98-refuter-catalog-isolation.test.ts.
//
// Goal: (a) confirm the blocking ask (scoped failure, unrelated providers
// survive, tailored reason preserved) and (b) ATTACK the safety property by
// trying to make a CLODEX_KEY_* override reach a catalog discovered under a
// different credential, across every provider shape that can survive
// materialization with an empty apiKey.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRegistryProviders } from '../src/registry/load.js';
import { resolveLocalProviderApiKey } from '../src/provider-catalog.js';

const OVERRIDE = 'PROCESS-OVERRIDE-TOKEN';

function model(id: string) {
  return { id, name: id, upstreamModelId: id, modelFormat: 'openai', npm: '@ai-sdk/openai' };
}

function provider(over: Record<string, unknown>) {
  return {
    id: 'openai',
    templateId: 'openai',
    name: 'OpenAI',
    enabled: true,
    authRef: 'env:OPENAI_TEST_KEY',
    authType: 'api',
    api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
    modelsCache: { fetchedAt: '2026-08-09T00:00:00.000Z', models: [model('stored-catalog-model')] },
    addedAt: '2026-08-09T00:00:00.000Z',
    ...over,
  };
}

let home: string;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function writeRegistry(providers: unknown[], schemaVersion = 1) {
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ schemaVersion, providers }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'zzl1-'));
  setEnv('CLODEX_HOME', home);
  setEnv('OPENAI_TEST_KEY', 'stored-openai-key');
  setEnv('OAUTH_TEST_KEY', 'stored-oauth-key');
  setEnv('CLODEX_KEY_OPENAI', undefined);
  setEnv('CLODEX_KEY_OPENAI_OAUTH', undefined);
  setEnv('CLODEX_OAUTH_ACCOUNT', undefined);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('L1 — blocking ask: scoped provider-override isolation', () => {
  it('one override scopes the failure to its own provider and keeps the other loadable', async () => {
    writeRegistry([
      provider({}),
      provider({
        id: 'openai-oauth',
        templateId: 'openai-oauth',
        name: 'OpenAI (ChatGPT)',
        authRef: 'env:OAUTH_TEST_KEY',
        authType: 'oauth',
        modelsCache: { fetchedAt: '2026-08-09T00:00:00.000Z', models: [model('oauth-catalog-model')] },
      }),
    ]);
    setEnv('CLODEX_KEY_OPENAI_OAUTH', OVERRIDE);

    const providers = await loadRegistryProviders();

    expect(providers.map(p => p.id)).toEqual(['openai']);
    expect(providers[0]!.apiKey).toBe('stored-openai-key');
    expect(providers.blockedProviders.get('openai-oauth')).toContain('no isolated model catalog');
    expect(providers.blockedProviders.has('openai')).toBe(false);
  });

  it('both overrides block both providers and neither is paired', async () => {
    writeRegistry([
      provider({}),
      provider({
        id: 'openai-oauth',
        templateId: 'openai-oauth',
        name: 'OpenAI (ChatGPT)',
        authRef: 'env:OAUTH_TEST_KEY',
        authType: 'oauth',
      }),
    ]);
    setEnv('CLODEX_KEY_OPENAI', OVERRIDE);
    setEnv('CLODEX_KEY_OPENAI_OAUTH', OVERRIDE);

    const providers = await loadRegistryProviders();
    expect(providers).toHaveLength(0);
    expect([...providers.blockedProviders.keys()].sort()).toEqual(['openai', 'openai-oauth']);
  });
});

describe('L1 — safety property attack: can an override reach a stored catalog?', () => {
  // Each row is a provider shape that could plausibly survive materialization
  // with an empty apiKey (the only way resolveLocalProviderApiKey is reached
  // at launch time, src/cli.ts:1334 / src/http-proxy/index.ts:48).
  const shapes: Array<{ name: string; provider: Record<string, unknown>; envVar: string }> = [
    { name: 'api-key provider (schema v1)', provider: provider({}), envVar: 'CLODEX_KEY_OPENAI' },
    {
      name: 'oauth provider',
      provider: provider({ id: 'openai-oauth', templateId: 'openai-oauth', authRef: 'env:OAUTH_TEST_KEY', authType: 'oauth' }),
      envVar: 'CLODEX_KEY_OPENAI_OAUTH',
    },
    {
      name: 'explicit anonymous provider (load.ts early-return path)',
      provider: provider({ authType: 'none', authRef: 'none:anonymous' }),
      envVar: 'CLODEX_KEY_OPENAI',
    },
    {
      name: 'authType none with a real authRef (load.ts early-return path)',
      provider: provider({ authType: 'none' }),
      envVar: 'CLODEX_KEY_OPENAI',
    },
    {
      name: 'legacy custom-openai endpoint (authType undefined)',
      provider: (() => {
        const p = provider({ templateId: 'custom-openai', authRef: 'keyring:provider:openai' }) as Record<string, unknown>;
        delete p.authType;
        return p;
      })(),
      envVar: 'CLODEX_KEY_OPENAI',
    },
    {
      name: 'oauth provider with a named slot selected via CLODEX_OAUTH_ACCOUNT',
      provider: provider({
        id: 'openai-oauth',
        templateId: 'openai-oauth',
        authRef: 'env:OAUTH_TEST_KEY',
        authType: 'oauth',
        authAccounts: {
          work: {
            authRef: 'env:OAUTH_TEST_KEY',
            addedAt: '2026-08-09T00:00:00.000Z',
            modelsCache: { fetchedAt: '2026-08-09T00:00:00.000Z', models: [model('work-slot-model')] },
          },
        },
      }),
      envVar: 'CLODEX_KEY_OPENAI_OAUTH',
    },
  ];

  for (const shape of shapes) {
    it(`no override-paired catalog: ${shape.name}`, async () => {
      writeRegistry([shape.provider], 5);
      setEnv(shape.envVar, OVERRIDE);
      if (shape.name.includes('CLODEX_OAUTH_ACCOUNT')) setEnv('CLODEX_OAUTH_ACCOUNT', 'work');

      const providers = await loadRegistryProviders();

      // The pairing under attack: a provider that is BOTH in the runtime
      // catalog (so its stored modelsCache is live) AND whose launch-time key
      // resolves to the process override.
      const paired: string[] = [];
      for (const p of providers) {
        const key = await resolveLocalProviderApiKey(p);
        if (key === OVERRIDE) paired.push(`${p.id} models=[${p.models.map(m => m.id).join(',')}]`);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[${shape.name}] catalog=`,
        providers.map(p => `${p.id}(apiKey=${JSON.stringify(p.apiKey)},models=${p.models.length})`).join(',') || '(empty)',
        '| blocked=', [...providers.blockedProviders.keys()].join(',') || '(none)',
        '| PAIRED=', paired.join(';') || '(none)',
      );
      expect(paired).toEqual([]);
    });
  }
});
