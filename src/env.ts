// src/env.ts
import { CONFLICTING_ENV_VARS } from './constants.js';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  deleteCredentialHelperAccount,
  readCredentialHelperAccount,
  writeCredentialHelperAccount,
} from './credential-helper.js';
import { claudeCodeClientModelId, stripOneMContextSuffix } from './context-model-id.js';
import { resolveContextWindow } from './context-window.js';
import {
  oauthCredentialToKeychainJson,
  parseStoredOAuthCredential,
  type StoredOAuthCredential,
} from './oauth/types.js';
import { refreshStoredOAuthCredential, oauthCredentialShouldRefresh } from './oauth/refresh.js';
import {
  withCredentialMutationLock,
  withRegistryWriteLock,
} from './registry/lock.js';
import type { ConflictInfo } from './types.js';

export function detectConflicts(): ConflictInfo[] {
  return CONFLICTING_ENV_VARS
    .filter(name => process.env[name] !== undefined)
    .map(name => ({ name, value: process.env[name]! }));
}

/** Restore first-party-like Claude Code behavior when routing through a proxy or gateway. */
export function applyClaudeCodeThirdPartyCompat(env: NodeJS.ProcessEnv): void {
  // Custom ANTHROPIC_BASE_URL disables MCP tool search by default, loading every
  // MCP tool (100+) on every turn. Requires defer_loading on tools — do not set
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS when using the local translation proxy.
  env['ENABLE_TOOL_SEARCH'] = 'true';
  // Third-party routes may enable a shorter system prompt that drops conversational
  // guardrails while hooks/plugins still inject agentic instructions.
  env['CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT'] = '0';
}

export function buildChildEnv(
  baseUrl: string,
  model: string,
  apiKey: string,
  proxyPort?: number,
  contextWindow?: number,
  enableGatewayDiscovery?: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CONFLICTING_ENV_VARS) {
    delete env[name];
  }
  env['ANTHROPIC_BASE_URL'] = proxyPort
    ? `http://127.0.0.1:${proxyPort}`
    : baseUrl;
  env['ANTHROPIC_API_KEY'] = apiKey;
  const bareModel = stripOneMContextSuffix(model);
  env['ANTHROPIC_MODEL'] = claudeCodeClientModelId(model, contextWindow);
  // Claude Code defaults to 200K for non-api.anthropic.com base URLs; override with
  // the launch model's real window. NOTE: in switch-menu mode this is fixed at launch
  // and does NOT update on live /model switch — Claude Code's gateway model discovery
  // only carries id + display_name (no context_window), so this env var is the only
  // lever and it reflects the model you started with.
  // Third-party routes also require a `[1m]` model-id suffix for 1M+ windows in the UI.
  env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] = String(resolveContextWindow(bareModel, contextWindow));
  if (enableGatewayDiscovery) {
    env['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'] = '1';
  }
  applyClaudeCodeThirdPartyCompat(env);
  return env;
}

/**
 * Child env for transparent HTTP-proxy mode. Keep normal Anthropic credentials
 * intact, remove only endpoint modes that would bypass api.anthropic.com, and
 * trust the per-user clodex CA for this child process.
 */
export function buildHttpProxyChildEnv(proxyPort: number, caCertPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CONFLICTING_ENV_VARS) {
    if (name === 'ANTHROPIC_API_KEY' || name === 'ANTHROPIC_AUTH_TOKEN' || name === 'ANTHROPIC_MODEL') continue;
    delete env[name];
  }
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  env['HTTPS_PROXY'] = proxyUrl;
  env['HTTP_PROXY'] = proxyUrl;
  env['https_proxy'] = proxyUrl;
  env['http_proxy'] = proxyUrl;
  env['NODE_EXTRA_CA_CERTS'] = caCertPath;
  const noProxy = env['NO_PROXY'] ?? env['no_proxy'];
  if (noProxy !== undefined) {
    const filtered = noProxy
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .filter(value => {
        const entry = value.toLowerCase().replace(/^https?:\/\//, '');
        const host = entry.replace(/:\d+$/, '');
        if (host === '*') return false;
        const suffix = host.startsWith('*.') ? host.slice(1) : host;
        const bypassesAnthropic = suffix.startsWith('.')
          ? 'api.anthropic.com'.endsWith(suffix)
          : 'api.anthropic.com' === suffix || 'api.anthropic.com'.endsWith(`.${suffix}`);
        return !bypassesAnthropic;
      })
      .join(',');
    if (filtered) {
      env['NO_PROXY'] = filtered;
      env['no_proxy'] = filtered;
    } else {
      delete env['NO_PROXY'];
      delete env['no_proxy'];
    }
  }
  return env;
}

/** Classify a keyring error into a human-readable reason (never throws). */
export function classifyKeyringError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('cannot find module') || lower.includes('module not found') || lower.includes('failed to load')) {
    return 'native keyring module not available on this system';
  }
  if (lower.includes('secret service') || lower.includes('dbus') || lower.includes('daemon')) {
    return 'Secret Service daemon is not running (start GNOME Keyring or KWallet)';
  }
  if (lower.includes('denied') || lower.includes('locked') || lower.includes('cancelled') || lower.includes('user refused')) {
    return 'keychain access was denied or the keychain is locked';
  }
  return `keyring error: ${msg}`;
}

