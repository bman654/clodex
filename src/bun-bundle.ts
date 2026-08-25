// src/bun-bundle.ts — the Claude Code bundle as ONE string, however many Bun modules hold it.
//
// Through Claude Code 2.1.241 the bundle was a single Bun module: tweakcc read it, clodex patched
// the string, tweakcc wrote it back. 2.1.242 code-split it — the entry module became a ~20 KB ESM
// stub that imports ~1,370 `chunk-*.js` siblings — so `readContent` started returning a stub with
// none of clodex's anchors in it and `PATCH 1` failed on every platform and every executable
// format at once.
//
// This module restores the old contract without changing a single patch transform: every
// JavaScript module is read, joined into one document for `applyClodexPatches`, and split back
// afterwards. `applyClodexPatches` stays a pure string -> string function that neither knows nor
// cares how many modules the bundle arrived in.
//
// WRITING IT BACK IS THE HARD HALF. tweakcc's `writeContent` replaces the payload of every module
// whose NAME it recognizes, with one buffer — it has no way to say "this module gets these bytes
// and that one gets those". Calling it once per changed module is not an option either: every
// repack of an ELF build relocates the whole ~290 MB blob to the end of the binary, so six repacks
// would leave a multi-gigabyte claude and take minutes.
//
// So the write is one repack plus a pointer edit. Every changed module's patched source is
// concatenated into the single buffer tweakcc writes, and then each module's `{ offset, length }`
// pair in the blob's module table is repointed at its own slice of that buffer. The bytes are
// already in the blob by then, so nothing moves and nothing grows: `repointBunModuleContents`
// writes 8 bytes per module. When the ONLY changed module is the one tweakcc writes anyway — every
// release up to 2.1.241, and any later one whose patches all land in the entry — the plan degrades
// to exactly the call clodex has always made, with no pointer edit at all.

import {
  readBunJavaScriptModules,
  readBunModuleTable,
  repointBunModuleContents,
  tweakccRecognizesModuleName,
  type BunModuleRange,
  type BunModuleSnapshot,
} from './bun-entry-module.js';

/**
 * Position in the blob's module table of the module tweakcc will overwrite: the first one whose
 * name it recognizes. Null when it would find nothing, which is the case the entry-module shim
 * exists to prevent — so callers apply the shim first and treat null as "tweakcc cannot write
 * this binary".
 */
export function writableModuleIndex(path: string): number | null {
  const table = readBunModuleTable(path);
  if (!table) return null;
  const index = table.names.findIndex(tweakccRecognizesModuleName);
  return index < 0 ? null : index;
}

/**
 * What the modules are joined with: a line-delimited block comment, so the joined document stays
 * parseable JavaScript and reads as a boundary to anyone looking at it.
 *
 * The punctuation inside it is not decoration. Nearly every built-in anchor bounds its wildcards
 * with a character class — `` (?:[^`\]|\.)*? `` in PATCH 4, `[^{}]*` in PATCH 6, `[^;{}]` in
 * PATCH 5, `[^"]+` in the alias arrays, `[^\]]*` in PATCH 7 — and a separator those classes
 * accept is one they can match ACROSS, binding a patch to a span that belongs to two modules at
 * once. Carrying one of each makes that impossible by construction rather than by inspection.
 * They are inside a comment, so none of them mean anything to JavaScript.
 *
 * It is NOT a whole-file invariant, and do not write one down: PATCH 10's anchor and its proof
 * bound their wildcards with a negative lookahead (`(?:(?!\}\s*function )[\s\S])*?`) rather
 * than a class, so those two CAN run across this separator. PATCH 10 is safe for its own reason —
 * it separately validates that the end it matched is the starting function's real block end, which
 * rejects a cross-module bind — and local patches are trusted code that may use any regex at all.
 * The punctuation is what protects the class-bounded majority; it is not a proof about every site.
 *
 * `splitBundleSource` still counts the separators back out, because a patch that DELETED one would
 * be caught by nothing else.
 */
export const BUNDLE_MODULE_SEPARATOR = '\n/*clodex:module-boundary`;{}"]*/\n';

