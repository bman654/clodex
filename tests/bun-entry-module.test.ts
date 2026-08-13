import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectEntryModule,
  entryModuleShimName,
  restoreEntryModuleName,
  shimEntryModuleName,
  tweakccRecognizesModuleName,
} from '../src/bun-entry-module.js';
import {
  buildBunBlob,
  BUN_TRAILER,
  MACHO_MAGIC,
  type BunBlobOptions,
} from './bun-blob-fixture.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

/**
 * The blob wrapped in a container: leading bytes standing in for the executable headers and
 * sections ahead of it, trailing bytes for a code signature.
 */
function buildBinary(names: string[], options: BunBlobOptions = {}): Buffer {
  return Buffer.concat([
    Buffer.from('not-a-real-executable-header'.repeat(8)),
    buildBunBlob(names.map(name => ({ name })), options),
    // Deliberately opens with sixteen printable, NUL-terminated bytes: a pointer that escapes the
    // blob must be rejected for being out of bounds, not because whatever it landed on happened to
    // look wrong.
    Buffer.concat([
      Buffer.from('pretend-code-sig'),
      Buffer.from([0]),
      Buffer.from('nature'.repeat(16)),
    ]),
  ]);
}

const CURRENT_NAMES = [
  '/$bunfs/root/cli',
  '/$bunfs/root/image-processor.js',
  '/$bunfs/root/mermaid.min.js',
];
const PRE_231_NAMES = [
  '/$bunfs/root/src/entrypoints/cli.js',
  '/$bunfs/root/image-processor.js',
  '/$bunfs/root/mermaid.min.js',
];

