// tool-input-coerce.ts — the scalar re-typing Claude Code applies to a tool
// call's arguments, mirrored so a chain head can recognise its own echo.
//
// Leaf module by design, like tool-input-sanitize.ts: it imports nothing from
// src/. Its one consumer is oauth/responses-websocket.ts, which normalizes BOTH
// sides of a head comparison with it (issue #225). It is not applied to what
// reaches the client or what goes upstream.
//
// What the client does (read out of the 2.1.273 bundle and captured against
// 2.1.267, 2.1.270 and 2.1.273 in bypass, `--allowedTools` and `acceptEdits`):
// when an assistant message arrives, each tool call's arguments are rewritten
// against the tool's schema before the message is stored, and the stored form
// is what the next request echoes. Two client rules do it:
//   - a generic repair (`qKe` → `OYs`, L12552) that runs on EVERY tool and
//     JSON-parses a string for any top-level property whose schema resolves to
//     number/integer/boolean — keeping a number only if it prints back
//     identically, keeping a boolean after one BOM strip with no print-back
//     check. It skips built-in properties declared through a zod preprocess
//     pipe, which is what limits its coverage on built-ins;
//   - per-tool cases (`rW`, L11539) that re-type Bash `timeout` and its two
//     booleans and Read `offset` through those preprocessors (`UF` L9822: trim,
//     `/^[-+]?\d+(\.\d+)?$/`, `Number`; `k1` L7356: exactly "true"/"false"),
//     and fill TaskOutput `block`/`timeout`. Bash is all-or-nothing: one value
//     the strict parse rejects, or one unknown key, and the per-tool step is
//     skipped — the transcript keeps the generic repair's output (the scalar
//     strings untouched, unknown key included), not necessarily the exact
//     model input, since the generic repair may already have changed a field.
// So Bash, Read (`offset` only), ToolSearch, Agent, TaskOutput and MCP tools ARE
// re-typed on the transcript; PowerShell, Grep and CronCreate, whose scalars
// are all preprocess pipes with no per-tool case, are NOT.
//
// clodex cannot tell from the wire schema which client rule a property falls
// under, so this accepts the UNION of the two: every spelling either rule
// re-types. That is safe under both-sides normalization because a spelling maps
// to the number or boolean it denotes: distinct values with at most 15
// significant digits never become equal (DBL_DIG — such decimals map to
// distinct doubles), and a longer literal is not re-typed at all, because
// `Number()` would fold `"9007199254740993"` onto `"9007199254740992"`. The
// client does re-type those, so that rare echo loses its chain — the safe
// direction. The exponent path is injective by construction: `String(n)` is
// unique per double, so two strings that both print back identically denote
// different doubles. Everything neither rule accepts — an enum without a
// scalar `type`, a union with string, nested values, stringified arrays or
// objects (the client parses those; out of this module's scalar scope),
// number → string — is left exactly as the model said it.
//
// Because the same rule runs on both sides, a typed head against a string echo
// (`5000` vs `"5000"`) compares equal too, although no client path produces
// that direction. It is harmless: upstream keeps the model's own emission, the
// tool already ran with the client's arguments, and tool outputs compare
// byte-exact — the same accepted asymmetry as #214's default stripping.

export type ScalarKind = 'number' | 'integer' | 'boolean';

const SCALAR_KINDS: ReadonlySet<string> = new Set<ScalarKind>(['number', 'integer', 'boolean']);
const LOCAL_REF = /^#\/(?:\$defs|definitions)\/([^/]+)$/;
const MAX_SCHEMA_VISITS = 64;

/**
 * The client's preference over a list of candidate type names (`cMt`'s inner
 * rule): an array or object kind wins outright and is not a scalar; then a
 * string anywhere means no re-typing; else the first non-null entry decides.
 */
function preferredName(kinds: readonly (string | undefined)[]): string | undefined {
  let compound: string | undefined;
  let scalar: string | undefined;
  let hasString = false;
  for (const kind of kinds) {
    if (kind === 'array' || kind === 'object') compound ??= kind;
    else if (kind === 'string') hasString = true;
    else if (kind !== undefined && kind !== 'null') scalar ??= kind;
  }
  return compound ?? (hasString ? 'string' : scalar);
}

