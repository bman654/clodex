// src/registry/resolve-template.ts — map imported OpenCode ids to builtin templates + default URLs

import { OPENCODE_GO_PROVIDER_ID } from '../data/opencode-go-models.js';
import { getTemplateById, type ProviderTemplate } from '../provider-templates.js';
import type { RegistryProvider } from './types.js';

/** Legacy provider ids that differ from clodex template ids */
const TEMPLATE_ID_ALIASES: Record<string, string> = {
  'google-vertex': 'vertex',
};

const NPM_DEFAULT_BASE_URL: Record<string, string> = {
  '@ai-sdk/anthropic': 'https://api.anthropic.com',
};

/**
 * The identity fields template resolution reads.
 *
 * Accepting this pair instead of a whole `RegistryProvider` lets a caller that
 * only holds the persisted policy fields — pricing's
 * `providerPreservesModelPricing` — ask the SAME identity question. The
 * alternative was a second, partial predicate keyed on `templateId` alone,
 * which is exactly the drift this module exists to prevent.
 */
export type ProviderTemplateIdentity = Pick<RegistryProvider, 'templateId'>
  & Partial<Pick<RegistryProvider, 'id'>>;

export function resolveProviderTemplate(provider: ProviderTemplateIdentity): ProviderTemplate | undefined {
  const candidates = [
    TEMPLATE_ID_ALIASES[provider.templateId],
    provider.templateId,
    provider.id ? TEMPLATE_ID_ALIASES[provider.id] : undefined,
    provider.id,
  ].filter(Boolean) as string[];

  for (const id of candidates) {
    const template = getTemplateById(id);
    if (template) return template;
  }
  return undefined;
}

/**
 * Recognize the retained OpenCode Go built-in by its canonical template
 * relationship rather than by one mutable field.
 *
 * The explicit id arm preserves records that keep the canonical id while
 * naming another template. The resolver arm preserves imported or migrated
 * records whose id drifted while `templateId: 'opencode-go'` and its credential
 * lineage remained. This intentionally does not generalize template identity
 * to ordinary providers: custom records may name an ordinary template without
 * occupying that built-in's add slot.
 */
export function isRetainedOpenCodeGoProvider(provider: ProviderTemplateIdentity): boolean {
  return provider.id === OPENCODE_GO_PROVIDER_ID
    || resolveProviderTemplate(provider)?.id === OPENCODE_GO_PROVIDER_ID;
}

/**
 * The retained built-in's own template, for callers that must discover or
 * price a record by its real identity rather than the template it names.
 *
 * A retained record whose `templateId` drifted resolves to somebody else's
 * template, and that template carries the wrong catalog: OpenCode's committed
 * allowlist, its bare-array parse, and its curated costs all hang off THIS
 * entry. Callers pair it with `isRetainedOpenCodeGoProvider`.
 */
export function retainedOpenCodeGoTemplate(): ProviderTemplate | undefined {
  return getTemplateById(OPENCODE_GO_PROVIDER_ID);
}

/** Whether a configured record occupies a built-in template's add slot. */
export function isProviderConfiguredForTemplate(
  provider: RegistryProvider,
  templateId: string,
): boolean {
  if (provider.id === templateId) return true;
  return templateId === OPENCODE_GO_PROVIDER_ID
    && isRetainedOpenCodeGoProvider(provider);
}

export function effectiveProviderBaseUrl(provider: RegistryProvider, template?: ProviderTemplate): string | undefined {
  const fromRegistry = provider.api.url?.trim();
  if (fromRegistry) return fromRegistry;
  if (template?.defaultBaseUrl?.trim()) return template.defaultBaseUrl.trim();
  const npm = provider.api.npm?.trim();
  if (npm && NPM_DEFAULT_BASE_URL[npm]) return NPM_DEFAULT_BASE_URL[npm];
  return undefined;
}

export function syntheticTemplate(provider: RegistryProvider, baseUrl?: string): ProviderTemplate {
  const npm = provider.api.npm ?? '@ai-sdk/openai-compatible';
  return {
    id: provider.id,
    name: provider.name,
    authType: 'api',
    npm,
    defaultBaseUrl: baseUrl,
    modelSource: 'api-list',
    supported: true,
  };
}