describe('bun entry module shim', () => {
  let dir: string;
  let binary: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bun-entry-'));
    binary = join(dir, 'claude');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (bytes: Buffer) => {
    writeFileSync(binary, bytes);
    return bytes;
  };

  it('leaves a binary tweakcc can already read untouched', () => {
    const before = write(buildBinary(PRE_231_NAMES));

    expect(inspectEntryModule(binary)).toBe('discoverable');
    expect(shimEntryModuleName(binary)).toBeNull();
    expect(readFileSync(binary).equals(before)).toBe(true);
  });

  it('makes the renamed 2.1.231 entry module discoverable', () => {
    write(buildBinary(CURRENT_NAMES));
    expect(inspectEntryModule(binary)).toBe('needs-shim');

    const shim = shimEntryModuleName(binary);

    expect(shim?.original).toBe('/$bunfs/root/cli');
    expect(tweakccRecognizesModuleName(shim!.marker)).toBe(true);
    expect(inspectEntryModule(binary)).toBe('discoverable');
  });

  it('changes nothing but the name bytes, and puts them back exactly', () => {
    const before = write(buildBinary(CURRENT_NAMES));

    const shim = shimEntryModuleName(binary)!;
    const shimmed = readFileSync(binary);

    expect(shimmed.length).toBe(before.length);
    const differing = [...shimmed].flatMap((byte, index) => byte === before[index] ? [] : [index]);
    expect(differing.length).toBeGreaterThan(0);
    expect(Math.min(...differing)).toBeGreaterThanOrEqual(shim.offset);
    expect(Math.max(...differing)).toBeLessThan(shim.offset + Buffer.byteLength(shim.original));

    restoreEntryModuleName(binary, shim, { resign: false });
    expect(readFileSync(binary).equals(before)).toBe(true);
  });

  it('shims the entry module rather than the first one', () => {
    const names = ['/$bunfs/root/mermaid.min.js', '/$bunfs/root/helper.js', '/$bunfs/root/cli'];
    const before = write(buildBinary(names, { entryPointId: 2 }));

    const shim = shimEntryModuleName(binary)!;

    expect(shim.original).toBe('/$bunfs/root/cli');
    const after = readFileSync(binary);
    expect(after.indexOf('/$bunfs/root/mermaid.min.js')).toBe(before.indexOf('/$bunfs/root/mermaid.min.js'));
    expect(after.indexOf('/$bunfs/root/helper.js')).toBe(before.indexOf('/$bunfs/root/helper.js'));
  });

  it('reads the legacy 36-byte module struct', () => {
    write(buildBinary(CURRENT_NAMES, { structBytes: 36 }));

    expect(shimEntryModuleName(binary)?.original).toBe('/$bunfs/root/cli');
    expect(inspectEntryModule(binary)).toBe('discoverable');
  });

  it('declines to shim a name too short to hold a recognizable one', () => {
    // `/claude` is seven bytes; nothing shorter can be swapped in place.
    const before = write(buildBinary(['cli', '/$bunfs/root/helper.js']));

    expect(shimEntryModuleName(binary)).toBeNull();
    expect(readFileSync(binary).equals(before)).toBe(true);
  });

  it('declines to shim a name that is not where the module list says it ends', () => {
    // A name field one byte short of its NUL means this parse disagrees with the
    // real layout — renaming on that basis would overwrite the wrong span.
    const before = write(buildBinary(CURRENT_NAMES, { entryNameLengthDelta: -1 }));

    expect(shimEntryModuleName(binary)).toBeNull();
    expect(inspectEntryModule(binary)).toBe('unparseable');
    expect(readFileSync(binary).equals(before)).toBe(true);
  });

  it('declines to shim a name pointing outside the blob', () => {
    const before = write(buildBinary(CURRENT_NAMES, { entryNameOutOfBounds: true }));

    expect(shimEntryModuleName(binary)).toBeNull();
    expect(readFileSync(binary).equals(before)).toBe(true);
  });

  /**
   * The real container is nothing like a tight wrapper: on 2.1.231 the blob's trailer sits
   * ~800 KB from EOF behind a ~590 KB code signature, and the file carries a decoy
   * `---- Bun! ----` at ~55 MB (Bun's runtime ships the literal in __TEXT). A fixture that hugs
   * the blob passes with a scan window far too small to work, or one so wide it finds the decoy.
   */
  describe('inside a realistic container', () => {
    const blobOf = (names: string[]) => buildBunBlob(names.map(name => ({ name })));

    it('finds a blob buried under a code signature far larger than a page', () => {
      write(Buffer.concat([blobOf(CURRENT_NAMES), Buffer.alloc(1_500_000, 0x41)]));

      expect(shimEntryModuleName(binary)?.original).toBe('/$bunfs/root/cli');
    });

    it('is not fooled by a decoy trailer ahead of the blob', () => {
      write(Buffer.concat([
        Buffer.from('runtime strings: '),
        BUN_TRAILER,
        Buffer.alloc(4096, 0x42),
        blobOf(CURRENT_NAMES),
        Buffer.alloc(2048, 0x43),
      ]));

      expect(shimEntryModuleName(binary)?.original).toBe('/$bunfs/root/cli');
    });

    it('skips a stale trailer a shrinking repack left behind after the live blob', () => {
      // Verified against the real binary: an identity repack of 2.1.231 shrinks the blob by 61
      // bytes and the previous offsets struct + trailer survive at a HIGHER file offset.
      const blob = blobOf(CURRENT_NAMES);
      const staleTail = blob.subarray(blob.length - (32 + BUN_TRAILER.length));
      write(Buffer.concat([blob, Buffer.from('LEFT!'), staleTail, Buffer.alloc(1024, 0x44)]));

      expect(shimEntryModuleName(binary)?.original).toBe('/$bunfs/root/cli');
    });
  });

  describe('refuses a module list that does not validate', () => {
    const corrupted = (mutate: (blob: Buffer, offsetsAt: number) => void) => {
      const blob = buildBunBlob(CURRENT_NAMES.map(name => ({ name })));
      mutate(blob, blob.length - (32 + BUN_TRAILER.length));
      return write(Buffer.concat([blob, Buffer.alloc(64, 0x45)]));
    };

    it('when a name carries a byte no module path would', () => {
      // A control byte where a path should be means these offsets are being read as
      // something they are not — the same signal as a missing NUL, one step earlier.
      const before = write(buildBinary(['/$bunfs/root/cli', '/$bunfs/root/helper.js']));

      expect(shimEntryModuleName(binary)).toBeNull();
      expect(readFileSync(binary).equals(before)).toBe(true);
    });

    it('when the entry point is not one of the modules', () => {
      const before = corrupted((blob, offsetsAt) => blob.writeUInt32LE(3, offsetsAt + 16));

      expect(shimEntryModuleName(binary)).toBeNull();
      expect(readFileSync(binary).equals(before)).toBe(true);
    });

    it('when the module table overruns the blob', () => {
      const before = corrupted((blob, offsetsAt) => blob.writeUInt32LE(0xffff, offsetsAt + 12));

      expect(shimEntryModuleName(binary)).toBeNull();
      expect(readFileSync(binary).equals(before)).toBe(true);
    });

    it('when the module table is empty', () => {
      const before = corrupted((blob, offsetsAt) => blob.writeUInt32LE(0, offsetsAt + 12));

      expect(shimEntryModuleName(binary)).toBeNull();
      expect(readFileSync(binary).equals(before)).toBe(true);
    });

    it('when the blob claims to start before the file does', () => {
      const before = corrupted((blob, offsetsAt) => blob.writeBigUInt64LE(1n << 40n, offsetsAt));

      expect(shimEntryModuleName(binary)).toBeNull();
      expect(readFileSync(binary).equals(before)).toBe(true);
    });
  });

  it('declines to shim when no module list can be found', () => {
    const before = write(Buffer.from('this is not a bun binary at all'.repeat(100)));

    expect(shimEntryModuleName(binary)).toBeNull();
    // Nothing a shim can fix — tweakcc reports its own extraction failure.
    expect(inspectEntryModule(binary)).toBe('unparseable');
    expect(readFileSync(binary).equals(before)).toBe(true);
  });

  it('does not shim when tweakcc can already reach some other module', () => {
    // Two matches would let tweakcc pick a module other than the entry point.
    const before = write(buildBinary(['/$bunfs/root/cli', '/$bunfs/root/claude']));

    expect(inspectEntryModule(binary)).toBe('discoverable');
    expect(shimEntryModuleName(binary)).toBeNull();
    expect(readFileSync(binary).equals(before)).toBe(true);
  });

  it('restores the name where the repack moved it, not where it was shimmed', () => {
    // A repack rebuilds the blob, so the name almost never comes back at the same offset. Writing
    // at the remembered offset would corrupt whatever now lives there and leave the stand-in in
    // place. Growing an earlier module reproduces the shift.
    const modules = [
      { name: '/$bunfs/root/mermaid.min.js', contents: 'small' },
      { name: '/$bunfs/root/cli', contents: 'bundle' },
    ];
    write(Buffer.concat([buildBunBlob(modules, { entryPointId: 1 }), Buffer.alloc(64, 0x46)]));
    const shim = shimEntryModuleName(binary)!;
    const moved = buildBunBlob(
      [{ ...modules[0]!, contents: 'much larger contents than before' }, {
        name: shim.marker,
        contents: 'bundle',
      }],
      { entryPointId: 1 },
    );
    writeFileSync(binary, Buffer.concat([moved, Buffer.alloc(64, 0x46)]));

    restoreEntryModuleName(binary, shim, { resign: false });

    expect(inspectEntryModule(binary)).toBe('needs-shim');
    expect(readFileSync(binary).includes(shim.marker)).toBe(false);
    expect(shimEntryModuleName(binary)?.original).toBe('/$bunfs/root/cli');
  });

  it('refuses to publish a file where the stand-in survived elsewhere', () => {
    // The parse finds one blob; the guarantee is about the whole file. A stale copy of the blob
    // left behind by a repack is exactly how the stand-in could outlive its own restoration.
    const blob = buildBunBlob(CURRENT_NAMES.map(name => ({ name })));
    write(Buffer.concat([blob, Buffer.alloc(32, 0x47)]));
    const shim = shimEntryModuleName(binary)!;
    const shimmed = readFileSync(binary);
    writeFileSync(binary, Buffer.concat([shimmed, Buffer.from(shim.marker)]));

    expect(() => restoreEntryModuleName(binary, shim, { resign: false }))
      .toThrow(/survived restoration/);
  });

  it('refuses to restore over a name that is not the shim it wrote', () => {
    write(buildBinary(CURRENT_NAMES));
    const shim = shimEntryModuleName(binary)!;
    restoreEntryModuleName(binary, shim, { resign: false });

    expect(() => restoreEntryModuleName(binary, shim, { resign: false }))
      .toThrow(/expected the entry module/);
  });

  describe('Mach-O signatures', () => {
    let platform: PropertyDescriptor;

    beforeEach(() => {
      platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.mocked(execFileSync).mockClear();
      // A Bun blob is located by scanning back from EOF, so the Mach-O magic can
      // simply lead the same synthetic container.
      writeFileSync(binary, Buffer.concat([MACHO_MAGIC, buildBinary(CURRENT_NAMES)]));
    });
    afterEach(() => Object.defineProperty(process, 'platform', platform));

    it('re-signs after a repack, which leaves the binary otherwise unrunnable', () => {
      const shim = shimEntryModuleName(binary)!;

      restoreEntryModuleName(binary, shim, { resign: true });

      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        'codesign',
        ['-s', '-', '-f', binary],
        expect.anything(),
      );
    });

    it('leaves the signature alone when the restore reproduces the original bytes', () => {
      // Re-signing here would swap Claude Code's own signature for an ad-hoc one,
      // so bytes taken as a pristine backup would not match the install they came
      // from — nor the content address they are filed under.
      const before = readFileSync(binary);
      const shim = shimEntryModuleName(binary)!;

      restoreEntryModuleName(binary, shim, { resign: false });

      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
      expect(readFileSync(binary).equals(before)).toBe(true);
    });
  });

  it('builds a recognizable name at any length that admits one', () => {
    for (let length = 7; length <= 64; length++) {
      const name = entryModuleShimName(length);
      expect(Buffer.byteLength(name!)).toBe(length);
      expect(tweakccRecognizesModuleName(name!)).toBe(true);
    }
    expect(entryModuleShimName(6)).toBeNull();
  });
});
