import type { ProviderRegistry, RegistryProvider } from './types.js';

/**
 * Resolve only an account slot the registry actually owns. Account names such
 * as `constructor` are valid, so ordinary bracket lookup can otherwise return
 * an inherited Object.prototype member and turn a stale selector into data.
 */
export function getOAuthAccountSlot(
  provider: Pick<RegistryProvider, 'authAccounts'>,
  name: string,
): NonNullable<RegistryProvider['authAccounts']>[string] | undefined {
  const accounts = provider.authAccounts;
  return accounts && Object.prototype.hasOwnProperty.call(accounts, name)
    ? accounts[name]
    : undefined;
}

/** The provider-owned credential, whether or not a named slot is selected. */
export function providerDefaultAuthRef(
  provider: Pick<RegistryProvider, 'authRef' | 'defaultAuthRef'>,
): string {
  return provider.defaultAuthRef ?? provider.authRef;
}

/**
 * Persist one named selection in the downgrade-visible `authRef` field while
 * retaining the provider default for an exact rollback.
 */
export function storeActiveOAuthAccount(
  provider: RegistryProvider,
  name: string,
  selectedAuthRef: string,
): boolean {
  const previousAuthRef = provider.authRef;
  const previousDefaultAuthRef = provider.defaultAuthRef;
  const previousAccount = provider.activeAuthAccount;
  provider.defaultAuthRef = providerDefaultAuthRef(provider);
  provider.authRef = selectedAuthRef;
  provider.activeAuthAccount = name;
  return previousAuthRef !== provider.authRef
    || previousDefaultAuthRef !== provider.defaultAuthRef
    || previousAccount !== provider.activeAuthAccount;
}

/** Restore the parked provider default and remove all persisted selection state. */
export function clearActiveOAuthAccount(provider: RegistryProvider): boolean {
  const previousAuthRef = provider.authRef;
  const previousDefaultAuthRef = provider.defaultAuthRef;
  const previousAccount = provider.activeAuthAccount;
  provider.authRef = providerDefaultAuthRef(provider);
  delete provider.defaultAuthRef;
  delete provider.activeAuthAccount;
  return previousAuthRef !== provider.authRef
    || previousDefaultAuthRef !== provider.defaultAuthRef
    || previousAccount !== provider.activeAuthAccount;
}

/**
 * Upgrade OAuth selectors written before schema v5. In v3/v4, `authRef` is
 * defined as the provider default, so it is safe to park. The top-level model
 * cache is not proof of account ownership, however: only a v4 slot cache is.
 * Never copy an ambiguous top cache into the selected slot. Project the slot's
 * proven cache when one exists, otherwise clear the top cache and fail closed
 * until that account is refreshed.
 *
 * A selector whose slot is missing is deliberately left untouched. There is
 * no selected credential to materialize, and guessing the default would turn
 * a broken selection into a silent identity fallback.
 */
export function migrateActiveOAuthAccountStorage(registry: ProviderRegistry): boolean {
  let changed = false;
  for (const provider of registry.providers) {
    const name = provider.activeAuthAccount?.trim();
    if (provider.authType !== 'oauth' || !name || provider.defaultAuthRef !== undefined) continue;
    const selected = getOAuthAccountSlot(provider, name);
    if (!selected) continue;

    provider.defaultAuthRef = provider.authRef;
    provider.authRef = selected.authRef;
    // Account-owned caches did not exist until v4. A stray cache in older
    // bytes has no schema-backed ownership provenance and must not be paired
    // with the selected credential.
    if (registry.schemaVersion >= 4 && selected.modelsCache) {
      provider.modelsCache = selected.modelsCache;
      provider.refreshedAt = selected.modelsCache.fetchedAt;
    } else {
      delete provider.modelsCache;
      delete provider.refreshedAt;
    }
    changed = true;
  }
  return changed;
}
