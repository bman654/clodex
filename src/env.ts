// src/env.ts
import { CONFLICTING_ENV_VARS } from './constants.js';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  credentialAccountBase,
  deleteCredentialHelperAccount,
  isCredentialAccountInstance,
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
  getCredentialMutationLockPath,
  getCredentialStateRoot,
  withCredentialMutationLock,
  withRegistryWriteLock,
} from './registry/lock.js';
import type { ConflictInfo } from './types.js';
import { removeAnthropicProxyBypass } from './wrapper-env.js';

export function detectConflicts(): ConflictInfo[] {
  return CONFLICTING_ENV_VARS.filter(name => process.env[name] !== undefined).map(name => ({
    name,
    value: process.env[name]!,
  }));
}

/** Restore first-party-like Claude Code behavior when routing through a proxy or gateway. */
export function applyClaudeCodeThirdPartyCompat(env: NodeJS.ProcessEnv): void {
  // Custom ANTHROPIC_BASE_URL disables MCP tool search by default, loading every
  // MCP tool (100+) on every turn. Requires defer_loading on tools — clodex must
  // not add blanket beta suppression for a proxied route. An explicit value the
  // operator supplied in the parent environment remains authoritative.
  env['ENABLE_TOOL_SEARCH'] = 'true';
  // Third-party routes may enable a shorter system prompt that drops conversational
  // guardrails while hooks/plugins still inject agentic instructions.
  env['CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT'] = '0';
}

/** Loopback spellings the child must reach directly even behind a proxy. */
const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const;

