// Keeps tweakcc's ELF repack able to find the pointer Bun uses to locate its embedded blob.
//
// Read `.claude/docs/patcher.md` first. This file exists for the same reason `bun-entry-module.ts`
// does: tweakcc identifies something in the binary by a rule that a Claude Code release quietly
// stopped satisfying, and the cheapest correct answer is a reversible byte-level stand-in around
// the repack rather than a fork of tweakcc.
//
// THE RULE. A Bun standalone ELF stores the virtual address of its `.bun` section in an 8-byte
// little-endian global — Bun reads it at startup to find the blob. `repackELFSection` moves `.bun`
// to a fresh page past the end of the file, so it has to rewrite that global. It finds it by
// scanning the first writable `PT_LOAD` segment for 8 bytes equal to `.bun`'s CURRENT virtual
// address — but only at addresses that are multiples of 16384. tweakcc 4.3.0 and 4.3.3 both do
// this; bumping the pin does not help.
//
// WHAT BROKE. Through Claude Code 2.1.252 that global happened to land on a 16 KiB boundary on
// every ELF build (measured: 2.1.246 and 2.1.252, x64 and arm64, glibc and musl — all at
// `vaddr % 16384 === 0`). Claude Code 2.1.257 moved it off one: 0x534f758 on linux-x64,
// 0x4d9af08 on linux-x64-musl, 0x5310758 on linux-arm64, 0x4c46d10 on linux-arm64-musl. The
// strided scan steps straight over it, `repackELFSection` throws "Could not find original
// BUN_COMPILED location in binary", and `clodex patch` fails on all four ELF builds. Nothing about
// clodex's own patches changed; the alignment the scan assumes is not a property Bun promises.
//
// THE STAND-IN. Before the repack, plant a copy of the value the scan is looking for at an address
// the scan DOES visit, and remember the eight bytes displaced. tweakcc then finds that copy and
// rewrites it to the new `.bun` address. Afterwards, copy the new address to where the real global
// actually lives and put the displaced bytes back, so the published binary differs from a
// pristine repack in exactly one place: the global, holding the value it was always meant to hold.
//
// Two things make that safe rather than clever, and both are checked rather than assumed:
//   * it is a NO-OP wherever tweakcc already works. `bunCompiledPointerScan` runs tweakcc's own
//     scan first; if that finds anything, this module returns null and stays out of the way. So an
//     older release, and any future release that goes back to being aligned, takes the path it
//     always took.
//   * the real global is identified, not guessed: the ONE 8-byte occurrence of `.bun`'s address
//     inside the writable segment and outside `.bun`'s own payload. Matches inside the payload are
//     coincidences in compressed JavaScript (there are dozens on some builds) and are excluded by
//     range. Anything other than exactly one candidate is refused, loudly, instead of patched.
// The restore reads back both addresses and refuses a binary where either did not take.

import { closeSync, openSync, readSync, writeSync } from 'node:fs';

/** tweakcc's `repackELFSection` only inspects addresses at this stride. Mirrored, not chosen. */
const TWEAKCC_SCAN_STRIDE = 16384n;

/** Chunk used to sweep the writable segment for the pointer. Any size ≥ 8 is correct. */
const SCAN_CHUNK = 1 << 20;

const ELF_MAGIC = 0x464c457f;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const PT_LOAD = 1;
const PF_W = 2;

interface ElfSection {
  name: string;
  addr: bigint;
  offset: bigint;
  size: bigint;
}

interface ElfSegment {
  type: number;
  flags: number;
  offset: bigint;
  vaddr: bigint;
  filesz: bigint;
}

interface ElfLayout {
  sections: ElfSection[];
  segments: ElfSegment[];
}

