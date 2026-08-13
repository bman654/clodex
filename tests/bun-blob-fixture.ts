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
}

export interface BunBlobOptions {
  entryPointId?: number;
  structBytes?: 52 | 36;
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
    entryNameLengthDelta = 0,
    entryNameOutOfBounds = false,
  }: BunBlobOptions = {},
): Buffer {
  const stringsPerModule = structBytes === 52 ? 6 : 4;
  const strings: Buffer[] = [];
  for (const module of modules) {
    strings.push(Buffer.from(module.name));
    strings.push(Buffer.from(module.contents ?? ''));
    // sourcemap, bytecode (+ moduleInfo, bytecodeOriginPath) — empty here.
    for (let field = 2; field < stringsPerModule; field++) strings.push(Buffer.alloc(0));
  }

  const pointers: { offset: number; length: number }[] = [];
  let cursor = 0;
  for (const value of strings) {
    pointers.push({ offset: cursor, length: value.length });
    cursor += value.length + 1;
  }
  const modulesOffset = cursor;
  const modulesLength = modules.length * structBytes;
  cursor += modulesLength;
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
    blob.writeUInt8(1, at + 1); // loader
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
  blob.writeUInt32LE(0, at); // flags
  BUN_TRAILER.copy(blob, trailerOffset);
  return blob;
}

export interface ParsedBunBlob {
  names: string[];
  contents: string[];
  entryPointId: number;
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
  const structBytes = modulesLength % 36 === 0 && modulesLength % 52 !== 0 ? 36 : 52;

  const names: string[] = [];
  const contents: string[] = [];
  for (let module = 0; module < modulesLength / structBytes; module++) {
    const at = blobAt + modulesOffset + module * structBytes;
    const read = (field: number) => {
      const offset = binary.readUInt32LE(at + field * 8);
      const length = binary.readUInt32LE(at + field * 8 + 4);
      return binary.subarray(blobAt + offset, blobAt + offset + length).toString('utf8');
    };
    names.push(read(0));
    contents.push(read(1));
  }
  return { names, contents, entryPointId };
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

/** Rebuild a fake install around new module contents, the way a repack does. */
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
    })),
    { entryPointId: parsed.entryPointId },
  );
}
