// The Bun blob pointer stand-in on an ELF whose first writable segment is not `.bun`'s.
//
// Claude Code 2.1.314's glibc builds (linux-x64, linux-arm64) put a RELRO-only writable PT_LOAD
// ahead of the one holding `.data`, the blob pointer and `.bun`. tweakcc 4.3.3 scans and extends
// the FIRST writable PT_LOAD, so the census, which mirrored that choice, found 0 candidates and
// `clodex patch` refused both builds. The musl builds keep one writable segment and never reach
// any of this. See src/bun-compiled-pointer.ts.
//
// Synthetic, like tests/bun-compiled-pointer.test.ts: a real build is 300 MB. The real ones are
// covered by scripts/probe-patch-mechanism.mjs and the canary's linux-arm64 container leg.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/** Lets a test make one `writeSync` report success and write nothing, to fault a readback. */
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
const PF_RW = 6;
const PHOFF = 0x40;
const PHENTSIZE = 56;
/** Never zero on a real build: 0x202000 on linux-x64. */
const LOAD_BIAS = 0x202000;

// Laid out like linux-x64 2.1.314, scaled down: the RELRO segment starts off the page, the main
// one follows it in the file, and `.bun` sits inside the main one past `.data`.
const RELRO_OFFSET = 0x8770;
const RELRO_SIZE = 0x6000;
const MAIN_OFFSET = 0x105a8;
const MAIN_SIZE = 0x20000;
const BUN_OFFSET = 0x20000;
const BUN_SIZE = 0x8000;
const BUN_VADDR = BUN_OFFSET + LOAD_BIAS;
const MAIN_VADDR = MAIN_OFFSET + LOAD_BIAS;
const RELRO_VADDR = RELRO_OFFSET + LOAD_BIAS;
const SHOFF = MAIN_OFFSET + MAIN_SIZE;
/** An optional third writable segment, mapped past everything else from bytes after the tables. */
const TRAIL_OFFSET = 0x32000;
const TRAIL_SIZE = 0x2000;
const TRAIL_VADDR = 0x400000;
const NEW_BUN_VADDR = 0x900000;

const SECTION_NAMES = ['', '.shstrtab', '.data', '.bun'];

/** The pointer where it is on 2.1.314 linux-x64: aligned to 8, 8040 bytes past a 16 KiB boundary. */
const POINTER = Math.ceil(MAIN_VADDR / STRIDE) * STRIDE + 8040;

/**
 * An ELF64 with program headers [RELRO (RW), main (RW)] and `.bun` inside main. `pointers` are
 * the addresses holding `.bun`'s address; `relroFlags` and `mainFlags` set the two segments'
 * `p_flags`, and `trailing` adds a third writable segment after them, carrying `trailingPointer`.
 */
