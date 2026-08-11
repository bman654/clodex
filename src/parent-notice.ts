// src/parent-notice.ts
import { writeSync } from 'node:fs';

/**
 * The one channel bounded parent-side diagnostics use to reach the terminal.
 *
 * `launchClaude` replaces `process.stdout.write`/`process.stderr.write` for the
 * entire lifetime of the spawned Claude Code, because the child inherits the
 * terminal and a stray parent write corrupts its TUI. clodex's gateway/MITM,
 * however, runs in that same process and handles every translated request while
 * the child is alive — so the few warnings that are documented as reaching
 * stderr (the reasoning- and tool-argument normalization canaries, the retry
 * clamp notice) were written straight into the mute and were never seen.
 *
 * This channel is deliberately OPT-IN and enumerable: a caller must import
 * `emitParentNotice` to reach the terminal. There is no prefix sniffing or other
 * content-based rule, because a prefix is not a safety boundary — diagnostic
 * data gets interpolated into messages, and a future writer would silently
 * inherit the bypass. What can reach the terminal is exactly the set of
 * `emitParentNotice` call sites.
 *
 * It does NOT interleave with the child. A notice raised while Claude Code owns
 * the terminal is handed to the sink `launchClaude` installs, which queues it
 * and flushes after the child exits; painting it live lands wherever the child
 * left the shared cursor — mid-frame, or right after the prompt where it reads
 * as typed input (both observed against real Claude Code). Deferred visibility
 * is the point; the `--debug-file` copy remains immediate.
 *
 * Notices must stay bounded, low-volume, and single-line: every call site is
 * already deduplicated and hard-capped by its own caller, and this module
 * additionally forces one trailing newline, strips C0/C1 control characters (so
 * no escape sequence can ever repaint anything), and truncates.
 */

export type ParentNoticeSink = (line: string) => void;

/** Longer than every notice clodex emits; a guard, not a budget. */
const MAX_NOTICE_CHARS = 2000;

/**
 * C0 controls, DEL, and the C1 range. C1 matters because `U+009B`/`U+009C`/
 * `U+009D` are the 8-bit CSI/ST/OSC introducers: a terminal that honors them
 * would act on an escape sequence even with every ESC byte removed, and some
 * notice fields (a tool name, a differing property name) originate upstream.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

let activeSink: ParentNoticeSink | null = null;
let stderrErrorGuardInstalled = false;

/** Normalizes a notice into exactly one printable, newline-terminated line. */
function toNoticeLine(message: string): string {
  const flattened = message.replace(CONTROL_CHARS, ' ').trimEnd();
  const bounded = flattened.length > MAX_NOTICE_CHARS
    ? `${flattened.slice(0, MAX_NOTICE_CHARS)}...`
    : flattened;
  return `${bounded}\n`;
}

/**
 * Makes a failed stderr write survivable.
 *
 * A closed pipe — `clodex claude 2>&1 | head -n 1` and every other truncating
 * log consumer — reports EPIPE ASYNCHRONOUSLY through the stream's `error`
 * event, after `write()` has already returned, so a synchronous `try/catch`
 * around the call cannot contain it. With no listener Node terminates the
 * process, which on the launch path would tear the in-process gateway away from
 * a still-running Claude Code. A diagnostic must never do that.
 */
function guardStderrErrors(): void {
  if (stderrErrorGuardInstalled) return;
  stderrErrorGuardInstalled = true;
  try {
    // Installed only once clodex actually writes a notice, and never removed:
    // the failure it absorbs (EPIPE/EBADF on a stream clodex does not own) is
    // one no writer here can act on anyway.
    process.stderr.on('error', () => { /* swallowed — see above */ });
  } catch { /* a diagnostic must never break a request */ }
}

/**
 * Writes already-normalized lines to the terminal. Safe to call with an empty
 * list, and safe to call when stderr is a closed pipe.
 */
export function writeParentNoticeLines(lines: readonly string[]): void {
  if (lines.length === 0) return;
  guardStderrErrors();
  try {
    // The write callback and the stream `error` listener both absorb the same
    // failure; which one Node reports through depends on when the peer closed.
    process.stderr.write(lines.join(''), () => { /* swallowed */ });
  } catch { /* a diagnostic must never break a request */ }
}

/**
 * Last-resort flush for a `process.on('exit')` handler, where the event loop is
 * already done and an asynchronous stream write would never be delivered.
 * `writeSync` reports a closed pipe synchronously, so the catch is sufficient.
 */
export function writeParentNoticeLinesSync(lines: readonly string[]): void {
  if (lines.length === 0) return;
  try {
    writeSync(2, lines.join(''));
  } catch { /* EPIPE/EBADF/EAGAIN on a dying process — nothing to do */ }
}

/**
 * Raises one bounded diagnostic for the terminal that started clodex.
 *
 * With no sink installed this is an ordinary `process.stderr.write`, resolved at
 * call time so the usual test spies still observe it. While `launchClaude` holds
 * the terminal for Claude Code, the installed sink takes the line instead and
 * decides when it is safe to paint.
 *
 * A diagnostic must never break a request, so every failure is swallowed.
 */
export function emitParentNotice(message: string): void {
  const line = toNoticeLine(message);
  try {
    if (activeSink) activeSink(line);
    else writeParentNoticeLines([line]);
  } catch { /* a notice must never break a request */ }
}

/**
 * Routes notices to `sink` instead of the terminal until the returned release
 * function is called. Used by `launchClaude`, which owns the mute and the
 * terminal-safety decision this channel defers to.
 */
export function installParentNoticeSink(sink: ParentNoticeSink): () => void {
  const previous = activeSink;
  activeSink = sink;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeSink === sink) activeSink = previous;
  };
}