/** What `shimBunCompiledPointer` has to hand back for the restore to finish the job. */
export interface BunCompiledPointerShim {
  /** Address of the real Bun global. Its FILE offset is re-derived from the repacked binary. */
  pointerVaddr: bigint;
  /** Address of the aligned slot tweakcc will find and rewrite instead. */
  standInVaddr: bigint;
  /** The eight bytes the stand-in displaced, put back verbatim after the repack. */
  displaced: Buffer;
  /** `.bun`'s address before the repack — what the planted copy holds. */
  bunVaddr: bigint;
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n <= 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/**
 * Section and segment tables of a little-endian ELF64, or null for anything else — a Mach-O, a PE,
 * an npm `cli.js`, or a truncated file. Null means "not our case", never "assume it is fine".
 */
function readElfLayout(fd: number): ElfLayout | null {
  const ident = readAt(fd, 64, 0);
  if (ident.length < 64) return null;
  if (ident.readUInt32LE(0) !== ELF_MAGIC) return null;
  if (ident[4] !== ELFCLASS64 || ident[5] !== ELFDATA2LSB) return null;

  const phoff = ident.readBigUInt64LE(0x20);
  const shoff = ident.readBigUInt64LE(0x28);
  const phentsize = ident.readUInt16LE(0x36);
  const phnum = ident.readUInt16LE(0x38);
  const shentsize = ident.readUInt16LE(0x3a);
  const shnum = ident.readUInt16LE(0x3c);
  const shstrndx = ident.readUInt16LE(0x3e);
  // `e_shnum === 0` is SHN_XINDEX and `e_phnum === 0xffff` is PN_XNUM: both say the real count
  // lives elsewhere. Neither occurs on any Claude Code build (measured: 10 program headers, 38-42
  // sections on all eight), and reading 0xffff headers of arbitrary file bytes as segments is how
  // a stand-in gets planted at a garbage offset.
  if (shnum === 0 || phnum === 0xffff) return null;
  if (shstrndx >= shnum || shentsize < 64 || phentsize < 56) return null;

  const shTable = readAt(fd, shnum * shentsize, Number(shoff));
  if (shTable.length !== shnum * shentsize) return null;
  const raw = [];
  for (let i = 0; i < shnum; i++) {
    const at = i * shentsize;
    raw.push({
      nameOffset: shTable.readUInt32LE(at),
      addr: shTable.readBigUInt64LE(at + 16),
      offset: shTable.readBigUInt64LE(at + 24),
      size: shTable.readBigUInt64LE(at + 32),
    });
  }
  const strtab = raw[shstrndx]!;
  const names = readAt(fd, Number(strtab.size), Number(strtab.offset));
  const sections: ElfSection[] = raw.map(section => {
    const start = section.nameOffset;
    let end = start;
    while (end < names.length && names[end] !== 0) end++;
    return {
      name: names.toString('utf8', start, end),
      addr: section.addr,
      offset: section.offset,
      size: section.size,
    };
  });

  const phTable = readAt(fd, phnum * phentsize, Number(phoff));
  if (phTable.length !== phnum * phentsize) return null;
  const segments: ElfSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const at = i * phentsize;
    segments.push({
      type: phTable.readUInt32LE(at),
      flags: phTable.readUInt32LE(at + 4),
      offset: phTable.readBigUInt64LE(at + 8),
      vaddr: phTable.readBigUInt64LE(at + 16),
      filesz: phTable.readBigUInt64LE(at + 32),
    });
  }
  return { sections, segments };
}

function alignUp(value: bigint, to: bigint): bigint {
  return ((value + to - 1n) / to) * to;
}

/** The segment tweakcc searches: the first writable `PT_LOAD`. Same predicate, same order. */
function writableLoad(layout: ElfLayout): ElfSegment | undefined {
  return layout.segments.find(segment => segment.type === PT_LOAD && (segment.flags & PF_W) !== 0);
}

