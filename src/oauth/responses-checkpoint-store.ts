import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const STORE_VERSION = 1;
const MAX_CHECKPOINT_FILE_BYTES = 8 * 1024 * 1024;
const CHECKPOINT_FILE_SUFFIX = '.json';
const CHECKPOINT_KEY_PATTERN = /^[a-f0-9]{64}$/;
const LINEAGE_KEY_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface StoredResponsesCheckpoint {
  version: typeof STORE_VERSION;
  checkpointKey: string;
  lineageKey: string;
  requestInputHashes: string[];
  expectedAssistantHashes: string[];
  expectedAssistantKinds: string[];
  compactedInput: unknown[];
  lastInputTokens?: number;
  claudeCompactionSummaryHash?: string;
  promptFieldHashes?: Record<string, string>;
  lastUsedAt: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isStoredCheckpoint(value: unknown): value is StoredResponsesCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === STORE_VERSION
    && typeof record.checkpointKey === 'string'
    && CHECKPOINT_KEY_PATTERN.test(record.checkpointKey)
    && typeof record.lineageKey === 'string'
    && LINEAGE_KEY_PATTERN.test(record.lineageKey)
    && isStringArray(record.requestInputHashes)
    && isStringArray(record.expectedAssistantHashes)
    && isStringArray(record.expectedAssistantKinds)
    && record.expectedAssistantHashes.length === record.expectedAssistantKinds.length
    && Array.isArray(record.compactedInput)
    && typeof record.lastUsedAt === 'number';
}

function checkpointPath(directory: string, checkpointKey: string, lineageKey: string): string {
  if (!CHECKPOINT_KEY_PATTERN.test(checkpointKey) || !LINEAGE_KEY_PATTERN.test(lineageKey)) {
    throw new Error('Invalid Responses checkpoint identity');
  }
  return join(directory, `${checkpointKey}-${lineageKey}${CHECKPOINT_FILE_SUFFIX}`);
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* best effort on restricted platforms */ }
}

export function loadStoredResponsesCheckpoints(
  directory: string,
  now: number,
  ttlMs: number,
): StoredResponsesCheckpoint[] {
  if (!existsSync(directory)) return [];
  try { chmodSync(directory, 0o700); } catch { /* best effort */ }
  const loaded: StoredResponsesCheckpoint[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(CHECKPOINT_FILE_SUFFIX)) continue;
    const path = join(directory, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_CHECKPOINT_FILE_BYTES) {
        rmSync(path, { force: true });
        continue;
      }
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isStoredCheckpoint(parsed) || now - parsed.lastUsedAt >= ttlMs) {
        rmSync(path, { force: true });
        continue;
      }
      loaded.push(parsed);
    } catch {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }
  return loaded;
}

export function saveStoredResponsesCheckpoint(
  directory: string,
  checkpoint: StoredResponsesCheckpoint,
  maxPerPartition: number,
  maxTotal: number,
): boolean {
  const serialized = `${JSON.stringify(checkpoint)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CHECKPOINT_FILE_BYTES) return false;
  ensurePrivateDirectory(directory);
  const path = checkpointPath(directory, checkpoint.checkpointKey, checkpoint.lineageKey);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    const files = readdirSync(directory)
      .filter(name => name.endsWith(CHECKPOINT_FILE_SUFFIX))
      .map(name => {
        const candidatePath = join(directory, name);
        try {
          return { name, path: candidatePath, mtimeMs: statSync(candidatePath).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter((candidate): candidate is { name: string; path: string; mtimeMs: number } => Boolean(candidate));
    const partitionPrefix = `${checkpoint.checkpointKey}-`;
    const partitionExcess = files
      .filter(candidate => candidate.name.startsWith(partitionPrefix))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(maxPerPartition);
    for (const candidate of partitionExcess) rmSync(candidate.path, { force: true });
    const globalExcess = files
      .filter(candidate => !partitionExcess.some(removed => removed.path === candidate.path))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(maxTotal);
    for (const candidate of globalExcess) rmSync(candidate.path, { force: true });
    return true;
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* ignore */ }
  }
}

export function deleteStoredResponsesCheckpoint(
  directory: string,
  checkpointKey: string,
  lineageKey: string,
): void {
  try {
    rmSync(checkpointPath(directory, checkpointKey, lineageKey), { force: true });
  } catch { /* ignore */ }
}
