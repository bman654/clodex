import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaudeNativeBinaryPlaceholder } from '../src/claude-native-placeholder.js';

// Regenerated with:
// npm pack @anthropic-ai/claude-code@2.1.266 --ignore-scripts
const PLACEHOLDER_SHA256 = '6d7abae055d3b598281300a6c835086dec81bf3048f8a2294c5d3e50c8830d7b';
const placeholderFixture = fileURLToPath(
  new URL('./fixtures/claude-native-placeholder-2.1.266.exe', import.meta.url),
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

function placeholderText(): string {
  return readFileSync(placeholderFixture, 'utf8');
}

function syntheticMachO(): Buffer {
  const bytes = Buffer.alloc(4096, 0xa5);
  // Complete 64-bit little-endian arm64 Mach-O header with no load commands.
  bytes.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  bytes.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  bytes.writeUInt32LE(0, 8); // cpusubtype
  bytes.writeUInt32LE(2, 12); // MH_EXECUTE
  bytes.writeUInt32LE(0, 16); // ncmds
  bytes.writeUInt32LE(0, 20); // sizeofcmds
  bytes.writeUInt32LE(0, 24); // flags
  bytes.writeUInt32LE(0, 28); // reserved
  return bytes;
}

describe('isClaudeNativeBinaryPlaceholder', () => {
  it('recognizes the exact placeholder bytes shipped by Claude Code 2.1.266', () => {
    const bytes = readFileSync(placeholderFixture);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PLACEHOLDER_SHA256);
    expect(isClaudeNativeBinaryPlaceholder(placeholderFixture)).toBe(true);
  });

  it('still detects when the missing-binary wording changes', () => {
    const revised = placeholderText().replace(
      'claude native binary not installed',
      'Claude Code executable unavailable',
    );
    expect(isClaudeNativeBinaryPlaceholder(write('without-error-marker.exe', revised))).toBe(true);
  });

  it('still detects when the install-script path changes', () => {
    const revised = placeholderText().replace(
      'node_modules/@anthropic-ai/claude-code/install.cjs',
      'node_modules/@anthropic-ai/claude-code/repair.cjs',
    );
    expect(
      isClaudeNativeBinaryPlaceholder(write('without-installer-marker.exe', revised)),
    ).toBe(true);
  });

  it('still detects when both npm option names change', () => {
    const revised = placeholderText()
      .replaceAll('--ignore-scripts', 'scripts-disabled')
      .replaceAll('--omit=optional', 'optional-dependency-omitted');
    expect(
      isClaudeNativeBinaryPlaceholder(write('without-option-markers.exe', revised)),
    ).toBe(true);
  });

  it('rejects a synthetic Mach-O binary prefix when its content is inspected', () => {
    expect(isClaudeNativeBinaryPlaceholder(write('macho', syntheticMachO()))).toBe(false);
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

  it.each([
    ['install-script path', 'node_modules/@anthropic-ai/claude-code/install.cjs'],
    ['both npm options', '--ignore-scripts and --omit=optional'],
  ])('rejects unrelated ASCII carrying only the %s signal', (_label, signal) => {
    expect(isClaudeNativeBinaryPlaceholder(write('one-signal.exe', signal))).toBe(false);
  });

  it.each(['--ignore-scripts', '--omit=optional'])(
    'requires the other npm option before %s contributes a signal',
    option => {
      const text = `claude native binary not installed; ${option}`;
      expect(isClaudeNativeBinaryPlaceholder(write('one-option.exe', text))).toBe(false);
    },
  );

  it('rejects the real placeholder truncated after its first line', () => {
    const bytes = readFileSync(placeholderFixture);
    const firstNewline = bytes.indexOf(0x0a);
    const truncated = write('truncated.exe', bytes.subarray(0, firstNewline + 1));
    expect(isClaudeNativeBinaryPlaceholder(truncated)).toBe(false);
  });
});
