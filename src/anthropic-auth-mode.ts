import type { RegistryProvider } from './registry/types.js';

/**
 * Positive provenance for Anthropic-compatible endpoints whose API-key
 * contract is `x-api-key` only. Absence deliberately preserves the historical
 * dual Authorization + x-api-key envelope used by other proxied gateways.
 */
export const ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE = 'x-api-key-only' as const;

export type AnthropicAuthMode = typeof ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE;

/** Derive the runtime auth envelope from the registry template that proved it. */
export function resolveAnthropicAuthMode(
  provider: Pick<RegistryProvider, 'templateId'>,
): AnthropicAuthMode | undefined {
  return provider.templateId === 'custom-anthropic' || provider.templateId === 'anthropic'
    ? ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE
    : undefined;
}
