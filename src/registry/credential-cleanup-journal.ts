import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseAuthRef } from '../env.js';
import { getCredentialCleanupPath } from '../paths.js';
import { ensureSecureAppHome } from './io.js';
import {
  assertRegistryWriteOwnership,
  withRegistryWriteLock,
} from './lock.js';
import { isValidProviderId } from './validate.js';

const JOURNAL_SCHEMA_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_PENDING_CREDENTIAL_DELETES = 1024;
const MAX_CREDENTIAL_REF_BYTES = 4096;
const CREDENTIAL_INSTANCE_SEPARATOR = '::credential::';
const CREDENTIAL_INSTANCE_PATTERN = /^v1:[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  return (
    (parsed?.kind === 'keyring' || parsed?.kind === 'helper')
    && isManagedCredentialAccount(parsed.account)
  );
}

function credentialAccountBase(account: string): string | null {
  const separatorIndex = account.lastIndexOf(CREDENTIAL_INSTANCE_SEPARATOR);
  if (separatorIndex === -1) return account;
  if (
    separatorIndex === 0
    || account.indexOf(CREDENTIAL_INSTANCE_SEPARATOR) !== separatorIndex
    || !CREDENTIAL_INSTANCE_PATTERN.test(
      account.slice(separatorIndex + CREDENTIAL_INSTANCE_SEPARATOR.length),
    )
  ) {
    return null;
  }
  return account.slice(0, separatorIndex);
}

function isManagedCredentialAccount(account: string): boolean {
  const base = credentialAccountBase(account);
  if (!base) return false;

  const oauth = /^oauth:provider:(.+)$/.exec(base);
  if (oauth) return isValidProviderId(oauth[1]!);

  const provider = /^provider:([^:]+)(?::(.+))?$/.exec(base);
  if (!provider || !isValidProviderId(provider[1]!)) return false;
  const suffix = provider[2];
  if (!suffix) return true;
  if (UUID_PATTERN.test(suffix)) return true;
  return suffix.startsWith('replacement:')
    && UUID_PATTERN.test(suffix.slice('replacement:'.length));
}

function normalizePendingCredentialDeletes(raw: unknown[]): string[] {
  if (raw.length > MAX_PENDING_CREDENTIAL_DELETES) {
    throw new Error('Credential cleanup journal contains too many pending entries.');
  }
  const pending: string[] = [];
  for (const [index, value] of raw.entries()) {
    if (
      typeof value !== 'string'
      || Buffer.byteLength(value) > MAX_CREDENTIAL_REF_BYTES
      || !isStoredCredentialRef(value)
    ) {
      throw new Error(`Credential cleanup journal has an invalid entry at index ${index}.`);
    }
    if (!pending.includes(value)) pending.push(value);
  }
  return pending;
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
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    pendingCredentialDeletes: normalizePendingCredentialDeletes(
      data.pendingCredentialDeletes,
    ),
  };
}

function readJournalUnlocked(path: string): CredentialCleanupJournal {
  if (!existsSync(path)) return emptyJournal();
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error('Credential cleanup journal must be a regular file.');
    }
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error('Credential cleanup journal changed while opening.');
    }
    if (typeof process.getuid === 'function') {
      if (opened.uid !== process.getuid()) {
        throw new Error('Credential cleanup journal is owned by another user.');
      }
      if ((opened.mode & 0o077) !== 0) {
        throw new Error('Credential cleanup journal permissions are too broad.');
      }
    }
    if (opened.size > MAX_JOURNAL_BYTES) {
      throw new Error('Credential cleanup journal is too large.');
    }
    return parseJournal(JSON.parse(readFileSync(fd, 'utf8')));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read credential cleanup journal: ${message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
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
  return withRegistryWriteLock(
    () => [...readJournalUnlocked(path).pendingCredentialDeletes],
    { lockPath: journalLockPath(path) },
  );
}

async function updatePendingCredentialDeletes(
  update: (pending: string[]) => string[],
  path = getCredentialCleanupPath(),
): Promise<{ before: string[]; after: string[] }> {
  return withRegistryWriteLock(() => {
    const journal = readJournalUnlocked(path);
    const before = [...journal.pendingCredentialDeletes];
    const after = normalizePendingCredentialDeletes(update(before));
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
