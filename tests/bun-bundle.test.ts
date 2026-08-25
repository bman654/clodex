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
  PLACEHOLDER_SLACK_BYTES,
  planBundleWrite,
  readClaudeBundle,
  splitBundleSource,
  writableModuleIndex,
} from '../src/bun-bundle.js';
import {
  BUN_BLOB_FLAGS,
  readBunJavaScriptModules,
  readBunModuleTable,
  tweakccRecognizesModuleName,
} from '../src/bun-entry-module.js';
import { closeSync, openSync, writeSync } from 'node:fs';
import { buildFakeNativeClaude, parseBunBlob, rebuildFakeNativeClaude } from './bun-blob-fixture.js';
import { applyClodexPatches } from '../src/patch-transforms.js';
import { CLAUDE_FIXTURE } from './fixtures/claude-bundle.js';

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
/**
 * The module Bun starts at, deliberately not the one tweakcc writes AND deliberately not zero: at
 * zero, publishing `entryPointId` and publishing nothing are the same bytes, so a write that
 * dropped it would pass. On a real 2.1.246 it is 7.
 */
const ENTRY_ID = 2;
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

  it('stops an anchor binding across a boundary, which a punctuation-free separator would not', () => {
    // The BEHAVIOURAL version of the assertion below, and the reason the punctuation is there. A
    // module whose text ends mid-template — a shape a code-split chunk can genuinely have — is
    // joined ahead of the real bundle.
    //
    // With a plain `/*clodex:module-boundary*/` separator, PATCH 4's wildcard runs from the stray
    // `describe(` ACROSS the boundary and the replacement consumes the span between them, so the
    // real Agent-tool description is DESTROYED — what is left is `describe(` with its template
    // opener eaten — and the site still reports OK. The boundary count is unchanged, the split
    // succeeds and the read-back succeeds, so nothing else in the pipeline notices.
    const stray = 'var stray=describe(`Optional model override for this agent. Truncated';
    const config = { 'clodex:openai:m': { alias: 'luna', display: 'Luna' } };
    const across = (separator: string) => {
      const out = applyClodexPatches([stray, CLAUDE_FIXTURE].join(separator), config);
      return {
        status: out.results.find(result => result.name.startsWith('PATCH 4'))!.status,
        // The template opener the real module owned, eaten by a match that started in the stray.
        mangled: out.content.includes('describe( '),
      };
    };
    expect(across('\n/*clodex:module-boundary*/\n')).toEqual({ status: 'OK', mangled: true });
    // The separator carries a backtick, so it closes the stray template instead of being crossed:
    // the anchor finds two candidates and refuses rather than corrupting a module it never owned.
    expect(across(BUNDLE_MODULE_SEPARATOR)).toEqual({ status: 'FAIL', mangled: false });
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
  it('appends only the modules whose source changed, and leaves the rest where they were', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const before = readBunModuleTable(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[3] = 'export const c=33;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);

      expect(plan.appends.map(append => append.index)).toEqual([JS_IDS[3]]);
      // Past the end of the pristine blob, so no offset that was already in it moves.
      expect(plan.appends[0]!.range.offset).toBeGreaterThanOrEqual(before.byteCount);
      expect(plan.data.subarray(0, before.byteCount / 2))
        .toEqual(readFileSync(path).subarray(before.blobAt, before.blobAt + before.byteCount / 2));
    });
  });

  it('is the pristine bytes plus the patched sources, not a rebuild of them', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const before = readBunModuleTable(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      // Everything before the module table is untouched — including whatever no module struct
      // points at, which is what a rebuild loses.
      expect(plan.data.subarray(0, before.modulesOffset))
        .toEqual(readFileSync(path).subarray(before.blobAt, before.blobAt + before.modulesOffset));
      expect(plan.data.length).toBeGreaterThan(before.byteCount);
    });
  });

  it('refuses a patched document that lost or gained a module', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      expect(() => planBundleWrite(path, bundle, patched.slice(0, -1), WRITABLE_ID))
        .toThrow(/expected 4 patched module sources, got 3/);
      expect(() => planBundleWrite(path, bundle, [...patched, 'extra'], WRITABLE_ID))
        .toThrow(/expected 4 patched module sources, got 5/);
    });
  });

  it('refuses to size a placeholder when the module table double-counts its own payloads', () => {
    // The mirror of tweakcc's rebuild sums each module's six payload ranges. A table whose ranges
    // OVERLAP makes it count the same bytes more than once and predict a bigger blob than the one
    // being planned — the only direction that can leave a section too small to publish into. Left
    // to clamp at zero, the repack comes back LARGER than the planned blob, so the truncation
    // refusal never fires and clodex publishes into a section sized off arithmetic it knows is
    // wrong.
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const table = readBunModuleTable(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      // Point every module's `bytecodeOriginPath` at one oversized shared range, which is what a
      // misparsed struct size or field offset produces.
      const fd = openSync(path, 'r+');
      try {
        for (let index = 0; index < table.names.length; index++) {
          const pair = Buffer.alloc(8);
          pair.writeUInt32LE(0, 0);
          pair.writeUInt32LE(1 << 24, 4);
          writeSync(fd, pair, 0, 8, table.modulesAt + index * table.structBytes + 40);
        }
      } finally {
        closeSync(fd);
      }
      expect(() => planBundleWrite(path, bundle, patched, WRITABLE_ID))
        .toThrow(/overlapping payload ranges/);
    });
  });

  it('refuses a writable index that is not the module tweakcc writes to', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      // Every offset in the plan is computed against the module tweakcc will overwrite, so being
      // handed the wrong one silently mis-sizes the placeholder.
      expect(() => planBundleWrite(path, bundle, patched, 0))
        .toThrow(/is not the one tweakcc writes to/);
    });
  });

  it('refuses more than one module tweakcc would write to', () => {
    // tweakcc puts its buffer into EVERY recognized module, and the size the placeholder is
    // computed for assumes exactly one. The entry-module shim declines to fire when a recognized
    // name already exists precisely so that stays true.
    const twoRecognized = MODULES.map((module, index) => index === 0
      ? { ...module, name: '/$bunfs/root/src/entrypoints/cli.js' }
      : module);
    withBinary(twoRecognized, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[3] = 'export const c=333;';
      expect(() => planBundleWrite(path, bundle, patched, 0))
        .toThrow(/2 modules tweakcc would write to/);
    });
  });
});

