import models from './opencode-go-models.json';
import type { CachedModel } from '../registry/types.js';

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_PROVIDER_NAME = 'OpenCode Go';
export const OPENCODE_GO_COMPLETIONS_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go';
/**
 * Provenance of the catalog above, mirrored from
 * `src/data/opencode-go-cli-snapshot.json` by
 * `pnpm update:opencode-go`, and re-verified offline by
 * `pnpm update:opencode-go -- --check`.
 *
 * MIRRORED, not imported: the snapshot is maintainer input, so shipping it
 * into the runtime bundle would put an 18-model resolver dump — including the
 * Responses-transport entries this provider deliberately never routes — behind
 * every launch. These constants let a diagnostic name the pinned capture
 * without any of that.
 *
 * `OPENCODE_GO_SOURCE_MODELS_SHA256` is the digest of the snapshot's own
 * normalized rows: an integrity/reproducibility marker for which capture the
 * catalog was generated from. It authenticates nothing about the upstream
 * release, and nothing here fetches or verifies one.
 */
export const OPENCODE_GO_SOURCE = 'opencode --pure models opencode-go --verbose';
export const OPENCODE_GO_SOURCE_FETCHED_AT = '2026-08-09T17:47:18Z';
export const OPENCODE_GO_SOURCE_VERSION = '1.18.15';
export const OPENCODE_GO_SOURCE_RELEASE_COMMIT = 'd7b115f623760e68a4749d16508a9eca350f246f';
export const OPENCODE_GO_SOURCE_MODELS_SHA256 = 'fa41e01da5fe41fb08e75b37adf1c5404902489c4dc76d390e5209f555897cb4';

type OpenCodeGoModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

/**
 * Curated OpenCode Go models supported by Clodex.
 *
 * Metadata (name, context, cost, modalities) comes from the committed
 * snapshot of OpenCode's own model resolver; per-model wire transport and
 * compatibility behavior are clodex's live-validated knowledge in the updater
 * script, which cross-checks them against the snapshot and fails closed on an
 * unreviewed divergence. The resolver catalog mixes Anthropic Messages, Chat
 * Completions, and Responses transports. Clodex publishes only the routes it
 * has exercised; entries the resolver routes over Responses (currently Grok)
 * never enter the provider allowlist.
 */
export function buildOpenCodeGoModels(): OpenCodeGoModel[] {
  return structuredClone(models) as unknown as OpenCodeGoModel[];
}
