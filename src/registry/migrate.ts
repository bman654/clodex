import {
  REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT,
  REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES,
  type ProviderRegistry,
} from './types.js';
import { migrateActiveOAuthAccountStorage } from './oauth-account-storage.js';

// Rename {id:'openai', authType:'oauth'} → {id:'openai-oauth'} so it can coexist
// with the API-key 'openai' provider. Preserves the original authRef so the
// keyring credential isn't orphaned.
export function migrateOAuthOpenAiProvider(registry: ProviderRegistry): boolean {
  if (registry.providers.some(p => p.id === 'openai-oauth')) return false;

  const idx = registry.providers.findIndex(
    p => p.id === 'openai' && p.authType === 'oauth',
  );
  if (idx < 0) return false;

  const existing = registry.providers[idx]!;
  registry.providers[idx] = {
    ...existing,
    id: 'openai-oauth',
    templateId: existing.templateId || 'openai',
    name: existing.name === 'OpenAI' ? 'OpenAI (ChatGPT)' : existing.name,
  };
  return true;
}

export interface RegistryMigrationResult {
  changed: boolean;
  /**
   * The selected credential/cache identity was projected into downgrade-visible
   * top-level fields. Returning those bytes before they are durable would put
   * the current process and an older process on different identities.
   */
  materializedActiveAccount: boolean;
}

/** Apply every supported in-memory registry migration. */
export function migrateRegistry(registry: ProviderRegistry): RegistryMigrationResult {
  const renamed = migrateOAuthOpenAiProvider(registry);
  // Schema v5 is authoritative. Never infer a missing parked default there:
  // its top-level authRef is already the selected slot, not the value to park.
  const materialized = registry.schemaVersion >= REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT
    && registry.schemaVersion <= REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES
    ? migrateActiveOAuthAccountStorage(registry)
    : false;
  return {
    changed: renamed || materialized,
    materializedActiveAccount: materialized,
  };
}
