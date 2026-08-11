export const NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE = 'native-claude-code-oauth' as const;

/** Positive provenance required before clodex forwards or synthesizes client betas. */
export type AnthropicBetaProvenance = typeof NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE;

type AnthropicRouteShape = {
  modelFormat: string;
  authType?: 'api' | 'oauth' | 'none';
  anthropicBetaProvenance?: AnthropicBetaProvenance;
};

function isNativeAnthropicApiBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase().replace(/\.+$/, '') === 'api.anthropic.com'
      && parsed.port === ''
      && (parsed.pathname === '' || parsed.pathname === '/')
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

/**
 * Establish positive provenance while converting a configured provider/model
 * into an internal route. Authentication type alone is not capability proof:
 * generic OAuth and anonymous Anthropic-compatible endpoints fail closed.
 */
export function resolveAnthropicBetaProvenance(
  model: { modelFormat: string; baseUrl?: string },
  provider: { id: string; authType?: 'api' | 'oauth' | 'none' },
): AnthropicBetaProvenance | undefined {
  return model.modelFormat === 'anthropic'
    && provider.id === 'claude-code'
    && provider.authType === 'oauth'
    && isNativeAnthropicApiBaseUrl(model.baseUrl)
    ? NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE
    : undefined;
}

export function isNativeClaudeCodeOAuthBetaRoute(route: AnthropicRouteShape): boolean {
  return route.modelFormat === 'anthropic'
    && route.authType === 'oauth'
    && route.anthropicBetaProvenance === NATIVE_CLAUDE_CODE_OAUTH_BETA_PROVENANCE;
}

/** Default-deny policy for client-supplied experimental Anthropic betas. */
export function shouldDisableExperimentalAnthropicBetas(route: AnthropicRouteShape): boolean {
  return route.modelFormat === 'anthropic' && !isNativeClaudeCodeOAuthBetaRoute(route);
}

/** Canonicalize duplicate/list-valued inbound headers for the trusted local adapter hop. */
export function normalizeAnthropicBetaHeader(
  value: string | string[] | undefined,
): string | undefined {
  const flags = (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap(entry => entry.split(','))
    .map(entry => entry.trim())
    .filter(Boolean);
  const normalized = [...new Set(flags)].join(',');
  return normalized || undefined;
}
