// Makes a Claude Code native binary's entry module discoverable by tweakcc.
//
// tweakcc finds the module holding Claude Code's JavaScript by NAME — it accepts
// `/claude`, `claude`, `/claude.exe`, `claude.exe`, `/src/entrypoints/cli.js` and
// `src/entrypoints/cli.js`. Claude Code 2.1.231 renamed its entry module from
// `/$bunfs/root/src/entrypoints/cli.js` to `/$bunfs/root/cli`, which matches none
// of them, so `readContent` throws and `clodex patch` fails with
// "Failed to extract JavaScript from native installation".
//
// The name is used for identification only — nothing at runtime resolves modules
// through it except Bun's own `$bunfs` paths — so this module swaps it for a
// stand-in of IDENTICAL byte length that tweakcc does recognize, and puts the real
// name back before the patched candidate is published. Equal length is what keeps
// the edit safe: no offset, length, or size field in the Bun blob changes, so the
// swap is a pure byte overwrite that any later parse (including tweakcc's own
// repack) sees as an ordinary module name.
//
// The name still has to be right in the published binary: the OTHER modules live at
// `/$bunfs/root/*` and are resolved relative to the entry module's directory, so
// shipping a renamed entry would break the native image, audio, and URL helpers.
//
// Locating the name deliberately does NOT parse Mach-O/ELF/PE: the Bun blob ends with a fixed
// trailer and its own header records where the blob starts, so scanning back from EOF finds it
// with no dependency on node-lief. Verified on Mach-O; ELF and PE are inferred from tweakcc's
// own reader and untested — in both, a parse that does not validate returns null and leaves
// tweakcc to report its usual failure, so the cost of being wrong there is a refusal to patch.
//
// See .claude/docs/patcher.md and .claude/docs/claude-code-internals.md.

import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Terminates the Bun data blob in every container format Bun emits. */
const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');

/** `{ byteCount: u64, modulesPtr: u32/u32, entryPointId: u32, compileExecArgvPtr: u32/u32, flags: u32 }`. */
const BUN_OFFSETS_BYTES = 32;

/**
 * How far back from EOF the trailer is searched for. This is a cost bound, not a correctness one —
 * scanning further only costs time, because every candidate is validated — but it IS a floor: a
 * window smaller than the distance from the last trailer to EOF finds nothing and silently disables
 * the shim. Measured on the real binaries, that distance is 683–802 KB, almost all of it code
 * signature, so this leaves ~20x headroom.
 */
const TAIL_SCAN_BYTES = 16 * 1024 * 1024;

/** Bun's module struct grew from 36 to 52 bytes; both are still in the wild. */
const MODULE_STRUCT_BYTES_CURRENT = 52;
const MODULE_STRUCT_BYTES_LEGACY = 36;

/** A module path far longer than this is a misparse, not a name. */
const MAX_MODULE_NAME_BYTES = 4096;

/** The shortest name that can be swapped in: `/claude`. */
const MIN_SHIMMABLE_NAME_BYTES = 7;

export interface EntryModuleShim {
  /** Absolute file offset of the entry module's name bytes. */
  offset: number;
  /** The name Claude Code actually ships, restored before the binary is published. */
  original: string;
  /** The identical-length stand-in tweakcc recognizes. */
  marker: string;
}

/**
 * tweakcc's own test for "this is the module holding Claude Code's JS", mirrored
 * exactly. A name this accepts needs no shim; a binary where NO module name is
 * accepted is one tweakcc cannot read or repack.
 */
export function tweakccRecognizesModuleName(name: string): boolean {
  return name.endsWith('/claude')
    || name === 'claude'
    || name.endsWith('/claude.exe')
    || name === 'claude.exe'
    || name.endsWith('/src/entrypoints/cli.js')
    || name === 'src/entrypoints/cli.js';
}

/**
 * A recognizable stand-in of exactly `byteLength` bytes, or null when no such name
 * exists (any name shorter than `/claude`). The `clodex` infix makes a stand-in
 * that somehow escaped restoration identifiable on sight.
 */
export function entryModuleShimName(byteLength: number): string | null {
  if (byteLength < MIN_SHIMMABLE_NAME_BYTES) return null;
  const padding = byteLength - MIN_SHIMMABLE_NAME_BYTES;
  return '/clodex'.padEnd(padding, '-').slice(0, padding) + '/claude';
}

interface BunModuleNames {
  /** Every module name in the blob, in blob order. */
  names: string[];
  /** Index of the module Bun starts at. */
  entryPointId: number;
  /** Absolute file offset of each name's bytes, parallel to `names`. */
  offsets: number[];
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
 * it fails to validate. Never throws: a corrupt file must degrade to "no shim", leaving tweakcc to
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
  }
  return { names, entryPointId, offsets: nameOffsets };
}

/**
 * Prove the stand-in is gone from the ENTIRE file, not merely from wherever the parse just looked.
 * Locating the blob is a search, and a repack can leave a stale trailer behind, so "I wrote the
 * real name back where I found the marker" is a weaker statement than it appears — it would also
 * be true of a write into a dead copy of the blob while the live one stayed shimmed. Publishing
 * that binary is the one outcome this module exists to prevent, and it costs one sequential read
 * to rule out.
 */
