// src/registry/crud.ts — add/remove providers in the native registry

import { parseAuthRef, deleteProviderCredential } from '../env.js';
import { loadRegistry, saveRegistry } from './io.js';
import type { RegistryProvider } from './types.js';

export interface RemoveProviderResult {
  removed: boolean;
  id: string;
  name?: string;
  credentialDeleted: boolean;
  error?: string;
}

function credentialStillReferenced(authRef: string, remaining: RegistryProvider[]): boolean {
  return remaining.some(p => p.authRef === authRef);
}

/** Remove a provider from the registry; delete per-provider keychain entry when safe. */
export async function removeProviderFromRegistry(
  id: string,
  opts?: { deleteCredential?: boolean },
): Promise<RemoveProviderResult> {
  const registry = loadRegistry();
  const index = registry.providers.findIndex(p => p.id === id);
  if (index < 0) {
    return { removed: false, id, credentialDeleted: false, error: `Provider not found: ${id}` };
  }

  const [removedProvider] = registry.providers.splice(index, 1);
  saveRegistry(registry);

  let credentialDeleted = false;
  if (opts?.deleteCredential !== false) {
    const parsed = parseAuthRef(removedProvider.authRef);
    const shouldDelete = !credentialStillReferenced(removedProvider.authRef, registry.providers);
    if (shouldDelete && parsed?.kind === 'keyring') {
      credentialDeleted = await deleteProviderCredential(removedProvider.authRef);
    }
  }

  return {
    removed: true,
    id,
    name: removedProvider.name,
    credentialDeleted,
  };
}

export function toggleProviderEnabled(id: string): { toggled: boolean; enabled?: boolean; error?: string } {
  const registry = loadRegistry();
  const provider = registry.providers.find(p => p.id === id);
  if (!provider) return { toggled: false, error: `Provider not found: ${id}` };
  provider.enabled = !provider.enabled;
  saveRegistry(registry);
  return { toggled: true, enabled: provider.enabled };
}
