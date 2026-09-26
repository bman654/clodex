import { describe, expect, it } from 'vitest';
import { applyClodexPatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import { CLAUDE_FIXTURE, PICKER_ENTRY_POINT } from './fixtures/claude-bundle.js';

// PATCH 11 injects the clodex rows at the /model picker's entry point, where the served-catalog
// builder and the legacy builder PATCH 5 patches converge. These tests EXECUTE the patched entry
// point, together with the patched legacy builder it falls back to, on both paths. Reading the
// emitted text is not evidence it runs: an emission that names the catalog variable where it means
// the merged one still carries every row literal, and throws on every account with no catalog.

const CONFIG: PatchScriptModelConfig = {
  'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', display: 'GPT-5.6 Sol (OpenAI (ChatGPT))' },
  'clodex:openai-oauth:gpt-5.6-luna': { alias: 'luna', display: 'GPT-5.6 Luna (OpenAI (ChatGPT))' },
};

const SOL = { value: 'sol', label: 'Sol', description: 'GPT-5.6 Sol (OpenAI (ChatGPT))' };
const LUNA = { value: 'luna', label: 'Luna', description: 'GPT-5.6 Luna (OpenAI (ChatGPT))' };

interface Row { value: string; label?: string; description?: string }

/** A function declaration sliced out of the bundle by brace matching. */
function declaration(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} present`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} is unbalanced`);
}

/**
 * Run the picker's entry point from `source`. `catalog` is what the served-catalog builder
 * returns — a fresh copy per call, as Claude Code's builder does — or null for an account that is
 * served none. The legacy builder is the fixture's real `opts`, so PATCH 5's rows are in the array
 * whenever it runs, and `legacyCalls` counts how often it did.
 */
function runPicker(source: string, catalog: Row[] | null): { rows: Row[]; legacyCalls: number } {
  let legacyCalls = 0;
  const entry = Function(
    'fromCatalog',
    'cur',
    'Dlh',
    'env',
    `${declaration(source, 'opts')}\n${declaration(source, 'mkOpts')};return mkOpts;`,
  )(
    () => (catalog === null ? null : catalog.map(row => ({ ...row }))),
    () => { legacyCalls++; return 'opus'; },
    (options: Row[], name: string | undefined) => { if (name !== undefined) options.push({ value: name }); },
    {},
  ) as (options: Row[], ctx: unknown) => Row[];
  const rows = entry([], null);
  return { rows, legacyCalls };
}

const SERVED: Row[] = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Most capable' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Efficient' },
];

