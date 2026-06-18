// Claude Code treats third-party routes as 200K unless the model id ends with [1m].
import { DEFAULT_CONTEXT_WINDOW, resolveContextWindow } from './context-window.js';

export const ONE_M_CONTEXT_SUFFIX = '[1m]';

export function stripOneMContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, '');
}

export function hasOneMContextSuffix(modelId: string): boolean {
  return /\[1m\]$/i.test(modelId);
}

/** Model id to pass to Claude Code (--model / ANTHROPIC_MODEL) for accurate context UX. */
export function claudeCodeClientModelId(modelId: string, contextWindow?: number): string {
  const bare = stripOneMContextSuffix(modelId);
  const window = resolveContextWindow(bare, contextWindow);
  if (window > DEFAULT_CONTEXT_WINDOW) {
    return `${bare}${ONE_M_CONTEXT_SUFFIX}`;
  }
  return bare;
}

/** Variants to match inbound Claude Code model ids against proxy catalog aliases. */
export function routeLookupIds(id: string): string[] {
  const bare = stripOneMContextSuffix(id);
  const googleBare = bare.startsWith('models/') ? bare.slice('models/'.length) : bare;
  return [...new Set([
    id,
    bare,
    `${bare}${ONE_M_CONTEXT_SUFFIX}`,
    googleBare,
    `${googleBare}${ONE_M_CONTEXT_SUFFIX}`,
    `models/${googleBare}`,
    `models/${bare}`,
  ])];
}
