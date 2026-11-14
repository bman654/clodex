// Built-in postcondition capture over every cached real Claude Code bundle.
//
// Local patches publish only if `captureBuiltInPatchProofs` can pin every built-in site the run
// applied, and only if a local edit that leaves those sites alone is then read as unchanged by both
// the proofs and the built-in re-verification `applyPatch` runs. From 2.1.314 to 2.1.325 the PATCH 1
// proof knew only the inline enum array, so capture threw on every build and every enabled local
// patch was dropped. Per bundle this runs the steps of that chain that do not need a local module:
// built-ins, capture, then the proof and re-verification checks on a neutral appended edit.
//
// Copy into tests/ to run (see README), with REVIEW_BUNDLE_DIR pointing at a directory of
// `<version>/<platform>.js` bundles — `node scripts/extract-cc-bundles.mjs` makes one:
//   REVIEW_BUNDLE_DIR=$HOME/.cache/clodex-review-bundles pnpm vitest run tests/<copy>.test.ts
// The vitest sandbox replaces HOME, so give it an absolute path.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyClodexPatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import {
  builtInPatchProofsChanged,
  captureBuiltInPatchProofs,
} from '../src/built-in-patch-proofs.js';

const ROOT = process.env.REVIEW_BUNDLE_DIR ?? '';
// The releases whose Agent tool enum is a hoisted constant, plus the last inline one as a control.
const VERSIONS = ['2.1.304', '2.1.314', '2.1.321', '2.1.323', '2.1.325'];
const CONFIG: PatchScriptModelConfig = {
  'clodex:openai-oauth:gpt-6.1-sol': { alias: 'sol', context: 272_000 },
};

const bundles = VERSIONS.flatMap(version => {
  const dir = join(ROOT, version);
  if (!ROOT || !existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.js')).map(f => ({ version, file: join(dir, f) }));
});

describe('built-in proofs over real bundles', () => {
  it('found bundles to check', () => {
    expect(bundles.length, `no bundles under ${ROOT || '(REVIEW_BUNDLE_DIR unset)'}`).toBeGreaterThan(0);
  });

  it.each(bundles)('$version $file: proofs capture and a neutral local edit publishes', ({ version, file }) => {
    const source = readFileSync(file, 'utf8');
    const built = applyClodexPatches(source, CONFIG);
    const proofs = captureBuiltInPatchProofs(built.content, CONFIG, built.results);

    const names = proofs.map(proof => proof.name);
    expect(names).toContain('PATCH 1: Agent tool model enum');
    if (version === '2.1.325') expect(names).toContain('PATCH 7: per-model context window (credits clamp)');
    const enumProof = proofs.find(proof => proof.name === 'PATCH 1: Agent tool model enum')!;
    expect(enumProof.protectedText).toContain('"sol"');

    // What `applyPatch` checks after local patches run (`builtInPatchVerificationFailed`): content
    // unchanged, and every site SKIP — except one that failed the first time, which must fail the
    // same way again.
    const local = `${built.content}\n/*clodex-local:probe*/void 0;`;
    expect(builtInPatchProofsChanged(local, proofs)).toBe(false);
    const again = applyClodexPatches(local, CONFIG);
    expect(again.content).toBe(local);
    // Matched by name as `builtInPatchVerificationFailed` matches them, not by position.
    const siteName = (name: string) => name.replace(/ \(refresh\)$/, '');
    const firstRun = new Map(built.results.map(result => [siteName(result.name), result]));
    expect(again.results).toHaveLength(built.results.length);
    for (const result of again.results) {
      const original = firstRun.get(siteName(result.name));
      expect(original, `${result.name} was not in the first run`).toBeDefined();
      if (original!.status === 'FAIL') {
        expect({ status: result.status, extra: result.extra }).toEqual({ status: 'FAIL', extra: original!.extra });
      } else {
        expect(result.status, result.name).toBe('SKIP');
      }
    }

    // And the proof is not vacuous: taking the identity back out of the enum is caught.
    const stripped = local.replace(enumProof.protectedText, enumProof.protectedText.replace(',"sol"', ''));
    expect(stripped).not.toBe(local);
    expect(builtInPatchProofsChanged(stripped, proofs)).toBe(true);
  }, 120_000);
});
