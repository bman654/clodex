import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PathLike } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  registryPath: '',
  openPaths: new Map<number, string>(),
  events: [] as string[],
  failTempFsync: false,
  failParentFsync: false,
  dropLockAfterTempFsync: false,
}));

function ioError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EIO' });
}

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isRegistryTemp = (path: string | undefined): boolean =>
    path?.startsWith(`${fsState.registryPath}.`) === true
    && path.endsWith('.tmp')
    && !path.startsWith(`${fsState.registryPath}.lock.`);

  return {
    ...actual,
    openSync: vi.fn((path: PathLike, flags: string | number, mode?: string | number) => {
      const fd = actual.openSync(path, flags, mode);
      fsState.openPaths.set(fd, String(path));
      return fd;
    }),
    closeSync: vi.fn((fd: number) => {
      actual.closeSync(fd);
      fsState.openPaths.delete(fd);
    }),
    fsyncSync: vi.fn((fd: number) => {
      const path = fsState.openPaths.get(fd);
      if (isRegistryTemp(path)) {
        fsState.events.push('temp-fsync');
        if (fsState.failTempFsync) throw ioError('temp fsync failed');
        actual.fsyncSync(fd);
        if (fsState.dropLockAfterTempFsync) {
          actual.unlinkSync(`${fsState.registryPath}.lock`);
        }
        return;
      }
      if (path === dirname(fsState.registryPath)) {
        fsState.events.push('parent-fsync');
        if (fsState.failParentFsync) throw ioError('parent fsync failed');
      }
      actual.fsyncSync(fd);
    }),
    renameSync: vi.fn((oldPath: PathLike, newPath: PathLike) => {
      if (String(newPath) === fsState.registryPath) {
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
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import {
  RegistryLockLostError,
  withRegistryWriteLockSync,
} from '../src/registry/lock.js';

describe('registry publication durability', () => {
  const previousHome = process.env.CLODEX_HOME;
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-registry-durability-'));
    process.env.CLODEX_HOME = home;
    fsState.registryPath = join(home, 'providers.json');
    fsState.openPaths.clear();
    fsState.events = [];
    fsState.failTempFsync = false;
    fsState.failParentFsync = false;
    fsState.dropLockAfterTempFsync = false;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function publishRegistry(): void {
    withRegistryWriteLockSync(
      () => saveRegistry(emptyRegistry(), fsState.registryPath),
      { lockPath: `${fsState.registryPath}.lock` },
    );
  }

  it('syncs the completed temp before rename and the parent after rename', () => {
    publishRegistry();

    expect(fsState.events).toEqual([
      'temp-fsync',
      'rename',
      'parent-fsync',
    ]);
    expect(JSON.parse(readFileSync(fsState.registryPath, 'utf8'))).toEqual(
      emptyRegistry(),
    );
  });

  it('does not publish when syncing the completed temp fails', () => {
    fsState.failTempFsync = true;

    expect(publishRegistry).toThrow('temp fsync failed');

    expect(fsState.events).toEqual(['temp-fsync']);
    expect(existsSync(fsState.registryPath)).toBe(false);
  });

  it('reports a parent sync failure only after the rename has committed', () => {
    fsState.failParentFsync = true;

    expect(publishRegistry).toThrow('parent fsync failed');

    expect(fsState.events).toEqual([
      'temp-fsync',
      'rename',
      'parent-fsync',
    ]);
    expect(existsSync(fsState.registryPath)).toBe(true);
  });

  it('still fences publication when the lease is lost after temp sync', () => {
    fsState.dropLockAfterTempFsync = true;

    expect(publishRegistry).toThrow(RegistryLockLostError);

    expect(fsState.events).toEqual(['temp-fsync']);
    expect(existsSync(fsState.registryPath)).toBe(false);
  });
});
