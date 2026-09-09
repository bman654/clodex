// tool-schema-sanitize.ts — drop `pattern` constraints a non-Anthropic provider cannot compile.
//
// Leaf module by design: it imports nothing from src/, like its sibling
// tool-input-sanitize.ts, so the translation path can use it from anywhere in
// the import graph.
//
// Claude Code writes its built-in tool schemas in the ECMAScript regex dialect
// (an MCP or plugin tool's schema comes from its author, in whatever dialect
// they wrote). OpenAI rejects every regex-valued position that python-jsonschema
// would: the 400 reads `Invalid schema for function 'X': '<pattern>' is not a
// 'regex'`, that library's format-checker wording, and locally its checker is a
// bare `re.compile`. That is behavioural evidence about the far side, not
// source-level knowledge of what it runs. Claude Code 2.1.266's Artifact tool
// spells its `field` constraint with Unicode property escapes
// (`[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}...]`), Python answers `bad escape \p`, and every
// request carrying that tool 400s before the model sees the turn — Artifact
// ships on every request, so the session was dead from `hello` onward (#194).
//
// Two regex-valued positions exist, and the far side compiles both: the
// `pattern` keyword, and every **key** of `patternProperties`
// (`patternProperties.propertyNames` carries `format: "regex"` in the 2020-12
// applicator vocabulary, and a bad key returns the same `is not a 'regex'`
// message). Only those two positions are edited, and only the constraint goes —
// never the property it constrains, and never a wildcard in its place. The
// schema the provider sees does become more permissive than the one Claude Code
// wrote: that is unavoidable, since the alternative is a 400. What it must not
// do is become *less* permissive.
//
// **Sanitizing only ever loosens.** That is the invariant the rest of this
// module protects, and `patternProperties` is the one place where removing a
// constraint would otherwise tighten: with a sibling `additionalProperties` or
// `unevaluatedProperties`, the dropped entry was the only thing *admitting* its
// keys, so removing it alone turns them from permitted into forbidden and the
// tool stops accepting input it used to. When an entry is dropped, the sibling
// closure keyword is therefore dropped too (`true` is already the permissive
// default and is left alone).
//
// The walk follows only **declared schema positions** (`properties` values,
// `items`, `anyOf`, `$defs`, …). Keywords that hold instance *data* rather than
// rules — `const`, `enum`, `default`, `examples` — are opaque. Inside `const`
// or `enum` a `pattern` member is a value the schema requires, so deleting it
// changes which instances validate; `default` and `examples` are annotations,
// where the reason is simply that instance data is not a schema and must not be
// rewritten as one.
//
// Simple lookahead and fixed-width lookbehind compile in both dialects, so
// Artifact's `collection` pattern (`^(?!\.\.?(?:\/|$))...`) is left alone.
// Two caveats, both deliberate:
//   - **Variable-width lookbehind** — alternated (`(?<=a|bb)`) or quantified
//     (`(?<=a+)`, `(?<=\d{2,3})`) — is legal in ECMAScript (ES2018) and
//     rejected by Python's `re` ("look-behind requires fixed-width pattern").
//     Recognising it needs a real regex parser, so this module does not, and
//     such a pattern would still 400. None of the 245 regexes in Claude Code
//     2.1.266's bundle that feed a tool schema uses one.
//   - The scanner is narrower than Python in other ways too — `[\w-.]` (a
//     shorthand escape as a range endpoint) and the JS `[^]` idiom compile in
//     ECMAScript and are rejected by Python. Those are reachable only from a
//     hand-written MCP or plugin schema, are not new here, and widening the
//     scanner to cover them is tracked separately.
//   - **Lookaround is reported rejected on OpenAI's strict structured-output
//     path** (vercel/ai#16021, SmartBear/smartbear-mcp#491 — reports, not
//     something verified here; the vercel maintainers could not reproduce it
//     from a synthetic case). clodex does not meet that path: `translateTools`
//     sends `strict: false` on `@ai-sdk/openai`, which covers both OpenAI
//     routes, and `@ai-sdk/openai-compatible` goes to Chat Completions, which
//     is non-strict by default. The explicit opt-out is load-bearing for
//     keeping Artifact's `collection` lookahead in the payload; if it is ever
//     removed, lookaround has to be stripped here too.
//
// What dropping a constraint costs depends on the tool, and the comfortable
// version of this claim is wrong. Claude Code does `inputSchema.safeParse` before
// executing, but only a built-in whose Zod schema carries the same constraint is
// still guarded — Artifact's `field` is (`field: s().regex(...)` in the 2.1.266
// bundle). A registered tool gets `c({}).passthrough()` as its `inputSchema` with
// the real schema parked in `inputJSONSchema`, and the MCP path checks only that
// `required` keys are present. So for an MCP or plugin tool the dropped regex is
// a genuinely lost guard, not just a lost hint: nothing revalidates it, and a
// bad value reaches the tool's own handler. That is still the better trade — the
// constraint was going to 400 the whole session otherwise — but it is a real
// cost, and it is why nothing here drops more than it must.

