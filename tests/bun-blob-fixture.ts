// A synthetic Bun data blob, laid out exactly as Bun (and tweakcc's repack) writes it:
// NUL-terminated strings, then the module structs, then the exec-argv string, then the 32-byte
// offsets struct, then the trailer.
//
// Not a *.test.ts, so vitest's `include: ['tests/**/*.test.ts']` never collects it as a suite.
//
// Verified against the real layout: the module names, entry-point id, struct size and header form
// this produces match what a real Claude Code 2.1.231 binary carries.

export const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');

/** An arm64 Mach-O binary starts with these four bytes. */
export const MACHO_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

export interface BunModuleFixture {
  name: string;
  /** The module's payload. Only the entry module's is ever read as the bundle. */
  contents?: string;
  /**
   * The module's source map. Empty on every real build measured, but the mirror of tweakcc's
   * repack counts it, and a fixture that cannot vary it cannot see the mirror stop reading it.
   */
  sourcemap?: string;
  /** Cached JSC bytecode, which a patched module must not be left carrying. */
  bytecode?: string;
  /** JSC module info, which travels with the bytecode. */
  moduleInfo?: string;
  /**
   * The path the bytecode cache was generated under. Non-empty on almost every module of a real
   * build — 1,404 of 1,582 on 2.1.246 — so a fixture that always leaves it empty cannot see an
   * arithmetic mirror of the repack that forgets it.
   */
  bytecodeOriginPath?: string;
  /**
   * Bun's loader id. `1` is JavaScript and is the default; real binaries also carry `5` (vendored
   * text assets like `mermaid.min.js`) and `10` (napi `*.node` modules). Those are NOT part of the
   * bundle, so `readBunJavaScriptModules` skips them — which means blob-table positions and
   * positions within the bundle are different numbers, and a fixture with only JavaScript in it
   * cannot tell the two apart.
   */
  loader?: number;
}

export interface BunBlobOptions {
  entryPointId?: number;
  structBytes?: 52 | 36;
  /**
   * The blob's `flags` word. Bun 1.4.1 uses bits 5-7 to announce the structures written after the
   * module table, which the options below fill in; bit 4 is `SOURCE_TEXT_CONTIGUOUS`.
   */
  flags?: number;
  /** A `[u32; modules]` of source hashes after the module table (Bun's `HAS_SOURCE_HASHES`). */
  sourceHashes?: number[];
  /**
   * The shared bytecode string table every chunk's compiled form references by ordinal. Stored
   * among the payloads and addressed by a `{ offset, length }` pair after the module table — a
   * region no module struct points at, which is exactly what a rebuild of the blob loses.
   */
  bytecodeStringTable?: string;
  /** Corrupt the entry name's recorded length, to exercise the parser's guards. */
  entryNameLengthDelta?: number;
  /** Point the entry name outside the blob, to exercise the bounds guard. */
  entryNameOutOfBounds?: boolean;
}

