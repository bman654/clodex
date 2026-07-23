// src/registry/add-template.ts — add a provider from a builtin template

import { randomUUID } from 'node:crypto';
import { saveProviderCredential } from '../env.js';
import { credentialAuthRef } from '../credential-helper.js';
import { isSdkMigratedNpm } from '../provider-factory.js';
import type { ProviderTemplate } from '../provider-templates.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import {
  cancelCredentialDelete,
  journalCredentialWrite,
  queueCredentialDelete,
  reconcilePendingCredentialDeletes,
} from './credential-lifecycle.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistryStrict, saveRegistry } from './io.js';
import {
  withCredentialMutationLock,
  withRegistryWriteLock,
} from './lock.js';
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
  credentialCleanupPending?: boolean;
}

async function probeTemplatePackage(template: ProviderTemplate): Promise<string | null> {
  if (!template.supported) return template.unsupportedReason ?? 'Provider is not supported yet.';
  if (!template.npm) return 'Template is missing an SDK package.';
  if (!isSdkMigratedNpm(template.npm) && template.npm !== '@ai-sdk/anthropic') {
    return `SDK package ${template.npm} is not available in clodex.`;
  }
  try {
    await import(template.npm);
    return null;
  } catch {
    return `Could not load ${template.npm}. Run npm install in your clodex checkout.`;
  }
}

function filterAnonymousFreeModels<T extends { cost?: { input: number; output: number }; isFree?: boolean; freeStatus?: ReturnType<typeof classifyFreeStatus> }>(
  models: T[],
  template: ProviderTemplate,
): T[] {
  if (!template.anonymousFreeModels) return models;
  return models.filter(model => isFreeStatus(classifyFreeStatus({
    model,
    providerId: template.id,
    templateId: template.id,
  })));
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
  if (!trimmedKey && !template.apiKeyOptional) {
    return { added: false, error: 'API key cannot be empty.' };
  }

  const existingState = await withRegistryWriteLock(() => {
    const registry = loadRegistryStrict();
    const existing = registry.providers.find(p => p.id === template.id);
    if (existing && !opts?.replaceExisting) {
      return {
        existing: false,
        error: {
          added: false as const,
          error: `${template.name} is already configured.`,
          hint: `Remove it first with: clodex providers remove ${template.id}`,
        },
      };
    }
    return { existing: existing !== undefined, error: null };
  });
  if (existingState.error) return existingState.error;

  const fetched = await fetchTemplateModels(template, trimmedKey, opts?.baseUrl);
  if (fetched.error || fetched.models.length === 0) {
    return {
      added: false,
      error: fetched.error ?? 'No models returned.',
      hint: fetched.hint,
    };
  }
  const usableModels = !trimmedKey && template.anonymousFreeModels
    ? filterAnonymousFreeModels(fetched.models, template)
    : fetched.models;
  if (usableModels.length === 0) {
    return {
      added: false,
      error: 'No free models were returned for anonymous access.',
      hint: template.signupUrl ? `Add a ${template.name} API key from ${template.signupUrl} to use paid models.` : undefined,
    };
  }

  const pricingCache = loadPricingCache();
  const platform = pricingPlatformForProvider(template.id, template.id);
  const pricedModels = enrichModelsWithPricing(
    usableModels.map(m => ({ ...m, apiUrl: fetched.baseUrl })),
    buildPricingIndex(pricingCache),
    platform,
  );
  const authRef = trimmedKey
    ? credentialAuthRef(
      existingState.existing
        ? `provider:${template.id}:replacement:${randomUUID()}`
        : `provider:${template.id}`,
    )
    : 'none:anonymous';
  const commitProvider = () => withRegistryWriteLock(async () => {
    const registry = loadRegistryStrict();
    const existing = registry.providers.find(p => p.id === template.id);
    if (existing && !opts?.replaceExisting) {
      return {
        added: false,
        error: `${template.name} is already configured.`,
        hint: `Remove it first with: clodex providers remove ${template.id}`,
      };
    }

    const now = new Date().toISOString();
    const entry: RegistryProvider = {
      id: template.id,
      templateId: template.id,
      name: template.name,
      enabled: true,
      authRef,
      authType: trimmedKey ? template.authType : 'none',
      ...(!trimmedKey && template.anonymousFreeModels
        ? { subscriptionFilter: 'free' as const }
        : {}),
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
    if (existing?.authRef && existing.authRef !== authRef) {
      await queueCredentialDelete(existing.authRef);
    }
    saveRegistry(registry);
    let credentialCleanupPending = false;
    if (trimmedKey) {
      try {
        await cancelCredentialDelete(authRef);
      } catch {
        credentialCleanupPending = true;
      }
    }
    return {
      added: true,
      provider: entry,
      modelCount: pricedModels.length,
      ...(credentialCleanupPending ? { credentialCleanupPending: true } : {}),
    };
  });

  const result: AddTemplateResult = trimmedKey
    ? await withCredentialMutationLock(authRef, async () => {
      const prepareError = await withRegistryWriteLock(() => {
        const registry = loadRegistryStrict();
        const existing = registry.providers.find(p => p.id === template.id);
        if (existing && !opts?.replaceExisting) {
          return {
            added: false,
            error: `${template.name} is already configured.`,
            hint: `Remove it first with: clodex providers remove ${template.id}`,
          };
        }
        return null;
      });
      if (prepareError) return prepareError;

      await journalCredentialWrite(authRef);

      const saved = await saveProviderCredential(authRef, trimmedKey);
      if (!saved) {
        return {
          added: false,
          error: 'Could not save API key to the credential store.',
          hint: 'Check credential-store access and try again.',
        };
      }
      return commitProvider();
    })
    : await commitProvider();

  if (result.added) {
    try {
      const cleanup = await reconcilePendingCredentialDeletes();
      result.credentialCleanupPending =
        cleanup.pending.length > 0 || cleanup.persistenceError !== undefined;
    } catch {
      result.credentialCleanupPending = true;
    }
  } else {
    try {
      await reconcilePendingCredentialDeletes();
    } catch {
      // The failed credential remains journaled for a later retry.
    }
  }

  if (result.added) enrichPricingAsync();
  return result;
}
