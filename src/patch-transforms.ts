// src/patch-transforms.ts — clodex patch transforms, applied in-process.
//
// Ported from the relay-ai scripts/patch-custom-models wrapper, originally run
// as a tweakcc `adhoc-patch --script` inside tweakcc's sandbox (with the Claude
// Code source as global `js`). Now a pure function: patcher.ts extracts the
// bundled JS with tweakcc's programmatic `readContent`, calls
// `applyClodexPatches`, and repacks with `writeContent`. The patch sites and
// their regex/replacement logic are unchanged — they are hard-won; do not
// "improve" them.
//
// Inspired by https://github.com/East-rayyy/claude-alias-patch (MIT); this is a
// from-scratch reimplementation with a different patch mechanism and an added
// per-model context window patch.
//
// The ALIAS is the model's identity inside the binary: for any entry that
// defines one, the alias (not the canonical `clodex:<provider>:<model>` id) is
// what lands in the Agent-tool enum, the known-alias validator, the /model
// picker, and the context-window table — so `model: sol` in agent/skill
// frontmatter validates. Entries with no alias fall back to their canonical id
// as the identity (they still join the enum, validator, and context table, but
// skip the resolver and /model picker patches).

export interface PatchScriptModelEntry {
  alias?: string;
  context?: number;
  /** Human label for the /model picker, e.g. `GPT-5.6 Sol (OpenAI (ChatGPT))`. */
  display?: string;
}

/** Real model id (e.g. `clodex:openai-oauth:gpt-5.6-sol`) → alias/context. */
export type PatchScriptModelConfig = Record<string, PatchScriptModelEntry>;

export type PatchSiteStatus = 'OK' | 'SKIP' | 'FAIL';

export interface PatchSiteResult {
  status: PatchSiteStatus;
  name: string;
  extra?: string;
}

export interface ApplyPatchesOutcome {
  /** The patched Claude Code source. */
  content: string;
  /** Per-site outcome, in patch order. */
  results: PatchSiteResult[];
}

/**
 * Thrown when a required patch site fails (or the config is invalid). Carries
 * the per-site results collected up to the failure so `--trace` can report
 * exactly what the sandboxed script used to print.
 */
export class PatchApplyError extends Error {
  readonly results: PatchSiteResult[];
  constructor(message: string, results: PatchSiteResult[]) {
    super(message);
    this.name = 'PatchApplyError';
    this.results = results;
  }
}

/** One report line, same format the tweakcc-sandbox script wrote to stderr. */
export function formatPatchSiteLine(result: PatchSiteResult): string {
  return '  ' + result.status.padEnd(4) + ' ' + result.name + (result.extra ? ' — ' + result.extra : '');
}

/**
 * Apply the clodex patch sites (PATCH 1–11) to the Claude Code source.
 * Pure: source string in → patched string + per-site results out. Throws
 * `PatchApplyError` when the config is invalid or a required site fails —
 * nothing should be written to the binary in that case.
 */
