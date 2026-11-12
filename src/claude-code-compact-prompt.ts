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

/** How a bundle spells a marker it renders, or `undefined` when it renders none. */
type MarkerSpelling =
  | { kind: 'literal' }
  | { kind: 'constant-prefix'; constant: string };

const MARKER_SEED_LENGTH = 8;
const DECLARED_BEFORE_ASSIGNMENT = /\b(?:var|let|const)\s+([\w$]+)=$/;

/**
 * Find the marker as Claude Code's builders render it, not only as one literal.
 *
 * 2.1.323 hoisted the opening of the compaction header into a constant
 * (`Hxn="CRITICAL: Respond with TEXT ONLY"`) that another prompt quotes, and the
 * builder interpolates it (`${Hxn}. Do NOT call any tools.`). The text sent to the
 * model is byte-for-byte what it was, so the runtime guard still fires, but the
 * sentence no longer occurs as one string in the bundle. Accept exactly that form:
 * a double-quoted string constant, declared first in a `var`/`let`/`const`
 * statement, that holds a prefix of the marker and is interpolated directly in
 * front of the rest of it, both in the same module. Minified names repeat across
 * modules (2.1.323 also has an unrelated `function Hxn`), so a name is only
 * meaningful inside the module that declares it. Anything looser would let a real
 * rewording pass.
 */
function findMarkerSpelling(
  modules: readonly string[],
  marker: string,
): MarkerSpelling | undefined {
  if (modules.some(module => module.includes(marker))) return { kind: 'literal' };
  const seed = marker.slice(0, MARKER_SEED_LENGTH);
  const opening = '"' + seed;
  for (const module of modules) {
    for (let at = module.indexOf(opening); at !== -1; at = module.indexOf(opening, at + 1)) {
      const close = module.indexOf('"', at + 1);
      if (close === -1) break;
      const value = module.slice(at + 1, close);
      if (!marker.startsWith(value)) continue;
      const constant = DECLARED_BEFORE_ASSIGNMENT.exec(module.slice(Math.max(0, at - 64), at))?.[1];
      if (constant === undefined) continue;
      if (module.includes('${' + constant + '}' + marker.slice(value.length))) {
        return { kind: 'constant-prefix', constant };
      }
    }
  }
  return undefined;
}

/**
 * Report which strict compaction-prompt markers a bundle no longer renders.
 *
 * Takes the bundle's modules separately, because the constant spelling is only
 * meaningful within one module; pass a single-element list for an unsplit bundle.
 */
export function checkClaudeCodeCompactPromptMarkers(
  modules: readonly string[],
): ClaudeCodeCompactPromptMarkerCheck {
  const entries = Object.entries(CLAUDE_CODE_COMPACT_PROMPT_MARKERS) as Array<
    [ClaudeCodeCompactPromptMarkerName, string]
  >;
  const missing: ClaudeCodeCompactPromptMarkerName[] = [];
  const assembled: string[] = [];
  for (const [name, marker] of entries) {
    const spelling = findMarkerSpelling(modules, marker);
    if (spelling === undefined) missing.push(name);
    else if (spelling.kind === 'constant-prefix') {
      assembled.push(`${name} assembled from constant ${spelling.constant}`);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      detail: `missing strict compaction prompt marker(s): ${missing.join(', ')}`,
    };
  }
  return {
    ok: true,
    missing,
    detail: 'both strict compaction prompt markers are present'
      + (assembled.length > 0 ? ` (${assembled.join('; ')})` : ''),
  };
}
