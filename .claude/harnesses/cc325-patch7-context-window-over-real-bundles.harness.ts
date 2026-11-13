// REVIEW HARNESS (not for merge into tests/) — PATCH 7, the per-model context-window lookup, against
// the resolver split Claude Code 2.1.325 shipped.
//
// Through 2.1.323 one two-parameter function decided every context window: env override, then the
// long-context-credits clamp, then the inner resolver. 2.1.325 moved the env override into the inner
// resolver and left the outer one as a three-parameter wrapper with a defaulted options object:
//   function Bg(e,n,r={context1mBeta:oat(e),longContextCredits:XDe()}){
//     let s=T1(e,n,r.context1mBeta);return qYs(s,r.longContextCredits)?cD:s}
// PATCH 7's anchor matched neither, so `clodex patch` refused every 2.1.325 build.
//
// This drives the REAL applyClodexPatches over every pristine bundle under REVIEW_BUNDLE_DIR (searched
// recursively, so point it at the whole cache) and measures:
//   - DIFFERENTIAL: on every bundle the previous transform set could patch, the new output is
//     byte-identical to the previous one (length + digest, never a 50 MB string diff)
//   - on every 2.1.325 bundle the previous set refuses and the new one applies PATCH 7 exactly once,
//     at the wrapper whose body threads `.context1mBeta` into the inner resolver
//   - THE LOAD-BEARING CLAIM: the inner resolver the wrapper calls is reachable only through the
//     wrapper, so every consumer reaches the lookup — its name occurs exactly twice in the wrapper's
//     own module (the declaration and the wrapper's call; a token count, so spread calls, `.call`
//     and value references are all counted) and it is not in that module's export list. The module
//     is cut on the bundle reader's separator, because minified names repeat across modules
//   - the patched wrapper EXECUTES: a table model returns its window even when the clamp says
//     "clamp" and the inner resolver would answer differently; an unbaked model falls through to
//     the inner resolver and the clamp still applies to it
//   - the long-context-credits clamp's SECOND application, the model-facts adapter
//     (`function A(f){return <clamp>(<selector>(f))}`), is patched exactly once, calls the wrapper's
//     own clamp (imported unrenamed from the wrapper's module, which exports it), and EXECUTED with its real selector exempts table
//     models while still clamping an unbaked 1M model
//   - the patched wrapper is the pristine one plus exactly the snippet (new Function() above has
//     parsed it; the bundle's modules use ESM `import`, so a whole-bundle vm.Script cannot), and a
//     second pass refreshes rather than double-injecting
//
//   printf "export default { test: { include: ['.claude/harnesses/**/*.harness.ts'], testTimeout: 1200000 } };\n" \
//     > /tmp/harness.vitest.config.ts
//   REVIEW_BUNDLE_DIR=~/.cache/clodex-review-bundles OLD_TRANSFORMS=/path/to/main/src/patch-transforms.ts \
//     npx vitest run --root . --config /tmp/harness.vitest.config.ts \
//     .claude/harnesses/cc325-patch7-context-window-over-real-bundles.harness.ts
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { applyClodexPatches, type PatchScriptModelConfig } from '../../src/patch-transforms.js';
import { BUNDLE_MODULE_SEPARATOR } from '../../src/bun-bundle.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';
const OLD_TRANSFORMS = process.env['OLD_TRANSFORMS'] ?? '';

const CONFIG: PatchScriptModelConfig = {
  'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000, display: 'GPT-5.6 Sol (OpenAI (ChatGPT))' },
  'clodex:openai-oauth:gpt-6-luna': { alias: 'luna', context: 1_000_000, display: 'GPT-6 Luna (OpenAI (ChatGPT))' },
};

function bundles(dir: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...bundles(full));
    else if (entry.endsWith('.js') && statSync(full).size > 1_000_000) out.push(full);
  }
  return out.sort();
}

const digest = (s: string) => `${s.length}:${createHash('sha256').update(s).digest('hex')}`;

const WRAPPER = /function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)=\{context1mBeta:[^{}]*,longContextCredits:[^{}]*\}\)\{let ([\w$]+)=([\w$]+)\(\2,\3,\4\.context1mBeta\);return ([\w$]+)\(\5,\4\.longContextCredits\)\?([\w$]+):\5\}/g;

const files = bundles(BUNDLE_DIR);
type Apply = typeof applyClodexPatches;
const oldApply: Apply | undefined = OLD_TRANSFORMS
  ? ((await import(OLD_TRANSFORMS)) as { applyClodexPatches: Apply }).applyClodexPatches
  : undefined;

function tryApply(apply: Apply, src: string) {
  try {
    return apply(src, CONFIG);
  } catch (e) {
    return { error: String(e) };
  }
}

