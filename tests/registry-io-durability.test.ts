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
  maxWriteBytes: Number.POSITIVE_INFINITY,
  tempWriteSizes: [] as number[],
  registryReadCount: 0,
  failRegistryReadAt: 0,
  registryReadErrorCode: 'EIO',
  replaceRegistryAtRead: 0,
  replacementRegistry: '',
  failLockOpenCode: '',
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
    readFileSync: vi.fn((path: PathLike, encoding: BufferEncoding) => {
      if (String(path) === fsState.registryPath) {
        fsState.registryReadCount += 1;
        if (fsState.registryReadCount === fsState.replaceRegistryAtRead) {
          actual.writeFileSync(path, fsState.replacementRegistry);
        }
        if (fsState.registryReadCount === fsState.failRegistryReadAt) {
          throw Object.assign(new Error('registry read failed'), {
            code: fsState.registryReadErrorCode,
          });
        }
      }
      return actual.readFileSync(path, encoding);
    }),
    openSync: vi.fn((path: PathLike, flags: string | number, mode?: string | number) => {
      if (String(path).startsWith(`${fsState.registryPath}.lock.`)
        && String(path).endsWith('.tmp')
        && fsState.failLockOpenCode) {
        throw Object.assign(new Error('lock open failed'), {
          code: fsState.failLockOpenCode,
        });
      }
      const fd = actual.openSync(path, flags, mode);
      fsState.openPaths.set(fd, String(path));
      return fd;
    }),
    closeSync: vi.fn((fd: number) => {
      actual.closeSync(fd);
      fsState.openPaths.delete(fd);
    }),
    writeSync: vi.fn((
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
    ) => {
      const path = fsState.openPaths.get(fd);
      if (isRegistryTemp(path)) {
        const bytes = Math.min(length, fsState.maxWriteBytes);
        fsState.tempWriteSizes.push(bytes);
        if (bytes === 0) return 0;
        return actual.writeSync(fd, buffer, offset, bytes);
      }
      return actual.writeSync(fd, buffer, offset, length);
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
  writeFileSync,
} from 'node:fs';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import {
  RegistryLockLostError,
  withRegistryWriteLockSync,
} from '../src/registry/lock.js';
import { clearActiveOAuthAccount } from '../src/registry/oauth-account-storage.js';

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
    fsState.maxWriteBytes = Number.POSITIVE_INFINITY;
    fsState.tempWriteSizes = [];
    fsState.registryReadCount = 0;
    fsState.failRegistryReadAt = 0;
    fsState.registryReadErrorCode = 'EIO';
    fsState.replaceRegistryAtRead = 0;
    fsState.replacementRegistry = '';
    fsState.failLockOpenCode = '';
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

  it('classifies selected-account migration write failures as filesystem recovery', () => {
    writeFileSync(fsState.registryPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    }, null, 2)}\n`);
    fsState.failTempFsync = true;

    expect(() => loadRegistry(fsState.registryPath)).toThrow(
      /Could not durably write the provider registry.*temp fsync failed.*permissions.*storage health.*free disk space/s,
    );
    expect(readFileSync(fsState.registryPath, 'utf8')).toContain('"schemaVersion": 3');
  });

  it('classifies a locked migration reread failure as filesystem access, not corruption', () => {
    writeFileSync(fsState.registryPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    }, null, 2)}\n`);
    fsState.failRegistryReadAt = 2;
    fsState.registryReadErrorCode = 'EACCES';

    let thrown: Error | undefined;
    try {
      loadRegistry(fsState.registryPath);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toMatch(
      /Could not read the provider registry.*registry read failed.*permissions.*storage health/s,
    );
    expect(thrown?.message).not.toMatch(/registry .* is invalid|restore .*\.bak/s);
  });

  it('classifies migration-lock I/O failures as filesystem access, not contention', () => {
    writeFileSync(fsState.registryPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    }, null, 2)}\n`);
    fsState.failLockOpenCode = 'EACCES';

    let thrown: Error | undefined;
    try {
      loadRegistry(fsState.registryPath);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toMatch(
      /Could not access the lock for the provider registry.*lock open failed.*permissions.*storage health/s,
    );
    expect(thrown?.message).not.toContain('Stop other Clodex processes');
  });

  it('repairs a post-rename parent sync failure on the next selected-account load', () => {
    writeFileSync(fsState.registryPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    }, null, 2)}\n`);
    fsState.failParentFsync = true;

    expect(() => loadRegistry(fsState.registryPath)).toThrow('parent fsync failed');
    expect(JSON.parse(readFileSync(fsState.registryPath, 'utf8')).schemaVersion).toBe(5);

    fsState.failParentFsync = false;
    fsState.events = [];
    fsState.registryReadCount = 0;
    expect(loadRegistry(fsState.registryPath).schemaVersion).toBe(5);
    expect(fsState.events).toEqual(['parent-fsync']);
  });

  it('syncs an already-migrated winner reread under the migration lock', () => {
    const defaultRef = 'keyring:oauth:provider:openai-oauth::credential::v1:default';
    const workRef =
      'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work';
    const provider = {
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: defaultRef,
      authType: 'oauth',
      activeAuthAccount: 'work',
      authAccounts: {
        work: {
          authRef: workRef,
          addedAt: '2026-08-09T00:00:00.000Z',
        },
      },
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-08-09T00:00:00.000Z',
    };
    writeFileSync(fsState.registryPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: [provider],
    }, null, 2)}\n`);
    fsState.replaceRegistryAtRead = 2;
    fsState.replacementRegistry = `${JSON.stringify({
      schemaVersion: 5,
      providers: [{
        ...provider,
        authRef: workRef,
        defaultAuthRef: defaultRef,
      }],
    }, null, 2)}\n`;
    fsState.failParentFsync = true;

    expect(() => loadRegistry(fsState.registryPath)).toThrow(
      /selected OAuth account.*durably sync.*parent fsync failed/s,
    );
    expect(fsState.events).toEqual(['parent-fsync']);

    fsState.failParentFsync = false;
    fsState.events = [];
    fsState.registryReadCount = 0;
    fsState.replaceRegistryAtRead = 0;
    expect(loadRegistry(fsState.registryPath).schemaVersion).toBe(5);
    expect(fsState.events).toEqual(['parent-fsync']);
  });

  it('repairs a post-rename parent sync failure after clearing back to schema v2', () => {
    writeFileSync(fsState.registryPath, `${JSON.stringify({
      schemaVersion: 5,
      providers: [{
        id: 'openai-oauth',
        templateId: 'openai',
        name: 'OpenAI (ChatGPT)',
        enabled: true,
        authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work',
        defaultAuthRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
        authType: 'oauth',
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:work',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
        api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
        addedAt: '2026-08-09T00:00:00.000Z',
      }],
    }, null, 2)}\n`);
    const cleared = loadRegistry(fsState.registryPath);
    clearActiveOAuthAccount(cleared.providers[0]!);
    fsState.events = [];
    fsState.failParentFsync = true;

    expect(() => withRegistryWriteLockSync(
      () => saveRegistry(cleared, fsState.registryPath),
      { lockPath: `${fsState.registryPath}.lock` },
    )).toThrow('parent fsync failed');
    expect(JSON.parse(readFileSync(fsState.registryPath, 'utf8')).schemaVersion).toBe(2);

    fsState.failParentFsync = false;
    fsState.events = [];
    fsState.registryReadCount = 0;
    expect(loadRegistry(fsState.registryPath).schemaVersion).toBe(2);
    expect(fsState.events).toEqual(['parent-fsync']);
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

  it('retries short writes until the complete registry payload is stored', () => {
    fsState.maxWriteBytes = 5;

    publishRegistry();

    expect(fsState.tempWriteSizes.length).toBeGreaterThan(1);
    expect(fsState.tempWriteSizes.every(size => size > 0 && size <= 5)).toBe(true);
    expect(JSON.parse(readFileSync(fsState.registryPath, 'utf8'))).toEqual(
      emptyRegistry(),
    );
  });

  it('does not publish when a secure write makes no progress', () => {
    fsState.maxWriteBytes = 0;

    expect(publishRegistry).toThrow('Could not complete secure file write');

    expect(fsState.events).toEqual([]);
    expect(existsSync(fsState.registryPath)).toBe(false);
  });
});
