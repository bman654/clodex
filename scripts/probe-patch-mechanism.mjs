#!/usr/bin/env node
// Would `clodex patch` work on a Claude Code build for ANOTHER platform?
//
// Two separable halves, and this answers both without ever EXECUTING the binary — which is what
// lets a linux-arm64 or win32-x64 build be checked from macOS. (Running it is what `clodex patch`
// itself needs, since it resolves the version by executing the binary; that is why full-patch
// coverage for Linux needs a container and this does not.)
//
//   the container   the entry-module shim, tweakcc's read, the repack, the restore and the Mach-O
//                   re-sign all depend on the executable format. Every ELF build of Claude Code
//                   from 2.1.229 onward was unpatchable across two clodex releases while macOS
//                   stayed green, because nothing tested an ELF binary.
//   the patch sites the anchors clodex matches in the extracted JavaScript. These were long
//                   assumed to be platform-independent — "one platform covers them all". 2.1.238
//                   proved otherwise: `PATCH 5: model picker options` matched on five builds and
//                   not on linux-arm64, linux-arm64-musl or win32-arm64. So this probe applies the
//                   real transforms to the real bundle it extracted from THIS build, and publishes
//                   what they produced rather than the pristine bytes.
//
// Read the second half precisely, because it changed. tweakcc's repack is no longer given the
// patched bundle at all — it is given a placeholder, purely to resize the container's Bun section,
// and clodex publishes the patched blob over that section itself. So the readback below proves the
// RESIZE works on this format and that clodex's own publish round-trips byte for byte; it no longer
// proves anything about the patched bytes surviving tweakcc's rebuild, because they never enter it.
//
// What it still does NOT establish, and must never be reported as if it did: the patched binary is
// never started, so nothing here says a PE runs on Windows or an ELF runs on Linux. And an anchor
// that binds to the WRONG function while still emitting valid JavaScript passes every check below.
// Only the host and container legs of the canary run the patched binary.
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
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inspectEntryModule,
  listBunModuleNames,
  readBunModuleTable,
  resignMachOBinary,
  restoreEntryModuleName,
  shimEntryModuleName,
} from '../src/bun-entry-module.ts';
// bun-compiled-pointer.ts imports nothing relative either, so a static import is safe here.
import {
  restoreBunCompiledPointer,
  shimBunCompiledPointer,
} from '../src/bun-compiled-pointer.ts';

// `src/` spells its own imports the TypeScript way — `./model-aliases.js` for a file that is
// really `./model-aliases.ts`. tsup and vitest both understand that; bare `node` does not, and
// resolves it to a file that does not exist. bun-entry-module.ts happens to import nothing
// relative, which is why the static import above works; patch-transforms.ts does, so it is loaded
// dynamically BELOW this hook — a static import would be resolved before this line ever runs.
// Guarded on the sibling .ts actually existing, so a real .js file is never redirected.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (candidate.protocol === 'file:' && existsSync(candidate)) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { checkPatchSites } = await import('./probe-patch-sites.mjs');
// Same reason as above: bun-bundle.ts imports a sibling the TypeScript way, so it can only be
// loaded once the resolve hook is installed.
const {
  applyBundleWritePlan,
  PLACEHOLDER_SLACK_BYTES,
  planBundleWrite,
  readClaudeBundle,
  splitBundleSource,
  writableModuleIndex,
} = await import('../src/bun-bundle.ts');

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(
    'Usage: node scripts/probe-patch-mechanism.mjs <claude-binary> [options]\n\n' +
      '  --json              emit one JSON object on stdout and nothing else\n' +
      '  --label NAME        how this binary is named in the output\n' +
      '  --expect-version V  fail unless the binary is that Claude Code release\n' +
      '  --scratch DIR       where the ~300 MB working copy goes\n' +
      '  --keep              leave the scratch copy behind\n\n' +
      'Applies every clodex patch site to this build\'s own bundle and runs the shim/read/repack/\n' +
      'restore cycle `clodex patch` runs — without executing the binary, so a build for any\n' +
      'platform can be probed from any host. It does NOT start the patched binary. Exits 0 only\n' +
      'if every check passed.',
  );
  process.exit(0);
}

