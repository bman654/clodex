// src/parent-notice.ts

/**
 * The one channel bounded parent-side diagnostics use to reach the real
 * terminal.
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
 * `emitParentNotice` to bypass the mute. There is no prefix sniffing or other
 * content-based rule, because a prefix is not a safety boundary — diagnostic
 * data gets interpolated into messages, and a future writer would silently
 * inherit the bypass. The set of notices that can reach a running Claude Code's
 * terminal is exactly the set of `emitParentNotice` call sites.
 *
 * Notices must stay bounded, low-volume, and single-line: every call site is
 * already deduplicated and hard-capped by its own caller, and this module
 * additionally forces one trailing newline, strips control characters (so an
 * escape sequence can never repaint the child's UI), and truncates.
 */

export type ParentNoticeSink = (line: string) => void;

/** Longer than every notice clodex emits; a guard, not a budget. */
const MAX_NOTICE_CHARS = 2000;

/** Control characters, including ESC — an ANSI sequence must never reach a TUI. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

let activeSink: ParentNoticeSink | null = null;

/**
 * Normalizes a notice into exactly one printable, newline-terminated line.
 */
function toNoticeLine(message: string): string {
  const flattened = message.replace(CONTROL_CHARS, ' ').trimEnd();
  const bounded = flattened.length > MAX_NOTICE_CHARS
    ? `${flattened.slice(0, MAX_NOTICE_CHARS)}...`
    : flattened;
  return `${bounded}\n`;
}

/**
 * Writes one bounded diagnostic line to the terminal that started clodex.
 *
 * With no sink installed this is an ordinary `process.stderr.write`, resolved at
 * call time so the usual test spies still observe it. While `launchClaude` holds
 * the terminal mute, the installed sink writes to the pre-mute stderr instead
 * (and still copies the line into the `--debug-file` log).
 *
 * A diagnostic must never break a request, so every failure is swallowed.
 */
export function emitParentNotice(message: string): void {
  const line = toNoticeLine(message);
  try {
    if (activeSink) activeSink(line);
    else process.stderr.write(line);
  } catch { /* a notice must never break a request */ }
}

/**
 * Routes notices somewhere other than the current `process.stderr.write` for as
 * long as the returned release function has not been called. Used by
 * `launchClaude`, which owns the mute this channel exists to bypass.
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