const KEYRING_SERVICE = 'clodex';
const KEYRING_CHUNK_SERVICE = 'clodex-chunks';
const KEYRING_JOURNAL_SERVICE = 'clodex-journal';
/** One-time silent migration source: credentials stored by relay-ai. */
const LEGACY_KEYRING_SERVICE = 'relay-ai';
// Windows Credential Manager caps a single credential blob at 2560 bytes (CredWriteW).
// keyring-rs encodes the password as UTF-16 (2 bytes/char) before that check, so the
// usable limit is 2560 / 2 = 1280 chars — long OAuth tokens (e.g. OpenAI's JWTs) exceed
// this, so secrets above the threshold are split across multiple keyring entries.
// Harmless on macOS/Linux, which have no such limit.
const KEYRING_CHUNK_PREFIX = '__relay_chunked__:';
const KEYRING_JOURNAL_PREFIX = '__relay_chunk_journal__:v1:';
const KEYRING_MAX_ENTRY_CHARS = 1200;
const KEYRING_CHUNK_SIZE = KEYRING_MAX_ENTRY_CHARS;
const KEYRING_MAX_CHUNKS = 128;
const KEYRING_MAX_WRITE_GENERATIONS = 2;
const KEYRING_MAX_DELETE_GENERATIONS = 6;
const KEYRING_MAX_LEGACY_GENERATIONS = 4;
const KEYRING_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface KeyringChunkMarker {
  count: number;
  generation?: string;
  digest?: string;
}

interface KeyringChunkJournal {
  mode: 'write' | 'delete';
  generations: KeyringChunkMarker[];
  legacyGenerations?: KeyringChunkMarker[];
  unverifiable?: true;
}

export function providerKeyringAccount(providerId: string): string {
  return `provider:${providerId}`;
}

export function oauthProviderKeyringAccount(providerId: string): string {
  return `oauth:provider:${providerId}`;
}

function oauthProviderIdFromAccount(account: string): string | null {
  const prefix = 'oauth:provider:';
  return account.startsWith(prefix) ? account.slice(prefix.length) : null;
}

const oauthRefreshInflight = new Map<string, Promise<string | null>>();
interface CachedOAuthCredential {
  access: string;
  expires: number;
  accessRejected?: true;
  checkedAt: number;
}

// Another process can replace the shared credential without invalidating this
// process. Keep only access-token metadata and bound that stale view to 30 seconds;
// rejection and expiration bypass it immediately.
const OAUTH_CREDENTIAL_CACHE_MAX_AGE_MS = 30_000;
const oauthCredentialCache = new Map<string, CachedOAuthCredential>();
const rejectedEnvCredentialFingerprints = new Map<string, string>();
const OAUTH_REFRESH_LOCK_WAIT_MS = 150_000;
const OAUTH_STATE_KEY_SEPARATOR = '\0';

export type ParsedAuthRef =
  | { kind: 'keyring'; account: string }
  | { kind: 'helper'; helperId: string; account: string }
  | { kind: 'env'; varName: string }
  | { kind: 'none' };

function isReservedKeyringAccount(account: string): boolean {
  const separator = '::chunk::';
  const separatorIndex = account.lastIndexOf(separator);
  if (separatorIndex <= 0) return false;
  const suffix = account.slice(separatorIndex + separator.length);
  const parts = suffix.split('::');
  if (parts.length === 2 && !KEYRING_GENERATION_PATTERN.test(parts[0]!)) {
    return false;
  }
  if (parts.length !== 1 && parts.length !== 2) return false;
  const indexText = parts.at(-1)!;
  if (!/^\d+$/.test(indexText)) return false;
  const index = Number(indexText);
  return Number.isSafeInteger(index)
    && indexText === String(index)
    && index >= 0
    && index < KEYRING_MAX_CHUNKS;
}

export interface ResolveCredentialOptions {
  rejectedAccessToken?: string;
}

/** Parse registry credential references. */
export function parseAuthRef(authRef: string): ParsedAuthRef | null {
  if (authRef === 'none:anonymous') return { kind: 'none' };
  if (authRef.startsWith('keyring:')) {
    const account = authRef.slice('keyring:'.length);
    return account && !isReservedKeyringAccount(account)
      ? { kind: 'keyring', account }
      : null;
  }
  if (authRef.startsWith('env:')) {
    const varName = authRef.slice('env:'.length);
    return varName ? { kind: 'env', varName } : null;
  }
  const helper = /^helper:v1:([0-9a-f]{64}):(.+)$/s.exec(authRef);
  if (helper) return { kind: 'helper', helperId: helper[1]!, account: helper[2]! };
  return null;
}

