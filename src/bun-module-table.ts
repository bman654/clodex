// Read and validate the Bun module table embedded in a native Claude Code binary.
// Shared by the bundle reader, patch planner, and cross-platform probe.

import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** Terminates the Bun data blob in every container format Bun emits. */
const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');

/** `{ byteCount: u64, modulesPtr: u32/u32, entryPointId: u32, compileExecArgvPtr: u32/u32, flags: u32 }`. */
const BUN_OFFSETS_BYTES = 32;

/**
 * How far back from EOF the trailer is searched for. This is a cost bound, not a correctness one —
 * scanning further only costs time, because every candidate is validated — but it IS a floor: a
 * window smaller than the distance from the last trailer to EOF finds nothing and silently disables
 * the reader. Measured on the real binaries, that distance is 683–802 KB, almost all of it code
 * signature, so this leaves ~20x headroom.
 */
const TAIL_SCAN_BYTES = 16 * 1024 * 1024;

/** Bun's module struct grew from 36 to 52 bytes; both are still in the wild. */
const MODULE_STRUCT_BYTES_CURRENT = 52;
const MODULE_STRUCT_BYTES_LEGACY = 36;

/**
 * A module struct opens with `{ name, contents, sourcemap, bytecode }` as four
 * `{ u32 offset, u32 length }` pairs, so those four are at the same place in both struct sizes.
 * The 52-byte struct adds `{ moduleInfo, bytecodeOriginPath }` after them.
 */
const CONTENTS_FIELD_AT = 8;
const SOURCEMAP_FIELD_AT = 16;
const BYTECODE_FIELD_AT = 24;
const MODULE_INFO_FIELD_AT = 32;
const BYTECODE_ORIGIN_PATH_FIELD_AT = 40;

/**
 * The bits of the blob's `flags` word clodex reasons about. Bun 1.4.1 added everything above
 * `SOURCE_TEXT_CONTIGUOUS`; a blob that sets them carries structures after the module table that
 * no per-module struct points at. See `.claude/docs/claude-code-internals.md`.
 */
export const BUN_BLOB_FLAGS = {
  /** Every module's source text lies in one run no other region falls inside. */
  SOURCE_TEXT_CONTIGUOUS: 1 << 4,
  /** A `[u32; modules]` of each module's source hash follows the module table. */
  HAS_SOURCE_HASHES: 1 << 5,
  /** After the source hashes: `u32 count`, then `count` x `{ u32 id, offset, length }`. */
  HAS_BUILTIN_BYTECODE: 1 << 6,
  /** After the builtin-bytecode table: one `{ offset, length }` for the shared string table. */
  HAS_BYTECODE_STRING_TABLE: 1 << 7,
} as const;

/**
 * The struct ends with four `u8`s — `encoding, loader, moduleFormat, side` — so the loader is
 * three bytes from the end whichever struct size this blob uses.
 */
const LOADER_FROM_END = 3;

/** Bun's loader id for a module it will execute as JavaScript. */
export const BUN_JAVASCRIPT_LOADER = 1;

/** A module path far longer than this is a misparse, not a name. */
const MAX_MODULE_NAME_BYTES = 4096;

/**
 * tweakcc's own test for "this is the module holding Claude Code's JS", mirrored
 * exactly for tweakcc 4.3.3. The planner must select the same module that tweakcc
 * reads and overwrites during the repack.
 */
export function tweakccRecognizesModuleName(name: string): boolean {
  return name.endsWith('/claude')
    || name === 'claude'
    || name.endsWith('/claude.exe')
    || name === 'claude.exe'
    || name.endsWith('/src/entrypoints/cli.js')
    || name === 'src/entrypoints/cli.js'
    || name.endsWith('/cli')
    || name === 'cli';
}

