#!/usr/bin/env node
// Extract the JavaScript bundle out of each pristine Claude Code native binary.
//
// The bundle is compressed inside the native binary, so raw byte greps do not work — this is the
// only way to read what the client actually does. See .claude/docs/claude-code-internals.md.
//
// Must run from inside this repo so `tweakcc` resolves from node_modules.
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
import { readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const srcDir = process.env['TWEAKCC_CONFIG_DIR'] || path.join(homedir(), '.tweakcc');
const outDir =
  process.argv[2] || process.env['REVIEW_BUNDLE_DIR'] || path.join(tmpdir(), 'cc-bundles');

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
  if (existsSync(target)) {
    console.log('cached', f);
    cached++;
    continue;
  }
  try {
    const inst = await tryDetectInstallation({ path: path.join(srcDir, f) });
    if (!inst) throw new Error('tweakcc did not recognize the binary');
    const src = await readContent(inst);
    if (!src) throw new Error('readContent returned nothing');
    writeFileSync(target, src);
    console.log(`OK ${f} version=${inst.version} kind=${inst.kind} bytes=${src.length}`);
    ok++;
  } catch (e) {
    console.log('FAIL', f, String(e).slice(0, 200));
    failed++;
  }
}

console.log(`\nextracted ${ok}, cached ${cached}, failed ${failed} → ${outDir}`);
if (ok + cached === 0) process.exit(1);