export interface ClaudeBundle {
  /** Every JavaScript module in the binary, in blob order. */
  modules: BunModuleSnapshot[];
  /** All of them as one document — what the patch transforms see. */
  source: string;
}

/**
 * Read the whole bundle out of a native Claude Code binary, or null when the Bun blob cannot be
 * parsed — in which case the caller falls back to tweakcc's own single-module read, which is what
 * clodex did before code splitting existed.
 */
export function readClaudeBundle(path: string): ClaudeBundle | null {
  const modules = readBunJavaScriptModules(path);
  if (!modules || modules.length === 0) return null;
  if (modules.some(module => module.source.includes(BUNDLE_MODULE_SEPARATOR))) return null;
  // Every module is decoded as UTF-8 here and re-encoded as UTF-8 on the way back, so a module
  // Bun stores in some other encoding would come back as replacement characters — and NOTHING
  // downstream could see it, because the read-back check and the probe both decode the same way
  // and would agree with each other. Every module of every real build measured (2.1.232 and
  // 2.1.243) is pure ASCII, so this refuses rather than defends: an encoding that does not
  // round-trip means fall back to tweakcc's single-module read, which on a split binary is a loud
  // `PATCH 1` failure instead of a silently mangled module.
  if (modules.some(module => !roundTripsAsUtf8(module.source, module.byteLength))) return null;
  return { modules, source: modules.map(module => module.source).join(BUNDLE_MODULE_SEPARATOR) };
}

// Only the U+FFFD half is independently pinned, and that is not an oversight: `byteLength` is the
// length of the very bytes `source` was decoded from, so the length comparison can only differ
// when the decode inserted a replacement character — which the second half already catches. It is
// kept as belt-and-braces against a future reader path that supplies the two from different
// places. Do not write a test claiming to pin it alone; no input can trip it alone.
function roundTripsAsUtf8(source: string, byteLength: number): boolean {
  return Buffer.byteLength(source, 'utf8') === byteLength && !source.includes('\uFFFD');
}

/**
 * Split a patched document back into one source per module.
 *
 * A patch that consumed or duplicated a boundary would silently redistribute code between modules,
 * so a piece count that does not match the bundle is a hard failure rather than a best effort.
 */
export function splitBundleSource(bundle: ClaudeBundle, patched: string): string[] {
  const parts = patched.split(BUNDLE_MODULE_SEPARATOR);
  if (parts.length !== bundle.modules.length) {
    throw new Error(
      `the patched bundle has ${parts.length} module boundaries, expected ${bundle.modules.length}`,
    );
  }
  return parts;
}

/** One module's new payload, and where it sits inside the buffer tweakcc is asked to write. */
interface BundleRepoint {
  /** Position in the blob's module table. */
  index: number;
  /** Byte offset of this module's slice within the written buffer. */
  start: number;
  /** Byte length of this module's slice. */
  length: number;
  /** What those bytes must read back as. */
  expected: string;
}

export interface BundleWritePlan {
  /** The buffer handed to tweakcc's `writeContent`. */
  content: string;
  /** Empty when the write needs no pointer edit — the pre-2.1.242 shape. */
  repoints: BundleRepoint[];
}

/**
 * Work out what to hand `writeContent`, given the patched source of every module.
 *
 * `writableIndex` addresses the module tweakcc will overwrite — `writableModuleIndex`, taken with
 * the shim in place. Its slice has to come FIRST, because that is the only slice whose position is
 * known before the repack: everything else is addressed relative to where tweakcc puts this one.
 * The module is identified by table position rather than by name because the shim renames it, so
 * the name it answers to depends on when you look.
 */
