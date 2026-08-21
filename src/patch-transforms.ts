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

import { isReservedModelAlias } from './model-aliases.js';
import {
  CHILD_NETWORK_ENV_VARS,
  NETWORK_ENV_CONTRACT_VAR,
} from './network-env.js';

/**
 * Version of the transform set below — NOT of the patch-state manifest, whose
 * shape is unrelated. It is folded into `computePatchConfigHash`, so bumping it
 * is what makes an existing install read as `stale-config` and repatch.
 *
 * IMPORTANT: bump this whenever the transform set changes materially — adding or
 * removing a PATCH site, or changing a site's regex, replacement, or ordering.
 * Without a bump, users whose favorites are unchanged keep the OLD patch forever
 * and never receive the new transforms, silently. `tests/patcher.test.ts` pins a
 * hash of the transform inputs to force that decision to be made rather than
 * forgotten.
 */
export const PATCH_TRANSFORMS_VERSION = 8;

export interface PatchScriptModelEntry {
  alias?: string;
  context?: number;
  /** Human label for the /model picker, e.g. `GPT-5.6 Sol (OpenAI (ChatGPT))`. */
  display?: string;
  /** Provider reasoning levels projected onto Claude Code's native effort ladder. */
  effort?: PatchScriptEffort;
}

export interface PatchScriptEffort {
  levels: string[];
  defaultLevel: string;
}

/** Real model id (e.g. `clodex:openai-oauth:gpt-5.6-sol`) → alias/context. */
export type PatchScriptModelConfig = Record<string, PatchScriptModelEntry>;

const NATIVE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const BASE_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export function projectNativeEffort(
  effort: PatchScriptEffort | undefined,
): PatchScriptEffort | undefined {
  if (!effort || !Array.isArray(effort.levels) || typeof effort.defaultLevel !== 'string') return undefined;
  const declared = new Set(effort.levels);
  const levels = NATIVE_EFFORT_LEVELS.filter(level => declared.has(level));
  if (!BASE_EFFORT_LEVELS.every(level => declared.has(level))) return undefined;
  if (!levels.some(level => level === effort.defaultLevel)) return undefined;
  // The native client defaults custom identities to high; preserve that contract.
  return { levels, defaultLevel: 'high' };
}

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
 * Apply the clodex patch sites (PATCH 1–10) to the Claude Code source.
 * Pure: source string in → patched string + per-site results out. Throws
 * `PatchApplyError` when the config is invalid or a required site fails —
 * nothing should be written to the binary in that case.
 */
