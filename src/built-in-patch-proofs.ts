import type {
  PatchScriptModelConfig,
  PatchSiteResult,
} from './patch-transforms.js';

/**
 * Version of the proof set below, folded into the patch config hash ONLY while local patches are
 * enabled (`computePatchConfigHash`). Proofs decide whether local patches publish, so a proof fix
 * changes what an install with local patches gets — and without a hash change that install stays
 * `current` until something else re-patches it (a Claude Code update, a config change). Installs
 * without local patches never run a proof, so their hash, and their patch, are left alone.
 *
 * Bump it when a proof changes on its own. A change that lands together with a
 * `PATCH_TRANSFORMS_VERSION` bump needs no bump here, because that one already re-patches every
 * install. A test pins this file's digest so the decision is made deliberately.
 *
 * 1 — first version. The PATCH 1 proof knew only the inline enum array, so from Claude Code
 * 2.1.314, where PATCH 1 writes a spread over a hoisted constant, capture threw and every enabled
 * local patch was dropped with "could not capture built-in postconditions". Adding the version
 * changes every local-patch hash once, so those installs re-patch even if nothing else changed.
 */
export const BUILT_IN_PATCH_PROOFS_VERSION = 1;

export interface BuiltInPatchProof {
  name: string;
  protectedText: string;
  occurrences: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countExactOccurrences(source: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function uniqueMatch(source: string, name: string, pattern: RegExp): string {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  const match = matcher.exec(source);
  if (!match || matcher.exec(source)) {
    throw new Error(`clodex patch: could not capture built-in postcondition: ${name}`);
  }
  return match[0];
}

function captureNeedle(
  source: string,
  name: string,
  needle: string,
  expected = 1,
): BuiltInPatchProof {
  if (countExactOccurrences(source, needle) !== expected) {
    throw new Error(`clodex patch: could not capture built-in postcondition: ${name}`);
  }
  return {
    name,
    protectedText: needle,
    occurrences: expected,
  };
}

function capturePattern(
  source: string,
  name: string,
  pattern: RegExp,
): BuiltInPatchProof {
  return captureNeedle(source, name, uniqueMatch(source, name, pattern));
}

function normalizedPatchName(name: string): string {
  return name.replace(/ \(refresh\)$/, '');
}

function protectsResult(results: PatchSiteResult[], name: string): boolean {
  const result = results.find(entry => normalizedPatchName(entry.name) === name);
  return result !== undefined
    && result.status !== 'FAIL'
    && result.extra !== 'no aliases configured';
}

function configuredAliases(config: PatchScriptModelConfig): Array<{
  alias: string;
  id: string;
  display?: string;
}> {
  const aliases = new Map<string, { id: string; display?: string }>();
  for (const [id, entry] of Object.entries(config)) {
    if (entry.alias === undefined) continue;
    for (const name of [entry.alias, ...(entry.moreAliases ?? [])]) {
      aliases.set(String(name).trim().toLowerCase(), {
        id,
        ...(entry.display === undefined ? {} : { display: String(entry.display) }),
      });
    }
  }
  return [...aliases].map(([alias, entry]) => ({ alias, ...entry }));
}

function effortProofPattern(marker: string): RegExp {
  return new RegExp(
    escapeRegex(marker)
    + 'var _ccv=Object\\.assign\\(Object\\.create\\(null\\),\\{[^{}]*\\}\\)'
    + '\\[String\\([\\w$]+\\|\\|""\\)\\.trim\\(\\)\\.toLowerCase\\(\\)\\];'
    + 'if\\(_ccv!==void 0\\)return _ccv;',
  );
}

export function captureBuiltInPatchProofs(
  source: string,
  config: PatchScriptModelConfig,
  results: PatchSiteResult[],
): BuiltInPatchProof[] {
  const proofs: BuiltInPatchProof[] = [];
  const addPattern = (name: string, pattern: RegExp): void => {
    if (protectsResult(results, name)) {
      proofs.push(capturePattern(source, name, pattern));
    }
  };

  // Both shapes PATCH 1 writes: the extended inline array, and — from 2.1.314, where the array is
  // a constant passed by name — the spread `model:F([...dmi,"sol"])`. The spread shape is pinned to
  // the Agent tool's description exactly as the transform's anchor is, because the spread alone
  // says nothing about which enum it is. This proof knew only the inline shape until the spread one
  // was added here, so on 2.1.314 and later capture threw and every enabled local patch was dropped.
  addPattern(
    'PATCH 1: Agent tool model enum',
    /(?:\.enum|model:[A-Za-z_$][\w$]*)\(\["sonnet","opus","haiku"(?:,"[^"]+")*\]\)\.optional\(\)\.describe\(|model:[A-Za-z_$][\w$]*\(\[\.\.\.[A-Za-z_$][\w$]*(?:,"[^"]+")*\]\)\.optional\(\)\.describe\(`Optional model override for this agent/,
  );
  addPattern(
    'PATCH 3: known-alias validator list',
    /\["sonnet","opus","haiku","fable"(?:,"[^"]+")*,"opusplan"(?:,"[^"]+")*\]/,
  );
  // Ends at the template's own closing backtick, not at the `)` that used to follow it: Claude
  // Code 2.1.242 started concatenating a conditional sentence onto the same string, and a proof
  // that could no longer find the site turned every local patch into "could not capture built-in
  // postconditions" — the same drift PATCH 4's own anchor had to absorb.
  addPattern(
    'PATCH 4: Agent tool model description',
    /describe\(`Optional model override for this agent(?:[^`\\]|\\.)*?`/,
  );

  const aliases = configuredAliases(config);
  if (protectsResult(results, 'PATCH 6: alias resolver switch')) {
    for (const { alias } of aliases) {
      const value = JSON.stringify(alias);
      proofs.push(captureNeedle(
        source,
        `PATCH 6: alias resolver switch (${alias})`,
        `case${value}:return ${value};`,
      ));
    }
  }
  // Both picker sites emit the SAME row literal — PATCH 5 into the legacy builder, PATCH 11 into
  // the entry point the served-catalog builder returns through — so the row is proof of however
  // many of them applied, and pinning it at one occurrence would fail the moment both do.
  const pickerSites = [
    'PATCH 5: model picker options',
    'PATCH 11: catalog picker options',
  ].filter(name => protectsResult(results, name));
  if (pickerSites.length > 0) {
    for (const { alias, id, display } of aliases) {
      const entry = '{value:' + JSON.stringify(alias)
        + ',label:' + JSON.stringify(alias.charAt(0).toUpperCase() + alias.slice(1))
        + ',description:' + JSON.stringify(display ?? `Custom model (${id})`) + '}';
      proofs.push(captureNeedle(
        source,
        `model picker options (${alias})`,
        entry,
        pickerSites.length,
      ));
    }
  }
  addPattern(
    'PATCH 11: catalog picker options',
    /,_ccpick=\/\*ccpatch:picker\*\/\[[\s\S]*?\]\.forEach\(function\(_o\)\{if\(![\w$]+\.some\(function\(_i\)\{return _i\.value===_o\.value\}\)\)[\w$]+\.push\(_o\)\}\)/,
  );

  addPattern(
    'PATCH 7: per-model context window',
    /\/\*ccpatch:ctx\*\/var _ccw=\(\{[^{}]*\}\)\[[^\]]*\];if\(_ccw!==void 0\)return _ccw;/,
  );
  // PATCH 7 writes this second snippet only on a bundle whose resolver is split (2.1.325+).
  if (protectsResult(results, 'PATCH 7: per-model context window') && source.includes('/*ccpatch:ctx-credits*/')) {
    proofs.push(capturePattern(
      source,
      'PATCH 7: per-model context window (credits clamp)',
      /\/\*ccpatch:ctx-credits\*\/if\(\(\{[^{}]*\}\)\[[^\]]*\]!==void 0\)return!1;/,
    ));
  }
  addPattern(
    'PATCH 8a: effort capability',
    effortProofPattern('/*ccpatch:effort*/'),
  );
  addPattern(
    'PATCH 8b: xhigh effort capability',
    effortProofPattern('/*ccpatch:xhigh-effort*/'),
  );
  addPattern(
    'PATCH 8c: max effort capability',
    effortProofPattern('/*ccpatch:max-effort*/'),
  );
  addPattern(
    'PATCH 9: default effort',
    /\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\([\w$]+\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_cce!==void 0\)return _cce;/,
  );
  addPattern(
    'PATCH 10: child network environment',
    /\/\*ccpatch:child-network-env\*\/let _clodexChildEnv=process\.env,[\s\S]*?catch\(_clodexError\)\{\}\}/,
  );

  return proofs;
}

export function builtInPatchProofsChanged(
  source: string,
  proofs: BuiltInPatchProof[],
): boolean {
  return proofs.some(
    proof => countExactOccurrences(source, proof.protectedText) !== proof.occurrences,
  );
}
