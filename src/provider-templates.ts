// src/provider-templates.ts — builtin provider templates for clodex providers add

import { TEST_TIMEOUT_MS } from './constants.js';
import type { CachedModel } from './registry/types.js';
import {
  buildOpenCodeGoModels,
  OPENCODE_GO_COMPLETIONS_BASE_URL,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_PROVIDER_NAME,
} from './data/opencode-go-models.js';

export type ProviderAuthType = 'api' | 'oauth' | 'none';
export type ProviderModelSource = 'api-list' | 'static-seed' | 'manual-only';
export type ProviderStaticModelPolicy = 'overlay' | 'allowlist';
export type ProviderTemplateModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

export interface ProviderTemplate {
  id: string;
  name: string;
  authType: ProviderAuthType;
  npm: string;
  defaultBaseUrl?: string;
  modelsPath?: string;
  signupUrl?: string;
  urlPlaceholder?: string;
  urlPrompt?: string;
  apiKeyOptional?: boolean;
  anonymousFreeModels?: boolean;
  /** Static headers this provider requires on every request (model listing and runtime). */
  headers?: Record<string, string>;
  modelSource: ProviderModelSource;
  /** Curated model metadata layered over live discovery or used as a static seed. */
  staticModels?: ProviderTemplateModel[];
  /** `allowlist` hides live models absent from staticModels; `overlay` keeps them. */
  staticModelPolicy?: ProviderStaticModelPolicy;
  /** Keep provider/curated costs instead of replacing them with the global pricing cache. */
  preserveModelPricing?: boolean;
  /**
   * Authenticated probe run before a pasted key is persisted. Required when the
   * provider's models endpoint answers without authentication (so a models
   * fetch cannot validate the credential). Returns an error message to reject
   * the key, or null when the key is accepted or the probe is inconclusive —
   * only a definite auth rejection may block the add.
   *
   * Deliberately takes no base-URL argument. The probe destination is a
   * property of the template, so no caller can redirect a live credential to
   * an address the template did not declare.
   */
  verifyCredential?: (apiKey: string) => Promise<string | null>;
  supported: boolean;
  addable?: boolean;
  hidden?: boolean;
  unsupportedReason?: string;
}

/**
 * OpenCode Go's /models endpoint is availability data and answers without
 * authentication, so the shared api-list flow's models fetch cannot validate a
 * pasted key. Probe the authenticated chat-completions endpoint instead.
 *
 * The destination is the template's own reviewed literal, never an argument:
 * this function sends a live credential, so the address it reaches must not be
 * reachable from caller input.
 *
 * The gateway resolves the request's model BEFORE evaluating the key: a body
 * without a supported model returns 401 ModelError for every key, valid or
 * not, so the probe must name a model from the committed catalog. Even then,
 * only an auth-shaped rejection (401/403 whose error reads as AuthError /
 * invalid key) rejects the credential; every other outcome — validation
 * errors, unparseable bodies, an unreachable upstream — is inconclusive and
 * passes, so the probe can only ever reject keys the upstream itself
 * rejected as keys.
 */
export async function verifyOpenCodeGoCredential(apiKey: string): Promise<string | null> {
  const model = buildOpenCodeGoModels().find(entry => entry.modelFormat === 'openai');
  if (!model) return null;
  try {
    const response = await fetch(`${OPENCODE_GO_COMPLETIONS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: model.upstreamModelId ?? model.id }),
      // This is the FIRST thing a user hits after pasting a key, and it runs
      // under a spinner. Without a deadline an upstream that accepts and then
      // stalls leaves no exit but Ctrl-C. The catch below already treats an
      // abort as inconclusive, so fail-open semantics are unchanged.
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      let authRejected = false;
      try {
        const parsed = JSON.parse(await response.text()) as { error?: { type?: string; message?: string } };
        const errorType = String(parsed.error?.type ?? '');
        const message = String(parsed.error?.message ?? '');
        // Anchored: the probe names one fixed model, so a plan-gated model
        // answers 403 UnauthorizedModelError ("your plan does not include …")
        // on a perfectly good key. An unanchored /auth/i matches inside
        // "Unauthorized" and would reject that key at add time, blaming the
        // key for an entitlement problem. Only a type that IS an auth error,
        // or a message that talks about the key itself, counts.
        authRejected = /^(?:auth|authentication|authorization)(?:_?error)?$/i.test(errorType)
          || /\b(?:invalid|bad|missing|expired|incorrect)\b[^.]{0,40}\bapi[ _-]?key\b/i.test(message)
          || /\bapi[ _-]?key\b[^.]{0,40}\b(?:invalid|not valid|expired|incorrect|missing)\b/i.test(message)
          || /\bauthentication (?:failed|error)\b/i.test(message);
      } catch {
        // An unparseable 401 is inconclusive, not proof of a bad key.
      }
      if (authRejected) {
        return 'OpenCode Go rejected this API key (authentication failed). Check the key and try again.';
      }
    } else {
      try {
        await response.body?.cancel?.();
      } catch { /* only auth rejections matter to the probe */ }
    }
  } catch {
    // Unreachable probe is inconclusive; the models fetch surfaces network errors.
  }
  return null;
}

/** Built-in providers available through `clodex providers add` or OAuth authentication. */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    authType: 'api',
    npm: '@ai-sdk/openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    signupUrl: 'https://platform.openai.com/api-keys',
    modelSource: 'api-list',
    supported: true,
  },
  {
    id: OPENCODE_GO_PROVIDER_ID,
    name: OPENCODE_GO_PROVIDER_NAME,
    authType: 'api',
    npm: '@ai-sdk/openai-compatible',
    defaultBaseUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
    modelsPath: '/models',
    signupUrl: 'https://opencode.ai',
    modelSource: 'api-list',
    // /models is availability data (answers without auth), so the shared
    // api-list validation cannot catch a bad key; probe before persisting.
    verifyCredential: verifyOpenCodeGoCredential,
    // A getter, not a value: PROVIDER_TEMPLATES is a module-level literal, so
    // an eager call would deep-clone the catalog entries on every single CLI
    // invocation — `clodex --help` included — for a list most commands never
    // read. Still returns an isolated copy per access, as callers expect.
    get staticModels() { return buildOpenCodeGoModels(); },
    staticModelPolicy: 'allowlist',
    preserveModelPricing: true,
    supported: true,
  },
  {
    id: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    authType: 'oauth',
    npm: '@ai-sdk/openai',
    signupUrl: 'https://chatgpt.com',
    modelSource: 'api-list',
    supported: true,
  },
];

export function listSupportedTemplates(): ProviderTemplate[] {
  return PROVIDER_TEMPLATES
    .filter(t => t.supported && t.authType === 'api' && t.addable !== false && !t.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Supported templates not yet present in the user's registry. */
export function listAddableTemplates(configuredIds: Iterable<string> = []): ProviderTemplate[] {
  const configured = new Set(configuredIds);
  return listSupportedTemplates().filter(t => !configured.has(t.id));
}

export function listVisibleOAuthTemplates(configuredIds: Iterable<string> = []): ProviderTemplate[] {
  const configured = new Set(configuredIds);
  return PROVIDER_TEMPLATES
    .filter(t => t.authType === 'oauth' && t.supported && t.addable !== false && !t.hidden && !configured.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplateById(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find(t => t.id === id);
}

export function filterTemplates(templates: ProviderTemplate[], query: string): ProviderTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return templates;
  return templates.filter(
    t =>
      t.id.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.npm.toLowerCase().includes(q),
  );
}
