#!/usr/bin/env node
// Does `clodex patch`'s binary handling survive a round trip on a Claude Code build for ANOTHER
// platform?
//
// The patch sites themselves match against extracted JavaScript, which is near-identical on every
// platform — one platform covers them. Everything around the JavaScript is not: the entry-module
// shim, tweakcc's read, the repack, the restore and the Mach-O re-sign all depend on the container
// format, and that is the half that has broken. Every ELF build of Claude Code from 2.1.229 onward
// was unpatchable across two clodex releases while macOS stayed green, because nothing tested an
// ELF binary.
//
// This probe closes that gap without a Linux host: it never EXECUTES the binary, it only
// manipulates its bytes, so a linux-arm64 or win32-x64 binary can be probed from macOS. (Running it
// is what `clodex patch` itself needs — it resolves the version by executing the binary — which is
// why full-patch coverage for Linux needs a container and this does not.)
//
//   node scripts/probe-patch-mechanism.mjs <claude-binary> [options]
//
//     --json             emit one JSON object on stdout and nothing else
//     --label NAME       how this binary is named in the output (default: its parent dir name)
//     --expect-version V fail unless the binary is that Claude Code release
//     --scratch DIR      where the ~300 MB working copy goes (default: a fresh tmpdir)
//     --keep             leave the scratch copy behind for inspection
//
// Exit status is 0 only when every check passed, so a shell caller can branch on that alone.
//
// Must run from inside this repo so `tweakcc` resolves from node_modules. Needs Node >= 22.18 (or
// `--experimental-strip-types`) for the .ts import below; .nvmrc pins 24.

import {
  closeSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inspectEntryModule,
  restoreEntryModuleName,
  shimEntryModuleName,
} from '../src/bun-entry-module.ts';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(
    'Usage: node scripts/probe-patch-mechanism.mjs <claude-binary> [options]\n\n' +
      '  --json              emit one JSON object on stdout and nothing else\n' +
      '  --label NAME        how this binary is named in the output\n' +
      '  --expect-version V  fail unless the binary is that Claude Code release\n' +
      '  --scratch DIR       where the ~300 MB working copy goes\n' +
      '  --keep              leave the scratch copy behind\n\n' +
      'Exercises the shim/read/repack/restore cycle `clodex patch` runs, without executing the\n' +
      'binary — so a build for any platform can be probed from any host. Exits 0 only if every\n' +
      'check passed.',
  );
  process.exit(0);
}

const opts = { json: false, keep: false, label: '', scratch: '', expectVersion: '' };
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') opts.json = true;
  else if (arg === '--keep') opts.keep = true;
  else if (arg === '--label') opts.label = args[++i] ?? '';
  else if (arg === '--expect-version') opts.expectVersion = args[++i] ?? '';
  else if (arg === '--scratch') opts.scratch = args[++i] ?? '';
  else if (arg.startsWith('-')) {
    console.error(`Unrecognized option: ${arg}. Try --help.`);
    process.exit(1);
  } else positionals.push(arg);
}
if (positionals.length !== 1) {
  console.error(`Expected exactly one binary path, got ${positionals.length}. Try --help.`);
  process.exit(1);
}

const binary = path.resolve(positionals[0]);
if (!statSync(binary, { throwIfNoEntry: false })?.isFile()) {
  console.error(`Not a file: ${binary}`);
  process.exit(1);
}
const label = opts.label || path.basename(path.dirname(binary));

// tweakcc keeps its own backups and config beside whatever this points at. The probe must never
// write into a real ~/.tweakcc, so it is redirected into the scratch dir unless the caller has
// already chosen somewhere — and before tweakcc is imported, in case it reads the variable then.
let scratchDir = opts.scratch ? path.resolve(opts.scratch) : '';
if (scratchDir) mkdirSync(scratchDir, { recursive: true });
else scratchDir = mkdtempSync(path.join(tmpdir(), 'clodex-probe-'));
if (!process.env['TWEAKCC_CONFIG_DIR']) {
  const dir = path.join(scratchDir, 'tweakcc');
  mkdirSync(dir, { recursive: true });
  process.env['TWEAKCC_CONFIG_DIR'] = dir;
}

const { tryDetectInstallation, readContent, writeContent } = await import('tweakcc');

