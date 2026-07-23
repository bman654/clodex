// src/registry/crud.ts — add/remove providers in the native registry

import { deleteProviderCredential } from '../env.js';
import { loadRegistry, saveRegistry } from './io.js';
import {
  withCredentialMutationLock,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from './lock.js';
import type { RegistryProvider } from './types.js';

export interface RemoveProviderResult {
  removed: boolean;
  id: string;
  name?: string;
  credentialDeleted: boolean;
  error?: string;
}

interface PendingProviderRemoval {
  result: RemoveProviderResult;
  authRefToDelete: string | null;
}

function credentialStillReferenced(authRef: string, remaining: RegistryProvider[]): boolean {
  return remaining.some(p => p.authRef === authRef);
}

function isStoredCredentialRef(authRef: string): boolean {
  return authRef.startsWith('keyring:') || authRef.startsWith('helper:');
}

/** Remove a provider from the registry; delete per-provider keychain entry when safe. */
export async function removeProviderFromRegistry(
  id: string,
  opts?: { deleteCredential?: boolean },
): Promise<RemoveProviderResult> {
  const removal = await withRegistryWriteLock<PendingProviderRemoval>(() => {
    const registry = loadRegistry();
    const index = registry.providers.findIndex(p => p.id === id);
    if (index < 0) {
      return {
        result: {
          removed: false,
          id,
          credentialDeleted: false,
          error: `Provider not found: ${id}`,
        },
        authRefToDelete: null,
      };
    }

    const [removedProvider] = registry.providers.splice(index, 1);
    saveRegistry(registry);

    return {
      result: {
        removed: true,
        id,
        name: removedProvider.name,
        credentialDeleted: false,
      },
      authRefToDelete:
        opts?.deleteCredential !== false &&
        isStoredCredentialRef(removedProvider.authRef) &&
        !credentialStillReferenced(removedProvider.authRef, registry.providers)
          ? removedProvider.authRef
          : null,
    };
  });

  const authRefToDelete = removal.authRefToDelete;
  if (authRefToDelete) {
    await withCredentialMutationLock(authRefToDelete, async () => {
      const referencedAgain = await withRegistryWriteLock(() =>
        credentialStillReferenced(
          authRefToDelete,
          loadRegistry().providers,
        ));
      if (referencedAgain) return;
      removal.result.credentialDeleted = await deleteProviderCredential(
        authRefToDelete,
      );
      if (!removal.result.credentialDeleted) {
        removal.result.error =
          `Provider ${removal.result.name ?? id} was removed, but credential ` +
          `cleanup failed for ${authRefToDelete}. The credential remains in ` +
          'the configured store and must be removed manually.';
      }
    });
  }
  return removal.result;
}

export function toggleProviderEnabled(id: string): { toggled: boolean; enabled?: boolean; error?: string } {
  return withRegistryWriteLockSync(() => {
    const registry = loadRegistry();
    const provider = registry.providers.find(p => p.id === id);
    if (!provider) return { toggled: false, error: `Provider not found: ${id}` };
    provider.enabled = !provider.enabled;
    saveRegistry(registry);
    return { toggled: true, enabled: provider.enabled };
  });
}