function assertShimGone(fd: number, fileSize: number, marker: string): void {
  const needle = Buffer.from(marker);
  const chunkBytes = 8 * 1024 * 1024;
  let carry = Buffer.alloc(0);
  for (let position = 0; position < fileSize;) {
    const length = Math.min(chunkBytes, fileSize - position);
    const chunk = readAt(fd, length, position);
    if (!chunk) throw new Error('could not re-read the candidate to verify the entry-module name');
    const window = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    if (window.includes(needle)) {
      throw new Error(`the entry-module stand-in ${marker} survived restoration`);
    }
    // Keep the last needle-1 bytes so a marker straddling two chunks is still seen.
    carry = Buffer.from(window.subarray(Math.max(0, window.length - (needle.length - 1))));
    position += length;
  }
}

/** Overwrite a module name in place, refusing to continue on a short write. */
function writeNameBytes(fd: number, name: string, offset: number): void {
  const bytes = Buffer.from(name);
  const written = writeSync(fd, bytes, 0, bytes.length, offset);
  if (written !== bytes.length) {
    throw new Error(`wrote ${written} of ${bytes.length} entry-module name bytes at ${offset}`);
  }
}

function isMachO(fd: number): boolean {
  const magic = readAt(fd, 4, 0);
  if (!magic) return false;
  const value = magic.readUInt32BE(0);
  return value === 0xfeedface // 32-bit, big-endian magic
    || value === 0xfeedfacf // 64-bit
    || value === 0xcefaedfe // 32-bit, byte-swapped
    || value === 0xcffaedfe // 64-bit, byte-swapped
    || value === 0xcafebabe // universal ("fat")
    || value === 0xcafebabf; // universal, 64-bit
}

/**
 * - `discoverable` — tweakcc can already find the bundle; no shim, no change.
 * - `needs-shim` — the module list is readable and nothing in it matches.
 * - `unparseable` — no Bun module list could be read at all.
 *
 * The last two both mean "do nothing" to a caller, but they are very different
 * diagnoses, and collapsing them costs a bisect: tweakcc reports the same
 * "Failed to extract JavaScript" for a name it cannot match, a blob it cannot
 * read, and the unrelated `node-gyp-build` packaging fault. Opens read-only, so
 * it is safe to ask about a pristine backup.
 */
export type EntryModuleState = 'discoverable' | 'needs-shim' | 'unparseable';

export function inspectEntryModule(path: string): EntryModuleState {
  const fd = openSync(path, 'r');
  try {
    const parsed = readBunModuleNames(fd, statSync(path).size);
    if (parsed === null) return 'unparseable';
    return parsed.names.some(tweakccRecognizesModuleName) ? 'discoverable' : 'needs-shim';
  } finally {
    closeSync(fd);
  }
}

/**
 * Give an unpatchable Claude Code binary a module name tweakcc recognizes, so it
 * can read and repack it. Returns null — no write — when the binary already has a
 * recognizable module (every release before 2.1.231, so nothing drifts for
 * existing installs) or when no shim is possible, in which case tweakcc reports its
 * own extraction failure as before.
 *
 * `path` must be a private copy: this WRITES to it.
 */
export function shimEntryModuleName(path: string): EntryModuleShim | null {
  const fd = openSync(path, 'r+');
  try {
    const parsed = readBunModuleNames(fd, statSync(path).size);
    if (!parsed) return null;
    // Only rename when tweakcc would otherwise find nothing. If it can already
    // reach a module, renaming would add a second candidate and could hand it a
    // different one than it picks today.
    if (parsed.names.some(tweakccRecognizesModuleName)) return null;

    const original = parsed.names[parsed.entryPointId]!;
    const offset = parsed.offsets[parsed.entryPointId]!;
    const marker = entryModuleShimName(Buffer.byteLength(original));
    if (marker === null) return null;

    writeNameBytes(fd, marker, offset);
    return { offset, original, marker };
  } finally {
    closeSync(fd);
  }
}

/**
 * Put Claude Code's real entry-module name back. Call this on the repacked
 * candidate BEFORE it is published — a binary shipped under the stand-in name
 * would fail to resolve its sibling native modules.
 *
 * The name is re-located rather than written at `shim.offset`, because repacking
 * rebuilds the blob and moves it.
 *
 * `resign` re-applies an ad-hoc Mach-O signature, which the write invalidates.
 * Pass it after a repack, where the binary would otherwise be unrunnable — and
 * failing here (candidate discarded, install untouched) beats publishing a binary
 * that will not start. Pass `false` when the restore returns a file to bytes that
 * were already validly signed, because re-signing REPLACES Claude Code's own
 * signature and the result is no longer byte-identical to the pristine install —
 * which would silently corrupt a content-addressed pristine backup taken from it.
 */
export function restoreEntryModuleName(
  path: string,
  shim: EntryModuleShim,
  { resign }: { resign: boolean },
): void {
  const fd = openSync(path, 'r+');
  let machO: boolean;
  try {
    const parsed = readBunModuleNames(fd, statSync(path).size);
    const offset = parsed?.offsets[parsed.entryPointId];
    if (!parsed || offset === undefined || parsed.names[parsed.entryPointId] !== shim.marker) {
      throw new Error(
        `expected the entry module of ${path} to be named ${shim.marker}, found `
        + `${parsed ? JSON.stringify(parsed.names[parsed.entryPointId]) : 'no readable Bun module list'}`,
      );
    }
    writeNameBytes(fd, shim.original, offset);
    assertShimGone(fd, statSync(path).size, shim.marker);
    machO = resign && isMachO(fd);
  } finally {
    closeSync(fd);
  }
  if (machO && process.platform === 'darwin') {
    execFileSync('codesign', ['-s', '-', '-f', path], { stdio: 'ignore' });
  }
}
