// src/registry/load.ts — materialize registry into runtime LocalProvider[]

import { resolveProviderCredential } from '../env.js';
import type { CompatibilityAgent } from '../model-compatibility.js';
import type { LocalProvider } from '../types.js';
import { materializeRegistry } from './materialize.js';
import { loadRegistry } from './io.js';

/** Load enabled providers from ~/.relay-ai/providers.json with resolved credentials. */
export async function loadRegistryProviders(
  diag?: (msg: string) => void,
  opts?: { agent?: CompatibilityAgent },
): Promise<LocalProvider[]> {
  const registry = loadRegistry();
  const keys = new Map<string, string>();
  for (const provider of registry.providers) {
    const key = await resolveProviderCredential(provider.id, provider.authRef, diag);
    if (key) keys.set(provider.id, key);
  }
  return materializeRegistry(registry, provider => keys.get(provider.id) ?? null, opts);
}

/** Sync variant when credentials are already resolved (tests). */
export function loadRegistryProvidersSync(
  resolveKey: (providerId: string, authRef: string) => string | null,
  opts?: { agent?: CompatibilityAgent },
): LocalProvider[] {
  const registry = loadRegistry();
  return materializeRegistry(registry, provider => resolveKey(provider.id, provider.authRef), opts);
}