// What the probe writes into the bundle. Long enough not to occur by chance, and identifiable in a
// binary that somehow escapes cleanup.
const PROBE_MARKER = '/*clodex-probe-patch-mechanism*/';

const checks = [];
const info = { label, binary, checks: [] };
let failed = 0;

// name    stable identifier a caller can branch on
// ok      did it hold
// detail  what was actually observed — the thing worth reading in a Slack alert
function record(name, ok, detail) {
  checks.push(name);
  info.checks.push({ name, ok, detail });
  if (!ok) failed++;
  if (!opts.json) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function note(message) {
  if (!opts.json) console.log(`     ${message}`);
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Which container the binary is, read from its own magic rather than from the package name — the
// name is a label, the magic is the thing that decides which code path tweakcc takes.
function containerFormat(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    if (head.toString('latin1') === '\x7fELF') return 'elf';
    if (head.toString('latin1', 0, 2) === 'MZ') return 'pe';
    const magic = head.readUInt32BE(0);
    // 32/64-bit Mach-O in either endianness, plus the fat wrapper.
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) {
      return 'macho';
    }
    return `unknown(0x${magic.toString(16)})`;
  } finally {
    closeSync(fd);
  }
}

// Every byte occurrence of `needle`, module name or not. Streaming, because these binaries are
// ~300 MB and a match can straddle any read boundary.
function countOccurrences(file, needle) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const pattern = Buffer.from(needle);
    const chunkBytes = 8 * 1024 * 1024;
    let carry = Buffer.alloc(0);
    let found = 0;
    for (let position = 0; position < size; ) {
      const length = Math.min(chunkBytes, size - position);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, position);
      const window = carry.length > 0 ? Buffer.concat([carry, buf]) : buf;
      for (let at = window.indexOf(pattern); at >= 0; at = window.indexOf(pattern, at + 1)) found++;
      carry = Buffer.from(window.subarray(Math.max(0, window.length - (pattern.length - 1))));
      position += length;
    }
    return found;
  } finally {
    closeSync(fd);
  }
}

const started = Date.now();
const scratch = path.join(scratchDir, 'claude');
let exitCode = 1;

