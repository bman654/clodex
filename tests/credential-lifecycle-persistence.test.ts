import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialAuthRef } from '../src/credential-helper.js';
import {
  resolveProviderCredential,
  saveProviderCredential,
} from '../src/env.js';
import {
  journalCredentialWrite,
  reconcilePendingCredentialDeletes,
} from '../src/registry/credential-lifecycle.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { getProvidersPath } from '../src/paths.js';

const helperPath = fileURLToPath(
  new URL('./fixtures/credential-helper.mjs', import.meta.url),
);

describe('persisted credential cleanup recovery', () => {
  const previousHome = process.env.CLODEX_HOME;
  const previousHelper = process.env.CLODEX_CREDENTIAL_HELPER;
  const previousStore = process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE;
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-cleanup-persistence-'));
    process.env.CLODEX_HOME = home;
    process.env.CLODEX_CREDENTIAL_HELPER = helperPath;
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE = join(home, 'helper-store.json');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    if (previousHelper === undefined) delete process.env.CLODEX_CREDENTIAL_HELPER;
    else process.env.CLODEX_CREDENTIAL_HELPER = previousHelper;
    if (previousStore === undefined) delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE;
    else process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE = previousStore;
    rmSync(home, { recursive: true, force: true });
  });

  it('deletes a persisted credential when interruption precedes registry commit', async () => {
    const authRef = credentialAuthRef('provider:interrupted-write');
    await journalCredentialWrite(authRef);
    expect(await saveProviderCredential(authRef, 'persisted-secret')).toBe(true);
    expect(await resolveProviderCredential('interrupted-write', authRef)).toBe(
      'persisted-secret',
    );

    const cleanup = await reconcilePendingCredentialDeletes();

    expect(cleanup.deleted).toEqual([authRef]);
    expect(cleanup.pending).toEqual([]);
    expect(await resolveProviderCredential('interrupted-write', authRef)).toBeNull();
  });

  it('retains a persisted credential when interruption follows registry commit', async () => {
    const authRef = credentialAuthRef('provider:committed-write');
    await journalCredentialWrite(authRef);
    expect(await saveProviderCredential(authRef, 'persisted-secret')).toBe(true);
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'committed-write',
      templateId: 'committed-write',
      name: 'Committed Write',
      enabled: true,
      authRef,
      authType: 'api',
      api: {},
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));

    const cleanup = await reconcilePendingCredentialDeletes();

    expect(cleanup.deleted).toEqual([]);
    expect(cleanup.pending).toEqual([]);
    expect(await resolveProviderCredential('committed-write', authRef)).toBe(
      'persisted-secret',
    );
  });

  it('retains a persisted credential when the registry is malformed', async () => {
    const authRef = credentialAuthRef('provider:unreadable-registry');
    await journalCredentialWrite(authRef);
    expect(await saveProviderCredential(authRef, 'persisted-secret')).toBe(true);
    writeFileSync(getProvidersPath(), '{', { mode: 0o600 });

    const cleanup = await reconcilePendingCredentialDeletes();

    expect(cleanup.deleted).toEqual([]);
    expect(cleanup.pending).toEqual([authRef]);
    expect(cleanup.persistenceError).toContain(authRef);
    expect(cleanup.persistenceError).toContain('JSON');
    expect(await resolveProviderCredential('unreadable-registry', authRef)).toBe(
      'persisted-secret',
    );
  });
});