export function applyClodexPatches(source: string, config: PatchScriptModelConfig): ApplyPatchesOutcome {
  let js = source;
  const MODEL_CONFIG = config;

  // ---- derive helpers ------------------------------------------------------
  // alias -> model id (only for entries that define an alias)
  const ALIAS_TO_ID: Record<string, string> = Object.create(null);
  // The name Claude Code knows a model by: its alias when it has one, else its
  // canonical id. This single value is used for the Agent-tool enum, the
  // known-alias validator, the /model picker value, and the context-window table,
  // so the name the binary validates == the name it sends upstream == the name
  // the proxy echoes back == the key its context window is stored under.
  const IDENTITIES: string[] = [];
  // identity -> human label for the /model picker (falls back at use site)
  const DISPLAY_BY_IDENTITY: Record<string, string> = Object.create(null);
  // lowercased alias AND id -> context-window tokens (only for models that set it)
  const CONTEXT_BY_KEY: Record<string, number> = Object.create(null);
  // lowercased alias AND id for every configured model. Capability verdicts
  // must distinguish configured-false from an unknown identity that may use
  // the native fallback.
  const CONFIGURED_CAPABILITY_KEYS = new Set<string>();
  // lowercased alias AND id -> effort metadata for Claude Code's capability gates.
  const EFFORT_BY_KEY = Object.create(null) as Record<
    string,
    PatchScriptModelEntry['effort']
  >;

  const report: PatchSiteResult[] = [];
  const fail = (message: string): never => {
    throw new PatchApplyError(message, report);
  };
  const capabilityKeys = (value: string): string[] => {
    const normalized = value.trim().toLowerCase();
    const bare = normalized.replace(/\[1m\]$/i, '');
    return [...new Set([bare, `${bare}[1m]`])];
  };
  const registerCapabilityKeys = (value: string): void => {
    for (const key of capabilityKeys(value)) {
      CONFIGURED_CAPABILITY_KEYS.add(key);
    }
  };

  for (const [id, value] of Object.entries(MODEL_CONFIG)) {
    const spec: PatchScriptModelEntry = value && typeof value === 'object' ? value : { alias: value as unknown as string };
    if (spec.alias !== undefined) {
      const rawAlias = String(spec.alias).trim();
      const a = rawAlias.toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]*(\[1m\])?$/.test(a)) {
        fail('clodex patch: alias "' + spec.alias + '" is not a safe lowercase alias');
      }
      if (isReservedModelAlias(a)) {
        fail('clodex patch: reserved alias "' + a + '" cannot be reassigned');
      }
      ALIAS_TO_ID[a] = String(id);
      IDENTITIES.push(a);
      if (spec.display) DISPLAY_BY_IDENTITY[a] = String(spec.display);
    } else {
      IDENTITIES.push(String(id));
      if (spec.display) DISPLAY_BY_IDENTITY[String(id)] = String(spec.display);
    }
    if (spec.alias !== undefined) {
      registerCapabilityKeys(String(spec.alias));
    }
    registerCapabilityKeys(String(id));

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

    if (spec.effort) {
      const effort = projectNativeEffort(spec.effort);
      if (!effort) {
        fail(
          `clodex patch: effort for "${id}" must include low, medium, and high with a native default`,
        );
      }
      if (spec.alias !== undefined) {
        for (const key of capabilityKeys(String(spec.alias))) {
          EFFORT_BY_KEY[key] = effort;
        }
      }
      for (const key of capabilityKeys(String(id))) {
        EFFORT_BY_KEY[key] = effort;
      }
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
  // Anchor: the aliases array ["sonnet",...,"fable"] wrapped in an enum
  // constructor and immediately followed by .optional().describe(. Builds
  // through 2.1.223 spell the constructor `.enum(`; 2.1.224+ minifies it to a
  // bare helper call on the model property (`model:xr([...])`), so both are
  // accepted. We append our identities (alias when defined, else the canonical
  // id) inside the enum so the tool accepts them — this is the same enum
  // subagent/skill 'model:' frontmatter is validated against, which is why
  // the short alias has to be the value that lands here.
  // (This same .describe( is patched by PATCH 4 below.)
  // ---------------------------------------------------------------------------
  applyOnce(
    'PATCH 1: Agent tool model enum',
    /((?:\.enum|model:[A-Za-z_$][\w$]*)\()(\["sonnet","opus","haiku"(?:,"[^"]+")*\])\)(\.optional\(\)\.describe\()/,
    (_m, open, arr, tail) => open! + extendAliasArray(arr!) + ')' + tail!,
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
  //
  // Anchor: the choke-point's own code — its `"opus"`/`"sonnet"` selection, which
  // is what makes it the MODEL picker and not merely a loop that appends things,
  // followed by the loop and the per-item appender. Every minified identifier is
  // wildcarded and repeats are tied together with back-references rather than
  // spelled out. Claude Code 2.1.238 shipped per-platform builds whose minifier
  // handed this function different names — `(e,t,r){let n=...}` on five of the
  // eight published builds, but `(e,t,n){let r=...}` on linux-arm64,
  // linux-arm64-musl and win32-arm64 — so an anchor naming `r` literally stopped
  // matching on the other three, and their users silently lost every custom
  // picker entry.
  // Keep BOTH halves. The back-references alone only make the identifiers
  // internally consistent; they do not say the function is the picker, and a
  // review demonstrated that a same-shaped neighbour could then be patched
  // instead if the real site ever drifted out of the match. The model-name
  // comparison is the discriminator; the wildcards are what survive a rename.
  // The tolerated run between the comparison and the pair is bounded to
  // `[^;{}]` so it cannot reach out of the statement it starts in.
  // The appender's FIRST argument is captured and the append snippet is bound to
  // that name, so we push into the very array the built-in options were just
  // appended to, under whatever name this build gave it, instead of into a
  // variable we assumed was called `e`.
  // The anchor deliberately stops before the function's `return`: the snippet is
  // spliced in between, so consuming the tail would make a re-run of the patch
  // report a missing anchor instead of the SKIP that keeps re-patching clean.
  //
  // The selection is ALSO counted across the whole bundle, and that check is not
  // redundant. "The anchor matched once" only means one candidate survived, not
  // that it was the right one: a review built a second builder with its own
  // opus/sonnet selection and moved the real picker out of the match by turning
  // `for(` into `for (` — one space — and PATCH 5 reported OK while injecting
  // into the impostor, where no user would ever see the entries. The anchor
  // BEGINS with the selection, so at most one site in the bundle can match it,
  // and that composition becomes a refusal.
  // State the guarantee precisely, because it rests on an assumption nothing
  // here tests: the counted site is the picker only while the picker keeps
  // spelling its selection THIS way. Respelt upstream to the equivalent
  // `(x==="sonnet"||x==="opus")` with something else adopting this spelling, the
  // survivor would be the wrong function again. No published bundle contains a
  // second selection in any spelling, and that needs two coordinated upstream
  // changes rather than one, so it is calibrated as unreachable rather than
  // defended against — adding more discriminators is what broke this patch on
  // three platforms in the first place. If only the spelling drifts, the count
  // goes to ZERO and PATCH 5 fails loudly (it is `required:false`, so the rest
  // of the patch still applies) and the release canary reports it on all eight
  // platforms. Failing loud is the direction to bias toward here.
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
    /** The append snippet, bound to whatever this build named the options array. */
    const injectInto = (options: string) =>
      missing.length
        ? '[' + entries + '].forEach(function(_o){if(!' + options + '.some(function(_i){return _i.value===_o.value}))' + options + '.push(_o)});'
        : '';
    const pickerSite = 'PATCH 5: model picker options';
    // MUST stay a prefix of the anchor below — that is what makes the count mean
    // "the anchor can only match the picker". A harness asserts the relationship
    // and, on every real bundle, that the anchor binds at this very offset.
    const modelSelections = [...js.matchAll(/\(([\w$]+)==="opus"\|\|\1==="sonnet"\)/g)];
    if (ALIASES.length === 0) {
      log('SKIP', pickerSite, 'no aliases configured');
    } else if (modelSelections.length !== 1) {
      log('FAIL', pickerSite, 'model selection appears ' + modelSelections.length + ' times (expected 1)');
    } else {
      applyOnce(
        pickerSite,
        /\(([\w$]+)==="opus"\|\|\1==="sonnet"\)[^;{}]*\?\[\1,([\w$]+)\]:\[\2\];for\(let ([\w$]+) of [\w$]+\)[\w$]+\(([\w$]+),\3,[\w$]+\);/,
        (m, _selected, _requested, _item, options) => m + injectInto(options!),
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
  // PATCH 8 — per-model effort capability gates.
  //
  // Claude Code checks three separate resolvers before it exposes effort at all,
  // includes xhigh/max in the picker, and emits effort.level in status hooks.
  // Inject model-specific lookups after the native denylist, but before the
  // built-in metadata and provider-fallback checks.
  // ---------------------------------------------------------------------------
  function patchEffortCapability(
    capability: 'effort' | 'xhigh_effort' | 'max_effort',
    marker: string,
    name: string,
    anchor: RegExp,
  ): void {
    const verdicts = Object.fromEntries(
      [...CONFIGURED_CAPABILITY_KEYS].map(key => {
        const effort = EFFORT_BY_KEY[key];
        return [
          key,
          effort !== undefined && (
            capability === 'effort'
            || effort.levels.includes(capability === 'xhigh_effort' ? 'xhigh' : 'max')
          ),
        ];
      }),
    );
    const hasMarker = js.includes(marker);
    if (Object.keys(verdicts).length === 0 && !hasMarker) return;

    const snippet = (arg: string) =>
      marker
      + 'var _ccv=Object.assign(Object.create(null),' + JSON.stringify(verdicts)
      + ')[String(' + arg + '||"").trim().toLowerCase()];'
      + 'if(_ccv!==void 0)return _ccv;';

    if (hasMarker) {
      const markerPattern = reEsc(marker);
      applyOnce(
        name + ' (refresh)',
        new RegExp(
          markerPattern
          + 'var _ccv=Object\\.assign\\(Object\\.create\\(null\\),\\{[^{}]*\\}\\)'
          + '\\[String\\(([\\w$]+)\\|\\|""\\)\\.trim\\(\\)\\.toLowerCase\\(\\)\\];'
          + 'if\\(_ccv!==void 0\\)return _ccv;',
        ),
        (_m, arg) => snippet(arg!),
        { required: false, noopIsSkip: true },
      );
      return;
    }

    applyOnce(
      name,
      anchor,
      (_m, head, arg, body) => head! + snippet(arg!) + body!,
      { required: false },
    );
  }

  patchEffortCapability(
    'effort',
    '/*ccpatch:effort*/',
    'PATCH 8a: effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"effort"\);)/,
  );
  patchEffortCapability(
    'xhigh_effort',
    '/*ccpatch:xhigh-effort*/',
    'PATCH 8b: xhigh effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"xhigh_effort"\);)/,
  );
  patchEffortCapability(
    'max_effort',
    '/*ccpatch:max-effort*/',
    'PATCH 8c: max effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"max_effort"\);)/,
  );

  // ---------------------------------------------------------------------------
  // PATCH 9 — per-model default effort.
  // ---------------------------------------------------------------------------
  const DEFAULT_EFFORT_MARKER = '/*ccpatch:default-effort*/';
  const defaults = Object.fromEntries(
    Object.entries(EFFORT_BY_KEY).map(([key, effort]) => [key, effort!.defaultLevel]),
  );
  if (Object.keys(defaults).length || js.includes(DEFAULT_EFFORT_MARKER)) {
    const snippet = (arg: string) =>
      DEFAULT_EFFORT_MARKER
      + 'var _cce=Object.assign(Object.create(null),' + JSON.stringify(defaults)
      + ')[String(' + arg + '||"").trim().toLowerCase()];'
      + 'if(_cce!==void 0)return _cce;';

    if (js.includes(DEFAULT_EFFORT_MARKER)) {
      applyOnce(
        'PATCH 9: default effort (refresh)',
        /\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\(([\w$]+)\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_cce!==void 0\)return _cce;/,
        (_m, arg) => snippet(arg!),
        { required: false, noopIsSkip: true },
      );
    } else {
      applyOnce(
        'PATCH 9: default effort',
        /(function [\w$]+\(([\w$]+)\)\{)(return [\w$]+\([\w$]+\(\2\)\)\?\.default_effort\?\?"high"\})/,
        (_m, head, arg, body) => head! + snippet(arg!) + body!,
        { required: false },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 10 — child command network environment.
  //
  // The wrapper routes the parent client through a local bridge and records the
  // external and injected values. In the shared child-environment builder,
  // revert a key only while its live value still equals the Clodex injection.
  // Settings-level overrides therefore remain authoritative, and the builder's
  // existing filtering continues against the resulting copy.
  //
  // Both ends of the anchor are described by what the builder MEANS, because both
  // ends have drifted with upstream refactors:
  //
  //   * head — Claude Code 2.1.228 hoisted the settings-colour env into its own
  //     declarator, and 2.1.239 rewrote the whole opening `let` again: the agent
  //     proxy env moved behind `sUn.of(lr().host)` and the settings-colour env
  //     became a DESTRUCTURING declarator (`{settingsColorEnv:n}=e`). Spelling
  //     the declarators out, or forbidding braces in the run between them, read
  //     both of those as "anchor not found" — and because PATCH 10 is required,
  //     `clodex patch` then refused to patch the release at all, on every
  //     platform. So the head run is now "anything up to the CLAUDE_CODE_REMOTE
  //     ternary, containing no `;` and no unmatched brace": `[^;{}]` characters
  //     or a single balanced `{...}` group. That still cannot leave the `let`
  //     statement it starts in, let alone the function — consuming the enclosing
  //     function's closing `}` would need an unmatched brace.
  //
  //   * tail — through 2.1.238 the builder ended by scrubbing GitHub Actions
  //     inputs (``delete p[`INPUT_${f}`]``); 2.1.239 dropped that entirely. The
  //     tail is now tied to the merged copy by BACK-REFERENCE: the same variable
  //     the builder declares for `{...process.env,...}` is the one it returns at
  //     the end. That is upstream-refactor-proof in a way a named statement is
  //     not, and it also proves we stopped at the function's own closing brace.
  //
  // Identity is carried by the passthrough early-out — `)return process.env;let
  // <copy>={` — which only the shared child-env builder can mean ("nothing to
  // change, so hand the parent's own env straight through, otherwise start a
  // copy"). It is counted across the WHOLE bundle before the anchor runs, so a
  // second candidate fails loud instead of being silently preferred; over 29
  // real bundles (2.1.208 through every 2.1.239 build) it occurs exactly once,
  // and exactly one `<fn>(process.env.CLAUDE_CODE_REMOTE)?` ternary precedes it.
  // Those two facts together are what pin the head to the real builder.
  //
  // The literal, nested-function and brace-balance checks below are the last
  // line: they reject a match that ends at a nested `return <copy>}` (which
  // would truncate the function) or that swallowed a neighbour.
  // ---------------------------------------------------------------------------
  {
    const patchName = 'PATCH 10: child network environment';
    const marker = '/*ccpatch:child-network-env*/';
    const contractVar = q(NETWORK_ENV_CONTRACT_VAR);
    const networkVars = JSON.stringify(CHILD_NETWORK_ENV_VARS);
    const requiredBodyLiterals = [
      '{...process.env',
      'CLAUDE_CODE_REMOTE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SUBSCRIPTION_TYPE',
      'CLAUDE_BG_PTY_AUTH',
      '"OTEL_"',
      'CLAUDE_CODE_OTEL_DIAG_STDERR',
    ];
    /**
     * Index of the `}` closing the block opened at `open`, or -1 if the scan runs
     * off the end. Braces inside strings, template literals and comments do not
     * count — a plain `{`/`}` tally does, and a single `"}"` in a string is enough
     * to make it agree with a match that stopped in the middle of the function.
     *
     * A `/` is read as division, never as the start of a regex literal, because
     * telling those apart needs the grammar. That is a real limit, not a safe
     * approximation: a review built a builder ending
     * `…if(x){var re=/}/;return <copy>}…;return <copy>}` where the unbalanced `}`
     * inside the regex literal moved this walk's zero-crossing onto the NESTED
     * return, so a truncated match agreed with it and PATCH 10 reported OK with
     * a live `process.env` read stranded past the rewritten span. It is left
     * as-is deliberately: no such shape occurs in any of the 29 real bundles
     * from 2.1.208 to 2.1.239, it needs a regex literal no minifier emits here,
     * and closing it means parsing JavaScript. Every wrong bind reachable from a
     * shape a real build could emit fails LOUD instead.
     */
    const blockEndIndex = (text: string, open: number): number => {
      // Each entry is a brace depth; a new entry is pushed on entering `${`.
      const depths: number[] = [0];
      const templates: boolean[] = [false];
      for (let i = open; i < text.length; i++) {
        const ch = text[i];
        const inTemplate = templates[templates.length - 1]!;
        if (inTemplate) {
          if (ch === '\\') { i++; continue; }
          if (ch === '`') { templates.pop(); depths.pop(); continue; }
          if (ch === '$' && text[i + 1] === '{') { templates.push(false); depths.push(0); i++; }
          continue;
        }
        if (ch === '\\') { i++; continue; }
        if (ch === '"' || ch === "'") {
          const quote = ch;
          for (i++; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (text[i] === quote) break;
          }
          continue;
        }
        if (ch === '`') { templates.push(true); depths.push(0); continue; }
        if (ch === '/' && text[i + 1] === '/') {
          while (i < text.length && text[i] !== '\n') i++;
          continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
          i = text.indexOf('*/', i + 2);
          if (i < 0) return -1;
          i++;
          continue;
        }
        if (ch === '{') { depths[depths.length - 1]!++; continue; }
        if (ch === '}') {
          if (depths[depths.length - 1] === 0 && templates.length > 1) {
            // Closes a `${…}` and hands control back to the template literal.
            templates.pop();
            depths.pop();
            continue;
          }
          depths[depths.length - 1]!--;
          if (depths.length === 1 && depths[0] === 0) return i;
        }
      }
      return -1;
    };
    // Count against the ORIGINAL source, not the partly-patched `js`: PATCH 4 and
    // PATCH 5 splice user-supplied model display text into the bundle, so counting
    // afterwards lets a model label that happens to contain this signal refuse a
    // patch that would otherwise succeed.
    //
    // Patching an already-patched bundle rewrites `return process.env` to
    // `return _clodexChildEnv`, so the count is only meaningful pre-patch —
    // applyOnce reports SKIP for that case and must still be allowed to.
    const passthroughSites = source.includes(marker)
      ? 1
      : (source.match(/\)return process\.env;let [\w$]+=\{/g) ?? []).length;
    if (passthroughSites !== 1) {
      log('FAIL', patchName, 'child env passthrough appears ' + passthroughSites + ' times (expected 1)');
      fail('clodex patch: required patch failed: ' + patchName);
    }
    applyOnce(
      patchName,
      /(function [\w$]+\(\)\{)(let (?:[^;{}]|\{[^;{}]*\})*?[\w$]+\(process\.env\.CLAUDE_CODE_REMOTE\)\?(?:(?!\}\s*function )[\s\S])*?\)return process\.env;let ([\w$]+)=\{(?:(?!\}\s*function )[\s\S])*?return \3)(\})/,
      (match, head, body, _copyVar, tail) => {
        // The tail is found lazily, so it can stop in the wrong place in EITHER
        // direction, and both are silent without this check:
        //   * short — a nested `return <copy>}` ends the match inside the
        //     function, so only part of it is rewritten and live `process.env`
        //     reads survive;
        //   * long — if the builder's own final `return <copy>}` is ever
        //     minified to the comma form `return f(),<copy>}` (400+ of those
        //     already exist elsewhere in 2.1.239), the tail runs past the true
        //     end into a neighbour and rewrites ITS `process.env` to a name
        //     that is out of scope there, which throws at runtime. The
        //     `}<space>function` guard does not stop this: a neighbour written
        //     `};var x=()=>{` never matches it.
        // Walking the real block from the function's own `{` rules out both:
        // the anchor's end must BE the function's end.
        const at = js.indexOf(match);
        const bound = at < 0
          ? -1
          : blockEndIndex(js, at + head!.length - 1) - at - (match.length - 1);
        const targetIsValid = requiredBodyLiterals.every(literal => body!.includes(literal))
          && !/\bfunction\s*[\w$]*\(/.test(body!)
          && bound === 0;
        if (!targetIsValid) {
          log('FAIL', patchName, 'target validation failed');
          fail('clodex patch: child network environment target validation failed');
        }
        const restoredBody = body!.replace(/process\.env/g, '_clodexChildEnv');
        const restore = marker
          + 'let _clodexChildEnv=process.env,_clodexNetworkRaw=_clodexChildEnv[' + contractVar + '];'
          + 'if(_clodexNetworkRaw!==void 0){_clodexChildEnv={..._clodexChildEnv};'
          + 'delete _clodexChildEnv[' + contractVar + '];try{'
          + 'let _clodexNetwork=JSON.parse(_clodexNetworkRaw);'
          + 'if(_clodexNetwork&&typeof _clodexNetwork==="object"&&!Array.isArray(_clodexNetwork)'
          + '&&_clodexNetwork.version===1&&_clodexNetwork.original'
          + '&&typeof _clodexNetwork.original==="object"&&!Array.isArray(_clodexNetwork.original)'
          + '&&_clodexNetwork.injected&&typeof _clodexNetwork.injected==="object"'
          + '&&!Array.isArray(_clodexNetwork.injected)'
          + '&&Object.keys(_clodexNetwork.original).every(_clodexKey=>'
          + networkVars + '.includes(_clodexKey)'
          + '&&(typeof _clodexNetwork.original[_clodexKey]==="string"'
          + '||_clodexNetwork.original[_clodexKey]===null)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.injected,_clodexKey))'
          + '&&Object.keys(_clodexNetwork.injected).every(_clodexKey=>'
          + networkVars + '.includes(_clodexKey)'
          + '&&(typeof _clodexNetwork.injected[_clodexKey]==="string"'
          + '||_clodexNetwork.injected[_clodexKey]===null)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.original,_clodexKey)))'
          + 'for(let _clodexKey of ' + networkVars + '){'
          + 'if(Object.prototype.hasOwnProperty.call(_clodexNetwork.original,_clodexKey)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.injected,_clodexKey)){'
          + 'let _clodexOriginal=_clodexNetwork.original[_clodexKey],'
          + '_clodexInjected=_clodexNetwork.injected[_clodexKey],'
          + '_clodexCurrent=_clodexChildEnv[_clodexKey]===void 0?null:_clodexChildEnv[_clodexKey];'
          + 'if((typeof _clodexOriginal==="string"||_clodexOriginal===null)'
          + '&&(typeof _clodexInjected==="string"||_clodexInjected===null)'
          + '&&_clodexCurrent===_clodexInjected){if(_clodexOriginal===null)'
          + 'delete _clodexChildEnv[_clodexKey];else '
          + '_clodexChildEnv[_clodexKey]=_clodexOriginal}}}}catch(_clodexError){}}';
        return head! + restore + restoredBody + tail!;
      },
      { marker, required: true },
    );
  }

  return { content: js, results: report };
}
