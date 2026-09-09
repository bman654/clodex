import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaudeNativeBinaryPlaceholder } from '../src/claude-native-placeholder.js';

// Regenerated with:
// npm pack @anthropic-ai/claude-code@2.1.266 --ignore-scripts
// sha256: 6d7abae055d3b598281300a6c835086dec81bf3048f8a2294c5d3e50c8830d7b
const placeholderFixture = fileURLToPath(
  new URL('./fixtures/claude-native-placeholder-2.1.266.exe', import.meta.url),
);

// First 4 KiB of the real 205,905,136-byte Claude Code 2.1.263 darwin-arm64
// executable. Keeping only the prefix makes content, rather than size, reject it.
const machoPrefixFixture = fileURLToPath(
  new URL('./fixtures/claude-macho-prefix-2.1.263.bin', import.meta.url),
);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clodex-native-placeholder-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('isClaudeNativeBinaryPlaceholder', () => {
  it('recognizes the exact placeholder bytes shipped by Claude Code 2.1.266', () => {
    expect(isClaudeNativeBinaryPlaceholder(placeholderFixture)).toBe(true);
  });

  it('tolerates changed surrounding wording when two authoritative signals remain', () => {
    const revised = readFileSync(placeholderFixture, 'utf8').replace(
      'claude native binary not installed',
      'Claude Code executable unavailable',
    );

    expect(isClaudeNativeBinaryPlaceholder(write('revised-placeholder.exe', revised))).toBe(true);
  });

  it('rejects a real Mach-O Claude binary prefix when its content is inspected', () => {
    expect(isClaudeNativeBinaryPlaceholder(machoPrefixFixture)).toBe(false);
  });

  it('enforces the 64 KiB content-read ceiling on marker-bearing files', () => {
    const placeholder = readFileSync(placeholderFixture);
    const atLimit = Buffer.alloc(64 * 1024, 0x20);
    placeholder.copy(atLimit);
    const overLimit = Buffer.alloc(64 * 1024 + 1, 0x20);
    placeholder.copy(overLimit);

    expect(isClaudeNativeBinaryPlaceholder(write('at-limit.exe', atLimit))).toBe(true);
    expect(isClaudeNativeBinaryPlaceholder(write('over-limit.exe', overLimit))).toBe(false);
  });

  it('rejects a small cli.js program', () => {
    const cli = write(
      'cli.js',
      '#!/usr/bin/env node\nconsole.log("2.1.266 (Claude Code)");\n',
    );

    expect(isClaudeNativeBinaryPlaceholder(cli)).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(isClaudeNativeBinaryPlaceholder(write('empty.exe', ''))).toBe(false);
  });

  it('rejects unrelated small ASCII even when it repeats one placeholder marker', () => {
    const script = write(
      'other.exe',
      '#!/bin/sh\necho "claude native binary not installed" >&2\nexit 1\n',
    );

    expect(isClaudeNativeBinaryPlaceholder(script)).toBe(false);
  });

  it('rejects the real placeholder truncated after its first line', () => {
    const bytes = readFileSync(placeholderFixture);
    const firstNewline = bytes.indexOf(0x0a);
    const truncated = write('truncated.exe', bytes.subarray(0, firstNewline + 1));

    expect(isClaudeNativeBinaryPlaceholder(truncated)).toBe(false);
  });
});
