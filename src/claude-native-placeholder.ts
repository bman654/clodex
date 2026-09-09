// src/claude-native-placeholder.ts
//
// Recognize the tiny script npm leaves at bin/claude.exe when Claude Code's
// postinstall does not replace it with the platform-native executable.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The shipped placeholder is 500 bytes. A generous ceiling tolerates future
 * explanatory text while ensuring the real ~200 MB binary and legacy cli.js
 * are rejected by metadata alone, before any content is read.
 */
const MAX_PLACEHOLDER_BYTES = 64 * 1024;

const MISSING_BINARY_MARKER = 'claude native binary not installed';
const INSTALL_SCRIPT_MARKER = 'node_modules/@anthropic-ai/claude-code/install.cjs';
const OMIT_OPTIONAL_MARKER = '--omit=optional';
const IGNORE_SCRIPTS_MARKER = '--ignore-scripts';

/**
 * Return whether `path` is Claude Code's npm native-binary placeholder.
 *
 * This deliberately requires two of three independent signals: the missing-
 * binary error, Anthropic's package-specific install script, and both npm
 * options that produce this state. Requiring the exact first line would stop
 * recognizing the placeholder after a harmless echo or wording change; one
 * substring alone could misclassify an unrelated small script. The size gate
 * excludes real Claude executables, and this two-signal rule errs toward still
 * recognizing revised placeholders while a lone or truncated marker stays a
 * negative. A false positive can refuse a small custom wrapper that would
 * otherwise run, but it can never select a backup or reach patching.
 */
export function isClaudeNativeBinaryPlaceholder(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= 0 || size > MAX_PLACEHOLDER_BYTES) return false;

    // Read through the already-open descriptor so a path replacement between
    // the size check and the read cannot make clodex load a real binary.
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, bytes, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== size) return false;

    const text = bytes.toString('utf8');
    const signals = [
      text.includes(MISSING_BINARY_MARKER),
      text.includes(INSTALL_SCRIPT_MARKER),
      text.includes(OMIT_OPTIONAL_MARKER) && text.includes(IGNORE_SCRIPTS_MARKER),
    ];
    return signals.filter(Boolean).length >= 2;
  } catch {
    return false;
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