describe('applyBundleWritePlan', () => {
  it('publishes every module at its patched source over the repacked section', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      patched[3] = 'export const c=333;';
      // Found by the name tweakcc recognizes, which is NOT `entryPointId` here.
      expect(writableModuleIndex(path)).toBe(WRITABLE_ID);
      const plan = planBundleWrite(path, bundle, patched, writableModuleIndex(path)!);

      fakeWriteContent(path, plan.content);
      // What the repack leaves behind: the placeholder in the module tweakcc writes, and none of
      // the patched code anywhere.
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

  it('keeps the blob regions no module struct points at, which the repack drops', () => {
    // The Claude Code 2.1.246 failure, in miniature. Bun 1.4.1 writes a `[u32; modules]` of source
    // hashes, a builtin-bytecode table and a shared bytecode string table after the module table,
    // announces them in `flags`, and points at none of them from a module struct. tweakcc rebuilds
    // the blob from the module structs, so it published a binary whose flags promised structures
    // that were no longer there — and Bun segfaulted reading them.
    const table = 'shared-bytecode-string-table-every-chunk-references-by-ordinal';
    const options = {
      entryPointId: ENTRY_ID,
      flags: BUN_BLOB_FLAGS.SOURCE_TEXT_CONTIGUOUS
        | BUN_BLOB_FLAGS.HAS_SOURCE_HASHES
        | BUN_BLOB_FLAGS.HAS_BUILTIN_BYTECODE
        | BUN_BLOB_FLAGS.HAS_BYTECODE_STRING_TABLE,
      sourceHashes: MODULES.map((_, index) => 0xc0de0000 + index),
      bytecodeStringTable: table,
    };
    const dir = mkdtempSync(join(tmpdir(), 'clodex-bun-bundle-'));
    try {
      const path = join(dir, 'claude');
      writeFileSync(path, buildFakeNativeClaude('2.1.246', MODULES, options));
      const before = readBunModuleTable(path)!;
      const tailAt = before.modulesOffset + before.modulesLength;
      const pointerAt = tailAt + before.names.length * 4 + 4;
      const pristine = readFileSync(path);
      const stringTableAt = pristine.readUInt32LE(before.blobAt + pointerAt);

      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      // What the repack leaves: a blob whose `flags` still promise all three structures, and whose
      // bytes no longer hold any of them. This is the state clodex used to publish.
      const repacked = readBunModuleTable(path)!;
      expect(repacked.flags).toBe(options.flags);
      expect(readFileSync(path).subarray(repacked.blobAt, repacked.blobAt + repacked.byteCount)
        .includes(table)).toBe(false);

      applyBundleWritePlan(path, plan);

      const after = readBunModuleTable(path)!;
      const published = readFileSync(path);
      // The pointer still addresses the same offset, and that offset still holds the table.
      expect(published.readUInt32LE(after.blobAt + pointerAt)).toBe(stringTableAt);
      expect(published.readUInt32LE(after.blobAt + pointerAt + 4)).toBe(table.length);
      expect(published.subarray(after.blobAt + stringTableAt, after.blobAt + stringTableAt + table.length)
        .toString('utf8')).toBe(table);
      // Every module's source hash survives except the patched one's, whose bytecode was compiled
      // from source that is no longer there.
      const hashes = MODULES.map((_, index) => published.readUInt32LE(after.blobAt + tailAt + index * 4));
      expect(hashes).toEqual(options.sourceHashes.map((hash, index) => (index === JS_IDS[0] ? 0 : hash)));
      // `SOURCE_TEXT_CONTIGUOUS` is the one flag that stops being true: the appended sources are
      // outside the run Bun laid out. Nothing else may be dropped.
      expect(after.flags).toBe(options.flags & ~BUN_BLOB_FLAGS.SOURCE_TEXT_CONTIGUOUS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the cached bytecode of a patched module and keeps every other module\'s', () => {
    // Bun 1.4.1 records a source hash so that loading from bytecode never has to re-hash the
    // source. Leaving a patched module's pre-patch bytecode in place would let that recorded hash
    // vouch for it, and the module would run its UNPATCHED compiled form.
    const withBytecode = MODULES.map(module => ({
      ...module,
      bytecode: `compiled:${module.name}`,
      moduleInfo: 'info',
      bytecodeOriginPath: `origin:${module.name}`,
    }));
    withBinary(withBytecode, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      applyBundleWritePlan(path, plan);

      const after = readBunModuleTable(path)!;
      // The whole group goes: the compiled form, its module info, and the path it was compiled
      // under. Leaving the origin path behind would describe bytecode that is no longer there.
      expect(after.bytecode[JS_IDS[0]!]).toEqual({ offset: 0, length: 0 });
      expect(after.moduleInfo[JS_IDS[0]!]).toEqual({ offset: 0, length: 0 });
      expect(after.bytecodeOriginPath[JS_IDS[0]!]).toEqual({ offset: 0, length: 0 });
      expect(after.bytecode[JS_IDS[1]!]!.length).toBeGreaterThan(0);
      expect(after.bytecodeOriginPath[JS_IDS[1]!]!.length).toBeGreaterThan(0);
    });
  });

  it('refuses to publish when the repack did not leave the placeholder it was addressed to', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      // A repack that does not grow the blob leaves the PREVIOUS one's trailer behind at a higher
      // offset, and the scan that finds a blob works backwards from the end of the file — so
      // "these are the bytes tweakcc just wrote" has to be proved, not assumed.
      fakeWriteContent(path, `${plan.content}unexpected extra bytes`);
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/refusing to publish a blob addressed/);
    });
  });

  it('leaves every module it did not patch exactly as it found it', () => {
    // The read-back loop only looks at modules Bun executes as JavaScript, so an over-scoped
    // repoint into the vendored asset or the napi module beside them is invisible to it — and on a
    // real 2.1.246 that class is 173 modules, including five `*.node` helpers. Clobbering one
    // publishes a claude that starts and then dies loading a native helper.
    const withBytecode = MODULES.map(module => ({
      ...module,
      bytecode: `compiled:${module.name}`,
      moduleInfo: `info:${module.name}`,
      bytecodeOriginPath: `origin:${module.name}`,
    }));
    withBinary(withBytecode, path => {
      const bundle = readClaudeBundle(path)!;
      const before = readBunModuleTable(path)!;
      const beforeBlob = parseBunBlob(readFileSync(path));
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      applyBundleWritePlan(path, plan);

      const after = readBunModuleTable(path)!;
      const afterBlob = parseBunBlob(readFileSync(path));
      const untouched = MODULES.map((_, index) => index).filter(index => index !== JS_IDS[0]);
      for (const index of untouched) {
        expect([index, afterBlob.contents[index]]).toEqual([index, beforeBlob.contents[index]]);
        expect([index, afterBlob.bytecode[index]]).toEqual([index, beforeBlob.bytecode[index]]);
        expect([index, afterBlob.moduleInfo[index]]).toEqual([index, beforeBlob.moduleInfo[index]]);
        expect([index, after.contents[index]]).toEqual([index, before.contents[index]]);
        expect([index, after.bytecode[index]]).toEqual([index, before.bytecode[index]]);
        expect([index, after.moduleInfo[index]]).toEqual([index, before.moduleInfo[index]]);
      }
      // And the one that WAS patched moved, so the loop above is not vacuously true.
      expect(after.contents[JS_IDS[0]!]).not.toEqual(before.contents[JS_IDS[0]!]);
    });
  });

  it('appends 8-byte aligned, NUL-terminated payloads', () => {
    // Neither is observable through clodex's own reader — it addresses a payload by
    // `{offset,length}` and only checks the NUL after names — so nothing else can see this code
    // stop doing either.
    const odd = MODULES.map((module, index) => index === 0
      ? { ...module, contents: `${module.contents}xyz` }
      : module);
    withBinary(odd, path => {
      const bundle = readClaudeBundle(path)!;
      const before = readBunModuleTable(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=1111;';
      patched[3] = 'export const c=3333;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      // A pristine blob whose length is not a multiple of 8, so the first append has to pad.
      expect(before.byteCount % 8).not.toBe(0);
      for (const append of plan.appends) {
        expect(append.range.offset % 8).toBe(0);
        expect(plan.data[append.range.offset + append.range.length]).toBe(0);
        expect(append.range.offset).toBeGreaterThanOrEqual(before.byteCount);
      }
    });
  });

  it('sizes the placeholder from the repack it is about to get, not from a guess', () => {
    // `repackedBlobBytes` mirrors arithmetic clodex does not own, and its terms — the NUL after
    // each copied field, each field's own length, the exec-argv byte — can be wrong without any
    // other assertion noticing. Hardcoding `bytecodeOriginPath` as empty wasted 33,652 bytes of
    // section on a real 2.1.246. If the mirror is exact, the blob the repack produces is the
    // planned one plus exactly the slack.
    //
    // The one term this does NOT reach is the `structBytes === 52` branch: nothing here builds a
    // 36-byte blob and drives it through the write, so that branch is pinned only by reading it
    // against tweakcc's own `r === 52 ? … : …`. The probe's `blob-sized-as-planned` check covers
    // the rest against a real repack, per format.
    const withBytecode = MODULES.map(module => ({
      ...module,
      sourcemap: `map:${module.name}`,
      bytecode: `compiled:${module.name}`,
      moduleInfo: `info:${module.name}`,
      bytecodeOriginPath: `origin:${module.name}`,
    }));
    withBinary(withBytecode, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      patched[3] = 'export const c=333;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      expect(readBunModuleTable(path)!.byteCount)
        .toBe(plan.data.length + PLACEHOLDER_SLACK_BYTES);
    });
  });

  it('publishes the offsets struct the plan built, not the one the repack left', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const before = readBunModuleTable(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      applyBundleWritePlan(path, plan);

      const after = readBunModuleTable(path)!;
      expect(after.entryPointId).toBe(ENTRY_ID);
      expect(after.compileExecArgv).toEqual(before.compileExecArgv);
      expect(after.modulesOffset).toBe(before.modulesOffset);
      expect(after.modulesLength).toBe(before.modulesLength);
    });
  });

  it('appends nothing when the patch changed nothing', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const before = readBunModuleTable(path)!;
      const pristine = readFileSync(path).subarray(before.blobAt, before.blobAt + before.byteCount);
      const plan = planBundleWrite(path, bundle, bundle.modules.map(module => module.source), WRITABLE_ID);
      expect(plan.appends).toEqual([]);
      expect(plan.data).toEqual(pristine);
      // Still republished, and still verified: the repack ran either way.
      fakeWriteContent(path, plan.content);
      applyBundleWritePlan(path, plan);
      expect(readBunJavaScriptModules(path)!.map(module => module.source))
        .toEqual(bundle.modules.map(module => module.source));
    });
  });

  it('refuses to publish when the repack reordered the module table', () => {
    // The ONLY guard that can see a repack which preserves every module but changes their table
    // order. The read-back loop provably cannot substitute for it, because it compares each index
    // AFTER writing that index, so a blob published over a shuffled table reads back as exactly
    // what was just written. The pinned tweakcc preserves order today, which is what makes this
    // calibration rather than a live hole; it is also what would silently disarm on a bump.
    //
    // The shuffle deliberately LEAVES the module tweakcc wrote where the plan addressed it. Rotate
    // the whole table instead and the placeholder moves off `writableIndex`, the placeholder-length
    // check fires first, and this guard is never reached — which is how this test used to pass.
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      const parsed = parseBunBlob(readFileSync(path));
      const modules = parsed.names.map((name, index) => ({
        name,
        contents: parsed.contents[index]!,
        bytecode: parsed.bytecode[index]!,
        moduleInfo: parsed.moduleInfo[index]!,
        bytecodeOriginPath: parsed.bytecodeOriginPath[index]!,
        loader: parsed.loaders[index]!,
      }));
      // Swap two modules that are NOT the one tweakcc wrote: nothing is lost, the placeholder is
      // still at `WRITABLE_ID`, and every length is still what the plan expects.
      [modules[0], modules[2]] = [modules[2]!, modules[0]!];
      writeFileSync(path, buildFakeNativeClaude('2.1.243', modules, {
        entryPointId: parsed.entryPointId,
        flags: parsed.flags,
      }));
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/different module table/);
    });
  });

  it('refuses to publish when the repack moved the blob off its 128-byte residue', () => {
    // Every unpatched module keeps its cached bytecode exactly where it was, and JSC decodes that
    // in place at a 128-byte boundary. Nothing else here can see a repack that put the blob back
    // at a different residue, and the result would be a claude that starts and then dies in JSC.
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      // Shift the whole file down by one byte, which is what a repack that padded differently
      // would do to the blob's start. Everything else about the blob is untouched.
      writeFileSync(path, Buffer.concat([Buffer.from('#'), readFileSync(path)]));
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/different offset modulo 128/);
    });
  });

  it('accepts a blob the repack relocated by a multiple of 128', () => {
    // The check above passes for a guard that demanded the blob come back at the SAME offset — and
    // that guard would refuse every Linux patch, because tweakcc's ELF repack relocates the blob
    // to a fresh page-aligned address (86,638,600 -> 266,207,240 on a real linux-arm64 2.1.246,
    // both 8 mod 128). What has to hold is the residue, not the offset.
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      writeFileSync(path, Buffer.concat([Buffer.alloc(128 * 32, 0x23), readFileSync(path)]));
      applyBundleWritePlan(path, plan);
      expect(readBunJavaScriptModules(path)!.map(module => module.source)).toEqual([
        'export const a=111;',
        MODULES[2]!.contents,
        MODULES[WRITABLE_ID]!.contents,
        MODULES[5]!.contents,
      ]);
    });
  });

  it('refuses to publish when the section is too small for the planned blob', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      // What a tweakcc whose repack laid the blob out differently would leave: room for less than
      // the planned blob. One byte past the boundary, so a guard that drifted by any margin at all
      // is caught — the section the repack produced is the planned blob plus exactly the slack.
      plan.data = Buffer.concat([plan.data, Buffer.alloc(PLACEHOLDER_SLACK_BYTES + 1)]);
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/refusing to publish a truncated one/);
    });
  });

  it('refuses when the published blob does not read back as the one that was planned', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      // Every module still reads back as its patched source, so only comparing the OFFSETS STRUCT
      // can see this: the blob is published claiming a flag the plan says it does not carry.
      plan.offsets.writeUInt32LE(plan.flags | BUN_BLOB_FLAGS.SOURCE_TEXT_CONTIGUOUS, 28);
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/does not read back as the one/);
    });
  });

  it('refuses when a module it planned to move is not one Bun executes as JavaScript', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      // Table position 1 is the vendored asset. The read-back walks the JavaScript modules, so an
      // expectation about a module it never visits would otherwise pass by never being checked.
      plan.appends.push({ ...plan.appends[0]!, index: 1 });
      fakeWriteContent(path, plan.content);
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/came back as JavaScript Bun will execute/);
    });
  });

  it('refuses when a patched module does not read back as its patched source', () => {
    withBinary(MODULES, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      patched[3] = 'export const c=333;';
      const before = readBunModuleTable(path)!;
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      fakeWriteContent(path, plan.content);
      // Nudge what the published table says about one module, leaving everything else — the
      // module count, the names, the length of the section, the appended bytes themselves —
      // exactly as planned. Only reading each module back can catch a range that starts one byte
      // late.
      const structAt = before.modulesOffset + JS_IDS[3]! * before.structBytes;
      plan.data.writeUInt32LE(plan.data.readUInt32LE(structAt + 8) + 1, structAt + 8);
      expect(() => applyBundleWritePlan(path, plan)).toThrow(/did not read back/);
    });
  });
});
