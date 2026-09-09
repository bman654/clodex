// Launcher ("shim") parsing — the discovery half of issue #193.
//
// The fixtures are real npm output; see tests/helpers/npm-launchers.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readNpmShim, resolveThroughNpmShims } from '../src/npm-shim.js';
import {
  LEGACY_LAUNCHERS as LEGACY,
  NATIVE_LAUNCHERS as NATIVE,
  V9_LEGACY_LAUNCHERS as V9_LEGACY,
  V9_NATIVE_LAUNCHERS as V9_NATIVE,
} from './helpers/npm-launchers.js';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'clodex-npm-shim-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

/** Materialize the program a launcher points at, so resolution can reach it. */
function writeProgram(relativePath: string, contents = 'MZ-program'): string {
  return write(relativePath, contents);
}

describe('readNpmShim — the three launchers npm writes', () => {
  const cases = [
    ['sh', 'claude', NATIVE.sh, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
    ['cmd', 'claude.cmd', NATIVE.cmd, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
    ['ps1', 'claude.ps1', NATIVE.ps1, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
  ] as const;

  it.each(cases)('reads a native-binary %s launcher', (_kind, name, contents, expected) => {
    const shim = write(name, contents);
    expect(readNpmShim(shim)).toEqual({ kind: 'target', target: join(dir, expected) });
  });

  const legacyCases = [
    ['sh', 'claude', LEGACY.sh],
    ['cmd', 'claude.cmd', LEGACY.cmd],
    ['ps1', 'claude.ps1', LEGACY.ps1],
  ] as const;

  it.each(legacyCases)(
    'reads the cli.js — not the nearby node — out of a legacy %s launcher',
    (_kind, name, contents) => {
      const shim = write(name, contents);
      expect(readNpmShim(shim)).toEqual({
        kind: 'target',
        target: join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js'),
      });
    },
  );

  it('handles an install directory whose path contains spaces', () => {
    // The whole target sits inside the launcher's quotes, so spaces need no
    // special handling — but the launcher lives in a directory with spaces too,
    // and the target is resolved against THAT directory.
    const spaced = join(dir, 'Program Files', 'node');
    mkdirSync(spaced, { recursive: true });
    const shim = join(spaced, 'claude.cmd');
    writeFileSync(shim, NATIVE.cmd.replace(
      'node_modules\\@anthropic-ai',
      'my node_modules\\@anthropic-ai',
    ));
    expect(readNpmShim(shim)).toEqual({
      kind: 'target',
      target: join(spaced, 'my node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    });
  });

  it('is not fooled by CRLF line endings in a sh or ps1 launcher', () => {
    const shim = write('claude.ps1', NATIVE.ps1.replace(/\n/g, '\r\n'));
    expect(readNpmShim(shim)).toEqual({
      kind: 'target',
      target: join(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    });
  });

  it('refuses a Windows launcher it cannot parse instead of treating it as a binary', () => {
    const shim = write('claude.cmd', '@ECHO off\r\nnode "%~dp0\\..\\thing.js" %1\r\n');
    expect(readNpmShim(shim)).toEqual({ kind: 'unreadable-launcher' });
  });

  it('refuses a launcher whose target is still an unexpanded variable', () => {
    const shim = write('claude.cmd', '@ECHO off\r\n"%dp0%\\%CLAUDE_BIN%" %*\r\n');
    expect(readNpmShim(shim)).toEqual({ kind: 'unreadable-launcher' });
  });

  it('refuses a PowerShell launcher whose program is an unexpanded PowerShell variable', () => {
    // The `$` half of the literal-target guard. `%VAR%` is covered above; a
    // PowerShell launcher spells its variables with `$`, and a target clodex
    // cannot expand is a target it must not guess at — that path is what would
    // be backed up, patched and renamed over.
    const shim = write('claude.ps1', [
      '#!/usr/bin/env pwsh',
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
      '& "$basedir/$ClaudeProgram" $args',
      '',
    ].join('\n'));
    expect(readNpmShim(shim)).toEqual({ kind: 'unreadable-launcher' });
  });

  it('refuses when ONE named program is unreadable, even beside a readable one', () => {
    // The all-targets rule: an unreadable target poisons the whole file. Reading
    // only the ones that happen to parse would let clodex conclude it knows what
    // the launcher starts when a line it could not read may name something else.
    // The distinguishing outcome is the DIAGNOSIS: this is "could not read",
    // not "names more than one program", and the two send the user different
    // places.
    const shim = write('claude.ps1', [
      '#!/usr/bin/env pwsh',
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
      '& "$basedir/$ClaudeProgram" $args',
      '& "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" $args',
      '',
    ].join('\n'));
    expect(readNpmShim(shim)).toEqual({ kind: 'unreadable-launcher' });

    const result = resolveThroughNpmShims(shim);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toMatch(/could not read which file it starts/);
    expect(result.detail).not.toMatch(/names more than one program/);
  });

  it('treats a hand-written wrapper that is not a cmd-shim as the program itself', () => {
    // The over-scope negative: clodex must not "resolve" every script named
    // claude. This one execs an absolute path the way a cmux-style wrapper does,
    // and only cmd-shim's `$basedir` form may be followed.
    const shim = write('claude', '#!/bin/sh\nexec "/opt/real/claude" "$@"\n');
    expect(readNpmShim(shim)).toEqual({ kind: 'not-a-shim' });
  });

  it('treats a wrapper whose target is a shell variable as the program itself', () => {
    const shim = write('claude', '#!/bin/sh\nexec "$HOME/real/claude" "$@"\n');
    expect(readNpmShim(shim)).toEqual({ kind: 'not-a-shim' });
  });

  it('does not read a file past the size limit, even when it contains launcher text', () => {
    // The discriminating form: the launcher line IS there, so the only thing
    // that can keep this from resolving is the guard refusing to read the file.
    // A native claude is ~200 MB and an npm cli.js is megabytes; either can hold
    // a string that looks like a launcher.
    const launcherLine = 'exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"';
    const program = write('claude', `${'x'.repeat(70 * 1024)}\n${launcherLine}\n`);
    expect(statSync(program).size).toBeGreaterThan(64 * 1024);
    expect(readNpmShim(program)).toEqual({ kind: 'not-a-shim' });
  });

  it('reads the same launcher text when the file is under the limit', () => {
    // The other side of the boundary, so the test above pins the SIZE and not
    // the text: identical content, 60 KiB instead of 70 KiB.
    const launcherLine = 'exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"';
    const program = write('claude', `${'x'.repeat(60 * 1024)}\n${launcherLine}\n`);
    expect(statSync(program).size).toBeLessThan(64 * 1024);
    expect(readNpmShim(program)).toEqual({
      kind: 'target',
      target: join(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    });
  });

  it('treats a missing file as not-a-shim rather than throwing', () => {
    expect(readNpmShim(join(dir, 'absent'))).toEqual({ kind: 'not-a-shim' });
  });
});

describe('readNpmShim — cmd-shim 9.0.2 launchers', () => {
  // Real output of cmd-shim 9.0.2, which npm 12 resolves to through bin-links 7.
  const cases = [
    ['native sh', 'claude', V9_NATIVE.sh, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
    ['native cmd', 'claude.cmd', V9_NATIVE.cmd, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
    ['native ps1', 'claude.ps1', V9_NATIVE.ps1, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
    ['legacy sh', 'claude', V9_LEGACY.sh, 'node_modules/@anthropic-ai/claude-code/cli.js'],
    ['legacy cmd', 'claude.cmd', V9_LEGACY.cmd, 'node_modules/@anthropic-ai/claude-code/cli.js'],
    ['legacy ps1', 'claude.ps1', V9_LEGACY.ps1, 'node_modules/@anthropic-ai/claude-code/cli.js'],
  ] as const;

  it.each(cases)('reads a %s launcher', (_label, name, contents, expected) => {
    const shim = write(name, contents);
    expect(readNpmShim(shim)).toEqual({ kind: 'target', target: join(dir, expected) });
  });

  it("reads the legacy sh launcher's renamed base directory", () => {
    // cmd-shim 9 spells it `$basedir_win` in the legacy sh launcher only, and
    // hoists the node lookup into PROG_EXE. Pinned separately because it is the
    // one line in the six v9 files that the v8 grammars could not read.
    expect(V9_LEGACY.sh).toContain('"$basedir_win/node_modules/@anthropic-ai/claude-code/cli.js" "$@"');
    expect(V9_LEGACY.sh).toContain('PROG_EXE');
    expect(NATIVE.sh).not.toContain('basedir_win');
  });
});

describe('readNpmShim — decoys that must not select the program', () => {
  it('ignores a commented-out sh launcher line and takes the live one', () => {
    // A launcher edited by hand can keep a stale invocation in a comment. The
    // shell runs the live line; clodex must patch what the shell runs.
    const shim = write('claude', [
      '#!/bin/sh',
      'basedir=$(dirname "$0")',
      '# exec "$basedir/stale/claude.exe" "$@"',
      'exec "$basedir/live/claude.exe" "$@"',
      '',
    ].join('\n'));
    expect(readNpmShim(shim)).toEqual({ kind: 'target', target: join(dir, 'live/claude.exe') });
  });

  it('ignores REM- and ::-commented batch lines and takes the live one', () => {
    const rem = write('claude.cmd', [
      '@ECHO off',
      'REM "%dp0%\\stale\\claude.exe" %*',
      ':: "%dp0%\\older\\claude.exe" %*',
      '"%dp0%\\live\\claude.exe"   %*',
      '',
    ].join('\r\n'));
    expect(readNpmShim(rem)).toEqual({ kind: 'target', target: join(dir, 'live/claude.exe') });
  });

  it('ignores a commented-out PowerShell launcher line', () => {
    const shim = write('claude.ps1', [
      '#!/usr/bin/env pwsh',
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
      '#  & "$basedir/stale/claude.exe" $args',
      '& "$basedir/live/claude.exe" $args',
      '',
    ].join('\n'));
    expect(readNpmShim(shim)).toEqual({ kind: 'target', target: join(dir, 'live/claude.exe') });
  });

  it('refuses a batch launcher that names two different programs', () => {
    // No real cmd-shim output has two DISTINCT targets — the PowerShell and sh
    // launchers repeat one target across their branches. Two disagreeing live
    // lines mean clodex cannot know which program runs, and picking the first
    // would silently patch an install the user never starts.
    const shim = write('claude.cmd', [
      '@ECHO off',
      '"%dp0%\\decoy.exe"   %*',
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
      '',
    ].join('\r\n'));
    expect(readNpmShim(shim)).toEqual({
      kind: 'ambiguous-launcher',
      targets: [
        join(dir, 'decoy.exe'),
        join(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
      ],
    });
  });

  it('refuses a PowerShell launcher whose branches disagree', () => {
    const shim = write('claude.ps1', [
      '#!/usr/bin/env pwsh',
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
      'if (Test-Path "$basedir/decoy.exe") {',
      '  & "$basedir/decoy.exe" $args',
      '} else {',
      '  & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" $args',
      '}',
      '',
    ].join('\n'));
    const reading = readNpmShim(shim);
    expect(reading.kind).toBe('ambiguous-launcher');
  });

  it('accepts the real launchers that repeat ONE target across their branches', () => {
    // The negative for the rule above: repetition is normal (the real
    // PowerShell legacy launcher names cli.js four times) and must not refuse.
    expect(readNpmShim(write('claude.ps1', LEGACY.ps1))).toEqual({
      kind: 'target',
      target: join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js'),
    });
  });

  it('does not stitch a target out of two adjacent lines', () => {
    // The grammar runs per line. Whole-file matching would let `[^"]+?` span the
    // newline between an unterminated quote and a later argument forwarder.
    const shim = write('claude', '#!/bin/sh\necho "$basedir/half\nrest.exe" "$@"\n');
    expect(readNpmShim(shim)).toEqual({ kind: 'not-a-shim' });
  });
});

describe('resolveThroughNpmShims', () => {
  it('follows a .cmd launcher to the program and resolves its symlinks', () => {
    const real = writeProgram('actual-install/claude.exe');
    mkdirSync(join(dir, 'node_modules/@anthropic-ai/claude-code/bin'), { recursive: true });
    symlinkSync(real, join(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
    const shim = write('claude.cmd', NATIVE.cmd);

    expect(resolveThroughNpmShims(shim)).toEqual({ ok: true, path: real });
  });

  it('returns the file itself when it is not a launcher', () => {
    const program = writeProgram('claude');
    expect(resolveThroughNpmShims(program)).toEqual({ ok: true, path: program });
  });

  it('fails, naming the missing program, when the launcher is stale', () => {
    const shim = write('claude.cmd', NATIVE.cmd);
    const result = resolveThroughNpmShims(shim);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.shimPath).toBe(shim);
    expect(result.declaredTarget).toBe(
      resolve(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    );
    expect(result.detail).toMatch(/does not exist/);
  });

  it('fails when a Windows launcher cannot be parsed at all', () => {
    const shim = write('claude.ps1', '#!/usr/bin/env pwsh\nWrite-Host hi\n');
    const result = resolveThroughNpmShims(shim);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.declaredTarget).toBeNull();
    expect(result.detail).toMatch(/could not read which file it starts/);
  });

  it('follows a chain of four launchers, and refuses a fifth', () => {
    // npm never chains launchers; this pins what the cap actually permits, which
    // the failure message has to agree with.
    const chain = (name: string, target: string) => write(
      name,
      NATIVE.cmd.replace('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', target),
    );
    const program = writeProgram('program.exe');
    chain('c4.cmd', 'program.exe');
    chain('c3.cmd', 'c4.cmd');
    chain('c2.cmd', 'c3.cmd');
    const four = chain('c1.cmd', 'c2.cmd');
    expect(resolveThroughNpmShims(four)).toEqual({ ok: true, path: program });

    const five = chain('c0.cmd', 'c1.cmd');
    const result = resolveThroughNpmShims(five);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toMatch(/more than 4 deep/);
  });

  it('refuses an ambiguous launcher, naming both programs', () => {
    const shim = write('claude.cmd', [
      '@ECHO off',
      '"%dp0%\\decoy.exe"   %*',
      '"%dp0%\\real.exe"   %*',
      '',
    ].join('\r\n'));
    const result = resolveThroughNpmShims(shim);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.declaredTarget).toBeNull();
    expect(result.detail).toMatch(/names more than one program/);
    expect(result.detail).toContain('decoy.exe');
    expect(result.detail).toContain('real.exe');
  });

  it('terminates on a launcher cycle instead of spinning', () => {
    // npm never chains launchers; this only proves a hand-made cycle stops.
    const contents = NATIVE.cmd.replace(
      'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      'claude.cmd',
    );
    const shim = write('claude.cmd', contents);
    const result = resolveThroughNpmShims(shim);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toMatch(/more than 4 deep/);
  });
});