/**
 * The scalar kind a JSON-schema property declares, resolved the way the client
 * resolves an MCP tool's schema (`cMt`, L12552): a `type` string or array
 * first (a sibling `type` wins over `$ref`; `{type:"number", enum:[…]}` is a
 * number), then a local `$ref`, then `anyOf`/`oneOf` branches under the same
 * preference. Two client quirks are mirrored rather than corrected, because
 * they can only ever equate two spellings of one value: refs are looked up in
 * `$defs` when it exists, even a `#/definitions/` ref (the client picks one
 * bucket, `$defs ?? definitions`), and resolution stops after 64 schema
 * visits, so a branch past that cap is ignored. An enum without a scalar
 * `type`, `const`, annotation-only and nested properties yield `undefined`
 * and are left as the model wrote them. (The client also re-types an
 * annotation-only property; not mirrored here.)
 */
export function schemaScalarKind(schema: unknown, parameters?: unknown): ScalarKind | undefined {
  const defs = parameters && typeof parameters === 'object'
    ? ((parameters as { $defs?: unknown }).$defs ?? (parameters as { definitions?: unknown }).definitions)
    : undefined;
  const visited = new Set<unknown>();
  const resolve = (node: unknown): string | undefined => {
    if (visited.size > MAX_SCHEMA_VISITS || visited.has(node) || !node || typeof node !== 'object') return undefined;
    visited.add(node);
    const record = node as { type?: unknown; $ref?: unknown; anyOf?: unknown; oneOf?: unknown };
    if (typeof record.type === 'string') return record.type;
    if (Array.isArray(record.type)) {
      const named = preferredName(record.type.filter((entry): entry is string => typeof entry === 'string'));
      if (named !== undefined) return named;
    }
    if (typeof record.$ref === 'string' && defs && typeof defs === 'object') {
      const match = LOCAL_REF.exec(record.$ref);
      if (match) return resolve((defs as Record<string, unknown>)[match[1]!]);
    }
    for (const branches of [record.anyOf, record.oneOf]) {
      if (!Array.isArray(branches)) continue;
      const named = preferredName(branches.map(resolve));
      if (named !== undefined) return named;
    }
    return undefined;
  };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const kind = resolve(schema);
  return kind !== undefined && SCALAR_KINDS.has(kind) ? (kind as ScalarKind) : undefined;
}

// `UF`'s pattern, applied after `trim()` (which also strips U+FEFF).
const DECIMAL_LITERAL = /^[-+]?\d+(\.\d+)?$/;
// The generic repair's boolean: JSON.parse after one BOM strip, whitespace and all.
const BOOLEAN_LITERAL = /^\uFEFF?[ \t\n\r]*(true|false)[ \t\n\r]*$/;

// DBL_DIG: a decimal with this many significant digits or fewer converts to a
// double and back without loss, so two distinct such decimals are distinct
// doubles. Beyond it `Number()` is lossy and the literal is left alone.
const MAX_SIGNIFICANT_DIGITS = 15;

function significantDigits(decimal: string): number {
  const [integer = '', fraction = ''] = decimal.replace(/^[-+]/, '').split('.');
  return integer.replace(/^0+/, '').length + fraction.length;
}

/**
 * Re-type a string argument the way the client would for a property of the
 * given kind, or return it unchanged. Non-strings are never touched.
 *
 * `number` and `integer` share one rule with no integrality check: Read's
 * `offset` is `integer` on the wire and the client echoes `"5.5"` as `5.5`; a
 * built-in `.int()` reads as `number` to the generic repair; and an MCP
 * `integer` leaves `"5.5"` a string on both sides, where re-typing both is
 * harmless. A decimal literal (after trim) is `Number()`ed like `UF` when it
 * carries at most 15 significant digits — counted after the sign, the integer
 * part's leading zeros and the dot are dropped — so it can never overflow and
 * never collides with another literal; otherwise only a spelling that prints
 * back identically is accepted, which adds the canonical exponent forms
 * (`"1e+21"`) the generic repair keeps and is injective because `String(n)`
 * is unique per double.
 */
export function coerceEchoedScalar(value: unknown, kind: ScalarKind): unknown {
  if (typeof value !== 'string') return value;
  if (kind === 'boolean') {
    const match = BOOLEAN_LITERAL.exec(value);
    return match ? match[1] === 'true' : value;
  }
  const trimmed = value.trim();
  if (DECIMAL_LITERAL.test(trimmed)) {
    return significantDigits(trimmed) <= MAX_SIGNIFICANT_DIGITS ? Number(trimmed) : value;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(numeric) === value ? numeric : value;
}