export function planBundleWrite(
  bundle: ClaudeBundle,
  patchedSources: string[],
  writableIndex: number,
): BundleWritePlan {
  if (patchedSources.length !== bundle.modules.length) {
    throw new Error(
      `expected ${bundle.modules.length} patched module sources, got ${patchedSources.length}`,
    );
  }
  const writable = bundle.modules.findIndex(module => module.index === writableIndex);
  if (writable < 0) {
    throw new Error(`module ${writableIndex} is not one of this binary's JavaScript modules`);
  }

  const changed = bundle.modules
    .map((module, at) => at)
    .filter(at => at !== writable && patchedSources[at] !== bundle.modules[at]!.source);
  // Nothing outside the module tweakcc writes changed, so write it the way clodex always has.
  if (changed.length === 0) return { content: patchedSources[writable]!, repoints: [] };

  const order = [writable, ...changed];
  const repoints: BundleRepoint[] = [];
  let content = '';
  let start = 0;
  for (const at of order) {
    const source = patchedSources[at]!;
    const length = Buffer.byteLength(source, 'utf8');
    repoints.push({ index: bundle.modules[at]!.index, start, length, expected: source });
    // Bun NUL-terminates every string in the blob, and tweakcc only appends one terminator — for
    // the buffer as a whole. Separating the slices with a NUL gives every one of them the same
    // trailing byte it would have had as a module of its own.
    content += source + '\0';
    start += length + 1;
  }
  return { content, repoints };
}

/**
 * Point every changed module at its slice of the buffer tweakcc just wrote, and prove it landed.
 *
 * Called on the repacked candidate, where the blob has been rebuilt and the written buffer sits at
 * an offset only the new module table knows.
 */
export function applyBundleWritePlan(path: string, plan: BundleWritePlan): void {
  const table = readBunModuleTable(path);
  // No table to check and no repoint to make: a binary clodex read through tweakcc's single-module
  // path is one it also wrote that way, exactly as it always did.
  if (!table) {
    if (plan.repoints.length === 0) return;
    throw new Error(`cannot read the Bun module table of ${path} after repacking`);
  }
  // tweakcc writes its buffer into EVERY module it recognizes, not just the first. The plan is
  // built around exactly one, and the entry-module shim declines to fire when a recognized name
  // already exists precisely so there is only ever one — so a second is a state nothing here
  // understands, not a case to muddle through.
  //
  // Checked BEFORE the early return below. A plan with nothing to repoint is the common case — it
  // is every release up to 2.1.241 — and it is not exempt: tweakcc would still have put the same
  // buffer into that second module, and there would be no repoint afterwards to notice.
  const recognized = table.names.filter(tweakccRecognizesModuleName);
  if (recognized.length !== 1) {
    throw new Error(
      `${path} has ${recognized.length} modules tweakcc would write to; the patch was planned `
      + 'around exactly one',
    );
  }
  if (plan.repoints.length === 0) return;
  const writable = table.names.findIndex(tweakccRecognizesModuleName);
  if (writable !== plan.repoints[0]!.index) {
    throw new Error(
      `${path} exposes module ${writable} to tweakcc, but the patch was planned around module `
      + `${plan.repoints[0]!.index}`,
    );
  }
  const written = table.contents[writable]!;
  const expectedBytes = Buffer.byteLength(plan.content, 'utf8');
  // The repack is what put these bytes in the blob. If it wrote a different module, or a different
  // number of bytes, every offset below would be computed against the wrong base — so refuse
  // instead of repointing modules at whatever happens to be there.
  if (written.length !== expectedBytes) {
    throw new Error(
      `${path} holds ${written.length} bytes where the ${expectedBytes} bytes clodex wrote should `
      + 'be; refusing to repoint its modules',
    );
  }

  const edits = plan.repoints.map(repoint => ({
    index: repoint.index,
    range: { offset: written.offset + repoint.start, length: repoint.length } satisfies BunModuleRange,
  }));
  repointBunModuleContents(path, edits);

  // Read the result back through the same parser Bun's loader agrees with, rather than trusting
  // the arithmetic above. A module left pointing at its neighbour's bytes is a binary that starts
  // and then misbehaves, which is far worse than a patch that refuses.
  const after = readBunJavaScriptModules(path);
  if (!after) throw new Error(`cannot re-read the modules of ${path} after repointing them`);
  const byIndex = new Map(after.map(module => [module.index, module.source]));
  for (const repoint of plan.repoints) {
    if (byIndex.get(repoint.index) !== repoint.expected) {
      throw new Error(`module ${repoint.index} of ${path} did not read back as the patched source`);
    }
  }
}
