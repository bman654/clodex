// src/registry/crud.ts — add/remove providers in the native registry

import {
  queueCredentialDelete,
  reconcilePendingCredentialDeletes,
} from './credential-lifecycle.js';
import { loadRegistry, saveRegistry } from './io.js';
import {
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from './lock.js';

export interface RemoveProviderResult {
  removed: boolean;
  id: string;
  name?: string;
  credentialDeleted: boolean;
  credentialCleanupPending?: boolean;
  error?: string;
}

interface PendingProviderRemoval {
  result: RemoveProviderResult;
  authRef: string | null;
}

/** Remove a provider from the registry; delete its stored credential when safe. */
export async function removeProviderFromRegistry(
  id: string,
  opts?: { deleteCredential?: boolean },
): Promise<RemoveProviderResult> {
  const removal = await withRegistryWriteLock<PendingProviderRemoval>(async () => {
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
        authRef: null,
      };
    }

    const [removedProvider] = registry.providers.splice(index, 1);
    const cleanupQueued = opts?.deleteCredential !== false
      ? await queueCredentialDelete(removedProvider.authRef)
      : false;
    saveRegistry(registry);

    return {
      result: {
        removed: true,
        id,
        name: removedProvider.name,
        credentialDeleted: false,
      },
      authRef: cleanupQueued ? removedProvider.authRef : null,
    };
  });

  if (removal.authRef) {
    try {
      const cleanup = await reconcilePendingCredentialDeletes();
      removal.result.credentialDeleted = cleanup.deleted.includes(removal.authRef);
      removal.result.credentialCleanupPending =
        cleanup.pending.includes(removal.authRef) || cleanup.persistenceError !== undefined;
    } catch {
      removal.result.credentialCleanupPending = true;
    }
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