export function buildBunBlob(
  modules: BunModuleFixture[],
  {
    entryPointId = 0,
    structBytes = 52,
    flags = 0,
    sourceHashes,
    bytecodeStringTable,
    entryNameLengthDelta = 0,
    entryNameOutOfBounds = false,
  }: BunBlobOptions = {},
): Buffer {
  const stringsPerModule = structBytes === 52 ? 6 : 4;
  const strings: Buffer[] = [];
  for (const module of modules) {
    strings.push(Buffer.from(module.name));
    strings.push(Buffer.from(module.contents ?? ''));
    strings.push(Buffer.from(module.sourcemap ?? ''));
    strings.push(Buffer.from(module.bytecode ?? ''));
    if (stringsPerModule === 6) {
      strings.push(Buffer.from(module.moduleInfo ?? ''));
      strings.push(Buffer.from(module.bytecodeOriginPath ?? ''));
    }
  }

  const pointers: { offset: number; length: number }[] = [];
  let cursor = 0;
  for (const value of strings) {
    pointers.push({ offset: cursor, length: value.length });
    cursor += value.length + 1;
  }
  // The shared bytecode string table is an ordinary payload region — with no module struct
  // pointing at it, which is what makes it invisible to anything that rebuilds the blob.
  const stringTable = bytecodeStringTable === undefined
    ? null
    : { offset: cursor, length: Buffer.byteLength(bytecodeStringTable) };
  if (stringTable !== null) cursor += stringTable.length + 1;
  const modulesOffset = cursor;
  const modulesLength = modules.length * structBytes;
  cursor += modulesLength;
  // Bun's tail structures, in the order `to_bytes` writes them: the source hashes, the
  // builtin-bytecode table (a count of zero here), then the string table's pointer.
  const hashesOffset = cursor;
  if (sourceHashes) cursor += modules.length * 4;
  const builtinOffset = cursor;
  if (stringTable !== null) cursor += 4;
  const stringTablePointerOffset = cursor;
  if (stringTable !== null) cursor += 8;
  const argvOffset = cursor;
  cursor += 1;
  const offsetsOffset = cursor;
  cursor += 32;
  const trailerOffset = cursor;
  cursor += BUN_TRAILER.length;

  const blob = Buffer.alloc(cursor);
  strings.forEach((value, index) => {
    value.copy(blob, pointers[index]!.offset);
    blob[pointers[index]!.offset + value.length] = 0;
  });
  if (stringTable !== null) {
    blob.write(bytecodeStringTable!, stringTable.offset);
    blob[stringTable.offset + stringTable.length] = 0;
  }
  if (sourceHashes) {
    sourceHashes.forEach((hash, index) => blob.writeUInt32LE(hash, hashesOffset + index * 4));
  }
  if (stringTable !== null) {
    blob.writeUInt32LE(0, builtinOffset); // no ahead-of-time bytecode for builtin modules
    blob.writeUInt32LE(stringTable.offset, stringTablePointerOffset);
    blob.writeUInt32LE(stringTable.length, stringTablePointerOffset + 4);
  }
  for (let module = 0; module < modules.length; module++) {
    let at = modulesOffset + module * structBytes;
    for (let field = 0; field < stringsPerModule; field++) {
      const pointer = pointers[module * stringsPerModule + field]!;
      const isEntryName = field === 0 && module === entryPointId;
      // `cursor` is the whole blob, so this points at the first byte past it.
      blob.writeUInt32LE(isEntryName && entryNameOutOfBounds ? cursor : pointer.offset, at);
      blob.writeUInt32LE(pointer.length + (isEntryName ? entryNameLengthDelta : 0), at + 4);
      at += 8;
    }
    blob.writeUInt8(1, at); // encoding
    blob.writeUInt8(modules[module]!.loader ?? 1, at + 1); // loader
    blob.writeUInt8(2, at + 2); // moduleFormat
    blob.writeUInt8(0, at + 3); // side
  }
  let at = offsetsOffset;
  blob.writeBigUInt64LE(BigInt(offsetsOffset), at);
  at += 8;
  blob.writeUInt32LE(modulesOffset, at);
  blob.writeUInt32LE(modulesLength, at + 4);
  at += 8;
  blob.writeUInt32LE(entryPointId, at);
  at += 4;
  blob.writeUInt32LE(argvOffset, at);
  blob.writeUInt32LE(0, at + 4);
  at += 8;
  blob.writeUInt32LE(flags, at);
  BUN_TRAILER.copy(blob, trailerOffset);
  return blob;
}

export interface ParsedBunBlob {
  names: string[];
  contents: string[];
  sourcemap: string[];
  bytecode: string[];
  moduleInfo: string[];
  bytecodeOriginPath: string[];
  loaders: number[];
  /** 52 or 36 — a rebuild that dropped it would silently promote a legacy blob to the new format. */
  structBytes: 52 | 36;
  entryPointId: number;
  /**
   * Carried through a rebuild verbatim, exactly as tweakcc carries it — which is what makes the
   * loss lethal rather than merely wasteful: the flags go on promising structures the rebuild
   * dropped, and Bun reads what is no longer there.
   */
  flags: number;
}

