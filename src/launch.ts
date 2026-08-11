// src/launch.ts
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { findClaudeBinary } from './claude-binary.js';
import {
  installParentNoticeSink,
  writeParentNoticeLines,
  writeParentNoticeLinesSync,
} from './parent-notice.js';

// Re-exported so existing importers (cli.ts, patcher.ts, tests) keep one entry
// point; the wrapper imports './claude-binary.js' directly instead.
export {
  findClaudeBinary,
  getClaudeVersionForBinary,
  getInstalledClaudeVersion,
} from './claude-binary.js';

const isWindows = process.platform === 'win32';

/**
 * Notices held while Claude Code owns the terminal. Every producer is already
 * deduplicated and hard-capped, so this is a backstop against a future looping
 * writer, not a budget anyone should reach.
 */
const MAX_QUEUED_NOTICES = 50;

export function buildClaudeArgs(model: string | undefined, extraArgs: string[]): string[] {
  return model ? ['--model', model, ...extraArgs] : [...extraArgs];
}

export function launchClaude(
  env: NodeJS.ProcessEnv,
  model: string | undefined,
  extraArgs: string[],
): Promise<number> {
  return new Promise((resolve) => {
    const claudePath = findClaudeBinary()!;
    const args = buildClaudeArgs(model, extraArgs);

    const debugFileIdx = extraArgs.indexOf('--debug-file');
    const debugLogPath = debugFileIdx !== -1 && extraArgs[debugFileIdx + 1] ? extraArgs[debugFileIdx + 1] : undefined;

    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    const muteWrite = (chunk: string | Uint8Array, encoding?: any, callback?: any) => {
      if (typeof encoding === 'function') {
        callback = encoding;
      }
      if (debugLogPath) {
        try {
          const str = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          appendFileSync(debugLogPath, `[parent] ${str}`);
        } catch {
          // ignore
        }
      }
      if (callback) callback();
      return true;
    };

    process.stdout.write = muteWrite as any;
    process.stderr.write = muteWrite as any;

    // The mute protects Claude Code's TUI from stray parent writes, but clodex's
    // gateway/MITM runs in THIS process and keeps producing the few bounded
    // diagnostics that are documented as reaching stderr. They are QUEUED here,
    // not painted: parent and child are separate processes sharing one PTY with
    // no render lock, so a live write lands wherever the child left the cursor —
    // mid-frame, or right after the prompt where it reads as typed input (both
    // observed against real Claude Code) — and the child's next redraw may erase
    // it anyway. The queue is flushed in restore(), once the child has exited and
    // handed the terminal back. The --debug-file copy stays immediate.
    const queuedNotices: string[] = [];
    let droppedNotices = 0;
    const releaseNoticeSink = installParentNoticeSink((line) => {
      if (debugLogPath) {
        try {
          appendFileSync(debugLogPath, `[parent] ${line}`);
        } catch {
          // ignore
        }
      }
      // Bounded: every producer is already deduplicated and capped, so reaching
      // this means something new is looping. Counting beats unbounded growth in
      // a process that has to keep serving requests.
      if (queuedNotices.length < MAX_QUEUED_NOTICES) queuedNotices.push(line);
      else droppedNotices += 1;
    });

    const takeQueuedNotices = (): string[] => {
      const lines = queuedNotices.splice(0, queuedNotices.length);
      if (droppedNotices > 0) {
        lines.push(
          `clodex: warning: and ${droppedNotices} further notice`
          + `${droppedNotices === 1 ? '' : 's'} suppressed while Claude Code held the terminal.\n`,
        );
        droppedNotices = 0;
      }
      return lines;
    };

    // Last resort. restore() covers the child's exit and error paths (a forwarded
    // SIGINT/SIGTERM reaches them through the child's own exit), but if this
    // process goes down some other way the queue would die with it. An exit
    // handler cannot await, hence the synchronous write.
    const flushNoticesOnExit = () => {
      writeParentNoticeLinesSync(takeQueuedNotices());
    };
    process.once('exit', flushNoticesOnExit);

    const restore = () => {
      releaseNoticeSink();
      process.removeListener('exit', flushNoticesOnExit);
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      // Only now — child gone, terminal handed back — is it safe to paint.
      writeParentNoticeLines(takeQueuedNotices());
    };

    const child = spawn(claudePath, args, {
      stdio: 'inherit',
      env,
      shell: isWindows,
    });

    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };

    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));

    child.on('exit', (code) => {
      restore();
      resolve(code ?? 0);
    });

    child.on('error', (err) => {
      restore();
      resolve(1);
    });
  });
}