/**
 * File offset of `vaddr`, or null when no loaded segment's file image holds it — or when MORE than
 * one does. Taking the first match would be a silent wrong answer rather than a safe one: the
 * restore's readback reads the offset it just wrote, so it proves the write landed, not that the
 * offset was right, and Bun would be left pointed at the old blob. No real build has overlapping
 * PT_LOADs (checked on all eight 2.1.257/2.1.252/2.1.246 builds and on a repacked one), so this
 * refuses a shape that does not occur rather than resolving one that does.
 */
function fileOffsetOf(layout: ElfLayout, vaddr: bigint, length: bigint): number | null {
  let found: number | null = null;
  for (const segment of layout.segments) {
    if (segment.type !== PT_LOAD) continue;
    if (vaddr < segment.vaddr) continue;
    if (vaddr + length > segment.vaddr + segment.filesz) continue;
    if (found !== null) return null;
    found = Number(segment.offset + (vaddr - segment.vaddr));
  }
  return found;
}

/**
 * tweakcc's own strided scan, reproduced exactly, over the given `needle`. Returns the address it
 * would settle on, or null when it would throw. Running it is what keeps this module a no-op on
 * every build where tweakcc needs no help.
 */
function tweakccWouldFind(fd: number, segment: ElfSegment, needle: Buffer): bigint | null {
  const first = alignUp(segment.vaddr, TWEAKCC_SCAN_STRIDE);
  const last = segment.vaddr + segment.filesz - 8n;
  for (let vaddr = first; vaddr <= last; vaddr += TWEAKCC_SCAN_STRIDE) {
    const at = Number(segment.offset + (vaddr - segment.vaddr));
    if (readAt(fd, 8, at).equals(needle)) return vaddr;
  }
  return null;
}

/** Every offset in `[from, to)` holding `needle`, excluding those inside `[skipFrom, skipTo)`. */
function scanForNeedle(
  fd: number,
  from: number,
  to: number,
  needle: Buffer,
  skipFrom: number,
  skipTo: number,
): number[] {
  const hits: number[] = [];
  // Overlap by 7 so a match straddling a chunk boundary is not missed.
  for (let start = from; start < to; start += SCAN_CHUNK - 7) {
    const length = Math.min(SCAN_CHUNK, to - start);
    if (length < 8) break;
    const chunk = readAt(fd, length, start);
    let at = 0;
    for (;;) {
      const found = chunk.indexOf(needle, at);
      if (found < 0) break;
      const offset = start + found;
      if (offset < skipFrom || offset >= skipTo) hits.push(offset);
      at = found + 1;
    }
  }
  return hits;
}

/**
 * Plant the stand-in tweakcc's ELF repack needs, or return null when it needs none.
 *
 * Null covers every case this does not apply to: a Mach-O or PE binary, a non-native install, a
 * binary with no `.bun` section or no writable segment, and — the important one — any ELF where
 * tweakcc's own scan already finds the pointer. Throws only when the binary IS one that needs help
 * and the pointer cannot be identified unambiguously, because publishing a binary whose Bun global
 * still points at the old blob would produce a `claude` that does not start.
 */