/**
 * Read a blob back. Used by the tweakcc stand-in to answer `readContent`/`writeContent` the way
 * tweakcc does — by module name — so a test that removes the shim sees tweakcc's real failure.
 */
export function parseBunBlob(binary: Buffer): ParsedBunBlob {
  const trailerAt = binary.lastIndexOf(BUN_TRAILER);
  if (trailerAt < 0) throw new Error('no Bun trailer in fixture');
  const offsetsAt = trailerAt - 32;
  const blobAt = offsetsAt - Number(binary.readBigUInt64LE(offsetsAt));
  const modulesOffset = binary.readUInt32LE(offsetsAt + 8);
  const modulesLength = binary.readUInt32LE(offsetsAt + 12);
  const entryPointId = binary.readUInt32LE(offsetsAt + 16);
  const flags = binary.readUInt32LE(offsetsAt + 28);
  const structBytes = modulesLength % 36 === 0 && modulesLength % 52 !== 0 ? 36 : 52;

  const names: string[] = [];
  const contents: string[] = [];
  const sourcemap: string[] = [];
  const bytecode: string[] = [];
  const moduleInfo: string[] = [];
  const bytecodeOriginPath: string[] = [];
  const loaders: number[] = [];
  for (let module = 0; module < modulesLength / structBytes; module++) {
    const at = blobAt + modulesOffset + module * structBytes;
    const read = (field: number) => {
      const offset = binary.readUInt32LE(at + field * 8);
      const length = binary.readUInt32LE(at + field * 8 + 4);
      return binary.subarray(blobAt + offset, blobAt + offset + length).toString('utf8');
    };
    names.push(read(0));
    contents.push(read(1));
    sourcemap.push(read(2));
    bytecode.push(read(3));
    moduleInfo.push(structBytes === 52 ? read(4) : '');
    bytecodeOriginPath.push(structBytes === 52 ? read(5) : '');
    loaders.push(binary.readUInt8(at + structBytes - 3));
  }
  return {
    names,
    contents,
    sourcemap,
    bytecode,
    moduleInfo,
    bytecodeOriginPath,
    loaders,
    entryPointId,
    flags,
    structBytes,
  };
}

/**
 * A stand-in for a native Claude Code install: a shell script that answers `--version` (the patcher
 * probes the real binary this way) followed by the blob. `sh` exits before reaching the blob bytes.
 */
