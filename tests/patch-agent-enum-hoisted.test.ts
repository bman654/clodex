// PATCH 1 on the Agent tool's model enum as Claude Code 2.1.314 spells it.
//
// 2.1.314 moved the enum's array into a constant exported from another module
// (`dmi=["sonnet","opus","haiku","fable"]`, minified per build: dmi, Tpi, Ppi) and the schema passes
// it by name, `model:F(dmi).optional().describe(`. The literal-array anchor found nothing on all
// eight builds and `clodex patch` refused every one.

import { describe, it, expect } from 'vitest';
import { applyClodexPatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
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

/** The fixture with the enum spelled the 2.1.314 way. `ref` is the minified constant's name. */
function hoisted(ref = 'dmi'): string {
  expect(CLAUDE_FIXTURE).toContain(LITERAL);
  return `${HOISTED_CONST.replace('dmi', ref)}\n${CLAUDE_FIXTURE.replace(LITERAL, `model:F(${ref})`)}`;
}

/** Evaluate the patched enum call with `F` as the identity, so the result is the values it gets. */
function enumValues(source: string, ref = 'dmi'): string[] {
  const call = source.match(/model:F\((\[[^\]]*\]|[\w$]+)\)\.optional\(\)\.describe\(`Optional model override/);
  expect(call, 'the Agent tool enum call must still be there').not.toBeNull();
  const definition = source.match(new RegExp(`var ${ref.replace(/\$/g, '\\$')}=(\\[[^\\]]*\\]);`))![1];
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
});
