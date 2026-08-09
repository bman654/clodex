import type { ModelAlias } from './types.js';
import { stripOneMContextSuffix } from './context-model-id.js';

const MODEL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Derived from Claude Code v2.1.220's built-in model resolver and sentinels.
const RESERVED_MODEL_ALIASES = new Set([
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'best',
  'default',
  'opusplan',
  'inherit',
]);

export interface NormalizedModelAliases {
  aliases: ModelAlias[];
  accepted: NormalizedModelAliasSource[];
  rejected: StoredModelAlias[];
  rejections: ModelAliasRejection[];
}

export type ModelAliasRejectionReason =
  | 'invalid-name'
  | 'reserved-name'
  | 'invalid-target'
  | 'conflicting-targets'
  | 'target-not-favorite'
  | 'target-not-exposed';

/** Unvalidated saved alias record retained exactly as read from configuration. */
export interface StoredModelAlias {
  name: string;
  providerId?: unknown;
  modelId?: unknown;
}

export interface NormalizedModelAliasSource {
  alias: ModelAlias;
  /** First saved record retained for compatibility with single-source consumers. */
  source: StoredModelAlias;
  /** Every equivalent saved record that collapsed to this canonical alias. */
  sources: StoredModelAlias[];
}

export interface ModelAliasRejection {
  alias: StoredModelAlias;
  reason: ModelAliasRejectionReason;
}

export function canonicalModelAliasName(name: string): string {
  return name.trim().toLowerCase();
}

export function isReservedModelAlias(name: string): boolean {
  return RESERVED_MODEL_ALIASES.has(
    stripOneMContextSuffix(canonicalModelAliasName(name)),
  );
}

export function isModelAliasNameSyntax(name: string): boolean {
  return MODEL_ALIAS_PATTERN.test(canonicalModelAliasName(name));
}

export function isValidModelAlias(name: string): boolean {
  const canonical = canonicalModelAliasName(name);
  return isModelAliasNameSyntax(canonical) && !isReservedModelAlias(canonical);
}

export function modelAliasMatchesName(value: unknown, name: string): boolean {
  if (!value || typeof value !== 'object' || !('name' in value)) return false;
  const candidate = value.name;
  return typeof candidate === 'string'
    && canonicalModelAliasName(candidate) === canonicalModelAliasName(name);
}

export function modelAliasMatchesStoredName(value: unknown, name: string): boolean {
  if (!value || typeof value !== 'object' || !('name' in value)) return false;
  const candidate = value.name;
  if (typeof candidate !== 'string') return false;
  const requested = name.trim();
  return isModelAliasNameSyntax(requested)
    ? canonicalModelAliasName(candidate) === canonicalModelAliasName(requested)
    : candidate.trim() === requested;
}

export function describeModelAliasRejection(reason: ModelAliasRejectionReason): string {
  switch (reason) {
    case 'invalid-name':
      return 'invalid name';
    case 'reserved-name':
      return 'reserved client name';
    case 'invalid-target':
      return 'invalid target';
    case 'conflicting-targets':
      return 'conflicting targets';
    case 'target-not-favorite':
      return 'target is not a saved favorite';
    case 'target-not-exposed':
      return 'target is outside the active Claude Code catalog';
  }
}

/**
 * Produce the lowercase alias view consumed by patching and routing.
 *
 * Equivalent duplicates collapse to their first occurrence. If one canonical
 * name points at multiple targets, every occurrence is rejected so array order
 * cannot silently choose a route.
 */