/** Hostname of a base URL, with IPv6 brackets stripped; '' when unparseable. */
function gatewayHostname(gatewayUrl: string): string {
  try {
    return new URL(gatewayUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Loopback per RFC 5735/4291: `localhost`, all of 127.0.0.0/8, and `::1`. */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some(o => o > 255)) return false;
  return octets[0] === 127;
}

/**
 * The NO_PROXY value the child actually consults. Claude Code reads
 * `no_proxy || NO_PROXY`, so a non-empty lowercase value wins OUTRIGHT and the
 * uppercase one is never seen. Unioning the two would hand back proxy-free
 * routing for hosts the user had bypassed in only the losing variable.
 */
function effectiveNoProxyValue(env: NodeJS.ProcessEnv): string {
  return env['no_proxy'] || env['NO_PROXY'] || '';
}

function normalizedNoProxyEntries(env: NodeJS.ProcessEnv): string[] {
  return effectiveNoProxyValue(env)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

/**
 * Endpoint mode points the child at a local gateway but deliberately leaves the
 * user's HTTP(S)_PROXY in place — Claude Code still needs it for its OWN outbound
 * traffic (WebFetch, MCP servers, telemetry). Claude Code honours NO_PROXY but has
 * no implicit loopback bypass, so without this it asks the corporate proxy to fetch
 * the loopback gateway and a proxy that refuses returns a bodyless 503 (issue #95,
 * confirmed fixed by the reporter with a manual `no_proxy`).
 *
 * Deliberately additive: entries already present are preserved, and the child's
 * proxy is left usable for everything that is not the gateway. This is why we do
 * NOT simply delete the proxy vars the way the wrapper's endpoint branch does.
 */
export function addGatewayNoProxyBypass(env: NodeJS.ProcessEnv, gatewayUrl: string): void {
  const hasProxy = Boolean(
    env['HTTPS_PROXY']?.trim() || env['https_proxy']?.trim()
    || env['HTTP_PROXY']?.trim() || env['http_proxy']?.trim(),
  );
  // Nothing to bypass without a proxy — do not add noise to a clean env.
  if (!hasProxy) return;

  // ONLY loopback gateways. `buildChildEnv` is also called with a REMOTE
  // Anthropic-passthrough baseUrl (`cli.ts`, the modelFormat === 'anthropic'
  // branch), and that host must keep using the proxy — bypassing it there would
  // point the child straight at a host the proxy may be the only route to.
  const host = gatewayHostname(gatewayUrl);
  if (!isLoopbackHost(host)) return;

  // `*` bypasses everything ONLY as the entire value — Claude Code's matcher
  // tests `value === "*"` before splitting, and a `*` appearing as one entry in
  // a list matches nothing. Bailing on a list-member `*` would make this a
  // silent no-op and reproduce #95 for anyone with e.g. `NO_PROXY=internal,*`.
  if (effectiveNoProxyValue(env) === '*') return;
  const existing = normalizedNoProxyEntries(env);

  // The gateway's OWN address has to be in the list: NO_PROXY matches host by
  // host, so the canonical spellings do not cover a gateway bound elsewhere in
  // 127.0.0.0/8 (all of which is loopback). Without this, `http://127.1.2.3:…`
  // is recognised as local and still routed to the proxy — the original bug.
  const additions: string[] = [...LOOPBACK_NO_PROXY_ENTRIES, host];
  const seen = new Set(existing.map(entry => entry.toLowerCase()));
  const merged = [...existing];
  for (const entry of additions) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }

  const value = merged.join(',');
  // Claude Code reads `no_proxy` before `NO_PROXY`; set both so neither wins stale.
  env['NO_PROXY'] = value;
  env['no_proxy'] = value;
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
  addGatewayNoProxyBypass(env, env['ANTHROPIC_BASE_URL']);
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
  removeAnthropicProxyBypass(env);
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
const KEYRING_DELETED_SERVICE = 'clodex-deleted';
const KEYRING_MANAGED_STATE_KEY_SERVICE = 'clodex-state-key';
const KEYRING_DELETED_VALUE = 'v1:deleted';
const KEYRING_PENDING_DELETE_VALUE = 'v1:pending';
const KEYRING_MANAGED_STATE_KEY_PREFIX = 'v1:';
// Windows Credential Manager caps a single credential blob at 2560 bytes (CredWriteW).
// keyring-rs encodes the password as UTF-16 (2 bytes/char) before that check, so the
// usable limit is 2560 / 2 = 1280 chars — long OAuth tokens (e.g. OpenAI's JWTs) exceed
// this, so secrets above the threshold are split across multiple keyring entries.
// Harmless on macOS/Linux, which have no such limit.
const KEYRING_CHUNK_PREFIX = '__relay_chunked__:';
const KEYRING_JOURNAL_PREFIX = '__clodex_chunk_journal__:v1:';
const KEYRING_DELETE_TOMBSTONE_PREFIX = '__clodex_delete__:';
const KEYRING_ENUMERATION_SENTINEL_PREFIX = '__clodex_inventory__:';
const KEYRING_MAX_ENTRY_CHARS = 1200;
const KEYRING_CHUNK_SIZE = KEYRING_MAX_ENTRY_CHARS;
const KEYRING_MAX_CHUNKS = 128;
const KEYRING_MAX_WRITE_GENERATIONS = 2;
const KEYRING_MAX_DELETE_GENERATIONS = 6;
const KEYRING_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface KeyringChunkMarker {
  count: number;
  generation?: string;
  digest?: string;
}

interface KeyringChunkJournal {
  mode: 'write' | 'short' | 'delete' | 'deleted';
  generations: KeyringChunkMarker[];
  shortDigest?: string;
  fallbackShortDigest?: string;
  unpublished?: true;
  publicationAttempted?: true;
  blockLegacy?: true;
  unverifiable?: true;
}

type KeyringApi = Pick<typeof import('@napi-rs/keyring'), 'Entry' | 'findCredentials'>;

export function providerKeyringAccount(providerId: string): string {
  return `provider:${providerId}`;
}

export function oauthProviderKeyringAccount(providerId: string): string {
  return `oauth:provider:${providerId}`;
}

function oauthProviderIdFromAccount(account: string): string | null {
  const prefix = 'oauth:provider:';
  const baseAccount = credentialAccountBase(account);
  return baseAccount.startsWith(prefix) ? baseAccount.slice(prefix.length) : null;
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
  return (
    Number.isSafeInteger(index) &&
    indexText === String(index) &&
    index >= 0 &&
    index < KEYRING_MAX_CHUNKS
  );
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

function readKeyringEntry(keyring: KeyringApi, service: string, account: string): string | null {
  const value = new keyring.Entry(service, account).getPassword();
  if (value !== null) return value;

  const matches = keyring
    .findCredentials(service)
    .filter(credential => credential.account === account);
  if (matches.length > 1) {
    throw new Error(`keyring credential account is ambiguous: ${account}`);
  }
  return matches[0]?.password ?? null;
}

function deleteKeyringEntry(keyring: KeyringApi, service: string, account: string): boolean {
  const entry = new keyring.Entry(service, account);
  const existing = readKeyringEntry(keyring, service, account);
  if (existing === null) {
    entry.deletePassword();
    return readKeyringEntry(keyring, service, account) === null;
  }
  if (!persistKeyringDeletionTombstone(keyring, service, account, existing)) return false;
  if (!entry.deletePassword()) return false;
  return readKeyringEntry(keyring, service, account) === null;
}

function hasUnjournaledKeyringChunks(keyring: KeyringApi, account: string): boolean {
  const prefix = `${account}::chunk::`;
  return [KEYRING_SERVICE, KEYRING_CHUNK_SERVICE].some(service =>
    keyring
      .findCredentials(service)
      .some(
        credential =>
          credential.account.startsWith(prefix) && isReservedKeyringAccount(credential.account),
      ),
  );
}

function listUnjournaledKeyringChunks(
  keyring: KeyringApi,
  account: string,
): Array<{ service: string; account: string; value: string }> {
  const prefix = `${account}::chunk::`;
  return [KEYRING_SERVICE, KEYRING_CHUNK_SERVICE].flatMap(service =>
    keyring
      .findCredentials(service)
      .filter(
        credential =>
          credential.account.startsWith(prefix) && isReservedKeyringAccount(credential.account),
      )
      .map(credential => ({
        service,
        account: credential.account,
        value: credential.password,
      })),
  );
}

interface KeyringEnumerationSentinel {
  service: string;
  account: string;
  value: string;
}

function createKeyringEnumerationSentinel(
  service: string,
  account: string,
): KeyringEnumerationSentinel {
  const generation = randomUUID();
  return {
    service,
    account: `${account}::chunk::${generation}::0`,
    value: `${KEYRING_ENUMERATION_SENTINEL_PREFIX}${generation}`,
  };
}

function writeKeyringEnumerationSentinel(
  keyring: KeyringApi,
  sentinel: KeyringEnumerationSentinel,
): void {
  new keyring.Entry(sentinel.service, sentinel.account).setPassword(sentinel.value);
  if (readKeyringEntry(keyring, sentinel.service, sentinel.account) !== sentinel.value) {
    throw new Error('keyring credential inventory sentinel could not be verified');
  }
}

function sameKeyringEnumerationEntry(
  entry: { service: string; account: string },
  sentinel: KeyringEnumerationSentinel,
): boolean {
  return entry.service === sentinel.service && entry.account === sentinel.account;
}

function removeKeyringEnumerationSentinel(
  keyring: KeyringApi,
  sentinel: KeyringEnumerationSentinel,
): boolean {
  const current = readKeyringEntry(keyring, sentinel.service, sentinel.account);
  if (current === null) return true;
  if (current !== sentinel.value) return false;
  if (!new keyring.Entry(sentinel.service, sentinel.account).deletePassword()) {
    return false;
  }
  return readKeyringEntry(keyring, sentinel.service, sentinel.account) === null;
}

function isKeyringInventoryBookkeepingEntry(
  entry: { account: string; value: string },
  ownerAccount: string,
): boolean {
  const accountPrefix = `${ownerAccount}::chunk::`;
  const accountSuffix = '::0';
  if (!entry.account.startsWith(accountPrefix) || !entry.account.endsWith(accountSuffix)) {
    return false;
  }
  const generation = entry.account.slice(accountPrefix.length, -accountSuffix.length);
  return (
    KEYRING_GENERATION_PATTERN.test(generation) &&
    entry.value === `${KEYRING_ENUMERATION_SENTINEL_PREFIX}${generation}`
  );
}

function removeKeyringBookkeepingEntry(
  keyring: KeyringApi,
  ownerAccount: string,
  entry: { service: string; account: string; value: string },
): boolean {
  if (!isKeyringInventoryBookkeepingEntry(entry, ownerAccount)) return false;
  if (readKeyringEntry(keyring, entry.service, entry.account) !== entry.value) return false;
  if (!new keyring.Entry(entry.service, entry.account).deletePassword()) {
    return false;
  }
  return readKeyringEntry(keyring, entry.service, entry.account) === null;
}

function verifyEmptyKeyringCredentialInventory(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  const sentinels: KeyringEnumerationSentinel[] = [];
  let empty = false;
  let cleanupComplete = true;
  try {
    for (const service of [KEYRING_SERVICE, KEYRING_CHUNK_SERVICE]) {
      const sentinel = createKeyringEnumerationSentinel(service, account);
      sentinels.push(sentinel);
      writeKeyringEnumerationSentinel(keyring, sentinel);
    }
    const currentValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    const inventory = listUnjournaledKeyringChunks(keyring, account);
    const complete = sentinels.every(sentinel =>
      inventory.some(entry => sameKeyringEnumerationEntry(entry, sentinel)),
    );
    const credentialEntries = inventory.filter(
      entry =>
        !sentinels.some(sentinel => sameKeyringEnumerationEntry(entry, sentinel)) &&
        !isKeyringInventoryBookkeepingEntry(entry, account),
    );
    const bookkeepingEntries = inventory.filter(
      entry =>
        !sentinels.some(sentinel => sameKeyringEnumerationEntry(entry, sentinel)) &&
        isKeyringInventoryBookkeepingEntry(entry, account),
    );
    for (const entry of bookkeepingEntries) {
      if (!removeKeyringBookkeepingEntry(keyring, account, entry)) {
        cleanupComplete = false;
        diag?.('keyring credential inventory bookkeeping could not be removed');
      }
    }
    empty = complete && currentValue === null && credentialEntries.length === 0;
    if (!complete) {
      diag?.('keyring credential inventory could not be verified');
    } else if (!empty) {
      diag?.('keyring credential inventory is not empty');
    }
  } catch (err) {
    diag?.(classifyKeyringError(err));
  } finally {
    for (const sentinel of sentinels) {
      try {
        if (!removeKeyringEnumerationSentinel(keyring, sentinel)) {
          cleanupComplete = false;
          diag?.('keyring credential inventory sentinel could not be removed');
        }
      } catch (err) {
        cleanupComplete = false;
        diag?.(classifyKeyringError(err));
      }
    }
  }
  return empty && cleanupComplete;
}

function isDisposableCredentialProbeAccount(account: string): boolean {
  const separator = '::probe::';
  const separatorIndex = account.lastIndexOf(separator);
  return (
    separatorIndex > 0 &&
    KEYRING_GENERATION_PATTERN.test(account.slice(separatorIndex + separator.length))
  );
}

function persistKeyringDeletionTombstone(
  keyring: KeyringApi,
  service: string,
  account: string,
  existing: string,
): boolean {
  if (existing.startsWith(KEYRING_DELETE_TOMBSTONE_PREFIX)) return true;
  const tombstone = `${KEYRING_DELETE_TOMBSTONE_PREFIX}${randomUUID()}`;
  new keyring.Entry(service, account).setPassword(tombstone);
  return readKeyringEntry(keyring, service, account) === tombstone;
}

function readKeyringAccountFromService(
  keyring: KeyringApi,
  service: string,
  account: string,
  retries = 2,
): string | null {
  const value = readKeyringEntry(keyring, service, account);
  const marker = parseKeyringChunkMarker(value);
  if (!marker) return value;
  let combined: string;
  try {
    combined = readKeyringMarkerChunks(keyring, service, account, marker);
  } catch (err) {
    if (retries > 0 && readKeyringEntry(keyring, service, account) !== value) {
      return readKeyringAccountFromService(keyring, service, account, retries - 1);
    }
    throw err;
  }
  if (readKeyringEntry(keyring, service, account) !== value) {
    if (retries > 0) {
      return readKeyringAccountFromService(keyring, service, account, retries - 1);
    }
    throw new Error('keyring credential changed repeatedly while it was being read');
  }
  return combined;
}

function readKeyringMarkerChunks(
  keyring: KeyringApi,
  service: string,
  account: string,
  marker: KeyringChunkMarker,
): string {
  let combined = '';
  const chunkService = keyringChunkService(service, marker);
  for (let i = 0; i < marker.count; i++) {
    const chunk = readKeyringEntry(keyring, chunkService, keyringChunkAccount(account, marker, i));
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
    const parsed = JSON.parse(
      value.slice(KEYRING_JOURNAL_PREFIX.length),
    ) as Partial<KeyringChunkJournal>;
    if (
      (parsed.mode !== 'write' &&
        parsed.mode !== 'short' &&
        parsed.mode !== 'delete' &&
        parsed.mode !== 'deleted') ||
      !Array.isArray(parsed.generations) ||
      parsed.generations.length >
        (parsed.mode === 'write' || parsed.mode === 'short'
          ? KEYRING_MAX_WRITE_GENERATIONS
          : KEYRING_MAX_DELETE_GENERATIONS) ||
      (parsed.mode === 'write' && parsed.generations.length < 1) ||
      (parsed.mode === 'short' &&
        (typeof parsed.shortDigest !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.shortDigest))) ||
      (parsed.mode !== 'short' && parsed.mode !== 'delete' && parsed.shortDigest !== undefined) ||
      (parsed.mode === 'delete' &&
        parsed.shortDigest !== undefined &&
        (typeof parsed.shortDigest !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.shortDigest))) ||
      (parsed.fallbackShortDigest !== undefined &&
        ((parsed.mode !== 'write' && parsed.mode !== 'short') ||
          typeof parsed.fallbackShortDigest !== 'string' ||
          !/^[0-9a-f]{64}$/.test(parsed.fallbackShortDigest))) ||
      (parsed.unpublished !== undefined &&
        ((parsed.mode !== 'write' && parsed.mode !== 'short') || parsed.unpublished !== true)) ||
      (parsed.publicationAttempted !== undefined &&
        ((parsed.mode !== 'write' && parsed.mode !== 'short') ||
          parsed.publicationAttempted !== true ||
          parsed.unpublished !== true)) ||
      (parsed.unpublished === true && parsed.fallbackShortDigest !== undefined) ||
      (parsed.mode === 'deleted' &&
        (parsed.generations.length > 0 ||
          parsed.shortDigest !== undefined ||
          parsed.fallbackShortDigest !== undefined ||
          parsed.unpublished !== undefined ||
          parsed.publicationAttempted !== undefined ||
          parsed.blockLegacy !== undefined ||
          parsed.unverifiable !== undefined)) ||
      (parsed.mode !== 'delete' &&
        (parsed.blockLegacy !== undefined || parsed.unverifiable !== undefined)) ||
      (parsed.blockLegacy !== undefined && parsed.blockLegacy !== true) ||
      (parsed.unverifiable !== undefined && parsed.unverifiable !== true)
    ) {
      throw new Error('invalid');
    }
    const generations = parsed.generations.map(parseJournalMarker);
    if (
      (parsed.mode === 'write' || parsed.mode === 'short') &&
      generations.some((marker, index) =>
        generations.slice(index + 1).some(candidate => sameKeyringGeneration(marker, candidate)),
      )
    ) {
      throw new Error('invalid');
    }
    return {
      mode: parsed.mode,
      generations,
      ...(parsed.shortDigest ? { shortDigest: parsed.shortDigest } : {}),
      ...(parsed.fallbackShortDigest ? { fallbackShortDigest: parsed.fallbackShortDigest } : {}),
      ...(parsed.unpublished ? { unpublished: true } : {}),
      ...(parsed.publicationAttempted ? { publicationAttempted: true } : {}),
      ...(parsed.blockLegacy ? { blockLegacy: true } : {}),
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
  return (
    left !== null &&
    left.generation === right.generation &&
    Boolean(left.digest) === Boolean(right.digest)
  );
}

function sameKeyringMarker(left: KeyringChunkMarker, right: KeyringChunkMarker): boolean {
  return (
    sameKeyringGeneration(left, right) && left.count === right.count && left.digest === right.digest
  );
}

function appendUniqueKeyringMarker(target: KeyringChunkMarker[], marker: KeyringChunkMarker): void {
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
  unverifiable = false,
  blockLegacy = false,
  shortDigest?: string,
): boolean {
  if (generations.length > KEYRING_MAX_DELETE_GENERATIONS) {
    return false;
  }
  return (
    encodeKeyringJournal({
      mode: 'delete',
      generations,
      ...(shortDigest ? { shortDigest } : {}),
      ...(blockLegacy ? { blockLegacy: true } : {}),
      ...(unverifiable ? { unverifiable: true } : {}),
    }).length <= KEYRING_MAX_ENTRY_CHARS
  );
}

function keyringChunkAccount(account: string, marker: KeyringChunkMarker, index: number): string {
  return marker.generation
    ? `${account}::chunk::${marker.generation}::${index}`
    : `${account}::chunk::${index}`;
}

function keyringChunkService(mainService: string, marker: KeyringChunkMarker): string {
  return marker.digest ? KEYRING_CHUNK_SERVICE : mainService;
}

function splitKeyringCredential(value: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < value.length; ) {
    let end = Math.min(start + KEYRING_CHUNK_SIZE, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function removeKeyringChunkRange(
  keyring: KeyringApi,
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
      if (!deleteKeyringEntry(keyring, chunkService, keyringChunkAccount(account, marker, i))) {
        removed = false;
      }
    } catch (err) {
      removed = false;
      diag?.(classifyKeyringError(err));
    }
  }
  return removed;
}

function removeKeyringChunks(
  keyring: KeyringApi,
  service: string,
  account: string,
  marker: KeyringChunkMarker | null,
  diag?: (msg: string) => void,
): boolean {
  if (!marker) return true;
  return removeKeyringChunkRange(keyring, service, account, marker, 0, diag);
}

function writeKeyringJournal(
  keyring: KeyringApi,
  account: string,
  journal: KeyringChunkJournal,
): void {
  const entry = new keyring.Entry(KEYRING_JOURNAL_SERVICE, account);
  const encoded = encodeKeyringJournal(journal);
  if (encoded.length > KEYRING_MAX_ENTRY_CHARS) {
    throw new Error('keyring cleanup journal exceeds the credential entry limit');
  }
  persistKeyringManagedState(keyring, account, { mode: 'preparing', journal });
  entry.setPassword(encoded);
  if (readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account) !== encoded) {
    throw new Error('keyring cleanup journal verification failed');
  }
  persistKeyringManagedState(keyring, account, { mode: 'managed', journal });
}

function adoptKeyringJournal(
  keyring: KeyringApi,
  account: string,
  journal: KeyringChunkJournal,
  diag?: (msg: string) => void,
): void {
  try {
    const encoded = encodeKeyringJournal(journal);
    if (encoded.length > KEYRING_MAX_ENTRY_CHARS) {
      throw new Error('keyring cleanup journal exceeds the credential entry limit');
    }
    const entry = new keyring.Entry(KEYRING_JOURNAL_SERVICE, account);
    entry.setPassword(encoded);
    if (readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account) !== encoded) {
      throw new Error('keyring cleanup journal verification failed');
    }
    persistKeyringManagedState(keyring, account, { mode: 'managed', journal });
  } catch (err) {
    diag?.(classifyKeyringError(err));
  }
}

function readKeyringDeletionGuard(
  keyring: KeyringApi,
  account: string,
): 'deleted' | 'pending' | null {
  const value = readKeyringEntry(keyring, KEYRING_DELETED_SERVICE, account);
  if (value === null) return null;
  if (value === KEYRING_DELETED_VALUE) return 'deleted';
  if (value === KEYRING_PENDING_DELETE_VALUE) return 'pending';
  throw new Error('keyring credential has an invalid deletion guard');
}

function writeKeyringDeletionGuard(
  keyring: KeyringApi,
  account: string,
  mode: 'deleted' | 'pending',
): boolean {
  const entry = new keyring.Entry(KEYRING_DELETED_SERVICE, account);
  const value = mode === 'deleted' ? KEYRING_DELETED_VALUE : KEYRING_PENDING_DELETE_VALUE;
  entry.setPassword(value);
  return readKeyringEntry(keyring, KEYRING_DELETED_SERVICE, account) === value;
}

function clearKeyringDeletionGuard(keyring: KeyringApi, account: string): boolean {
  return new keyring.Entry(KEYRING_DELETED_SERVICE, account).deletePassword();
}

function reconcileKeyringJournal(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  let rawJournal = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
  let managedState = readKeyringManagedState(keyring, account);
  if (managedState?.mode === 'preparing') {
    try {
      writeKeyringJournal(keyring, account, managedState.journal);
      rawJournal = encodeKeyringJournal(managedState.journal);
      managedState = { mode: 'managed', journal: managedState.journal };
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  } else if (rawJournal === null && managedState?.mode === 'managed') {
    if (managedState.journal === null) {
      diag?.('managed keyring state has no recoverable cleanup journal');
      return false;
    }
    try {
      writeKeyringJournal(keyring, account, managedState.journal);
      rawJournal = encodeKeyringJournal(managedState.journal);
      diag?.('restored keyring cleanup journal from managed state');
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }
  const deletionGuard = readKeyringDeletionGuard(keyring, account);
  if (rawJournal === null) {
    if (deletionGuard === null) {
      return true;
    }
    const restoredJournal: KeyringChunkJournal =
      deletionGuard === 'deleted'
        ? {
            mode: 'deleted',
            generations: [],
          }
        : {
            mode: 'delete',
            generations: [],
          };
    writeKeyringJournal(keyring, account, restoredJournal);
    rawJournal = encodeKeyringJournal(restoredJournal);
  }
  let journal = parseKeyringChunkJournal(rawJournal);
  if (
    managedState?.mode !== 'managed' ||
    managedState.journal === null ||
    encodeKeyringJournal(managedState.journal) !== rawJournal
  ) {
    try {
      persistKeyringManagedState(keyring, account, { mode: 'managed', journal });
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }
  const accountEntry = new keyring.Entry(KEYRING_SERVICE, account);

  if (journal.mode === 'deleted') {
    let currentValue: string | null;
    let currentMarker: KeyringChunkMarker | null = null;
    let unverifiable = false;
    try {
      currentValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
      currentMarker = parseKeyringChunkMarker(currentValue);
    } catch (err) {
      unverifiable = true;
      diag?.(classifyKeyringError(err));
    }
    const resumedJournal: KeyringChunkJournal = {
      mode: 'delete',
      generations: currentMarker ? [currentMarker] : [],
      blockLegacy: true,
      ...(unverifiable ? { unverifiable: true } : {}),
    };
    try {
      writeKeyringJournal(keyring, account, resumedJournal);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    journal = resumedJournal;
  }

  let activeMarker: KeyringChunkMarker | null = null;
  let activeShortDigest: string | null = null;
  if (journal.mode === 'delete') {
    let currentMarker: KeyringChunkMarker | null = null;
    let activeShortDigest = journal.shortDigest;
    let unverifiable = journal.unverifiable === true;
    let currentValue: string | null;
    try {
      currentValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    if (
      currentValue === null ||
      !activeShortDigest ||
      createHash('sha256').update(currentValue).digest('hex') !== activeShortDigest
    ) {
      activeShortDigest = undefined;
      try {
        currentMarker = parseKeyringChunkMarker(currentValue);
      } catch (err) {
        unverifiable = true;
        diag?.(classifyKeyringError(err));
      }
    }

    let preparedGenerations = journal.generations.map(marker => ({
      ...marker,
    }));
    if (currentMarker) appendUniqueKeyringMarker(preparedGenerations, currentMarker);
    if (
      !keyringDeleteJournalFits(
        preparedGenerations,
        unverifiable,
        journal.blockLegacy === true,
        activeShortDigest,
      )
    ) {
      const protectedMarker = currentMarker
        ? (preparedGenerations.find(marker => sameKeyringGeneration(currentMarker, marker)) ??
          currentMarker)
        : null;
      let compacted = true;
      for (const marker of journal.generations) {
        if (protectedMarker && sameKeyringGeneration(protectedMarker, marker)) {
          continue;
        }
        if (!removeKeyringChunks(keyring, KEYRING_SERVICE, account, marker, diag)) {
          compacted = false;
        }
      }
      if (!compacted) return false;
      preparedGenerations = protectedMarker ? [protectedMarker] : [];
    }
    if (
      !keyringDeleteJournalFits(
        preparedGenerations,
        unverifiable,
        journal.blockLegacy === true,
        activeShortDigest,
      )
    ) {
      diag?.('keyring cleanup journal cannot represent the pending generations');
      return false;
    }
    const preparedJournal: KeyringChunkJournal = {
      mode: 'delete',
      generations: preparedGenerations,
      ...(activeShortDigest ? { shortDigest: activeShortDigest } : {}),
      ...(journal.blockLegacy ? { blockLegacy: true } : {}),
      ...(unverifiable ? { unverifiable: true } : {}),
    };
    if (encodeKeyringJournal(preparedJournal) !== rawJournal) {
      try {
        writeKeyringJournal(keyring, account, preparedJournal);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
    }
    journal = preparedJournal;
    try {
      if (
        !writeKeyringDeletionGuard(
          keyring,
          account,
          journal.blockLegacy === true ? 'deleted' : 'pending',
        )
      ) {
        diag?.('keyring deletion guard could not be verified');
        return false;
      }
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    try {
      if (!deleteKeyringEntry(keyring, KEYRING_SERVICE, account)) {
        diag?.('keyring credential deletion could not be verified');
        return false;
      }
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  } else if (journal.mode === 'write') {
    let activeValue: string | null;
    try {
      activeValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    if (activeValue === null) {
      if (journal.unpublished !== true) {
        diag?.('published credential state cannot be confirmed while cleanup metadata is active');
        return false;
      }
      if (journal.publicationAttempted === true) {
        const candidate = journal.generations[0];
        if (!candidate) return false;
        try {
          readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, candidate);
          const encodedCandidate = encodeKeyringChunkMarker(candidate);
          accountEntry.setPassword(encodedCandidate);
          if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== encodedCandidate) {
            throw new Error('keyring credential recovery verification failed');
          }
          activeMarker = candidate;
        } catch (err) {
          diag?.(classifyKeyringError(err));
          return false;
        }
      }
    } else if (
      journal.fallbackShortDigest &&
      createHash('sha256').update(activeValue).digest('hex') === journal.fallbackShortDigest
    ) {
      activeShortDigest = journal.fallbackShortDigest;
    } else {
      try {
        activeMarker = parseKeyringChunkMarker(activeValue);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
      if (!activeMarker) {
        diag?.('published credential kind is not represented by cleanup journal');
        return false;
      }
    }

    const activeJournalMarker = activeMarker
      ? journal.generations.find(marker => sameKeyringGeneration(activeMarker, marker))
      : undefined;
    if (activeMarker && !activeJournalMarker) {
      throw new Error('published credential generation is not represented by cleanup journal');
    }
    if (activeMarker && activeJournalMarker) {
      try {
        readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, activeMarker);
        if (
          activeJournalMarker.count > activeMarker.count &&
          !removeKeyringChunkRange(
            keyring,
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
          ...(!sameKeyringMarker(activeMarker, activeJournalMarker) ? [activeJournalMarker] : []),
          ...journal.generations.filter(marker => !sameKeyringGeneration(activeMarker, marker)),
        ];
        let recovered = false;
        for (const candidate of recoveryCandidates) {
          try {
            readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, candidate);
            if (
              activeMarker.count > activeJournalMarker.count &&
              !removeKeyringChunkRange(
                keyring,
                KEYRING_SERVICE,
                account,
                activeMarker,
                activeJournalMarker.count,
                diag,
              )
            ) {
              return false;
            }
            const encodedCandidate = encodeKeyringChunkMarker(candidate);
            accountEntry.setPassword(encodedCandidate);
            if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== encodedCandidate) {
              throw new Error('keyring credential recovery verification failed');
            }
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
  } else {
    let activeValue: string | null;
    try {
      activeValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    if (activeValue === null) {
      if (journal.unpublished !== true) {
        diag?.('published credential state cannot be confirmed while cleanup metadata is active');
        return false;
      }
      if (journal.publicationAttempted === true) return false;
    } else {
      const observedDigest = createHash('sha256').update(activeValue).digest('hex');
      if (observedDigest === journal.shortDigest) {
        activeShortDigest = observedDigest;
      } else if (observedDigest === journal.fallbackShortDigest) {
        activeShortDigest = observedDigest;
      } else {
        try {
          activeMarker = parseKeyringChunkMarker(activeValue);
        } catch (err) {
          diag?.(classifyKeyringError(err));
          return false;
        }
        if (
          !activeMarker ||
          !journal.generations.some(marker => sameKeyringGeneration(activeMarker, marker))
        ) {
          diag?.('published credential kind is not represented by cleanup journal');
          return false;
        }
        try {
          readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, activeMarker);
        } catch (err) {
          diag?.(classifyKeyringError(err));
          return false;
        }
      }
    }
  }

  let cleaned = true;
  for (const marker of journal.generations) {
    if (
      (journal.mode === 'write' || journal.mode === 'short') &&
      sameKeyringGeneration(activeMarker, marker)
    )
      continue;
    if (!removeKeyringChunks(keyring, KEYRING_SERVICE, account, marker, diag)) {
      cleaned = false;
    }
  }
  if (!cleaned) return false;
  if (journal.unverifiable === true) {
    if (!verifyEmptyKeyringCredentialInventory(keyring, account, diag)) {
      return false;
    }
    const verifiedDelete: KeyringChunkJournal = {
      mode: 'delete',
      generations: [],
      ...(journal.blockLegacy ? { blockLegacy: true } : {}),
    };
    try {
      writeKeyringJournal(keyring, account, verifiedDelete);
      journal = verifiedDelete;
      diag?.('retired unverifiable credential metadata after verifying an empty keyring');
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }

  if (journal.mode === 'delete' && journal.blockLegacy === true) {
    try {
      writeKeyringJournal(keyring, account, {
        mode: 'deleted',
        generations: [],
      });
      return true;
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }

  if (journal.mode === 'delete') {
    try {
      if (!deleteKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account)) {
        diag?.('keyring cleanup journal could not be removed');
        return false;
      }
      if (!clearKeyringDeletionGuard(keyring, account)) {
        diag?.('keyring deletion guard could not be removed');
        return false;
      }
      removeKeyringManagedState(account);
      if (!deleteKeyringEntry(keyring, KEYRING_MANAGED_STATE_KEY_SERVICE, account)) {
        diag?.('keyring managed-state encryption key could not be removed');
        return false;
      }
      return true;
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }

  if (activeShortDigest) {
    const activeInventory: KeyringChunkJournal = {
      mode: 'short',
      generations: [],
      shortDigest: activeShortDigest,
    };
    if (encodeKeyringJournal(activeInventory) !== rawJournal) {
      try {
        writeKeyringJournal(keyring, account, activeInventory);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
    }
    return true;
  }

  if (activeMarker) {
    const activeInventory: KeyringChunkJournal = {
      mode: 'write',
      generations: [{ ...activeMarker }],
    };
    if (encodeKeyringJournal(activeInventory) !== rawJournal) {
      try {
        writeKeyringJournal(keyring, account, activeInventory);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
    }
    return true;
  }

  try {
    if (!writeKeyringDeletionGuard(keyring, account, 'deleted')) {
      diag?.('keyring deletion guard could not be verified');
      return false;
    }
    writeKeyringJournal(keyring, account, {
      mode: 'deleted',
      generations: [],
    });
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
}

const KEYRING_PREPARING_STATE_PREFIX = 'v2:preparing:';
const KEYRING_MANAGED_STATE_PREFIX = 'v2:managed:';
const KEYRING_EMPTY_MANAGED_STATE_VALUE = 'v1:managed\n';
type KeyringManagedState =
  | { mode: 'preparing'; journal: KeyringChunkJournal }
  | { mode: 'managed'; journal: KeyringChunkJournal | null };

class KeyringManagedStateKeyUnavailableError extends Error {
  constructor() {
    super('keyring managed-state encryption key is unavailable');
    this.name = 'KeyringManagedStateKeyUnavailableError';
  }
}

function keyringAccountIdentity(account: string): string {
  return createHash('sha256').update(account).digest('hex');
}

function keyringManagedStatePath(account: string): string {
  return join(getCredentialStateRoot(), `${keyringAccountIdentity(account)}.managed`);
}

function parseKeyringManagedStateKey(value: string): Buffer {
  if (!value.startsWith(KEYRING_MANAGED_STATE_KEY_PREFIX)) {
    throw new KeyringManagedStateKeyUnavailableError();
  }
  const encoded = value.slice(KEYRING_MANAGED_STATE_KEY_PREFIX.length);
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) {
    throw new KeyringManagedStateKeyUnavailableError();
  }
  return key;
}

function readKeyringManagedStateKey(keyring: KeyringApi, account: string): Buffer | null {
  const value = readKeyringEntry(keyring, KEYRING_MANAGED_STATE_KEY_SERVICE, account);
  return value === null ? null : parseKeyringManagedStateKey(value);
}

function ensureKeyringManagedStateKey(keyring: KeyringApi, account: string): Buffer {
  let current: Buffer | null;
  try {
    current = readKeyringManagedStateKey(keyring, account);
  } catch (err) {
    if (!(err instanceof KeyringManagedStateKeyUnavailableError)) throw err;
    current = null;
  }
  if (current !== null) return current;
  const key = randomBytes(32);
  const encoded = `${KEYRING_MANAGED_STATE_KEY_PREFIX}${key.toString('base64url')}`;
  const entry = new keyring.Entry(KEYRING_MANAGED_STATE_KEY_SERVICE, account);
  entry.setPassword(encoded);
  if (readKeyringEntry(keyring, KEYRING_MANAGED_STATE_KEY_SERVICE, account) !== encoded) {
    throw new Error('keyring managed-state encryption key verification failed');
  }
  return key;
}

function keyringManagedStateAad(account: string, mode: KeyringManagedState['mode']): Buffer {
  return Buffer.from(`clodex-managed-state:v2:${mode}:${account}`, 'utf8');
}

function decryptKeyringManagedState(
  key: Buffer,
  account: string,
  mode: KeyringManagedState['mode'],
  encoded: string,
): KeyringChunkJournal {
  const payload = Buffer.from(encoded, 'base64url');
  if (payload.toString('base64url') !== encoded || payload.length <= 28) {
    throw new Error('keyring managed-state marker is invalid');
  }
  const nonce = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(keyringManagedStateAad(account, mode));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return parseKeyringChunkJournal(plaintext);
}

function readKeyringManagedState(
  keyring: KeyringApi,
  account: string,
): KeyringManagedState | null {
  try {
    const value = readFileSync(keyringManagedStatePath(account), 'utf8');
    if (value === KEYRING_EMPTY_MANAGED_STATE_VALUE) {
      return { mode: 'managed', journal: null };
    }
    const statePrefix = value.startsWith(KEYRING_PREPARING_STATE_PREFIX)
      ? KEYRING_PREPARING_STATE_PREFIX
      : value.startsWith(KEYRING_MANAGED_STATE_PREFIX)
        ? KEYRING_MANAGED_STATE_PREFIX
        : null;
    if (statePrefix && value.endsWith('\n')) {
      try {
        const mode = statePrefix === KEYRING_PREPARING_STATE_PREFIX ? 'preparing' : 'managed';
        const key = readKeyringManagedStateKey(keyring, account);
        if (key === null) {
          throw new KeyringManagedStateKeyUnavailableError();
        }
        const journal = decryptKeyringManagedState(
          key,
          account,
          mode,
          value.slice(statePrefix.length, -1),
        );
        return mode === 'preparing'
          ? { mode: 'preparing', journal }
          : { mode: 'managed', journal };
      } catch (err) {
        if (err instanceof KeyringManagedStateKeyUnavailableError) throw err;
        throw new Error('keyring managed-state marker is invalid');
      }
    }
    throw new Error('keyring managed-state marker is invalid');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function sameKeyringManagedState(
  left: KeyringManagedState,
  right: KeyringManagedState,
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.journal === null || right.journal === null) {
    return left.journal === right.journal;
  }
  return encodeKeyringJournal(left.journal) === encodeKeyringJournal(right.journal);
}

function encodeKeyringManagedState(
  keyring: KeyringApi,
  account: string,
  state: KeyringManagedState,
): string {
  if (state.mode === 'managed' && state.journal === null) {
    return KEYRING_EMPTY_MANAGED_STATE_VALUE;
  }
  const journal = state.journal;
  if (journal === null) return KEYRING_EMPTY_MANAGED_STATE_VALUE;
  const key = ensureKeyringManagedStateKey(keyring, account);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(keyringManagedStateAad(account, state.mode));
  const ciphertext = Buffer.concat([
    cipher.update(encodeKeyringJournal(journal), 'utf8'),
    cipher.final(),
  ]);
  const payload = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  const prefix =
    state.mode === 'preparing' ? KEYRING_PREPARING_STATE_PREFIX : KEYRING_MANAGED_STATE_PREFIX;
  return `${prefix}${payload}\n`;
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') {
      throw err;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function persistKeyringManagedState(
  keyring: KeyringApi,
  account: string,
  state: KeyringManagedState,
): void {
  const currentState = readKeyringManagedState(keyring, account);
  if (currentState !== null && sameKeyringManagedState(currentState, state)) return;
  const encodedState = encodeKeyringManagedState(keyring, account, state);
  const path = keyringManagedStatePath(account);
  const directory = getCredentialStateRoot();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, encodedState, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      renameSync(tempPath, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') {
        throw err;
      }
      unlinkSync(path);
      renameSync(tempPath, path);
    }
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

function removeKeyringManagedState(account: string): void {
  const path = keyringManagedStatePath(account);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  syncDirectory(getCredentialStateRoot());
}

function keyringAccountLockPath(account: string): string {
  return getCredentialMutationLockPath(`keyring:${account}`);
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

async function readKeyringAccount(
  account: string,
  diag?: (msg: string) => void,
): Promise<string | null> {
  return withKeyringAccountLock(account, null, diag, async () => {
    try {
      const keyring = await import('@napi-rs/keyring');
      const cleanupComplete = reconcileKeyringJournal(keyring, account, diag);
      const finalJournalRaw = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
      const finalJournal =
        finalJournalRaw === null ? null : parseKeyringChunkJournal(finalJournalRaw);
      if (finalJournal?.mode === 'delete' || finalJournal?.mode === 'deleted') return null;
      if (
        finalJournalRaw === null &&
        readKeyringManagedState(keyring, account)?.mode === 'managed'
      ) {
        return null;
      }
      if (finalJournal?.mode === 'short') {
        const value = readKeyringEntry(keyring, KEYRING_SERVICE, account);
        if (
          value === null ||
          createHash('sha256').update(value).digest('hex') !== finalJournal.shortDigest
        )
          return null;
        return value;
      }
      if (finalJournal?.mode === 'write') {
        return readKeyringAccountFromService(keyring, KEYRING_SERVICE, account);
      }
      if (!cleanupComplete) return null;

      const rawValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
      if (rawValue === null) return null;
      const marker = parseKeyringChunkMarker(rawValue);
      if (marker) {
        const value = readKeyringAccountFromService(keyring, KEYRING_SERVICE, account);
        adoptKeyringJournal(
          keyring,
          account,
          {
            mode: 'write',
            generations: [marker],
          },
          diag,
        );
        return value;
      }
      adoptKeyringJournal(
        keyring,
        account,
        {
          mode: 'short',
          generations: [],
          shortDigest: createHash('sha256').update(rawValue).digest('hex'),
        },
        diag,
      );
      return rawValue;
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return null;
    }
  });
}

function persistUnverifiableKeyringDeletion(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
  blockLegacy = false,
): boolean {
  try {
    writeKeyringJournal(keyring, account, {
      mode: 'delete',
      generations: [],
      ...(blockLegacy ? { blockLegacy: true } : {}),
      unverifiable: true,
    });
    diag?.('unverifiable credential state was marked for verified deletion');
    return true;
  } catch {
    diag?.('unverifiable credential state could not be marked for deletion');
    return false;
  }
}

function recoverEmptyPublishedKeyringState(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  const rawJournal = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
  if (rawJournal === null) return false;
  const journal = parseKeyringChunkJournal(rawJournal);
  if (
    (journal.mode !== 'write' && journal.mode !== 'short') ||
    journal.unpublished === true ||
    readKeyringEntry(keyring, KEYRING_SERVICE, account) !== null
  ) {
    return false;
  }
  if (!verifyEmptyKeyringCredentialInventory(keyring, account, diag)) {
    return false;
  }
  if (!writeKeyringDeletionGuard(keyring, account, 'deleted')) {
    diag?.('keyring deletion guard could not be verified');
    return false;
  }
  writeKeyringJournal(keyring, account, {
    mode: 'deleted',
    generations: [],
  });
  diag?.('discarded missing published credential metadata after verifying an empty keyring');
  return true;
}

function recoverEmptyOpaqueManagedKeyringState(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== null) {
    return false;
  }
  if (!verifyEmptyKeyringCredentialInventory(keyring, account, diag)) {
    return false;
  }
  if (!writeKeyringDeletionGuard(keyring, account, 'deleted')) {
    diag?.('keyring deletion guard could not be verified');
    return false;
  }
  removeKeyringManagedState(account);
  writeKeyringJournal(keyring, account, {
    mode: 'deleted',
    generations: [],
  });
  diag?.('recovered managed credential metadata after verifying an empty keyring');
  return true;
}

function retireUnreadableManagedStateForDeletion(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  try {
    readKeyringManagedState(keyring, account);
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    if (!(err instanceof KeyringManagedStateKeyUnavailableError)) {
      return false;
    }
  }
  try {
    removeKeyringManagedState(account);
    diag?.('retired unreadable managed credential metadata for explicit deletion');
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
}

function writeKeyringAccountLocked(
  keyring: KeyringApi,
  account: string,
  key: string,
  intent: 'probe' | 'provision' | 'replace',
  diag?: (msg: string) => void,
): boolean {
  try {
    let reconciled: boolean;
    let deletedMarkerActive = false;
    try {
      const deletionGuard = readKeyringDeletionGuard(keyring, account);
      const rawJournal = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
      const initialJournal = rawJournal === null ? null : parseKeyringChunkJournal(rawJournal);
      deletedMarkerActive = deletionGuard !== null || initialJournal?.mode === 'deleted';
      if (
        initialJournal?.mode === 'short' &&
        initialJournal.unpublished === true &&
        initialJournal.publicationAttempted === true
      ) {
        if (deletedMarkerActive) {
          if (!clearKeyringDeletionGuard(keyring, account)) {
            throw new Error('keyring deletion guard could not be cleared');
          }
          deletedMarkerActive = false;
        }
        const shortDigest = createHash('sha256').update(key).digest('hex');
        if (shortDigest !== initialJournal.shortDigest) {
          writeKeyringJournal(keyring, account, {
            ...initialJournal,
            shortDigest,
          });
        }
        const accountEntry = new keyring.Entry(KEYRING_SERVICE, account);
        accountEntry.setPassword(key);
        if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== key) {
          throw new Error('keyring credential write verification failed');
        }
        if (!reconcileKeyringJournal(keyring, account, diag)) return false;
        return true;
      }
      reconciled = reconcileKeyringJournal(keyring, account, diag);
      if (
        !reconciled &&
        intent !== 'probe' &&
        recoverEmptyPublishedKeyringState(keyring, account, diag)
      ) {
        reconciled = reconcileKeyringJournal(keyring, account, diag);
      }
    } catch (err) {
      diag?.(classifyKeyringError(err));
      if (
        err instanceof KeyringManagedStateKeyUnavailableError &&
        intent !== 'probe' &&
        recoverEmptyOpaqueManagedKeyringState(keyring, account, diag)
      ) {
        reconciled = reconcileKeyringJournal(keyring, account, diag);
      } else {
        return false;
      }
    }
    if (!reconciled) return false;

    const activeJournalRaw = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
    const activeJournal =
      activeJournalRaw === null ? null : parseKeyringChunkJournal(activeJournalRaw);
    const managedState = readKeyringManagedState(keyring, account);
    deletedMarkerActive =
      deletedMarkerActive ||
      activeJournal?.mode === 'deleted' ||
      readKeyringDeletionGuard(keyring, account) !== null;

    const accountEntry = new keyring.Entry(KEYRING_SERVICE, account);
    const previousValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    if (intent === 'probe') {
      if (
        !isDisposableCredentialProbeAccount(account) ||
        activeJournal !== null ||
        managedState !== null ||
        deletedMarkerActive ||
        previousValue !== null ||
        hasUnjournaledKeyringChunks(keyring, account)
      ) {
        diag?.('credential account is not available for a new credential');
        return false;
      }
    } else if (intent === 'provision') {
      if (!isCredentialAccountInstance(account)) {
        diag?.('provisioned credentials require a versioned account instance');
        return false;
      }
    } else if (activeJournal === null && managedState === null && previousValue === null) {
      diag?.('existing credential state could not be confirmed');
      return false;
    }
    if (deletedMarkerActive) {
      if (!clearKeyringDeletionGuard(keyring, account)) {
        throw new Error('keyring deletion guard could not be cleared');
      }
      deletedMarkerActive = false;
    }
    let previousMarker =
      activeJournal?.mode === 'write' ? (activeJournal.generations[0] ?? null) : null;
    let previousShortDigest =
      activeJournal?.mode === 'short' ? activeJournal.shortDigest : undefined;
    try {
      if (activeJournal?.mode === 'short') {
        if (
          previousValue !== null &&
          createHash('sha256').update(previousValue).digest('hex') !== previousShortDigest
        ) {
          throw new Error('published short credential changed after reconciliation');
        }
      } else if (activeJournal?.mode === 'write') {
        if (previousValue !== null) {
          const observedMarker = parseKeyringChunkMarker(previousValue);
          if (
            !observedMarker ||
            !previousMarker ||
            !sameKeyringMarker(observedMarker, previousMarker)
          ) {
            throw new Error('published chunk credential changed after reconciliation');
          }
        }
      } else if (activeJournal === null) {
        previousMarker = parseKeyringChunkMarker(previousValue);
        if (previousMarker) {
          try {
            readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, previousMarker);
          } catch {
            previousMarker = null;
          }
        }
        if (previousValue !== null && !previousMarker) {
          previousShortDigest = createHash('sha256').update(previousValue).digest('hex');
        }
      }
    } catch (err) {
      diag?.(classifyKeyringError(err));
      persistUnverifiableKeyringDeletion(keyring, account, diag);
      return false;
    }
    const unpublished =
      activeJournal?.mode !== 'write' && activeJournal?.mode !== 'short' && previousValue === null;
    if (key.length <= KEYRING_CHUNK_SIZE) {
      const shortDigest = createHash('sha256').update(key).digest('hex');
      const transitionJournal: KeyringChunkJournal = {
        mode: 'short',
        generations: previousMarker ? [previousMarker] : [],
        shortDigest,
        ...(previousShortDigest ? { fallbackShortDigest: previousShortDigest } : {}),
        ...(unpublished ? { unpublished: true } : {}),
      };
      writeKeyringJournal(keyring, account, transitionJournal);
      accountEntry.setPassword(key);
      if (unpublished) {
        writeKeyringJournal(keyring, account, {
          ...transitionJournal,
          publicationAttempted: true,
        });
      }
      if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== key) {
        throw new Error('keyring credential write verification failed');
      }
      if (!reconcileKeyringJournal(keyring, account, diag)) {
        diag?.('keyring cleanup is pending and will be retried');
      }
      return true;
    }
    const chunks = splitKeyringCredential(key);
    const chunkCount = chunks.length;
    if (chunkCount > KEYRING_MAX_CHUNKS) {
      throw new Error('keyring credential exceeds the supported chunk count');
    }
    const marker: KeyringChunkMarker = {
      count: chunkCount,
      generation: randomUUID(),
      digest: createHash('sha256').update(key).digest('hex'),
    };
    const transitionJournal: KeyringChunkJournal = {
      mode: 'write',
      generations: [marker, ...(previousMarker ? [previousMarker] : [])],
      ...(previousShortDigest ? { fallbackShortDigest: previousShortDigest } : {}),
      ...(unpublished ? { unpublished: true } : {}),
    };
    writeKeyringJournal(keyring, account, transitionJournal);
    for (const [i, chunk] of chunks.entries()) {
      new keyring.Entry(KEYRING_CHUNK_SERVICE, keyringChunkAccount(account, marker, i)).setPassword(
        chunk,
      );
    }
    const encodedMarker = encodeKeyringChunkMarker(marker);
    accountEntry.setPassword(encodedMarker);
    if (unpublished) {
      writeKeyringJournal(keyring, account, {
        ...transitionJournal,
        publicationAttempted: true,
      });
    }
    if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== encodedMarker) {
      throw new Error('keyring credential write verification failed');
    }
    if (!reconcileKeyringJournal(keyring, account, diag)) {
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
  intent: 'probe' | 'provision' | 'replace',
  diag?: (msg: string) => void,
): Promise<boolean> {
  return withKeyringAccountLock(account, false, diag, async () => {
    try {
      const keyring = await import('@napi-rs/keyring');
      return writeKeyringAccountLocked(keyring, account, key, intent, diag);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  });
}

function deleteJournalLessManagedKeyringAccount(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
  retireUnreadableManagedState = false,
): boolean {
  const sentinels: KeyringEnumerationSentinel[] = [];
  let sentinelsRemoved = false;
  try {
    for (const service of [KEYRING_SERVICE, KEYRING_CHUNK_SERVICE]) {
      const sentinel = createKeyringEnumerationSentinel(service, account);
      sentinels.push(sentinel);
      writeKeyringEnumerationSentinel(keyring, sentinel);
    }
    const currentValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    parseKeyringChunkMarker(currentValue);
    // The keyring binding returns a complete service snapshot or an error. Sentinels detect
    // backends that make this account namespace temporarily invisible without throwing.
    const inventory = listUnjournaledKeyringChunks(keyring, account);
    if (
      sentinels.some(
        sentinel => !inventory.some(entry => sameKeyringEnumerationEntry(entry, sentinel)),
      )
    ) {
      diag?.('keyring credential chunk inventory could not be verified');
      return false;
    }
    const chunks = inventory.filter(
      entry => !sentinels.some(sentinel => sameKeyringEnumerationEntry(entry, sentinel)),
    );
    if (!writeKeyringDeletionGuard(keyring, account, 'deleted')) {
      diag?.('keyring deletion guard could not be verified');
      return false;
    }
    if (!deleteKeyringEntry(keyring, KEYRING_SERVICE, account)) {
      diag?.('keyring credential deletion could not be verified');
      return false;
    }
    for (const chunk of chunks) {
      if (!deleteKeyringEntry(keyring, chunk.service, chunk.account)) {
        diag?.('keyring credential chunk deletion could not be verified');
        return false;
      }
    }
    const remainingInventory = listUnjournaledKeyringChunks(keyring, account);
    if (
      sentinels.some(
        sentinel =>
          !remainingInventory.some(entry => sameKeyringEnumerationEntry(entry, sentinel)),
      ) ||
      remainingInventory.some(
        entry => !sentinels.some(sentinel => sameKeyringEnumerationEntry(entry, sentinel)),
      )
    ) {
      diag?.('keyring credential chunk deletion could not be verified');
      return false;
    }
    for (const sentinel of sentinels) {
      if (!removeKeyringEnumerationSentinel(keyring, sentinel)) {
        diag?.('keyring credential inventory sentinel could not be removed');
        return false;
      }
    }
    sentinelsRemoved = true;
    if (retireUnreadableManagedState) {
      removeKeyringManagedState(account);
      diag?.('retired unreadable managed credential metadata for explicit deletion');
    }
    writeKeyringJournal(keyring, account, {
      mode: 'deleted',
      generations: [],
    });
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  } finally {
    if (!sentinelsRemoved) {
      for (const sentinel of sentinels) {
        try {
          if (!removeKeyringEnumerationSentinel(keyring, sentinel)) {
            diag?.('keyring credential inventory sentinel could not be removed');
          }
        } catch (err) {
          diag?.(classifyKeyringError(err));
        }
      }
    }
  }
}

async function deleteKeyringAccount(
  account: string,
  diag?: (msg: string) => void,
  blockLegacy = true,
): Promise<boolean> {
  return withKeyringAccountLock(account, false, diag, async () => {
    try {
      const keyring = await import('@napi-rs/keyring');
      let pendingJournalRaw = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
      if (pendingJournalRaw === null) {
        let managedState: KeyringManagedState | null;
        try {
          managedState = readKeyringManagedState(keyring, account);
        } catch (err) {
          diag?.(classifyKeyringError(err));
          if (err instanceof KeyringManagedStateKeyUnavailableError) {
            if (recoverEmptyOpaqueManagedKeyringState(keyring, account, diag)) {
              return true;
            }
            return deleteJournalLessManagedKeyringAccount(keyring, account, diag, true);
          }
          return false;
        }
        if (managedState !== null) {
          if (managedState.journal === null) {
            return deleteJournalLessManagedKeyringAccount(keyring, account, diag);
          } else {
            writeKeyringJournal(keyring, account, managedState.journal);
            pendingJournalRaw = encodeKeyringJournal(managedState.journal);
            diag?.('restored keyring cleanup journal from managed state');
          }
        } else if (readKeyringDeletionGuard(keyring, account) !== null) {
          return reconcileKeyringJournal(keyring, account, diag);
        }
      }
      let pendingJournal: KeyringChunkJournal | null = null;
      try {
        if (pendingJournalRaw !== null) {
          pendingJournal = parseKeyringChunkJournal(pendingJournalRaw);
          if (!retireUnreadableManagedStateForDeletion(keyring, account, diag)) {
            return false;
          }
          if (pendingJournal.mode === 'deleted') {
            return reconcileKeyringJournal(keyring, account, diag);
          }
          if (pendingJournal.mode === 'delete') {
            if (blockLegacy && pendingJournal.blockLegacy !== true) {
              pendingJournal = {
                ...pendingJournal,
                blockLegacy: true,
              };
              writeKeyringJournal(keyring, account, pendingJournal);
            }
            return reconcileKeyringJournal(keyring, account, diag);
          }
        }
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
      const value = readKeyringEntry(keyring, KEYRING_SERVICE, account);
      if (pendingJournal === null && value === null) {
        throw new Error('existing credential state could not be confirmed');
      }
      const generations: KeyringChunkMarker[] = [];
      for (const marker of pendingJournal?.generations ?? []) {
        appendUniqueKeyringMarker(generations, marker);
      }
      let unverifiable = false;
      const shortDigest = pendingJournal?.mode === 'short' ? pendingJournal.shortDigest : undefined;
      if (pendingJournal?.mode !== 'short') {
        try {
          const marker = parseKeyringChunkMarker(value);
          if (marker) appendUniqueKeyringMarker(generations, marker);
        } catch (err) {
          unverifiable = true;
          diag?.(classifyKeyringError(err));
        }
      }
      if (!keyringDeleteJournalFits(generations, unverifiable, blockLegacy, shortDigest)) {
        diag?.('keyring cleanup has too many pending generations');
        return false;
      }
      writeKeyringJournal(keyring, account, {
        mode: 'delete',
        generations,
        ...(shortDigest ? { shortDigest } : {}),
        ...(blockLegacy ? { blockLegacy: true } : {}),
        ...(unverifiable ? { unverifiable: true } : {}),
      });
      return reconcileKeyringJournal(keyring, account, diag);
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
  intent: 'probe' | 'provision' | 'replace',
  diag?: (msg: string) => void,
): Promise<boolean> {
  if (ref.kind === 'keyring') {
    return writeKeyringAccount(ref.account, value, intent, diag);
  }
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
  blockLegacy = true,
): Promise<boolean> {
  if (ref.kind === 'keyring') {
    return deleteKeyringAccount(ref.account, diag, blockLegacy);
  }
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

async function persistProviderCredential(
  authRef: string,
  key: string,
  intent: 'provision' | 'replace',
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind === 'env' || parsed.kind === 'none') return false;
  if (intent === 'provision' && !isCredentialAccountInstance(parsed.account)) {
    diag?.('provisioned credentials require a versioned account instance');
    return false;
  }
  return withCredentialMutationLock(authRef, async () => {
    const cacheKey = storedCredentialAuthRef(parsed);
    clearOAuthCredentialCache(cacheKey);
    const written = await writeStoredCredential(parsed, key, intent, diag);
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

/** Create or resume a credential at its provider-owned account reference. */
export async function provisionProviderCredential(
  authRef: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  return persistProviderCredential(authRef, key, 'provision', diag);
}

/** Replace a credential whose prior state can be confirmed. */
export async function saveProviderCredential(
  authRef: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  return persistProviderCredential(authRef, key, 'replace', diag);
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
    const written = await writeStoredCredential(probeRef, value, 'probe', diag);
    if (!written) return false;
    const readBack = await readStoredCredential(probeRef, diag);
    if (readBack !== value) {
      diag?.('credential store probe read-back verification failed');
      return false;
    }
    verified = true;
  } finally {
    const deleted = await deleteStoredCredential(probeRef, diag, false);
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
