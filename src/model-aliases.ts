import type { ModelAlias } from './types.js';
import { stripOneMContextSuffix } from './context-model-id.js';

const MODEL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_MODEL_ALIASES = new Set([
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'best',
  'opusplan',
  'inherit',
]);

export interface NormalizedModelAliases {
  aliases: ModelAlias[];
  rejected: ModelAlias[];
}

export function canonicalModelAliasName(name: string): string {
  return name.trim().toLowerCase();
}

export function isReservedModelAlias(name: string): boolean {
  return RESERVED_MODEL_ALIASES.has(
    stripOneMContextSuffix(canonicalModelAliasName(name)),
  );
}

export function isValidModelAlias(name: string): boolean {
  const canonical = canonicalModelAliasName(name);
  return MODEL_ALIAS_PATTERN.test(canonical) && !isReservedModelAlias(canonical);
}

/**
 * Produce the lowercase alias view consumed by patching and routing.
 *
 * Equivalent duplicates collapse to their first occurrence. If one canonical
 * name points at multiple targets, every occurrence is rejected so array order
 * cannot silently choose a route.
 */
export function normalizeModelAliases(value: unknown): NormalizedModelAliases {
  if (!Array.isArray(value)) return { aliases: [], rejected: [] };

  interface Candidate {
    source: ModelAlias;
    normalized?: ModelAlias;
    accepted?: boolean;
  }

  const candidates: Candidate[] = [];
  const groups = new Map<string, Candidate[]>();

  for (const item of value) {
    if (
      !item
      || typeof item !== 'object'
      || typeof item.name !== 'string'
      || typeof item.providerId !== 'string'
      || typeof item.modelId !== 'string'
    ) {
      continue;
    }

    const source = item as ModelAlias;
    const normalized = {
      name: canonicalModelAliasName(source.name),
      providerId: source.providerId.trim(),
      modelId: source.modelId.trim(),
    };
    const candidate: Candidate = { source };
    candidates.push(candidate);

    if (
      !isValidModelAlias(normalized.name)
      || !normalized.providerId
      || !normalized.modelId
    ) {
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
    if (targets.size === 1) group[0]!.accepted = true;
  }

  return {
    aliases: candidates
      .filter(candidate => candidate.accepted)
      .map(candidate => candidate.normalized!),
    rejected: candidates
      .filter(candidate => !candidate.accepted)
      .map(candidate => candidate.source),
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
