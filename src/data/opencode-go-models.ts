import models from './opencode-go-models.json';
import type { CachedModel } from '../registry/types.js';

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_PROVIDER_NAME = 'OpenCode Go';
export const OPENCODE_GO_COMPLETIONS_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go';
export const OPENCODE_GO_SOURCE_REPOSITORY = 'monotykamary/pi-opencode-go-provider';
export const OPENCODE_GO_SOURCE_REF = 'b1f0428f699dc3cb50d6553d5a3a3a99c8371836';

type OpenCodeGoModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

/**
 * Curated OpenCode Go models supported by Clodex.
 *
 * The upstream catalog mixes Anthropic Messages, Chat Completions, and
 * Responses transports. Clodex intentionally publishes only the first two;
 * Responses-only entries (currently Grok) never enter the provider allowlist.
 */
export function buildOpenCodeGoModels(): OpenCodeGoModel[] {
  return structuredClone(models) as unknown as OpenCodeGoModel[];
}
