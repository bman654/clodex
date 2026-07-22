import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseAuthRef } from '../env.js';
import {
  ensureLegacyAppHomeMigrated,
  getCredentialCleanupPath,
} from '../paths.js';
import { ensureSecureAppHome } from './io.js';
import {
  assertRegistryWriteOwnership,
  withRegistryWriteLock,
} from './lock.js';

const JOURNAL_SCHEMA_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface CredentialCleanupJournal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  pendingCredentialDeletes: string[];
}

function emptyJournal(): CredentialCleanupJournal {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    pendingCredentialDeletes: [],
  };
}

export function isStoredCredentialRef(value: string): boolean {
  const parsed = parseAuthRef(value);
  return parsed?.kind === 'keyring' || parsed?.kind === 'helper';
}

function parseJournal(raw: unknown): CredentialCleanupJournal {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Credential cleanup journal must be a JSON object.');
  }
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error('Unsupported credential cleanup journal schema.');
  }
  if (!Array.isArray(data.pendingCredentialDeletes)) {
    throw new Error('Credential cleanup journal is missing its pending list.');
  }
  const pending = data.pendingCredentialDeletes.filter(
    (value): value is string =>
      typeof value === 'string' && isStoredCredentialRef(value),
  );
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    pendingCredentialDeletes: [...new Set(pending)],
  };
}

function readJournalUnlocked(path: string): CredentialCleanupJournal {
  if (!existsSync(path)) return emptyJournal();
  try {
    return parseJournal(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read credential cleanup journal: ${message}`);
  }
}

function syncParentDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeJournalUnlocked(
  journal: CredentialCleanupJournal,
  path: string,
): void {
  assertRegistryWriteOwnership(path);
  ensureSecureAppHome();
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertRegistryWriteOwnership(path);
    renameSync(tmp, path);
    syncParentDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function journalLockPath(path: string): string {
  return `${path}.lock`;
}

export async function loadPendingCredentialDeletes(
  path = getCredentialCleanupPath(),
): Promise<string[]> {
  ensureLegacyAppHomeMigrated();
  return withRegistryWriteLock(
    () => [...readJournalUnlocked(path).pendingCredentialDeletes],
    { lockPath: journalLockPath(path) },
  );
}

async function updatePendingCredentialDeletes(
  update: (pending: string[]) => string[],
  path = getCredentialCleanupPath(),
): Promise<{ before: string[]; after: string[] }> {
  ensureLegacyAppHomeMigrated();
  return withRegistryWriteLock(() => {
    const journal = readJournalUnlocked(path);
    const before = [...journal.pendingCredentialDeletes];
    const after = [...new Set(update(before))].filter(isStoredCredentialRef);
    if (
      after.length !== before.length ||
      after.some((value, index) => value !== before[index])
    ) {
      writeJournalUnlocked(
        {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          pendingCredentialDeletes: after,
        },
        path,
      );
    }
    return { before, after };
  }, { lockPath: journalLockPath(path) });
}

export async function queueCredentialDelete(authRef: string): Promise<boolean> {
  if (!isStoredCredentialRef(authRef)) return false;
  const result = await updatePendingCredentialDeletes(pending =>
    pending.includes(authRef) ? pending : [...pending, authRef]);
  return result.after.includes(authRef);
}

export async function cancelCredentialDelete(authRef: string): Promise<boolean> {
  const result = await updatePendingCredentialDeletes(pending =>
    pending.filter(candidate => candidate !== authRef));
  return result.before.includes(authRef) && !result.after.includes(authRef);
}