describe('PATCH 7 over real bundles', () => {
  it('found bundles to check', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(oldApply, 'OLD_TRANSFORMS must point at the pre-fix patch-transforms.ts').toBeDefined();
  });

  const summary = { identical: 0, rescued: 0, refusedAtPatch7: 0, skipped: [] as string[], otherwise: [] as string[] };

  it.each(files.map(f => [relative(BUNDLE_DIR, f), f] as const))('%s', (_label, file) => {
    const src = readFileSync(file, 'utf8');
    if (src.includes('/*ccpatch:')) { summary.skipped.push(_label); return; } // not pristine: never evidence
    const before = tryApply(oldApply!, src);
    const after = tryApply(applyClodexPatches, src);
    const wrappers = [...src.matchAll(WRAPPER)];

    if (!('error' in before)) {
      // DIFFERENTIAL: anything the old set could patch comes out byte-for-byte the same.
      expect('error' in after, 'new set refused a bundle the old set patched').toBe(false);
      expect(digest((after as { content: string }).content)).toBe(digest(before.content));
      expect(wrappers).toHaveLength(0);
      summary.identical++;
      return;
    }

    if (!/PATCH 7: per-model context window/.test(before.error)) {
      // Refused by the old set for a reason that is not PATCH 7: not this fix's business.
      summary.otherwise.push(`${_label}: ${before.error.slice(0, 120)}`);
      return;
    }

    summary.refusedAtPatch7++;
    // The bundle PATCH 7 used to refuse: exactly one wrapper, and the new set applies there.
    expect(wrappers).toHaveLength(1);
    expect('error' in after, `new set still refuses: ${'error' in after ? after.error : ''}`).toBe(false);
    const patched = after as { content: string; results: { status: string; name: string }[] };
    expect(patched.results).toContainEqual({ status: 'OK', name: 'PATCH 7: per-model context window' });
    expect(patched.content.match(/\/\*ccpatch:ctx\*\//g)).toHaveLength(1);

    const [whole, outer, model, betas, opts, bound, inner, clampFn, clampValue] = wrappers[0]!;
    const at = wrappers[0]!.index!;

    // Every call of the inner resolver in its module is the wrapper's. Names repeat across the
    // bundle's modules, so the count is taken inside the wrapper's own module only, split on the
    // separator the bundle reader joined them with.
    const lo = src.lastIndexOf(BUNDLE_MODULE_SEPARATOR, at);
    const next = src.indexOf(BUNDLE_MODULE_SEPARATOR, at);
    const region = src.slice(lo < 0 ? 0 : lo, next < 0 ? src.length : next);
    const innerRe = inner!.replace(/\$/g, '\\$');
    expect(region.match(new RegExp(`function ${innerRe}\\(`, 'g')), 'inner declared once in the module').toHaveLength(1);
    const tokens = region.match(new RegExp(`(?<![\\w$])${innerRe}(?![\\w$])`, 'g')) ?? [];
    expect(tokens, `references to ${inner} in its module`).toHaveLength(2);
    expect(region).toContain(`let ${bound}=${inner}(${model},${betas},${opts}.context1mBeta)`);
    const exportLists = [...region.matchAll(/export\{([^}]*)\}/g)].map(m => m[1]!);
    expect(exportLists.length, 'the module has an export list').toBeGreaterThan(0);
    for (const list of exportLists) {
      expect(list.split(',').map(e => e.trim().split(/\s+as\s+/)[0])).not.toContain(inner);
    }

    // EXECUTE the patched wrapper with stubbed callees.
    const patchedOuter = patched.content.slice(
      patched.content.indexOf(`function ${outer}(${model},${betas},${opts}=`),
    );
    const decl = patchedOuter.slice(0, patchedOuter.indexOf(`:${bound}}`) + `:${bound}}`.length);
    expect(decl).toContain('/*ccpatch:ctx*/');
    expect(decl.replace(/\/\*ccpatch:ctx\*\/.*?return _ccw;/, '')).toBe(whole);
    const defaults = /=\{context1mBeta:([\w$]+)\(/.exec(decl)![1]!;
    const credits = /longContextCredits:([\w$]+)\(\)/.exec(decl)![1]!;
    const innerCalls: unknown[][] = [];
    const make = new Function(defaults, credits, inner!, clampFn!, clampValue!, `${decl}; return ${outer};`) as (
      ...a: unknown[]
    ) => (m: unknown, b?: unknown, o?: unknown) => unknown;
    const run = make(
      () => false,
      () => true, // credits blocked: the clamp WANTS to fire
      (...a: unknown[]) => { innerCalls.push(a); return 400_000; },
      (w: number, blocked: boolean) => blocked && w > 200_000,
      200_000,
    );
    expect(run('sol', [])).toBe(272_000);
    expect(run('  LUNA ', [])).toBe(1_000_000);
    expect(run('clodex:openai-oauth:gpt-6-luna', [])).toBe(1_000_000);
    expect(innerCalls).toHaveLength(0);
    expect(run('claude-sonnet-4-6', [])).toBe(200_000); // clamp still applies to unbaked models
    expect(run('claude-sonnet-4-6', [], { context1mBeta: false, longContextCredits: false })).toBe(400_000);
    expect(innerCalls).toHaveLength(2);

    // THE SECOND CLAMP: the model-facts adapter, `function A(f){return <clamp>(<selector>(f))}`.
    // Bound to the wrapper's own clamp, exactly once, in the wrapper's module, and EXECUTED with the
    // real selector and the clamp armed.
    const adapters = [...patched.content.matchAll(
      /function ([\w$]+)\(([\w$]+)\)\{\/\*ccpatch:ctx-credits\*\/if\(\(\{[^{}]*\}\)\[String\(\2\.model\|\|""\)\.trim\(\)\.toLowerCase\(\)\]!==void 0\)return!1;return ([\w$]+)\(([\w$]+)\(\2\)\)\}/g,
    )];
    expect(adapters, 'one patched adapter').toHaveLength(1);
    const [adapterDecl, adapterName, , adapterClamp, selectorName] = adapters[0]!;
    expect(adapterClamp, 'the adapter calls the wrapper\'s clamp').toBe(clampFn);
    // The adapter lives in another module, which imports the clamp from the wrapper's under the
    // same name; the wrapper's module exports it.
    const pristineAdapter = adapterDecl!.replace(/\/\*ccpatch:ctx-credits\*\/.*?return!1;/, '');
    const adapterModules = src.split(BUNDLE_MODULE_SEPARATOR).filter(m => m.includes(pristineAdapter));
    expect(adapterModules, 'the pristine adapter is in exactly one module').toHaveLength(1);
    const adapterModule = adapterModules[0]!;
    const named = (list: string) => list.split(',').map(e => e.trim());
    const imports = [...adapterModule.matchAll(/import\{([^}]*)\}from"[^"]+"/g)].flatMap(m => named(m[1]!));
    expect(imports, 'the adapter\'s module imports the clamp unrenamed').toContain(clampFn);
    const exports = [...region.matchAll(/export\{([^}]*)\}/g)].flatMap(m => named(m[1]!));
    expect(exports, 'the wrapper\'s module exports the clamp').toContain(clampFn);
    const selectorDecl = new RegExp(
      `function ${selectorName!.replace(/\$/g, '\\$')}\\(([\\w$]+)\\)\\{return ([\\w$]+)\\(\\1\\.model\\)\\?\\1\\.modelContextWindowWithoutContext1m:\\1\\.modelContextWindow\\}`,
    ).exec(adapterModule);
    expect(selectorDecl, 'the selector it reads through, in the adapter\'s module').toBeTruthy();
    const runAdapter = new Function(
      selectorDecl![2]!, clampFn!,
      `${selectorDecl![0]}${adapterDecl}; return ${adapterName};`,
    )(() => false, (w: number) => w > 200_000) as (facts: unknown) => boolean;
    const facts = (m: string, w: number) => ({ model: m, modelContextWindow: w, modelContextWindowWithoutContext1m: w });
    expect(runAdapter(facts('sol', 272_000))).toBe(false);
    expect(runAdapter(facts('luna', 1_000_000))).toBe(false);
    expect(runAdapter(facts('claude-opus-4-7', 1_000_000))).toBe(true);
    expect(runAdapter(facts('claude-sonnet-4-6', 180_000))).toBe(false);

    const again = applyClodexPatches(patched.content, {
      ...CONFIG,
      'clodex:openai-oauth:gpt-5.6-sol': { ...CONFIG['clodex:openai-oauth:gpt-5.6-sol']!, context: 300_000 },
    });
    expect(again.results).toContainEqual({ status: 'OK', name: 'PATCH 7: per-model context window (refresh)' });
    expect(again.content.match(/\/\*ccpatch:ctx\*\//g)).toHaveLength(1);
    expect(again.content).toContain(`[String(${model}||"").trim().toLowerCase()]`);
    const tables = [...again.content.matchAll(/\/\*ccpatch:ctx(?:-credits)?\*\/(?:var _ccw=\(|if\(\()(\{[^{}]*\})\)/g)]
      .map(m => JSON.parse(m[1]!) as Record<string, number>);
    expect(tables, 'both copies of the table').toHaveLength(2);
    for (const t of tables) expect(t['sol']).toBe(300_000);
    summary.rescued++;
  });

  it('summary', () => {
    console.log(JSON.stringify(summary, null, 2));
    expect(summary.skipped).toEqual([]);
    expect(summary.otherwise).toEqual([]);
    expect(summary.rescued).toBeGreaterThan(0);
    expect(summary.rescued).toBe(summary.refusedAtPatch7);
    expect(summary.identical + summary.rescued).toBe(files.length);
  });
});
