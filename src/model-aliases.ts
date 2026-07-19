import type { ModelAlias } from './types.js';
import { stripOneMContextSuffix } from './context-model-id.js';

const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidModelAlias(name: string): boolean {
  return MODEL_ALIAS_PATTERN.test(name);
}

/** Parse `luna=clodex:openai-oauth:gpt-5.6-luna` (the `clodex:` prefix is optional). */
export function parseModelAliasAssignment(value: string): ModelAlias | { error: string } {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) {
    return { error: 'Alias must use name=clodex:<provider-id>:<model-id>.' };
  }

  const name = value.slice(0, separator).trim();
  if (!isValidModelAlias(name)) {
    return { error: 'Alias names must be 1-64 letters, numbers, dots, underscores, or hyphens.' };
  }

  const rawTarget = value.slice(separator + 1).trim();
  const target = rawTarget.startsWith('clodex:') ? rawTarget.slice('clodex:'.length) : rawTarget;
  const targetSeparator = target.indexOf(':');
  if (targetSeparator < 1 || targetSeparator === target.length - 1) {
    return { error: 'Alias target must use clodex:<provider-id>:<model-id>.' };
  }

  return {
    name,
    providerId: target.slice(0, targetSeparator),
    // `models --list` prints Claude's synthetic context suffix. It is a client
    // routing hint, not part of the provider catalog id stored in favorites.
    modelId: stripOneMContextSuffix(target.slice(targetSeparator + 1)),
  };
}

export function modelAliasTarget(alias: Pick<ModelAlias, 'providerId' | 'modelId'>): string {
  return `clodex:${alias.providerId}:${alias.modelId}`;
}