export function buildFakeNativeClaude(
  version: string,
  modules: BunModuleFixture[],
  options: BunBlobOptions = {},
): Buffer {
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexit 1\n`;
  return Buffer.concat([Buffer.from(script), buildBunBlob(modules, options)]);
}

/**
 * Rebuild a fake install around new module contents, the way tweakcc's repack does: from the
 * per-module `{ offset, length }` pairs and nothing else. Every offset is renumbered, and anything
 * the module structs do not describe — Bun 1.4.1's source hashes, its builtin-bytecode table and
 * its shared bytecode string table — is gone. That loss is the whole reason clodex publishes its
 * own blob over the result.
 */
export function rebuildFakeNativeClaude(
  binary: Buffer,
  version: string,
  contentsByIndex: (index: number, previous: string) => string,
): Buffer {
  const parsed = parseBunBlob(binary);
  return buildFakeNativeClaude(
    version,
    parsed.names.map((name, index) => ({
      name,
      contents: contentsByIndex(index, parsed.contents[index]!),
      sourcemap: parsed.sourcemap[index]!,
      bytecode: parsed.bytecode[index]!,
      moduleInfo: parsed.moduleInfo[index]!,
      bytecodeOriginPath: parsed.bytecodeOriginPath[index]!,
      loader: parsed.loaders[index]!,
    })),
    // `structBytes` is carried because tweakcc's repack carries it: a rebuild that dropped it would
    // silently promote a 36-byte blob to the 52-byte format and pass for the wrong reason.
    { entryPointId: parsed.entryPointId, flags: parsed.flags, structBytes: parsed.structBytes },
  );
}

// ---------------------------------------------------------------------------------------------
// An ELF64 wrapper for the blob above, so the `clodex patch` write path can be driven end to end
// on the one executable format that needs the Bun blob-pointer stand-in.
//
// A Mach-O or PE candidate never reaches `src/bun-compiled-pointer.ts` — only ELF relocates the
// blob and rewrites the global that points at it. Every other fake install here starts with a
// `#!/bin/sh` shim, so `readElfLayout` returns null and the stand-in is a silent no-op; a fixture
// that cannot produce ELF bytes cannot see the production wiring get deleted.
// ---------------------------------------------------------------------------------------------

/** Where the writable PT_LOAD starts, at a deliberately un-16K-aligned address, as real builds do. */
const ELF_SEG_OFFSET = 0x1000;
/** The lowest address tweakcc's 16 KiB-strided scan visits inside that segment. */
export const ELF_FIRST_SCANNED = 0x4000;
/** Where the Bun blob-pointer global sits — off the boundary, as on every 2.1.257 ELF build. */
export const ELF_POINTER_VADDR = ELF_FIRST_SCANNED + 0x758;
const ELF_BUN_AT = 0x8000;
const ELF_SECTION_NAMES = ['', '.shstrtab', '.bun'];

function elfSectionHeaders(bunAddr: number, bunOffset: number, bunSize: number, shoff: number): Buffer {
  const shstrtab = Buffer.from(`${ELF_SECTION_NAMES.join('\0')}\0`, 'utf8');
  const nameOffsets = new Map<string, number>();
  let cursor = 0;
  for (const name of ELF_SECTION_NAMES) {
    nameOffsets.set(name, cursor);
    cursor += name.length + 1;
  }
  const table = Buffer.alloc(3 * 64 + shstrtab.length);
  const write = (index: number, name: string, addr: number, offset: number, size: number) => {
    const at = index * 64;
    table.writeUInt32LE(nameOffsets.get(name)!, at);
    table.writeBigUInt64LE(BigInt(addr), at + 16);
    table.writeBigUInt64LE(BigInt(offset), at + 24);
    table.writeBigUInt64LE(BigInt(size), at + 32);
  };
  write(1, '.shstrtab', 0, shoff + 3 * 64, shstrtab.length);
  write(2, '.bun', bunAddr, bunOffset, bunSize);
  shstrtab.copy(table, 3 * 64);
  return table;
}

/**
 * A native install shaped like a Linux Claude Code build: an ELF64 whose writable segment holds
 * the Bun blob-pointer global at an address tweakcc's scan never visits, followed by the blob
 * itself in a `.bun` section.
 */
export function buildFakeElfClaude(modules: BunModuleFixture[], options: BunBlobOptions = {}): Buffer {
  const blob = buildBunBlob(modules, options);
  const bunOffset = ELF_BUN_AT;
  const segmentSize = bunOffset - ELF_SEG_OFFSET + blob.length;
  const shoff = bunOffset + blob.length;
  const buf = Buffer.alloc(shoff + 3 * 64 + 64);

  buf.writeUInt32LE(0x464c457f, 0);
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // ELFDATA2LSB
  buf.writeBigUInt64LE(0x40n, 0x20); // e_phoff
  buf.writeBigUInt64LE(BigInt(shoff), 0x28); // e_shoff
  buf.writeUInt16LE(56, 0x36);
  buf.writeUInt16LE(1, 0x38); // one program header
  buf.writeUInt16LE(64, 0x3a);
  buf.writeUInt16LE(3, 0x3c); // three section headers
  buf.writeUInt16LE(1, 0x3e); // .shstrtab index

  buf.writeUInt32LE(1, 0x40); // PT_LOAD
  buf.writeUInt32LE(6, 0x44); // R|W
  buf.writeBigUInt64LE(BigInt(ELF_SEG_OFFSET), 0x48);
  buf.writeBigUInt64LE(BigInt(ELF_SEG_OFFSET), 0x50); // vaddr == offset
  buf.writeBigUInt64LE(BigInt(segmentSize), 0x60);

  // Filler that can never be read as an address, then the global, then the blob.
  buf.fill(0xaa, ELF_SEG_OFFSET, bunOffset);
  buf.writeBigUInt64LE(BigInt(ELF_BUN_AT), ELF_POINTER_VADDR);
  blob.copy(buf, bunOffset);
  elfSectionHeaders(ELF_BUN_AT, bunOffset, blob.length, shoff).copy(buf, shoff);
  return buf;
}

/**
 * What tweakcc's `repackELFSection` does to that binary: scan the writable segment at a 16384-byte
 * stride for the address `.bun` currently has, rewrite the eight bytes it finds to `.bun`'s new
 * address, and record the section there. It never looks anywhere else — which is the whole reason
 * `shimBunCompiledPointer` exists.
 *
 * Throws the way tweakcc throws when the scan comes up empty, so a fixture that stops reproducing
 * the 2.1.257 failure fails loudly instead of passing for the wrong reason.
 */
export function repackFakeElfClaude(
  binary: Buffer,
  contentsByIndex: (index: number, previous: string) => string,
  newBunAddr: number,
): Buffer {
  const segmentOffset = Number(binary.readBigUInt64LE(0x48));
  const segmentVaddr = Number(binary.readBigUInt64LE(0x50));
  const segmentSize = Number(binary.readBigUInt64LE(0x60));
  const shoff = Number(binary.readBigUInt64LE(0x28));
  const bunAddr = Number(binary.readBigUInt64LE(shoff + 2 * 64 + 16));

  const needle = Buffer.alloc(8);
  needle.writeBigUInt64LE(BigInt(bunAddr));
  let foundAt = -1;
  const first = Math.ceil(segmentVaddr / 16384) * 16384;
  for (let vaddr = first; vaddr <= segmentVaddr + segmentSize - 8; vaddr += 16384) {
    const at = segmentOffset + (vaddr - segmentVaddr);
    if (binary.subarray(at, at + 8).equals(needle)) { foundAt = at; break; }
  }
  if (foundAt < 0) {
    throw new Error(`Could not find original BUN_COMPILED location in binary (searched for 0x${bunAddr.toString(16)})`);
  }

  const parsed = parseBunBlob(binary);
  const blob = buildBunBlob(
    parsed.names.map((name, index) => ({
      name,
      contents: contentsByIndex(index, parsed.contents[index]!),
      sourcemap: parsed.sourcemap[index]!,
      bytecode: parsed.bytecode[index]!,
      moduleInfo: parsed.moduleInfo[index]!,
      bytecodeOriginPath: parsed.bytecodeOriginPath[index]!,
      loader: parsed.loaders[index]!,
    })),
    { entryPointId: parsed.entryPointId, flags: parsed.flags, structBytes: parsed.structBytes },
  );

  // The blob keeps its file position; only its recorded address moves, which is all the restore
  // reads. Growing the file where the real repack does would add nothing this test can observe.
  const bunOffset = Number(binary.readBigUInt64LE(shoff + 2 * 64 + 24));
  const grown = bunOffset + blob.length;
  const out = Buffer.alloc(grown + 3 * 64 + 64);
  binary.subarray(0, bunOffset).copy(out, 0);
  blob.copy(out, bunOffset);
  out.writeBigUInt64LE(BigInt(grown), 0x28);
  out.writeBigUInt64LE(BigInt(bunOffset - segmentOffset + blob.length), 0x60);
  out.writeBigUInt64LE(BigInt(newBunAddr), foundAt);
  elfSectionHeaders(newBunAddr, bunOffset, blob.length, grown).copy(out, grown);
  return out;
}
