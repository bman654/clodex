// The stand-in that keeps tweakcc's ELF repack able to find the global Bun reads its blob's
// address from. Claude Code 2.1.257 moved that global off the 16 KiB boundary tweakcc scans, and
// `clodex patch` failed on all four ELF builds with "Could not find original BUN_COMPILED
// location in binary". See src/bun-compiled-pointer.ts.
//
// The binaries here are synthetic: a real one is 300 MB and cannot be committed, and every rule
// this module applies is about ELF structure, which a small hand-built ELF64 carries exactly.
// The real builds are covered by scripts/probe-patch-mechanism.mjs and the canary's container leg.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  restoreBunCompiledPointer,
  shimBunCompiledPointer,
} from '../src/bun-compiled-pointer.js';

const STRIDE = 16384;
// The writable segment starts on an ODD address, as it does on every real build (file offset
// 0x512a490 at virtual address 0x532c490 on linux-x64 2.1.257). A 16 KiB-aligned segment would make
// the first scanned address the segment's own start and hide the arithmetic this module has to get
// right.
const SEG_OFFSET = 0x10490;
/**
 * How far virtual addresses run ahead of file offsets: 0x202000 on the real linux-x64 build,
 * 0x220000 on arm64. Never zero, and that is the point — mapped at `vaddr === offset`, an
 * implementation that confuses the two reads and writes the same wrong place, passes its own
 * readback, and leaves Bun pointed at the old blob on every real Linux build.
 */
const LOAD_BIAS = 0x202000;
const SEG_VADDR = SEG_OFFSET + LOAD_BIAS;
const SEG_SIZE = 0x20000;
/** The lowest address tweakcc's scan visits inside that segment. */
const FIRST_SCANNED = Math.ceil(SEG_VADDR / STRIDE) * STRIDE;
const BUN_OFFSET = 0x20000;
const BUN_VADDR = BUN_OFFSET + LOAD_BIAS;
const BUN_SIZE = 0x8000;
const SHOFF = SEG_OFFSET + SEG_SIZE;

const SECTION_NAMES = ['', '.shstrtab', '.data', '.bun'];

/**
 * A 64-bit little-endian ELF with one writable PT_LOAD and a `.bun` section inside it, carrying
 * the blob pointer at `pointerVaddr`. Everything the module reads — and nothing else.
 */
