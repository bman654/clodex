import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  journalPath: '',
  openPaths: new Map<number, string>(),
  tempOpenFlags: [] as Array<string | number>,
  events: [] as string[],
  failTempFsync: false,
  failParentFsync: false,
}));

function ioError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EIO' });
}

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isJournalTemp = (path: string | undefined): boolean =>
    path?.startsWith(`${fsState.journalPath}.`) === true
    && path.endsWith('.tmp')
    && !path.startsWith(`${fsState.journalPath}.lock.`);

  return {
    ...actual,
    openSync: vi.fn((path: PathLike, flags: string | number, mode?: string | number) => {
      const fd = actual.openSync(path, flags, mode);
      const stringPath = String(path);
      fsState.openPaths.set(fd, stringPath);
      if (isJournalTemp(stringPath)) fsState.tempOpenFlags.push(flags);
      return fd;
    }),
    closeSync: vi.fn((fd: number) => {
      actual.closeSync(fd);
      fsState.openPaths.delete(fd);
    }),
    fsyncSync: vi.fn((fd: number) => {
      const path = fsState.openPaths.get(fd);
      if (isJournalTemp(path)) {
        fsState.events.push('temp-fsync');
        if (fsState.failTempFsync) throw ioError('journal temp fsync failed');
        actual.fsyncSync(fd);
        return;
      }
      if (path === dirname(fsState.journalPath)) {
        fsState.events.push('parent-fsync');
        if (fsState.failParentFsync) throw ioError('journal parent fsync failed');
      }
      actual.fsyncSync(fd);
    }),
    renameSync: vi.fn((oldPath: PathLike, newPath: PathLike) => {
      if (String(newPath) === fsState.journalPath) {
        fsState.events.push('rename');
      }
      actual.renameSync(oldPath, newPath);
    }),
  };
});

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { queueCredentialDelete } from '../src/registry/credential-cleanup-journal.js';
import { getCredentialCleanupPath } from '../src/paths.js';

describe('credential cleanup journal durability', () => {
  const previousHome = process.env.CLODEX_HOME;
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-journal-durability-'));
    process.env.CLODEX_HOME = home;
    fsState.journalPath = getCredentialCleanupPath();
    fsState.openPaths.clear();
    fsState.tempOpenFlags = [];
    fsState.events = [];
    fsState.failTempFsync = false;
    fsState.failParentFsync = false;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('exclusively creates and syncs the completed temp before publication', async () => {
    await queueCredentialDelete('keyring:provider:openai');

    expect(fsState.tempOpenFlags).toEqual(['wx']);
    expect(fsState.events).toEqual([
      'temp-fsync',
      'rename',
      'parent-fsync',
    ]);
    expect(JSON.parse(readFileSync(fsState.journalPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      pendingCredentialDeletes: ['keyring:provider:openai'],
    });
  });

  it('does not publish when syncing the completed temp fails', async () => {
    fsState.failTempFsync = true;

    await expect(
      queueCredentialDelete('keyring:provider:openai'),
    ).rejects.toThrow('journal temp fsync failed');

    expect(fsState.events).toEqual(['temp-fsync']);
    expect(existsSync(fsState.journalPath)).toBe(false);
  });

  it('reports a parent sync failure after the journal rename committed', async () => {
    fsState.failParentFsync = true;

    await expect(
      queueCredentialDelete('keyring:provider:openai'),
    ).rejects.toThrow('journal parent fsync failed');

    expect(fsState.events).toEqual([
      'temp-fsync',
      'rename',
      'parent-fsync',
    ]);
    expect(existsSync(fsState.journalPath)).toBe(true);
  });
});