export function normalizeModelAliases(value: unknown): NormalizedModelAliases {
  if (value === undefined) {
    return { aliases: [], accepted: [], rejected: [], rejections: [] };
  }
  if (!Array.isArray(value)) {
    throw new TypeError('Saved model aliases are malformed: "modelAliases" must be an array.');
  }

  interface Candidate {
    source: StoredModelAlias;
    normalized?: ModelAlias;
    accepted?: boolean;
    sources?: StoredModelAlias[];
    rejectionReason?: ModelAliasRejectionReason;
  }

  const candidates: Candidate[] = [];
  const groups = new Map<string, Candidate[]>();

  for (const [index, item] of value.entries()) {
    if (
      !item
      || typeof item !== 'object'
      || typeof item.name !== 'string'
    ) {
      throw new TypeError(
        `Saved model aliases are malformed: "modelAliases[${index}]" `
        + 'must be an object with a string "name".',
      );
    }

    const source = item as StoredModelAlias;
    const candidate: Candidate = { source };
    candidates.push(candidate);

    if (
      typeof source.providerId !== 'string'
      || typeof source.modelId !== 'string'
    ) {
      candidate.rejectionReason = 'invalid-target';
      continue;
    }

    const normalized = {
      name: canonicalModelAliasName(source.name),
      providerId: source.providerId,
      modelId: source.modelId,
    };

    if (!isModelAliasNameSyntax(normalized.name)) {
      candidate.rejectionReason = 'invalid-name';
      continue;
    }
    if (isReservedModelAlias(normalized.name)) {
      candidate.rejectionReason = 'reserved-name';
      continue;
    }
    if (!normalized.providerId.trim() || !normalized.modelId.trim()) {
      candidate.rejectionReason = 'invalid-target';
      continue;
    }

    candidate.normalized = normalized;
    const group = groups.get(normalized.name) ?? [];
    group.push(candidate);
    groups.set(normalized.name, group);
  }

  for (const group of groups.values()) {
    const targets = new Set(
      group.map(candidate => (
        `${candidate.normalized!.providerId}\0${candidate.normalized!.modelId}`
      )),
    );
    if (targets.size === 1) {
      group[0]!.accepted = true;
      group[0]!.sources = group.map(candidate => candidate.source);
    } else {
      for (const candidate of group) candidate.rejectionReason = 'conflicting-targets';
    }
  }

  const rejections = candidates
    .filter((candidate): candidate is Candidate & { rejectionReason: ModelAliasRejectionReason } => (
      candidate.rejectionReason !== undefined
    ))
    .map(candidate => ({
      alias: candidate.source,
      reason: candidate.rejectionReason,
    }));
  const accepted = candidates
    .filter((candidate): candidate is Candidate & { normalized: ModelAlias } => (
      candidate.accepted === true && candidate.normalized !== undefined
    ))
    .map(candidate => ({
      alias: candidate.normalized,
      source: candidate.source,
      sources: candidate.sources ?? [candidate.source],
    }));

  return {
    aliases: accepted.map(entry => entry.alias),
    accepted,
    rejected: rejections.map(rejection => rejection.alias),
    rejections,
  };
}

/** Parse `luna=clodex:openai-oauth:gpt-5.6-luna` (the `clodex:` prefix is optional). */
export function parseModelAliasAssignment(value: string): ModelAlias | { error: string } {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) {
    return { error: 'Alias must use name=clodex:<provider-id>:<model-id>.' };
  }

  const name = canonicalModelAliasName(value.slice(0, separator));
  if (!MODEL_ALIAS_PATTERN.test(name)) {
    return { error: 'Alias names must be 1-64 letters, numbers, dots, underscores, or hyphens.' };
  }
  if (isReservedModelAlias(name)) {
    return { error: 'That alias name is reserved by the client.' };
  }

  const rawTarget = value.slice(separator + 1).trim();
  const target = rawTarget.startsWith('clodex:') ? rawTarget.slice('clodex:'.length) : rawTarget;
  const targetSeparator = target.indexOf(':');
  const providerId = target.slice(0, targetSeparator).trim();
  const modelId = stripOneMContextSuffix(target.slice(targetSeparator + 1).trim());
  if (
    targetSeparator < 1
    || targetSeparator === target.length - 1
    || !providerId
    || !modelId
  ) {
    return { error: 'Alias target must use clodex:<provider-id>:<model-id>.' };
  }

  return {
    name,
    providerId,
    // `models --list` prints Claude's synthetic context suffix. It is a client
    // routing hint, not part of the provider catalog id stored in favorites.
    modelId,
  };
}

export function modelAliasTarget(alias: Pick<ModelAlias, 'providerId' | 'modelId'>): string {
  return `clodex:${alias.providerId}:${alias.modelId}`;
}
