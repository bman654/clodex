import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
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
  loadPendingCredentialDeletes,
  queueCredentialDelete,
} from '../src/registry/credential-cleanup-journal.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import {
  getCredentialCleanupPath,
  getProvidersPath,
  resetLegacyMigrationForTests,
} from '../src/paths.js';

const TEST_HELPER_ID = 'a'.repeat(64);
const helperRef = (account: string): string => `helper:v1:${TEST_HELPER_ID}:${account}`;

describe('credential cleanup journal', () => {
  const previousHome = process.env.CLODEX_HOME;
  const previousUserHome = process.env.HOME;
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-cleanup-journal-'));
    process.env.CLODEX_HOME = home;
    resetLegacyMigrationForTests();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    if (previousUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousUserHome;
    resetLegacyMigrationForTests();
    rmSync(home, { recursive: true, force: true });
  });

  it('migrates the legacy app home before publishing its first journal lock', async () => {
    const appHome = join(home, '.clodex');
    const legacyHome = join(home, '.relay-ai');
    const legacyRegistry = `${JSON.stringify({
      schemaVersion: 1,
      providers: [{ id: 'legacy-provider' }],
    })}\n`;
    process.env.HOME = home;
    process.env.CLODEX_HOME = appHome;
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, 'providers.json'), legacyRegistry);
    resetLegacyMigrationForTests();

    expect(await loadPendingCredentialDeletes()).toEqual([]);

    expect(readFileSync(join(appHome, 'providers.json'), 'utf8')).toBe(
      legacyRegistry,
    );
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