export function shimBunCompiledPointer(path: string): BunCompiledPointerShim | null {
  const fd = openSync(path, 'r+');
  try {
    const layout = readElfLayout(fd);
    if (!layout) return null;
    const bun = layout.sections.find(section => section.name === '.bun');
    if (!bun || bun.size === 0n) return null;
    const segment = writableLoad(layout);
    if (!segment) return null;

    const needle = Buffer.alloc(8);
    needle.writeBigUInt64LE(bun.addr);
    if (tweakccWouldFind(fd, segment, needle) !== null) return null;

    const segmentStart = Number(segment.offset);
    const segmentEnd = Number(segment.offset + segment.filesz);
    const bunStart = Number(bun.offset);
    const bunEnd = Number(bun.offset + bun.size);
    const candidates = scanForNeedle(fd, segmentStart, segmentEnd, needle, bunStart, bunEnd);
    if (candidates.length !== 1) {
      throw new Error(
        `cannot locate Bun's blob pointer: ${candidates.length} candidates in the writable segment `
        + `(expected 1). Refusing to repack a binary whose Bun global would be left stale.`,
      );
    }
    const pointerOffset = candidates[0]!;
    const pointerVaddr = segment.vaddr + BigInt(pointerOffset) - segment.offset;

    // The slot tweakcc will land on: the lowest address its scan visits that overlaps neither the
    // blob it is about to move nor the global we are about to correct. Its previous contents are
    // restored below, so "free" is not required of it — only "not something the repack rereads".
    const first = alignUp(segment.vaddr, TWEAKCC_SCAN_STRIDE);
    const last = segment.vaddr + segment.filesz - 8n;
    let standInVaddr: bigint | null = null;
    for (let vaddr = first; vaddr <= last; vaddr += TWEAKCC_SCAN_STRIDE) {
      const at = Number(segment.offset + (vaddr - segment.vaddr));
      if (at + 8 > bunStart && at < bunEnd) continue;
      if (at + 8 > pointerOffset && at < pointerOffset + 8) continue;
      standInVaddr = vaddr;
      break;
    }
    if (standInVaddr === null) {
      throw new Error("no address tweakcc's ELF repack scans is usable for Bun's blob pointer");
    }

    const standInOffset = Number(segment.offset + (standInVaddr - segment.vaddr));
    const displaced = readAt(fd, 8, standInOffset);
    if (displaced.length !== 8) throw new Error("could not read the bytes Bun's blob pointer displaces");
    writeSync(fd, needle, 0, 8, standInOffset);
    return { pointerVaddr, standInVaddr, displaced, bunVaddr: bun.addr };
  } finally {
    closeSync(fd);
  }
}

/**
 * Move the address tweakcc wrote into the stand-in over to the real Bun global, and put the
 * displaced bytes back. Throws if either address no longer resolves to exactly one place in the
 * repacked image, if the repack did not rewrite the stand-in, or if it disagrees with where `.bun`
 * actually ended up — all of which would leave a `claude` that fails inside Bun before it prints
 * anything. (The readbacks below confirm the writes landed. They read the offsets they just wrote,
 * so they cannot vouch for the offsets themselves; `fileOffsetOf` is what does that.)
 */
export function restoreBunCompiledPointer(path: string, shim: BunCompiledPointerShim): void {
  const fd = openSync(path, 'r+');
  try {
    const layout = readElfLayout(fd);
    if (!layout) throw new Error('the repacked binary is no longer a 64-bit little-endian ELF');
    const bun = layout.sections.find(section => section.name === '.bun');
    if (!bun) throw new Error('the repacked binary has no .bun section');

    const standInOffset = fileOffsetOf(layout, shim.standInVaddr, 8n);
    const pointerOffset = fileOffsetOf(layout, shim.pointerVaddr, 8n);
    if (standInOffset === null || pointerOffset === null) {
      throw new Error(
        "the repack left Bun's blob pointer outside the loaded image, or in more than one segment of it",
      );
    }
    const written = readAt(fd, 8, standInOffset).readBigUInt64LE(0);
    if (written === shim.bunVaddr) {
      throw new Error("the repack did not rewrite Bun's blob pointer — the stand-in was not used");
    }
    if (written !== bun.addr) {
      throw new Error(
        `the repack pointed Bun at 0x${written.toString(16)} but put .bun at 0x${bun.addr.toString(16)}`,
      );
    }

    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(written);
    writeSync(fd, value, 0, 8, pointerOffset);
    writeSync(fd, shim.displaced, 0, 8, standInOffset);

    if (!readAt(fd, 8, pointerOffset).equals(value)) {
      throw new Error("Bun's blob pointer did not take the repacked address");
    }
    if (!readAt(fd, 8, standInOffset).equals(shim.displaced)) {
      throw new Error('the bytes the stand-in displaced were not restored');
    }
  } finally {
    closeSync(fd);
  }
}
