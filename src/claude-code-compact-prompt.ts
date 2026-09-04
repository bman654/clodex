/**
 * Verbatim Claude Code compaction-prompt text that clodex depends on.
 *
 * The runtime guard and the per-build release probe both import this object so
 * a clodex marker update cannot leave either one checking a stale private copy.
 */
export const CLAUDE_CODE_COMPACT_PROMPT_MARKERS = Object.freeze({
  start: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
  end: 'REMINDER: Do NOT call any tools. Respond with plain text only',
} as const);

export type ClaudeCodeCompactPromptMarkerName =
  keyof typeof CLAUDE_CODE_COMPACT_PROMPT_MARKERS;

export interface ClaudeCodeCompactPromptMarkerCheck {
  ok: boolean;
  missing: ClaudeCodeCompactPromptMarkerName[];
  detail: string;
}

/** Report which strict compaction-prompt markers are absent from a bundle. */
export function checkClaudeCodeCompactPromptMarkers(
  source: string,
): ClaudeCodeCompactPromptMarkerCheck {
  const entries = Object.entries(CLAUDE_CODE_COMPACT_PROMPT_MARKERS) as Array<
    [ClaudeCodeCompactPromptMarkerName, string]
  >;
  const missing = entries
    .filter(([, marker]) => !source.includes(marker))
    .map(([name]) => name);
  return {
    ok: missing.length === 0,
    missing,
    detail: missing.length === 0
      ? 'both strict compaction prompt markers are present'
      : `missing strict compaction prompt marker(s): ${missing.join(', ')}`,
  };
}
