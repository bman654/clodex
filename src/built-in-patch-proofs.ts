import type {
  PatchScriptModelConfig,
  PatchSiteResult,
} from './patch-transforms.js';

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
    const alias = String(entry.alias).trim().toLowerCase();
    aliases.set(alias, {
      id,
      ...(entry.display === undefined ? {} : { display: String(entry.display) }),
    });
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
  // Ends at the template's own closing backtick, not at the `)` that used to follow it: Claude
  // Code 2.1.242 started concatenating a conditional sentence onto the same string, and a proof
  // that could no longer find the site turned every local patch into "could not capture built-in
  // postconditions" — the same drift PATCH 4's own anchor had to absorb.
  addPattern(
    'PATCH 4: Agent tool model description',
    /describe\(`Optional model override for this agent[^`]*?`/,
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