/**
 * True when `pattern` contains none of the Python-incompatible constructs this
 * targeted scanner recognizes — it is not a full `re` compatibility oracle (see
 * the variable-width-lookbehind caveat in the module header). Scans rather than
 * pattern-matches so an escaped backslash (`\\p`, a literal backslash followed
 * by `p` — compilable) is not mistaken for the Unicode property escape `\p`
 * that is not.
 */
export function isCompatiblePattern(pattern: string): boolean {
  // ECMAScript reading of `[`/`]`: an unescaped `]` closes the class, so `[]` is
  // the empty class. Escapes are still scanned inside a class — Artifact's
  // `[^\p{Cc}...]` is exactly that — but group syntax is not, so a class merely
  // *listing* `(`, `?` and `<` is not a named group.
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1];
      // \p{...} / \P{...}: Python has no Unicode property escapes ("bad escape \p").
      // \u{...}: the same u-flag family, and RegExp.source carries it into the
      // schema with the flag lost. Python answers "incomplete escape \u".
      // \x{...} is not the same family — it throws under `u`, and in a legacy
      // regex it means "x, 41 times", not a code point. It is stripped because a
      // schema author can still write the string and Python rejects it outright.
      if (
        (next === 'p' || next === 'P' || next === 'u' || next === 'x')
        && pattern[i + 2] === '{'
      ) return false;
      // \k<name>: a JS named backreference; Python spells it (?P=name) and
      // answers "bad escape \k".
      if (next === 'k' && pattern[i + 2] === '<') return false;
      i++; // an escaped character never starts a construct
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    // (?<name>...): a JS named group; Python spells it (?P<name>...). Lookbehind
    // is (?<= / (?<! in both dialects and stays.
    if (
      ch === '(' && pattern[i + 1] === '?' && pattern[i + 2] === '<'
      && pattern[i + 3] !== '=' && pattern[i + 3] !== '!'
    ) return false;
  }
  return true;
}

// Keywords whose value is a subschema, or an array of subschemas (draft-04/7
// spell `items` both ways). `sanitizeSchema` handles either shape.
//
// The membership is the union across every draft, not one of them: OpenAI's
// validator is not a single draft — one session compiled regexes under `$defs`
// (2019+), `prefixItems` (2020) and array-form `items` (<=2019) alike — so a
// keyword omitted here is a regex that reaches the far side and 400s.
const SUBSCHEMA_KEYWORDS = new Set([
  'items', 'prefixItems', 'additionalItems', 'unevaluatedItems',
  'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains',
  'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'contentSchema',
]);

// Keywords whose value is an object mapping *names* to subschemas. The keys are
// property names, never regexes, so they are never inspected — which is why a
// tool parameter named `pattern` (Grep has one) needs no special case.
// `dependencies` is draft-07's union of the two: each value is either a
// subschema or a plain array of property names, and `sanitizeSchema` returns
// the array form by identity.
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  'properties', '$defs', 'definitions', 'dependentSchemas', 'dependencies',
]);

