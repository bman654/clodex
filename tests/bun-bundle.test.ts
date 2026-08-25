// Reading a code-split Claude Code bundle as one document, and writing it back in one repack.
//
// Claude Code 2.1.242 turned its single ~28 MB Bun module into a ~20 KB entry plus ~1,370 chunks.
// tweakcc reads and writes ONE module — the one it recognizes by name — so everything here is
// about the other 1,369: getting their source in front of the transforms, and getting the patched
// result back into the blob without repacking once per module.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBundleWritePlan,
  BUNDLE_MODULE_SEPARATOR,
  planBundleWrite,
  readClaudeBundle,
  splitBundleSource,
  writableModuleIndex,
} from '../src/bun-bundle.js';
import {
  readBunJavaScriptModules,
  readBunModuleTable,
  repointBunModuleContents,
  tweakccRecognizesModuleName,
} from '../src/bun-entry-module.js';
import { closeSync, openSync, writeSync } from 'node:fs';
import { buildFakeNativeClaude, parseBunBlob, rebuildFakeNativeClaude } from './bun-blob-fixture.js';

/**
 * Table positions and bundle positions are DIFFERENT NUMBERS, and this fixture is built so they
 * disagree: assets sit between the JavaScript modules, so the JavaScript lives at table positions
 * 0, 2, 4, 5. On every Claude Code shipped so far the assets happen to sort last, which makes the
 * two accidentally equal — and a repoint addressed by the wrong one would still pass.
 *
 * `entryPointId` is also deliberately not the module tweakcc writes: tweakcc finds its module by
 * NAME, and reading `entryPointId` instead would agree with it on every real build.
 */
const MODULES = [
  { name: '/$bunfs/root/chunk-a.js', contents: 'export const a=1;' },
  { name: '/$bunfs/root/mermaid.min.js', loader: 5, contents: 'export const a=99;' },
  { name: '/$bunfs/root/chunk-b.js', contents: 'export const b=2;' },
  { name: '/$bunfs/root/image-processor.node', loader: 10, contents: 'native helper' },
  { name: '/$bunfs/root/claude', contents: 'import{a}from"./chunk-a.js";a;' },
  { name: '/$bunfs/root/chunk-c.js', contents: 'export const c=3;' },
];
/** Table position of the module tweakcc recognizes and writes. */
const WRITABLE_ID = 4;
/** Its position within the bundle — not the same number. */
const WRITABLE_AT = 2;
/** The module Bun starts at, deliberately not the one tweakcc writes. */
const ENTRY_ID = 0;
/** Table positions of the JavaScript modules, in bundle order. */
const JS_IDS = [0, 2, 4, 5];

function withBinary(
  modules: { name: string; contents: string; loader?: number }[],
  run: (path: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'clodex-bun-bundle-'));
  try {
    const path = join(dir, 'claude');
    writeFileSync(path, buildFakeNativeClaude('2.1.243', modules, { entryPointId: ENTRY_ID }));
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Stand in for tweakcc's `writeContent`, which replaces the payload of every module whose NAME it
 * recognizes and rebuilds the blob around it — the behaviour that makes one call per module the
 * only thing its API offers, and the reason the repoint below exists.
 */
function fakeWriteContent(path: string, content: string): void {
  const parsed = parseBunBlob(readFileSync(path));
  writeFileSync(path, rebuildFakeNativeClaude(
    readFileSync(path),
    '2.1.243',
    // EVERY recognized module, exactly as tweakcc does — it has no way to say "this one".
    (index, previous) => (tweakccRecognizesModuleName(parsed.names[index]!) ? content : previous),
  ));
}

/** Overwrite one module's `{offset,length}` pair directly, without the bounds check on the way. */
function forceContentRange(path: string, index: number, offset: number, length: number): void {
  const table = readBunModuleTable(path)!;
  const pair = Buffer.alloc(8);
  pair.writeUInt32LE(offset, 0);
  pair.writeUInt32LE(length, 4);
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, pair, 0, 8, table.modulesAt + index * table.structBytes + 8);
  } finally {
    closeSync(fd);
  }
}

const jsModules = MODULES.filter((_, index) => JS_IDS.includes(index));

