// src/process-exit.ts — how both bins (clodex, clodex-claude) end the process.
//
// Not process.exit(). On Node 24 it can hang forever: it joins V8's background threads before
// tearing down the isolate, so a background compile that is waiting for the main thread to collect
// garbage is never woken (https://github.com/nodejs/node/issues/64274). Letting the event loop
// drain with process.exitCode set tears the isolate down first, which releases that thread.
//
// A drain only happens if nothing still holds the loop, so work that nothing awaits registers a
// canceller here (see cancelOnExit) and is cut off when the exit is requested, exactly as
// process.exit() used to cut it off. If something still holds the loop after the grace period,
// the process falls back to process.exit() — the old behaviour, deadlock risk included — so an
// unforeseen leak costs a short delay rather than a process that never ends.

import { writeSync } from 'node:fs';

/**
 * How long a requested exit may wait for the event loop to drain before falling back to
 * process.exit(). Measured drains finish in under a millisecond and never took more than about
 * 60 ms, so this only matters when something unexpected holds the loop. One second keeps that case
 * short for someone at a terminal, while leaving room for the waits a drain can legitimately
 * include: an uncancellable in-flight DNS lookup or connection attempt, a pipe reader catching up on
 * buffered output (which process.exit() can cut short), and closing sockets finishing their
 * shutdown. Waiting also gives V8's background compiles time to finish, which should make a
 * fallback that does fire less likely to meet the deadlock than an immediate process.exit().
 */
export const EXIT_DRAIN_GRACE_MS = 1_000;

export interface ExitAfterDrainOptions {
  /** Report what still held the loop when the fallback fires. CLODEX_TRACE=1 also turns it on. */
  trace?: boolean;
  /** Prefix for the trace line, e.g. `clodex` or `clodex-claude`. */
  label?: string;
  graceMs?: number;
}

const exitCancellers = new Set<() => void>();
let exitRequested = false;

/**
 * Register work that nothing awaits and that must not keep the process alive once an exit is
 * requested. Returns an unregister function; call it when the work settles. Work registered after
 * an exit was requested is cancelled immediately.
 */
export function cancelOnExit(cancel: () => void): () => void {
  if (exitRequested) {
    runCanceller(cancel);
    return () => {};
  }
  exitCancellers.add(cancel);
  return () => {
    exitCancellers.delete(cancel);
  };
}

function runCanceller(cancel: () => void): void {
  try {
    cancel();
  } catch {
    // A canceller that throws must not stop the exit or the other cancellers.
  }
}

/** Active resources by type, e.g. `TCPSocketWrap x2, Timeout`. */
export function describeActiveResources(resources: readonly string[] = process.getActiveResourcesInfo()): string {
  if (resources.length === 0) return 'nothing reported';
  const counts = new Map<string, number>();
  for (const resource of resources) counts.set(resource, (counts.get(resource) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} x${count}` : name)).join(', ');
}

/**
 * End the process with `code` once the event loop drains, the way process.exit(code) would have,
 * without process.exit()'s Node 24 deadlock. Returns immediately: the caller must stop doing work
 * (return) rather than rely on this call not returning. The first request wins, as with
 * process.exit(); later requests are ignored.
 */
export function exitAfterDrain(code: number, options: ExitAfterDrainOptions = {}): void {
  if (exitRequested) return;
  exitRequested = true;
  process.exitCode = code;

  const cancellers = [...exitCancellers];
  exitCancellers.clear();
  for (const cancel of cancellers) runCanceller(cancel);

  const graceMs = options.graceMs ?? EXIT_DRAIN_GRACE_MS;
  // Unref'd, so it never holds the loop open itself: it fires only if something else does.
  const fallback = setTimeout(() => {
    if (options.trace || process.env.CLODEX_TRACE === '1') {
      const label = options.label ?? 'clodex';
      try {
        writeSync(
          2,
          `${label}: event loop still busy ${graceMs}ms after exit was requested; `
          + `exiting with process.exit(${code}). Still active: ${describeActiveResources()}\n`,
        );
      } catch {
        // stderr gone; the exit matters more than the diagnostic.
      }
    }
    process.exit(code);
  }, graceMs);
  fallback.unref();
}