const opts = { json: false, keep: false, label: '', scratch: '', expectVersion: '' };
const positionals = [];
// A missing value must be an error, not a silent one. `--label --json` used to name the binary
// "--json" AND turn JSON output off, and a trailing `--expect-version` left the version
// unvalidated — so a mistyped command reported PASS for a release it never checked.
const value = (flag, i) => {
  const next = args[i];
  if (next === undefined || next.startsWith('-') || next === '') {
    console.error(`${flag} needs a value. Try --help.`);
    process.exit(1);
  }
  return next;
};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') opts.json = true;
  else if (arg === '--keep') opts.keep = true;
  else if (arg === '--label') opts.label = value(arg, ++i);
  else if (arg === '--expect-version') opts.expectVersion = value(arg, ++i);
  else if (arg === '--scratch') opts.scratch = value(arg, ++i);
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
// Always a private subdirectory, even under a caller-supplied --scratch. Writing `claude` and
// `tweakcc/` straight into the given directory clobbered anything already named that, deleted it
// on the way out, made two concurrent probes fight over the same files, and — when the binary
// under test lived in the directory handed to --scratch — deleted the input itself.
const scratchRoot = opts.scratch ? path.resolve(opts.scratch) : tmpdir();
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(path.join(scratchRoot, 'clodex-probe-'));
if (!process.env['TWEAKCC_CONFIG_DIR']) {
  const dir = path.join(scratchDir, 'tweakcc');
  mkdirSync(dir, { recursive: true });
  process.env['TWEAKCC_CONFIG_DIR'] = dir;
}

const { tryDetectInstallation, readContent, writeContent } = await import('tweakcc');

// What the probe writes into the bundle. Long enough not to occur by chance, and identifiable in a
// binary that somehow escapes cleanup.
const PROBE_MARKER = '/*clodex-probe-patch-mechanism*/';

// ...and enough of it to make the bundle bigger. tweakcc only extends the Mach-O segment when the
// repacked bundle exceeds the section it came from, and an identity repack SHRINKS it by ~61 bytes,
// so a token-sized marker leaves that branch — page rounding, segment extension, re-signing a
// binary whose segment actually moved — untested, while every real patch takes it. The patch sites
// add kilobytes; so does this.
const PROBE_PADDING = `\n/*${'clodex-probe-padding'.repeat(4096)}*/\n`;

// Default signal handling does not unwind through the `finally` that cleans up, so an interrupted
// run would strand a scratch tree of up to ~770 MB.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!opts.keep) rmSync(scratchDir, { recursive: true, force: true });
    process.exit(130);
  });
}

const checks = [];
const info = { label, binary, checks: [] };
let failed = 0;

