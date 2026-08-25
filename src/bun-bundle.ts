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
// WRITING IT BACK IS THE HARD HALF, and the reason has changed twice.
//
// tweakcc's `writeContent` replaces the payload of every module whose NAME it recognizes, with one
// buffer — it has no way to say "this module gets these bytes and that one gets those". Calling it
// once per changed module is not an option either: every repack of an ELF build relocates the whole
// ~290 MB blob to the end of the binary, so six repacks would leave a multi-gigabyte claude and take
// minutes. That is why there is one repack here however many modules the patch touched.
//
// The deeper problem is that tweakcc REBUILDS the blob, from the per-module `{ offset, length }`
// pairs and the exec-argv string — carrying `entryPointId`, `flags` and each module's
// loader/encoding/format/side across as scalars, but reconstructing the payload region from those
// ranges alone. So a region no range describes is silently dropped, and every offset that survives
// moves. Through Bun 1.4.0 (Claude Code 2.1.245) that was close enough to
// lossless to work. Bun 1.4.1 (Claude Code 2.1.246) is not: after the module table it writes a
// `[u32; modules]` of source hashes, an ahead-of-time bytecode table, and a ~9.9 MB shared bytecode
// string table that every chunk's compiled form references by ordinal — announced by the blob's
// `flags` word and reachable from no module range. (The string table itself is written among the
// payloads, BEFORE the module table; it is the 8-byte pointer to it that follows the table.) A
// rebuild kept the flags, dropped all of it, and the patched binary segfaulted inside Bun before
// printing its version. It also packs every
// module's cached bytecode wherever it lands, and JSC requires that 128-byte aligned because it
// decodes it in place.
//
// So the blob is not rebuilt. The pristine bytes are published verbatim, each patched module's
// source is APPENDED past the end of them, and the module table is repointed in place — everything
// clodex does not understand survives because nothing moved it. tweakcc's repack is still what
// resizes the container's Bun section (the only part that needs node-lief, and the part that knows
// Mach-O from ELF from PE), but the buffer handed to it is a placeholder, and every byte of the
// blob it produces is overwritten afterwards. The section's own 8-byte length header is the one
// exception: it is left exactly as the repack wrote it, and the published blob is padded to match
// the length it declares.

import { closeSync, openSync, readSync, writeSync } from 'node:fs';

