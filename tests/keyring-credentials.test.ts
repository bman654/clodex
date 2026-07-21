import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failSetSuffix: '' as string,
  failSetKey: '' as string,
  failDeleteSuffix: '' as string,
  failDeleteKey: '' as string,
  onGet: null as ((key: string) => void) | null,
  operations: [] as Array<{ type: 'set' | 'delete'; key: string; value?: string }>,
  lockHome: '' as string,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => keyring.lockHome || actual.homedir(),
  };
});

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    private readonly key: string;

    constructor(service: string, account: string) {
      this.key = `${service}:${account}`;
    }

    getPassword(): string | null {
      keyring.onGet?.(this.key);
      return keyring.values.get(this.key) ?? null;
    }

    setPassword(value: string): void {
      if (
        (keyring.failSetSuffix && this.key.endsWith(keyring.failSetSuffix))
        || (keyring.failSetKey && this.key === keyring.failSetKey)
      ) {
        throw new Error('injected keyring write failure');
      }
      keyring.operations.push({ type: 'set', key: this.key, value });
      keyring.values.set(this.key, value);
    }

    deletePassword(): void {
      if (
        (keyring.failDeleteSuffix && this.key.endsWith(keyring.failDeleteSuffix))
        || (keyring.failDeleteKey && this.key === keyring.failDeleteKey)
      ) {
        throw new Error('injected keyring delete failure');
      }
      keyring.operations.push({ type: 'delete', key: this.key });
      keyring.values.delete(this.key);
    }
  },
}));

import {
  deleteProviderCredential,
  resolveProviderCredential,
  saveProviderCredential,
} from '../src/env.js';

const account = 'oauth:provider:test';
const authRef = `keyring:${account}`;
const mainKey = `clodex:${account}`;
const journalKey = `clodex-journal:${account}`;
const journalPrefix = '__relay_chunk_journal__:v1:';
const previousHome = process.env.CLODEX_HOME;
let tempDir = '';

function currentChunkKeys(): string[] {
  return [...keyring.values.keys()].filter(key => key.includes(`${account}::chunk::`));
}

function expectUnverifiableTombstone(): string {
  const raw = keyring.values.get(journalKey);
  expect(raw?.startsWith(journalPrefix)).toBe(true);
  expect(JSON.parse(raw!.slice(journalPrefix.length))).toEqual({
    mode: 'delete',
    generations: [],
    unverifiable: true,
  });
  return raw!;
}

