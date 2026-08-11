import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelCredentialDelete,
  isStoredCredentialRef,
  loadPendingCredentialDeletes,
  queueCredentialDelete,
} from '../src/registry/credential-cleanup-journal.js';
import { emptyRegistry, loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { getCredentialCleanupPath, getProvidersPath } from '../src/paths.js';

vi.mock('../src/ui.js', () => ({ printOAuthStepsPanel: vi.fn() }));
vi.mock('../src/oauth/openai.js', () => ({ runOpenAiDeviceCodeFlow: vi.fn() }));
vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    probeProviderCredentialStore: vi.fn(async () => true),
    provisionProviderCredential: vi.fn(async () => true),
    saveProviderCredential: vi.fn(async () => true),
    resolveProviderCredentialWithSource: vi.fn(async () => ({
      credential: 'stored-access-token',
      source: 'keyring' as const,
    })),
  };
});
vi.mock('../src/registry/refresh-models.js', () => ({
  refreshProviderModelsWithCredential: vi.fn(async () => ({
    id: 'openai-oauth',
    name: 'OpenAI',
    ok: true,
  })),
}));

import { runOpenAiDeviceCodeFlow } from '../src/oauth/openai.js';
import { authenticateProvider } from '../src/registry/provider-auth.js';
import { setActiveOAuthAccount } from '../src/registry/crud.js';

const TEST_HELPER_ID = 'a'.repeat(64);
const helperRef = (account: string): string => `helper:v1:${TEST_HELPER_ID}:${account}`;

describe('isStoredCredentialRef named account slots', () => {
  it('accepts slot credential refs and rejects malformed slot names', () => {
    const instance = '::credential::v1:0f4a2f6e6c1e4f9f9d3a1b2c3d4e5f60';
    expect(isStoredCredentialRef(`keyring:oauth:provider:openai-oauth:account:work${instance}`)).toBe(true);
    // Rejecting the slot shape made journalCredentialWrite throw "not managed
    // by Clodex" and the whole named-account sign-in fail after the ceremony.
    expect(isStoredCredentialRef(`keyring:oauth:provider:openai-oauth${instance}`)).toBe(true);
    expect(isStoredCredentialRef(`keyring:oauth:provider:openai-oauth:account:Bad Name${instance}`)).toBe(false);
    expect(isStoredCredentialRef(`keyring:oauth:provider:bad id:account:work${instance}`)).toBe(false);
  });
});