describe('readClaudeBundle', () => {
  it('joins every JavaScript module into one document, in blob order', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      expect(bundle.modules.map(module => module.name))
        .toEqual(jsModules.map(module => module.name));
      expect(bundle.source)
        .toBe(jsModules.map(module => module.contents).join(BUNDLE_MODULE_SEPARATOR));
    });
  });

  it('leaves out the modules Bun does not execute as JavaScript, and keeps their table positions', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      // The vendored asset at table position 1 carries `export const a=99;` — text a transform
      // could match. Including it would make an anchor ambiguous; addressing a repoint by bundle
      // position instead of table position would rewrite the WRONG module.
      expect(bundle.modules.map(module => module.index)).toEqual(JS_IDS);
      expect(bundle.source).not.toContain('a=99');
      expect(bundle.source).not.toContain('native helper');
    });
  });

  it('reports no bundle when a module already contains the boundary marker', () => {
    // Splitting would then cut in a place no patch put a boundary, silently moving code between
    // modules. Falling back to tweakcc's single-module read fails loudly instead.
    const poisoned = MODULES.map((module, index) => index === 0
      ? { ...module, contents: `export const a=1;${BUNDLE_MODULE_SEPARATOR}` }
      : module);
    withBinary(poisoned, path => expect(readClaudeBundle(path)).toBeNull());
  });

  it('reports no bundle when a module is not valid UTF-8', () => {
    // Decoding and re-encoding would replace those bytes, and every check downstream decodes the
    // same way — so it would agree with itself and publish a mangled module.
    //
    // A TRUNCATED four-byte sequence, deliberately: it decodes to one replacement character that
    // re-encodes to the same three bytes it occupied, so the byte-length half of the check is
    // satisfied and only the replacement-character half can catch it. `ff fe` would be caught by
    // the length alone and would leave the other half unpinned.
    withBinary(MODULES, path => {
      const table = readBunModuleTable(path)!;
      const range = table.contents[0]!;
      const fd = openSync(path, 'r+');
      try {
        writeSync(fd, Buffer.from([0xf0, 0x90, 0x80]), 0, 3, table.blobAt + range.offset);
      } finally {
        closeSync(fd);
      }
      expect(readClaudeBundle(path)).toBeNull();
    });
  });

  it('keeps the module boundary out of reach of every anchor\'s wildcards', () => {
    // Each built-in anchor bounds its wildcard with a character class. A separator any of them
    // accepts is one they can match ACROSS, binding a patch to a span belonging to two modules —
    // and the boundary COUNT would be unchanged, so nothing downstream would notice.
    for (const forbidden of ['`', '{', '}', ';', '"', ']']) {
      expect(BUNDLE_MODULE_SEPARATOR).toContain(forbidden);
    }
    // ...and it is still a comment, so the joined document is still JavaScript.
    expect(BUNDLE_MODULE_SEPARATOR.trim().startsWith('/*')).toBe(true);
    expect(BUNDLE_MODULE_SEPARATOR.trim().endsWith('*/')).toBe(true);
    expect(BUNDLE_MODULE_SEPARATOR.trim().slice(2, -2)).not.toContain('*/');
  });

  it('reports no bundle when a payload range runs past the end of the blob', () => {
    // Padded so the bytes past the blob are still IN the file and are still valid ASCII — which is
    // the real shape (a Mach-O code signature follows the `__BUN` section) and the only one where
    // this guard is what does the work. Without the padding the read simply runs off the end, and
    // the guard could be deleted with nothing to show for it.
    const dir = mkdtempSync(join(tmpdir(), 'clodex-bun-bundle-'));
    try {
      const path = join(dir, 'claude');
      writeFileSync(path, Buffer.concat([
        buildFakeNativeClaude('2.1.243', MODULES, { entryPointId: ENTRY_ID }),
        Buffer.from('A'.repeat(4096)),
      ]));
      const table = readBunModuleTable(path)!;
      expect(readClaudeBundle(path)).not.toBeNull();
      // The blob's own recorded size is the only thing that says how far a payload may go. Point a
      // module past it and what gets read as Claude Code source is whatever the container put
      // there — here 64 bytes of perfectly valid ASCII, which every other guard is happy with.
      forceContentRange(path, 0, table.byteCount + 47, 64);
      expect(readClaudeBundle(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to point a module outside the blob', () => {
    withBinary(MODULES, path => {
      const table = readBunModuleTable(path)!;
      expect(() => repointBunModuleContents(path, [
        { index: 0, range: { offset: 1, length: table.byteCount } },
      ])).toThrow(/outside the .*-byte blob/);
    });
  });

  it('reports no bundle when the file carries no readable Bun blob', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-bun-bundle-'));
    try {
      const path = join(dir, 'claude');
      writeFileSync(path, 'not a native binary at all');
      expect(readClaudeBundle(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('splitBundleSource', () => {
  it('refuses a patched document that lost a module boundary', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      // What a patch that matched ACROSS two modules would leave behind. Splitting it anyway would
      // hand one module its neighbour's code and leave the neighbour empty.
      const mangled = bundle.source.replace(BUNDLE_MODULE_SEPARATOR, '');
      expect(() => splitBundleSource(bundle, mangled)).toThrow(/3 module boundaries, expected 4/);
    });
  });
});

describe('planBundleWrite', () => {
  it('writes only the module tweakcc writes when nothing else changed', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[WRITABLE_AT] = 'patched entry';
      const plan = planBundleWrite(bundle, patched, WRITABLE_ID);
      // The pre-2.1.242 shape: exactly the call clodex has always made, and no pointer edit.
      expect(plan).toEqual({ content: 'patched entry', repoints: [] });
    });
  });

  it('puts the writable module first and NUL-separates the slices', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[3] = 'export const c=33;';
      const plan = planBundleWrite(bundle, patched, WRITABLE_ID);
      expect(plan.content).toBe(`${MODULES[WRITABLE_ID]!.contents}\0export const c=33;\0`);
      // Addressed by TABLE position, not by position within the bundle.
      expect(plan.repoints.map(repoint => repoint.index)).toEqual([WRITABLE_ID, JS_IDS[3]]);
      expect(plan.repoints[1]!.start).toBe(MODULES[WRITABLE_ID]!.contents.length + 1);
    });
  });
});