import {
  BUN_BLOB_FLAGS,
  readBunJavaScriptModules,
  readBunModuleTable,
  tweakccRecognizesModuleName,
  type BunModuleRange,
  type BunModuleSnapshot,
  type BunModuleTable,
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

/** One module's patched source and the blob-relative range it is published at. */
interface BundleAppend {
  /** Position in the blob's module table. */
  index: number;
  /** Where the patched source lands, blob-relative. */
  range: BunModuleRange;
  /** What those bytes must read back as. */
  expected: string;
}

export interface BundleWritePlan {
  /**
   * Placeholder bytes handed to `writeContent`. Nothing reads them: tweakcc's repack exists here
   * only to resize the container's Bun section, and every byte of the blob it produces is
   * overwritten by `applyBundleWritePlan` afterwards.
   */
  content: string;
  /** The published blob's data region: the pristine bytes, repointed, with the patched sources appended. */
  data: Buffer;
  /** The blob's 32-byte offsets struct as it must be published, apart from `byte_count`. */
  offsets: Buffer;
  /** Table position of the module tweakcc writes its placeholder into. */
  writableIndex: number;
  /** Every module name, in table order — what the repacked binary must still expose. */
  names: string[];
  /** The module Bun starts at, which the published blob must still name. */
  entryPointId: number;
  /** The `flags` word the published blob carries. */
  flags: number;
  /** Where the blob started before the repack — the repack has to put it back at the same residue. */
  blobAt: number;
  /** Every module that moved, and what it must read back as. */
  appends: BundleAppend[];
}

/** `\n---- Bun! ----\n`, which terminates the blob in every container format Bun emits. */
const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');

/** The offsets struct sits between the blob's data and the trailer. */
const BUN_OFFSETS_BYTES = 32;

/**
 * Slack added to the placeholder so a tweakcc whose repack lays the blob out slightly differently
 * than `repackedBlobBytes` predicts still leaves room. It cannot paper over a real change — a
 * section that is still too small refuses below rather than publishing a truncated blob — it only
 * keeps drift too small to be worth a release from costing one.
 */
export const PLACEHOLDER_SLACK_BYTES = 64 * 1024;

/**
 * What Bun aligns cached bytecode to, because JSC decodes it in place. Bun writes each range at
 * `120 mod 128` from the start of the blob, which lands on a multiple of 128 once the section's
 * base and the blob's 8-byte length header are added. The check below compares FILE offsets while
 * the requirement is on the mapped address, and that is sound on all three formats: ELF and Mach-O
 * require `vaddr ≡ fileoff (mod pagesize)`, and PE's `FileAlignment` is at least 512 — every one of
 * those is a multiple of 128. (A PE section's file offset is only 512-aligned, not page-aligned;
 * 512 is what carries the argument there.)
 */
const BYTECODE_ALIGNMENT = 128;

/**
 * Appended sources are 8-byte aligned. Bun asks nothing of source text beyond 2, for the UTF-16
 * aliasing in `File::to_wtf_string` — real blobs do not align source payloads at all — so this is
 * defensive headroom, not a requirement being met. It is NOT enough for a Bun payload that IS
 * alignment-sensitive: cached bytecode wants 128, which is why a patched module's bytecode is
 * cleared rather than moved.
 */
const APPEND_ALIGNMENT = 8;

/**
 * What tweakcc's repack will make the blob, in bytes, if handed `contentBytes` for the module it
 * recognizes. It rebuilds the blob from the module structs: every `{ offset, length }` field of
 * every module, NUL-separated, then the module table, the exec-argv string, the offsets struct and
 * the trailer. It carries `entryPointId`, `flags` and each module's loader/encoding/format/side
 * across too, but those are fixed-size and do not affect the total.
 *
 * This is an arithmetic mirror of code clodex does not own, so it is a SIZING hint and nothing
 * more — `applyBundleWritePlan` measures what the repack actually produced and refuses if it is
 * too small. Note which direction is dangerous: UNDER-counting makes the placeholder bigger and
 * leaves more room, so it only wastes section; only OVER-counting can leave a section too small to
 * publish into, which is what the refusal in `planBundleWrite` names. Every field is read from the
 * struct anyway, so that the repacked blob is the planned one plus exactly the slack and the probe
 * can assert it: hardcoding `bytecodeOriginPath` as empty wasted 33,652 bytes of section on a real
 * 2.1.246 darwin-arm64 and 41,412 on 2.1.245, growing with the module count.
 */
function repackedBlobBytes(table: BunModuleTable, writableIndex: number, contentBytes: number): number {
  let total = 0;
  for (let index = 0; index < table.names.length; index++) {
    const fields = [
      Buffer.byteLength(table.names[index]!, 'utf8'),
      index === writableIndex ? contentBytes : table.contents[index]!.length,
      table.sourcemap[index]!.length,
      table.bytecode[index]!.length,
    ];
    // A 36-byte struct stops after `bytecode`, and tweakcc copies four fields rather than six.
    if (table.structBytes === 52) {
      fields.push(table.moduleInfo[index]!.length, table.bytecodeOriginPath[index]!.length);
    }
    // tweakcc NUL-terminates every field it copies, including the empty ones.
    for (const length of fields) total += length + 1;
  }
  return total + table.modulesLength + table.compileExecArgv.length + 1
    + BUN_OFFSETS_BYTES + BUN_TRAILER.length;
}

/**
 * Work out the blob to publish, given the patched source of every module.
 *
 * The blob is NOT rebuilt. Bun's own layout carries far more than the module structs describe —
 * since Bun 1.4.1 (Claude Code 2.1.246) a `[u32; modules]` of source hashes, an ahead-of-time
 * bytecode table, and a ~9.9 MB shared bytecode string table follow the module table, and every
 * module's cached bytecode has to stay 128-byte aligned — and none of it is reachable from the
 * per-module `{ offset, length }` pairs tweakcc rebuilds from. So the pristine bytes are kept
 * verbatim, each patched module's source is APPENDED past the end of them, and the module table is
 * repointed in place. Everything clodex does not understand survives because it was never moved.
 *
 * Two consequences of changing a module's source are handled here rather than left to Bun:
 *
 * - Its cached bytecode and module info are cleared. They were compiled from the source that is
 *   being replaced, and on 2.1.246 the stale bytecode WINS: rewriting all 1,659 occurrences of the
 *   version string in a pristine binary's JavaScript, same length, bytecode untouched, still
 *   printed the old version — and the same edit with the bytecode cleared printed the new one. An
 *   empty bytecode range leaves Bun no choice but to compile the source that is there.
 * - `SOURCE_TEXT_CONTIGUOUS` is cleared, because the appended sources make it false. It is only a
 *   `madvise` hint, and a blob that does not claim it simply does not get the hint.
 */
export function planBundleWrite(
  path: string,
  bundle: ClaudeBundle,
  patchedSources: string[],
  writableIndex: number,
): BundleWritePlan {
  if (patchedSources.length !== bundle.modules.length) {
    throw new Error(
      `expected ${bundle.modules.length} patched module sources, got ${patchedSources.length}`,
    );
  }
  const table = readBunModuleTable(path);
  if (!table) throw new Error(`cannot read the Bun module table of ${path}`);
  // tweakcc writes its buffer into EVERY module it recognizes, and the size arithmetic above is
  // built around exactly one. The entry-module shim declines to fire when a recognized name
  // already exists precisely so there is only ever one, so a second is a state nothing here
  // understands rather than a case to muddle through.
  const recognized = table.names.filter(tweakccRecognizesModuleName);
  if (recognized.length !== 1) {
    throw new Error(
      `${path} has ${recognized.length} modules tweakcc would write to; the patch was planned `
      + 'around exactly one',
    );
  }
  if (!table.names[writableIndex] || !tweakccRecognizesModuleName(table.names[writableIndex]!)) {
    throw new Error(`module ${writableIndex} of ${path} is not the one tweakcc writes to`);
  }

  // Lay the appends out before allocating, so the blob is built in ONE buffer. A `Buffer.concat`
  // of the pristine bytes doubles a ~164 MB (and on a pre-split release ~290 MB) allocation for
  // the length of the copy, on top of what tweakcc's own repack holds.
  const appends: BundleAppend[] = [];
  const sources: Buffer[] = [];
  let cursor = table.byteCount;
  for (let at = 0; at < bundle.modules.length; at++) {
    const module = bundle.modules[at]!;
    const source = patchedSources[at]!;
    if (source === module.source) continue;
    // Blob-relative is the right base: the pristine bytes this follows are published at the offset
    // they were read from, so a blob-relative offset is the offset Bun resolves.
    cursor += (APPEND_ALIGNMENT - (cursor % APPEND_ALIGNMENT)) % APPEND_ALIGNMENT;
    const bytes = Buffer.from(source, 'utf8');
    appends.push({ index: module.index, range: { offset: cursor, length: bytes.length }, expected: source });
    sources.push(bytes);
    // Bun NUL-terminates every string in the blob; give an appended one the same trailing byte it
    // would have had as a payload Bun itself wrote. The gap left by the alignment above is zero
    // too, because the buffer is allocated zeroed.
    cursor += bytes.length + 1;
  }
  // Hardening: every offset in the blob is a u32, and no real bundle is within three orders of
  // magnitude of this. Nothing reaches it from a supported configuration.
  if (cursor > 0xffff_ffff) {
    throw new Error(`the patched blob of ${path} would be ${cursor} bytes, past the 4 GiB a Bun offset can address`);
  }
  const data = Buffer.alloc(cursor);
  readBlobData(path, table, data);
  appends.forEach((append, at) => sources[at]!.copy(data, append.range.offset));
  for (const append of appends) repointModule(data, table, append);

  const offsets = Buffer.alloc(BUN_OFFSETS_BYTES);
  // `byte_count` is filled in at publish time: it depends on how much padding the repacked section
  // leaves, which is only known once the repack has happened.
  offsets.writeUInt32LE(table.modulesOffset, 8);
  offsets.writeUInt32LE(table.modulesLength, 12);
  offsets.writeUInt32LE(table.entryPointId, 16);
  offsets.writeUInt32LE(table.compileExecArgv.offset, 20);
  offsets.writeUInt32LE(table.compileExecArgv.length, 24);
  offsets.writeUInt32LE(table.flags & ~BUN_BLOB_FLAGS.SOURCE_TEXT_CONTIGUOUS, 28);

  const wanted = data.length + BUN_OFFSETS_BYTES + BUN_TRAILER.length + PLACEHOLDER_SLACK_BYTES;
  const empty = repackedBlobBytes(table, writableIndex, 0);
  // For any blob whose payload ranges are disjoint and inside `byte_count`, `wanted` exceeds
  // `empty` by at least the slack, so reaching this means the mirror counted some bytes twice —
  // i.e. clodex read overlapping ranges out of the module table. Clamping the placeholder to zero
  // instead does NOT get caught downstream: the section would come back LARGER than the planned
  // blob, the too-small refusal would not fire, and clodex would publish into a section sized off
  // arithmetic it already knows is wrong. Refuse here, where that arithmetic is in scope.
  if (wanted < empty) {
    throw new Error(
      `repacking ${path} is predicted to make a blob of at least ${empty} bytes, more than the `
      + `${wanted} the placeholder is sized against; clodex is reading overlapping payload ranges `
      + 'out of this binary\'s module table',
    );
  }
  return {
    content: placeholderOf(wanted - empty),
    data,
    offsets,
    writableIndex,
    names: table.names,
    entryPointId: table.entryPointId,
    flags: table.flags & ~BUN_BLOB_FLAGS.SOURCE_TEXT_CONTIGUOUS,
    blobAt: table.blobAt,
    appends,
  };
}

/**
 * What the placeholder is made of, so a binary that somehow shipped one says so in its own bytes.
 * Nothing reads it — `applyBundleWritePlan` overwrites every byte of the section it lands in.
 */
const PLACEHOLDER_TEXT = '/*clodex:placeholder*/\n';

function placeholderOf(byteLength: number): string {
  return PLACEHOLDER_TEXT.repeat(Math.ceil(byteLength / PLACEHOLDER_TEXT.length)).slice(0, byteLength);
}

/** Read the blob's data region — everything `byte_count` covers — into the head of `into`. */
function readBlobData(path: string, table: BunModuleTable, into: Buffer): void {
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < table.byteCount) {
      const got = readSync(fd, into, read, table.byteCount - read, table.blobAt + read);
      if (got <= 0) {
        throw new Error(`read ${read} of the ${table.byteCount} blob bytes of ${path}`);
      }
      read += got;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Point one module at its appended source, and drop what was compiled from the source it replaces:
 * the cached bytecode, its module info, the path it was compiled under, and the source hash Bun
 * would otherwise use as that bytecode's cache key.
 */
function repointModule(data: Buffer, table: BunModuleTable, append: BundleAppend): void {
  const structAt = table.modulesOffset + append.index * table.structBytes;
  data.writeUInt32LE(append.range.offset, structAt + 8);
  data.writeUInt32LE(append.range.length, structAt + 12);
  data.writeUInt32LE(0, structAt + 24); // bytecode offset
  data.writeUInt32LE(0, structAt + 28); // bytecode length
  if (table.structBytes === 52) {
    data.writeUInt32LE(0, structAt + 32); // moduleInfo offset
    data.writeUInt32LE(0, structAt + 36); // moduleInfo length
    data.writeUInt32LE(0, structAt + 40); // bytecodeOriginPath offset
    data.writeUInt32LE(0, structAt + 44); // bytecodeOriginPath length
  }
  if ((table.flags & BUN_BLOB_FLAGS.HAS_SOURCE_HASHES) === 0) return;
  const hashAt = table.modulesOffset + table.modulesLength + append.index * 4;
  if (hashAt + 4 > table.byteCount) {
    throw new Error(
      'the blob claims a source hash per module but the table is followed by only '
      + `${table.byteCount - table.modulesOffset - table.modulesLength} bytes`,
    );
  }
  data.writeUInt32LE(0, hashAt);
}

/**
 * Publish the planned blob over the section tweakcc's repack just resized, and prove it landed.
 *
 * Called on the repacked candidate, where the blob tweakcc rebuilt sits at an offset only the file
 * itself knows. Its contents are discarded wholesale: what gets written is the plan's pristine
 * bytes, padded out so the trailer still ends exactly where Bun expects it — Bun takes the blob's
 * length from the section's own header, and that header is the one tweakcc wrote.
 */
export function applyBundleWritePlan(path: string, plan: BundleWritePlan): void {
  const repacked = readBunModuleTable(path);
  if (!repacked) throw new Error(`cannot read the Bun module table of ${path} after repacking`);
  // Prove this IS the blob the repack just wrote before overwriting anything with offsets computed
  // against it. A repack that does not grow the blob leaves the previous one's trailer behind at a
  // HIGHER offset, and the scan that finds a blob works backwards from the end of the file.
  const placeholderBytes = Buffer.byteLength(plan.content, 'utf8');
  const written = repacked.contents[plan.writableIndex];
  if (!written || written.length !== placeholderBytes) {
    throw new Error(
      `${path} holds ${written ? written.length : 'no'} bytes where the ${placeholderBytes} bytes `
      + 'clodex wrote should be; refusing to publish a blob addressed against it',
    );
  }
  if (repacked.names.length !== plan.names.length
    || repacked.names.some((name, index) => name !== plan.names[index])) {
    throw new Error(
      `${path} exposes a different module table after repacking than the patch was planned around`,
    );
  }
  // Keeping every unpatched module's cached bytecode where it was is only worth anything while it
  // stays 128-byte aligned once mapped — JSC decodes it in place. Bun writes each bytecode range
  // at `120 mod 128` from the start of the blob, and the blob itself begins 8 bytes into a section
  // whose base is page-aligned, so the alignment holds exactly while the blob's start keeps its
  // residue. tweakcc's Mach-O and PE repacks assign the section in place and its ELF one relocates
  // to a page-aligned address, so all three preserve it today (measured on real 2.1.245 and
  // 2.1.246 builds) — but nothing else here could see a repack that did not, and the result would
  // be a claude that starts and then dies inside JSC.
  if (repacked.blobAt % BYTECODE_ALIGNMENT !== plan.blobAt % BYTECODE_ALIGNMENT) {
    throw new Error(
      `repacking ${path} moved its Bun blob from ${plan.blobAt} to ${repacked.blobAt}, which is a `
      + `different offset modulo ${BYTECODE_ALIGNMENT}; every unpatched module's cached bytecode `
      + 'would be misaligned',
    );
  }

  // The repacked section is exactly as long as the header tweakcc wrote says it is, and the
  // published blob keeps that length: everything past the planned blob is padding — unreferenced
  // bytes between the last appended source and the offsets struct — so the trailer still ends
  // where the section does, on every container format.
  const byteCount = repacked.byteCount;
  if (byteCount < plan.data.length) {
    throw new Error(
      `repacking ${path} left ${byteCount} bytes for a blob that needs ${plan.data.length}; `
      + 'refusing to publish a truncated one',
    );
  }
  const offsets = Buffer.from(plan.offsets);
  offsets.writeBigUInt64LE(BigInt(byteCount), 0);

  const fd = openSync(path, 'r+');
  try {
    writeAll(fd, plan.data, repacked.blobAt, path);
    const padding = byteCount - plan.data.length;
    if (padding > 0) writeAll(fd, Buffer.alloc(padding), repacked.blobAt + plan.data.length, path);
    writeAll(fd, offsets, repacked.blobAt + byteCount, path);
    // Idempotent today — the published blob is the same length as the repacked one, so this writes
    // the trailer over an identical trailer. It is kept so the published blob is written here in
    // full rather than partly inherited from whatever the repack happened to leave, which is what
    // every offset above is computed against.
    writeAll(fd, BUN_TRAILER, repacked.blobAt + byteCount + BUN_OFFSETS_BYTES, path);
  } finally {
    closeSync(fd);
  }

  // Read the result back through the same parser Bun's loader agrees with, rather than trusting
  // the arithmetic above. A module left pointing at its neighbour's bytes is a binary that starts
  // and then misbehaves, which is far worse than a patch that refuses.
  const published = readBunModuleTable(path);
  if (!published) throw new Error(`cannot re-read the Bun module table of ${path} after publishing its blob`);
  if (published.byteCount !== byteCount
    || published.entryPointId !== plan.entryPointId
    || published.flags !== plan.flags
    || published.names.length !== plan.names.length
    || published.names.some((name, index) => name !== plan.names[index])) {
    throw new Error(`the blob published into ${path} does not read back as the one that was planned`);
  }
  const after = readBunJavaScriptModules(path);
  if (!after) throw new Error(`cannot re-read the modules of ${path} after publishing its blob`);
  const expected = new Map(plan.appends.map(append => [append.index, append.expected]));
  let matched = 0;
  for (const module of after) {
    const want = expected.get(module.index);
    if (want === undefined) continue;
    if (module.source !== want) {
      throw new Error(`module ${module.index} of ${path} did not read back as the patched source`);
    }
    matched++;
  }
  if (matched !== expected.size) {
    throw new Error(
      `${matched} of the ${expected.size} patched modules of ${path} came back as JavaScript Bun `
      + 'will execute',
    );
  }
}

function writeAll(fd: number, bytes: Buffer, position: number, path: string): void {
  let written = 0;
  while (written < bytes.length) {
    const wrote = writeSync(fd, bytes, written, bytes.length - written, position + written);
    if (wrote <= 0) throw new Error(`wrote ${written} of ${bytes.length} blob bytes to ${path}`);
    written += wrote;
  }
}
