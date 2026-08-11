// tests/helpers/parent-notice-probe.ts
//
// Runs OUTSIDE vitest, in a plain Node process, so `process.stderr` is a real
// pipe and the assertions are about actual fd-2 bytes. Vitest replaces the
// worker's console/stdio, which is precisely the thing this behavior is about,
// so an in-process test cannot measure it.
//
// Contract: argv[2] is a scratch directory. The probe
//   1. writes a fake `claude` that blocks until a sentinel file appears,
//   2. drives the REAL `launchClaude` (so the real mute is installed),
//   3. once the child is confirmed running, emits one parent notice and one
//      ordinary `process.stderr.write` (the control that MUST stay muted),
//   4. releases the child and waits for `launchClaude` to resolve.
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchClaude } from '../../src/launch.js';
import { emitParentNotice } from '../../src/parent-notice.js';

const NOTICE_TEXT = 'clodex: warning: probe-notice-must-reach-the-terminal';
const MUTED_TEXT = 'probe-plain-write-must-stay-muted';

const scratch = process.argv[2]!;
const withDebugFile = process.argv[3] === '--with-debug-file';
const started = join(scratch, 'child-started');
const release = join(scratch, 'child-release');
const debugFile = join(scratch, 'debug.log');
const fakeClaude = join(scratch, 'fake-claude.sh');

writeFileSync(
  fakeClaude,
  `#!/bin/sh\ntouch "${started}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done\nexit 0\n`,
);
chmodSync(fakeClaude, 0o755);

process.env['CLODEX_CLAUDE_PATH'] = fakeClaude;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const extraArgs = withDebugFile ? ['--debug-file', debugFile] : [];
  if (withDebugFile) writeFileSync(debugFile, '');
  const exit = launchClaude({ ...process.env }, undefined, extraArgs);

  for (let attempt = 0; attempt < 200 && !existsSync(started); attempt += 1) await sleep(25);
  if (!existsSync(started)) throw new Error('probe: fake claude never started');

  // The child owns the terminal right now — exactly the window in which clodex's
  // in-process gateway produces these diagnostics.
  emitParentNotice(NOTICE_TEXT);
  process.stderr.write(`${MUTED_TEXT}\n`);

  writeFileSync(release, '');
  const code = await exit;
  process.stderr.write(`probe-done exit=${code}\n`);
}

main().catch(err => {
  process.stderr.write(`probe-error ${String(err)}\n`);
  process.exit(1);
});