describe('applyBundleWritePlan', () => {
  it('points every patched module at its own slice of the one buffer that was written', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      patched[3] = 'export const c=333;';
      // Found by the name tweakcc recognizes, which is NOT `entryPointId` here.
      expect(writableModuleIndex(path)).toBe(WRITABLE_ID);
      const plan = planBundleWrite(bundle, patched, writableModuleIndex(path)!);

      fakeWriteContent(path, plan.content);
      // Before the repoint, the module tweakcc wrote holds ALL of it — which is exactly the
      // corruption this step exists to undo.
      expect(readBunJavaScriptModules(path)![WRITABLE_AT]!.source).toBe(plan.content);

      applyBundleWritePlan(path, plan);
      expect(readBunJavaScriptModules(path)!.map(module => module.source)).toEqual([
        'export const a=111;',
        MODULES[2]!.contents,
        MODULES[WRITABLE_ID]!.contents,
        'export const c=333;',
      ]);
    });
  });

  it('refuses to repoint when the bytes in the binary are not the ones it planned around', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(bundle, patched, WRITABLE_ID);
      // A repack that wrote a different string — or a different module — would leave every offset
      // below computed against the wrong base, so this has to fail loudly rather than repoint into
      // whatever happens to be there.
      fakeWriteContent(path, `${plan.content}unexpected extra bytes`);
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/refusing to repoint/);
    });
  });

  it('refuses more than one module tweakcc would write to even when nothing needs repointing', () => {
    // The common shape — every release up to 2.1.241 patches only the module tweakcc writes — and
    // therefore the one an early return would exempt. tweakcc would still have put the same buffer
    // into the second recognized module, and with no repoint to follow there is nothing else that
    // would ever look at it.
    const twoRecognized = MODULES.map((module, index) => index === 0
      ? { ...module, name: '/$bunfs/root/src/entrypoints/cli.js' }
      : module);
    withBinary(twoRecognized, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'patched entry';
      const plan = planBundleWrite(bundle, patched, 0);
      expect(plan.repoints).toEqual([]);
      fakeWriteContent(path, plan.content);
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/2 modules tweakcc would write to/);
    });
  });

  it('refuses when the blob has more than one module tweakcc would write to', () => {
    // tweakcc puts its buffer into EVERY recognized module, and the plan repoints exactly one — so
    // the second would be published holding the whole concatenation of unrelated chunks. The
    // read-back loop cannot see it, because a module nobody repointed is a module nobody checks.
    const twoRecognized = MODULES.map((module, index) => index === 0
      ? { ...module, name: '/$bunfs/root/src/entrypoints/cli.js' }
      : module);
    withBinary(twoRecognized, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[3] = 'export const c=333;';
      const plan = planBundleWrite(bundle, patched, 0);
      fakeWriteContent(path, plan.content);
      expect(() => applyBundleWritePlan(path, plan))
        .toThrow(/2 modules tweakcc would write to/);
    });
  });

  it('refuses when a repointed module does not read back as the patched source', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      patched[3] = 'export const c=333;';
      const plan = planBundleWrite(bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      // The buffer is intact and the right length, so the length check above still passes — only
      // reading each module back can catch a slice that starts one byte late.
      plan.repoints[1]!.start += 1;
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/did not read back/);
    });
  });
});
