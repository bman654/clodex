// src/registry/crud.ts — add/remove providers in the native registry

import {
  queueCredentialDelete,
  reconcilePendingCredentialDeletes,
} from './credential-lifecycle.js';
import { loadRegistryStrict, saveRegistry } from './io.js';
import {
  withProviderMutationLock,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from './lock.js';
import {
  REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT,
  type RegistryProvider,
} from './types.js';
import {
  clearActiveOAuthAccount,
  getOAuthAccountSlot,
  storeActiveOAuthAccount,
} from './oauth-account-storage.js';

export interface RemoveProviderResult {
  removed: boolean;
  id: string;
  name?: string;
  credentialDeleted: boolean;
  credentialCleanupPending?: boolean;
  credentialCleanupReconciled?: boolean;
  error?: string;
}

interface PendingProviderRemoval {
  result: RemoveProviderResult;
  /** Every unique selected, parked-default, and named-slot ref queued for cleanup. */
  queuedRefs: string[];
}

/** Remove a provider from the registry; delete its stored credential when safe. */
async function removeProviderWithinLifecycle(
  id: string,
  opts?: { deleteCredential?: boolean },
): Promise<RemoveProviderResult> {
  const removal = await withRegistryWriteLock<PendingProviderRemoval>(async () => {
    const registry = loadRegistryStrict();
    const index = registry.providers.findIndex(p => p.id === id);
    if (index < 0) {
      return {
        result: {
          removed: false,
          id,
          credentialDeleted: false,
          error: `Provider not found: ${id}`,
        },
        queuedRefs: [],
      };
    }

    const [removedProvider] = registry.providers.splice(index, 1);
    const queuedRefs: string[] = [];
    if (opts?.deleteCredential !== false) {
      // `authRef` can equal the selected slot while `defaultAuthRef` parks the
      // provider credential. Queue every UNIQUE lineage so neither one can be
      // orphaned or spuriously counted twice during cleanup.
      const credentialRefs = new Set<string>([
        removedProvider.authRef,
        ...(removedProvider.defaultAuthRef ? [removedProvider.defaultAuthRef] : []),
        ...Object.values(removedProvider.authAccounts ?? {}).map(slot => slot.authRef),
      ]);
      for (const authRef of credentialRefs) {
        if (await queueCredentialDelete(authRef)) queuedRefs.push(authRef);
      }
    }
    saveRegistry(registry);

    return {
      result: {
        removed: true,
        id,
        name: removedProvider.name,
        credentialDeleted: false,
      },
      queuedRefs,
    };
  });

  if (removal.queuedRefs.length > 0) {
    // Deletion and pending status derive from the COMPLETE queued set: a
    // failed slot deletion must surface as pending even when the default
    // credential deleted cleanly, or the pending-cleanup warning is
    // suppressed while credentials remain queued in the store.
    try {
      const cleanup = await reconcilePendingCredentialDeletes();
      removal.result.credentialDeleted =
        removal.queuedRefs.every(ref => cleanup.deleted.includes(ref));
      removal.result.credentialCleanupPending =
        removal.queuedRefs.some(ref => cleanup.pending.includes(ref))
        || cleanup.persistenceError !== undefined;
    } catch {
      removal.result.credentialCleanupPending = true;
    }
    removal.result.credentialCleanupReconciled = true;
  }
  return removal.result;
}

export async function removeProviderFromRegistry(
  id: string,
  opts?: { deleteCredential?: boolean },
): Promise<RemoveProviderResult> {
  return withProviderMutationLock(id, () => removeProviderWithinLifecycle(id, opts));
}

/**
 * Persist which OAuth account slot the provider launches as. `undefined`
 * restores the provider's own default credential.
 *
 * Membership is checked here, under the write lock, so the registry can never
 * be left pointing at a slot that does not exist — the one state
 * `applySelectedOAuthAccount` has to refuse to launch on.
 */
export async function setActiveOAuthAccount(
  id: string,
  account: string | undefined,
): Promise<{ updated: boolean; changed?: boolean; account?: string; provider?: RegistryProvider; error?: string }> {
  // Account cache ownership and OAuth credential replacement are one provider
  // mutation domain. Without this outer lock, a concurrent reauthentication
  // can replace a deterministic slot credential while this switch parks that
  // slot's old catalog, leaving new credentials paired with stale entitlements.
  return withProviderMutationLock(id, () => withRegistryWriteLock(() => {
    const registry = loadRegistryStrict();
    const provider = registry.providers.find(p => p.id === id);
    if (!provider) return { updated: false, error: `Provider not found: ${id}` };
    const name = account?.trim().toLowerCase();
    const previous = provider.activeAuthAccount?.trim() || undefined;
    const selectedSlot = name ? getOAuthAccountSlot(provider, name) : undefined;
    let selectionChanged = previous !== name;
    let storageChanged = false;
    if (name && !selectedSlot) {
      const slots = provider.authAccounts ?? {};
      const available = Object.keys(slots).sort().join(', ') || 'none';
      return {
        updated: false,
        error: `${provider.name} has no account named "${name}" (available: ${available}).`,
      };
    }
    if (name && provider.authType === 'oauth') {
      // Park the provider default before replacing the top-level cache with the
      // selected slot. Named-to-named switches leave that parked state intact.
      storageChanged = storeActiveOAuthAccount(provider, name, selectedSlot!.authRef);
    }
    if (selectionChanged && provider.authType === 'oauth') {
      // Model availability is credential/account-specific. Park a named
      // account's current cache, then expose only the selected account's known
      // cache under the same lock. A cache miss fails closed until the
      // interactive command's targeted refresh completes.
      const previousSlot = previous ? getOAuthAccountSlot(provider, previous) : undefined;
      if (previous && previousSlot && provider.modelsCache && provider.authAccounts) {
        provider.authAccounts[previous] = {
          ...previousSlot,
          modelsCache: provider.modelsCache,
        };
      }
      const selectedCache = selectedSlot?.modelsCache;
      if (selectedCache) {
        provider.modelsCache = selectedCache;
        provider.refreshedAt = selectedCache.fetchedAt;
      } else {
        delete provider.modelsCache;
        delete provider.refreshedAt;
      }
    }
    if (name && provider.authType !== 'oauth') {
      // Preserve PR #17's repairable dormant-selector state without routing a
      // non-OAuth provider through an OAuth slot credential.
      storageChanged = clearActiveOAuthAccount(provider) || storageChanged;
      if (provider.activeAuthAccount !== name) {
        provider.activeAuthAccount = name;
        storageChanged = true;
      }
    } else if (!name && (previous !== undefined || provider.defaultAuthRef !== undefined)) {
      storageChanged = clearActiveOAuthAccount(provider);
    } else if (!name) {
      selectionChanged = false;
    }
    // A strict legacy load migrates in memory without changing schemaVersion.
    // Persist that storage upgrade even when the user selected the same slot.
    const migrationNeedsPersistence = registry.schemaVersion
      < REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT
      && provider.defaultAuthRef !== undefined;
    if (selectionChanged || storageChanged || migrationNeedsPersistence) saveRegistry(registry);
    // Return the state that actually won the write lock. The provider may have
    // been disabled, retyped, or otherwise changed while the picker was open;
    // post-switch messages must not be derived from the stale pre-prompt copy.
    return { updated: true, changed: selectionChanged, ...(name ? { account: name } : {}), provider };
  }));
}

export function toggleProviderEnabled(id: string): { toggled: boolean; enabled?: boolean; error?: string } {
  return withRegistryWriteLockSync(() => {
    const registry = loadRegistryStrict();
    const provider = registry.providers.find(p => p.id === id);
    if (!provider) return { toggled: false, error: `Provider not found: ${id}` };
    provider.enabled = !provider.enabled;
    saveRegistry(registry);
    return { toggled: true, enabled: provider.enabled };
  });
}