/**
 * Return `schema` with the regexes `isCompatiblePattern` recognizes as
 * Python-incompatible removed, everywhere the walk reaches: the `pattern`
 * keyword, and any `patternProperties` entry whose key is incompatible (the
 * entry goes with its key, since the key is the constraint). "Everywhere the
 * walk reaches" is the allowlist below, not literally every nested object —
 * and neither the scanner nor the allowlist claims to be exhaustive; see the
 * module header for the known gaps.
 *
 * `schema` is never mutated. Unchanged subtrees are returned by identity, so a
 * schema with nothing to strip is not rebuilt.
 */
export function sanitizeToolSchema(schema: unknown): unknown {
  return sanitizeSchema(schema);
}

function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map(entry => {
      const next = sanitizeSchema(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? out : node;
  }
  if (!node || typeof node !== 'object') return node;

  const record = node as Record<string, unknown>;
  // Dropping a `patternProperties` entry removes the only thing that made its
  // keys *allowed*, so a sibling `additionalProperties`/`unevaluatedProperties`
  // would silently turn them from permitted into forbidden — a narrower schema,
  // which is exactly what this module promises never to produce. Decide it
  // before the walk, because the closure keyword can appear either side of
  // `patternProperties` in key order.
  const patternProps = 'patternProperties' in record
    ? sanitizePatternProperties(record.patternProperties)
    : undefined;
  const openClosure = patternProps?.dropped === true;

  let changed = false;
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === 'patternProperties' && patternProps) {
      changed ||= patternProps.value !== value;
      entries.push([key, patternProps.value]);
      continue;
    }
    // `true` is already the permissive default; anything else can only forbid
    // or re-constrain a key the dropped entry used to admit.
    if (
      openClosure && value !== true
      && (key === 'additionalProperties' || key === 'unevaluatedProperties')
    ) {
      changed = true;
      continue;
    }
    if (key === 'pattern') {
      // A non-string here is a malformed `pattern` keyword, not a schema. It
      // is left exactly as written — this module's job is to remove regexes the
      // far side cannot compile, not to repair schemas — and it is not walked.
      if (typeof value === 'string' && !isCompatiblePattern(value)) {
        changed = true;
        continue;
      }
      entries.push([key, value]);
      continue;
    }
    let next = value;
    if (SUBSCHEMA_KEYWORDS.has(key)) next = sanitizeSchema(value);
    else if (SUBSCHEMA_MAP_KEYWORDS.has(key)) next = sanitizeSchemaMap(value);
    changed ||= next !== value;
    entries.push([key, next]);
  }
  // fromEntries defines rather than assigns, so a schema property named
  // `__proto__` survives the copy instead of hitting Object.prototype's setter.
  return changed ? Object.fromEntries(entries) : node;
}

/** Walk the values of a name-keyed subschema map; leave every key untouched. */
function sanitizeSchemaMap(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  let changed = false;
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const next = sanitizeSchema(value);
    changed ||= next !== value;
    entries.push([key, next]);
  }
  return changed ? Object.fromEntries(entries) : node;
}

/**
 * Drop entries whose key is a regex recognized as Python-incompatible; walk
 * the rest.
 * `dropped` tells the caller whether a key went, so it can open a sibling
 * closure keyword rather than let the removal narrow the schema.
 */
function sanitizePatternProperties(node: unknown): { value: unknown; dropped: boolean } {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { value: node, dropped: false };
  let changed = false;
  let dropped = false;
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!isCompatiblePattern(key)) {
      changed = true;
      dropped = true;
      continue;
    }
    const next = sanitizeSchema(value);
    changed ||= next !== value;
    entries.push([key, next]);
  }
  return { value: changed ? Object.fromEntries(entries) : node, dropped };
}