function buildElf(
  pointers: number[],
  {
    relroFlags = PF_RW,
    mainFlags = PF_RW,
    trailing = false,
    trailingPointer,
  }: { relroFlags?: number; mainFlags?: number; trailing?: boolean; trailingPointer?: number } = {},
): Buffer {
  const shstrtab = Buffer.from(SECTION_NAMES.join('\0') + '\0', 'utf8');
  const nameOffsets = new Map<string, number>();
  let at = 0;
  for (const name of SECTION_NAMES) {
    nameOffsets.set(name, at);
    at += name.length + 1;
  }
  const shstrOffset = SHOFF + 4 * 64;
  const buf = Buffer.alloc(trailing ? TRAIL_OFFSET + TRAIL_SIZE : shstrOffset + shstrtab.length, 0);

  buf.writeUInt32LE(0x464c457f, 0);
  buf[4] = 2;
  buf[5] = 1;
  buf.writeBigUInt64LE(BigInt(PHOFF), 0x20);
  buf.writeBigUInt64LE(BigInt(SHOFF), 0x28);
  buf.writeUInt16LE(PHENTSIZE, 0x36);
  buf.writeUInt16LE(trailing ? 3 : 2, 0x38);
  buf.writeUInt16LE(64, 0x3a);
  buf.writeUInt16LE(4, 0x3c);
  buf.writeUInt16LE(1, 0x3e);

  const load = (index: number, flags: number, offset: number, size: number, vaddr = offset + LOAD_BIAS) => {
    const base = PHOFF + index * PHENTSIZE;
    buf.writeUInt32LE(1, base);
    buf.writeUInt32LE(flags, base + 4);
    buf.writeBigUInt64LE(BigInt(offset), base + 8);
    buf.writeBigUInt64LE(BigInt(vaddr), base + 16);
    buf.writeBigUInt64LE(BigInt(size), base + 32);
    buf.writeBigUInt64LE(BigInt(size), base + 40);
  };
  load(0, relroFlags, RELRO_OFFSET, RELRO_SIZE);
  load(1, mainFlags, MAIN_OFFSET, MAIN_SIZE);
  if (trailing) {
    load(2, PF_RW, TRAIL_OFFSET, TRAIL_SIZE, TRAIL_VADDR);
    buf.fill(0xcc, TRAIL_OFFSET, TRAIL_OFFSET + TRAIL_SIZE);
  }

  const section = (index: number, name: string, addr: number, offset: number, size: number) => {
    const base = SHOFF + index * 64;
    buf.writeUInt32LE(nameOffsets.get(name)!, base);
    buf.writeBigUInt64LE(BigInt(addr), base + 16);
    buf.writeBigUInt64LE(BigInt(offset), base + 24);
    buf.writeBigUInt64LE(BigInt(size), base + 32);
  };
  section(1, '.shstrtab', 0, shstrOffset, shstrtab.length);
  section(2, '.data', MAIN_VADDR, MAIN_OFFSET, BUN_OFFSET - MAIN_OFFSET);
  section(3, '.bun', BUN_VADDR, BUN_OFFSET, BUN_SIZE);
  shstrtab.copy(buf, shstrOffset);

  buf.fill(0xbb, RELRO_OFFSET, RELRO_OFFSET + RELRO_SIZE);
  buf.fill(0xaa, MAIN_OFFSET, MAIN_OFFSET + MAIN_SIZE);
  for (const vaddr of pointers) buf.writeBigUInt64LE(BigInt(BUN_VADDR), vaddr - LOAD_BIAS);
  if (trailingPointer !== undefined) {
    buf.writeBigUInt64LE(BigInt(BUN_VADDR), TRAIL_OFFSET + (trailingPointer - TRAIL_VADDR));
  }
  return buf;
}

const flagsOf = (buf: Buffer, index: number) => buf.readUInt32LE(PHOFF + index * PHENTSIZE + 4);
const read8 = (buf: Buffer, vaddr: number) => buf.readBigUInt64LE(vaddr - LOAD_BIAS);

/**
 * tweakcc 4.3.3's `repackELFSection`, reduced to the part that touches these bytes: take the FIRST
 * PT_LOAD whose `p_flags` carry PF_W, as read from the file, scan it at 16 KiB strides for `.bun`'s
 * address, and throw like it does when nothing turns up. Otherwise rewrite the eight bytes it found
 * and record `.bun`'s new address. Returns the address it rewrote.
 */
function tweakccRepack(file: string): number {
  const buf = readFileSync(file);
  let first: { offset: number; vaddr: number; size: number } | null = null;
  for (let i = 0; i < buf.readUInt16LE(0x38); i++) {
    const base = PHOFF + i * PHENTSIZE;
    if (buf.readUInt32LE(base) === 1 && (buf.readUInt32LE(base + 4) & 2) !== 0) {
      first = {
        offset: Number(buf.readBigUInt64LE(base + 8)),
        vaddr: Number(buf.readBigUInt64LE(base + 16)),
        size: Number(buf.readBigUInt64LE(base + 32)),
      };
      break;
    }
  }
  if (!first) throw new Error('No writable ELF PT_LOAD segment found');
  const bunAddr = buf.readBigUInt64LE(SHOFF + 3 * 64 + 16);
  for (let vaddr = Math.ceil(first.vaddr / STRIDE) * STRIDE; vaddr <= first.vaddr + first.size - 8; vaddr += STRIDE) {
    const at = first.offset + (vaddr - first.vaddr);
    if (buf.readBigUInt64LE(at) === bunAddr) {
      buf.writeBigUInt64LE(BigInt(NEW_BUN_VADDR), at);
      buf.writeBigUInt64LE(BigInt(NEW_BUN_VADDR), SHOFF + 3 * 64 + 16);
      writeFileSync(file, buf);
      return vaddr;
    }
  }
  throw new Error(`Could not find original BUN_COMPILED location in binary (searched for 0x${bunAddr.toString(16)})`);
}

