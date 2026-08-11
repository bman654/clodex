// src/registry/load.ts — materialize registry into runtime LocalProvider[]

import {
  resolveProviderCredentialWithSource,
  resolveProviderOAuthAccountId,
  resolveProviderOAuthProviderData,
} from '../env.js';
import type { CompatibilityAgent } from '../model-compatibility.js';
import type { LocalProvider } from '../types.js';
import { applySelectedOAuthAccount, isAnonymousProvider, materializeRegistry } from './materialize.js';
import { loadRegistry } from './io.js';

export type LoadedRegistryProviders = LocalProvider[] & {
  readonly blockedProviders: ReadonlyMap<string, string>;
};

/** Load enabled providers from ~/.clodex/providers.json with resolved credentials. */
export async function loadRegistryProviders(
  diag?: (msg: string) => void,
  opts?: { agent?: CompatibilityAgent; warn?: (msg: string) => void },
): Promise<LoadedRegistryProviders> {
  const registry = loadRegistry(undefined, diag);
  const providers = registry.providers.map(provider => applySelectedOAuthAccount(
    provider,
    undefined,
    opts?.warn,
  ));
  const selectedRegistry = { ...registry, providers };
  const keys = new Map<string, string>();
  const oauthAccountIds = new Map<string, string>();
  const oauthProviderData = new Map<string, Record<string, unknown>>();
  const blockedProviders = new Map<string, string>();
  await Promise.all(providers.map(async provider => {
    if (
      isAnonymousProvider(provider)
      || provider.authType === 'none'
      || provider.authRef === 'none:anonymous'
    ) return;
    let resolved;
    try {
      resolved = await resolveProviderCredentialWithSource(provider.id, provider.authRef, diag);
    } catch (err) {
      diag?.(`${provider.id}: credential unavailable — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const credentialOverride = resolved.credentialOverride !== undefined;
    if (provider.enabled && resolved.credentialOverride) {
      blockedProviders.set(
        provider.id,
        `${resolved.credentialOverride.variable} is a process-scoped credential with no isolated model catalog `
        + `for provider "${provider.id}". Save that credential as a provider or account and refresh its models, `
        + 'or unset the variable.',
      );
      return;
    }
    const credentialAvailable = Boolean(resolved.credential);
    if (resolved.credential) keys.set(provider.id, resolved.credential);
    if (provider.authType === 'oauth' && credentialAvailable && !credentialOverride) {
      try {
        const accountId = await resolveProviderOAuthAccountId(provider.authRef, diag);
        if (accountId) oauthAccountIds.set(provider.id, accountId);
        const pd = await resolveProviderOAuthProviderData(provider.authRef, diag);
        if (pd) oauthProviderData.set(provider.id, pd);
      } catch {
        // OAuth metadata is best-effort; credential failure already logged above.
      }
    }
  }));
  const materialized = materializeRegistry(selectedRegistry, provider => keys.get(provider.id) ?? null, opts)
    .map(provider => ({
      ...provider,
      oauthAccountId: oauthAccountIds.get(provider.id),
      providerData: oauthProviderData.get(provider.id),
    }));
  Object.defineProperty(materialized, 'blockedProviders', {
    value: blockedProviders,
    enumerable: false,
  });
  return materialized as LoadedRegistryProviders;
}

/** Sync variant when credentials are already resolved (tests). */
export function loadRegistryProvidersSync(
  resolveKey: (providerId: string, authRef: string) => string | null,
  opts?: { agent?: CompatibilityAgent },
): LocalProvider[] {
  const registry = loadRegistry();
  const selectedRegistry = {
    ...registry,
    providers: registry.providers.map(provider => applySelectedOAuthAccount(provider)),
  };
  return materializeRegistry(
    selectedRegistry,
    provider => isAnonymousProvider(provider) ? null : resolveKey(provider.id, provider.authRef),
    opts,
  );
}