describe('credential cleanup journal', () => {
  const previousHome = process.env.CLODEX_HOME;
  const previousHelper = process.env.CLODEX_CREDENTIAL_HELPER;
  const previousAccount = process.env.CLODEX_OAUTH_ACCOUNT;
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-cleanup-journal-'));
    process.env.CLODEX_HOME = home;
    delete process.env.CLODEX_CREDENTIAL_HELPER;
    delete process.env.CLODEX_OAUTH_ACCOUNT;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    if (previousHelper === undefined) delete process.env.CLODEX_CREDENTIAL_HELPER;
    else process.env.CLODEX_CREDENTIAL_HELPER = previousHelper;
    if (previousAccount === undefined) delete process.env.CLODEX_OAUTH_ACCOUNT;
    else process.env.CLODEX_OAUTH_ACCOUNT = previousAccount;
    rmSync(home, { recursive: true, force: true });
  });

  it('serializes concurrent updates without dropping references', async () => {
    const refs = [
      helperRef('provider:first'),
      helperRef('provider:second'),
      'keyring:provider:third',
    ];

    await Promise.all(refs.map(authRef => queueCredentialDelete(authRef)));

    expect(await loadPendingCredentialDeletes()).toEqual(refs);
    expect(statSync(getCredentialCleanupPath()).mode.toString(8).slice(-3)).toBe('600');
  });

  it('survives a schema-1 registry rewrite by an older writer', async () => {
    const authRef = helperRef('provider:orphaned-write');
    await queueCredentialDelete(authRef);

    const registry = emptyRegistry();
    withRegistryWriteLockSync(() => saveRegistry(registry));
    const persistedRegistry = JSON.parse(
      readFileSync(getProvidersPath(), 'utf8'),
    ) as Record<string, unknown>;

    expect(persistedRegistry).toEqual({ schemaVersion: 1, providers: [] });
    expect(await loadPendingCredentialDeletes()).toEqual([authRef]);
  });

  it('completes sequential default and named sign-ins before persisting the named selection', async () => {
    vi.mocked(runOpenAiDeviceCodeFlow)
      .mockReset()
      .mockResolvedValueOnce({
        tokens: {
          access_token: 'default-access-token',
          refresh_token: 'default-refresh-token',
          expires_in: 3600,
        },
        accountId: 'default-runtime-account',
      })
      .mockResolvedValueOnce({
        tokens: {
          access_token: 'work-access-token',
          refresh_token: 'work-refresh-token',
          expires_in: 3600,
        },
        accountId: 'work-runtime-account',
      });

    const defaultSignIn = await authenticateProvider('openai');
    expect(defaultSignIn.registryProvider.authAccounts).toBeUndefined();
    expect(await loadPendingCredentialDeletes()).toEqual([]);

    const namedSignIn = await authenticateProvider('openai', { account: 'work' });
    const namedRef = namedSignIn.registryProvider.authAccounts?.work?.authRef;
    expect(namedRef).toMatch(/:account:work::credential::v1:/);
    expect(await loadPendingCredentialDeletes()).toEqual([]);

    await expect(setActiveOAuthAccount('openai-oauth', 'work')).resolves.toMatchObject({
      updated: true,
      changed: true,
      account: 'work',
    });
    const persistedRegistry = loadRegistryStrict();
    expect(persistedRegistry.schemaVersion).toBe(5);
    expect(persistedRegistry.providers[0]).toMatchObject({
      activeAuthAccount: 'work',
      authRef: namedRef,
      defaultAuthRef: defaultSignIn.registryProvider.authRef,
    });
    expect(JSON.parse(readFileSync(getCredentialCleanupPath(), 'utf8')))
      .toEqual({ schemaVersion: 1, pendingCredentialDeletes: [] });
    const serializedRegistry = readFileSync(getProvidersPath(), 'utf8');
    expect(serializedRegistry).not.toContain('default-runtime-account');
    expect(serializedRegistry).not.toContain('work-runtime-account');
    expect(vi.mocked(runOpenAiDeviceCodeFlow)).toHaveBeenCalledTimes(2);
  });

  it('deduplicates managed references and persists cancellation atomically', async () => {
    const authRef = helperRef('provider:stale');
    writeFileSync(getCredentialCleanupPath(), JSON.stringify({
      schemaVersion: 1,
      pendingCredentialDeletes: [
        authRef,
        authRef,
        'keyring:provider:stale',
      ],
    }), { mode: 0o600 });

    expect(await loadPendingCredentialDeletes()).toEqual([
      authRef,
      'keyring:provider:stale',
    ]);

    await cancelCredentialDelete(authRef);

    expect(await loadPendingCredentialDeletes()).toEqual([
      'keyring:provider:stale',
    ]);
  });

  it.each([
    ['malformed JSON', '{'],
    ['wrong schema', JSON.stringify({ schemaVersion: 2, pendingCredentialDeletes: [] })],
    ['non-object root', JSON.stringify([])],
    ['missing pending list', JSON.stringify({ schemaVersion: 1 })],
    ['non-array pending list', JSON.stringify({
      schemaVersion: 1,
      pendingCredentialDeletes: 'keyring:provider:stale',
    })],
  ])('rejects %s without processing cleanup entries', async (_label, content) => {
    writeFileSync(getCredentialCleanupPath(), content, { mode: 0o600 });

    await expect(loadPendingCredentialDeletes()).rejects.toThrow(
      'Could not read credential cleanup journal',
    );
  });

  it('rejects unmanaged or malformed credential references', async () => {
    writeFileSync(getCredentialCleanupPath(), JSON.stringify({
      schemaVersion: 1,
      pendingCredentialDeletes: [
        'keyring:arbitrary-account',
        'env:OPENAI_API_KEY',
        42,
      ],
    }), { mode: 0o600 });

    await expect(loadPendingCredentialDeletes()).rejects.toThrow(
      'invalid entry at index 0',
    );
    expect(await queueCredentialDelete('keyring:arbitrary-account')).toBe(false);
  });

  it('accepts generated replacement, custom, OAuth, and scoped account shapes', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const refs = [
      'keyring:provider:openai',
      `keyring:provider:openai:replacement:${uuid}`,
      `keyring:provider:custom-openai:${uuid}`,
      'keyring:oauth:provider:openai-oauth',
      `keyring:provider:openai::credential::v1:${'a'.repeat(32)}`,
      helperRef(`oauth:provider:openai-oauth::credential::v1:${'b'.repeat(32)}`),
    ];

    for (const authRef of refs) {
      expect(await queueCredentialDelete(authRef)).toBe(true);
    }

    expect(await loadPendingCredentialDeletes()).toEqual(refs);
  });

  it('bounds the persisted journal before parsing entries', async () => {
    writeFileSync(getCredentialCleanupPath(), 'x'.repeat(1024 * 1024 + 1), {
      mode: 0o600,
    });

    await expect(loadPendingCredentialDeletes()).rejects.toThrow(
      'Credential cleanup journal is too large',
    );
  });

  it('bounds the number of pending entries', async () => {
    writeFileSync(getCredentialCleanupPath(), JSON.stringify({
      schemaVersion: 1,
      pendingCredentialDeletes: Array.from(
        { length: 1025 },
        () => 'keyring:provider:openai',
      ),
    }), { mode: 0o600 });

    await expect(loadPendingCredentialDeletes()).rejects.toThrow(
      'too many pending entries',
    );
  });

  it('rejects a symlinked journal', async () => {
    const target = join(home, 'journal-target.json');
    writeFileSync(target, JSON.stringify({
      schemaVersion: 1,
      pendingCredentialDeletes: ['keyring:provider:openai'],
    }), { mode: 0o600 });
    symlinkSync(target, getCredentialCleanupPath());

    await expect(loadPendingCredentialDeletes()).rejects.toThrow(
      'must be a regular file',
    );
  });

  it.runIf(typeof process.getuid === 'function')(
    'rejects a journal with group or other permissions',
    async () => {
      writeFileSync(getCredentialCleanupPath(), JSON.stringify({
        schemaVersion: 1,
        pendingCredentialDeletes: ['keyring:provider:openai'],
      }), { mode: 0o600 });
      chmodSync(getCredentialCleanupPath(), 0o644);

      await expect(loadPendingCredentialDeletes()).rejects.toThrow(
        'permissions are too broad',
      );
    },
  );
});