try {
  info.format = containerFormat(binary);
  info.pristineSize = statSync(binary).size;
  note(`${label}: ${info.format}, ${info.pristineSize} bytes`);

  copyFileSync(binary, scratch);
  const pristineSha = await sha256(scratch);

  // ---- 1. can the pristine binary be read at all? -------------------------------------------
  info.entryState = inspectEntryModule(scratch);
  record(
    'pristine-parses',
    info.entryState !== 'unparseable',
    `entry module is ${info.entryState}`,
  );
  if (info.entryState === 'unparseable') throw new Error('nothing further can be probed');

  // ---- 2. seed the candidate, exactly as patcher.ts does ------------------------------------
  // The shim is undone immediately so the seeded copy is byte-identical to the source: clodex
  // publishes these bytes as the pristine backup under a content address, so a shim left in place
  // (or a stray re-sign) would poison a backup that is supposed to be Claude Code's own bytes.
  const readShim = shimEntryModuleName(scratch);
  info.shimUsed = readShim !== null;
  info.entryModuleName = readShim?.original ?? null;
  const installation = await tryDetectInstallation({ path: scratch });
  record(
    'tweakcc-detects',
    Boolean(installation),
    installation
      ? `version ${installation.version}, kind ${installation.kind}`
      : 'tryDetectInstallation returned nothing',
  );
  if (!installation) throw new Error('nothing further can be probed');
  info.detectedVersion = installation.version ?? null;

  // The probe never runs the binary, so this is the only confirmation that the bytes under test
  // are the release they were asked for — worth having before a mismatch is reported as the
  // release being broken.
  if (opts.expectVersion) {
    record(
      'expected-version',
      info.detectedVersion === opts.expectVersion,
      `binary is ${info.detectedVersion}, expected ${opts.expectVersion}`,
    );
  }

  const source = await readContent(installation);
  record('read-content', Boolean(source) && source.length > 1_000_000, `${source ? source.length : 0} bytes of JavaScript`);
  if (!source) throw new Error('nothing further can be probed');
  info.sourceBytes = source.length;
  info.readMs = Date.now() - started;

  if (readShim) restoreEntryModuleName(scratch, readShim, { resign: false });
  record(
    'seed-round-trip',
    (await sha256(scratch)) === pristineSha,
    'the copy the pristine backup is taken from is byte-identical to the release',
  );

  // ---- 3. repack, then put the real entry-module name back ----------------------------------
  const repackStarted = Date.now();
  const writeShim = shimEntryModuleName(scratch);
  await writeContent(installation, `${source}\n${PROBE_MARKER}\n`);
  let restoreError = null;
  if (writeShim) {
    try {
      restoreEntryModuleName(scratch, writeShim, { resign: true });
    } catch (err) {
      restoreError = err instanceof Error ? err.message : String(err);
    }
  }
  info.repackMs = Date.now() - repackStarted;
  info.publishedSize = statSync(scratch).size;
  info.growth = Number((info.publishedSize / info.pristineSize).toFixed(3));
  note(`repacked to ${info.publishedSize} bytes (${info.growth}x)`);
  record(
    'restore-entry-name',
    restoreError === null,
    restoreError ?? 'the real entry-module name went back on after the repack',
  );

  // ---- 4. is the binary that WOULD be published actually sound? -----------------------------
  // Reading OK from the steps above is not evidence of that: the checks below are on the bytes
  // that would be renamed over the live install.
  if (writeShim) {
    info.standInSurvivors = countOccurrences(scratch, writeShim.marker);
    record(
      'no-stand-in',
      info.standInSurvivors === 0,
      info.standInSurvivors === 0
        ? `no ${writeShim.marker} left in the published bytes`
        : `${info.standInSurvivors} copy/copies of ${writeShim.marker} survived — Claude Code would fail to resolve its sibling native modules`,
    );
  }

  const publishedState = inspectEntryModule(scratch);
  record(
    'published-parses',
    publishedState === info.entryState,
    publishedState === info.entryState
      ? `entry module is ${publishedState}, as it was before`
      : `entry module went from ${info.entryState} to ${publishedState}`,
  );

  // The published binary carries Claude Code's own module name, so it has to be shimmed again to
  // be readable — and unshimmed again afterwards, or this leaves behind a binary that cannot run
  // and reports a failure that is the probe's own doing.
  const verifyShim = shimEntryModuleName(scratch);
  record(
    'entry-name-restored',
    !writeShim || verifyShim?.original === writeShim.original,
    verifyShim
      ? `published entry module is named ${JSON.stringify(verifyShim.original)}`
      : 'published binary needs no shim (its entry module is already one tweakcc recognizes)',
  );
  try {
    const verifyInstallation = await tryDetectInstallation({ path: scratch });
    const republished = verifyInstallation ? await readContent(verifyInstallation) : '';
    record(
      'published-content',
      republished.includes(PROBE_MARKER),
      republished
        ? `${republished.length} bytes read back${republished.includes(PROBE_MARKER) ? ', carrying the probe marker' : ' but WITHOUT the probe marker — the repack did not land'}`
        : 'the published binary yields no JavaScript — a patched install would be unreadable and unpatchable',
    );
  } finally {
    // Undoing the verification shim is housekeeping, not a check: leaving it on would hand an
    // investigator a binary that cannot run and a symptom the probe invented. When it fails for
    // the same reason `restore-entry-name` already reported, saying so twice only pads the alert.
    try {
      if (verifyShim) restoreEntryModuleName(scratch, verifyShim, { resign: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (info.checks.every((c) => c.name !== 'restore-entry-name' || c.ok)) {
        record('cleanup-restore', false, detail);
      } else {
        note(`cleanup restore also failed: ${detail}`);
      }
    }
  }

  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail !== 'nothing further can be probed') {
    record('probe-completed', false, detail);
  }
  exitCode = 1;
} finally {
  info.durationMs = Date.now() - started;
  info.failed = failed;
  info.verdict = failed === 0 ? 'pass' : 'fail';
  info.reasons = info.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  if (opts.keep) {
    info.scratch = scratch;
  } else {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(info)}\n`);
  else console.log(`${info.verdict.toUpperCase()} ${label} — ${checks.length} checks in ${Math.round(info.durationMs / 1000)}s`);
}

process.exit(exitCode);
