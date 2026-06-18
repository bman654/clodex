// Codex App config.toml content — root keys + model_providers (not CLI sidecar profile).
import { codexProviderEnvKey, type CodexRoute } from './routing.js';

export const CODEX_APP_PROVIDER_ID = 'relay-ai-launch-codex-app';
export const PREVIEW_PROXY_PORT = 54321;

/** Codex app expects provider-prefixed model keys for custom providers (see openai/codex#24007). */
export function codexAppModelSlug(rawModelId: string): string {
  const bare = rawModelId.startsWith('models/') ? rawModelId.slice('models/'.length) : rawModelId;
  return `${CODEX_APP_PROVIDER_ID}/${bare}`;
}

export function parseCodexAppModelSlug(modelKey: string): string {
  const prefix = `${CODEX_APP_PROVIDER_ID}/`;
  return modelKey.startsWith(prefix) ? modelKey.slice(prefix.length) : modelKey;
}

export interface CodexAppConfigSpec {
  route: CodexRoute;
  proxyPort?: number;
  catalogPath: string;
  /** Shown as model_providers.*.name in Codex (best-effort; app may still label "Custom"). */
  providerDisplayName?: string;
}

export interface CodexAppProviderBlock {
  name: string;
  base_url: string;
  wire_api: string;
  env_key?: string;
  /** Unlocks Codex desktop model picker for custom providers (openai/codex#10867). */
  requires_openai_auth?: boolean;
}

export function buildCodexAppProviderBlock(spec: CodexAppConfigSpec): CodexAppProviderBlock {
  const { route, proxyPort } = spec;
  const providerName = spec.providerDisplayName ?? 'relay-ai';
  if (route.tier === 'direct') {
    return {
      name: providerName,
      base_url: route.baseURL ?? 'https://api.openai.com/v1',
      wire_api: 'responses',
      env_key: codexProviderEnvKey(route.providerId),
    };
  }
  return {
    name: providerName,
    base_url: `http://127.0.0.1:${proxyPort}/v1`,
    wire_api: 'responses',
    requires_openai_auth: true,
  };
}

export function buildCodexAppRootConfig(spec: CodexAppConfigSpec): {
  model: string;
  model_provider: string;
  model_catalog_json: string;
  model_providers: Record<string, CodexAppProviderBlock>;
} {
  const slug = codexAppModelSlug(spec.route.modelId);
  return {
    model: slug,
    model_provider: CODEX_APP_PROVIDER_ID,
    model_catalog_json: spec.catalogPath,
    model_providers: {
      [CODEX_APP_PROVIDER_ID]: buildCodexAppProviderBlock(spec),
    },
  };
}
