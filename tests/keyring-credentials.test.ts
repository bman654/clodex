import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failSetSuffix: '' as string,
  failSetKey: '' as string,
  failDeleteSuffix: '' as string,
  failDeleteKey: '' as string,
  failFindService: '' as string,
  failFindCount: 0,
  omitFindKey: '' as string,
  omitFindOnceKey: '' as string,
  omitFindAccount: '' as string,
  getCount: 0,
  findCount: 0,
  onGet: null as ((key: string) => void) | null,
  operations: [] as Array<{
    type: 'set' | 'delete';
    key: string;
    value?: string;
  }>,
  lockHome: '' as string,
}));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: () => ({
      ...actual.userInfo(),
      homedir: keyring.lockHome || actual.userInfo().homedir,
    }),
  };
});

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    private readonly key: string;

    constructor(service: string, account: string) {
      this.key = `${service}:${account}`;
    }

    getPassword(): string | null {
      keyring.getCount++;
      try {
        keyring.onGet?.(this.key);
      } catch {
        return null;
      }
      return keyring.values.get(this.key) ?? null;
    }

    setPassword(value: string): void {
      if (
        (keyring.failSetSuffix && this.key.endsWith(keyring.failSetSuffix))
        || (keyring.failSetKey && this.key === keyring.failSetKey)
      ) {
        throw new Error('injected keyring write failure');
      }
      const nativeValue = Buffer.from(value, 'utf8').toString('utf8');
      keyring.operations.push({
        type: 'set',
        key: this.key,
        value: nativeValue,
      });
      keyring.values.set(this.key, nativeValue);
    }

    deletePassword(): boolean {
      if (
        (keyring.failDeleteSuffix && this.key.endsWith(keyring.failDeleteSuffix))
        || (keyring.failDeleteKey && this.key === keyring.failDeleteKey)
      ) {
        return false;
      }
      const deleted = keyring.values.delete(this.key);
      if (!deleted) return false;
      keyring.operations.push({ type: 'delete', key: this.key });
      return true;
    }
  },
  findCredentials: (service: string) => {
    keyring.findCount++;
    if (keyring.failFindService === service && keyring.failFindCount > 0) {
      keyring.failFindCount--;
      throw new Error('injected keyring enumeration failure');
    }
    const prefix = `${service}:`;
    return [...keyring.values.entries()]
      .filter(([key]) => {
        if (!key.startsWith(prefix)) return false;
        if (key === keyring.omitFindOnceKey) {
          keyring.omitFindOnceKey = '';
          return false;
        }
        const credentialAccount = key.slice(prefix.length);
        if (
          keyring.omitFindAccount &&
          (credentialAccount === keyring.omitFindAccount ||
            credentialAccount.startsWith(`${keyring.omitFindAccount}::`))
        )
          return false;
        return key !== keyring.omitFindKey;
      })
      .map(([key, password]) => ({
        account: key.slice(prefix.length),
        password,
      }));
  },
}));

import {
  deleteProviderCredential,
  probeProviderCredentialStore,
  provisionProviderCredential,
  resolveProviderCredential,
  saveProviderCredential as replaceProviderCredential,
} from '../src/env.js';

const credentialInstance = `v1:${'1'.repeat(32)}`;
const account = `oauth:provider:test::credential::${credentialInstance}`;
const authRef = `keyring:${account}`;
const mainKey = `clodex:${account}`;
const journalKey = `clodex-journal:${account}`;
const deletedKey = `clodex-deleted:${account}`;
const journalPrefix = '__relay_chunk_journal__:v1:';
const previousHome = process.env.CLODEX_HOME;
const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
let tempDir = '';

function testCredentialAuthRef(accountBase: string): string {
  return `keyring:${accountBase}::credential::${credentialInstance}`;
}

function managedStatePath(refAccount = account): string {
  const accountDigest = createHash('sha256').update(refAccount).digest('hex');
  return join(keyring.lockHome, '.clodex', 'keyring-state', `${accountDigest}.managed`);
}

function hasStoredCredentialState(ref: string): boolean {
  const refAccount = ref.slice('keyring:'.length);
  if (existsSync(managedStatePath(refAccount))) {
    return true;
  }
  return [...keyring.values.keys()].some(key => {
    const separatorIndex = key.indexOf(':');
    const service = key.slice(0, separatorIndex);
    const storedAccount = key.slice(separatorIndex + 1);
    return (
      ['clodex', 'clodex-chunks', 'clodex-journal', 'clodex-deleted'].includes(service) &&
      (storedAccount === refAccount || storedAccount.startsWith(`${refAccount}::chunk::`))
    );
  });
}

function saveProviderCredential(
  ref: string,
  value: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  return hasStoredCredentialState(ref)
    ? replaceProviderCredential(ref, value, diag)
    : provisionProviderCredential(ref, value, diag);
}

function currentChunkKeys(): string[] {
  return [...keyring.values.keys()].filter(key => key.includes(`${account}::chunk::`));
}

function clearMockKeyringState(): void {
  keyring.values.clear();
  rmSync(join(keyring.lockHome, '.clodex', 'keyring-state'), { recursive: true, force: true });
}

function expectUnverifiableTombstone(blockLegacy = false): string {
  const raw = keyring.values.get(journalKey);
  expect(raw?.startsWith(journalPrefix)).toBe(true);
  expect(JSON.parse(raw!.slice(journalPrefix.length))).toEqual({
    mode: 'delete',
    generations: [],
    ...(blockLegacy ? { blockLegacy: true } : {}),
    unverifiable: true,
  });
  return raw!;
}

function expectDeletionMarker(): void {
  const raw = keyring.values.get(journalKey);
  expect(raw?.startsWith(journalPrefix)).toBe(true);
  expect(JSON.parse(raw!.slice(journalPrefix.length))).toEqual({
    mode: 'deleted',
    generations: [],
  });
  expectDeletionGuard();
}

function expectDeletionGuard(): void {
  expect(keyring.values.has(mainKey)).toBe(false);
  expect(keyring.values.get(deletedKey)).toBe('v1:deleted');
}

function publishedMarker(): {
  count: number;
  generation?: string;
  digest?: string;
} {
  const raw = keyring.values.get(mainKey);
  expect(raw?.startsWith('__relay_chunked__:')).toBe(true);
  const encoded = raw!.slice('__relay_chunked__:'.length);
  const current = /^v3:([^:]+):(\d+):([0-9a-f]{64})$/.exec(encoded);
  const versioned = /^v2:([^:]+):(\d+)$/.exec(encoded);
  const legacy = /^(\d+)$/.exec(encoded);
  const count = Number(current?.[2] ?? versioned?.[2] ?? legacy?.[1]);
  return {
    count,
    ...(current?.[1] || versioned?.[1] ? { generation: current?.[1] ?? versioned?.[1] } : {}),
    ...(current?.[3] ? { digest: current[3] } : {}),
  };
}

function expectActiveInventory(
  marker: ReturnType<typeof publishedMarker> = publishedMarker(),
): void {
  const raw = keyring.values.get(journalKey);
  expect(raw?.startsWith(journalPrefix)).toBe(true);
  expect(JSON.parse(raw!.slice(journalPrefix.length))).toEqual({
    mode: 'write',
    generations: [marker],
  });
}

function expectActiveShort(value: string): void {
  const raw = keyring.values.get(journalKey);
  expect(raw?.startsWith(journalPrefix)).toBe(true);
  expect(JSON.parse(raw!.slice(journalPrefix.length))).toEqual({
    mode: 'short',
    generations: [],
    shortDigest: createHash('sha256').update(value).digest('hex'),
  });
}

