import { randomUUID } from 'node:crypto';
import models from './opencode-go-models.json';
import type { CachedModel } from '../registry/types.js';

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_PROVIDER_NAME = 'OpenCode Go';
export const OPENCODE_GO_COMPLETIONS_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go';
export const OPENCODE_GO_SOURCE = 'https://models.dev/api.json';
export const OPENCODE_GO_SOURCE_FETCHED_AT = '2026-09-11T08:20:44.219Z';

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

/** Used when the client sent no session id; one per process, never per request. */
const OPENCODE_GO_FALLBACK_SESSION_ID = randomUUID();

/**
 * OpenCode Go rejects any request that carries no session id — both
 * `/v1/messages` and `/v1/chat/completions` answer
 * `MissingSessionID: Request is missing x-opencode-session` (measured
 * 2026-09-11 against the live endpoint). The header lets Go pin a conversation
 * to one backend and keep its prefix cache warm, so forward Claude Code's own
 * session id where one is known and fall back to a stable per-process id.
 *
 * A model counts as Go by provider id, by the trimmed-fork `sourceBackend`
 * spelling, or by pointing at the Go base URL, so a custom-endpoint entry that
 * targets Go directly is covered too.
 */
export function openCodeGoSessionHeaders(
  model: { providerId?: string; sourceBackend?: unknown; apiUrl?: string; baseUrl?: string },
  claudeSessionId: string | undefined,
): Record<string, string> | undefined {
  const isGo = model.providerId === OPENCODE_GO_PROVIDER_ID
    || String(model.sourceBackend) === OPENCODE_GO_PROVIDER_ID
    || /^https:\/\/opencode\.ai\/zen\/go(\/|$)/.test(String(model.baseUrl ?? model.apiUrl ?? ''));
  if (!isGo) return undefined;
  return { 'x-opencode-session': claudeSessionId ?? OPENCODE_GO_FALLBACK_SESSION_ID };
}
