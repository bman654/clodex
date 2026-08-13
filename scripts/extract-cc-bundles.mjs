#!/usr/bin/env node
// Extract the JavaScript bundle out of each pristine Claude Code native binary.
//
// The bundle is compressed inside the native binary, so raw byte greps do not work — this is the
// only way to read what the client actually does. See .claude/docs/claude-code-internals.md.
//
// Must run from inside this repo so `tweakcc` resolves from node_modules. Needs Node >= 22.18
// (or `--experimental-strip-types`) for the .ts import below; .nvmrc pins 24.
//
//   node scripts/extract-cc-bundles.mjs [outDir]
//
//   outDir            positional, else $REVIEW_BUNDLE_DIR, else <tmpdir>/cc-bundles
//   TWEAKCC_CONFIG_DIR   where the pristine *.orig backups live (default ~/.tweakcc)
//
// Extraction takes minutes per binary and each bundle is ~23 MB, so already-extracted files are
// left alone. Point REVIEW_BUNDLE_DIR at the same directory in your shell and the real-bundle
// harnesses will find them.

import { tryDetectInstallation, readContent } from 'tweakcc';
import {
  readdirSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { inspectEntryModule, shimEntryModuleName } from '../src/bun-entry-module.ts';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(
    'Usage: node scripts/extract-cc-bundles.mjs [outDir]\n\n' +
      '  outDir              positional, else $REVIEW_BUNDLE_DIR, else <tmpdir>/cc-bundles\n' +
      '  TWEAKCC_CONFIG_DIR  where pristine *.orig backups live (default ~/.tweakcc)\n\n' +
      'Already-extracted bundles are left alone. Point REVIEW_BUNDLE_DIR at the output so the\n' +
      'harnesses in .claude/harnesses/ can find them.',
  );
  process.exit(0);
}

const flags = args.filter((a) => a.startsWith('-'));
if (flags.length > 0) {
  console.error(`Unrecognized option: ${flags[0]}. Try --help.`);
  process.exit(1);
}
const positionals = args.filter((a) => !a.startsWith('-'));
if (positionals.length > 1) {
  console.error(`Expected at most one output directory, got ${positionals.length}. Try --help.`);
  process.exit(1);
}
const positional = positionals[0];

// A real bundle is ~20 MB; anything far below that is truncated, not cached.
const MIN_BUNDLE_BYTES = 1_000_000;

const srcDir = process.env['TWEAKCC_CONFIG_DIR'] || path.join(homedir(), '.tweakcc');
const outDir = positional || process.env['REVIEW_BUNDLE_DIR'] || path.join(tmpdir(), 'cc-bundles');

if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
  console.error(
    `No backup directory at ${srcDir}.\n` +
      `Pristine backups are created by \`clodex patch\`; set TWEAKCC_CONFIG_DIR to override.`,
  );
  process.exit(1);
}

const files = readdirSync(srcDir).filter((f) => f.endsWith('.orig'));
if (files.length === 0) {
  console.error(`No *.orig backups in ${srcDir}. Run \`clodex patch\` once to create one.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
console.log(`Extracting ${files.length} bundle(s) from ${srcDir} into ${outDir}`);

let ok = 0;
let cached = 0;
let failed = 0;

for (const f of files) {
  const target = path.join(outDir, f.replace(/\.orig$/, '.js'));
  // Treat an existing target as cached only if it is plausibly a whole bundle. A truncated or
  // zero-byte file would otherwise be reported as a success and then silently used as evidence
  // by the real-bundle harnesses.
  if (existsSync(target)) {
    const size = statSync(target).size;
    if (size >= MIN_BUNDLE_BYTES) {
      console.log('cached', f);
      cached++;
      continue;
    }
    console.log(`re-extracting ${f}: cached file is only ${size} bytes`);
  }
  // Claude Code 2.1.231 renamed the module tweakcc looks for. The rename that makes it
  // readable again is a write, so it happens on a scratch copy — these backups are the only
  // pristine bytes on the machine and nothing here may touch them.
  let readFrom = path.join(srcDir, f);
  let scratchDir;
  try {
    const state = inspectEntryModule(readFrom);
    if (state === 'unparseable') {
      // Distinguishing this from a name mismatch matters: tweakcc reports the same
      // "Failed to extract JavaScript" for both, and for the unrelated node-gyp-build fault.
      console.log(`NOTE ${f} has no readable Bun module list — extraction below is unshimmed`);
    }
    if (state === 'needs-shim') {
      scratchDir = mkdtempSync(path.join(tmpdir(), 'cc-bundle-'));
      const scratch = path.join(scratchDir, f);
      copyFileSync(readFrom, scratch);
      shimEntryModuleName(scratch);
      readFrom = scratch;
    }
    const inst = await tryDetectInstallation({ path: readFrom });
    if (!inst) throw new Error('tweakcc did not recognize the binary');
    const src = await readContent(inst);
    if (!src) throw new Error('readContent returned nothing');
    // These backups are only *named* pristine. clodex documents poisoned backups as reachable,
    // and a patched claude reports its version perfectly well — the patch marker is the only
    // thing that distinguishes them. Warn rather than refuse: reading a patched bundle is
    // sometimes exactly what you want, but never by accident.
    if (src.includes('/*ccpatch:')) {
      console.log(`WARN ${f} carries a clodex patch marker — this backup is NOT pristine`);
    }
    writeFileSync(target, src);
    console.log(`OK ${f} version=${inst.version} kind=${inst.kind} bytes=${src.length}`);
    ok++;
  } catch (e) {
    console.log('FAIL', f, String(e).slice(0, 200));
    failed++;
  } finally {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }
}

console.log(`\nextracted ${ok}, cached ${cached}, failed ${failed} → ${outDir}`);
if (ok + cached === 0) process.exit(1);