/** Env var name for clodex namespaced per-provider keys. */
export function clodexKeyEnvVar(providerId: string): string {
  return `CLODEX_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function readEnvCredential(varName: string): string | null {
  const raw = process.env[varName];
  if (!raw?.trim()) return null;
  return raw.trim().split(/\r?\n/)[0]?.trim() || null;
}

function credentialFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function usableEnvCredential(
  source: string,
  value: string | null,
  rejectedAccessToken?: string,
): string | null {
  if (!value) {
    rejectedEnvCredentialFingerprints.delete(source);
    return null;
  }

  const fingerprint = credentialFingerprint(value);
  if (
    rejectedAccessToken !== undefined
    && fingerprint === credentialFingerprint(rejectedAccessToken)
  ) {
    rejectedEnvCredentialFingerprints.set(source, fingerprint);
    return null;
  }

  const rejectedFingerprint = rejectedEnvCredentialFingerprints.get(source);
  if (rejectedFingerprint === fingerprint) return null;
  if (rejectedFingerprint !== undefined) {
    rejectedEnvCredentialFingerprints.delete(source);
  }
  return value;
}

function readKeyringAccountFromService(
  Entry: typeof import('@napi-rs/keyring').Entry,
  service: string,
  account: string,
  retries = 2,
): string | null {
  const accountEntry = new Entry(service, account);
  const value = accountEntry.getPassword() ?? null;
  const marker = parseKeyringChunkMarker(value);
  if (!marker) return value;
  let combined: string;
  try {
    combined = readKeyringMarkerChunks(Entry, service, account, marker);
  } catch (err) {
    if (retries > 0 && accountEntry.getPassword() !== value) {
      return readKeyringAccountFromService(Entry, service, account, retries - 1);
    }
    throw err;
  }
  if (accountEntry.getPassword() !== value) {
    if (retries > 0) {
      return readKeyringAccountFromService(Entry, service, account, retries - 1);
    }
    throw new Error('keyring credential changed repeatedly while it was being read');
  }
  return combined;
}

function readKeyringMarkerChunks(
  Entry: typeof import('@napi-rs/keyring').Entry,
  service: string,
  account: string,
  marker: KeyringChunkMarker,
): string {
  let combined = '';
  const chunkService = keyringChunkService(service, marker);
  for (let i = 0; i < marker.count; i++) {
    const chunk = new Entry(chunkService, keyringChunkAccount(account, marker, i)).getPassword();
    if (chunk === null) {
      throw new Error(`keyring credential chunk ${i + 1} of ${marker.count} is missing`);
    }
    combined += chunk;
  }
  if (
    marker.digest
    && createHash('sha256').update(combined).digest('hex') !== marker.digest
  ) {
    throw new Error('keyring credential chunk digest does not match');
  }
  return combined;
}

function parseKeyringChunkMarker(value: string | null): KeyringChunkMarker | null {
  if (!value?.startsWith(KEYRING_CHUNK_PREFIX)) return null;
  const encoded = value.slice(KEYRING_CHUNK_PREFIX.length);
  const current = /^v3:([^:]+):(\d+):([0-9a-f]{64})$/.exec(encoded);
  const versioned = /^v2:([^:]+):(\d+)$/.exec(encoded);
  const legacy = /^(\d+)$/.exec(encoded);
  const countText = current?.[2] ?? versioned?.[2] ?? legacy?.[1];
  const count = countText === undefined ? Number.NaN : Number(countText);
  const generation = current?.[1] ?? versioned?.[1];
  const digest = current?.[3];
  if (
    !Number.isSafeInteger(count)
    || count < 1
    || count > KEYRING_MAX_CHUNKS
    || (generation !== undefined && !KEYRING_GENERATION_PATTERN.test(generation))
  ) {
    throw new Error('keyring credential has an invalid chunk marker');
  }
  return {
    count,
    ...(generation ? { generation } : {}),
    ...(digest ? { digest } : {}),
  };
}

function encodeKeyringChunkMarker(marker: KeyringChunkMarker): string {
  if (!marker.generation) return `${KEYRING_CHUNK_PREFIX}${marker.count}`;
  if (marker.digest) {
    return `${KEYRING_CHUNK_PREFIX}v3:${marker.generation}:${marker.count}:${marker.digest}`;
  }
  return `${KEYRING_CHUNK_PREFIX}v2:${marker.generation}:${marker.count}`;
}

function parseJournalMarker(value: unknown): KeyringChunkMarker {
  if (!value || typeof value !== 'object') {
    throw new Error('keyring credential has an invalid cleanup journal');
  }
  const candidate = value as Partial<KeyringChunkMarker>;
  if (
    !Number.isSafeInteger(candidate.count)
    || (candidate.count ?? 0) < 1
    || (candidate.count ?? 0) > KEYRING_MAX_CHUNKS
    || (
      candidate.generation !== undefined
      && (
        typeof candidate.generation !== 'string'
        || !KEYRING_GENERATION_PATTERN.test(candidate.generation)
      )
    )
    || (
      candidate.digest !== undefined
      && (
        typeof candidate.digest !== 'string'
        || !/^[0-9a-f]{64}$/.test(candidate.digest)
        || candidate.generation === undefined
      )
    )
  ) {
    throw new Error('keyring credential has an invalid cleanup journal');
  }
  return {
    count: candidate.count!,
    ...(candidate.generation ? { generation: candidate.generation } : {}),
    ...(candidate.digest ? { digest: candidate.digest } : {}),
  };
}

class InvalidKeyringJournalError extends Error {
  constructor() {
    super('keyring credential has an invalid cleanup journal');
    this.name = 'InvalidKeyringJournalError';
  }
}

function parseKeyringChunkJournal(value: string): KeyringChunkJournal {
  if (!value.startsWith(KEYRING_JOURNAL_PREFIX)) {
    throw new InvalidKeyringJournalError();
  }
  try {
    const parsed = JSON.parse(value.slice(KEYRING_JOURNAL_PREFIX.length)) as Partial<KeyringChunkJournal>;
    if (
      (parsed.mode !== 'write' && parsed.mode !== 'delete')
      || !Array.isArray(parsed.generations)
      || parsed.generations.length > (
        parsed.mode === 'write'
          ? KEYRING_MAX_WRITE_GENERATIONS
          : KEYRING_MAX_DELETE_GENERATIONS
      )
      || (
        parsed.legacyGenerations !== undefined
        && (
          !Array.isArray(parsed.legacyGenerations)
          || parsed.legacyGenerations.length > KEYRING_MAX_LEGACY_GENERATIONS
        )
      )
      || (parsed.mode === 'write' && parsed.generations.length < 1)
      || (
        parsed.mode === 'write'
        && ((parsed.legacyGenerations?.length ?? 0) > 0 || parsed.unverifiable !== undefined)
      )
      || (parsed.unverifiable !== undefined && parsed.unverifiable !== true)
    ) {
      throw new Error('invalid');
    }
    const generations = parsed.generations.map(parseJournalMarker);
    const legacyGenerations = parsed.legacyGenerations?.map(parseJournalMarker);
    if (
      parsed.mode === 'write'
      && generations.some((marker, index) =>
        generations.slice(index + 1).some(candidate =>
          sameKeyringGeneration(marker, candidate),
        ),
      )
    ) {
      throw new Error('invalid');
    }
    return {
      mode: parsed.mode,
      generations,
      ...(legacyGenerations
        ? { legacyGenerations }
        : {}),
      ...(parsed.unverifiable ? { unverifiable: true } : {}),
    };
  } catch {
    throw new InvalidKeyringJournalError();
  }
}

function sameKeyringGeneration(
  left: KeyringChunkMarker | null,
  right: KeyringChunkMarker,
): boolean {
  return left !== null
    && left.generation === right.generation
    && Boolean(left.digest) === Boolean(right.digest);
}

function sameKeyringMarker(
  left: KeyringChunkMarker,
  right: KeyringChunkMarker,
): boolean {
  return sameKeyringGeneration(left, right)
    && left.count === right.count
    && left.digest === right.digest;
}

function appendUniqueKeyringMarker(
  target: KeyringChunkMarker[],
  marker: KeyringChunkMarker,
): void {
  const existing = target.find(candidate => sameKeyringGeneration(candidate, marker));
  if (!existing) {
    target.push(marker);
    return;
  }
  existing.count = Math.max(existing.count, marker.count);
  if (!existing.digest && marker.digest) existing.digest = marker.digest;
}

function encodeKeyringJournal(journal: KeyringChunkJournal): string {
  return `${KEYRING_JOURNAL_PREFIX}${JSON.stringify(journal)}`;
}

function keyringDeleteJournalFits(
  generations: KeyringChunkMarker[],
  legacyGenerations: KeyringChunkMarker[],
  unverifiable = false,
): boolean {
  if (
    generations.length > KEYRING_MAX_DELETE_GENERATIONS
    || legacyGenerations.length > KEYRING_MAX_LEGACY_GENERATIONS
  ) {
    return false;
  }
  return encodeKeyringJournal({
    mode: 'delete',
    generations,
    ...(legacyGenerations.length > 0 ? { legacyGenerations } : {}),
    ...(unverifiable ? { unverifiable: true } : {}),
  }).length <= KEYRING_MAX_ENTRY_CHARS;
}

function keyringChunkAccount(
  account: string,
  marker: KeyringChunkMarker,
  index: number,
): string {
  return marker.generation
    ? `${account}::chunk::${marker.generation}::${index}`
    : `${account}::chunk::${index}`;
}

function keyringChunkService(
  mainService: string,
  marker: KeyringChunkMarker,
): string {
  return marker.digest ? KEYRING_CHUNK_SERVICE : mainService;
}

function removeKeyringChunkRange(
  Entry: typeof import('@napi-rs/keyring').Entry,
  service: string,
  account: string,
  marker: KeyringChunkMarker,
  firstIndex: number,
  diag?: (msg: string) => void,
): boolean {
  let removed = true;
  const chunkService = keyringChunkService(service, marker);
  for (let i = firstIndex; i < marker.count; i++) {
    try {
      const entry = new Entry(chunkService, keyringChunkAccount(account, marker, i));
      if (entry.getPassword() !== null) entry.deletePassword();
    } catch (err) {
      removed = false;
      diag?.(classifyKeyringError(err));
    }
  }
  return removed;
}

function removeKeyringChunks(
  Entry: typeof import('@napi-rs/keyring').Entry,
  service: string,
  account: string,
  marker: KeyringChunkMarker | null,
  diag?: (msg: string) => void,
): boolean {
  if (!marker) return true;
  return removeKeyringChunkRange(Entry, service, account, marker, 0, diag);
}

function writeKeyringJournal(
  Entry: typeof import('@napi-rs/keyring').Entry,
  account: string,
  journal: KeyringChunkJournal,
): void {
  const entry = new Entry(KEYRING_JOURNAL_SERVICE, account);
  const encoded = encodeKeyringJournal(journal);
  if (encoded.length > KEYRING_MAX_ENTRY_CHARS) {
    throw new Error('keyring cleanup journal exceeds the credential entry limit');
  }
  entry.setPassword(encoded);
  if (entry.getPassword() !== encoded) {
    throw new Error('keyring cleanup journal verification failed');
  }
}

function reconcileKeyringJournal(
  Entry: typeof import('@napi-rs/keyring').Entry,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  const journalEntry = new Entry(KEYRING_JOURNAL_SERVICE, account);
  const rawJournal = journalEntry.getPassword();
  if (rawJournal === null) return true;
  let journal = parseKeyringChunkJournal(rawJournal);
  const accountEntry = new Entry(KEYRING_SERVICE, account);
  const legacyAccountEntry = new Entry(LEGACY_KEYRING_SERVICE, account);

  let activeMarker: KeyringChunkMarker | null = null;
  if (journal.mode === 'delete') {
    let currentMarker: KeyringChunkMarker | null = null;
    let currentLegacyMarker: KeyringChunkMarker | null = null;
    let unverifiable = journal.unverifiable === true;
    let currentValue: string | null;
    let currentLegacyValue: string | null;
    try {
      currentValue = accountEntry.getPassword();
      currentLegacyValue = legacyAccountEntry.getPassword();
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    for (const [storedValue, assign] of [
      [currentValue, (marker: KeyringChunkMarker | null) => {
        currentMarker = marker;
      }],
      [currentLegacyValue, (marker: KeyringChunkMarker | null) => {
        currentLegacyMarker = marker;
      }],
    ] as const) {
      try {
        assign(parseKeyringChunkMarker(storedValue));
      } catch (err) {
        unverifiable = true;
        diag?.(classifyKeyringError(err));
      }
    }

    let preparedGenerations = journal.generations.map(marker => ({ ...marker }));
    let preparedLegacyGenerations = (journal.legacyGenerations ?? []).map(marker => ({
      ...marker,
    }));
    if (currentMarker) appendUniqueKeyringMarker(preparedGenerations, currentMarker);
    if (currentLegacyMarker) {
      appendUniqueKeyringMarker(preparedLegacyGenerations, currentLegacyMarker);
    }
    if (!keyringDeleteJournalFits(
      preparedGenerations,
      preparedLegacyGenerations,
      unverifiable,
    )) {
      let compacted = true;
      for (const marker of journal.generations) {
        if (!removeKeyringChunks(Entry, KEYRING_SERVICE, account, marker, diag)) {
          compacted = false;
        }
      }
      for (const marker of journal.legacyGenerations ?? []) {
        if (!removeKeyringChunks(Entry, LEGACY_KEYRING_SERVICE, account, marker, diag)) {
          compacted = false;
        }
      }
      if (!compacted) return false;
      preparedGenerations = currentMarker ? [currentMarker] : [];
      preparedLegacyGenerations = currentLegacyMarker ? [currentLegacyMarker] : [];
    }
    if (!keyringDeleteJournalFits(
      preparedGenerations,
      preparedLegacyGenerations,
      unverifiable,
    )) {
      diag?.('keyring cleanup journal cannot represent the pending generations');
      return false;
    }
    const preparedJournal: KeyringChunkJournal = {
      mode: 'delete',
      generations: preparedGenerations,
      ...(preparedLegacyGenerations.length > 0
        ? { legacyGenerations: preparedLegacyGenerations }
        : {}),
      ...(unverifiable ? { unverifiable: true } : {}),
    };
    if (encodeKeyringJournal(preparedJournal) !== rawJournal) {
      try {
        writeKeyringJournal(Entry, account, preparedJournal);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
    }
    journal = preparedJournal;
    try {
      if (accountEntry.getPassword() !== null) accountEntry.deletePassword();
      if (legacyAccountEntry.getPassword() !== null) legacyAccountEntry.deletePassword();
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  } else {
    try {
      activeMarker = parseKeyringChunkMarker(accountEntry.getPassword());
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }

    const activeJournalMarker = activeMarker
      ? journal.generations.find(marker => sameKeyringGeneration(activeMarker, marker))
      : undefined;
    if (activeMarker && activeJournalMarker) {
      try {
        readKeyringMarkerChunks(Entry, KEYRING_SERVICE, account, activeMarker);
        if (
          activeJournalMarker.count > activeMarker.count
          && !removeKeyringChunkRange(
            Entry,
            KEYRING_SERVICE,
            account,
            activeJournalMarker,
            activeMarker.count,
            diag,
          )
        ) {
          return false;
        }
      } catch (err) {
        diag?.(classifyKeyringError(err));
        const recoveryCandidates = [
          ...(!sameKeyringMarker(activeMarker, activeJournalMarker)
            ? [activeJournalMarker]
            : []),
          ...journal.generations.filter(marker =>
            !sameKeyringGeneration(activeMarker, marker),
          ),
        ];
        let recovered = false;
        for (const candidate of recoveryCandidates) {
          try {
            readKeyringMarkerChunks(Entry, KEYRING_SERVICE, account, candidate);
            if (
              activeMarker.count > activeJournalMarker.count
              && !removeKeyringChunkRange(
                Entry,
                KEYRING_SERVICE,
                account,
                activeMarker,
                activeJournalMarker.count,
                diag,
              )
            ) {
              return false;
            }
            accountEntry.setPassword(encodeKeyringChunkMarker(candidate));
            activeMarker = candidate;
            recovered = true;
            break;
          } catch (candidateErr) {
            diag?.(classifyKeyringError(candidateErr));
          }
        }
        if (!recovered) return false;
      }
    }
  }

  let cleaned = true;
  for (const marker of journal.generations) {
    if (journal.mode === 'write' && sameKeyringGeneration(activeMarker, marker)) continue;
    if (!removeKeyringChunks(Entry, KEYRING_SERVICE, account, marker, diag)) {
      cleaned = false;
    }
  }
  for (const marker of journal.legacyGenerations ?? []) {
    if (!removeKeyringChunks(Entry, LEGACY_KEYRING_SERVICE, account, marker, diag)) {
      cleaned = false;
    }
  }
  if (!cleaned) return false;
  if (journal.unverifiable === true) return false;

  try {
    journalEntry.deletePassword();
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
}

function keyringAccountLockPath(account: string): string {
  const identity = createHash('sha256').update(account).digest('hex');
  return join(homedir(), '.clodex', 'keyring-locks', `${identity}.lock`);
}

async function withKeyringAccountLock<T>(
  account: string,
  fallback: T,
  diag: ((msg: string) => void) | undefined,
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    return await withRegistryWriteLock(operation, {
      lockPath: keyringAccountLockPath(account),
    });
  } catch {
    diag?.('keyring credential store is busy or unavailable');
    return fallback;
  }
}

async function readKeyringAccount(account: string, diag?: (msg: string) => void): Promise<string | null> {
  return withKeyringAccountLock(account, null, diag, async () => {
    try {
      const { Entry } = await import('@napi-rs/keyring');
      const rawJournal = new Entry(KEYRING_JOURNAL_SERVICE, account).getPassword();
      const pendingMode = rawJournal === null
        ? null
        : parseKeyringChunkJournal(rawJournal).mode;
      const cleanupComplete = reconcileKeyringJournal(Entry, account, diag);
      if (pendingMode === 'delete') return null;
      const value = readKeyringAccountFromService(Entry, KEYRING_SERVICE, account);
      if (value !== null || !cleanupComplete) return value;
      // One-time silent migration: fall back to the relay-ai keychain service and
      // copy the credential into the clodex service on first read.
      let legacy: string | null = null;
      try {
        legacy = readKeyringAccountFromService(Entry, LEGACY_KEYRING_SERVICE, account);
      } catch {
        legacy = null;
      }
      if (legacy !== null) {
        writeKeyringAccountLocked(Entry, account, legacy, diag);
      }
      return legacy;
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return null;
    }
  });
}

function replaceMalformedKeyringJournalWithTombstone(
  Entry: typeof import('@napi-rs/keyring').Entry,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  try {
    writeKeyringJournal(Entry, account, {
      mode: 'delete',
      generations: [],
      unverifiable: true,
    });
    diag?.('invalid keyring cleanup journal was replaced with a deletion tombstone');
    return true;
  } catch {
    diag?.('invalid keyring cleanup journal could not be replaced');
    return false;
  }
}

function writeKeyringAccountLocked(
  Entry: typeof import('@napi-rs/keyring').Entry,
  account: string,
  key: string,
  diag?: (msg: string) => void,
): boolean {
  try {
    let reconciled: boolean;
    try {
      reconciled = reconcileKeyringJournal(Entry, account, diag);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      if (err instanceof InvalidKeyringJournalError) {
        replaceMalformedKeyringJournalWithTombstone(Entry, account, diag);
      }
      return false;
    }
    if (!reconciled) return false;

    const accountEntry = new Entry(KEYRING_SERVICE, account);
    const previousValue = accountEntry.getPassword() ?? null;
    let previousMarker: KeyringChunkMarker | null = null;
    try {
      previousMarker = parseKeyringChunkMarker(previousValue);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      replaceMalformedKeyringJournalWithTombstone(Entry, account, diag);
      return false;
    }
    if (key.length <= KEYRING_CHUNK_SIZE) {
      if (previousMarker) {
        writeKeyringJournal(Entry, account, {
          mode: 'write',
          generations: [previousMarker],
        });
      }
      accountEntry.setPassword(key);
      if (previousMarker && !reconcileKeyringJournal(Entry, account, diag)) {
        diag?.('keyring cleanup is pending and will be retried');
      }
      return true;
    }
    const chunkCount = Math.ceil(key.length / KEYRING_CHUNK_SIZE);
    if (chunkCount > KEYRING_MAX_CHUNKS) {
      throw new Error('keyring credential exceeds the supported chunk count');
    }
    const marker: KeyringChunkMarker = {
      count: chunkCount,
      generation: randomUUID(),
      digest: createHash('sha256').update(key).digest('hex'),
    };
    writeKeyringJournal(Entry, account, {
      mode: 'write',
      generations: [marker, ...(previousMarker ? [previousMarker] : [])],
    });
    for (let i = 0; i < chunkCount; i++) {
      const chunk = key.slice(i * KEYRING_CHUNK_SIZE, (i + 1) * KEYRING_CHUNK_SIZE);
      new Entry(KEYRING_CHUNK_SERVICE, keyringChunkAccount(account, marker, i)).setPassword(chunk);
    }
    accountEntry.setPassword(encodeKeyringChunkMarker(marker));
    if (!reconcileKeyringJournal(Entry, account, diag)) {
      diag?.('keyring cleanup is pending and will be retried');
    }
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
}

async function writeKeyringAccount(
  account: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  return withKeyringAccountLock(account, false, diag, async () => {
    try {
      const { Entry } = await import('@napi-rs/keyring');
      return writeKeyringAccountLocked(Entry, account, key, diag);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  });
}

async function deleteKeyringAccount(account: string, diag?: (msg: string) => void): Promise<boolean> {
  return withKeyringAccountLock(account, false, diag, async () => {
    try {
      const { Entry } = await import('@napi-rs/keyring');
      const journalEntry = new Entry(KEYRING_JOURNAL_SERVICE, account);
      const accountEntry = new Entry(KEYRING_SERVICE, account);
      const legacyAccountEntry = new Entry(LEGACY_KEYRING_SERVICE, account);
      const pendingJournalRaw = journalEntry.getPassword();
      const initialValue = accountEntry.getPassword();
      const initialLegacyValue = legacyAccountEntry.getPassword();
      let pendingJournal: KeyringChunkJournal | null = null;
      let pendingMode: KeyringChunkJournal['mode'] | null = null;
      try {
        if (pendingJournalRaw !== null) {
          pendingJournal = parseKeyringChunkJournal(pendingJournalRaw);
          pendingMode = pendingJournal.mode;
        }
        const cleanupComplete = reconcileKeyringJournal(Entry, account, diag);
        if (pendingMode === 'delete' && !cleanupComplete) return false;
        if (cleanupComplete) pendingJournal = null;
      } catch (err) {
        diag?.(classifyKeyringError(err));
        if (err instanceof InvalidKeyringJournalError) {
          replaceMalformedKeyringJournalWithTombstone(Entry, account, diag);
        }
        return false;
      }
      const value = accountEntry.getPassword();
      const legacyValue = legacyAccountEntry.getPassword();
      const generations: KeyringChunkMarker[] = [];
      const legacyGenerations: KeyringChunkMarker[] = [];
      for (const marker of pendingJournal?.generations ?? []) {
        appendUniqueKeyringMarker(generations, marker);
      }
      for (const marker of pendingJournal?.legacyGenerations ?? []) {
        appendUniqueKeyringMarker(legacyGenerations, marker);
      }
      let unverifiable = pendingJournal?.unverifiable === true;
      for (const [storedValue, target] of [
        ...(pendingMode === 'delete'
          ? []
          : [
            [initialValue, generations],
            [initialLegacyValue, legacyGenerations],
          ] as const),
        [value, generations],
        [legacyValue, legacyGenerations],
      ] as const) {
        try {
          const marker = parseKeyringChunkMarker(storedValue);
          if (marker) appendUniqueKeyringMarker(target, marker);
        } catch (err) {
          unverifiable = true;
          diag?.(classifyKeyringError(err));
        }
      }
      if (
        value === null
        && legacyValue === null
        && generations.length === 0
        && legacyGenerations.length === 0
        && !unverifiable
      ) {
        return true;
      }
      if (!keyringDeleteJournalFits(generations, legacyGenerations, unverifiable)) {
        diag?.('keyring cleanup has too many pending generations');
        return false;
      }
      writeKeyringJournal(Entry, account, {
        mode: 'delete',
        generations,
        ...(legacyGenerations.length > 0 ? { legacyGenerations } : {}),
        ...(unverifiable ? { unverifiable: true } : {}),
      });
      return reconcileKeyringJournal(Entry, account, diag);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  });
}

type StoredCredentialRef = Extract<ParsedAuthRef, { kind: 'keyring' | 'helper' }>;

function storedCredentialAuthRef(ref: StoredCredentialRef): string {
  return ref.kind === 'helper'
    ? `helper:v1:${ref.helperId}:${ref.account}`
    : `keyring:${ref.account}`;
}

async function readStoredCredential(
  ref: StoredCredentialRef,
  diag?: (msg: string) => void,
): Promise<string | null> {
  if (ref.kind === 'keyring') return readKeyringAccount(ref.account, diag);
  try {
    return await readCredentialHelperAccount(ref.account, ref.helperId);
  } catch (err) {
    diag?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function writeStoredCredential(
  ref: StoredCredentialRef,
  value: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  if (ref.kind === 'keyring') return writeKeyringAccount(ref.account, value, diag);
  try {
    await writeCredentialHelperAccount(ref.account, value, ref.helperId);
    return true;
  } catch (err) {
    diag?.(err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function deleteStoredCredential(
  ref: StoredCredentialRef,
  diag?: (msg: string) => void,
): Promise<boolean> {
  if (ref.kind === 'keyring') return deleteKeyringAccount(ref.account, diag);
  try {
    await deleteCredentialHelperAccount(ref.account, ref.helperId);
    return true;
  } catch (err) {
    diag?.(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Resolve a provider secret from a namespaced env var or its configured store. */
export async function resolveProviderCredential(
  providerId: string,
  authRef: string,
  diag?: (msg: string) => void,
  options: ResolveCredentialOptions = {},
): Promise<string | null> {
  const parsed = parseAuthRef(authRef);
  if (parsed?.kind === 'none') return null;

  const namespacedVar = clodexKeyEnvVar(providerId);
  const namespaced = usableEnvCredential(
    `provider:${providerId}`,
    readEnvCredential(namespacedVar),
    options.rejectedAccessToken,
  );
  if (namespaced) return namespaced;

  if (!parsed) return null;

  if (parsed.kind === 'env') {
    return usableEnvCredential(
      `provider:${providerId}:env:${parsed.varName}`,
      readEnvCredential(parsed.varName),
      options.rejectedAccessToken,
    );
  }

  return readProviderSecret(parsed, diag, options.rejectedAccessToken);
}

/** Read OAuth metadata retained alongside the access token. */
export async function resolveProviderOAuthAccountId(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<string | undefined> {
  const parsed = parseAuthRef(authRef);
  if (
    !parsed
    || parsed.kind === 'env'
    || parsed.kind === 'none'
    || !oauthProviderIdFromAccount(parsed.account)
  ) return undefined;
  const raw = await readStoredCredential(parsed, diag);
  return parseStoredOAuthCredential(raw)?.accountId;
}

export async function resolveProviderOAuthProviderData(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<Record<string, unknown> | undefined> {
  const parsed = parseAuthRef(authRef);
  if (
    !parsed
    || parsed.kind === 'env'
    || parsed.kind === 'none'
    || !oauthProviderIdFromAccount(parsed.account)
  ) return undefined;
  const raw = await readStoredCredential(parsed, diag);
  return parseStoredOAuthCredential(raw)?.providerData;
}

function decodeProviderSecret(raw: string | null, allowOpaqueJson = false): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  const oauth = parseStoredOAuthCredential(trimmed);
  if (oauth) return oauth.access;
  try {
    const parsed = JSON.parse(trimmed) as { type?: string; access?: string; token?: string };
    if (parsed.type === 'wellknown') {
      return typeof parsed.token === 'string' && parsed.token.trim()
        ? parsed.token.trim()
        : null;
    }
    if (allowOpaqueJson && parsed.type === 'oauth') {
      return typeof parsed.access === 'string' && parsed.access.trim()
        ? parsed.access.trim()
        : null;
    }
    return allowOpaqueJson ? raw : null;
  } catch {
    return null;
  }
}

function oauthCredentialStateKey(providerId: string, authRef: string): string {
  return `${providerId}${OAUTH_STATE_KEY_SEPARATOR}${authRef}`;
}

function clearOAuthCredentialCache(authRef: string): void {
  const suffix = `${OAUTH_STATE_KEY_SEPARATOR}${authRef}`;
  for (const key of oauthCredentialCache.keys()) {
    if (key.endsWith(suffix)) oauthCredentialCache.delete(key);
  }
}

function cacheOAuthCredential(
  stateKey: string,
  credential: StoredOAuthCredential,
): void {
  oauthCredentialCache.set(stateKey, {
    access: credential.access,
    expires: credential.expires,
    ...(credential.accessRejected === true ? { accessRejected: true as const } : {}),
    checkedAt: Date.now(),
  });
}

function cachedOAuthCredentialIsUsable(
  credential: CachedOAuthCredential | undefined,
  providerId: string,
  rejectedAccessToken?: string,
): boolean {
  if (!credential) return false;
  const age = Date.now() - credential.checkedAt;
  return age >= 0
    && age < OAUTH_CREDENTIAL_CACHE_MAX_AGE_MS
    && credential.access !== rejectedAccessToken
    && credential.accessRejected !== true
    && !oauthCredentialShouldRefresh(credential, providerId);
}

async function readOAuthProviderSecret(
  ref: StoredCredentialRef,
  providerId: string,
  diag?: (msg: string) => void,
  rejectedAccessToken?: string,
): Promise<string | null> {
  const authRef = storedCredentialAuthRef(ref);
  const stateKey = oauthCredentialStateKey(providerId, authRef);
  const existing = oauthRefreshInflight.get(stateKey);
  if (existing) {
    const resolved = await existing;
    if (resolved !== rejectedAccessToken) return resolved;
    return readOAuthProviderSecret(ref, providerId, diag, rejectedAccessToken);
  }

  const cached = oauthCredentialCache.get(stateKey);
  if (cached && cachedOAuthCredentialIsUsable(cached, providerId, rejectedAccessToken)) {
    return cached.access;
  }
  if (cached?.access === rejectedAccessToken) oauthCredentialCache.delete(stateKey);

  const work = withCredentialMutationLock(authRef, async (): Promise<string | null> => {
    const latestCached = oauthCredentialCache.get(stateKey);
    if (
      latestCached
      && cachedOAuthCredentialIsUsable(latestCached, providerId, rejectedAccessToken)
    ) {
      return latestCached.access;
    }

    for (let generation = 0; generation < 3; generation += 1) {
      const raw = await readStoredCredential(ref, diag);
      if (!raw) return null;

      const cred = parseStoredOAuthCredential(raw);
      if (!cred) {
        const decoded = decodeProviderSecret(raw);
        return decoded === rejectedAccessToken ? null : decoded;
      }
      cacheOAuthCredential(stateKey, cred);

      const forceRefresh = cred.access === rejectedAccessToken || cred.accessRejected === true;
      if (!forceRefresh && !oauthCredentialShouldRefresh(cred, providerId)) {
        return cred.access;
      }

      let refreshed;
      try {
        refreshed = await refreshStoredOAuthCredential(providerId, cred);
      } catch (err) {
        diag?.(err instanceof Error ? err.message : String(err));
        if (!forceRefresh && cred.access && cred.expires > Date.now()) return cred.access;
        oauthCredentialCache.delete(stateKey);
        throw err;
      }

      const accessStillRejected = (
        rejectedAccessToken !== undefined
        && refreshed.access === rejectedAccessToken
      ) || (
        cred.accessRejected === true
        && refreshed.access === cred.access
      );
      const currentRaw = await readStoredCredential(ref, diag);
      if (currentRaw !== raw) {
        oauthCredentialCache.delete(stateKey);
        continue;
      }

      const credentialToSave: StoredOAuthCredential = accessStillRejected
        ? { ...refreshed, accessRejected: true }
        : refreshed;
      const json = oauthCredentialToKeychainJson(credentialToSave);
      const saved = await saveProviderCredential(authRef, json, diag);
      if (!saved) {
        oauthCredentialCache.delete(stateKey);
        throw new Error('Could not persist refreshed OAuth credential');
      }
      if (accessStillRejected) {
        oauthCredentialCache.delete(stateKey);
        return null;
      }
      return refreshed.access;
    }
    throw new Error('OAuth credential changed repeatedly while refresh was in progress');
  }, {
    waitMs: OAUTH_REFRESH_LOCK_WAIT_MS,
  });

  oauthRefreshInflight.set(stateKey, work);
  try {
    return await work;
  } finally {
    if (oauthRefreshInflight.get(stateKey) === work) {
      oauthRefreshInflight.delete(stateKey);
    }
  }
}

async function readProviderSecret(
  ref: StoredCredentialRef,
  diag?: (msg: string) => void,
  rejectedAccessToken?: string,
): Promise<string | null> {
  const oauthProviderId = oauthProviderIdFromAccount(ref.account);
  if (oauthProviderId) {
    return readOAuthProviderSecret(ref, oauthProviderId, diag, rejectedAccessToken);
  }
  const raw = await readStoredCredential(ref, diag);
  const decoded = decodeProviderSecret(raw, true);
  return decoded === rejectedAccessToken ? null : decoded;
}

export async function saveProviderCredential(
  authRef: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind === 'env' || parsed.kind === 'none') return false;
  return withCredentialMutationLock(authRef, async () => {
    const cacheKey = storedCredentialAuthRef(parsed);
    clearOAuthCredentialCache(cacheKey);
    const written = await writeStoredCredential(parsed, key, diag);
    if (!written) return false;
    const readBack = await readStoredCredential(parsed, diag);
    if (readBack === key) {
      const oauth = parseStoredOAuthCredential(key);
      const oauthProviderId = oauthProviderIdFromAccount(parsed.account);
      if (oauth && oauthProviderId) {
        cacheOAuthCredential(oauthCredentialStateKey(oauthProviderId, cacheKey), oauth);
      }
      return true;
    }
    diag?.('credential store read-back verification failed');
    return false;
  });
}

/** Verify that a credential backend can durably round-trip a disposable secret. */
export async function probeProviderCredentialStore(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind === 'env' || parsed.kind === 'none') return false;
  const probeAccount = `${parsed.account}::probe::${randomUUID()}`;
  const probeRef: StoredCredentialRef = parsed.kind === 'helper'
    ? { kind: 'helper', helperId: parsed.helperId, account: probeAccount }
    : { kind: 'keyring', account: probeAccount };
  const value = randomUUID();
  let verified = false;
  try {
    const written = await writeStoredCredential(probeRef, value, diag);
    if (!written) return false;
    const readBack = await readStoredCredential(probeRef, diag);
    if (readBack !== value) {
      diag?.('credential store probe read-back verification failed');
      return false;
    }
    verified = true;
  } finally {
    const deleted = await deleteStoredCredential(probeRef, diag);
    if (!deleted) {
      diag?.('credential store probe cleanup failed');
      verified = false;
    }
  }
  return verified;
}

/** Delete a provider secret from its credential store (no-op for env: refs). */
export async function deleteProviderCredential(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind === 'env' || parsed.kind === 'none') return false;
  return withCredentialMutationLock(authRef, () => {
    clearOAuthCredentialCache(storedCredentialAuthRef(parsed));
    return deleteStoredCredential(parsed, diag);
  });
}
