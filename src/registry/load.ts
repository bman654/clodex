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

/** Load enabled providers from ~/.clodex/providers.json with resolved credentials. */
export async function loadRegistryProviders(
  diag?: (msg: string) => void,
  opts?: { agent?: CompatibilityAgent },
): Promise<LocalProvider[]> {
  const registry = loadRegistry();
  const providers = registry.providers.map(provider => applySelectedOAuthAccount(provider));
  const selectedRegistry = { ...registry, providers };
  const keys = new Map<string, string>();
  const oauthAccountIds = new Map<string, string>();
  const oauthProviderData = new Map<string, Record<string, unknown>>();
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
      throw new Error(
        `${resolved.credentialOverride.variable} is a process-scoped credential with no isolated model catalog `
        + `for provider "${provider.id}". Save that credential as a provider or account and refresh its models, `
        + 'or unset the variable.',
      );
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
  return materializeRegistry(selectedRegistry, provider => keys.get(provider.id) ?? null, opts)
    .map(provider => ({
      ...provider,
      oauthAccountId: oauthAccountIds.get(provider.id),
      providerData: oauthProviderData.get(provider.id),
    }));
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
