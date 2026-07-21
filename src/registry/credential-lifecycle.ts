import { deleteProviderCredential, parseAuthRef } from '../env.js';
import { loadRegistry, saveRegistry } from './io.js';
import {
  withCredentialMutationLock,
  withRegistryWriteLock,
} from './lock.js';
import type { ProviderRegistry } from './types.js';

export interface CredentialCleanupResult {
  deleted: string[];
  pending: string[];
  persistenceError?: string;
}

function isStoredCredentialRef(authRef: string): boolean {
  const parsed = parseAuthRef(authRef);
  return parsed?.kind === 'keyring' || parsed?.kind === 'helper';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function credentialIsReferenced(registry: ProviderRegistry, authRef: string): boolean {
  return registry.providers.some(provider => provider.authRef === authRef);
}

/** Queue an unreferenced stored credential for idempotent cleanup. */
export function queueCredentialDelete(registry: ProviderRegistry, authRef: string): boolean {
  if (!isStoredCredentialRef(authRef) || credentialIsReferenced(registry, authRef)) return false;
  const pending = registry.pendingCredentialDeletes ?? [];
  if (pending.includes(authRef)) return false;
  registry.pendingCredentialDeletes = [...pending, authRef];
  return true;
}

/** Keep an active credential out of the cleanup queue. */
export function cancelCredentialDelete(registry: ProviderRegistry, authRef: string): boolean {
  const pending = registry.pendingCredentialDeletes;
  if (!pending?.includes(authRef)) return false;
  const next = pending.filter(candidate => candidate !== authRef);
  if (next.length > 0) registry.pendingCredentialDeletes = next;
  else delete registry.pendingCredentialDeletes;
  return true;
}

/**
 * Persist a cleanup marker before writing an unreferenced credential. The
 * caller must hold that credential's mutation lock before entering the short
 * registry-lock section that invokes this function.
 */
export function journalCredentialWriteLocked(registry: ProviderRegistry, authRef: string): void {
  if (queueCredentialDelete(registry, authRef)) saveRegistry(registry);
}

interface SingleCleanupResult {
  deleted: boolean;
  persistenceError?: string;
}

async function discardInvalidPendingRef(authRef: string): Promise<SingleCleanupResult> {
  try {
    await withRegistryWriteLock(() => {
      const registry = loadRegistry();
      if (cancelCredentialDelete(registry, authRef)) saveRegistry(registry);
    });
    return { deleted: false };
  } catch (error) {
    return { deleted: false, persistenceError: errorMessage(error) };
  }
}

/**
 * Reconcile one queued reference without holding the registry lock during a
 * credential-store operation. Every registry check happens inside the
 * credential lock, so activation of the same reference is serialized with
 * deletion while unrelated credentials remain independent.
 */
async function reconcilePendingCredentialDelete(authRef: string): Promise<SingleCleanupResult> {
  if (!isStoredCredentialRef(authRef)) return discardInvalidPendingRef(authRef);

  return withCredentialMutationLock(authRef, async () => {
    let queuedForDelete = false;
    try {
      await withRegistryWriteLock(() => {
        const registry = loadRegistry();
        if (!registry.pendingCredentialDeletes?.includes(authRef)) return;
        if (credentialIsReferenced(registry, authRef)) {
          cancelCredentialDelete(registry, authRef);
          saveRegistry(registry);
          return;
        }
        queuedForDelete = true;
      });
    } catch (error) {
      return { deleted: false, persistenceError: errorMessage(error) };
    }
    if (!queuedForDelete) return { deleted: false };

    let deleted = false;
    try {
      deleted = await deleteProviderCredential(authRef);
    } catch {
      deleted = false;
    }

    try {
      await withRegistryWriteLock(() => {
        const registry = loadRegistry();
        if (!registry.pendingCredentialDeletes?.includes(authRef)) return;
        if (credentialIsReferenced(registry, authRef) || deleted) {
          cancelCredentialDelete(registry, authRef);
          saveRegistry(registry);
        }
      });
    } catch (error) {
      return { deleted, persistenceError: errorMessage(error) };
    }
    return { deleted };
  });
}

/** Retry queued credential deletions sequentially and idempotently. */
export async function reconcilePendingCredentialDeletes(): Promise<CredentialCleanupResult> {
  const queued = await withRegistryWriteLock(() => [
    ...(loadRegistry().pendingCredentialDeletes ?? []),
  ]);
  const deleted: string[] = [];
  let persistenceError: string | undefined;

  for (const authRef of queued) {
    const result = await reconcilePendingCredentialDelete(authRef);
    if (result.deleted) deleted.push(authRef);
    persistenceError ??= result.persistenceError;
  }

  const pending = await withRegistryWriteLock(() => [
    ...(loadRegistry().pendingCredentialDeletes ?? []),
  ]);
  return {
    deleted,
    pending,
    ...(persistenceError ? { persistenceError } : {}),
  };
}
