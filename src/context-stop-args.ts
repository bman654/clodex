// Parsing for `--context <model-ref>=<stop>`, shared by the models and claude commands.

import { contextModeKey, parseContextStop, type ContextStop } from './context-modes.js';
import { canonicalModelAliasName, normalizeModelAliases } from './model-aliases.js';

export interface ContextStopAssignment {
  providerId: string;
  modelId: string;
  /** How the user spelled the model, so messages echo their own wording. */
  label: string;
  /** `null` clears a saved stop rather than selecting one. */
  stop: ContextStop | null;
}

function resolveModelReference(
  reference: string,
  aliases: unknown,
): { providerId: string; modelId: string } | { error: string } {
  const raw = reference.trim();
  const target = raw.startsWith('clodex:') ? raw.slice('clodex:'.length) : raw;
  const separator = target.indexOf(':');
  if (separator > 0 && separator < target.length - 1) {
    return {
      providerId: target.slice(0, separator).trim(),
      modelId: target.slice(separator + 1).trim(),
    };
  }

  const name = canonicalModelAliasName(target);
  const match = normalizeModelAliases(aliases).aliases.find(alias => alias.name === name);
  if (!match) {
    return {
      error: `No saved model alias named ${JSON.stringify(raw)}. `
        + 'Use a saved alias or the full clodex:<provider-id>:<model-id> form.',
    };
  }
  return { providerId: match.providerId, modelId: match.modelId };
}

export function parseContextStopAssignment(
  value: string,
  aliases: unknown,
): ContextStopAssignment | { error: string } {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) {
    return { error: 'Context stop must use <model>=standard|max|default|<tokens>.' };
  }

  const reference = value.slice(0, separator);
  const resolved = resolveModelReference(reference, aliases);
  if ('error' in resolved) return resolved;

  const stop = parseContextStop(value.slice(separator + 1));
  if (stop !== null && typeof stop === 'object') return stop;

  return {
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    label: reference.trim(),
    stop,
  };
}

/** Parse every `--context` argument, failing on the first bad one. */
export function parseContextStopAssignments(
  values: readonly string[],
  aliases: unknown,
): { assignments: ContextStopAssignment[] } | { error: string } {
  const assignments: ContextStopAssignment[] = [];
  for (const value of values) {
    const parsed = parseContextStopAssignment(value, aliases);
    if ('error' in parsed) return parsed;
    assignments.push(parsed);
  }
  return { assignments };
}

/** Session map for the resolver. A cleared stop falls back to `standard` for this run. */
export function sessionStopsFrom(
  assignments: readonly ContextStopAssignment[],
): Record<string, ContextStop> {
  const stops: Record<string, ContextStop> = Object.create(null);
  for (const assignment of assignments) {
    stops[contextModeKey(assignment.providerId, assignment.modelId)] = assignment.stop ?? 'standard';
  }
  return stops;
}

/** Saved map after applying assignments, with cleared entries removed. */
export function savedStopsAfter(
  current: Record<string, 'standard' | 'max' | number> | undefined,
  assignments: readonly ContextStopAssignment[],
): Record<string, 'standard' | 'max' | number> {
  const next: Record<string, 'standard' | 'max' | number> = { ...current };
  for (const assignment of assignments) {
    const key = contextModeKey(assignment.providerId, assignment.modelId);
    if (assignment.stop === null) delete next[key];
    else next[key] = assignment.stop;
  }
  return next;
}
