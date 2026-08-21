// Resolved model metadata for saved favourites, as JSON: the machine-readable twin
// of `models --list`. It reports clodex's own resolved state rather than any one
// consumer's config schema, so a wrapper maps it to whatever shape it needs.

import { projectNativeEffort } from './patch-transforms.js';
import { buildDesiredPatchConfig, type PatchModelMeta } from './patcher.js';

export interface ModelContextMetadata {
  /** Which stop produced these numbers: `standard`, `max`, or an explicit count. */
  stop: 'standard' | 'max' | number;
  /** Window before the model's headroom percentage. */
  raw?: number;
  /** Window a client should actually fill. */
  effective?: number;
  effectivePercent?: number;
  /** Highest raw window the model accepts, when one is known. */
  max?: number;
}

export interface ModelEffortMetadata {
  /**
   * Levels a patched Claude Code accepts. Providers advertise values it rejects
   * outright, such as `none`, so consumers get the projected ladder and the raw
   * provider list separately rather than having to know which is safe.
   */
  levels: string[];
  default: string;
  providerLevels?: string[];
}

export interface ModelMetadata {
  id: string;
  providerId?: string;
  modelId?: string;
  alias?: string;
  displayName?: string;
  context: ModelContextMetadata;
  maxOutputTokens?: number;
  /** Input size above which the provider bills the whole request at a higher rate. */
  pricingBoundary?: number;
  effort?: ModelEffortMetadata;
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function effortFor(meta: PatchModelMeta): ModelEffortMetadata | undefined {
  const projected = projectNativeEffort(meta.effort);
  if (!projected) return undefined;
  const declared = meta.effort?.defaultLevel;
  return {
    levels: projected.levels,
    default: declared !== undefined && projected.levels.includes(declared)
      ? declared
      : projected.defaultLevel,
    ...(meta.effort ? { providerLevels: meta.effort.levels } : {}),
  };
}

function metadataFor(id: string, meta: PatchModelMeta, alias?: string): ModelMetadata {
  const effective = positive(meta.contextWindow);
  const effort = effortFor(meta);
  return {
    id,
    ...(meta.providerId ? { providerId: meta.providerId } : {}),
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...(alias ? { alias } : {}),
    ...(meta.displayName?.trim() ? { displayName: meta.displayName.trim() } : {}),
    context: {
      stop: meta.contextStop ?? 'standard',
      ...(positive(meta.rawContextWindow) === undefined
        ? {}
        : { raw: meta.rawContextWindow }),
      ...(effective === undefined ? {} : { effective }),
      ...(positive(meta.effectiveContextPercent) === undefined
        ? {}
        : { effectivePercent: meta.effectiveContextPercent }),
      ...(positive(meta.maxContextWindow) === undefined ? {} : { max: meta.maxContextWindow }),
    },
    ...(positive(meta.maxOutputTokens) === undefined
      ? {}
      : { maxOutputTokens: meta.maxOutputTokens }),
    ...(positive(meta.pricingBoundary) === undefined
      ? {}
      : { pricingBoundary: meta.pricingBoundary }),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Resolved metadata for every saved favourite, in the same order `--list` prints.
 *
 * Session-aware: a launch-scoped `--context` is reported here, because this surface
 * describes what the current run resolves to rather than what is baked into a binary.
 */
export function buildModelMetadata(): ModelMetadata[] {
  const desired = buildDesiredPatchConfig({ sessionStops: true });
  return Object.entries(desired.config).map(([id, entry]) =>
    metadataFor(id, desired.metaById[id] ?? {}, entry.alias),
  );
}

/** One line, so a shell can capture it straight into a variable. */
export function formatModelMetadata(entries: readonly ModelMetadata[]): string {
  return JSON.stringify(entries);
}