describe('keyring credential chunks', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clodex-keyring-'));
    process.env.CLODEX_HOME = tempDir;
    keyring.lockHome = tempDir;
    keyring.values.clear();
    keyring.failSetSuffix = '';
    keyring.failSetKey = '';
    keyring.failDeleteSuffix = '';
    keyring.failDeleteKey = '';
    keyring.onGet = null;
    keyring.operations = [];
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(tempDir, { recursive: true, force: true });
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
    const journalSetIndex = keyring.operations.findIndex(operation =>
      operation.type === 'set' && operation.key === journalKey,
    );
    const journalDeleteIndex = keyring.operations.findIndex(operation =>
      operation.type === 'delete' && operation.key === journalKey,
    );
    expect(markerSetIndex).toBeGreaterThanOrEqual(0);
    expect(journalSetIndex).toBeGreaterThanOrEqual(0);
    expect(journalDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(newChunkSetIndices).toHaveLength(2);
    expect(oldChunkDeleteIndices).toHaveLength(3);
    expect(newChunkSetIndices.every(index => journalSetIndex < index)).toBe(true);
    expect(newChunkSetIndices.every(index => index < markerSetIndex)).toBe(true);
    expect(oldChunkDeleteIndices.every(index => index > markerSetIndex)).toBe(true);
    expect(oldChunkDeleteIndices.every(index => index < journalDeleteIndex)).toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(second);
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
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(first);
    expect(currentChunkKeys().sort()).toEqual(firstChunks.sort());
    expect(keyring.values.has(journalKey)).toBe(false);
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
    expect(keyring.values.has(journalKey)).toBe(false);
  });

  it('removes old chunks after replacing a long credential with a short one', async () => {
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    expect(currentChunkKeys()).toHaveLength(3);

    await expect(saveProviderCredential(authRef, 'short-secret')).resolves.toBe(true);

    expect(keyring.values.get(mainKey)).toBe('short-secret');
    expect(currentChunkKeys()).toEqual([]);
  });

  it('reads and deletes valid legacy chunks', async () => {
    keyring.values.set(mainKey, '__relay_chunked__:2');
    keyring.values.set(`clodex:${account}::chunk::0`, 'legacy-');
    keyring.values.set(`clodex:${account}::chunk::1`, 'secret');

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('legacy-secret');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(keyring.values.size).toBe(0);
  });

  it('does not report deletion success while credential chunks remain', async () => {
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    keyring.failDeleteSuffix = '::1';

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    keyring.failDeleteSuffix = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(currentChunkKeys()).toEqual([]);
    expect(keyring.values.has(journalKey)).toBe(false);
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
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(secondChunk)).toBe(true);
    keyring.failDeleteSuffix = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(keyring.values.has(firstChunk)).toBe(false);
    expect(keyring.values.has(secondChunk)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
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

    expect(keyring.values.get(mainKey)).toBe('pending-delete-secret');
    expect(keyring.values.get(journalKey)).toBe(journal);
    keyring.failDeleteKey = '';
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
  });

  it('retries from the published marker when rotation removes chunks mid-read', async () => {
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    const oldChunks = currentChunkKeys();
    const generation = '11111111-1111-4111-8111-111111111111';
    keyring.onGet = (key) => {
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
    })).resolves.toBeNull();
    expect(diagnostics.join('\n')).toContain('invalid chunk marker');
    await expect(deleteProviderCredential(authRef, message => {
      diagnostics.push(message);
    })).resolves.toBe(false);
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(true);
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.has(journalKey)).toBe(true);

    keyring.values.clear();
    diagnostics.length = 0;
    keyring.values.set(mainKey, '__relay_chunked__:2');
    keyring.values.set(`clodex:${account}::chunk::0`, 'partial');
    await expect(resolveProviderCredential('test', authRef, message => {
      diagnostics.push(message);
    })).resolves.toBeNull();
    expect(diagnostics.join('\n')).toContain('chunk 2 of 2 is missing');

    diagnostics.length = 0;
    keyring.values.set(
      mainKey,
      `__relay_chunked__:v2:${'-'.repeat(36)}:2`,
    );
    await expect(resolveProviderCredential('test', authRef, message => {
      diagnostics.push(message);
    })).resolves.toBeNull();
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
    expect(keyring.values.has(journalKey)).toBe(false);

    keyring.values.set(mainKey, newMarker);
    keyring.values.set(newChunkKeys[0]!, 'new-');
    keyring.values.set(newChunkKeys[1]!, 'secret');
    keyring.values.set(journalKey, journal);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('new-secret');
    expect(oldChunkKeys.every(key => !keyring.values.has(key))).toBe(true);
    expect(newChunkKeys.every(key => keyring.values.has(key))).toBe(true);
    expect(keyring.values.has(journalKey)).toBe(false);
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
    keyring.values.set(
      mainKey,
      `__relay_chunked__:v3:${newGeneration}:2:${newMarker.digest}`,
    );
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

    expect(keyring.values.get(mainKey)).toBe(
      `__relay_chunked__:v2:${oldGeneration}:2`,
    );
    expect(keyring.values.has(`clodex:${account}::chunk::${oldGeneration}::0`)).toBe(true);
    expect(keyring.values.has(`clodex-chunks:${account}::chunk::${newGeneration}::0`)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
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
    keyring.values.set(
      mainKey,
      `__relay_chunked__:v3:${newGeneration}:2:${publishedDigest}`,
    );
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
    expect(keyring.values.has(journalKey)).toBe(false);
  });

  it('removes journal-only tail chunks from the published generation', async () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const publishedValue = 'a';
    const journalValue = 'ab';
    const publishedDigest = createHash('sha256').update(publishedValue).digest('hex');
    const journalDigest = createHash('sha256').update(journalValue).digest('hex');
    const firstChunk = `clodex-chunks:${account}::chunk::${generation}::0`;
    const secondChunk = `clodex-chunks:${account}::chunk::${generation}::1`;
    keyring.values.set(
      mainKey,
      `__relay_chunked__:v3:${generation}:1:${publishedDigest}`,
    );
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
    expect(keyring.values.has(journalKey)).toBe(false);
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
    keyring.values.set(
      mainKey,
      `__relay_chunked__:v3:${newGeneration}:2:${staleDigest}`,
    );
    keyring.values.set(`clodex-chunks:${account}::chunk::${newGeneration}::0`, 'new-');
    keyring.values.set(`clodex-chunks:${account}::chunk::${newGeneration}::1`, 'secret');
    keyring.values.set(`clodex:${account}::chunk::${oldGeneration}::0`, 'old-');
    keyring.values.set(`clodex:${account}::chunk::${oldGeneration}::1`, 'secret');
    keyring.values.set(
      journalKey,
      `__relay_chunk_journal__:v1:${JSON.stringify({
        mode: 'write',
        generations: [
          currentMarker,
          { count: 2, generation: oldGeneration },
        ],
      })}`,
    );

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe(newValue);

    expect(keyring.values.get(mainKey)).toBe(
      `__relay_chunked__:v3:${newGeneration}:2:${currentDigest}`,
    );
    expect(keyring.values.has(`clodex-chunks:${account}::chunk::${newGeneration}::0`)).toBe(true);
    expect(keyring.values.has(`clodex:${account}::chunk::${oldGeneration}::0`)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
  });

  it('removes published tail chunks before restoring a shorter journal marker', async () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const recoveredValue = 'a';
    const recoveredDigest = createHash('sha256').update(recoveredValue).digest('hex');
    const staleDigest = createHash('sha256').update('stale-value').digest('hex');
    const firstChunk = `clodex-chunks:${account}::chunk::${generation}::0`;
    const secondChunk = `clodex-chunks:${account}::chunk::${generation}::1`;
    keyring.values.set(
      mainKey,
      `__relay_chunked__:v3:${generation}:2:${staleDigest}`,
    );
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
    expect(keyring.values.has(journalKey)).toBe(false);
  });

  it('migrates under one account lock and deletes both keyring services', async () => {
    const legacyMainKey = `relay-ai:${account}`;
    keyring.values.set(legacyMainKey, 'legacy-secret');

    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('legacy-secret');
    expect(keyring.values.get(mainKey)).toBe('legacy-secret');
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');

    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(legacyMainKey)).toBe(false);
  });

  it('keeps deletion journaled until current and legacy chunks are gone', async () => {
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
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(`relay-ai:${account}`)).toBe(false);

    keyring.failDeleteSuffix = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(keyring.values.has(currentChunk)).toBe(false);
    expect(keyring.values.has(legacyChunk)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
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

    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(v2ChunkKey)).toBe(false);
    expect(keyring.values.has(v3ChunkKey)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
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
    const legacyGenerations = [
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
      '99999999-9999-4999-8999-999999999999',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ];
    const currentPublished = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const legacyPublished = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    for (const generation of currentGenerations) {
      keyring.values.set(`clodex:${account}::chunk::${generation}::0`, generation);
    }
    for (const generation of legacyGenerations) {
      keyring.values.set(`relay-ai:${account}::chunk::${generation}::0`, generation);
    }
    keyring.values.set(mainKey, `__relay_chunked__:v2:${currentPublished}:1`);
    keyring.values.set(`clodex:${account}::chunk::${currentPublished}::0`, 'current');
    keyring.values.set(`relay-ai:${account}`, `__relay_chunked__:v2:${legacyPublished}:1`);
    keyring.values.set(`relay-ai:${account}::chunk::${legacyPublished}::0`, 'legacy');
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'delete',
      generations: currentGenerations.map(generation => ({ count: 1, generation })),
      legacyGenerations: legacyGenerations.map(generation => ({ count: 1, generation })),
    })}`;
    keyring.values.set(journalKey, journal);
    keyring.failDeleteKey = mainKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    const expandedJournal = keyring.values.get(journalKey)!;
    expect(expandedJournal.startsWith(journalPrefix)).toBe(true);
    const expanded = JSON.parse(expandedJournal.slice(journalPrefix.length)) as {
      generations: unknown[];
      legacyGenerations: unknown[];
    };
    expect(expanded.generations).toHaveLength(1);
    expect(expanded.legacyGenerations).toHaveLength(1);
    expect(currentChunkKeys()).toHaveLength(2);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    keyring.failDeleteKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(currentChunkKeys()).toEqual([]);
    expect(keyring.values.has(journalKey)).toBe(false);
  });

  it('compacts a size-bound v3 journal even when its generation counts fit', async () => {
    const currentGenerations = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    const legacyGenerations = [
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ];
    const currentPublished = '88888888-8888-4888-8888-888888888888';
    const legacyPublished = '99999999-9999-4999-8999-999999999999';
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
    const legacyMarkers = legacyGenerations.map(markerFor);
    const current = markerFor(currentPublished);
    const legacy = markerFor(legacyPublished);
    for (const { marker, value } of [...currentMarkers, ...legacyMarkers, current, legacy]) {
      keyring.values.set(`clodex-chunks:${account}::chunk::${marker.generation}::0`, value);
    }
    keyring.values.set(
      mainKey,
      `__relay_chunked__:v3:${currentPublished}:1:${current.marker.digest}`,
    );
    keyring.values.set(
      `relay-ai:${account}`,
      `__relay_chunked__:v3:${legacyPublished}:1:${legacy.marker.digest}`,
    );
    const journal = `${journalPrefix}${JSON.stringify({
      mode: 'delete',
      generations: currentMarkers.map(({ marker }) => marker),
      legacyGenerations: legacyMarkers.map(({ marker }) => marker),
    })}`;
    expect(journal.length).toBeLessThanOrEqual(1_200);
    keyring.values.set(journalKey, journal);
    keyring.failDeleteKey = mainKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    const compactedJournal = keyring.values.get(journalKey)!;
    const compacted = JSON.parse(compactedJournal.slice(journalPrefix.length)) as {
      generations: unknown[];
      legacyGenerations: unknown[];
    };
    expect(compacted.generations).toHaveLength(1);
    expect(compacted.legacyGenerations).toHaveLength(1);
    expect(currentChunkKeys()).toHaveLength(2);
    keyring.failDeleteKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(currentChunkKeys()).toEqual([]);
    expect(keyring.values.has(journalKey)).toBe(false);
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
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(chunkKey)).toBe(false);
    expect(keyring.values.has(journalKey)).toBe(false);
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
    let journalReads = 0;
    keyring.onGet = (key) => {
      if (key !== journalKey || ++journalReads !== 2) return;
      keyring.onGet = null;
      throw new Error('injected keyring read failure');
    };

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.get(journalKey)).toBe(journal);
    expect(keyring.values.get(mainKey)).toBe(marker);
    expect(keyring.values.get(chunkKey)).toBe('pending-secret');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(keyring.values.has(journalKey)).toBe(false);
    expect(keyring.values.has(mainKey)).toBe(false);
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
    let mainReads = 0;
    keyring.onGet = (key) => {
      if (key !== mainKey || ++mainReads !== 2) return;
      keyring.onGet = null;
      throw new Error('injected keyring read failure');
    };

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.get(journalKey)).toBe(journal);
    expect(keyring.values.get(mainKey)).toBe(marker);
    expect(keyring.values.get(chunkKey)).toBe('pending-secret');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    expect(keyring.values.has(journalKey)).toBe(false);
    expect(keyring.values.has(mainKey)).toBe(false);
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
    keyring.onGet = (key) => {
      if (key !== journalKey) return;
      keyring.onGet = null;
      throw new Error('injected keyring read failure');
    };

    await expect(saveProviderCredential(authRef, 'replacement-secret')).resolves.toBe(false);

    expect(keyring.values.get(journalKey)).toBe(journal);
    expect(keyring.values.get(mainKey)).toBe(encodedMarker);
    expect(keyring.values.get(chunkKey)).toBe('published-secret');
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('published-secret');
    expect(keyring.values.has(journalKey)).toBe(false);
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
    const deleteTombstone = expectUnverifiableTombstone();
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.has(`relay-ai:${account}`)).toBe(false);
    expect(keyring.values.get(journalKey)).toBe(deleteTombstone);
  });

  it.each([
    { failedKey: mainKey, survivor: 'current-secret' },
    { failedKey: `relay-ai:${account}`, survivor: 'legacy-secret' },
  ])('keeps a tombstone while $failedKey cannot be unpublished', async ({ failedKey, survivor }) => {
    const legacyMainKey = `relay-ai:${account}`;
    const malformedJournal = '__relay_chunk_journal__:v1:{';
    keyring.values.set(mainKey, 'current-secret');
    keyring.values.set(legacyMainKey, 'legacy-secret');
    keyring.values.set(journalKey, malformedJournal);
    keyring.failDeleteKey = failedKey;

    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);

    expect(keyring.values.get(mainKey)).toBe('current-secret');
    expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');
    const tombstone = expectUnverifiableTombstone();
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
    expect(keyring.values.get(failedKey)).toBe(survivor);
    if (failedKey === mainKey) expect(keyring.values.get(legacyMainKey)).toBe('legacy-secret');
    else expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.get(journalKey)).toBe(tombstone);

    keyring.failDeleteKey = '';
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(legacyMainKey)).toBe(false);
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
    const tombstone = expectUnverifiableTombstone();
    await expect(deleteProviderCredential(authRef)).resolves.toBe(false);
    expect(keyring.values.has(mainKey)).toBe(false);
    expect(keyring.values.has(`relay-ai:${account}`)).toBe(false);
    expect(keyring.values.has(currentChunk)).toBe(false);
    expect(keyring.values.has(legacyChunk)).toBe(false);
    const expandedTombstone = keyring.values.get(journalKey)!;
    expect(expandedTombstone).not.toBe(tombstone);
    expect(JSON.parse(expandedTombstone.slice(journalPrefix.length))).toEqual({
      mode: 'delete',
      generations: [{ count: 1, generation: currentGeneration }],
      legacyGenerations: [{ count: 1, generation: legacyGeneration }],
      unverifiable: true,
    });
  });

  it('isolates the journal namespace from credential accounts', async () => {
    const journalCollisionAccount = `${account}::chunk-journal`;
    const journalCollisionRef = `keyring:${journalCollisionAccount}`;
    await expect(saveProviderCredential(journalCollisionRef, 'journal-account-secret')).resolves.toBe(true);
    await expect(saveProviderCredential(authRef, 'a'.repeat(2_500))).resolves.toBe(true);
    await expect(resolveProviderCredential('test', journalCollisionRef)).resolves.toBe('journal-account-secret');
  });

  it('reserves legacy chunk account forms from credential references', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    keyring.values.set(mainKey, `__relay_chunked__:v2:${generation}:1`);
    keyring.values.set(`clodex:${account}::chunk::${generation}::0`, 'legacy-secret');
    const chunkCollisionAccount = `${account}::chunk::${generation}::0`;
    const chunkCollisionRef = `keyring:${chunkCollisionAccount}`;

    await expect(saveProviderCredential(chunkCollisionRef, 'collision-secret')).resolves.toBe(false);
    await expect(resolveProviderCredential('test', chunkCollisionRef)).resolves.toBeNull();
    await expect(deleteProviderCredential(chunkCollisionRef)).resolves.toBe(false);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('legacy-secret');
  });

  it('allows non-canonical chunk-like account names that cannot collide', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const safeRefs = [
      `keyring:${account}::chunk::00`,
      `keyring:${account}::chunk::${generation}::00`,
    ];

    for (const [index, safeRef] of safeRefs.entries()) {
      const value = `safe-secret-${index}`;
      await expect(saveProviderCredential(safeRef, value)).resolves.toBe(true);
      await expect(resolveProviderCredential('test', safeRef)).resolves.toBe(value);
    }
  });

  it('does not reinterpret malformed structured values as bearer credentials', async () => {
    keyring.values.set(mainKey, '{"type":"oauth","access":');
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
  });
});
