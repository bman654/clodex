// src/claude-native-placeholder.ts
//
// Recognize the tiny script npm leaves at bin/claude.exe when Claude Code's
// postinstall does not replace it with the platform-native executable.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { arch } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The shipped placeholder is 500 bytes. A generous ceiling tolerates future
 * explanatory text while ensuring the real ~200 MB binary and legacy cli.js
 * are rejected by metadata alone, before any content is read.
 */
const MAX_PLACEHOLDER_BYTES = 64 * 1024;

const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
const MISSING_BINARY_MARKER = 'claude native binary not installed';
const INSTALL_SCRIPT_MARKER = 'node_modules/@anthropic-ai/claude-code/install.cjs';
const OMIT_OPTIONAL_MARKER = '--omit=optional';
const IGNORE_SCRIPTS_MARKER = '--ignore-scripts';

export type ClaudeNativePackageState = 'present' | 'missing' | 'unknown';

export interface ClaudeNativePlaceholderInfo {
  /** Whether Anthropic's platform package can be resolved exactly as install.cjs resolves it. */
  nativePackageState: ClaudeNativePackageState;
  /** Absolute, verified path to the wrapper package's installer when available. */
  installScriptPath: string | null;
}

/** Copied from Anthropic's install.cjs so the native package key cannot diverge. */
function detectMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = (typeof process.report?.getReport === 'function'
    ? process.report.getReport()
    : null) as { header?: { glibcVersionRuntime?: unknown } } | null;
  return report != null && report.header?.glibcVersionRuntime === undefined;
}

/** Copied from Anthropic's install.cjs, including Android, musl and Rosetta handling. */
function getPlatformKey(): string {
  const platform = process.platform;
  let cpu = arch();
  if (platform === 'android') return `linux-${cpu}-android`;
  if (platform === 'linux') return `linux-${cpu}${detectMusl() ? '-musl' : ''}`;
  if (platform === 'darwin' && cpu === 'x64') {
    const translated = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], {
      encoding: 'utf8',
    });
    if (translated.stdout?.trim() === '1') cpu = 'arm64';
  }
  return `${platform}-${cpu}`;
}

function inspectNativePackage(binaryPath: string): ClaudeNativePlaceholderInfo {
  const packageRoot = dirname(dirname(binaryPath));
  const packageJsonPath = join(packageRoot, 'package.json');
  const installScriptPath = join(packageRoot, 'install.cjs');

  let manifest: {
    name?: unknown;
    optionalDependencies?: Record<string, unknown>;
  };
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as typeof manifest;
    if (manifest.name !== CLAUDE_PACKAGE || !statSync(installScriptPath).isFile()) {
      return { nativePackageState: 'unknown', installScriptPath: null };
    }
  } catch {
    return { nativePackageState: 'unknown', installScriptPath: null };
  }

  const nativePackage = `${CLAUDE_PACKAGE}-${getPlatformKey()}`;
  if (
    manifest.optionalDependencies === null
    || typeof manifest.optionalDependencies !== 'object'
    || typeof manifest.optionalDependencies[nativePackage] !== 'string'
  ) {
    return { nativePackageState: 'unknown', installScriptPath };
  }

  try {
    // install.cjs uses require.resolve from this package. createRequire gives the
    // same lookup roots, including npm siblings and pnpm's linked layout.
    createRequire(installScriptPath).resolve(`${nativePackage}/package.json`);
    return { nativePackageState: 'present', installScriptPath };
  } catch {
    return { nativePackageState: 'missing', installScriptPath };
  }
}

/**
 * Inspect `path` for Claude Code's npm native-binary placeholder.
 *
 * This deliberately requires two of three independent signals: the missing-
 * binary error, Anthropic's package-specific install script, and both npm
 * options that produce this state. All seven sampled native releases from
 * 2.1.113 through 2.1.266 carry all three byte-identically; two-of-three is a
 * defensive allowance for a hypothetical future rewording, not observed drift.
 * One substring alone could misclassify an unrelated small script.
 *
 * A false positive can refuse a small custom wrapper and disable its manifest-
 * based restore. It never writes; set TWEAKCC_CC_INSTALLATION_PATH to the real
 * native binary to bypass a misidentified wrapper.
 *
 * The production caller establishes `statSync(path).isFile()` first. Keep that
 * fence: opening a FIFO for reading can block rather than throw.
 */
export function inspectClaudeNativeBinaryPlaceholder(
  path: string,
): ClaudeNativePlaceholderInfo | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= 0 || size > MAX_PLACEHOLDER_BYTES) return null;

    // Use the same descriptor for metadata and content, and cap both the buffer
    // and every read at the size observed above. This bounds the read even if
    // the file grows in place; later patcher operations still resolve by path.
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, bytes, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== size) return null;

    const text = bytes.toString('utf8');
    const signals = [
      text.includes(MISSING_BINARY_MARKER),
      text.includes(INSTALL_SCRIPT_MARKER),
      text.includes(OMIT_OPTIONAL_MARKER) && text.includes(IGNORE_SCRIPTS_MARKER),
    ];
    if (signals.filter(Boolean).length < 2) return null;
    return inspectNativePackage(path);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A failed close cannot turn an unreadable file into the placeholder.
      }
    }
  }
}

export function isClaudeNativeBinaryPlaceholder(path: string): boolean {
  return inspectClaudeNativeBinaryPlaceholder(path) !== null;
}
