import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listBunModuleNames,
  readBunModuleTable,
  tweakccRecognizesModuleName,
} from '../src/bun-module-table.js';
import { buildBunBlob, BUN_TRAILER, type BunBlobOptions } from './bun-blob-fixture.js';

function withBinary(bytes: Buffer, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'clodex-bun-table-'));
  try {
    const path = join(dir, 'claude');
    writeFileSync(path, bytes);
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NAMES = [
  '/$bunfs/root/cli', '/$bunfs/root/image-processor.js', '/$bunfs/root/mermaid.min.js',
];

function binaryWithNames(names: string[], options: BunBlobOptions = {}): Buffer {
  return Buffer.concat([
    Buffer.from('not-a-real-executable-header'.repeat(8)),
    buildBunBlob(names.map(name => ({ name })), options),
    // An escaped name pointer lands on printable bytes, not arbitrary zeros.
    Buffer.from('pretend-code-sig\0' + 'nature'.repeat(16)),
  ]);
}

describe('Bun module table reader', () => {
  it('reads the renamed entry and siblings without modifying the binary', () => {
    const bytes = Buffer.concat([Buffer.from('container'), buildBunBlob([
      { name: '/$bunfs/root/chunk.js', contents: 'export const x = 1' },
      { name: '/$bunfs/root/cli', contents: 'import "./chunk.js"' },
      { name: '/$bunfs/root/image-processor.node', contents: 'native helper', loader: 10 },
    ], { entryPointId: 1 }), Buffer.alloc(1_500_000, 0x41)]);
    withBinary(bytes, path => {
      expect(listBunModuleNames(path)).toEqual([
        '/$bunfs/root/chunk.js', '/$bunfs/root/cli', '/$bunfs/root/image-processor.node',
      ]);
      expect(readBunModuleTable(path)?.entryPointId).toBe(1);
      expect(readFileSync(path)).toEqual(bytes);
    });
  });

  it('reads a legacy 36-byte module struct', () => {
    withBinary(binaryWithNames(NAMES, { structBytes: 36 }), path => {
      expect(readBunModuleTable(path)).toMatchObject({
        names: NAMES, entryPointId: 0, structBytes: 36,
      });
    });
  });

  // Real binaries carry a large code signature after the trailer; Bun's runtime also embeds a
  // decoy trailer, and a shrinking repack can strand a stale trailer after the live one.
  describe('inside a realistic container', () => {
    const blob = () => buildBunBlob(NAMES.map(name => ({ name })));

    it('finds the blob beneath a code signature much larger than a page', () => {
      withBinary(Buffer.concat([blob(), Buffer.alloc(1_500_000, 0x41)]), path => {
        expect(listBunModuleNames(path)).toEqual(NAMES);
      });
    });

    it('ignores a decoy trailer ahead of the live blob', () => {
      withBinary(Buffer.concat([
        Buffer.from('runtime strings: '), BUN_TRAILER, Buffer.alloc(4096, 0x42),
        blob(), Buffer.alloc(2048, 0x43),
      ]), path => {
        expect(readBunModuleTable(path)).toMatchObject({ names: NAMES, entryPointId: 0 });
      });
    });

    it('skips a stale trailer left after a shrinking repack', () => {
      const live = blob();
      const staleTail = live.subarray(live.length - (32 + BUN_TRAILER.length));
      withBinary(Buffer.concat([live, Buffer.from('LEFT!'), staleTail, Buffer.alloc(1024, 0x44)]), path => {
        expect(readBunModuleTable(path)).toMatchObject({ names: NAMES, entryPointId: 0 });
      });
    });
  });

  describe('refuses a module list that does not validate', () => {
    const corrupted = (mutate: (blob: Buffer, offsetsAt: number) => void): Buffer => {
      const blob = buildBunBlob(NAMES.map(name => ({ name })));
      mutate(blob, blob.length - (32 + BUN_TRAILER.length));
      return Buffer.concat([blob, Buffer.alloc(64, 0x45)]);
    };

    it('rejects a non-printable byte in a module name', () => {
      withBinary(binaryWithNames(['/$bunfs/root/c\x01li', '/$bunfs/root/helper.js']), path => {
        expect(readBunModuleTable(path)).toBeNull();
      });
    });

    it('rejects an entryPointId outside the module table', () => {
      withBinary(corrupted((blob, at) => blob.writeUInt32LE(3, at + 16)), path => {
        expect(readBunModuleTable(path)).toBeNull();
      });
    });

    it('returns null when the module table length runs past the file', () => {
      withBinary(corrupted((blob, at) => blob.writeUInt32LE(0xffff, at + 12)), path => {
        expect(readBunModuleTable(path)).toBeNull();
      });
    });

    it('rejects an empty module table', () => {
      withBinary(corrupted((blob, at) => blob.writeUInt32LE(0, at + 12)), path => {
        expect(readBunModuleTable(path)).toBeNull();
      });
    });

    it('returns null when the blob start offset is out of range', () => {
      withBinary(corrupted((blob, at) => blob.writeBigUInt64LE(1n << 40n, at)), path => {
        expect(readBunModuleTable(path)).toBeNull();
      });
    });

    it('rejects a name that is not NUL-terminated at its recorded length', () => {
      withBinary(binaryWithNames(NAMES, { entryNameLengthDelta: -1 }), path => {
        expect(readBunModuleTable(path)).toBeNull();
      });
    });

    it('rejects a name that points outside the blob', () => {
      withBinary(binaryWithNames(NAMES, { entryNameOutOfBounds: true }), path => {
        expect(readBunModuleTable(path)).toBeNull();
      });
    });
  });

  it('returns null when there is no module list', () => {
    withBinary(Buffer.from('this is not a bun binary at all'.repeat(100)), path => {
      expect(readBunModuleTable(path)).toBeNull();
      expect(listBunModuleNames(path)).toBeNull();
    });
  });

  it('matches tweakcc 4.3.3 /cli and cli as well as its older names', () => {
    for (const name of ['/$bunfs/root/cli', 'cli', '/$bunfs/root/claude', 'claude',
      '/$bunfs/root/src/entrypoints/cli.js']) {
      expect(tweakccRecognizesModuleName(name)).toBe(true);
    }
    for (const name of [
      '/$bunfs/root/chunk.js', '/$bunfs/root/cli.js', '/$bunfs/root/client.js',
      '/$bunfs/root/foo-cli', 'clix', '/$bunfs/root/claude-code',
    ]) {
      expect(tweakccRecognizesModuleName(name)).toBe(false);
    }
  });
});