export function applyClodexPatches(source: string, config: PatchScriptModelConfig): ApplyPatchesOutcome {
  let js = source;
  const MODEL_CONFIG = config;

  // ---- derive helpers ------------------------------------------------------
  // alias -> model id (only for entries that define an alias)
  const ALIAS_TO_ID: Record<string, string> = {};
  // The name Claude Code knows a model by: its alias when it has one, else its
  // canonical id. This single value is used for the Agent-tool enum, the
  // known-alias validator, the /model picker value, and the context-window table,
  // so the name the binary validates == the name it sends upstream == the name
  // the proxy echoes back == the key its context window is stored under.
  const IDENTITIES: string[] = [];
  // identity -> human label for the /model picker (falls back at use site)
  const DISPLAY_BY_IDENTITY: Record<string, string> = {};
  // lowercased alias AND id -> context-window tokens (only for models that set it)
  const CONTEXT_BY_KEY: Record<string, number> = {};

  const report: PatchSiteResult[] = [];
  const fail = (message: string): never => {
    throw new PatchApplyError(message, report);
  };

  for (const [id, value] of Object.entries(MODEL_CONFIG)) {
    const spec: PatchScriptModelEntry = value && typeof value === 'object' ? value : { alias: value as unknown as string };
    if (spec.alias !== undefined) {
      const a = String(spec.alias).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]*(\[1m\])?$/.test(a)) {
        fail('clodex patch: alias "' + spec.alias + '" is not a safe lowercase alias');
      }
      ALIAS_TO_ID[a] = String(id);
      IDENTITIES.push(a);
      if (spec.display) DISPLAY_BY_IDENTITY[a] = String(spec.display);
    } else {
      IDENTITIES.push(String(id));
      if (spec.display) DISPLAY_BY_IDENTITY[String(id)] = String(spec.display);
    }

    if (spec.context !== undefined) {
      const n = Number(spec.context);
      if (!Number.isInteger(n) || n <= 0) {
        fail('clodex patch: context for "' + id + '" must be a positive integer, got ' + spec.context);
      }
      // A [1m] suffix hard-codes 1M upstream (and sends the context-1m beta header
      // + raises the media cap). An explicit context on a [1m] model would win via
      // PATCH 7 while those side effects silently stayed on — so reject it.
      if (/\[1m\]/i.test(String(spec.alias ?? '')) || /\[1m\]/i.test(id)) {
        fail(
          'clodex patch: "' + id + '" sets context but keeps the [1m] suffix — drop the suffix from both the id and the alias'
        );
      }
      if (spec.alias !== undefined) CONTEXT_BY_KEY[String(spec.alias).trim().toLowerCase()] = n;
      CONTEXT_BY_KEY[String(id).trim().toLowerCase()] = n;
    }
  }
  const ALIASES = Object.keys(ALIAS_TO_ID);
  const MODELS = Object.keys(MODEL_CONFIG);
  if (MODELS.length === 0) fail('clodex patch: MODEL_CONFIG is empty');

  /** Picker/description label for an identity; falls back to the old wording. */
  function displayFor(identity: string, fallbackId: string): string {
    return DISPLAY_BY_IDENTITY[identity] || 'Custom model (' + fallbackId + ')';
  }

  const reEsc = (s: string) => s.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  const q = (s: string) => JSON.stringify(s); // safe JS string literal

  // ---- reporting -----------------------------------------------------------
  function log(status: PatchSiteStatus, name: string, extra?: string) {
    report.push(extra === undefined ? { status, name } : { status, name, extra });
  }

  /**
   * Apply exactly one regex replacement.
   *  - marker: if present in js, treat as already-patched -> SKIP.
   *  - expects exactly one match; 0 -> FAIL, >1 -> FAIL (ambiguous).
   *  - fn(match, ...groups) returns the replacement text.
   *  - required: on FAIL, throw (aborts the whole patch).
   */
  function applyOnce(
    name: string,
    regex: RegExp,
    fn: (match: string, ...groups: string[]) => string,
    { marker, required, noopIsSkip }: { marker?: string; required?: boolean; noopIsSkip?: boolean } = {},
  ): void {
    if (marker && js.includes(marker)) { log('SKIP', name, 'already patched'); return; }
    const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    const matches = js.match(g);
    const count = matches ? matches.length : 0;
    if (count === 0) {
      log('FAIL', name, 'anchor not found');
      if (required) fail('clodex patch: required patch failed: ' + name);
      return;
    }
    if (count > 1) {
      log('FAIL', name, 'anchor matched ' + count + ' times (expected 1)');
      if (required) fail('clodex patch: ambiguous anchor: ' + name);
      return;
    }
    const before = js;
    js = js.replace(regex, fn as (substring: string, ...args: unknown[]) => string);
    if (js === before) {
      // For array-extend / append patches, "no change" means the aliases are
      // already present (anchor matched, but fn had nothing new to add) -> SKIP.
      if (noopIsSkip) { log('SKIP', name, 'already patched'); return; }
      log('FAIL', name, 'replacement made no change');
      if (required) fail(name);
      return;
    }
    log('OK', name);
  }

  /** Insert missing identities just before the closing bracket of a JS array literal string. */
  function extendAliasArray(arrLiteral: string): string {
    const toAdd = IDENTITIES.filter((a) => !new RegExp('"' + reEsc(a) + '"').test(arrLiteral));
    if (toAdd.length === 0) return arrLiteral; // idempotent
    return arrLiteral.replace(/\]\s*$/, ',' + toAdd.map(q).join(',') + ']');
  }

  // ---------------------------------------------------------------------------
  // PATCH 1 — Agent/subagent tool 'model' zod enum.
  // Anchor: .enum([ "sonnet",...,"fable" ]).optional().describe( — the array
  // begins with the built-in aliases and is immediately followed by
  // .optional().describe(. We append our identities (alias when defined, else
  // the canonical id) inside the enum so the tool accepts them — this is the same
  // enum subagent/skill 'model:' frontmatter is validated against, which is why
  // the short alias has to be the value that lands here.
  // (This same .describe( is patched by PATCH 4 below.)
  // ---------------------------------------------------------------------------
  applyOnce(
    'PATCH 1: Agent tool model enum',
    /\.enum\((\["sonnet","opus","haiku"(?:,"[^"]+")*\])\)\.optional\(\)\.describe\(/,
    (_m, arr) => '.enum(' + extendAliasArray(arr!) + ').optional().describe(',
    { required: true, noopIsSkip: true }
  );

  // ---------------------------------------------------------------------------
  // PATCH 3 — known-alias validator list (drives "is this a known alias?").
  // Anchor: the master list literal, matched loosely as
  // ["sonnet","opus","haiku","fable", ...anything... ,"opusplan"] so it
  // tolerates new built-ins being added in the middle. Appending our identities
  // makes them recognized as first-class aliases everywhere the gate runs.
  // ---------------------------------------------------------------------------
  applyOnce(
    'PATCH 3: known-alias validator list',
    /\["sonnet","opus","haiku","fable"(?:,"[^"]+")*,"opusplan"(?:,"[^"]+")*\]/,
    (m) => extendAliasArray(m),
    { required: true, noopIsSkip: true }
  );

  // ---------------------------------------------------------------------------
  // PATCH 6 — alias resolver switch (IDENTITY mapping).
  // Anchor: case"best":{ ... } (the case"best":{ is unique). We inject
  // case"<alias>":return"<alias>"; right after it (before the switch's
  // default:return null).
  //
  // The mapping is deliberately an identity, NOT alias -> canonical id: the alias
  // IS the model's identity everywhere else in the patched binary (enum,
  // validator, picker, context table), and the MITM proxy resolves short alias
  // names as request model ids and echoes request bodies unrewritten. Resolving
  // to the canonical id here would make Claude Code send one name and look its
  // context window up under another — the exact mismatch that stopped auto-compact
  // from firing and killed agents with "Prompt is too long". The case still has to
  // EXIST (rather than be skipped) so the resolver returns the name instead of
  // falling through to default:return null.
  // Only aliases not already present are inserted, so a rerun (or a config
  // edit) tops up cleanly rather than duplicating cases.
  // ---------------------------------------------------------------------------
  {
    const missing = ALIASES.filter((a) => !new RegExp('case' + reEsc(q(a)) + ':return').test(js));
    const cases = missing.map((a) => 'case' + q(a) + ':return ' + q(a) + ';').join('');
    if (ALIASES.length === 0) {
      log('SKIP', 'PATCH 6: alias resolver switch', 'no aliases configured');
    } else {
      applyOnce(
        'PATCH 6: alias resolver switch',
        /(case"best":\{[^{}]*\})/,
        (m) => m + cases,
        { required: true, noopIsSkip: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 5 — interactive /model picker.
  // The picker is assembled through a single choke-point function; we insert,
  // right after its loop, a snippet that appends our custom
  // {value,label,description} entries — with a runtime .some() dedupe guard so
  // it is safe even if the function runs over the same array twice. Only
  // aliases not already injected are added, so reruns top up cleanly.
  // ---------------------------------------------------------------------------
  {
    const missing = ALIASES.filter((a) => !new RegExp('value:' + reEsc(q(a))).test(js));
    const entries = missing
      .map(
        // value = the alias (the name the user types and the binary sends);
        // description = the real model label, e.g. "GPT-5.6 Sol (OpenAI (ChatGPT))".
        // (tweakcc's writeContent round-trips utf8 faithfully — verified — so the
        // old adhoc-patch ASCII-only constraint no longer applies.)
        (a) => '{value:' + q(a) + ',label:' + q(a.charAt(0).toUpperCase() + a.slice(1)) + ',description:' + q(displayFor(a, ALIAS_TO_ID[a]!)) + '}'
      )
      .join(',');
    const inject = missing.length
      ? '[' + entries + '].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});'
      : '';
    if (ALIASES.length === 0) {
      log('SKIP', 'PATCH 5: model picker options', 'no aliases configured');
    } else {
      applyOnce(
        'PATCH 5: model picker options',
        /(\?\[[\w$]+,r\]:\[r\];for\(let [\w$]+ of [\w$]+\)[\w$]+\(e,[\w$]+,t\);)/,
        (m) => m + inject,
        { required: false, noopIsSkip: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 4 — Agent tool 'model' parameter description text.
  // Append the available model names (with their real labels) before the closing
  // backtick so the model knows which extra names it may request and what they
  // actually are. Best-effort (cosmetic). The text is spliced into a backtick
  // template literal, so backticks and interpolation openers are stripped.
  // ---------------------------------------------------------------------------
  {
    const safe = (s: string) => String(s).replace(/`/g, "'").replace(/\$\{/g, '(');
    const listing = IDENTITIES.map(function (i) {
      const d = DISPLAY_BY_IDENTITY[i];
      return d ? safe(i) + ' = ' + safe(d) : safe(i);
    }).join('; ');
    applyOnce(
      'PATCH 4: Agent tool model description',
      /(describe\(`Optional model override for this agent[^`]*?)(`\))/,
      (_m, body, close) =>
        body!.includes('Additional custom models')
          ? body! + close!
          : body! + ' Additional custom models: ' + listing + '.' + close!,
      { required: false, noopIsSkip: true }
    );
  }

  // ---------------------------------------------------------------------------
  // PATCH 7 — per-model context window.
  //
  // Claude Code funnels EVERY context-window consumer (autocompact threshold,
  // /context, the countdown, statusline, cost/usage records, subagent budgets)
  // through one resolver function. We inject a baked table lookup at the TOP of
  // that resolver, so it wins over the 200k clamp and the global
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS env override. Lookup is on the raw,
  // lowercased model string — alias and id are both in the table, so it hits
  // pre- or post-alias-resolution.
  //
  // Anchor: the resolver's exact body shape. Identifiers are wildcarded (they
  // churn per build); the (e,t) arity + 3-statement shape matches once.
  // ---------------------------------------------------------------------------
  if (Object.keys(CONTEXT_BY_KEY).length) {
    const MARKER = '/*ccpatch:ctx*/';
    const SNIPPET =
      MARKER + 'var _ccw=(' + JSON.stringify(CONTEXT_BY_KEY) + ')[String(e||"").trim().toLowerCase()];if(_ccw!==void 0)return _ccw;';

    if (js.includes(MARKER)) {
      // Re-patching an already-patched binary: refresh the baked table in place
      // so a MODEL_CONFIG edit takes effect without a restore first.
      applyOnce(
        'PATCH 7: per-model context window (refresh)',
        /\/\*ccpatch:ctx\*\/var _ccw=\(\{[^{}]*\}\)\[[^\]]*\];if\(_ccw!==void 0\)return _ccw;/,
        () => SNIPPET,
        { required: true, noopIsSkip: true }
      );
    } else {
      applyOnce(
        'PATCH 7: per-model context window',
        /(function [\w$]+\(e,t\)\{)(let [\w$]+=[\w$]+\(\);if\([\w$]+!==void 0\)return [\w$]+;if\([\w$]+\(e,t\)\)return [\w$]+;return [\w$]+\(e,t\)\})/,
        (_m, head, body) => head! + SNIPPET + body!,
        { required: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 12 — delegate context lifecycle to Clodex for translated routes.
  // Native Responses compaction reduces the model-facing chain without
  // rewriting Claude's local transcript. Claude's own auto-compactor and local
  // hard guard can therefore act on a different counter than Clodex.
  {
    const MARKER = '/*clodex:native-context-owner*/';
    applyOnce(
      'PATCH 12: native context owner',
      /function ([\w$]+)\(\)\{if\(([\w$]+)\.DISABLE_COMPACT\)return!1;if\(Yt\(process\.env\.DISABLE_AUTO_COMPACT\)\)return!1;return Hc\("autoCompactEnabled",!0\)\.value\}/,
      (_m, predicate, config) =>
        'function ' + predicate + '(){' + MARKER
        + 'if(process.env.CLODEX_NATIVE_CONTEXT_OWNER==="1")return!1;'
        + 'if(' + config + '.DISABLE_COMPACT)return!1;if(Yt(process.env.DISABLE_AUTO_COMPACT))return!1;'
        + 'return Hc("autoCompactEnabled",!0).value}',
      { marker: MARKER, required: true }
    );
  }

  // PATCH 13 — prevent Claude's local context guard from blocking a Clodex child.
  {
    const MARKER = '/*clodex:native-context-guard*/';
    applyOnce(
      'PATCH 13: native context guard',
      new RegExp(String.raw`function ([\w$]+)\(e,t,r,n=t\)\{let ([\w$]+)=Sfo\(t,r\),([\w$]+)=r\.enabled\?[\w$]+:t,([\w$]+)=[\w$]+-20000,([\w$]+)=r\.testBlockingOverride,`),
      (_m, fn, threshold, active, warn, blocking) =>
        'function ' + fn + '(e,t,r,n=t){' + MARKER
        + 'if(process.env.CLODEX_NATIVE_CONTEXT_OWNER==="1")return{level:"ok",pctLeft:100};'
        + 'let ' + threshold + '=Sfo(t,r),' + active + '=r.enabled?' + threshold + ':t,'
        + warn + '=' + active + '-20000,' + blocking + '=r.testBlockingOverride,',
      { marker: MARKER, required: true }
    );
  }

  // PATCH 14 — suppress Claude's background precomputed auto-compaction arm.
  {
    const MARKER = '/*clodex:native-precompute-owner*/';
    applyOnce(
      'PATCH 14: native precompute owner',
      /function ([\w$]+)\(e,t,r,n\)\{let ([\w$]+)=Uds\(t,r,n\),([\w$]+)=\2\.enabled\?r:void 0,([\w$]+)=CSe\(t,\3\);if\(!JGe\(t,r\)\)return e>=Hds\(\4,\2\);/,
      (_m, fn, options, enabledWindow, context, settings) =>
        'function ' + fn + '(e,t,r,n){' + MARKER
        + 'if(process.env.CLODEX_NATIVE_CONTEXT_OWNER==="1")return!1;'
        + 'let ' + options + '=Uds(t,r,n),' + enabledWindow + '=' + options + '.enabled?r:void 0,'
        + context + '=CSe(t,' + enabledWindow + ');if(!JGe(t,r))return e>=Hds(' + context + ',' + options + ');',
      { marker: MARKER, required: true }
    );
  }

  // ---------------------------------------------------------------------------
  // PATCH 15 — keep Claude's derived context window at the model cap.
  //
  // The owner flag suppresses Claude's compaction decision, but the resolver is
  // also consulted by request preflight and status calculations. If a caller
  // supplies CLAUDE_CODE_AUTO_COMPACT_WINDOW, leaving that value in the
  // resolver can still produce a local hard-limit rejection before Clodex's
  // native lifecycle gets a chance to compact. Owner mode therefore ignores
  // that local window and uses Claude's resolved model cap (currently 1M for
  // Sol/Luna). Non-owner launches retain the upstream env behavior.
  // ---------------------------------------------------------------------------
  {
    const MARKER = '/*clodex:native-context-window*/';
    applyOnce(
      'PATCH 15: native context window',
      /function ([\w$]+)\(e,t\)\{let ([\w$]+)=lo\(e\),([\w$]+)=Mv\(\),([\w$]+)=JE\(e,\3\);if\(process\.env\.CLAUDE_CODE_AUTO_COMPACT_WINDOW\)/,
      (_m, resolver, modelKey, clientData, modelCap) =>
        'function ' + resolver + '(e,t){let ' + modelKey + '=lo(e),' + clientData + '=Mv(),'
        + modelCap + '=JE(e,' + clientData + ');' + MARKER
        + 'if(process.env.CLODEX_NATIVE_CONTEXT_OWNER==="1")return{window:' + modelCap
        + ',configured:' + modelCap + ',source:"owner"};'
        + 'if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)',
      { marker: MARKER, required: true }
    );
  }

  // PATCH 8 — opt in to Claude Code's bundled native Computer Use MCP.
  //
  // Claude Code ships a macOS-native computer-use MCP server and guards both
  // its dynamic registration and its tools/list response through one predicate.
  // Keep Claude's HIPAA guard authoritative, but permit an explicit Clodex env
  // opt-in to bypass the Anthropic subscription-tier / rollout checks. The
  // surrounding upstream call site still limits automatic registration to
  // interactive macOS sessions.
  //
  // Off by default: users must set CLODEX_NATIVE_COMPUTER_USE=1.
  // ---------------------------------------------------------------------------
  {
    const MARKER = '/*clodex:native-computer-use*/';
    applyOnce(
      'PATCH 8: native Computer Use opt-in',
      /function ([\w$]+)\(\)\{if\(([\w$]+)\("hipaa"\)\)return!1;return ([\w$]+)\(\)&&([\w$]+)\(\)\.enabled\}/,
      (_m, predicate, hipaaGate, tierGate, rolloutGate) =>
        'function ' + predicate + '(){if(' + hipaaGate + '("hipaa"))return!1;'
        + MARKER + 'if(process.env.CLODEX_NATIVE_COMPUTER_USE==="1")return!0;'
        + 'return ' + tierGate + '()&&' + rolloutGate + '().enabled}',
      { marker: MARKER, required: false }
    );
  }

  // ---------------------------------------------------------------------------
  // PATCH 9 — make the explicit native Computer Use opt-in global.
  //
  // Upstream requires enabling the built-in `computer-use` server separately
  // in every project. When the same Clodex env opt-in is set, treat that server
  // as enabled without changing the normal project-scoped behavior for any
  // other MCP. Removing the env restores Claude Code's upstream toggle logic.
  // ---------------------------------------------------------------------------
  {
    const MARKER = '/*clodex:native-computer-use-default*/';
    applyOnce(
      'PATCH 9: native Computer Use default enable',
      /function ([\w$]+)\(e\)\{let t=([\w$]+)\(\);if\(([\w$]+)\(e\)\)return!([\w$]+)\(t\.enabledMcpServers\)\.includes\(e\);return ([\w$]+)\(t\.disabledMcpServers\)\.includes\(e\)\}/,
      (_m, predicate, readProject, isBuiltin, normalizeEnabled, normalizeDisabled) =>
        'function ' + predicate + '(e){'
        + MARKER + 'if(' + isBuiltin + '(e)&&process.env.CLODEX_NATIVE_COMPUTER_USE==="1")return!1;'
        + 'let t=' + readProject + '();if(' + isBuiltin + '(e))return!'
        + normalizeEnabled + '(t.enabledMcpServers).includes(e);return '
        + normalizeDisabled + '(t.disabledMcpServers).includes(e)}',
      { marker: MARKER, required: false }
    );
  }

  // ---------------------------------------------------------------------------
  // PATCH 10 — make Workflow's agent stall watchdog configurable.
  //
  // Claude Code's Workflow runtime abandons an agent after 180 seconds without
  // a semantic content event. OpenAI-family models can remain active beyond
  // that while producing a large tool argument that Clodex must buffer until it
  // can sanitize the complete JSON object. HTTP keepalive pings intentionally
  // do not count as agent progress, so expose a bounded opt-in override.
  //
  // The upstream default remains 180 seconds. Values are clamped to 3–30
  // minutes to prevent accidental zero/negative or effectively unbounded waits.
  // ---------------------------------------------------------------------------
  {
    const MARKER = '/*clodex:workflow-stall-timeout*/';
    applyOnce(
      'PATCH 10: Workflow agent stall timeout',
      /(Be concise \\u2014 the script will parse your output\.`(?:,[\w$]+){4},)([\w$]+)=180000(,[\w$]+=5,[\w$]+=5;var)/,
      (_m, prefix, timeoutName, suffix) =>
        prefix + timeoutName + '=' + MARKER
        + 'Math.min(Math.max(Number(process.env.CLODEX_WORKFLOW_STALL_TIMEOUT_MS)||180000,180000),1800000)'
        + suffix,
      { marker: MARKER, required: false }
    );
  }

  // ---------------------------------------------------------------------------
  // PATCH 11 — retain the last nonzero Workflow agent usage sample.
  //
  // Translated streams begin with an Anthropic-shaped message_start carrying
  // zero usage because OpenAI reports authoritative cache-aware usage only at
  // completion. Claude's Workflow loop replaces its progress counter for every
  // assistant event, so a subsequent zero-valued streaming placeholder erases
  // the last completed response's real token count and leaves the UI at 0 tok.
  //
  // Preserve the previous sample when the incoming total is zero. Native Claude
  // streams are unchanged because their message_start usage is already nonzero.
  // ---------------------------------------------------------------------------
  {
    const MARKER = '/*clodex:workflow-token-progress*/';
    const name = 'PATCH 11: Workflow token progress';
    if (js.includes(MARKER)) {
      log('SKIP', name, 'already patched');
    } else {
      const assistantRe = /if\(([\w$]+)=([\w$]+),([\w$]+)\?\.\push\(\2\),!\2\.isApiErrorMessage\)\{([\w$]+)=([\w$]+)\(\2\.message\.usage\);let ([\w$]+)=\2\.message\.model;/g;
      const matches = [...js.matchAll(assistantRe)];
      if (matches.length !== 1) {
        log('FAIL', name, matches.length === 0
          ? 'anchor not found'
          : 'anchor matched ' + matches.length + ' times (expected 1)');
      } else {
        const match = matches[0]!;
        const index = match.index!;
        const [whole, lastMessage, message, messages, tokens, countUsage, model] = match;
        const progressSlice = js.slice(index, index + 3000);
        const progressRe = new RegExp(
          '([\\w$]+)\\("progress",\\{tokens:([\\w$]+)\\+' + reEsc(tokens!)
          + ',toolCalls:([\\w$]+)\\+([\\w$]+)\\}\\)'
        );
        const progress = progressSlice.match(progressRe);
        const outerAssistant = 'if(' + message + '.type==="assistant"){';
        const outerAssistantIndex = js.lastIndexOf(outerAssistant, index);
        const previousContinue = js.lastIndexOf('continue}', outerAssistantIndex);
        const continueAdjacent = previousContinue >= 0
          && previousContinue + 'continue}'.length === outerAssistantIndex;

        if (!progress || !continueAdjacent) {
          log('FAIL', name, !continueAdjacent
            ? 'user/assistant boundary not found'
            : 'progress emitter not found');
        } else {
          const [, emitProgress, priorTokens, priorTools, toolCalls] = progress;
          const refresh =
            MARKER
            + 'let __clodexWorkflowUsage=' + lastMessage + '?'
            + countUsage + '(' + lastMessage + '.message.usage):0;'
            + 'if(__clodexWorkflowUsage>0){' + tokens + '=__clodexWorkflowUsage;'
            + emitProgress + '("progress",{tokens:' + priorTokens + '+' + tokens
            + ',toolCalls:' + priorTools + '+' + toolCalls + '})}';
          const before = js.slice(0, previousContinue);
          const between = js.slice(previousContinue + 'continue}'.length, index);
          const afterAssistant = js.slice(index + whole.length);
          const retainedAssistant =
            'if(' + lastMessage + '=' + message + ',' + messages + '?.push(' + message + '),!'
            + message + '.isApiErrorMessage){let __clodexAssistantUsage='
            + countUsage + '(' + message + '.message.usage);'
            + 'if(__clodexAssistantUsage>0)' + tokens + '=__clodexAssistantUsage;'
            + 'let ' + model + '=' + message + '.message.model;';
          js = before + refresh + 'continue}' + between + retainedAssistant + afterAssistant;
          log('OK', name);
        }
      }
    }
  }

  return { content: js, results: report };
}