describe('PATCH 11: catalog picker options', () => {
  const patched = applyClodexPatches(CLAUDE_FIXTURE, CONFIG).content;

  it('lists the aliases after the served catalog, and never calls the legacy builder', () => {
    expect(runPicker(patched, SERVED)).toEqual({
      rows: [...SERVED, SOL, LUNA],
      legacyCalls: 0,
    });
  });

  it('lists each alias exactly once when no catalog is served and PATCH 5 already added it', () => {
    expect(runPicker(patched, null)).toEqual({
      rows: [{ value: 'opus' }, SOL, LUNA],
      legacyCalls: 1,
    });
  });

  // The legacy builder does not always hold PATCH 5's rows: its branch for Bedrock, Vertex,
  // Foundry and Mantle never reaches PATCH 5's choke point, and a build can move the choke point
  // out of PATCH 5's match.
  // Then the rows PATCH 11 adds are the only ones, and they must land in the array the entry point
  // returns — the catalog variable is null on this path.
  it('lists the aliases when no catalog is served and PATCH 5 missed the legacy builder', () => {
    const legacyLoop = 'for(let i of o)Dlh(e,i,t);';
    expect(CLAUDE_FIXTURE, 'fixture carries the legacy loop').toContain(legacyLoop);
    const source = CLAUDE_FIXTURE.replace(legacyLoop, 'for(let i of o){Dlh(e,i,t);}');
    const result = applyClodexPatches(source, CONFIG);
    expect(result.results.find(r => r.name === 'PATCH 5: model picker options')?.status).toBe('FAIL');

    expect(runPicker(result.content, null)).toEqual({
      rows: [{ value: 'opus' }, SOL, LUNA],
      legacyCalls: 1,
    });
  });

  it('keeps a served row whose value is an alias instead of adding a second one', () => {
    const serverSol = { value: 'sol', label: 'Server Sol', description: 'From the catalog' };
    expect(runPicker(patched, [...SERVED, serverSol]).rows)
      .toEqual([...SERVED, serverSol, LUNA]);
  });

  // PATCH 5 splices model display names into the bundle before PATCH 11 runs, and a custom
  // provider's model name is the user's own text. On a build with no matching picker entry point, a name
  // spelling the anchor would be its only match, and the rows would be spliced into that name's
  // string literal — a syntax error in a bundle nothing downstream parses.
  it('reports a miss on a build with no matching entry point even when a model name spells the anchor', () => {
    const spelled = 'function q(e,n){let r=a(e,n),s=r??b(e),t=ANTHROPIC_CUSTOM_MODEL_OPTION';
    const config: PatchScriptModelConfig = { 'clodex:custom:odd': { alias: 'odd', display: spelled } };
    const olderBuild = CLAUDE_FIXTURE.replace(PICKER_ENTRY_POINT, '');
    expect(olderBuild, 'fixture has no matching entry point').not.toContain('function mkOpts(');

    const result = applyClodexPatches(olderBuild, config);

    expect(result.results.find(r => r.name === 'PATCH 5: model picker options')?.status).toBe('OK');
    expect(result.results.find(r => r.name === 'PATCH 11: catalog picker options'))
      .toEqual({ status: 'FAIL', name: 'PATCH 11: catalog picker options', extra: 'anchor not found' });
    expect(result.content).toContain(JSON.stringify(spelled));
  });

  it('is what puts the aliases on the served path: the unpatched entry point lists none', () => {
    expect(runPicker(CLAUDE_FIXTURE, SERVED).rows).toEqual(SERVED);
  });

  // A declarator is a safe splice only where the fallback call ends — before the `let` goes on
  // with a comma, or before the statement's `;`. A build that chains onto the fallback must be a
  // loud miss, not a patch that runs the chained call on the wrong value.
  it('still lists the aliases when the build ends the statement after the fallback call', () => {
    const drifted = PICKER_ENTRY_POINT.replace('s=r??opts(e),d=env.', 's=r??opts(e);let d=env.');
    expect(drifted, 'fixture variant applied').not.toBe(PICKER_ENTRY_POINT);
    const result = applyClodexPatches(CLAUDE_FIXTURE.replace(PICKER_ENTRY_POINT, drifted), CONFIG);

    expect(result.results.find(r => r.name === 'PATCH 11: catalog picker options')?.status).toBe('OK');
    expect(runPicker(result.content, SERVED).rows).toEqual([...SERVED, SOL, LUNA]);
  });

  it.each([
    ['chains a copy onto the fallback', 's=r??opts(e).slice(),d=env.'],
    ['chains a filter onto the fallback', 's=r??opts(e)?.filter(Boolean),d=env.'],
  ])('reports a miss, and leaves the entry point alone, when the build %s', (_shape, tail) => {
    const drifted = PICKER_ENTRY_POINT.replace('s=r??opts(e),d=env.', tail);
    expect(drifted, 'fixture variant applied').not.toBe(PICKER_ENTRY_POINT);
    const source = CLAUDE_FIXTURE.replace(PICKER_ENTRY_POINT, drifted);

    const result = applyClodexPatches(source, CONFIG);

    expect(result.results.find(r => r.name === 'PATCH 11: catalog picker options'))
      .toEqual({ status: 'FAIL', name: 'PATCH 11: catalog picker options', extra: 'anchor not found' });
    expect(result.content).toContain(drifted);
  });
});
