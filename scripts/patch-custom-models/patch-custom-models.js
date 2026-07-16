/**
 * tweakcc adhoc-patch script — inject custom Claude Code model aliases.
 *
 * Makes relay-ai's `relay:<provider>:<model>` favorites first-class inside
 * Claude Code's own tooling: they pass the Agent tool's `model` validation,
 * appear in the `/model` picker, resolve to their concrete id, and report the
 * correct context window. Without this, the names still work via `/model`, but
 * Claude Code treats them as unknown (200k assumed, rejected by the Agent tool).
 *
 * Inspired by https://github.com/East-rayyy/claude-alias-patch (MIT); this is a
 * from-scratch reimplementation applied through tweakcc's `adhoc-patch --script`
 * mode with a different patch mechanism and an added per-model context window
 * patch. See README.md for details and attribution.
 *
 * Aliases are baked in at patch time from the MODEL_CONFIG const below: the
 * tweakcc script sandbox blocks filesystem access, so the script cannot read
 * model-config.json at runtime. The wrapper (patch-custom-models.sh) injects
 * your model-config.json between the `relay:config` markers before running
 * tweakcc; editing the const directly also works for a manual `npx tweakcc`.
 *
 * USAGE (run after every `claude` update):
 *   ./patch-custom-models.sh              # backup (once per version) + apply
 *   ./patch-custom-models.sh restore      # roll back to the pristine binary
 *
 * The script receives Claude Code's full source as the global `js` and returns
 * the patched source. It is idempotent: re-running is a no-op (each patch leaves
 * a `/*ccpatch:*​/` marker or an already-present alias and is skipped).
 *
 * Anchors are keyed on stable STRING LITERALS (model names, describe text,
 * switch-case labels) rather than minified identifiers, so they survive the
 * per-build identifier churn and tolerate new built-in models being added
 * (e.g. "fable"). If Claude Code restructures a site, that one patch logs FAIL
 * (and, for a core patch, throws) instead of silently corrupting the build.
 * ------------------------------------------------------------------------- */

// === EDIT model-config.json (preferred) OR this const ======================
// Keys = the real model id (e.g. a relay-ai favorite), values = the alias you
// type. A value is either the alias string, or { alias, context } to also pin
// that model's context window (in tokens) instead of relying on the `[1m]`
// suffix. Without `context`, a model with no `[1m]` suffix gets Claude Code's
// 200k default. `context` and a `[1m]` suffix are mutually exclusive (PATCH 7).
//
// The wrapper replaces this whole block from model-config.json — the values
// here are only an example / manual-run fallback.
// relay:config:start
const MODEL_CONFIG = {
  "relay:openai-oauth:gpt-5.6-sol": { alias: "sol", context: 272000 },
  "relay:openai-oauth:gpt-5.6-terra": { alias: "terra", context: 272000 },
  "relay:openai-oauth:gpt-5.6-luna": { alias: "luna", context: 272000 },
};
// relay:config:end
// ===========================================================================

// ---- derive helpers --------------------------------------------------------
// alias -> model id  (values are the aliases; keys are the ids)
const ALIAS_TO_ID = {};
// lowercased alias AND id -> context-window tokens (only for models that set it)
const CONTEXT_BY_KEY = {};
for (const [id, value] of Object.entries(MODEL_CONFIG)) {
  const spec = value && typeof value === "object" ? value : { alias: value };
  const a = String(spec.alias).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*(\[1m\])?$/.test(a)) {
    throw new Error(`patch-custom-models: alias "${spec.alias}" is not a safe lowercase alias`);
  }
  ALIAS_TO_ID[a] = String(id);

  if (spec.context !== undefined) {
    const n = Number(spec.context);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`patch-custom-models: context for "${a}" must be a positive integer, got ${spec.context}`);
    }
    // `[1m]` hard-codes 1M upstream (and sends the context-1m beta header +
    // raises the media cap). An explicit context on a `[1m]` model would win
    // via PATCH 7 while those side effects silently stayed on — so reject it.
    if (/\[1m\]/i.test(a) || /\[1m\]/i.test(id)) {
      throw new Error(
        `patch-custom-models: "${a}" sets context but keeps the [1m] suffix — drop the suffix from both the id and the alias`
      );
    }
    CONTEXT_BY_KEY[a] = n;
    CONTEXT_BY_KEY[String(id).trim().toLowerCase()] = n;
  }
}
const ALIASES = Object.keys(ALIAS_TO_ID);
const MODELS = Object.keys(MODEL_CONFIG);
if (ALIASES.length === 0) throw new Error("patch-custom-models: MODEL_CONFIG is empty");

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const q = (s) => JSON.stringify(s); // safe JS string literal