export interface BunModuleNames {
  /** Every module name in the blob, in blob order. */
  names: string[];
  /** Index of the module Bun starts at. */
  entryPointId: number;
  /** Absolute file offset of each name's bytes, parallel to `names`. */
  offsets: number[];
  /** Where each module's payload lives, blob-relative, parallel to `names`. */
  contents: BunModuleRange[];
  /** Each module's source map, blob-relative, parallel to `names`. Empty on every build measured. */
  sourcemap: BunModuleRange[];
  /** Each module's cached JSC bytecode, blob-relative, parallel to `names`. Empty when it has none. */
  bytecode: BunModuleRange[];
  /** Each module's JSC module info, blob-relative, parallel to `names`. Empty on a 36-byte struct. */
  moduleInfo: BunModuleRange[];
  /**
   * The path each module's bytecode cache was generated under, blob-relative, parallel to `names`.
   * Non-empty on almost every module of a real build, and empty on a 36-byte struct.
   */
  bytecodeOriginPath: BunModuleRange[];
  /** Bun's loader id for each module, parallel to `names`. `1` is JavaScript. */
  loaders: number[];
  /** Absolute file offset the blob starts at; `contents` offsets are relative to it. */
  blobAt: number;
  /** Absolute file offset of the module struct table. */
  modulesAt: number;
  /** Blob-relative offset of the module struct table — where Bun's tail structures start after it. */
  modulesOffset: number;
  /** Byte length of the module struct table. */
  modulesLength: number;
  /** Bytes per module struct (36 or 52). */
  structBytes: number;
  /** The blob's own recorded size, used to bounds-check a rewritten range. */
  byteCount: number;
  /** The `compile_exec_argv` string, blob-relative. */
  compileExecArgv: BunModuleRange;
  /**
   * The blob's `flags` word. Bun 1.4.1 uses its high bits to announce the tail structures written
   * after the module table (source hashes, builtin bytecode, the shared bytecode string table);
   * `BUN_BLOB_FLAGS` names the ones clodex reasons about.
   */
  flags: number;
}

/** A `{ offset, length }` pair out of a module struct, blob-relative. */
export interface BunModuleRange {
  offset: number;
  length: number;
}

function readAt(fd: number, length: number, position: number): Buffer | null {
  if (length <= 0 || position < 0) return null;
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return read === length ? buffer : null;
}

/**
 * Read every module name out of the Bun blob embedded in `path`, or null when the
 * blob cannot be located and validated. Every derived offset is bounds-checked
 * against the blob's own recorded size, so a misparse yields null rather than a
 * plausible-looking wrong answer.
 */
function readBunModuleNames(fd: number, fileSize: number): BunModuleNames | null {
  const tailLength = Math.min(fileSize, TAIL_SCAN_BYTES);
  const tail = readAt(fd, tailLength, fileSize - tailLength);
  if (!tail) return null;
  const tailAt = fileSize - tailLength;

  // A repack can leave the PREVIOUS blob's trailer behind at a HIGHER offset than the new one: the
  // replacement section content is written over the old content, and when it is shorter the old
  // tail survives inside the segment. (On a real 2.1.231 an identity repack shrinks the blob by 61
  // bytes, so this is reachable whenever the patched bundle grows by less than that.) Taking only
  // the last trailer would parse a stale offsets struct against the new blob, so try each candidate
  // from EOF backwards and keep the first that validates.
  for (let searchFrom = tail.length - 1; searchFrom >= 0;) {
    const trailerInTail = tail.lastIndexOf(BUN_TRAILER, searchFrom);
    if (trailerInTail < 0) return null;
    const parsed = parseBunModuleNamesAt(fd, tailAt + trailerInTail - BUN_OFFSETS_BYTES);
    if (parsed) return parsed;
    searchFrom = trailerInTail - 1;
  }
  return null;
}

/**
 * Parse the module list whose 32-byte offsets struct sits at `offsetsAt`, or null if anything about
 * it fails to validate. Never throws: a corrupt file must degrade to null, leaving tweakcc to
 * report its own extraction failure.
 */
