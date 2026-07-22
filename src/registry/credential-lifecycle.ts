import { deleteProviderCredential } from '../env.js';
import {
  cancelCredentialDelete,
  isStoredCredentialRef,
  loadPendingCredentialDeletes,
  queueCredentialDelete,
} from './credential-cleanup-journal.js';
import { loadRegistryStrict } from './io.js';
import {
  withCredentialMutationLock,
  withRegistryWriteLock,
} from './lock.js';
import type { ProviderRegistry } from './types.js';

export {
  cancelCredentialDelete,
  queueCredentialDelete,
} from './credential-cleanup-journal.js';

export interface CredentialCleanupResult {
  deleted: string[];
  pending: string[];
  persistenceError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendError(errors: string[], context: string, error: unknown): void {
  errors.push(`${context}: ${errorMessage(error)}`);
}

export function credentialIsReferenced(
  registry: ProviderRegistry,
  authRef: string,
): boolean {
  return registry.providers.some(provider => provider.authRef === authRef);
}

/** Persist cleanup intent before a credential can become unreferenced. */
export async function journalCredentialWrite(authRef: string): Promise<void> {
  if (!await queueCredentialDelete(authRef)) {
    throw new Error('Credential reference is not managed by Clodex.');
  }
}

interface SingleCleanupResult {
  deleted: boolean;
  cleared: boolean;
  persistenceError?: string;
}

/**
 * Reconcile one queued reference without holding the registry lock during a
 * credential-store operation. The credential lock serializes activation and
 * deletion for this reference without blocking unrelated credentials.
 */
async function reconcilePendingCredentialDelete(
  authRef: string,
): Promise<SingleCleanupResult> {
  if (!isStoredCredentialRef(authRef)) {
    try {
      await cancelCredentialDelete(authRef);
      return { deleted: false, cleared: true };
    } catch (error) {
      return {
        deleted: false,
        cleared: false,
        persistenceError: errorMessage(error),
      };
    }
  }

  try {
    return await withCredentialMutationLock(authRef, async () => {
      try {
        const clearedReferencedMarker = await withRegistryWriteLock(async () => {
          if (!credentialIsReferenced(loadRegistryStrict(), authRef)) return false;
          await cancelCredentialDelete(authRef);
          return true;
        });
        if (clearedReferencedMarker) {
          return { deleted: false, cleared: true };
        }
      } catch (error) {
        return {
          deleted: false,
          cleared: false,
          persistenceError: errorMessage(error),
        };
      }

      let deleted = false;
      try {
        deleted = await deleteProviderCredential(authRef);
      } catch {
        deleted = false;
      }
      if (!deleted) return { deleted: false, cleared: false };

      try {
        await cancelCredentialDelete(authRef);
        return { deleted: true, cleared: true };
      } catch (error) {
        return {
          deleted: true,
          cleared: false,
          persistenceError: errorMessage(error),
        };
      }
    });
  } catch (error) {
    return {
      deleted: false,
      cleared: false,
      persistenceError: errorMessage(error),
    };
  }
}

/** Retry queued credential deletions sequentially and idempotently. */
export async function reconcilePendingCredentialDeletes(): Promise<CredentialCleanupResult> {
  let queued: string[];
  try {
    queued = await loadPendingCredentialDeletes();
  } catch (error) {
    return {
      deleted: [],
      pending: [],
      persistenceError: `Could not read pending credential cleanup: ${errorMessage(error)}`,
    };
  }

  const knownPending = new Set(queued);
  const deleted: string[] = [];
  const errors: string[] = [];

  for (const authRef of queued) {
    let result: SingleCleanupResult;
    try {
      result = await reconcilePendingCredentialDelete(authRef);
    } catch (error) {
      result = {
        deleted: false,
        cleared: false,
        persistenceError: errorMessage(error),
      };
    }
    if (result.deleted) deleted.push(authRef);
    if (result.cleared) knownPending.delete(authRef);
    if (result.persistenceError) {
      appendError(errors, `Cleanup for ${authRef}`, result.persistenceError);
    }
  }

  let pending = [...knownPending];
  try {
    pending = await loadPendingCredentialDeletes();
  } catch (error) {
    appendError(errors, 'Could not confirm pending credential cleanup', error);
  }

  return {
    deleted,
    pending,
    ...(errors.length > 0 ? { persistenceError: errors.join('; ') } : {}),
  };
}
