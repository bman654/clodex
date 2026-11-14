// PATCH 1 on the Agent tool's model enum as Claude Code 2.1.314 spells it.
//
// 2.1.314 moved the enum's array into a constant exported from another module
// (`dmi=["sonnet","opus","haiku","fable"]`, minified per build: dmi, Tpi, Ppi) and the schema passes
// it by name, `model:F(dmi).optional().describe(`. The literal-array anchor found nothing on all
// eight builds and `clodex patch` refused every one.

import { describe, it, expect } from 'vitest';
import { applyClodexPatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import {
  builtInPatchProofsChanged,
  captureBuiltInPatchProofs,
} from '../src/built-in-patch-proofs.js';
import { CLAUDE_FIXTURE } from './fixtures/claude-bundle.js';

const LITERAL = '.enum(["sonnet","opus","haiku","fable"])';
// A fifth name Claude Code does not ship, so that a patch which re-spelled the four built-ins
// instead of spreading the constant would lose it and fail here.
const HOISTED_CONST = 'var dmi=["sonnet","opus","haiku","fable","mythos"];';
const BUILT_INS = ['sonnet', 'opus', 'haiku', 'fable', 'mythos'];
const CONFIG: PatchScriptModelConfig = {
  'clodex:openai-oauth:gpt-6.1-sol': { alias: 'sol', context: 272_000 },
  'clodex:openai:mystery': {},
};

/**
 * The fixture with the enum spelled the 2.1.314 way. `ref` is the minified constant's name and
 * `ctor` the schema helper's.
 */
function hoisted(ref = 'dmi', ctor = 'F'): string {
  expect(CLAUDE_FIXTURE).toContain(LITERAL);
  return `${HOISTED_CONST.replace('dmi', ref)}\n${CLAUDE_FIXTURE.replace(LITERAL, `model:${ctor}(${ref})`)}`;
}

/** Evaluate the patched enum call with `F` as the identity, so the result is the values it gets. */
function enumValues(source: string, ref = 'dmi'): string[] {
  const call = source.match(/model:F\((\[[^\]]*\]|[\w$]+)\)\.optional\(\)\.describe\(`Optional model override/);
  expect(call, 'the Agent tool enum call must still be there').not.toBeNull();
  // A plain string search: the constant's name may hold `$`, and nothing here needs a pattern.
  const head = `var ${ref}=`;
  const start = source.indexOf(head);
  expect(start, `the ${ref} definition must still be there`).toBeGreaterThanOrEqual(0);
  const definition = source.slice(start + head.length, source.indexOf('];', start) + 1);
  return new Function(`const ${ref}=${definition};const F=v=>v;return F(${call![1]});`)() as string[];
}

describe('PATCH 1 on the 2.1.314 hoisted enum', () => {
  it('adds every identity to the enum and keeps every built-in it was given', () => {
    const { content, results } = applyClodexPatches(hoisted(), CONFIG);

    expect(results.find(r => r.name === 'PATCH 1: Agent tool model enum')?.status).toBe('OK');
    expect(enumValues(content)).toEqual([...BUILT_INS, 'sol', 'clodex:openai:mystery']);
    // The constant is shared through an export; it stays exactly what Claude Code shipped.
    expect(content).toContain(HOISTED_CONST);
  });

  it('follows whatever name the minifier gave the constant', () => {
    const { content } = applyClodexPatches(hoisted('P$i'), CONFIG);
    expect(enumValues(content, 'P$i')).toEqual([...BUILT_INS, 'sol', 'clodex:openai:mystery']);
  });

  it('reads a patched enum as patched, and tops it up when a model is added', () => {
    const once = applyClodexPatches(hoisted(), CONFIG).content;

    const again = applyClodexPatches(once, CONFIG);
    expect(again.results.find(r => r.name === 'PATCH 1: Agent tool model enum')?.status).toBe('SKIP');
    expect(again.content).toBe(once);

    const more = applyClodexPatches(once, { ...CONFIG, 'clodex:openai:other': { alias: 'other' } }).content;
    expect(enumValues(more)).toEqual([...BUILT_INS, 'sol', 'clodex:openai:mystery', 'other']);
  });

  it('does not take a bare name for the Agent tool enum without the Agent tool description', () => {
    const elsewhere = hoisted().replace('`Optional model override for this agent', '`Optional model for this hook');
    expect(() => applyClodexPatches(elsewhere, CONFIG))
      .toThrow('clodex patch: required patch failed: PATCH 1: Agent tool model enum');
  });

  it('refuses a bundle carrying both spellings rather than patching one', () => {
    const both = `${hoisted()}\nmodel:N(["sonnet","opus","haiku"]).optional().describe(\`x\`)`;
    expect(() => applyClodexPatches(both, CONFIG))
      .toThrow('clodex patch: ambiguous anchor: PATCH 1: Agent tool model enum');
  });

  // The proof is what lets local patches publish: capture runs before them, and a throw drops every
  // one with "could not capture built-in postconditions". Until this shape was added it knew only
  // the inline array, so on 2.1.314 and later that happened on every build.
  describe('postcondition proof', () => {
    const ENUM_PROOF = 'PATCH 1: Agent tool model enum';
    const DESCRIBE = '.optional().describe(`Optional model override for this agent';
    // The fixture's names, one with a `$`, and a pair 2.1.325 really ships (darwin: `B`/`Xba`).
    const SPELLINGS = [
      { ref: 'dmi', ctor: 'F' },
      { ref: 'P$i', ctor: 'F' },
      { ref: 'Xba', ctor: 'B' },
    ];

    describe.each(SPELLINGS)('model:$ctor($ref)', ({ ref, ctor }) => {
      const spread = `model:${ctor}([...${ref},"sol","clodex:openai:mystery"])`;

      it('captures the spread PATCH 1 wrote, so a local edit elsewhere still publishes', () => {
        const { content, results } = applyClodexPatches(hoisted(ref, ctor), CONFIG);
        const proofs = captureBuiltInPatchProofs(content, CONFIG, results);

        expect(proofs.find(entry => entry.name === ENUM_PROOF)?.protectedText).toBe(spread + DESCRIBE);
        expect(builtInPatchProofsChanged(`${content}\n/*clodex-local:x*/void 0;`, proofs)).toBe(false);
      });

      it('reports a local edit that takes an identity back out of the spread', () => {
        const { content, results } = applyClodexPatches(hoisted(ref, ctor), CONFIG);
        const proofs = captureBuiltInPatchProofs(content, CONFIG, results);

        expect(content).toContain(spread);
        const dropped = content.replace(spread, `model:${ctor}([...${ref},"clodex:openai:mystery"])`);
        expect(builtInPatchProofsChanged(dropped, proofs)).toBe(true);
        const unspread = content.replace(spread, `model:${ctor}(${ref})`);
        expect(builtInPatchProofsChanged(unspread, proofs)).toBe(true);
      });
    });

    // A competing spread call on each side of the enum. A proof without the description pin finds
    // two matches and refuses; the one BEFORE also catches a proof whose array grammar runs on from
    // that earlier call into the enum's description, which would then report an edit to the decoy
    // as an edit to the enum.
    it('binds the Agent tool enum, not another spread call with a describe beside it', () => {
      const decoy = (name: string) =>
        `model:Q([...xyz,"${name}"]).optional().describe(\`Optional model for this hook\`)`;
      const source = `${decoy('before')}\n${hoisted()}\n${decoy('after')}`;
      const { content, results } = applyClodexPatches(source, CONFIG);
      const proofs = captureBuiltInPatchProofs(content, CONFIG, results);

      expect(proofs.find(entry => entry.name === ENUM_PROOF)?.protectedText)
        .toBe('model:F([...dmi,"sol","clodex:openai:mystery"])' + DESCRIBE);
      for (const name of ['before', 'after']) {
        const edited = content.replace(decoy(name), decoy(`${name}-edited`));
        expect(edited).not.toBe(content);
        expect(builtInPatchProofsChanged(edited, proofs)).toBe(false);
      }
    });
  });
});
