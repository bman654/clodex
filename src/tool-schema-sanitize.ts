// tool-schema-sanitize.ts — drop `pattern` constraints a non-Anthropic provider cannot compile.
//
// Leaf module by design: it imports nothing from src/, like its sibling
// tool-input-sanitize.ts, so the translation path can use it from anywhere in
// the import graph.
//
// Claude Code writes its tool schemas in the ECMAScript regex dialect. OpenAI
// validates every `pattern` by compiling it with Python's `re` — the 400 reads
// `Invalid schema for function 'X': '<pattern>' is not a 'regex'`, which is
// jsonschema's format-checker wording — and the two dialects do not agree.
// Claude Code 2.1.266's Artifact tool spells its `field` constraint with
// Unicode property escapes (`[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}...]`), Python's `re`
// answers `bad escape \p`, and every OpenAI-routed request 400s before the
// model sees the turn — the tool is sent on every request, so the session is
// dead from `hello` onward (#194).
//
// The dialects agree on more than the issue reports assume: lookahead and
// lookbehind compile in both, so Artifact's `collection` pattern
// (`^(?!\.\.?(?:\/|$))...`) is left alone. Only the constructs Python actually
// rejects are removed, and only the `pattern` keyword goes — never the property
// it constrains, and never a wildcard in its place, so nothing in the schema
// starts claiming something untrue.
//
// Dropping the keyword loses a hint, not a guard: Claude Code validates tool
// input against its own schema before executing, so a value the pattern would
// have rejected still fails there, as a tool_result the model can retry.

/**
 * True when Python's `re` can compile `pattern`, which is what OpenAI's schema
 * validator does with it. Scans rather than pattern-matches so an escaped
 * backslash (`\\p`, a literal backslash followed by `p` — compilable) is not
 * mistaken for the Unicode property escape `\p` that is not.
 */
export function isCompatiblePattern(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      const next = pattern[i + 1];
      // \p{...} / \P{...}: Python has no Unicode property escapes ("bad escape \p").
      if ((next === 'p' || next === 'P') && pattern[i + 2] === '{') return false;
      // \k<name>: a JS named backreference; Python spells it (?P=name).
      if (next === 'k' && pattern[i + 2] === '<') return false;
      i++; // an escaped character never starts a construct
      continue;
    }
    // (?<name>...): a JS named group; Python spells it (?P<name>...). Lookbehind
    // is (?<= / (?<! in both dialects and stays.
    if (
      pattern[i] === '(' && pattern[i + 1] === '?' && pattern[i + 2] === '<'
      && pattern[i + 3] !== '=' && pattern[i + 3] !== '!'
    ) return false;
  }
  return true;
}

/**
 * Return `schema` with every `pattern` keyword Python's `re` cannot compile
 * removed, at any depth (`properties`, `items`, `anyOf`, `$defs`, …).
 *
 * A `pattern` whose value is not a string is a property of the tool named
 * `pattern` (Grep has one) rather than the keyword, and is walked like any
 * other subschema. Unchanged subtrees are returned by identity, so a schema
 * with nothing to strip — every schema but Artifact's, today — is not rebuilt.
 */
export function sanitizeToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const out = schema.map(entry => {
      const next = sanitizeToolSchema(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? out : schema;
  }
  if (!schema || typeof schema !== 'object') return schema;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'pattern' && typeof value === 'string') {
      if (!isCompatiblePattern(value)) {
        changed = true;
        continue;
      }
      out[key] = value;
      continue;
    }
    const next = sanitizeToolSchema(value);
    changed ||= next !== value;
    out[key] = next;
  }
  return changed ? out : schema;
}
