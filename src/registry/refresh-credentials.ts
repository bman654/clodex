// src/registry/refresh-credentials.ts — keys for refresh-models (OpenCode placeholders, env fallbacks)

import { isAnonymousProvider, projectSelectedOAuthAccount } from './materialize.js';
import {
  resolveProviderCredentialOverrideState,
  type ProviderCredentialOverrideState,
  type ResolvedProviderCredential,
} from '../env.js';
import { OAUTH_ACCOUNT_ENV } from '../oauth-account-selection.js';
import { getOAuthAccountSlot } from './oauth-account-storage.js';
import type { RegistryProvider } from './types.js';

export interface RefreshCredentialSnapshot {
  /** Provider generation and routing fields that this credential was resolved for. */
  provider: {
    id: string;
    addedAt: string;
    enabled: boolean;
    authType?: RegistryProvider['authType'];
    templateId: string;
    api: RegistryProvider['api'];
  };
  /** Effective credential reference used for this discovery request. */
  authRef: string;
  /** Stored selection at the moment credential resolution began. */
  activeAuthAccount?: string;
  /** Per-process override applied to this discovery request. */
  environmentAccount?: string;
  /** Winning named slot, including its generation even when authRef is stable. */
  selectedAccount?: {
    name: string;
    authRef: string;
    addedAt: string;
  };
  /** Redaction-safe identity of the namespaced provider key, when it wins. */
  credentialOverride?: ProviderCredentialOverrideState;
  /** The refresh deliberately resolved the persisted store, not CLODEX_KEY_*. */
  ignoreProviderOverride?: true;
}

export interface RefreshCredentialOptions {
  /** Resolve the persisted credential rather than a process-scoped CLODEX_KEY_* override. */
  ignoreProviderOverride?: boolean;
}

export function refreshCredentialSnapshot(
  provider: RegistryProvider,
  selected: string | null | undefined = process.env[OAUTH_ACCOUNT_ENV],
  options: RefreshCredentialOptions = {},
): RefreshCredentialSnapshot {
  const environmentAccount = selected === null
    ? undefined
    : selected?.trim().toLowerCase() || undefined;
  // Pass an explicit empty selector when the captured environment had none;
  // `undefined` would adopt a variable that changed after this snapshot.
  const effective = projectSelectedOAuthAccount(provider, environmentAccount ?? '');
  const activeAuthAccount = provider.activeAuthAccount?.trim() || undefined;
  const selectedName = environmentAccount || activeAuthAccount;
  const selectedAccount = provider.authType === 'oauth' && selectedName
    ? getOAuthAccountSlot(provider, selectedName)
    : undefined;
  const credentialOverride = effective.authType !== 'none'
    && effective.authRef !== 'none:anonymous'
    ? resolveProviderCredentialOverrideState(effective.id, process.env, {
        ignoreProviderOverride: options.ignoreProviderOverride,
      })
    : null;
  return {
    provider: {
      id: provider.id,
      addedAt: provider.addedAt,
      enabled: provider.enabled,
      authType: provider.authType,
      templateId: provider.templateId,
      api: {
        ...provider.api,
        ...(provider.api.headers ? { headers: { ...provider.api.headers } } : {}),
      },
    },
    authRef: effective.authRef,
    ...(activeAuthAccount ? { activeAuthAccount } : {}),
    ...(environmentAccount ? { environmentAccount } : {}),
    ...(selectedName && selectedAccount
      ? {
          selectedAccount: {
            name: selectedName,
            authRef: selectedAccount.authRef,
            addedAt: selectedAccount.addedAt,
          },
        }
      : {}),
    ...(credentialOverride ? { credentialOverride } : {}),
    ...(options.ignoreProviderOverride ? { ignoreProviderOverride: true as const } : {}),
  };
}

/** OpenCode uses these when OAuth/env supplies the real credential at runtime. */
const PLACEHOLDER_KEYS = new Set([
  'anything',
  'local',
  'ollama',
  'none',
  'n/a',
  'na',
  'placeholder',
  'test',
  'no-key',
]);

