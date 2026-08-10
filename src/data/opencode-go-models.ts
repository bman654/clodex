import models from './opencode-go-models.json';
import type { CachedModel } from '../registry/types.js';

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_PROVIDER_NAME = 'OpenCode Go';
export const OPENCODE_GO_COMPLETIONS_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go';
export const OPENCODE_GO_SOURCE = 'https://models.dev/api.json';
export const OPENCODE_GO_SOURCE_FETCHED_AT = '2026-08-08T20:10:24.208Z';

type OpenCodeGoModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

/**
 * Curated OpenCode Go models supported by Clodex.
 *
 * Metadata (name, context, cost, modalities) comes from OpenCode's own
 * catalog (models.dev); per-model wire transport and compatibility behavior
 * are clodex's live-validated knowledge in the updater script. The upstream
 * catalog mixes Anthropic Messages, Chat Completions, and Responses
 * transports. Clodex intentionally publishes only the first two;
 * Responses-only entries (currently Grok and mainline GPT) never enter the
 * provider allowlist.
 */
export function buildOpenCodeGoModels(): OpenCodeGoModel[] {
  return structuredClone(models) as unknown as OpenCodeGoModel[];
}
