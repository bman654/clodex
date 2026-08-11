// src/claude-binary.ts
//
// Claude Code binary discovery and version probing, kept OUT of launch.ts so the
// `clodex-claude` wrapper can import discovery without pulling in launchClaude
// and everything the launch path needs. The wrapper runs for every spawned agent
// process, so its import graph is an invariant (see CLAUDE.md), and tsup places
// anything both entry points touch in the shared chunk they both load.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAppPathOverride } from './config.js';
import { findBinaryOnPath } from './binary-lookup.js';

const isWindows = process.platform === 'win32';

const FALLBACK_PATHS = isWindows
  ? [
      join(process.env['APPDATA'] ?? homedir(), 'npm', 'claude.cmd'),
      join(process.env['APPDATA'] ?? homedir(), 'npm', 'claude'),
      join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    ]
  : [
      join(homedir(), '.local', 'bin', 'claude'),
      join(homedir(), '.npm', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];

export function findClaudeBinary(): string | null {
  const environmentOverride = process.env['CLODEX_CLAUDE_PATH'];
  if (environmentOverride?.trim()) {
    return existsSync(environmentOverride) ? environmentOverride : null;
  }

  const override = getAppPathOverride('claude');
  if (override) return existsSync(override) ? override : null;

  return findBinaryOnPath('claude', FALLBACK_PATHS);
}

/** Version reported when the installed claude cannot be probed. */
const FALLBACK_CLAUDE_VERSION = '2.1.183';

const VERSION_PROBE_TIMEOUT_MS = 15_000;

/**
 * Probe `--version` of ONE SPECIFIC claude binary, returning null when it cannot
 * be executed or prints nothing version-shaped.
 *
 * Callers that key destructive state on the answer — the patcher names its
 * pristine backups after this version and restores them over the live install —
 * MUST use this and fail loudly on null. A guessed version tags a backup with
 * bytes it does not contain, and restoring it downgrades the user's Claude Code.
 */
export function getClaudeVersionForBinary(binaryPath: string): string | null {
  try {
    // POSIX: exec the file directly so a path containing spaces still works.
    // Windows: `claude` is often a .cmd shim, which needs a shell — keep the
    // quoted shell invocation there.
    const result = isWindows
      ? execSync(`"${binaryPath}" --version`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: VERSION_PROBE_TIMEOUT_MS,
        })
      : execFileSync(binaryPath, ['--version'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: VERSION_PROBE_TIMEOUT_MS,
        });
    return result.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Version of the claude found on PATH (or via the configured overrides), with a
 * known-good fallback. This is a best-effort string for request metadata — it is
 * NOT the version of any particular file, because `findClaudeBinary()` can
 * return a wrapper shim that differs from the real installation.
 */
export function getInstalledClaudeVersion(): string {
  const claudePath = findClaudeBinary();
  if (!claudePath) return FALLBACK_CLAUDE_VERSION;
  return getClaudeVersionForBinary(claudePath) ?? FALLBACK_CLAUDE_VERSION;
}
