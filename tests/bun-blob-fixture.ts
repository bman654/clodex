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