// name     stable identifier a caller can branch on
// ok       did it hold
// detail   what was actually observed — the thing worth reading in a Slack alert
// reasons  how a failure should be phrased in the canary's alert, when `name: detail` is the
//          wrong shape. The patch-site check needs this: it can hold several distinct findings,
//          and its main one has to read exactly as the host and container legs word it so that
//          one anchor broken on four builds collapses to a single line instead of four.
function record(name, ok, detail, reasons) {
  checks.push(name);
  info.checks.push({ name, ok, detail, ...(reasons ? { reasons } : {}) });
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
    // Kept in step with isMachO in src/bun-entry-module.ts: thin 32/64 in both byte orders, plus
    // both fat wrappers. A magic this list misses is reported as unknown, which silently skips the
    // signature check on a binary the patcher does re-sign.
    const MACH_O_MAGIC = [
      0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca,
    ];
    if (MACH_O_MAGIC.includes(magic)) return 'macho';
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
  info.pristineMode = statSync(binary).mode & 0o777;
  note(`${label}: ${info.format}, ${info.pristineSize} bytes`);

  // --label is otherwise pure decoration, so probing one binary eight times under eight platform
  // names would report eight greens and look like full coverage. The magic is the file's own
  // testimony; where the label claims a platform, the two must agree. (Arch cannot be checked this
  // way — nothing here reads e_machine/cputype — so linux-x64 vs linux-arm64 stays unverified.)
  // Keyed on the whole published platform name, not its first component: --label is documented as
  // free text, and treating any "linux-…" as a platform claim would fail a PE artifact somebody
  // labelled "linux-reference".
  const EXPECTED_FORMAT = {
    'darwin-arm64': 'macho', 'darwin-x64': 'macho',
    'linux-arm64': 'elf', 'linux-x64': 'elf',
    'linux-arm64-musl': 'elf', 'linux-x64-musl': 'elf',
    'win32-arm64': 'pe', 'win32-x64': 'pe',
  };
  const claimed = EXPECTED_FORMAT[label];
  if (claimed) {
    record(
      'label-matches-format',
      claimed === info.format,
      `${label} should be ${claimed}, the bytes say ${info.format}`,
    );
  }

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
  const pristineModules = listBunModuleNames(scratch) ?? [];
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

  // The whole bundle, not just the module tweakcc names: since 2.1.242 that module is a stub and
  // every anchor clodex matches lives in a sibling chunk. `clodex patch` reads it the same way, so
  // a build whose split shape defeats the reader is caught here rather than on a user's machine.
  const bundle = readClaudeBundle(scratch);
  const source = bundle ? bundle.source : await readContent(installation);
  record(
    'read-content',
    Boolean(source) && source.length > 1_000_000,
    `${source ? source.length : 0} bytes of JavaScript`
      + (bundle ? ` across ${bundle.modules.length} module(s)` : ' (tweakcc single-module read)'),
  );
  if (!source) throw new Error('nothing further can be probed');
  info.sourceBytes = source.length;
  info.bundleModules = bundle ? bundle.modules.length : null;
  info.readMs = Date.now() - started;

  if (readShim) restoreEntryModuleName(scratch, readShim, { resign: false });
  record(
    'seed-round-trip',
    (await sha256(scratch)) === pristineSha,
    'the copy the pristine backup is taken from is byte-identical to the release',
  );

  // ---- 3. do clodex's patch sites still land in THIS build's bundle? ------------------------
  // The half that used to be taken on faith. Every anchor is matched against the JavaScript that
  // came out of this specific binary, with a synthetic config that turns on every site — so a
  // build whose picker, resolver or context anchor drifted is caught here even when no host of
  // that platform exists to run the real command.
  const patchStarted = Date.now();
  const patch = checkPatchSites(source);
  info.patchSites = patch.sites;
  info.patchSiteSummary = patch.summary;
  info.patchMs = Date.now() - patchStarted;
  record(
    'patch-sites-apply',
    patch.failures.length === 0,
    patch.failures.length === 0
      ? `all ${patch.summary.total} patch sites applied to this build's own bundle`
      : patch.failures.join(' | '),
    patch.failures,
  );

  // ---- 4. repack, then put the real entry-module name back ----------------------------------
  // What goes back in is the PATCHED bundle, not the pristine one: publishing bytes nobody patched
  // would leave the thing users actually receive — clodex's emitted patch, kilobytes of it,
  // surviving a PE/ELF/Mach-O round trip — unproven by the byte-for-byte readback below. When the
  // patch aborted there is nothing patched to write, so the pristine source stands in and the
  // container half is still measured; `patch-sites-apply` above has already reported the abort.
  const repackStarted = Date.now();
  const written = `${patch.patchedSource ?? source}\n${PROBE_MARKER}${PROBE_PADDING}`;
  const writeShim = shimEntryModuleName(scratch);
  let publishedBlob = false;
  let publishedPlan = null;
  if (bundle) {
    const writable = writableModuleIndex(scratch);
    if (writable === null) throw new Error('no module of this build carries a name tweakcc can write to');
    const plan = planBundleWrite(scratch, bundle, splitBundleSource(bundle, written), writable);
    // Mirrors patcher.ts: without this the ELF repack cannot find the global Bun reads its blob's
    // address from on Claude Code 2.1.257, and the probe reports a repack failure that has nothing
    // to do with this build's anchors. See src/bun-compiled-pointer.ts.
    const bunPointerShim = shimBunCompiledPointer(scratch);
    await writeContent(installation, plan.content);
    if (bunPointerShim) restoreBunCompiledPointer(scratch, bunPointerShim);
    publishedPlan = plan;
    applyBundleWritePlan(scratch, plan);
    publishedBlob = true;
  } else {
    const bunPointerShim = shimBunCompiledPointer(scratch);
    await writeContent(installation, written);
    if (bunPointerShim) restoreBunCompiledPointer(scratch, bunPointerShim);
  }
  let restoreError = null;
  if (writeShim) {
    try {
      restoreEntryModuleName(scratch, writeShim, { resign: true });
    } catch (err) {
      restoreError = err instanceof Error ? err.message : String(err);
    }
  } else if (publishedBlob) {
    resignMachOBinary(scratch);
  }
  info.repackMs = Date.now() - repackStarted;
  info.publishedSize = statSync(scratch).size;
  info.growth = Number((info.publishedSize / info.pristineSize).toFixed(3));
  // Growth is now structural: the placeholder is sized for the pristine blob plus the appended
  // sources plus slack, so the section always extends. `repack-grew` is kept because a build where
  // it somehow did NOT grow would mean the sizing collapsed, but it is no longer the interesting
  // number — `blob-sized-as-planned` below is.
  info.sizeDelta = info.publishedSize - info.pristineSize;
  note(`repacked to ${info.publishedSize} bytes (${info.growth}x, ${info.sizeDelta >= 0 ? '+' : ''}${info.sizeDelta})`);
  record(
    'repack-grew',
    info.sizeDelta > 0,
    `${info.sizeDelta >= 0 ? '+' : ''}${info.sizeDelta} bytes — a repack that did not grow leaves the segment-extension path untested`,
  );
  // The one check that pins `repackedBlobBytes` — clodex's arithmetic mirror of tweakcc's rebuild —
  // against the real thing, on this build's real module table. A unit test cannot: it can only
  // compare the mirror to a fixture that models the same rebuild. If the mirror is exact, the blob
  // the repack produced is the planned one plus exactly the slack; if it drifts, the placeholder is
  // mis-sized on every patch of this release and only the size of the slack is hiding it.
  if (publishedPlan) {
    const repackedTable = readBunModuleTable(scratch);
    const expected = publishedPlan.data.length + PLACEHOLDER_SLACK_BYTES;
    info.blobSizeDrift = repackedTable ? repackedTable.byteCount - expected : null;
    record(
      'blob-sized-as-planned',
      info.blobSizeDrift === 0,
      info.blobSizeDrift === null
        ? 'the repacked blob could not be read back'
        : `the repack made a ${expected + info.blobSizeDrift}-byte blob where clodex sized the `
          + `placeholder for ${expected} (drift ${info.blobSizeDrift})`,
    );
  }
  record(
    'restore-entry-name',
    restoreError === null,
    restoreError
      ?? (writeShim
        ? 'the real entry-module name went back on after the repack'
        : 'no shim was needed, so there was no entry-module name to put back'),
  );

  // ---- 5. is the binary that WOULD be published actually sound? -----------------------------
  // Reading OK from the steps above is not evidence of that: the checks below are on the bytes
  // that would be renamed over the live install.
  if (writeShim) {
    info.standInSurvivors = countOccurrences(scratch, writeShim.marker);
    record(
      'no-stand-in',
      info.standInSurvivors === 0,
      info.standInSurvivors === 0
        ? `no ${writeShim.marker} left in the published bytes`
        : `${info.standInSurvivors} copy/copies of ${writeShim.marker} survived; if any of them is a module name, Claude Code fails to resolve its sibling native modules`,
    );
  }

  // The probe never runs the binary, so a Mach-O whose signature the repack invalidated would
  // otherwise sail through here and only be caught on the one platform that executes it. codesign
  // reads any Mach-O, so this covers darwin-x64 from an arm64 host too.
  if (info.format === 'macho' && process.platform !== 'darwin') {
    // Saying nothing here would make a Linux run of this probe indistinguishable from a macOS one
    // that verified the signature.
    info.notChecked = [...(info.notChecked ?? []), 'signature-valid'];
    note('signature-valid was NOT checked: codesign needs a macOS host');
  }
  if (info.format === 'macho' && process.platform === 'darwin') {
    let signatureError = null;
    try {
      execFileSync('codesign', ['--verify', '--strict', scratch], { stdio: 'pipe' });
    } catch (err) {
      signatureError = (err.stderr?.toString() || err.message || String(err)).trim().split('\n')[0];
    }
    record(
      'signature-valid',
      signatureError === null,
      // Not "so it can be executed": a signed Mach-O with mode 0644 verifies and still will not
      // run. The executable bit is checked separately, below.
      signatureError ?? 'the Mach-O signature verifies after the repack and the name restore',
    );
  }

  // Every check around this one can be green on a file that will not start: the patcher renames
  // the candidate over the live install, and a repack that stopped preserving the mode would ship
  // an unrunnable Claude Code with a perfectly valid signature. The question is whether the repack
  // CHANGED the mode, not whether the file is executable — a Windows build unpacked from its npm
  // tarball is 0644 and correctly so.
  // ELF and Mach-O only: the execute bit is what the kernel consults for those, whereas a PE is
  // launched by Windows on its extension and tweakcc's PE path legitimately writes 0644 — asserting
  // it there would fail every Windows build for a property nothing depends on.
  if (info.format === 'elf' || info.format === 'macho') {
    const publishedMode = statSync(scratch).mode & 0o777;
    record(
      'mode-preserved',
      publishedMode === info.pristineMode,
      publishedMode === info.pristineMode
        ? `mode ${publishedMode.toString(8)}, unchanged by the repack`
        : `mode went from ${info.pristineMode.toString(8)} to ${publishedMode.toString(8)} — the published binary would not start`,
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
    const republishedBundle = readClaudeBundle(scratch);
    const republished = republishedBundle
      ? republishedBundle.source
      : (verifyInstallation ? await readContent(verifyInstallation) : '');
    // Exact equality, not "the marker is in there". Checking only for the marker passed a mutation
    // that dropped the first byte of Claude Code's entry JavaScript: a repack that flips, drops,
    // duplicates or re-encodes source bytes while carrying the marker through is precisely the
    // silent corruption this is here to catch, and it would ship a broken install reporting OK.
    let mismatch = '';
    if (!republished) mismatch = 'the published binary yields no JavaScript at all';
    else if (republished.length !== written.length) {
      mismatch = `read back ${republished.length} bytes, wrote ${written.length}`;
    } else if (republished !== written) {
      let at = 0;
      while (at < written.length && written[at] === republished[at]) at++;
      mismatch = `the bytes differ from what was written, first at offset ${at}`;
    }
    record(
      'published-content',
      mismatch === '',
      mismatch || `${republished.length} bytes read back, byte-for-byte what was written`,
    );

    // `published-content` compares the readback against what this probe CHOSE to write, so it is
    // silent about whether that was the patched bundle or the pristine one — repack the wrong
    // string and it stays green. This is the independent half: the bytes that would be published
    // must carry the markers clodex's own transforms emitted, which is the same evidence the host
    // and container legs take from the real patched binary.
    //
    // Read off the patched bundle rather than hard-coded, so a new marker is covered the day it
    // is added and a renamed one does not fail here for a reason that has nothing to do with the
    // release.
    const emitted = [...new Set(patch.patchedSource?.match(/ccpatch:[a-zA-Z0-9_-]+/g) ?? [])];
    info.patchMarkers = emitted;
    if (emitted.length === 0) {
      // Only reachable when the patch aborted; `patch-sites-apply` has already said so.
      info.notChecked = [...(info.notChecked ?? []), 'published-carries-patch'];
      note('published-carries-patch was NOT checked: the patch produced no bundle to look for');
    } else {
      const absent = emitted.filter((marker) => !republished.includes(marker));
      record(
        'published-carries-patch',
        absent.length === 0,
        absent.length === 0
          ? `the published bytes carry all ${emitted.length} clodex patch markers (${emitted.join(', ')})`
          : `the published bytes are missing ${absent.join(', ')} — what was repacked is not what the patch produced`,
      );
    }
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

  // Taken here, on the bytes that would actually be published — after the verification shim is
  // undone. Read while that shim is on, the entry module still carries the stand-in name and this
  // reports a change that is the probe's own doing.
  //
  // A repack can rebuild a perfectly valid module table and still lose or reorder a sibling — an
  // image or audio helper, say. The entry module reads, the signature verifies, every check above
  // is green, and the feature that needed the missing module fails in front of a user.
  const publishedModules = listBunModuleNames(scratch) ?? [];
  const lost = pristineModules.filter((n) => !publishedModules.includes(n));
  const gained = publishedModules.filter((n) => !pristineModules.includes(n));
  // ORDER, not just membership. This used to compare the two as sets, so a repack that kept every
  // module but shuffled the table read as green — and clodex now addresses each patched module by
  // its table position, so a silent reorder between the read and the write is exactly the shape
  // that would point a module at its neighbour's source.
  const reordered = lost.length === 0 && gained.length === 0
    && pristineModules.some((name, at) => publishedModules[at] !== name);
  info.moduleCount = { pristine: pristineModules.length, published: publishedModules.length };
  record(
    'modules-intact',
    lost.length === 0 && gained.length === 0 && !reordered
      && pristineModules.length === publishedModules.length,
    reordered
      ? 'the repack kept every module but changed their order in the table'
      : lost.length === 0 && gained.length === 0
        ? `all ${publishedModules.length} modules survived the repack, in the same order`
        : `the repack changed the module list — lost [${lost.slice(0, 5).join(', ')}], gained [${gained.slice(0, 5).join(', ')}]`,
  );

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
  info.reasons = info.checks
    .filter((c) => !c.ok)
    .flatMap((c) => c.reasons ?? [`${c.name}: ${c.detail}`]);
  // scratchDir is always one this run made, so removing it wholesale takes nothing that was not
  // put there by this run.
  if (opts.keep) info.scratch = scratch;
  else rmSync(scratchDir, { recursive: true, force: true });
  if (opts.json) process.stdout.write(`${JSON.stringify(info)}\n`);
  else console.log(`${info.verdict.toUpperCase()} ${label} — ${checks.length} checks in ${Math.round(info.durationMs / 1000)}s`);
}

process.exit(exitCode);
