// tests/helpers/parent-notice-probe.ts
//
// Runs OUTSIDE vitest, in a plain Node process, so `process.stderr` is a real
// fd and the assertions are about actual bytes. Vitest replaces the worker's
// console/stdio, which is precisely the thing this behavior is about, so an
// in-process test cannot measure it.
//
// Contract: argv[2] is a scratch directory, argv[3] an optional mode. The probe
//   1. writes a fake `claude` that prints CHILD-START, blocks until a sentinel
//      file appears (with its own deadline so it can never outlive the run),
//      then prints CHILD-LAST,
//   2. drives the REAL `launchClaude` (so the real mute is installed),
//   3. once the child is confirmed running, emits one parent notice and one
//      ordinary `process.stderr.write` (the control that MUST stay muted),
//   4. releases the child — or, in `--signal` mode, signals itself so the
//      forwarding handler tears the child down instead,
//   5. after `launchClaude` resolves, emits a second notice, which can only be
//      delivered if the launch released the sink.
//
// Every exit path releases the child in a `finally`.
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchClaude } from '../../src/launch.js';
import { emitParentNotice } from '../../src/parent-notice.js';

const NOTICE_TEXT = 'clodex: warning: probe-notice-must-reach-the-terminal';
const AFTER_EXIT_TEXT = 'clodex: warning: probe-notice-after-child-exit';
const MUTED_TEXT = 'probe-plain-write-must-stay-muted';

const scratch = process.argv[2]!;
const mode = process.argv[3] ?? '';
const withDebugFile = mode === '--with-debug-file';
const isEpipe = mode === '--epipe';
const isSignal = mode === '--signal';
const isFlood = mode === '--flood';
const started = join(scratch, 'child-started');
const release = join(scratch, 'child-release');
const debugFile = join(scratch, 'debug.log');
const fakeClaude = join(scratch, 'fake-claude.sh');

// The child polls for the release file but gives up on its own after ~30s, so a
// probe that is killed before its `finally` can still never orphan a live shell.
writeFileSync(
  fakeClaude,
  `#!/bin/sh\n`
  // Real Claude Code exits on SIGINT; a bare `sh` defers it while waiting on a
  // foreground `sleep`, which would make the forwarded-signal case measure the
  // shell instead of clodex.
  + `trap 'echo "CHILD-SIGINT"; exit 130' INT\n`
  + `echo "CHILD-START"\n`
  + `touch "${started}"\n`
  + `i=0\n`
  + `while [ ! -f "${release}" ]; do\n`
  + `  i=$((i+1))\n`
  + `  [ "$i" -gt 600 ] && break\n`
  + `  sleep 0.05\n`
  + `done\n`
  + `echo "CHILD-LAST"\n`
  + `exit 0\n`,
);
chmodSync(fakeClaude, 0o755);

process.env['CLODEX_CLAUDE_PATH'] = fakeClaude;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Bounded wait for the launch. The timer is unref'd and cleared so a probe that
 * finished normally exits immediately instead of lingering for the deadline.
 */
function awaitLaunch(exit: Promise<number>, ms: number): Promise<number> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(-1), ms);
    timer.unref();
    void exit.then(code => { clearTimeout(timer); resolve(code); });
  });
}

async function main(): Promise<void> {
  const extraArgs = withDebugFile ? ['--debug-file', debugFile] : [];
  if (withDebugFile) writeFileSync(debugFile, '');
  const exit = launchClaude({ ...process.env }, undefined, extraArgs);

  try {
    for (let attempt = 0; attempt < 400 && !existsSync(started); attempt += 1) await sleep(25);
    if (!existsSync(started)) throw new Error('probe: fake claude never started');

    // The child owns the terminal right now — exactly the window in which
    // clodex's in-process gateway produces these diagnostics.
    emitParentNotice(NOTICE_TEXT);
    process.stderr.write(`${MUTED_TEXT}\n`);

    // More notices than the launch queue holds: the overflow must be counted,
    // not accumulated, and not silently dropped either.
    if (isFlood) for (let n = 0; n < 55; n += 1) emitParentNotice(`clodex: flood-${n}`);

    if (isSignal) {
      // launchClaude forwards SIGINT to the child; the child's exit is what
      // reaches restore(), so the queue must still be flushed on this path.
      process.kill(process.pid, 'SIGINT');
    }
  } finally {
    // In --signal mode the forwarded signal is what must tear the child down, so
    // the release file is withheld until after the launch settles.
    if (!isSignal) writeFileSync(release, '');
  }

  const code = await awaitLaunch(exit, 20_000);
  // Belt and braces: whatever happened above, the child is now free to exit.
  try { writeFileSync(release, ''); } catch { /* scratch may be gone */ }

  // After the child is gone the sink must be released, so this one goes straight
  // to the terminal rather than into a queue nobody will ever flush.
  emitParentNotice(AFTER_EXIT_TEXT);
  // In the EPIPE case the terminal is a closed pipe: an ordinary write here
  // would take the process down for reasons that are not the channel's to fix.
  if (!isEpipe) process.stderr.write(`probe-done exit=${code}\n`);
}

main().catch(err => {
  process.stderr.write(`probe-error ${String(err)}\n`);
  process.exit(1);
});
