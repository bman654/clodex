// src/registry/add-template.ts — add a provider from a builtin template

import { saveProviderCredential } from '../env.js';
import { isSdkMigratedNpm } from '../provider-factory.js';
import type { ProviderTemplate } from '../provider-templates.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistry, saveRegistry } from './io.js';
import {
  buildPricingIndex,
  enrichModelsWithPricing,
  enrichPricingAsync,
  loadPricingCache,
  pricingPlatformForProvider,
} from './pricing.js';
import type { RegistryProvider } from './types.js';

export interface AddTemplateResult {
  added: boolean;
  provider?: RegistryProvider;
  modelCount?: number;
  error?: string;
  hint?: string;
}

async function probeTemplatePackage(template: ProviderTemplate): Promise<string | null> {
  if (!template.supported) return template.unsupportedReason ?? 'Provider is not supported yet.';
  if (!template.npm) return 'Template is missing an SDK package.';
  if (!isSdkMigratedNpm(template.npm) && template.npm !== '@ai-sdk/anthropic') {
    return `SDK package ${template.npm} is not available in relay-ai.`;
  }
  try {
    await import(template.npm);
    return null;
  } catch {
    return `Could not load ${template.npm}. Run npm install in your relay-ai checkout.`;
  }
}

/** Test API key, persist credential + registry entry. */
export async function addProviderFromTemplate(
  template: ProviderTemplate,
  apiKey: string,
  opts?: { replaceExisting?: boolean; baseUrl?: string },
): Promise<AddTemplateResult> {
  const packageError = await probeTemplatePackage(template);
  if (packageError) {
    return { added: false, error: packageError };
  }

  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { added: false, error: 'API key cannot be empty.' };
  }

  const registry = loadRegistry();
  const existing = registry.providers.find(p => p.id === template.id);
  if (existing && !opts?.replaceExisting) {
    return {
      added: false,
      error: `${template.name} is already configured.`,
      hint: `Remove it first with: relay-ai providers remove ${template.id}`,
    };
  }

  const fetched = await fetchTemplateModels(template, trimmedKey, opts?.baseUrl);
  if (fetched.error || fetched.models.length === 0) {
    return {
      added: false,
      error: fetched.error ?? 'No models returned.',
      hint: fetched.hint,
    };
  }

  const saved = await saveProviderCredential(`keyring:provider:${template.id}`, trimmedKey);
  if (!saved) {
    return {
      added: false,
      error: 'Could not save API key to Keychain.',
      hint: 'Grant Keychain access or try again.',
    };
  }

  const now = new Date().toISOString();
  const pricingCache = loadPricingCache();
  const platform = pricingPlatformForProvider(template.id, template.id);
  const pricedModels = enrichModelsWithPricing(
    fetched.models.map(m => ({ ...m, apiUrl: fetched.baseUrl })),
    buildPricingIndex(pricingCache),
    platform,
  );
  const entry: RegistryProvider = {
    id: template.id,
    templateId: template.id,
    name: template.name,
    enabled: true,
    authRef: `keyring:provider:${template.id}`,
    api: {
      npm: template.npm,
      url: fetched.baseUrl,
    },
    addedAt: existing?.addedAt ?? now,
    refreshedAt: now,
    modelsCache: {
      fetchedAt: now,
      models: pricedModels,
    },
  };

  if (existing) {
    const idx = registry.providers.findIndex(p => p.id === template.id);
    registry.providers[idx] = entry;
  } else {
    registry.providers.push(entry);
  }
  saveRegistry(registry);
  enrichPricingAsync();

  return { added: true, provider: entry, modelCount: fetched.models.length };
}
