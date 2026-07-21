// src/env.ts
import { CONFLICTING_ENV_VARS } from './constants.js';
import { createHash, randomUUID } from 'node:crypto';
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
import { withCredentialMutationLock } from './registry/lock.js';
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
/** One-time silent migration source: credentials stored by relay-ai. */
const LEGACY_KEYRING_SERVICE = 'relay-ai';
// Windows Credential Manager caps a single credential blob at 2560 bytes (CredWriteW).
// keyring-rs encodes the password as UTF-16 (2 bytes/char) before that check, so the
// usable limit is 2560 / 2 = 1280 chars — long OAuth tokens (e.g. OpenAI's JWTs) exceed
// this, so secrets above the threshold are split across multiple keyring entries.
// Harmless on macOS/Linux, which have no such limit.
const KEYRING_CHUNK_PREFIX = '__relay_chunked__:';
const KEYRING_CHUNK_SIZE = 1200;

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
const oauthCredentialCache = new Map<string, StoredOAuthCredential>();
const rejectedEnvCredentialFingerprints = new Map<string, string>();
const OAUTH_REFRESH_LOCK_WAIT_MS = 150_000;

export type ParsedAuthRef =
  | { kind: 'keyring'; account: string }
  | { kind: 'helper'; helperId: string; account: string }
  | { kind: 'env'; varName: string }
  | { kind: 'none' };

export interface ResolveCredentialOptions {
  rejectedAccessToken?: string;
}

/** Parse registry credential references. */
export function parseAuthRef(authRef: string): ParsedAuthRef | null {
  if (authRef === 'none:anonymous') return { kind: 'none' };
  if (authRef.startsWith('keyring:')) {
    const account = authRef.slice('keyring:'.length);
    return account ? { kind: 'keyring', account } : null;
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
): string | null {
  const value = new Entry(service, account).getPassword() ?? null;
  if (!value?.startsWith(KEYRING_CHUNK_PREFIX)) return value;
  const chunkCount = Number(value.slice(KEYRING_CHUNK_PREFIX.length));
  let combined = '';
  for (let i = 0; i < chunkCount; i++) {
    combined += new Entry(service, `${account}::chunk::${i}`).getPassword() ?? '';
  }
  return combined;
}

async function readKeyringAccount(account: string, diag?: (msg: string) => void): Promise<string | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    const value = readKeyringAccountFromService(Entry, KEYRING_SERVICE, account);
    if (value !== null) return value;
    // One-time silent migration: fall back to the relay-ai keychain service and
    // copy the credential into the clodex service on first read.
    let legacy: string | null = null;
    try {
      legacy = readKeyringAccountFromService(Entry, LEGACY_KEYRING_SERVICE, account);
    } catch {
      legacy = null;
    }
    if (legacy !== null) {
      await writeKeyringAccount(account, legacy, diag);
    }
    return legacy;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return null;
  }
}

async function writeKeyringAccount(
  account: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    if (key.length <= KEYRING_CHUNK_SIZE) {
      new Entry(KEYRING_SERVICE, account).setPassword(key);
      return true;
    }
    const chunkCount = Math.ceil(key.length / KEYRING_CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i++) {
      const chunk = key.slice(i * KEYRING_CHUNK_SIZE, (i + 1) * KEYRING_CHUNK_SIZE);
      new Entry(KEYRING_SERVICE, `${account}::chunk::${i}`).setPassword(chunk);
    }
    new Entry(KEYRING_SERVICE, account).setPassword(`${KEYRING_CHUNK_PREFIX}${chunkCount}`);
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
}

async function deleteKeyringAccount(account: string, diag?: (msg: string) => void): Promise<boolean> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    const value = new Entry(KEYRING_SERVICE, account).getPassword();
    if (value === null) return true;
    if (value?.startsWith(KEYRING_CHUNK_PREFIX)) {
      const chunkCount = Number(value.slice(KEYRING_CHUNK_PREFIX.length));
      for (let i = 0; i < chunkCount; i++) {
        new Entry(KEYRING_SERVICE, `${account}::chunk::${i}`).deletePassword();
      }
    }
    new Entry(KEYRING_SERVICE, account).deletePassword();
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
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
      `env:${parsed.varName}`,
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

function decodeProviderSecret(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  const oauth = parseStoredOAuthCredential(trimmed);
  if (oauth) return oauth.access;
  try {
    const parsed = JSON.parse(trimmed) as { type?: string; token?: string };
    if (parsed.type === 'wellknown') {
      return typeof parsed.token === 'string' && parsed.token.trim()
        ? parsed.token.trim()
        : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function readOAuthProviderSecret(
  ref: StoredCredentialRef,
  providerId: string,
  diag?: (msg: string) => void,
  rejectedAccessToken?: string,
): Promise<string | null> {
  const inflightKey = storedCredentialAuthRef(ref);
  const cached = oauthCredentialCache.get(inflightKey);
  if (
    cached
    && cached.access !== rejectedAccessToken
    && cached.accessRejected !== true
    && !oauthCredentialShouldRefresh(cached, providerId)
  ) {
    return cached.access;
  }
  if (cached?.access === rejectedAccessToken) oauthCredentialCache.delete(inflightKey);

  const existing = oauthRefreshInflight.get(inflightKey);
  if (existing) {
    const resolved = await existing;
    if (resolved !== rejectedAccessToken) return resolved;
    return readOAuthProviderSecret(ref, providerId, diag, rejectedAccessToken);
  }

  const work = withCredentialMutationLock(inflightKey, async (): Promise<string | null> => {
    const latestCached = oauthCredentialCache.get(inflightKey);
    if (
      latestCached
      && latestCached.access !== rejectedAccessToken
      && latestCached.accessRejected !== true
      && !oauthCredentialShouldRefresh(latestCached, providerId)
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
      oauthCredentialCache.set(inflightKey, cred);

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
        oauthCredentialCache.delete(inflightKey);
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
        oauthCredentialCache.delete(inflightKey);
        continue;
      }

      const credentialToSave: StoredOAuthCredential = accessStillRejected
        ? { ...refreshed, accessRejected: true }
        : refreshed;
      const json = oauthCredentialToKeychainJson(credentialToSave);
      const saved = await saveProviderCredential(inflightKey, json, diag);
      if (!saved) {
        oauthCredentialCache.delete(inflightKey);
        throw new Error('Could not persist refreshed OAuth credential');
      }
      if (accessStillRejected) {
        oauthCredentialCache.delete(inflightKey);
        return null;
      }
      return refreshed.access;
    }
    throw new Error('OAuth credential changed repeatedly while refresh was in progress');
  }, {
    waitMs: OAUTH_REFRESH_LOCK_WAIT_MS,
  });

  oauthRefreshInflight.set(inflightKey, work);
  try {
    return await work;
  } finally {
    if (oauthRefreshInflight.get(inflightKey) === work) {
      oauthRefreshInflight.delete(inflightKey);
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
  const decoded = decodeProviderSecret(raw);
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
    oauthCredentialCache.delete(cacheKey);
    const written = await writeStoredCredential(parsed, key, diag);
    if (!written) return false;
    const readBack = await readStoredCredential(parsed, diag);
    if (readBack === key) {
      const oauth = parseStoredOAuthCredential(key);
      if (oauth) oauthCredentialCache.set(cacheKey, oauth);
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
    oauthCredentialCache.delete(storedCredentialAuthRef(parsed));
    return deleteStoredCredential(parsed, diag);
  });
}
