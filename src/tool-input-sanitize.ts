// tool-input-sanitize.ts — the single home of the tool-input filler-strip rule.
//
// Leaf module by design: it imports nothing from src/ so both consumers can
// use it regardless of their position in the import graph. Two call sites
// apply the same rule to the same data at different times:
//   - sdk-adapter.ts strips filler from tool input on the way DOWN to the
//     client (Claude Code forwards some tool inputs verbatim into server-side
//     API calls, e.g. WebSearch domain lists, where an empty list is a 400);
//   - oauth/responses-websocket.ts snapshots a chain head's function_call
//     arguments in that same downstream shape, so the client's echo can match
//     the head and the continuation survives (#84).
// If the rule ever forks between those two places, the echo diverges from the
// snapshot and #84 comes back silently under a different filler shape — which
// is why the rule lives here exactly once.

/**
 * Strip filler values GPT-family models emit for optional params instead of
 * omitting them: top-level `null` always, and empty arrays for properties the
 * tool's schema does not require. Required properties keep their empty arrays —
 * there an empty array is an intentional value (e.g. TodoWrite's `todos: []`
 * clears the list).
 *
 * The returned object is prototype-less so model-controlled keys like
 * `__proto__` are stored as ordinary own properties instead of silently
 * invoking the plain-object setter.
 *
 * Anything that is not a plain object is returned unchanged. A model can emit
 * arguments that parse to an array or a scalar, or that do not parse at all —
 * in which case the SDK hands the raw string through as the input. Iterating
 * those with `Object.entries` invents a character-index map
 * (`'{"path":'` -> `{"0":"{","1":"\""...}`), which is not what the model said
 * and is not what `sanitizedCallArguments` in oauth/responses-websocket.ts
 * records for the same call — it returns those shapes untouched. Passing them
 * through keeps the one shared rule single-valued, and lets the malformed
 * input reach the client as itself so it can be rejected honestly.
 */
export function sanitizeToolInput(
  input: unknown,
  requiredProps?: ReadonlySet<string>,
): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === null) continue;
    if (Array.isArray(v) && v.length === 0 && !requiredProps?.has(k)) continue;
    out[k] = v;
  }
  return out;
}
