import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

  it('sanitizes stored references and persists cancellation atomically', async () => {
    const authRef = helperRef('provider:stale');
    writeFileSync(getCredentialCleanupPath(), JSON.stringify({
      schemaVersion: 1,
      pendingCredentialDeletes: [
        authRef,
        authRef,
        'keyring:provider:stale',
        'env:OPENAI_API_KEY',
        42,
      ],
    }));

    expect(await loadPendingCredentialDeletes()).toEqual([
      authRef,
      'keyring:provider:stale',
    ]);

    await cancelCredentialDelete(authRef);

    expect(await loadPendingCredentialDeletes()).toEqual([
      'keyring:provider:stale',
    ]);
  });
});