function buildElf(
  pointerVaddr: number,
  extraPointerVaddrs: number[] = [],
  bun: { offset: number; size: number } = { offset: BUN_OFFSET, size: BUN_SIZE },
  { segSize = SEG_SIZE, decoySegment = false, phnum = 1 }: {
    /** Grow the writable segment past one `SCAN_CHUNK`, so the sweep's chunking loop runs twice. */
    segSize?: number;
    /** Add an earlier PT_LOAD whose vaddr range also covers the pointer but not the stand-in. */
    decoySegment?: boolean;
    /** `e_phnum`. 0xffff is PN_XNUM, which says the real count lives in the section table. */
    phnum?: number;
  } = {},
): Buffer {
  const shstrtab = Buffer.from(SECTION_NAMES.join('\0') + '\0', 'utf8');
  const nameOffsets = new Map<string, number>();
  let at = 0;
  for (const name of SECTION_NAMES) {
    nameOffsets.set(name, at);
    at += name.length + 1;
  }
  const shoff = SEG_OFFSET + segSize;
  const shstrOffset = shoff + 4 * 64;
  const buf = Buffer.alloc(shstrOffset + shstrtab.length, 0);

  buf.writeUInt32LE(0x464c457f, 0);
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // ELFDATA2LSB
  buf.writeBigUInt64LE(BigInt(0x40), 0x20); // e_phoff
  buf.writeBigUInt64LE(BigInt(shoff), 0x28); // e_shoff
  buf.writeUInt16LE(56, 0x36); // e_phentsize
  buf.writeUInt16LE(phnum, 0x38); // e_phnum
  buf.writeUInt16LE(64, 0x3a); // e_shentsize
  buf.writeUInt16LE(4, 0x3c); // e_shnum
  buf.writeUInt16LE(1, 0x3e); // e_shstrndx

  // The one PT_LOAD, writable.
  buf.writeUInt32LE(1, 0x40); // p_type = PT_LOAD
  buf.writeUInt32LE(6, 0x44); // p_flags = R|W
  buf.writeBigUInt64LE(BigInt(SEG_OFFSET), 0x48);
  buf.writeBigUInt64LE(BigInt(SEG_VADDR), 0x50);
  buf.writeBigUInt64LE(BigInt(segSize), 0x60); // p_filesz

  if (decoySegment) {
    // A second PT_LOAD, EARLIER in the table, mapping the same file bytes at the same address but
    // stopping short of the stand-in. Nothing real does this; the point is that resolving an
    // address through "the first segment that contains it" would be a silent wrong answer.
    buf.writeUInt16LE(2, 0x38);
    buf.writeUInt32LE(1, 0x78);
    buf.writeUInt32LE(6, 0x7c);
    buf.writeBigUInt64LE(BigInt(SEG_OFFSET), 0x80);
    buf.writeBigUInt64LE(BigInt(SEG_VADDR), 0x88);
    buf.writeBigUInt64LE(BigInt(FIRST_SCANNED - SEG_VADDR + 0x1000), 0x98);
  }

  const section = (index: number, name: string, addr: number, offset: number, size: number) => {
    const base = shoff + index * 64;
    buf.writeUInt32LE(nameOffsets.get(name)!, base);
    buf.writeBigUInt64LE(BigInt(addr), base + 16);
    buf.writeBigUInt64LE(BigInt(offset), base + 24);
    buf.writeBigUInt64LE(BigInt(size), base + 32);
  };
  section(1, '.shstrtab', 0, shstrOffset, shstrtab.length);
  section(2, '.data', SEG_VADDR, SEG_OFFSET, bun.offset - SEG_OFFSET);
  section(3, '.bun', SEG_VADDR + (bun.offset - SEG_OFFSET), bun.offset, bun.size);
  shstrtab.copy(buf, shstrOffset);

  // A filler that can never be mistaken for an address.
  buf.fill(0xaa, SEG_OFFSET, SEG_OFFSET + segSize);
  const bunVaddr = SEG_VADDR + (bun.offset - SEG_OFFSET);
  for (const vaddr of [pointerVaddr, ...extraPointerVaddrs]) {
    buf.writeBigUInt64LE(BigInt(bunVaddr), SEG_OFFSET + (vaddr - SEG_VADDR));
  }
  return buf;
}