function parseBunModuleNamesAt(fd: number, offsetsAt: number): BunModuleNames | null {
  try {
    return parseBunModuleNamesAtUnchecked(fd, offsetsAt);
  } catch {
    return null;
  }
}

function parseBunModuleNamesAtUnchecked(fd: number, offsetsAt: number): BunModuleNames | null {
  const offsets = readAt(fd, BUN_OFFSETS_BYTES, offsetsAt);
  if (!offsets) return null;
  const byteCount = offsets.readBigUInt64LE(0);
  const modulesOffset = offsets.readUInt32LE(8);
  const modulesLength = offsets.readUInt32LE(12);
  const entryPointId = offsets.readUInt32LE(16);
  const compileExecArgvOffset = offsets.readUInt32LE(20);
  const compileExecArgvLength = offsets.readUInt32LE(24);
  const flags = offsets.readUInt32LE(28);

  // `byteCount` is where the blob records its own offsets struct, which is how the
  // blob's start is recovered without knowing anything about the container.
  if (byteCount <= 0n || byteCount > BigInt(offsetsAt)) return null;
  const blobAt = offsetsAt - Number(byteCount);
  if (modulesLength <= 0 || BigInt(modulesOffset) + BigInt(modulesLength) > byteCount) return null;

  // Bun's own ambiguity rule: divisible by both (or neither) means the current format.
  const structBytes = modulesLength % MODULE_STRUCT_BYTES_LEGACY === 0
      && modulesLength % MODULE_STRUCT_BYTES_CURRENT !== 0
    ? MODULE_STRUCT_BYTES_LEGACY
    : MODULE_STRUCT_BYTES_CURRENT;
  const moduleCount = Math.floor(modulesLength / structBytes);
  if (moduleCount <= 0 || entryPointId >= moduleCount) return null;

  const modules = readAt(fd, moduleCount * structBytes, blobAt + modulesOffset);
  if (!modules) return null;

  const names: string[] = [];
  const nameOffsets: number[] = [];
  const contents: BunModuleRange[] = [];
  const sourcemap: BunModuleRange[] = [];
  const bytecode: BunModuleRange[] = [];
  const moduleInfo: BunModuleRange[] = [];
  const bytecodeOriginPath: BunModuleRange[] = [];
  const loaders: number[] = [];
  for (let index = 0; index < moduleCount; index++) {
    const nameOffset = modules.readUInt32LE(index * structBytes);
    const nameLength = modules.readUInt32LE(index * structBytes + 4);
    if (nameLength <= 0 || nameLength > MAX_MODULE_NAME_BYTES) return null;
    if (BigInt(nameOffset) + BigInt(nameLength) > byteCount) return null;
    // Bun NUL-terminates every string in the blob; its absence means this is not a
    // string table and the struct size or entry point was misread.
    const bytes = readAt(fd, nameLength + 1, blobAt + nameOffset);
    if (!bytes || bytes[nameLength] !== 0) return null;
    const name = bytes.subarray(0, nameLength).toString('utf8');
    if (!/^[\x20-\x7e]+$/.test(name)) return null;
    names.push(name);
    nameOffsets.push(blobAt + nameOffset);
    const pairAt = (field: number): BunModuleRange => ({
      offset: modules.readUInt32LE(index * structBytes + field),
      length: modules.readUInt32LE(index * structBytes + field + 4),
    });
    contents.push(pairAt(CONTENTS_FIELD_AT));
    sourcemap.push(pairAt(SOURCEMAP_FIELD_AT));
    bytecode.push(pairAt(BYTECODE_FIELD_AT));
    // The 36-byte struct stops after `bytecode`; reading further would run into the next module.
    const current = structBytes === MODULE_STRUCT_BYTES_CURRENT;
    moduleInfo.push(current ? pairAt(MODULE_INFO_FIELD_AT) : { offset: 0, length: 0 });
    bytecodeOriginPath.push(
      current ? pairAt(BYTECODE_ORIGIN_PATH_FIELD_AT) : { offset: 0, length: 0 },
    );
    loaders.push(modules.readUInt8(index * structBytes + structBytes - LOADER_FROM_END));
  }
  return {
    names,
    entryPointId,
    offsets: nameOffsets,
    contents,
    sourcemap,
    bytecode,
    moduleInfo,
    bytecodeOriginPath,
    loaders,
    blobAt,
    modulesAt: blobAt + modulesOffset,
    modulesOffset,
    modulesLength,
    structBytes,
    byteCount: Number(byteCount),
    compileExecArgv: { offset: compileExecArgvOffset, length: compileExecArgvLength },
    flags,
  };
}