// ---- reporting -------------------------------------------------------------
const report = [];
function log(status, name, extra) {
  report.push({ status, name });
  const line = `  ${status.padEnd(4)} ${name}${extra ? " — " + extra : ""}`;
  // NOTE: tweakcc reads this script's STDOUT as the JSON result, so every
  // diagnostic MUST go to stderr — a stray stdout write corrupts the output.
  console.error(line);
}

/**
 * Apply exactly one regex replacement.
 *  - marker: if present in js, treat as already-patched -> SKIP.
 *  - expects exactly one match; 0 -> FAIL, >1 -> FAIL (ambiguous).
 *  - fn(match, ...groups) returns the replacement text.
 *  - required: on FAIL, throw (aborts the whole adhoc-patch).
 */
function applyOnce(name, regex, fn, { marker, required, noopIsSkip } = {}) {
  if (marker && js.includes(marker)) { log("SKIP", name, "already patched"); return; }
  const g = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  const matches = js.match(g);
  const count = matches ? matches.length : 0;
  if (count === 0) {
    log("FAIL", name, "anchor not found");
    if (required) throw new Error(`patch-custom-models: required patch failed: ${name}`);
    return;
  }
  if (count > 1) {
    log("FAIL", name, `anchor matched ${count} times (expected 1)`);
    if (required) throw new Error(`patch-custom-models: ambiguous anchor: ${name}`);
    return;
  }
  const before = js;
  js = js.replace(regex, fn);
  if (js === before) {
    // For array-extend / append patches, "no change" means the aliases are
    // already present (anchor matched, but fn had nothing new to add) -> SKIP.
    if (noopIsSkip) { log("SKIP", name, "already patched"); return; }
    log("FAIL", name, "replacement made no change");
    if (required) throw new Error(name);
    return;
  }
  log("OK", name);
}

/** Insert missing aliases just before the closing `]` of a JS array literal string. */
function extendAliasArray(arrLiteral) {
  const toAdd = MODELS.filter((a) => !new RegExp(`"${reEsc(a)}"`).test(arrLiteral));
  if (toAdd.length === 0) return arrLiteral; // idempotent
  return arrLiteral.replace(/\]\s*$/, "," + toAdd.map(q).join(",") + "]");
}

console.error(`patch-custom-models: injecting aliases [${ALIASES.join(", ")}]`);