const ENV_FALLBACK_BY_PROVIDER: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};

export function isPlaceholderProviderKey(key: string | null | undefined): boolean {
  if (!key?.trim()) return true;
  return PLACEHOLDER_KEYS.has(key.trim().toLowerCase());
}

export function isLikelyPlaceholderKey(key: string | null | undefined): boolean {
  if (isPlaceholderProviderKey(key)) return true;
  const trimmed = key?.trim() ?? '';
  if (trimmed.length <= 2) return true;
  return false;
}

export function cachedModelCount(provider: RegistryProvider): number {
  return provider.modelsCache?.models.length ?? 0;
}

export function skipWithCachedModels(
  provider: RegistryProvider,
  reason: string,
): { id: string; name: string; ok: true; skipped: true; modelCount?: number; reason: string } {
  const count = cachedModelCount(provider);
  return {
    id: provider.id,
    name: provider.name,
    ok: true,
    skipped: true,
    modelCount: count > 0 ? count : undefined,
    reason,
  };
}

export type RefreshCredentialResolver = (
  provider: RegistryProvider,
) => Promise<string | null | ResolvedProviderCredential>;

/** Resolve the refresh credential together with its actual provider-override source. */
export async function resolveRefreshCredentialWithSource(
  provider: RegistryProvider,
  resolveKey: RefreshCredentialResolver,
  selected: string | null | undefined = process.env[OAUTH_ACCOUNT_ENV],
  options: RefreshCredentialOptions = {},
): Promise<ResolvedProviderCredential> {
  // Model entitlements are account-specific. Resolve exactly the provider
  // identity a launch in this process would use, never the registry's default
  // authRef merely because it is the field persisted at the top level.
  const effectiveProvider = projectSelectedOAuthAccount(provider, selected ?? '');
  if (
    isAnonymousProvider(effectiveProvider)
    || effectiveProvider.authType === 'none'
    || effectiveProvider.authRef === 'none:anonymous'
  ) return { credential: null };

  // OAuth token refresh (e.g. an expired/revoked refresh token returning 401) throws
  // rather than resolving to null. Treat that the same as "no key" so callers fall
  // through to refreshProviderModels' existing friendly "sign in again" messaging
  // instead of crashing the whole refresh with an unhandled exception.
  let resolved: ResolvedProviderCredential;
  try {
    const result = await resolveKey(effectiveProvider);
    resolved = typeof result === 'object' && result !== null
      ? result
      : {
          credential: result,
          // Backwards-compatible resolvers return only the key. Attribute the
          // current usable override for them; production resolvers return the
          // source atomically with the credential and close this race fully.
          ...(result
            ? {
                credentialOverride:
                  resolveProviderCredentialOverrideState(
                    effectiveProvider.id,
                    process.env,
                    { ignoreProviderOverride: options.ignoreProviderOverride },
                  ) ?? undefined,
              }
            : {}),
        };
  } catch {
    resolved = { credential: null };
  }
  // A namespaced provider key is an explicit runtime override, even if its
  // spelling resembles an OpenCode placeholder. Refresh must use the same
  // credential a launch will use rather than silently falling through.
  if (resolved.credentialOverride || !isLikelyPlaceholderKey(resolved.credential)) {
    return resolved;
  }

  for (const envVar of ENV_FALLBACK_BY_PROVIDER[effectiveProvider.id] ?? []) {
    const fromEnv = process.env[envVar]?.trim();
    if (fromEnv && !isLikelyPlaceholderKey(fromEnv)) return { credential: fromEnv };
  }
  return resolved;
}

export async function resolveRefreshCredential(
  provider: RegistryProvider,
  resolveKey: RefreshCredentialResolver,
  selected: string | null | undefined = process.env[OAUTH_ACCOUNT_ENV],
  options: RefreshCredentialOptions = {},
): Promise<string | null> {
  return (await resolveRefreshCredentialWithSource(provider, resolveKey, selected, options)).credential;
}
