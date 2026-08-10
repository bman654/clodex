import type {
  PatchScriptModelConfig,
  PatchSiteResult,
} from './patch-transforms.js';
import { patchEntryAliases } from './patch-transforms.js';

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
): BuiltInPatchProof {
  if (countExactOccurrences(source, needle) !== 1) {
    throw new Error(`clodex patch: could not capture built-in postcondition: ${name}`);
  }
  return {
    name,
    protectedText: needle,
    occurrences: 1,
  };
}

function capturePattern(
  source: string,
  name: string,
  pattern: RegExp,
): BuiltInPatchProof {
  return captureNeedle(source, name, uniqueMatch(source, name, pattern));
}

function capturePatternOccurrences(
  source: string,
  name: string,
  pattern: RegExp,
  expected: number,
): BuiltInPatchProof[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))].map(match => match[0]);
  if (matches.length !== expected) {
    throw new Error(`clodex patch: could not capture built-in postcondition: ${name}`);
  }
  return matches.map((match, index) => ({
    name: `${name} (${index + 1}/${expected})`,
    protectedText: match,
    occurrences: 1,
  }));
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
    for (const alias of patchEntryAliases(entry)) {
      aliases.set(alias, {
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

  addPattern(
    'PATCH 1: Agent tool model enum',
    /(?:\.enum|model:[A-Za-z_$][\w$]*)\(\["sonnet","opus","haiku"(?:,"[^"]+")*\]\)\.optional\(\)\.describe\(/,
  );
  addPattern(
    'PATCH 3: known-alias validator list',
    /\["sonnet","opus","haiku","fable"(?:,"[^"]+")*,"opusplan"(?:,"[^"]+")*\]/,
  );
  addPattern(
    'PATCH 4: Agent tool model description',
    /describe\(`Optional model override for this agent[^`]*?`\)/,
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
  if (protectsResult(results, 'PATCH 5: model picker options')) {
    for (const { alias, id, display } of aliases) {
      const entry = '{value:' + JSON.stringify(alias)
        + ',label:' + JSON.stringify(alias.charAt(0).toUpperCase() + alias.slice(1))
        + ',description:' + JSON.stringify(display ?? `Custom model (${id})`) + '}';
      proofs.push(captureNeedle(
        source,
        `PATCH 5: model picker options (${alias})`,
        entry,
      ));
    }
  }

  addPattern(
    'PATCH 7: per-model context window',
    /\/\*ccpatch:ctx\*\/var _ccw=\(\{[^{}]*\}\)\[[^\]]*\];if\(_ccw!==void 0\)return _ccw;/,
  );
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
    'PATCH 8d: exact effort level helper',
    /\/\*ccpatch:effort-level-list\*\/var _ccl=Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\([\w$]+\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_ccl!==void 0\)return _ccl\.filter\(function\(_cclv\)\{return [\w$]+\(_cclv,[\w$]+\)\}\);/,
  );
  if (protectsResult(results, 'PATCH 8e: exact effort metadata lists')) {
    proofs.push(...capturePatternOccurrences(
      source,
      'PATCH 8e: exact effort metadata lists',
      /supportedEffortLevels:\(\/\*ccpatch:effort-level-consumer\*\/Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\([\w$]+\|\|""\)\.trim\(\)\.toLowerCase\(\)\]\?\?PM\)\.filter\(\([\w$]+\)=>\{if\([\w$]+==="max"&&![\w$]+\([\w$]+\)\)return!1;if\([\w$]+==="xhigh"&&![\w$]+\([\w$]+\)\)return!1;return!0\}\)/,
      2,
    ));
  }
  addPattern(
    'PATCH 8f: preserve requested effort',
    /\/\*ccpatch:requested-effort\*\/if\(typeof [\w$]+==="string"&&[\w$]+\([\w$]+\)\)\{var _ccl=Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\([\w$]+\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_ccl!==void 0\)return [\w$]+;\}/,
  );
  addPattern(
    'PATCH 9: default effort',
    /\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\([\w$]+\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_cce!==void 0\)return _cce;/,
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
