// The stand-in that keeps tweakcc's ELF repack able to find the global holding the address of
// Bun's blob. Claude Code 2.1.257 moved that global off the 16 KiB boundary tweakcc scans, and
// `clodex patch` failed on all four ELF builds with "Could not find original BUN_COMPILED
// location in binary". See src/bun-compiled-pointer.ts.
//
// The binaries here are synthetic: a real one is 300 MB and cannot be committed, and every rule
// this module applies is about ELF structure, which a small hand-built ELF64 carries exactly.
// The real builds are covered by scripts/probe-patch-mechanism.mjs and the canary's container leg.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';

/**
 * The restore's two readbacks exist to catch a write that was issued and did not land. Nothing in
 * the production path can produce that, and substituting an impossible shim does not test it: a
 * mutant that inspects the impossible field instead of reading the file passes such a test. So the
 * write itself is faulted — `writeSync` reports success for one position and writes nothing — with
 * an ordinary shim from `shimBunCompiledPointer` and an ordinary repack either side of it.
 */
const droppedWrite: { atPosition: number | null } = { atPosition: null };
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: (fd: number, buffer: never, offset: number, length: number, position: number) =>
      (droppedWrite.atPosition !== null && position === droppedWrite.atPosition
        ? length
        : actual.writeSync(fd, buffer, offset, length, position)),
  };
});
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
 * readback, and rewrites eight bytes that are not the global on every real Linux build.
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
  { segSize = SEG_SIZE, decoySegment = false, phnum = 1, trailingWritableSegment = false }: {
    /** Grow the writable segment past one `SCAN_CHUNK`, so the sweep's chunking loop runs twice. */
    segSize?: number;
    /** Add an earlier PT_LOAD whose vaddr range also covers the pointer but not the stand-in. */
    decoySegment?: boolean;
    /** `e_phnum`. 0xffff is PN_XNUM, which says the real count lives in the section table. */
    phnum?: number;
    /**
     * Add a LATER writable PT_LOAD holding none of the pointer occurrences. tweakcc takes the
     * FIRST writable `PT_LOAD`; a mirror that took the last would scan this one instead.
     */
    trailingWritableSegment?: boolean;
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

  if (trailingWritableSegment) {
    // Mapped past everything else, and left as filler, so it carries no occurrence of `.bun`'s
    // address. Picking it instead of the real one makes the census come up empty.
    buf.writeUInt16LE(2, 0x38);
    buf.writeUInt32LE(1, 0x78);
    buf.writeUInt32LE(6, 0x7c);
    buf.writeBigUInt64LE(BigInt(SEG_OFFSET), 0x80);
    buf.writeBigUInt64LE(BigInt(SEG_VADDR + segSize + 0x100000), 0x88);
    buf.writeBigUInt64LE(BigInt(0x1000), 0x98);
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
  afterEach(() => {
    droppedWrite.atPosition = null;
    rmSync(dir, { recursive: true, force: true });
  });

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

    // A repack that silently did not use the stand-in means the address clodex is about to copy
    // over the real global was never written. Refuse instead of publishing a guess.
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

  // The "exactly one candidate" rule has to govern the NO-OP path too, and for a while it did not:
  // the module ran tweakcc's scan first and returned null the moment it found anything. So a build
  // carrying a coincidental copy of `.bun`'s address at an address the scan visits made clodex
  // stand aside while the repack rewrote that copy — eight bytes of live `.data`/`.tdata` that
  // nothing then restores — and `clodex patch` reported success. Both shapes below took that path.
  //
  // No shipped build reaches either (every occurrence on the four 2.1.257 ELF builds is unaligned,
  // and on 2.1.252 the single aligned hit IS the global), which is exactly why it needs a test:
  // there is no real binary that would notice the regression.
  describe('when tweakcc would settle on something that is not the real pointer', () => {
    it('refuses when the aligned decoy is inside the blob, where the census cannot see it', () => {
      // Inside `.bun`, so the census excludes it by range and still finds exactly one candidate —
      // and on a 16 KiB boundary, so tweakcc's scan stops there instead. This is the realistic
      // shape: the coincidental copies a real build carries live in the compressed payload.
      const decoy = Math.ceil(BUN_VADDR / STRIDE) * STRIDE;
      expect(decoy, 'decoy must be inside the blob').toBeLessThan(BUN_VADDR + BUN_SIZE);
      const pointer = FIRST_SCANNED + 0x758;
      writeFileSync(file, buildElf(pointer, [decoy]));

      expect(tweakccScan(file, BigInt(BUN_VADDR)), 'tweakcc must land on the decoy, or this proves nothing')
        .toBe(decoy);

      const before = readFileSync(file);
      expect(() => shimBunCompiledPointer(file)).toThrow(
        `tweakcc's ELF repack would rewrite 0x${decoy.toString(16)}, which is not Bun's blob pointer `
        + `at 0x${pointer.toString(16)}`,
      );
      expect(readFileSync(file).equals(before), 'a refusal must not have written anything').toBe(true);
    });

    it('refuses when the aligned decoy is outside the blob, as a second candidate', () => {
      // Same failure, caught one check earlier: two candidates outside the payload is ambiguous
      // before tweakcc's preference between them matters.
      writeFileSync(file, buildElf(FIRST_SCANNED + 0x758, [FIRST_SCANNED]));

      expect(tweakccScan(file, BigInt(BUN_VADDR))).toBe(FIRST_SCANNED);
      expect(() => shimBunCompiledPointer(file))
        .toThrow("cannot locate Bun's blob pointer: 2 candidates");
    });
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
  // Every length below is read out of the file's own header, so the reads are sized against the
  // file before allocating. Each fixture is the shape that makes ONE of the three call sites throw
  // a raw RangeError without its guard — verified by deleting that guard alone. The distinction
  // matters: `e_shoff` and `e_shnum * e_shentsize` both land on the section-table read, so they
  // cannot stand in for the program-header one.
  describe('refuses a header that claims more than the file holds', () => {
    // `Buffer.alloc(0xfffe * 0xffff)` is ~4.3 GB, the shape the code comment cites. Unguarded this
    // is `RangeError: The value of "length" is out of range ... Received -196606` — readSync
    // coerces the length to int32.
    it('when the section table would run past the end', () => {
      const buf = buildElf(FIRST_SCANNED + 0x758);
      buf.writeUInt16LE(0xfffe, 0x3c); // e_shnum
      buf.writeUInt16LE(0xffff, 0x3a); // e_shentsize
      writeFileSync(file, buf);

      expect(shimBunCompiledPointer(file)).toBeNull();
    });

    // The other half of `fits`: a position past 2^53 converts to a double that cannot address a
    // byte. Unguarded, `RangeError: The value of "position" is out of range`.
    it('when a table offset is not a safe integer', () => {
      const buf = buildElf(FIRST_SCANNED + 0x758);
      buf.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 8n, 0x28); // e_shoff
      writeFileSync(file, buf);

      expect(shimBunCompiledPointer(file)).toBeNull();
    });

    // The program-header read has its own guard and its own fixture; neither of the two above
    // reaches it, because both are refused at the section table first.
    it('when the program-header table would run past the end', () => {
      const buf = buildElf(FIRST_SCANNED + 0x758);
      buf.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 8n, 0x20); // e_phoff
      writeFileSync(file, buf);

      expect(shimBunCompiledPointer(file)).toBeNull();
    });

    // 2^53 exactly, NOT 2^40: unguarded, a 1 TB `Buffer.alloc` succeeds lazily and the function
    // still returns null, so a smaller fixture would pass with the guard deleted and prove nothing.
    it('when the section-name table claims an impossible size', () => {
      const buf = buildElf(FIRST_SCANNED + 0x758);
      const shoff = SEG_OFFSET + SEG_SIZE;
      buf.writeBigUInt64LE(2n ** 53n, shoff + 1 * 64 + 32); // .shstrtab sh_size
      writeFileSync(file, buf);

      expect(shimBunCompiledPointer(file)).toBeNull();
    });
  });

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

  // The restore advertises that both of its writes are read back before it reports success. The
  // production path cannot make a write fail, so these drive `restoreBunCompiledPointer` with a
  // hand-built shim — the only way to reach either branch. Without them both `if (!readAt(...))`
  // blocks can be deleted with the whole file green, and `bun-compiled-pointer.ts` is not covered
  // by the transform source digest either, so nothing at all would notice.
  describe('the restore refuses when a write did not land', () => {
    const POINTER = FIRST_SCANNED + 0x758;
    const NEW_BUN_VADDR = 0x900000;

    it('refuses when the blob pointer does not read back', () => {
      writeFileSync(file, buildElf(POINTER));
      const shim = shimBunCompiledPointer(file)!;
      simulateRepack(file, Number(shim.standInVaddr), NEW_BUN_VADDR);

      // Drop only the write to the real global. Everything else — the shim, the repack, the
      // displaced-bytes write — is exactly what production does.
      droppedWrite.atPosition = SEG_OFFSET + (POINTER - SEG_VADDR);

      expect(() => restoreBunCompiledPointer(file, shim))
        .toThrow("Bun's blob pointer did not take the repacked address");
    });

    // `readAt` returns a SHORT buffer instead of throwing, and the stand-in readback is the one
    // consumer that indexes into it. Unguarded it raises `RangeError: Attempt to access memory
    // outside buffer bounds`, which names neither the binary nor the check.
    it('names the binary when the repacked file ends before the stand-in', () => {
      writeFileSync(file, buildElf(POINTER));
      const shim = shimBunCompiledPointer(file)!;
      simulateRepack(file, Number(shim.standInVaddr), NEW_BUN_VADDR);

      // Only NOW inflate `p_filesz`, so the census above ran against a sane file: the segment
      // claims bytes the file does not have, which is what a truncated binary looks like.
      const poked = readFileSync(file);
      poked.writeBigUInt64LE(BigInt(SEG_SIZE + 0x10000), 0x60);
      writeFileSync(file, poked);

      const beyond = BigInt(SEG_VADDR + SEG_SIZE + 0x8000);
      expect(() => restoreBunCompiledPointer(file, { ...shim, standInVaddr: beyond }))
        .toThrow("the repacked binary ends before the stand-in for Bun's blob pointer");
    });

    it('refuses when the displaced bytes do not read back', () => {
      writeFileSync(file, buildElf(POINTER));
      const shim = shimBunCompiledPointer(file)!;
      simulateRepack(file, Number(shim.standInVaddr), NEW_BUN_VADDR);

      // Drop only the write that puts the borrowed bytes back. The pointer write lands, so this
      // cannot pass by tripping the first guard instead.
      droppedWrite.atPosition = SEG_OFFSET + (Number(shim.standInVaddr) - SEG_VADDR);

      expect(() => restoreBunCompiledPointer(file, shim))
        .toThrow('the bytes the stand-in displaced were not restored');
    });
  });

  // Three details that are pure MIRROR FIDELITY: they make no difference on any build published so
  // far, so nothing real would notice them drifting away from what tweakcc actually does. Drifting
  // away from what tweakcc actually does is the whole reason `clodex patch` broke on 2.1.257, which
  // is why they are pinned here rather than left to a comment.
  describe('mirrors tweakcc exactly, in ways no shipped build exercises', () => {
    it('scans the FIRST writable PT_LOAD, as tweakcc does', () => {
      // A later writable segment carrying no occurrence of the address. tweakcc takes the first
      // one; taking the last would sweep an empty range and refuse with "0 candidates".
      const pointer = FIRST_SCANNED + 0x758;
      writeFileSync(file, buildElf(pointer, [], undefined, { trailingWritableSegment: true }));

      const shim = shimBunCompiledPointer(file);

      expect(shim).not.toBeNull();
      expect(shim!.pointerVaddr).toBe(BigInt(pointer));
    });

    it('visits the last address tweakcc visits, not one short of it', () => {
      // tweakcc's loop is `for (e = m; e <= h; e += 16384)` with `h = vaddr + len - 8`. Sized so
      // that `h` lands exactly ON the stride, which is the only geometry where `<` and `<=`
      // disagree — and where `<` would make clodex plant a stand-in tweakcc did not need.
      const segSize = 0x21b78;
      const last = SEG_VADDR + segSize - 8;
      expect(last % STRIDE, 'the fixture must put the final slot exactly on the stride').toBe(0);
      expect(last, 'the final slot must be outside .bun').toBeGreaterThan(BUN_VADDR + BUN_SIZE);

      writeFileSync(file, buildElf(last, [], undefined, { segSize }));
      const before = readFileSync(file);

      expect(shimBunCompiledPointer(file), 'tweakcc can reach this one unaided').toBeNull();
      expect(readFileSync(file).equals(before)).toBe(true);
    });

    it('does not borrow a slot that overlaps the real pointer', () => {
      // The global 4 bytes past a boundary: the first slot the stand-in would pick overlaps it, so
      // planting there would corrupt the very address the restore then reads.
      const pointer = FIRST_SCANNED + 4;
      writeFileSync(file, buildElf(pointer));

      const shim = shimBunCompiledPointer(file)!;

      expect(shim.standInVaddr).not.toBe(BigInt(FIRST_SCANNED));
      expect(shim.standInVaddr).toBe(BigInt(FIRST_SCANNED + STRIDE));
      expect(read8(file, pointer), 'the real pointer must survive planting').toBe(BigInt(BUN_VADDR));
    });
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
