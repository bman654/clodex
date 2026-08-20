// Shared provider-shape predicates, so callers do not each re-derive them.

import type { RegistryProvider } from './types.js';

/**
 * The ChatGPT/Codex OAuth provider. Matched on auth type plus template rather than a
 * single id, because the record predating the rename still identifies as `openai`.
 */
export function isChatGptOAuthProvider(
  provider: Pick<RegistryProvider, 'id' | 'templateId' | 'authType'>,
): boolean {
  if (provider.authType !== 'oauth') return false;
  const template = provider.templateId ?? provider.id;
  return template === 'openai' || template === 'openai-oauth' || provider.id === 'openai-oauth';
}