describe('the Bun blob pointer stand-in when a RELRO segment comes first', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clodex-bun-relro-'));
    file = path.join(dir, 'claude');
  });
  afterEach(() => {
    droppedWrite.atPosition = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reproduces the 2.1.314 glibc failure without the shim', () => {
    writeFileSync(file, buildElf([POINTER]));
    expect(() => tweakccRepack(file)).toThrow('Could not find original BUN_COMPILED location');
  });

  it('points tweakcc at .bun\'s segment and publishes the RELRO segment as it was', () => {
    const pristine = buildElf([POINTER]);
    writeFileSync(file, pristine);

    const shim = shimBunCompiledPointer(file);

    expect(shim).not.toBeNull();
    expect(shim!.pointerVaddr).toBe(BigInt(POINTER));
    expect(shim!.hiddenLoads.map(load => load.index)).toEqual([0]);
    expect(flagsOf(readFileSync(file), 0), 'tweakcc must see the RELRO segment as read-only').toBe(PF_RW & ~2);

    const rewrote = tweakccRepack(file);
    expect(rewrote, 'tweakcc must land on the stand-in in .bun\'s segment').toBe(Number(shim!.standIn!.vaddr));
    restoreBunCompiledPointer(file, shim!);

    const published = readFileSync(file);
    expect(flagsOf(published, 0)).toBe(PF_RW);
    expect(flagsOf(published, 1)).toBe(PF_RW);
    expect(read8(published, POINTER)).toBe(BigInt(NEW_BUN_VADDR));
    // Everything outside the global and `.bun`'s recorded address is the pristine bytes.
    const expected = Buffer.from(pristine);
    expected.writeBigUInt64LE(BigInt(NEW_BUN_VADDR), POINTER - LOAD_BIAS);
    expected.writeBigUInt64LE(BigInt(NEW_BUN_VADDR), SHOFF + 3 * 64 + 16);
    expect(published.equals(expected)).toBe(true);
  });

  it('still hides the RELRO segment when tweakcc can reach the pointer unaided', () => {
    const aligned = Math.ceil(MAIN_VADDR / STRIDE) * STRIDE;
    writeFileSync(file, buildElf([aligned]));

    const shim = shimBunCompiledPointer(file);

    expect(shim).not.toBeNull();
    expect(shim!.standIn).toBeNull();
    expect(tweakccRepack(file)).toBe(aligned);
    restoreBunCompiledPointer(file, shim!);
    const published = readFileSync(file);
    expect(flagsOf(published, 0)).toBe(PF_RW);
    expect(read8(published, aligned)).toBe(BigInt(NEW_BUN_VADDR));
  });

  it('refuses when the repack did not rewrite the pointer it was pointed at', () => {
    const aligned = Math.ceil(MAIN_VADDR / STRIDE) * STRIDE;
    writeFileSync(file, buildElf([aligned]));
    const shim = shimBunCompiledPointer(file)!;
    // `.bun` moved, the global did not.
    const buf = readFileSync(file);
    buf.writeBigUInt64LE(BigInt(NEW_BUN_VADDR), SHOFF + 3 * 64 + 16);
    writeFileSync(file, buf);

    expect(() => restoreBunCompiledPointer(file, shim))
      .toThrow("the repack did not point Bun's blob pointer at where it put .bun");
  });

  it('leaves a RELRO segment that is already read-only alone', () => {
    writeFileSync(file, buildElf([POINTER], { relroFlags: 4 }));

    const shim = shimBunCompiledPointer(file);

    expect(shim!.hiddenLoads).toEqual([]);
    tweakccRepack(file);
    restoreBunCompiledPointer(file, shim!);
    expect(flagsOf(readFileSync(file), 0)).toBe(4);
  });

  it('counts a copy in the RELRO segment as a second candidate', () => {
    const inRelro = Math.ceil(RELRO_VADDR / 8) * 8 + 0x100;
    writeFileSync(file, buildElf([POINTER, inRelro]));
    const before = readFileSync(file);

    expect(() => shimBunCompiledPointer(file)).toThrow('2 aligned candidates in the writable segments');
    expect(readFileSync(file).equals(before), 'a refusal must leave the binary untouched').toBe(true);
  });

  it('refuses a pointer that lives only in the RELRO segment, which tweakcc will not rewrite', () => {
    const inRelro = Math.ceil(RELRO_VADDR / 8) * 8 + 0x100;
    writeFileSync(file, buildElf([inRelro]));
    const before = readFileSync(file);

    expect(() => shimBunCompiledPointer(file)).toThrow('not in the writable segment that holds .bun');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses to restore flags onto a segment the repack moved', () => {
    writeFileSync(file, buildElf([POINTER]));
    const shim = shimBunCompiledPointer(file)!;
    tweakccRepack(file);
    const buf = readFileSync(file);
    buf.writeBigUInt64LE(BigInt(RELRO_VADDR + 0x1000), PHOFF + 16);
    writeFileSync(file, buf);

    expect(() => restoreBunCompiledPointer(file, shim))
      .toThrow(`the repack moved or rewrote the write-protected ELF segment at 0x${RELRO_VADDR.toString(16)}`);
  });

  /** Overwrite one program-header field of the file on disk. */
  const pokeHeader = (index: number, field: 'type' | 'flags' | 'offset' | 'vaddr' | 'filesz', value: number) => {
    const at = PHOFF + index * PHENTSIZE + { type: 0, flags: 4, offset: 8, vaddr: 16, filesz: 32 }[field];
    const buf = readFileSync(file);
    if (field === 'type' || field === 'flags') buf.writeUInt32LE(value, at);
    else buf.writeBigUInt64LE(BigInt(value), at);
    writeFileSync(file, buf);
  };

  it.each([
    ['its type', 'type', 4],
    ['its file offset', 'offset', RELRO_OFFSET + 0x10],
    ['its flags, write bit and all', 'flags', PF_RW],
  ] as const)('refuses to restore flags onto a segment the repack changed %s for', (_label, field, value) => {
    writeFileSync(file, buildElf([POINTER]));
    const shim = shimBunCompiledPointer(file)!;
    tweakccRepack(file);
    pokeHeader(0, field, value);

    expect(() => restoreBunCompiledPointer(file, shim))
      .toThrow(`the repack moved or rewrote the write-protected ELF segment at 0x${RELRO_VADDR.toString(16)}`);
  });

  it('refuses when the write bit does not read back', () => {
    writeFileSync(file, buildElf([POINTER]));
    const shim = shimBunCompiledPointer(file)!;
    tweakccRepack(file);
    droppedWrite.atPosition = PHOFF + 4;

    expect(() => restoreBunCompiledPointer(file, shim))
      .toThrow('a write-protected ELF segment did not get its write bit back');
  });

  describe('refuses when no single writable segment holds .bun', () => {
    it('when .bun is in no writable segment at all', () => {
      writeFileSync(file, buildElf([POINTER], { mainFlags: 4 }));
      const before = readFileSync(file);
      expect(() => shimBunCompiledPointer(file))
        .toThrow('no single writable ELF segment holds the .bun section');
      expect(readFileSync(file).equals(before)).toBe(true);
    });

    it('when .bun starts exactly where its segment ends', () => {
      writeFileSync(file, buildElf([POINTER]));
      pokeHeader(1, 'filesz', BUN_OFFSET - MAIN_OFFSET);
      expect(() => shimBunCompiledPointer(file))
        .toThrow('no single writable ELF segment holds the .bun section');
    });

    it('when two writable segments both claim it', () => {
      writeFileSync(file, buildElf([POINTER]));
      pokeHeader(0, 'filesz', BUN_OFFSET + BUN_SIZE - RELRO_OFFSET);
      expect(() => shimBunCompiledPointer(file))
        .toThrow('no single writable ELF segment holds the .bun section');
    });
  });

  it('leaves an ELF with no writable segment alone', () => {
    writeFileSync(file, buildElf([POINTER], { relroFlags: 4, mainFlags: 4 }));
    const before = readFileSync(file);
    expect(shimBunCompiledPointer(file)).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('hides only the writable segments ahead of .bun\'s, not one after it', () => {
    writeFileSync(file, buildElf([POINTER], { trailing: true }));

    const shim = shimBunCompiledPointer(file)!;

    expect(shim.hiddenLoads.map(load => load.index)).toEqual([0]);
    expect(flagsOf(readFileSync(file), 2)).toBe(PF_RW);
  });

  it('refuses a pointer that lives only in a writable segment after .bun\'s', () => {
    const inTrail = TRAIL_VADDR + 0x100;
    writeFileSync(file, buildElf([], { trailing: true, trailingPointer: inTrail }));
    const before = readFileSync(file);

    expect(() => shimBunCompiledPointer(file)).toThrow('not in the writable segment that holds .bun');
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
