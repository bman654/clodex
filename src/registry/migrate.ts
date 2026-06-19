import type { ProviderRegistry } from './types.js';

const LEGACY_CLOUD_PROVIDER_IDS = [
  { legacyId: 'opencode', id: 'zen', name: 'OpenCode Zen' },
  { legacyId: 'opencode-go', id: 'go', name: 'OpenCode Go' },
] as const;

export function migrateLegacyCloudProviders(registry: ProviderRegistry): boolean {
  let changed = false;

  for (const { legacyId, id, name } of LEGACY_CLOUD_PROVIDER_IDS) {
    const legacyIdx = registry.providers.findIndex(provider => provider.id === legacyId);
    if (legacyIdx < 0) continue;

    if (registry.providers.some(provider => provider.id === id)) {
      registry.providers.splice(legacyIdx, 1);
    } else {
      registry.providers[legacyIdx] = {
        ...registry.providers[legacyIdx]!,
        id,
        templateId: id,
        name,
        api: {},
      };
    }
    changed = true;
  }

  return changed;
}