/**
 * Every module name in the blob, in blob order, or null when the blob cannot be
 * read. Opens read-only, so it is safe on a pristine backup.
 *
 * Used by the cross-platform probe to compare the complete module inventory before and
 * after a repack, including native siblings and their order.
 */
export function listBunModuleNames(path: string): string[] | null {
  const fd = openSync(path, 'r');
  try {
    return readBunModuleNames(fd, statSync(path).size)?.names ?? null;
  } finally {
    closeSync(fd);
  }
}

/** Everything about the blob's module table a caller needs to read or repoint a payload. */
export type BunModuleTable = BunModuleNames;

/**
 * The blob's module table, or null when the blob cannot be located and validated. Opens read-only,
 * so it is safe on a pristine backup.
 */
export function readBunModuleTable(path: string): BunModuleTable | null {
  const fd = openSync(path, 'r');
  try {
    return readBunModuleNames(fd, statSync(path).size);
  } finally {
    closeSync(fd);
  }
}

/** One module's name, position and payload, read out of the blob. */
export interface BunModuleSnapshot {
  /** Position in the blob's module table — the key a repoint is addressed by. */
  index: number;
  name: string;
  source: string;
  /** How many bytes the payload occupies in the blob, before any decoding. */
  byteLength: number;
}

/**
 * Every module Bun will execute as JavaScript, in blob order, or null when the blob cannot be read.
 *
 * Claude Code 2.1.242 split its bundle: what used to be one ~28 MB module is now a ~20 KB entry
 * that imports ~1,370 `chunk-*.js` siblings, and tweakcc's `readContent` returns only the module it
 * recognizes by name — the entry — which no longer holds any of the code clodex patches. Reading
 * every JavaScript module is what puts the whole bundle back in front of the transforms.
 *
 * Assets (`mermaid.min.js`, `*.node`, the HTML payload) carry a different loader id and are left
 * out: they are never executed as part of the bundle, and feeding megabytes of vendored JavaScript
 * to anchors that must match exactly once is a way to invent ambiguity.
 */
export function readBunJavaScriptModules(path: string): BunModuleSnapshot[] | null {
  const fd = openSync(path, 'r');
  try {
    const parsed = readBunModuleNames(fd, statSync(path).size);
    if (!parsed) return null;
    const modules: BunModuleSnapshot[] = [];
    for (let index = 0; index < parsed.names.length; index++) {
      if (parsed.loaders[index] !== BUN_JAVASCRIPT_LOADER) continue;
      const range = parsed.contents[index]!;
      // Bounds-checked against the blob's own recorded size, like every other derived offset here:
      // a misparsed length is a `Buffer.alloc` of up to 4 GB, and a misparse has to degrade to "no
      // bundle" rather than to a throw from inside a read.
      if (range.offset < 0 || range.length < 0 || range.offset + range.length > parsed.byteCount) {
        return null;
      }
      const bytes = range.length === 0
        ? Buffer.alloc(0)
        : readAt(fd, range.length, parsed.blobAt + range.offset);
      if (!bytes) return null;
      modules.push({
        index,
        name: parsed.names[index]!,
        source: bytes.toString('utf8'),
        byteLength: bytes.length,
      });
    }
    return modules;
  } finally {
    closeSync(fd);
  }
}