function read8(file: string, vaddr: number): bigint {
  const fd = openSync(file, 'r');
  try {
    const out = Buffer.alloc(8);
    readSync(fd, out, 0, 8, SEG_OFFSET + (vaddr - SEG_VADDR));
    return out.readBigUInt64LE(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * What tweakcc's `repackELFSection` does once its scan succeeds: rewrite the eight bytes it found
 * to `.bun`'s new address, and move the section there. `foundAt` is the address it settled on.
 */
function simulateRepack(file: string, foundAt: number, newBunVaddr: number): void {
  const buf = readFileSync(file);
  buf.writeBigUInt64LE(BigInt(newBunVaddr), SEG_OFFSET + (foundAt - SEG_VADDR));
  // .bun stays inside the segment's file image here — only its recorded address changes, which is
  // all the restore reads.
  buf.writeBigUInt64LE(BigInt(newBunVaddr), SHOFF + 3 * 64 + 16);
  writeFileSync(file, buf);
}

/** tweakcc's own strided scan, so a test can assert the stand-in actually lands where it looks. */
function tweakccScan(file: string, needle: bigint): number | null {
  const buf = readFileSync(file);
  for (let vaddr = FIRST_SCANNED; vaddr <= SEG_VADDR + SEG_SIZE - 8; vaddr += STRIDE) {
    if (buf.readBigUInt64LE(SEG_OFFSET + (vaddr - SEG_VADDR)) === needle) return vaddr;
  }
  return null;
}

describe('the Bun blob pointer stand-in', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clodex-bun-pointer-'));
    file = path.join(dir, 'claude');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The releases through 2.1.252 that tweakcc repacks unaided. Planting anything there would be a
  // change to a path that works, on every ELF build, for no reason.
  it('does nothing when the pointer already sits where tweakcc scans', () => {
    writeFileSync(file, buildElf(FIRST_SCANNED));
    const before = readFileSync(file);

    expect(shimBunCompiledPointer(file)).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it.each([
    ['Mach-O', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])],
    ['PE', Buffer.from('MZ\0\0\0\0\0\0', 'latin1')],
    ['too short to be an ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  ])('leaves a %s binary alone', (_name, bytes) => {
    writeFileSync(file, bytes);
    const before = readFileSync(file);

    expect(shimBunCompiledPointer(file)).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  // The 2.1.257 shape. Every ELF build moved the pointer off the boundary: 0x534f758 on
  // linux-x64, 0x4d9af08 on linux-x64-musl, 0x5310758 on linux-arm64, 0x4c46d10 on
  // linux-arm64-musl — none of them a multiple of 16384.
  describe('when the pointer sits where tweakcc never looks', () => {
    const POINTER = FIRST_SCANNED + 0x758;
    const NEW_BUN_VADDR = 0x900000;

    beforeEach(() => writeFileSync(file, buildElf(POINTER)));

    it('makes tweakcc find something, without disturbing the real pointer', () => {
      expect(tweakccScan(file, BigInt(BUN_VADDR)), 'the fixture must reproduce the failure')
        .toBeNull();

      const shim = shimBunCompiledPointer(file);

      expect(shim).not.toBeNull();
      expect(shim!.pointerVaddr).toBe(BigInt(POINTER));
      expect(tweakccScan(file, BigInt(BUN_VADDR))).toBe(Number(shim!.standInVaddr));
      expect(read8(file, POINTER)).toBe(BigInt(BUN_VADDR));
    });

    it('moves the repacked address onto the real pointer and puts the displaced bytes back', () => {
      const shim = shimBunCompiledPointer(file)!;
      const displacedAt = Number(shim.standInVaddr);
      const before = read8(file, displacedAt);

      simulateRepack(file, displacedAt, NEW_BUN_VADDR);
      restoreBunCompiledPointer(file, shim);

      expect(read8(file, POINTER)).toBe(BigInt(NEW_BUN_VADDR));
      expect(read8(file, displacedAt)).toBe(shim.displaced.readBigUInt64LE(0));
      expect(before, 'the stand-in really did displace something').toBe(BigInt(BUN_VADDR));
    });

    // A repack that silently did not use the stand-in would leave Bun pointed at a blob that is no
    // longer there — a claude that dies before it prints anything. Refuse instead of publishing.
    it('refuses when the repack never rewrote the stand-in', () => {
      const shim = shimBunCompiledPointer(file)!;

      expect(() => restoreBunCompiledPointer(file, shim))
        .toThrow('the stand-in was not used');
      expect(read8(file, POINTER), 'and it left the binary as it found it').toBe(BigInt(BUN_VADDR));
    });

    it('refuses when the repack disagrees with where .bun ended up', () => {
      const shim = shimBunCompiledPointer(file)!;
      const buf = readFileSync(file);
      // The stand-in says one address, the section header says another.
      buf.writeBigUInt64LE(BigInt(NEW_BUN_VADDR), SEG_OFFSET + (Number(shim.standInVaddr) - SEG_VADDR));
      buf.writeBigUInt64LE(BigInt(NEW_BUN_VADDR + 0x1000), SHOFF + 3 * 64 + 16);
      writeFileSync(file, buf);

      expect(() => restoreBunCompiledPointer(file, shim))
        .toThrow(/pointed Bun at 0x900000 but put \.bun at 0x901000/);
    });
  });

  // Matches inside the blob are coincidences in compressed JavaScript — real builds carry dozens.
  // A second match OUTSIDE it is not something this module is entitled to guess about.
  it('refuses to guess when more than one pointer candidate is outside the blob', () => {
    writeFileSync(file, buildElf(FIRST_SCANNED + 0x758, [FIRST_SCANNED + 0x900]));

    expect(() => shimBunCompiledPointer(file))
      .toThrow("cannot locate Bun's blob pointer: 2 candidates");
  });

  // The remaining refusal: nowhere the scan visits is usable, because the blob covers every one of
  // them. Nothing observed does this, but the alternative to refusing is planting the stand-in into
  // the blob tweakcc is about to reparse.
  it('refuses when every address tweakcc scans is inside the blob', () => {
    // `.bun` starts below the first scanned address and runs to the end of the segment, so every
    // address the scan visits is inside the blob the repack is about to move. The real pointer sits
    // in the sliver below it. Nothing observed does this; the alternative to refusing would be
    // planting the stand-in into the blob tweakcc is about to reparse.
    const bun = { offset: SEG_OFFSET + 0x1000, size: SEG_SIZE - 0x1000 };
    writeFileSync(file, buildElf(SEG_VADDR + 0x40, [], bun));

    expect(() => shimBunCompiledPointer(file))
      .toThrow("no address tweakcc's ELF repack scans is usable");
  });

  // Mirrors SCAN_CHUNK in src/bun-compiled-pointer.ts. The other fixtures here are smaller than one
  // chunk, so the sweep's loop body runs once and the overlap that stitches chunks together is
  // unobservable — a pointer that straddles a boundary would be missed, or found twice and refused
  // as ambiguous, with every other test still green.
  const SCAN_CHUNK = 1 << 20;
  const BIG_SEG = 3 * SCAN_CHUNK;

  it.each([
    { where: 'wholly inside the first chunk', delta: SCAN_CHUNK - 8 },
    { where: 'straddling the first boundary', delta: SCAN_CHUNK - 4 },
    { where: 'first byte past the first boundary', delta: SCAN_CHUNK - 7 },
    { where: 'straddling the second boundary', delta: 2 * (SCAN_CHUNK - 7) - 3 },
    { where: 'in the last chunk', delta: 2 * SCAN_CHUNK + 0x40 },
  ])('finds a pointer $where of the segment sweep', ({ delta }) => {
    const pointer = SEG_VADDR + delta;
    const bun = { offset: SEG_OFFSET + BIG_SEG - 0x8000, size: 0x8000 };
    writeFileSync(file, buildElf(pointer, [], bun, { segSize: BIG_SEG }));

    const shim = shimBunCompiledPointer(file);

    // Found once: a miss throws "0 candidates", a double-report throws "2 candidates".
    expect(shim).not.toBeNull();
    expect(shim!.pointerVaddr).toBe(BigInt(pointer));
  });

  // `fileOffsetOf` resolves the two addresses in the REPACKED image. Taking the first PT_LOAD that
  // contains an address would put the repacked value at the wrong file offset, and every check in
  // the restore would still pass, because the readback reads the offset it just wrote.
  it('refuses to resolve an address that more than one segment claims', () => {
    const pointer = FIRST_SCANNED + 0x758;
    writeFileSync(file, buildElf(pointer, [], { offset: BUN_OFFSET, size: BUN_SIZE }));
    const shim = shimBunCompiledPointer(file)!;
    // Re-lay the same bytes with the overlapping decoy segment, keeping the stand-in tweakcc wrote.
    const withDecoy = buildElf(pointer, [], { offset: BUN_OFFSET, size: BUN_SIZE }, { decoySegment: true });
    withDecoy.writeBigUInt64LE(BigInt(0x90000), SEG_OFFSET + (Number(shim.standInVaddr) - SEG_VADDR));
    withDecoy.writeBigUInt64LE(BigInt(0x90000), SHOFF + 3 * 64 + 16);
    writeFileSync(file, withDecoy);

    expect(() => restoreBunCompiledPointer(file, shim)).toThrow('in more than one segment');
  });

  // PN_XNUM says the real program-header count lives in the section table. Reading 0xffff headers
  // of arbitrary file bytes as segments is how a stand-in gets planted at a garbage offset.
  it('leaves an ELF alone when its program-header count is PN_XNUM', () => {
    // Big enough that 0xffff * 56 bytes of "program headers" can actually be read out of it —
    // otherwise the short read rejects the file anyway and this passes without testing the guard.
    const bun = { offset: SEG_OFFSET + 4 * SCAN_CHUNK - 0x8000, size: 0x8000 };
    writeFileSync(
      file,
      buildElf(FIRST_SCANNED + 0x758, [], bun, { segSize: 4 * SCAN_CHUNK, phnum: 0xffff }),
    );
    const before = readFileSync(file);

    expect(shimBunCompiledPointer(file)).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('ignores candidates inside the blob itself', () => {
    // Two more occurrences, both inside `.bun`, exactly as a real bundle carries them (5 of them on
    // linux-arm64 2.1.257). Neither may land on a 16 KiB boundary, or tweakcc's own scan finds one
    // and this stops testing the exclusion at all.
    const inBlob = [BUN_VADDR + 0x40, BUN_VADDR + 0x2100];
    for (const vaddr of inBlob) expect(vaddr % STRIDE, 'decoy must be off the scan stride').not.toBe(0);
    writeFileSync(file, buildElf(FIRST_SCANNED + 0x758, inBlob));

    const shim = shimBunCompiledPointer(file);

    expect(shim).not.toBeNull();
    expect(shim!.pointerVaddr).toBe(BigInt(FIRST_SCANNED + 0x758));
  });
});