describe('keyring credential chunks', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clodex-keyring-'));
    process.env.CLODEX_HOME = tempDir;
    process.env.XDG_RUNTIME_DIR = tempDir;
    keyring.lockHome = tempDir;
    keyring.values.clear();
    keyring.failSetSuffix = '';
    keyring.failSetKey = '';
    keyring.failDeleteSuffix = '';
    keyring.failDeleteKey = '';
    keyring.failFindService = '';
    keyring.failFindCount = 0;
    keyring.omitFindKey = '';
    keyring.omitFindOnceKey = '';
    keyring.omitFindAccount = '';
    keyring.getCount = 0;
    keyring.findCount = 0;
    keyring.onGet = null;
    keyring.operations = [];
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('requires a versioned account reference for provisioned credentials', async () => {
    const diagnostics: string[] = [];

    await expect(
      provisionProviderCredential('keyring:provider:test', 'secret-value', message =>
        diagnostics.push(message),
      ),
    ).resolves.toBe(false);

    expect(diagnostics).toContain('provisioned credentials require a versioned account instance');
    expect(keyring.values.size).toBe(0);
  });

  it('publishes a new chunk generation before removing the previous one', async () => {
    const first = 'a'.repeat(2_500);
    const second = 'b'.repeat(1_500);

    await expect(saveProviderCredential(authRef, first)).resolves.toBe(true);
    const firstMarker = keyring.values.get(mainKey)!;
    const firstChunks = currentChunkKeys();
    keyring.operations = [];

    await expect(saveProviderCredential(authRef, second)).resolves.toBe(true);

    const secondMarker = keyring.values.get(mainKey)!;
    expect(secondMarker).toMatch(/^__relay_chunked__:v3:[0-9a-f-]{36}:2:[0-9a-f]{64}$/);
    expect(secondMarker).not.toBe(firstMarker);
    expect(firstChunks.every(key => !keyring.values.has(key))).toBe(true);
    const markerSetIndex = keyring.operations.findIndex(operation =>
      operation.type === 'set'
      && operation.key === mainKey
      && operation.value === secondMarker,
    );
    const newChunkSetIndices = keyring.operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) =>
        operation.type === 'set'
        && operation.key.includes(`${account}::chunk::`)
        && !firstChunks.includes(operation.key),
      )
      .map(({ index }) => index);
    const oldChunkDeleteIndices = keyring.operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => operation.type === 'delete' && firstChunks.includes(operation.key))
      .map(({ index }) => index);
    const journalSetIndices = keyring.operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => operation.type === 'set' && operation.key === journalKey)
      .map(({ index }) => index);
    const initialJournalSetIndex = journalSetIndices.at(0)!;
    const inventorySetIndex = journalSetIndices.at(-1)!;
    expect(markerSetIndex).toBeGreaterThanOrEqual(0);
    expect(journalSetIndices).toHaveLength(2);
    expect(newChunkSetIndices).toHaveLength(2);
    expect(oldChunkDeleteIndices).toHaveLength(3);
    expect(newChunkSetIndices.every(index => initialJournalSetIndex < index)).toBe(true);
    expect(newChunkSetIndices.every(index => index < markerSetIndex)).toBe(true);
    expect(oldChunkDeleteIndices.every(index => index > markerSetIndex)).toBe(true);
    expect(oldChunkDeleteIndices.every(index => index < inventorySetIndex)).toBe(true);
    expectActiveInventory();
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(second);
  });

  it('does not split a surrogate pair across native keyring chunks', async () => {
    const secret = `${'a'.repeat(1_199)}😀b`;

    await expect(saveProviderCredential(authRef, secret)).resolves.toBe(true);

    expect(currentChunkKeys()).toHaveLength(2);
    expect([...keyring.values.values()].every(value => !value.includes('�'))).toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(secret);
  });

  it('does not multiply missing-entry scans for a steady short credential', async () => {
    await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(true);
    keyring.getCount = 0;
    keyring.findCount = 0;

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('short-secret');

    expect(keyring.getCount).toBe(5);
    expect(keyring.findCount).toBe(1);
  });

  it('places keyring coordination state under the native account home', async () => {
    const defaultHome = mkdtempSync(join(tmpdir(), 'clodex-default-home-'));
    const alternateRuntime = mkdtempSync(join(tmpdir(), 'clodex-runtime-'));
    keyring.lockHome = defaultHome;
    process.env.XDG_RUNTIME_DIR = alternateRuntime;
    try {
      await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(true);

      expect(existsSync(join(defaultHome, '.clodex', 'credential-locks'))).toBe(true);
      expect(existsSync(join(defaultHome, '.clodex', 'keyring-state'))).toBe(true);
      expect(existsSync(join(tempDir, 'clodex-keyring-locks'))).toBe(false);
      expect(existsSync(join(tempDir, 'keyring-state'))).toBe(false);
      expect(existsSync(join(alternateRuntime, 'clodex-keyring-locks'))).toBe(false);
    } finally {
      rmSync(defaultHome, { recursive: true, force: true });
      rmSync(alternateRuntime, { recursive: true, force: true });
    }
  });

  it('keeps the published credential readable when a new generation fails', async () => {
    const first = 'a'.repeat(2_500);
    await expect(saveProviderCredential(authRef, first)).resolves.toBe(true);
    const firstMarker = keyring.values.get(mainKey);
    const firstChunks = currentChunkKeys();

    keyring.failSetSuffix = '::1';
    await expect(saveProviderCredential(authRef, 'b'.repeat(2_500))).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe(firstMarker);
    expect(keyring.values.has(journalKey)).toBe(true);
    keyring.failSetSuffix = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(first);
    expect(currentChunkKeys().sort()).toEqual(firstChunks.sort());
    expectActiveInventory();
  });

  it('recovers journaled chunks when publishing the new marker fails', async () => {
    const first = 'a'.repeat(2_500);
    await expect(saveProviderCredential(authRef, first)).resolves.toBe(true);
    const firstMarker = keyring.values.get(mainKey);
    const firstChunks = currentChunkKeys();

    keyring.failSetKey = mainKey;
    await expect(saveProviderCredential(authRef, 'b'.repeat(2_500))).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe(firstMarker);
    expect(keyring.values.has(journalKey)).toBe(true);
    keyring.failSetKey = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(first);
    expect(currentChunkKeys().sort()).toEqual(firstChunks.sort());
    expectActiveInventory();
  });

  it('retains a short fallback when its second read collapses before a failed long write', async () => {
    const first = 'short-secret';
    await expect(saveProviderCredential(authRef, first)).resolves.toBe(true);

    let mainReads = 0;
    keyring.omitFindOnceKey = mainKey;
    keyring.onGet = key => {
      if (key === mainKey && ++mainReads === 2) {
        throw new Error('injected collapsed keyring read failure');
      }
    };
    keyring.failSetSuffix = '::1';

    await expect(saveProviderCredential(authRef, 'b'.repeat(2_500))).resolves.toBe(false);

    keyring.onGet = null;
    keyring.failSetSuffix = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(first);
    expect(keyring.values.get(mainKey)).toBe(first);
    expect(currentChunkKeys()).toEqual([]);
    expectActiveShort(first);
  });

  it('retains a long fallback when its second read collapses before a failed short write', async () => {
    const first = 'a'.repeat(2_500);
    await expect(saveProviderCredential(authRef, first)).resolves.toBe(true);
    const marker = publishedMarker();
    const chunks = currentChunkKeys();

    let mainReads = 0;
    keyring.omitFindOnceKey = mainKey;
    keyring.onGet = key => {
      if (key === mainKey && ++mainReads === 2) {
        throw new Error('injected collapsed keyring read failure');
      }
    };
    keyring.failSetKey = mainKey;

    await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(false);

    keyring.onGet = null;
    keyring.failSetKey = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(first);
    expect(currentChunkKeys().sort()).toEqual(chunks.sort());
    expectActiveInventory(marker);
  });

  it('recovers a short credential when publishing a long marker fails', async () => {
    const first = 'short-secret';
    await expect(saveProviderCredential(authRef, first)).resolves.toBe(true);
    keyring.failSetKey = mainKey;

    await expect(saveProviderCredential(authRef, 'b'.repeat(2_500))).resolves.toBe(false);

    keyring.failSetKey = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(first);
    expect(keyring.values.get(mainKey)).toBe(first);
    expect(currentChunkKeys()).toEqual([]);
    expectActiveShort(first);
  });

  it('recovers a long credential when publishing a short value fails', async () => {
    const first = 'a'.repeat(2_500);
    await expect(saveProviderCredential(authRef, first)).resolves.toBe(true);
    const marker = publishedMarker();
    const chunks = currentChunkKeys();
    keyring.failSetKey = mainKey;

    await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(false);

    keyring.failSetKey = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(first);
    expect(currentChunkKeys().sort()).toEqual(chunks.sort());
    expectActiveInventory(marker);
  });

  it('retries an unpublished long credential after chunk or marker publication fails', async () => {
    const secret = 'a'.repeat(2_500);
    for (const failure of ['chunk', 'marker'] as const) {
      clearMockKeyringState();
      keyring.operations = [];
      if (failure === 'chunk') keyring.failSetSuffix = '::1';
      else keyring.failSetKey = mainKey;

      await expect(saveProviderCredential(authRef, secret)).resolves.toBe(false);

      keyring.failSetSuffix = '';
      keyring.failSetKey = '';
      await expect(saveProviderCredential(authRef, secret)).resolves.toBe(true);
      await expect(resolveProviderCredential('test', authRef)).resolves.toBe(secret);
      expectActiveInventory();
    }
  });

  it('verifies a first long publication after a transient collapsed marker read', async () => {
    const secret = 'a'.repeat(2_500);
    let remainingCollapsedReads = 2;
    keyring.onGet = key => {
      const markerWasPublished = keyring.operations.some(
        operation => operation.type === 'set' && operation.key === mainKey,
      );
      if (key === mainKey && markerWasPublished && remainingCollapsedReads > 0) {
        remainingCollapsedReads--;
        keyring.omitFindOnceKey = mainKey;
        throw new Error('injected collapsed keyring read failure');
      }
    };

    await expect(saveProviderCredential(authRef, secret)).resolves.toBe(false);

    expect(remainingCollapsedReads).toBe(1);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(secret);
    expect(remainingCollapsedReads).toBe(0);
    expect(currentChunkKeys()).toHaveLength(3);
    expect(keyring.values.has(journalKey)).toBe(true);

    keyring.onGet = null;
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(secret);
    expect(currentChunkKeys()).toHaveLength(3);
    expectActiveInventory();
  });

  it('reuses the provisioned account after an ambiguous publication result', async () => {
    const secret = 'a'.repeat(2_500);
    let remainingCollapsedReads = 2;
    keyring.onGet = key => {
      const markerWasPublished = keyring.operations.some(
        operation => operation.type === 'set' && operation.key === mainKey,
      );
      if (key === mainKey && markerWasPublished && remainingCollapsedReads > 0) {
        remainingCollapsedReads--;
        keyring.omitFindOnceKey = mainKey;
        throw new Error('injected collapsed keyring read failure');
      }
    };

    await expect(provisionProviderCredential(authRef, secret)).resolves.toBe(false);

    keyring.onGet = null;
    await expect(provisionProviderCredential(authRef, secret)).resolves.toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(secret);
    expectActiveInventory();
  });

  it('retries an unpublished short credential after publication fails', async () => {
    keyring.failSetKey = mainKey;
    await expect(saveProviderCredential(authRef, 'first-secret')).resolves.toBe(false);

    keyring.failSetKey = '';
    await expect(saveProviderCredential(authRef, 'different-secret')).resolves.toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('different-secret');
    expectActiveShort('different-secret');
  });

  it('replays the first journal write after publication fails', async () => {
    keyring.failSetKey = journalKey;
    await expect(provisionProviderCredential(authRef, 'short-secret')).resolves.toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);

    keyring.failSetKey = '';
    await expect(provisionProviderCredential(authRef, 'short-secret')).resolves.toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('short-secret');
    expectActiveShort('short-secret');
  });

  it('shares interrupted journal intent across config homes', async () => {
    const firstConfigHome = mkdtempSync(join(tmpdir(), 'clodex-config-a-'));
    const secondConfigHome = mkdtempSync(join(tmpdir(), 'clodex-config-b-'));
    try {
      process.env.CLODEX_HOME = firstConfigHome;
      keyring.failSetKey = journalKey;
      await expect(provisionProviderCredential(authRef, 'first-secret')).resolves.toBe(false);
      expect(existsSync(managedStatePath())).toBe(true);

      process.env.CLODEX_HOME = secondConfigHome;
      keyring.failSetKey = '';
      await expect(provisionProviderCredential(authRef, 'second-secret')).resolves.toBe(true);

      process.env.CLODEX_HOME = firstConfigHome;
      await expect(resolveProviderCredential('test', authRef)).resolves.toBe('second-secret');
      expect(existsSync(join(firstConfigHome, 'keyring-state'))).toBe(false);
      expect(existsSync(join(secondConfigHome, 'keyring-state'))).toBe(false);
    } finally {
      rmSync(firstConfigHome, { recursive: true, force: true });
      rmSync(secondConfigHome, { recursive: true, force: true });
    }
  });

  it('replays a failed replacement journal without losing the active credential', async () => {
    await expect(saveProviderCredential(authRef, 'first-secret')).resolves.toBe(true);

    keyring.failSetKey = journalKey;
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(false);

    keyring.failSetKey = '';
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('a'.repeat(2_500));
    expectActiveInventory();
  });

  it('fails closed when the local journal intent is malformed', async () => {
    const diagnostics: string[] = [];
    mkdirSync(join(keyring.lockHome, '.clodex', 'keyring-state'), { recursive: true });
    writeFileSync(managedStatePath(), 'v1:preparing:not-valid!\n', { mode: 0o600 });

    await expect(
      provisionProviderCredential(authRef, 'short-secret', message => diagnostics.push(message)),
    ).resolves.toBe(false);

    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
    expect(diagnostics).toContain('keyring error: keyring managed-state marker is invalid');
  });

  it('removes old chunks after replacing a long credential with a short one', async () => {
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    expect(currentChunkKeys()).toHaveLength(3);

    await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(true);

    expect(keyring.values.get(mainKey)).toBe('short-secret');
    expect(currentChunkKeys()).toEqual([]);
    expectActiveShort('short-secret');
  });

  it('retains cleanup inventory until an older-release removal is confirmed', async () => {
    const secret = 'a'.repeat(2_500);
    await expect(saveProviderCredential(authRef, secret)).resolves.toBe(true);
    const marker = publishedMarker();
    const chunks = currentChunkKeys();
    expect(chunks).toHaveLength(3);
    expectActiveInventory(marker);

    keyring.values.delete(mainKey);

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(chunks.every(key => keyring.values.has(key))).toBe(true);
    expectActiveInventory(marker);

    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(chunks.every(key => !keyring.values.has(key))).toBe(true);
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('preserves active chunks when a collapsed main read omits the entry', async () => {
    const secret = 'a'.repeat(2_500);
    await expect(saveProviderCredential(authRef, secret)).resolves.toBe(true);
    const marker = keyring.values.get(mainKey);
    const journal = keyring.values.get(journalKey);
    const chunks = currentChunkKeys();
    keyring.omitFindKey = mainKey;
    keyring.onGet = key => {
      if (key === mainKey) throw new Error('injected collapsed keyring read failure');
    };

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();

    expect(keyring.values.get(mainKey)).toBe(marker);
    expect(keyring.values.get(journalKey)).toBe(journal);
    expect(chunks.every(key => keyring.values.has(key))).toBe(true);
  });

  it('reads and deletes valid legacy chunks', async () => {
    keyring.values.set(mainKey, '__relay_chunked__:2');
    keyring.values.set(`clodex:${account}::chunk::0`, 'legacy-');
    keyring.values.set(`clodex:${account}::chunk::1`, 'secret');

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('legacy-secret');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(currentChunkKeys()).toEqual([]);
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('does not replace pre-journal chunks when keychain reads hide the account', async () => {
    const marker = '__relay_chunked__:2';
    const firstChunk = `clodex:${account}::chunk::0`;
    const secondChunk = `clodex:${account}::chunk::1`;
    keyring.values.set(mainKey, marker);
    keyring.values.set(firstChunk, 'legacy-');
    keyring.values.set(secondChunk, 'secret');
    keyring.omitFindAccount = account;
    keyring.onGet = key => {
      if (key.endsWith(`:${account}`) || key.includes(`:${account}::chunk::`))
        throw new Error('injected collapsed keyring read failure');
    };

    await expect(replaceProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe(marker);
    expect(keyring.values.get(firstChunk)).toBe('legacy-');
    expect(keyring.values.get(secondChunk)).toBe('secret');
    expect(keyring.values.has(journalKey)).toBe(false);
    expect(keyring.operations).toEqual([]);
  });

  it('does not delete pre-journal chunks when keychain reads hide the account', async () => {
    const marker = '__relay_chunked__:2';
    const firstChunk = `clodex:${account}::chunk::0`;
    const secondChunk = `clodex:${account}::chunk::1`;
    keyring.values.set(mainKey, marker);
    keyring.values.set(firstChunk, 'legacy-');
    keyring.values.set(secondChunk, 'secret');
    keyring.omitFindAccount = account;
    keyring.onGet = key => {
      if (key.endsWith(`:${account}`) || key.includes(`:${account}::chunk::`))
        throw new Error('injected collapsed keyring read failure');
    };

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe(marker);
    expect(keyring.values.get(firstChunk)).toBe('legacy-');
    expect(keyring.values.get(secondChunk)).toBe('secret');
    expect(keyring.values.has(journalKey)).toBe(false);
    expect(keyring.values.has(deletedKey)).toBe(false);
    expect(keyring.operations).toEqual([]);
  });

  it('does not report deletion success while credential chunks remain', async () => {
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    keyring.failDeleteSuffix = '::1';

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expectDeletionGuard();
    expect(keyring.values.has(journalKey)).toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    keyring.failDeleteSuffix = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(currentChunkKeys()).toEqual([]);
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('preserves transition inventory when the first delete journal read collapses', async () => {
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    keyring.failDeleteSuffix = '::0';
    await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(true);
    expect(currentChunkKeys().length).toBeGreaterThan(0);
    keyring.failDeleteSuffix = '';
    let remainingCollapsedReads = 2;
    keyring.onGet = key => {
      if (key === journalKey && remainingCollapsedReads > 0) {
        remainingCollapsedReads--;
        keyring.omitFindOnceKey = journalKey;
        throw new Error('injected collapsed keyring read failure');
      }
    };

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(remainingCollapsedReads).toBe(0);
    expect(currentChunkKeys().length).toBeGreaterThan(0);
    expect(keyring.values.get(mainKey)).toBe('short-secret');
    keyring.onGet = null;
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(currentChunkKeys()).toEqual([]);
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('keeps a deletion journal when the final marker cannot be written', async () => {
    await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(true);
    keyring.values.set(
      journalKey,
      `${journalPrefix}${JSON.stringify({
        mode: 'delete',
        generations: [],
        blockLegacy: true,
      })}`,
    );
    keyring.failSetKey = journalKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expectDeletionGuard();
    expect(keyring.values.get(journalKey)).toMatch(/^__relay_chunk_journal__:v1:/);
    keyring.failSetKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('keeps the credential published when the deletion guard cannot be written', async () => {
    await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(true);
    keyring.failSetKey = deletedKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe('short-secret');
    expect(keyring.values.has(journalKey)).toBe(true);
    expect(keyring.values.has(deletedKey)).toBe(false);
    keyring.failSetKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expectDeletionMarker();
  });

  it('persists an expanded same-generation count before unpublishing', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const firstChunk = `clodex:${account}::chunk::${generation}::0`;
    const secondChunk = `clodex:${account}::chunk::${generation}::1`;
    keyring.values.set(mainKey, `__relay_chunked__:v2:${generation}:2`);
    keyring.values.set(firstChunk, 'first-');
    keyring.values.set(secondChunk, 'second');
    keyring.values.set(
      journalKey,
      `${journalPrefix}${JSON.stringify({
        mode: 'delete',
        generations: [{ count: 1, generation }],
      })}`,
    );
    keyring.failDeleteSuffix = '::1';

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    const pending = JSON.parse(keyring.values.get(journalKey)!.slice(journalPrefix.length)) as {
      generations: Array<{ count: number }>;
    };
    expect(pending.generations).toEqual([{ count: 2, generation }]);
    expectDeletionGuard();
    expect(keyring.values.has(secondChunk)).toBe(true);
    keyring.failDeleteSuffix = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(keyring.values.has(firstChunk)).toBe(false);
    expect(keyring.values.has(secondChunk)).toBe(false);
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('keeps a credential inaccessible while a deletion journal cannot unpublish it', async () => {
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'delete',
      generations: [],
    })}`;
    keyring.values.set(mainKey, 'pending-delete-secret');
    keyring.values.set(journalKey, journal);
    keyring.failDeleteKey = mainKey;

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();

    const tombstone = keyring.values.get(mainKey)!;
    expect(tombstone).toMatch(/^__clodex_delete__:/);
    expect(keyring.values.get(mainKey)).not.toBe('pending-delete-secret');
    expect(keyring.values.get(journalKey)).toBe(journal);
    keyring.values.delete(journalKey);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(keyring.values.get(mainKey)).toBe(tombstone);
    keyring.values.set(journalKey, journal);
    keyring.failDeleteKey = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
    expect(keyring.values.has(deletedKey)).toBe(false);
  });

  it('retries from the published marker when rotation removes chunks mid-read', async () => {
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    const oldChunks = currentChunkKeys();
    const generation = '11111111-1111-4111-8111-111111111111';
    keyring.onGet = key => {
      if (key !== oldChunks[0]) return;
      keyring.onGet = null;
      keyring.values.set(mainKey, `__relay_chunked__:v2:${generation}:2`);
      for (const oldChunk of oldChunks) keyring.values.delete(oldChunk);
      keyring.values.set(`clodex:${account}::chunk::${generation}::0`, 'replace');
      keyring.values.set(`clodex:${account}::chunk::${generation}::1`, 'ment');
    };

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('replacement');
  });

  it('fails closed for invalid markers and missing chunks', async () => {
    const diagnostics: string[] = [];
    keyring.values.set(mainKey, '__relay_chunked__:Infinity');
    await expect(resolveProviderCredential('test', authRef, message => {
      diagnostics.push(message);
      }),
    ).resolves.toBeNull();
    expect(diagnostics.join('\n')).toContain('invalid chunk marker');
    await expect(deleteProviderCredential(authRef, message => {
      diagnostics.push(message);
      }),
    ).resolves.toBe(false);
    expectDeletionGuard();
    expect(keyring.values.has(journalKey)).toBe(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.has(journalKey)).toBe(true);

    clearMockKeyringState();
    diagnostics.length = 0;
    keyring.values.set(mainKey, '__relay_chunked__:2');
    keyring.values.set(`clodex:${account}::chunk::0`, 'partial');
    await expect(resolveProviderCredential('test', authRef, message => {
      diagnostics.push(message);
      }),
    ).resolves.toBeNull();
    expect(diagnostics.join('\n')).toContain('chunk 2 of 2 is missing');

    diagnostics.length = 0;
    keyring.values.set(mainKey, `__relay_chunked__:v2:${'-'.repeat(36)}:2`);
    await expect(
      resolveProviderCredential('test', authRef, message => {
      diagnostics.push(message);
      }),
    ).resolves.toBeNull();
    expect(diagnostics.join('\n')).toContain('invalid chunk marker');
  });

  it('tombstones invalid chunk state before rejecting a replacement', async () => {
    keyring.values.set(mainKey, '__relay_chunked__:Infinity');
    keyring.values.set(`clodex:${account}::chunk::0`, 'untracked-secret');

    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe('__relay_chunked__:Infinity');
    const tombstone = expectUnverifiableTombstone();
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.get(journalKey)).toBe(tombstone);
    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);
    expect(keyring.values.get(journalKey)).toBe(tombstone);
  });

  it('reconciles journaled generations on either side of marker publication', async () => {
    const oldGeneration = '11111111-1111-4111-8111-111111111111';
    const newGeneration = '22222222-2222-4222-8222-222222222222';
    const oldMarker = `__relay_chunked__:v2:${oldGeneration}:2`;
    const newMarker = `__relay_chunked__:v2:${newGeneration}:2`;
    const journal = `__relay_chunk_journal__:v1:${JSON.stringify({
      mode: 'write',
      generations: [
        { count: 2, generation: newGeneration },
        { count: 2, generation: oldGeneration },
      ],
    })}`;
    const oldChunkKeys = [0, 1].map(index =>
      `clodex:${account}::chunk::${oldGeneration}::${index}`,
    );
    const newChunkKeys = [0, 1].map(index =>
      `clodex:${account}::chunk::${newGeneration}::${index}`,
    );

    keyring.values.set(mainKey, oldMarker);
    keyring.values.set(oldChunkKeys[0]!, 'old-');
    keyring.values.set(oldChunkKeys[1]!, 'secret');
    keyring.values.set(newChunkKeys[0]!, 'new-');
    keyring.values.set(newChunkKeys[1]!, 'secret');
    keyring.values.set(journalKey, journal);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('old-secret');
    expect(newChunkKeys.every(key => !keyring.values.has(key))).toBe(true);
    expect(oldChunkKeys.every(key => keyring.values.has(key))).toBe(true);
    expectActiveInventory({ count: 2, generation: oldGeneration });

    keyring.values.set(mainKey, newMarker);
    keyring.values.set(newChunkKeys[0]!, 'new-');
    keyring.values.set(newChunkKeys[1]!, 'secret');
    keyring.values.set(journalKey, journal);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('new-secret');
    expect(oldChunkKeys.every(key => !keyring.values.has(key))).toBe(true);
    expect(newChunkKeys.every(key => keyring.values.has(key))).toBe(true);
    expectActiveInventory({ count: 2, generation: newGeneration });
  });

  it('fails closed when the published generation is absent from the write journal', async () => {
    const publishedGeneration = '11111111-1111-4111-8111-111111111111';
    const recoveryGeneration = '22222222-2222-4222-8222-222222222222';
    const publishedMarker = `__relay_chunked__:v2:${publishedGeneration}:1`;
    const publishedChunk = `clodex:${account}::chunk::${publishedGeneration}::0`;
    const recoveryChunk = `clodex:${account}::chunk::${recoveryGeneration}::0`;
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'write',
      generations: [{ count: 1, generation: recoveryGeneration }],
    })}`;
    const diagnostics: string[] = [];
    keyring.values.set(mainKey, publishedMarker);
    keyring.values.set(publishedChunk, 'published-secret');
    keyring.values.set(recoveryChunk, 'recovery-secret');
    keyring.values.set(journalKey, journal);

    await expect(
      resolveProviderCredential('test', authRef, message => {
        diagnostics.push(message);
      }),
    ).resolves.toBeNull();

    expect(diagnostics.join('\n')).toContain(
      'published credential generation is not represented by cleanup journal',
    );
    expect(keyring.values.get(mainKey)).toBe(publishedMarker);
    expect(keyring.values.get(publishedChunk)).toBe('published-secret');
    expect(keyring.values.get(recoveryChunk)).toBe('recovery-secret');
    expect(keyring.values.get(journalKey)).toBe(journal);
    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);
  });

  it('rolls back before retiring the last complete generation', async () => {
    const oldGeneration = '11111111-1111-4111-8111-111111111111';
    const newGeneration = '22222222-2222-4222-8222-222222222222';
    const oldMarker = {
      count: 2,
      generation: oldGeneration,
    };
    const newValue = 'new-secret';
    const newMarker = {
      count: 2,
      generation: newGeneration,
      digest: createHash('sha256').update(newValue).digest('hex'),
    };
    keyring.values.set(mainKey, `__relay_chunked__:v3:${newGeneration}:2:${newMarker.digest}`);
    keyring.values.set(`clodex:${account}::chunk::${oldGeneration}::0`, 'old-');
    keyring.values.set(`clodex:${account}::chunk::${oldGeneration}::1`, 'secret');
    keyring.values.set(`clodex-chunks:${account}::chunk::${newGeneration}::0`, 'new-');
    keyring.values.set(
      journalKey,
      `__relay_chunk_journal__:v1:${JSON.stringify({
        mode: 'write',
        generations: [newMarker, oldMarker],
      })}`,
    );

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('old-secret');

    expect(keyring.values.get(mainKey)).toBe(`__relay_chunked__:v2:${oldGeneration}:2`);
    expect(keyring.values.has(`clodex:${account}::chunk::${oldGeneration}::0`)).toBe(true);
    expect(keyring.values.has(`clodex-chunks:${account}::chunk::${newGeneration}::0`)).toBe(false);
    expectActiveInventory(oldMarker);
  });

  it('trusts the published digest over a stale journal digest', async () => {
    const oldGeneration = '11111111-1111-4111-8111-111111111111';
    const newGeneration = '22222222-2222-4222-8222-222222222222';
    const oldMarker = {
      count: 2,
      generation: oldGeneration,
    };
    const newValue = 'new-secret';
    const publishedDigest = createHash('sha256').update(newValue).digest('hex');
    const staleDigest = createHash('sha256').update('stale-secret').digest('hex');
    const journalMarker = {
      count: 2,
      generation: newGeneration,
      digest: staleDigest,
    };
    keyring.values.set(mainKey, `__relay_chunked__:v3:${newGeneration}:2:${publishedDigest}`);
    keyring.values.set(`clodex-chunks:${account}::chunk::${newGeneration}::0`, 'new-');
    keyring.values.set(`clodex-chunks:${account}::chunk::${newGeneration}::1`, 'secret');
    keyring.values.set(`clodex:${account}::chunk::${oldGeneration}::0`, 'old-');
    keyring.values.set(`clodex:${account}::chunk::${oldGeneration}::1`, 'secret');
    keyring.values.set(
      journalKey,
      `__relay_chunk_journal__:v1:${JSON.stringify({
        mode: 'write',
        generations: [journalMarker, oldMarker],
      })}`,
    );

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(newValue);

    expect(keyring.values.get(mainKey)).toBe(
      `__relay_chunked__:v3:${newGeneration}:2:${publishedDigest}`,
    );
    expect(keyring.values.has(`clodex-chunks:${account}::chunk::${newGeneration}::0`)).toBe(true);
    expect(keyring.values.has(`clodex:${account}::chunk::${oldGeneration}::0`)).toBe(false);
    expectActiveInventory({
      count: 2,
      generation: newGeneration,
      digest: publishedDigest,
    });
  });

  it('removes journal-only tail chunks from the published generation', async () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const publishedValue = 'a';
    const journalValue = 'ab';
    const publishedDigest = createHash('sha256').update(publishedValue).digest('hex');
    const journalDigest = createHash('sha256').update(journalValue).digest('hex');
    const firstChunk = `clodex-chunks:${account}::chunk::${generation}::0`;
    const secondChunk = `clodex-chunks:${account}::chunk::${generation}::1`;
    keyring.values.set(mainKey, `__relay_chunked__:v3:${generation}:1:${publishedDigest}`);
    keyring.values.set(firstChunk, 'a');
    keyring.values.set(secondChunk, 'b');
    keyring.values.set(
      journalKey,
      `${journalPrefix}${JSON.stringify({
        mode: 'write',
        generations: [{ count: 2, digest: journalDigest, generation }],
      })}`,
    );

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(publishedValue);

    expect(keyring.values.get(mainKey)).toBe(
      `__relay_chunked__:v3:${generation}:1:${publishedDigest}`,
    );
    expect(keyring.values.has(firstChunk)).toBe(true);
    expect(keyring.values.has(secondChunk)).toBe(false);
    expectActiveInventory({ count: 1, digest: publishedDigest, generation });
  });

  it('repairs a stale published digest from a valid journal copy', async () => {
    const oldGeneration = '11111111-1111-4111-8111-111111111111';
    const newGeneration = '22222222-2222-4222-8222-222222222222';
    const newValue = 'new-secret';
    const currentDigest = createHash('sha256').update(newValue).digest('hex');
    const staleDigest = createHash('sha256').update('stale-secret').digest('hex');
    const currentMarker = {
      count: 2,
      generation: newGeneration,
      digest: currentDigest,
    };
    keyring.values.set(mainKey, `__relay_chunked__:v3:${newGeneration}:2:${staleDigest}`);
    keyring.values.set(`clodex-chunks:${account}::chunk::${newGeneration}::0`, 'new-');
    keyring.values.set(`clodex-chunks:${account}::chunk::${newGeneration}::1`, 'secret');
    keyring.values.set(`clodex:${account}::chunk::${oldGeneration}::0`, 'old-');
    keyring.values.set(`clodex:${account}::chunk::${oldGeneration}::1`, 'secret');
    keyring.values.set(
      journalKey,
      `__relay_chunk_journal__:v1:${JSON.stringify({
        mode: 'write',
        generations: [currentMarker, { count: 2, generation: oldGeneration }],
      })}`,
    );

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(newValue);

    expect(keyring.values.get(mainKey)).toBe(
      `__relay_chunked__:v3:${newGeneration}:2:${currentDigest}`,
    );
    expect(keyring.values.has(`clodex-chunks:${account}::chunk::${newGeneration}::0`)).toBe(true);
    expect(keyring.values.has(`clodex:${account}::chunk::${oldGeneration}::0`)).toBe(false);
    expectActiveInventory(currentMarker);
  });

  it('removes published tail chunks before restoring a shorter journal marker', async () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const recoveredValue = 'a';
    const recoveredDigest = createHash('sha256').update(recoveredValue).digest('hex');
    const staleDigest = createHash('sha256').update('stale-value').digest('hex');
    const firstChunk = `clodex-chunks:${account}::chunk::${generation}::0`;
    const secondChunk = `clodex-chunks:${account}::chunk::${generation}::1`;
    keyring.values.set(mainKey, `__relay_chunked__:v3:${generation}:2:${staleDigest}`);
    keyring.values.set(firstChunk, 'a');
    keyring.values.set(secondChunk, 'b');
    keyring.values.set(
      journalKey,
      `${journalPrefix}${JSON.stringify({
        mode: 'write',
        generations: [{ count: 1, digest: recoveredDigest, generation }],
      })}`,
    );

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(recoveredValue);

    expect(keyring.values.get(mainKey)).toBe(
      `__relay_chunked__:v3:${generation}:1:${recoveredDigest}`,
    );
    expect(keyring.values.has(firstChunk)).toBe(true);
    expect(keyring.values.has(secondChunk)).toBe(false);
    expectActiveInventory({ count: 1, digest: recoveredDigest, generation });
  });

  it('requires an explicit save before replacing a relay-ai source', async () => {
    const legacyMainKey = `relay-ai:${account}`;
    keyring.values.set(legacyMainKey, 'legacy-secret');

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');

    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(true);
    expect(keyring.values.get(mainKey)).toBe('replacement-secret');
    expectActiveShort('replacement-secret');
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('replacement-secret');
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');

    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');
  });

  it('backfills active metadata for a pre-journal short credential', async () => {
    const legacyMainKey = `relay-ai:${account}`;
    keyring.values.set(mainKey, 'current-secret');
    keyring.values.set(legacyMainKey, 'stale-legacy-secret');

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('current-secret');

    expectActiveShort('current-secret');
    expect(keyring.values.get(legacyMainKey)).toBe('stale-legacy-secret');
  });

  it('fails closed when the first pre-journal short read collapses', async () => {
    const legacyMainKey = `relay-ai:${account}`;
    keyring.values.set(mainKey, 'current-secret');
    keyring.values.set(legacyMainKey, 'stale-legacy-secret');
    keyring.omitFindKey = mainKey;
    keyring.onGet = key => {
      if (key === mainKey) throw new Error('injected collapsed keyring read failure');
    };

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();

    expect(keyring.values.get(mainKey)).toBe('current-secret');
    expect(keyring.values.has(journalKey)).toBe(false);
    expect(keyring.values.get(legacyMainKey)).toBe('stale-legacy-secret');

    keyring.omitFindKey = '';
    keyring.onGet = null;
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('current-secret');
    expectActiveShort('current-secret');
  });

  it('round-trips and deletes short credentials that resemble chunk markers', async () => {
    for (const secret of ['__relay_chunked__:legitimate-provider-secret', '__relay_chunked__:2']) {
      clearMockKeyringState();

      await expect(saveProviderCredential(authRef, secret)).resolves.toBe(true);
      expectActiveShort(secret);
      await expect(resolveProviderCredential('test', authRef)).resolves.toBe(secret);
      await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
      expectDeletionGuard();
      expectDeletionMarker();
    }
  });

  it('removes all durable state after a disposable keyring probe', async () => {
    await expect(probeProviderCredentialStore(authRef)).resolves.toBe(true);

    expect([...keyring.values.entries()]).toEqual([]);
    const stateDirectory = join(keyring.lockHome, '.clodex', 'keyring-state');
    expect(existsSync(stateDirectory) ? readdirSync(stateDirectory) : []).toEqual([]);
  });

  it('blocks legacy migration when a deleted journal read collapses to null', async () => {
    const legacyMainKey = `relay-ai:${account}`;
    keyring.values.set(legacyMainKey, 'legacy-secret');
    await expect(saveProviderCredential(authRef, 'current-secret')).resolves.toBe(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    const deletionJournal = keyring.values.get(journalKey);
    keyring.omitFindKey = journalKey;
    keyring.onGet = key => {
      if (key === journalKey) throw new Error('injected collapsed keyring read failure');
    };

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();

    expectDeletionGuard();
    expect(keyring.values.get(journalKey)).toBe(deletionJournal);
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');
  });

  it('restores deleted state when the first guard snapshot collapses', async () => {
    await expect(saveProviderCredential(authRef, 'current-secret')).resolves.toBe(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    keyring.values.delete(journalKey);
    let guardReads = 0;
    keyring.omitFindOnceKey = deletedKey;
    keyring.onGet = key => {
      if (key === deletedKey && ++guardReads === 1) {
        throw new Error('injected collapsed keyring read failure');
      }
    };

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();

    expectDeletionGuard();
    expect(keyring.values.has(journalKey)).toBe(false);
    keyring.onGet = null;
    keyring.omitFindOnceKey = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expectDeletionMarker();
  });

  it('clears restored deletion metadata when a replacement is explicitly saved', async () => {
    await expect(saveProviderCredential(authRef, 'current-secret')).resolves.toBe(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    const collapsed = new Set([deletedKey, journalKey]);
    keyring.onGet = key => {
      if (collapsed.delete(key)) {
        keyring.omitFindOnceKey = key;
        throw new Error('injected collapsed keyring read failure');
      }
    };

    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(true);

    keyring.onGet = null;
    expect(keyring.values.has(deletedKey)).toBe(false);
    expectActiveShort('replacement-secret');
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('replacement-secret');
  });

  it('does not publish a replacement until the deletion guard is cleared', async () => {
    await expect(saveProviderCredential(authRef, 'current-secret')).resolves.toBe(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    keyring.failDeleteKey = deletedKey;

    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);

    expect(keyring.values.has(mainKey)).toBe(false);
    expectDeletionMarker();
    keyring.values.delete(journalKey);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expectDeletionMarker();

    keyring.failDeleteKey = '';
    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(true);
    expect(keyring.values.has(deletedKey)).toBe(false);
    expectActiveShort('replacement-secret');
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('replacement-secret');
  });

  it('retires a credential recreated behind a deleted marker', async () => {
    await expect(saveProviderCredential(authRef, 'first-secret')).resolves.toBe(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    keyring.values.set(mainKey, 'credential-written-by-older-release');

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();

    expectDeletionGuard();
    expectDeletionMarker();
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
  });

  it('deletes Clodex chunks without touching relay-ai chunks', async () => {
    const currentGeneration = '11111111-1111-4111-8111-111111111111';
    const legacyGeneration = '22222222-2222-4222-8222-222222222222';
    const currentChunk = `clodex:${account}::chunk::${currentGeneration}::0`;
    const legacyChunk = `relay-ai:${account}::chunk::${legacyGeneration}::0`;
    keyring.values.set(mainKey, `__relay_chunked__:v2:${currentGeneration}:1`);
    keyring.values.set(`relay-ai:${account}`, `__relay_chunked__:v2:${legacyGeneration}:1`);
    keyring.values.set(currentChunk, 'current-secret');
    keyring.values.set(legacyChunk, 'legacy-secret');
    keyring.failDeleteSuffix = '::0';

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.has(journalKey)).toBe(true);
    expectDeletionGuard();
    expect(keyring.values.get(`relay-ai:${account}`)).toBe(
      `__relay_chunked__:v2:${legacyGeneration}:1`,
    );
    expect(keyring.values.get(legacyChunk)).toBe('legacy-secret');

    keyring.failDeleteSuffix = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(keyring.values.has(currentChunk)).toBe(false);
    expect(keyring.values.get(legacyChunk)).toBe('legacy-secret');
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('captures a published generation missing from an existing deletion journal', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const v3Value = 'retired-secret';
    const v3Marker = {
      count: 1,
      generation,
      digest: createHash('sha256').update(v3Value).digest('hex'),
    };
    const v2ChunkKey = `clodex:${account}::chunk::${generation}::0`;
    const v3ChunkKey = `clodex-chunks:${account}::chunk::${generation}::0`;
    keyring.values.set(mainKey, `__relay_chunked__:v2:${generation}:1`);
    keyring.values.set(v2ChunkKey, 'published-secret');
    keyring.values.set(v3ChunkKey, v3Value);
    keyring.values.set(
      journalKey,
      `__relay_chunk_journal__:v1:${JSON.stringify({
        mode: 'delete',
        generations: [v3Marker],
      })}`,
    );

    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);

    expectDeletionGuard();
    expect(keyring.values.has(v2ChunkKey)).toBe(false);
    expect(keyring.values.has(v3ChunkKey)).toBe(false);
    expectDeletionMarker();
  });

  it('compacts a full deletion journal before adding newly observed generations', async () => {
    const currentGenerations = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const currentPublished = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    for (const generation of currentGenerations) {
      keyring.values.set(`clodex:${account}::chunk::${generation}::0`, generation);
    }
    keyring.values.set(mainKey, `__relay_chunked__:v2:${currentPublished}:1`);
    keyring.values.set(`clodex:${account}::chunk::${currentPublished}::0`, 'current');
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'delete',
      generations: currentGenerations.map(generation => ({
        count: 1,
        generation,
      })),
    })}`;
    keyring.values.set(journalKey, journal);
    keyring.failSetKey = mainKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    const expandedJournal = keyring.values.get(journalKey)!;
    expect(expandedJournal.startsWith(journalPrefix)).toBe(true);
    const expanded = JSON.parse(expandedJournal.slice(journalPrefix.length)) as {
      generations: unknown[];
    };
    expect(expanded.generations).toHaveLength(1);
    expect(currentChunkKeys()).toHaveLength(1);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    keyring.failSetKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(currentChunkKeys()).toEqual([]);
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('compacts a full v3 deletion journal before adding the published generation', async () => {
    const currentGenerations = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const currentPublished = '88888888-8888-4888-8888-888888888888';
    const markerFor = (generation: string) => {
      const value = `secret-${generation}`;
      return {
        marker: {
          count: 1,
          generation,
          digest: createHash('sha256').update(value).digest('hex'),
        },
        value,
      };
    };
    const currentMarkers = currentGenerations.map(markerFor);
    const current = markerFor(currentPublished);
    for (const { marker, value } of [...currentMarkers, current]) {
      keyring.values.set(`clodex-chunks:${account}::chunk::${marker.generation}::0`, value);
    }
    keyring.values.set(
      mainKey,
      `__relay_chunked__:v3:${currentPublished}:1:${current.marker.digest}`,
    );
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'delete',
      generations: currentMarkers.map(({ marker }) => marker),
    })}`;
    expect(journal.length).toBeLessThanOrEqual(1_200);
    keyring.values.set(journalKey, journal);
    keyring.failSetKey = mainKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    const compactedJournal = keyring.values.get(journalKey)!;
    const compacted = JSON.parse(compactedJournal.slice(journalPrefix.length)) as {
      generations: unknown[];
    };
    expect(compacted.generations).toHaveLength(1);
    expect(currentChunkKeys()).toHaveLength(1);
    keyring.failSetKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(currentChunkKeys()).toEqual([]);
    expectDeletionGuard();
    expectDeletionMarker();
  });

  it('preserves main markers when a deletion-journal expansion cannot be written', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const chunkKey = `clodex:${account}::chunk::${generation}::0`;
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'delete',
      generations: [],
    })}`;
    keyring.values.set(mainKey, `__relay_chunked__:v2:${generation}:1`);
    keyring.values.set(chunkKey, 'pending-secret');
    keyring.values.set(journalKey, journal);
    keyring.failSetKey = journalKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe(`__relay_chunked__:v2:${generation}:1`);
    expect(keyring.values.get(chunkKey)).toBe('pending-secret');
    expect(keyring.values.get(journalKey)).toBe(journal);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    keyring.failSetKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expectDeletionGuard();
    expect(keyring.values.has(chunkKey)).toBe(false);
    expectDeletionMarker();
  });

  it('falls back to credential enumeration when getPassword returns null', async () => {
    keyring.values.set(mainKey, 'stored-secret');
    keyring.onGet = key => {
      if (key !== mainKey) return;
      keyring.onGet = null;
      throw new Error('injected collapsed keyring read failure');
    };

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('stored-secret');
    expect(keyring.values.get(mainKey)).toBe('stored-secret');
  });

  it('does not replace a valid journal after a transient journal read failure', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const marker = `__relay_chunked__:v2:${generation}:1`;
    const chunkKey = `clodex:${account}::chunk::${generation}::0`;
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'delete',
      generations: [],
    })}`;
    keyring.values.set(mainKey, marker);
    keyring.values.set(chunkKey, 'pending-secret');
    keyring.values.set(journalKey, journal);
    keyring.failFindService = 'clodex-journal';
    keyring.failFindCount = 1;
    let journalReads = 0;
    keyring.onGet = key => {
      if (key !== journalKey || ++journalReads !== 2) return;
      keyring.onGet = null;
      throw new Error('injected keyring read failure');
    };

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(JSON.parse(keyring.values.get(journalKey)!.slice(journalPrefix.length))).toEqual({
      mode: 'delete',
      generations: [],
      blockLegacy: true,
    });
    expect(keyring.values.get(mainKey)).toBe(marker);
    expect(keyring.values.get(chunkKey)).toBe('pending-secret');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expectDeletionMarker();
    expectDeletionGuard();
    expect(keyring.values.has(chunkKey)).toBe(false);
  });

  it('does not unpublish chunks after a transient main-entry read failure', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const marker = `__relay_chunked__:v2:${generation}:1`;
    const chunkKey = `clodex:${account}::chunk::${generation}::0`;
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'delete',
      generations: [],
    })}`;
    keyring.values.set(mainKey, marker);
    keyring.values.set(chunkKey, 'pending-secret');
    keyring.values.set(journalKey, journal);
    keyring.failFindService = 'clodex';
    keyring.failFindCount = 1;
    let mainReads = 0;
    keyring.onGet = key => {
      if (key !== mainKey || ++mainReads !== 1) return;
      keyring.onGet = null;
      throw new Error('injected keyring read failure');
    };

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(JSON.parse(keyring.values.get(journalKey)!.slice(journalPrefix.length))).toEqual({
      mode: 'delete',
      generations: [],
      blockLegacy: true,
    });
    expect(keyring.values.get(mainKey)).toBe(marker);
    expect(keyring.values.get(chunkKey)).toBe('pending-secret');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expectDeletionMarker();
    expectDeletionGuard();
    expect(keyring.values.has(chunkKey)).toBe(false);
  });

  it('does not replace a valid write journal after a transient read failure', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const marker = { count: 1, generation };
    const encodedMarker = `__relay_chunked__:v2:${generation}:1`;
    const chunkKey = `clodex:${account}::chunk::${generation}::0`;
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'write',
      generations: [marker],
    })}`;
    keyring.values.set(mainKey, encodedMarker);
    keyring.values.set(chunkKey, 'published-secret');
    keyring.values.set(journalKey, journal);
    keyring.failFindService = 'clodex-journal';
    keyring.failFindCount = 1;
    keyring.onGet = key => {
      if (key !== journalKey) return;
      keyring.onGet = null;
      throw new Error('injected keyring read failure');
    };

    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);

    expect(keyring.values.get(journalKey)).toBe(journal);
    expect(keyring.values.get(mainKey)).toBe(encodedMarker);
    expect(keyring.values.get(chunkKey)).toBe('published-secret');
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('published-secret');
    expectActiveInventory(marker);
  });

  it('fails closed with a durable tombstone after a malformed journal', async () => {
    keyring.values.set(mainKey, 'existing-secret');
    keyring.values.set(journalKey, '__relay_chunk_journal__:v1:{');

    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);
    const writeTombstone = expectUnverifiableTombstone();
    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);
    expect(keyring.values.get(journalKey)).toBe(writeTombstone);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();

    keyring.values.set(`relay-ai:${account}`, 'legacy-secret');
    keyring.values.set(journalKey, '__relay_chunk_journal__:v1:{');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.get(`relay-ai:${account}`)).toBe('legacy-secret');
    const deleteTombstone = expectUnverifiableTombstone(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.get(`relay-ai:${account}`)).toBe('legacy-secret');
    expect(keyring.values.get(journalKey)).toBe(deleteTombstone);
  });

  it('keeps a tombstone while the Clodex credential cannot be unpublished', async () => {
    const legacyMainKey = `relay-ai:${account}`;
    const malformedJournal = '__relay_chunk_journal__:v1:{';
    keyring.values.set(mainKey, 'current-secret');
    keyring.values.set(legacyMainKey, 'legacy-secret');
    keyring.values.set(journalKey, malformedJournal);
    keyring.failDeleteKey = mainKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe('current-secret');
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');
    const tombstone = expectUnverifiableTombstone(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(keyring.values.get(mainKey)).toMatch(/^__clodex_delete__:/);
    expect(keyring.values.get(mainKey)).not.toBe('current-secret');
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');
    expect(keyring.values.get(journalKey)).toBe(tombstone);

    keyring.failDeleteKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expectDeletionGuard();
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.get(journalKey)).toBe(tombstone);
  });

  it('preserves chunk markers before replacing a malformed journal', async () => {
    const currentGeneration = '11111111-1111-4111-8111-111111111111';
    const legacyGeneration = '22222222-2222-4222-8222-222222222222';
    const currentChunk = `clodex:${account}::chunk::${currentGeneration}::0`;
    const legacyChunk = `relay-ai:${account}::chunk::${legacyGeneration}::0`;
    keyring.values.set(mainKey, `__relay_chunked__:v2:${currentGeneration}:1`);
    keyring.values.set(`relay-ai:${account}`, `__relay_chunked__:v2:${legacyGeneration}:1`);
    keyring.values.set(currentChunk, 'current-secret');
    keyring.values.set(legacyChunk, 'legacy-secret');
    keyring.values.set(journalKey, '__relay_chunk_journal__:v1:{');

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.has(mainKey)).toBe(true);
    expect(keyring.values.has(`relay-ai:${account}`)).toBe(true);
    expect(keyring.values.has(currentChunk)).toBe(true);
    expect(keyring.values.has(legacyChunk)).toBe(true);
    const tombstone = expectUnverifiableTombstone(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expectDeletionGuard();
    expect(keyring.values.get(`relay-ai:${account}`)).toBe(
      `__relay_chunked__:v2:${legacyGeneration}:1`,
    );
    expect(keyring.values.has(currentChunk)).toBe(false);
    expect(keyring.values.get(legacyChunk)).toBe('legacy-secret');
    const expandedTombstone = keyring.values.get(journalKey)!;
    expect(expandedTombstone).not.toBe(tombstone);
    expect(JSON.parse(expandedTombstone.slice(journalPrefix.length))).toEqual({
      mode: 'delete',
      generations: [{ count: 1, generation: currentGeneration }],
      blockLegacy: true,
      unverifiable: true,
    });
  });

  it('isolates the journal namespace from credential accounts', async () => {
    const journalCollisionAccount = `${account}::chunk-journal`;
    const journalCollisionRef = testCredentialAuthRef(journalCollisionAccount);
    await expect(
      saveProviderCredential(journalCollisionRef, 'journal-account-secret'),
    ).resolves.toBe(true);
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    await expect(resolveProviderCredential('test', journalCollisionRef)).resolves.toBe(
      'journal-account-secret',
    );
  });

  it('reserves legacy chunk account forms from credential references', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    keyring.values.set(mainKey, `__relay_chunked__:v2:${generation}:1`);
    keyring.values.set(`clodex:${account}::chunk::${generation}::0`, 'legacy-secret');
    const chunkCollisionAccount = `${account}::chunk::${generation}::0`;
    const chunkCollisionRef = `keyring:${chunkCollisionAccount}`;

    await expect(saveProviderCredential(chunkCollisionRef, 'collision-secret')).resolves.toBe(
      false,
    );
    await expect(resolveProviderCredential('test', chunkCollisionRef)).resolves.toBeNull();
    await expect(deleteProviderCredential(chunkCollisionRef)).resolves.toBe(false);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('legacy-secret');
  });

  it('allows non-canonical chunk-like account names that cannot collide', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const safeRefs = [
      testCredentialAuthRef(`${account}::chunk::00`),
      testCredentialAuthRef(`${account}::chunk::${generation}::00`),
    ];

    for (const [index, safeRef] of safeRefs.entries()) {
      const value = `safe-secret-${index}`;
      await expect(saveProviderCredential(safeRef, value)).resolves.toBe(true);
      await expect(resolveProviderCredential('test', safeRef)).resolves.toBe(value);
    }
  });

  it('returns JSON-shaped non-OAuth credentials as opaque values', async () => {
    const opaqueRef = testCredentialAuthRef('provider:test');
    const opaqueValue = '{"type":"custom","access":"opaque"}';

    await expect(saveProviderCredential(opaqueRef, opaqueValue)).resolves.toBe(true);
    await expect(resolveProviderCredential('test', opaqueRef)).resolves.toBe(opaqueValue);
  });

  it('round-trips credentials that begin with the internal tombstone prefix', async () => {
    const providerRef = testCredentialAuthRef('provider:test');
    const opaqueValue = '__clodex_delete__:legitimate-provider-secret';

    await expect(saveProviderCredential(providerRef, opaqueValue)).resolves.toBe(true);
    await expect(resolveProviderCredential('test', providerRef)).resolves.toBe(opaqueValue);
  });

  it('decodes historical structured credentials for non-OAuth accounts', async () => {
    const providerRef = testCredentialAuthRef('provider:test');

    await expect(
      saveProviderCredential(providerRef, '{"type":"wellknown","token":"wellknown-token"}'),
    ).resolves.toBe(true);
    await expect(resolveProviderCredential('test', providerRef)).resolves.toBe('wellknown-token');

    await expect(
      saveProviderCredential(providerRef, '{"type":"oauth","access":"oauth-access"}'),
    ).resolves.toBe(true);
    await expect(resolveProviderCredential('test', providerRef)).resolves.toBe('oauth-access');
  });

  it('does not reinterpret malformed structured values as bearer credentials', async () => {
    keyring.values.set(mainKey, '{"type":"oauth","access":');
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
  });
});