// ---------------------------------------------------------------------------
// PATCH 1 — Agent/subagent tool `model` zod enum.
// Anchor: `.enum([ "sonnet",...,"fable" ]).optional().describe(` — the array
// begins with the built-in aliases and is immediately followed by
// `.optional().describe(`. We append our aliases inside the enum so the tool
// accepts them. (This same `.describe(` is patched by PATCH 4 below.)
// ---------------------------------------------------------------------------
applyOnce(
  "PATCH 1: Agent tool model enum",
  /\.enum\((\["sonnet","opus","haiku"(?:,"[^"]+")*\])\)\.optional\(\)\.describe\(/,
  (_m, arr) => `.enum(${extendAliasArray(arr)}).optional().describe(`,
  { required: true, noopIsSkip: true }
);

// ---------------------------------------------------------------------------
// PATCH 3 — known-alias validator list (drives `mk()` / "is this a known
// alias?"). This is the modern equivalent of the old picker-fallback list.
// Anchor: the master list literal, matched loosely as
// `["sonnet","opus","haiku","fable", ...anything... ,"opusplan"]` so it
// tolerates new built-ins being added in the middle. Appending our aliases
// makes them recognized as first-class aliases everywhere `mk()` gates.
// ---------------------------------------------------------------------------
applyOnce(
  "PATCH 3: known-alias validator list",
  /\["sonnet","opus","haiku","fable"(?:,"[^"]+")*,"opusplan"(?:,"[^"]+")*\]/,
  (m) => extendAliasArray(m),
  { required: true, noopIsSkip: true }
);

// ---------------------------------------------------------------------------
// PATCH 6 — alias -> model-id resolver switch.
// Anchor: `case"best":{ ... }` (the `case"best":{` is unique). We inject
// `case"<alias>":return"<model-id>";` right after it (before the switch's
// `default:return null`) so each alias resolves to its concrete model id.
// Ids are returned verbatim so `relay:openai-oauth:gpt-5.6-sol[1m]` passes
// straight through. Only aliases not already present are inserted, so a rerun
// (or a config edit) tops up cleanly rather than duplicating cases.
// ---------------------------------------------------------------------------
{
  const missing = ALIASES.filter((a) => !new RegExp(`case${reEsc(q(a))}:return`).test(js));
  const cases = missing.map((a) => `case${q(a)}:return ${q(ALIAS_TO_ID[a])};`).join("");
  applyOnce(
    "PATCH 6: alias resolver switch",
    /(case"best":\{[^{}]*\})/,
    (m) => `${m}${cases}`,
    { required: true, noopIsSkip: true }
  );
}

// ---------------------------------------------------------------------------
// PATCH 5 — interactive `/model` picker.
// The picker is assembled through the single choke-point function
//   fn(e,t,r){ let n=..,o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];
//              for(let i of o) Dlh(e,i,t); return e }
// where `e` is the options array. We insert, right after the `Dlh` loop, a
// snippet that appends our custom `{value,label,description}` entries — with a
// runtime `.some()` dedupe guard so it is safe even if the function runs over
// the same array twice. Only aliases not already injected are added, so reruns
// / config edits top up cleanly.
// ---------------------------------------------------------------------------
{
  const missing = ALIASES.filter((a) => !new RegExp(`value:${reEsc(q(a))}`).test(js));
  const entries = missing
    .map(
      // ASCII only: tweakcc's script->JSON->repack path double-encodes any
      // non-ASCII byte (e.g. a "\xB7" middle dot renders as mojibake "Â\xB7").
      (a) => `{value:${q(a)},label:${q(a.charAt(0).toUpperCase() + a.slice(1))},description:${q("Custom model (" + ALIAS_TO_ID[a] + ")")}}`
    )
    .join(",");
  const inject = missing.length
    ? `[${entries}].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});`
    : "";
  applyOnce(
    "PATCH 5: model picker options",
    /(\?\[[\w$]+,r\]:\[r\];for\(let [\w$]+ of [\w$]+\)[\w$]+\(e,[\w$]+,t\);)/,
    (m) => `${m}${inject}`,
    { required: false, noopIsSkip: true }
  );
}

// ---------------------------------------------------------------------------
// PATCH 4 — Agent tool `model` parameter description text.
// Append the available alias names before the closing backtick so the model
// knows the aliases exist and can request them. Best-effort (cosmetic).
// ---------------------------------------------------------------------------
{
  const listing = MODELS.join(", ");
  applyOnce(
    "PATCH 4: Agent tool model description",
    /(describe\(`Optional model override for this agent[^`]*?)(`\))/,
    (_m, body, close) =>
      body.includes("custom aliases")
        ? `${body}${close}`
        : `${body} Additional custom aliases: ${listing}.${close}`,
    { required: false, noopIsSkip: true }
  );
}

// ---------------------------------------------------------------------------
// PATCH 7 — per-model context window.
//
// Claude Code funnels EVERY context-window consumer (autocompact threshold,
// /context, the countdown, statusline, cost/usage records, subagent budgets)
// through one function:
//
//   function RS(e,t){ let r=FAc(); if(r!==void 0) return r;      // DISABLE_COMPACT + CLAUDE_CODE_MAX_CONTEXT_TOKENS
//                     if(EHi(e,t)) return Dve;                   // clamp to 200k when 1M credits are blocked
//                     return $Ac(e,t) }                          // the real lookup
//   function $Ac(e,t){ if(B_(e)) return 1e6;                     // <- the `[1m]` suffix: /\[1m\]/i.test(e)
//                      if(t?.includes(Ofe.header)&&Oq(e)) return 1e6;
//                      if(eL(e)) return 1e6;                     // native-1M model on a supporting platform
//                      let r=G3n(e); if(r!==null) return r;       // sonnet-4-6 gate override
//                      let n=Te.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
//                      if(n!==void 0&&n>0&&!uo(ri(e)).startsWith("claude-")) return n;
//                      return gWt }                              // 200000 default
//
// We inject a baked table lookup at the TOP of `RS`, so it wins over all of the
// above — including the `EHi` clamp (a 272k model is >200k, so it would be
// dragged back to 200k if the session ever flips `longContext1mCreditsBlocked`)
// and the global CLAUDE_CODE_MAX_CONTEXT_TOKENS env override (which is
// all-or-nothing across every non-`claude-` model, hence this patch).
//
// Anchor: `RS`'s exact body shape. Identifiers are wildcarded (they churn per
// build); the `(e,t)` arity + 3-statement shape matches once in the bundle.
// Lookup is on the raw, lowercased model string, which is what callers pass —
// alias and id are both in the table, so it hits pre- or post-alias-resolution.
// ---------------------------------------------------------------------------
if (Object.keys(CONTEXT_BY_KEY).length) {
  const MARKER = "/*ccpatch:ctx*/";
  const SNIPPET =
    `${MARKER}var _ccw=(${JSON.stringify(CONTEXT_BY_KEY)})[String(e||"").trim().toLowerCase()];if(_ccw!==void 0)return _ccw;`;

  if (js.includes(MARKER)) {
    // Re-patching an already-patched binary: refresh the baked table in place
    // so a MODEL_CONFIG edit takes effect without a `restore` first.
    applyOnce(
      "PATCH 7: per-model context window (refresh)",
      /\/\*ccpatch:ctx\*\/var _ccw=\(\{[^{}]*\}\)\[[^\]]*\];if\(_ccw!==void 0\)return _ccw;/,
      () => SNIPPET,
      { required: true, noopIsSkip: true }
    );
  } else {
    applyOnce(
      "PATCH 7: per-model context window",
      /(function [\w$]+\(e,t\)\{)(let [\w$]+=[\w$]+\(\);if\([\w$]+!==void 0\)return [\w$]+;if\([\w$]+\(e,t\)\)return [\w$]+;return [\w$]+\(e,t\)\})/,
      (_m, head, body) => `${head}${SNIPPET}${body}`,
      { required: true }
    );
  }
}

// ---------------------------------------------------------------------------
const failed = report.filter((r) => r.status === "FAIL");
const ok = report.filter((r) => r.status === "OK").length;
const skip = report.filter((r) => r.status === "SKIP").length;
console.error(`patch-custom-models: ${ok} applied, ${skip} skipped, ${failed.length} failed`);
if (failed.length) console.error(`patch-custom-models: FAILED patches: ${failed.map((f) => f.name).join("; ")}`);

return js;
