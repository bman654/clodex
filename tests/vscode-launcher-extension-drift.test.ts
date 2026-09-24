// Issue #257: `clodex install-vscode-launcher` runs the same extension-version check as
// `clodex patch`, against the install the patch manifest records. The compiler is a fake csc.exe
// script inside a fake %WINDIR%, as in vscode-launcher.test.ts, and the editor extension
// directories live in a throwaway home passed in as `homeDir`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallVscodeLauncherCommand } from '../src/vscode-launcher.js';
import { installFakeExtension, snapshotTree, writeFakeNpm } from './helpers/fake-editor-extension.js';

const PATCHED_NATIVE = '/Users/jane/.local/share/claude/versions/2.1.267';

let dir: string;
let userHome: string;
let env: NodeJS.ProcessEnv;
let wrapperScriptPath: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'clodex-launcher-drift-')));
  userHome = join(dir, 'home');
  env = { WINDIR: join(dir, 'Windows'), CLODEX_HOME: join(dir, 'clodex-home'), PATH: process.env.PATH };
  wrapperScriptPath = join(dir, 'claude-wrapper.js');
  writeFileSync(wrapperScriptPath, '// wrapper\n');
  mkdirSync(userHome, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(claudeVersion: string, binaryPath = PATCHED_NATIVE): void {
  mkdirSync(env.CLODEX_HOME!, { recursive: true });
  writeFileSync(join(env.CLODEX_HOME!, 'patch-state.json'), JSON.stringify({
    binaryPath,
    claudeVersion,
    configHash: 'hash',
    patchedSize: 1,
    patchedSha256: 'a'.repeat(64),
    backupPath: join(dir, 'backup.orig'),
    pristineSha256: 'b'.repeat(64),
    patchedAt: new Date(0).toISOString(),
  }));
}

function writeSucceedingCsc(): void {
  const csc = join(env.WINDIR!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  mkdirSync(join(csc, '..'), { recursive: true });
  writeFileSync(csc, '#!/bin/sh\nprintf "MZ fake launcher" > "$PWD/clodex-claude.exe"; exit 0\n');
  chmodSync(csc, 0o755);
}

function run(platform: NodeJS.Platform) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = runInstallVscodeLauncherCommand({ platform, env, wrapperScriptPath, tempRoot: dir, homeDir: userHome });
  return {
    code,
    stdout: log.mock.calls.flat().join('\n'),
    stderr: error.mock.calls.flat().join('\n'),
  };
}

describe('clodex install-vscode-launcher extension version check (#257)', () => {
  it('warns after a successful build when the extension differs from the patched install', () => {
    writeSucceedingCsc();
    writeManifest('2.1.267');
    installFakeExtension(userHome, '.vscode', '2.1.276', { lingering: ['2.1.267'], platform: 'win32-x64' });

    const { code, stdout, stderr } = run('win32');

    expect(code).toBe(0);
    expect(stdout).toContain('Built ');
    expect(stderr).toBe([
      `clodex: warning: VS Code's Claude Code extension is 2.1.276, but the Claude Code clodex patched is 2.1.267 (${PATCHED_NATIVE}).`,
      'When VS Code launches Claude Code through clodex-claude (claudeCode.claudeProcessWrapper), its '
        + 'chats run the extension\'s own bundled 2.1.276 binary and clodex models will not appear in '
        + 'its model picker.',
      'To fix it, run:',
      '  claude install 2.1.276',
      '  clodex patch',
    ].join('\n'));
  });

  it('runs the check off Windows too, after the pointer to clodex-claude', () => {
    // `npm root -g` comes from the npm on the command's own PATH.
    writeFakeNpm(join(dir, 'fake-bin'), '/usr/lib/node_modules');
    env.PATH = `${join(dir, 'fake-bin')}:${process.env.PATH}`;
    writeManifest('2.1.267', '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    installFakeExtension(userHome, '.cursor', '2.1.276');

    const { code, stderr } = run('darwin');

    expect(code).toBe(1);
    expect(stderr).toMatch(/^clodex: clodex install-vscode-launcher is only needed on Windows/);
    expect(stderr).toContain('\nclodex: warning: Cursor\'s Claude Code extension is 2.1.276');
    expect(stderr).toContain('  npm install -g @anthropic-ai/claude-code@2.1.276\n  clodex patch');
  });

  it('says nothing when nothing has been patched', () => {
    writeSucceedingCsc();
    installFakeExtension(userHome, '.vscode', '2.1.276');

    const { code, stderr } = run('win32');

    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('says nothing with no extension installed, and nothing when it matches', () => {
    writeSucceedingCsc();
    writeManifest('2.1.276');
    expect(run('win32').stderr).toBe('');

    vi.restoreAllMocks();
    installFakeExtension(userHome, '.vscode', '2.1.276', { lingering: ['2.1.267'] });
    const before = snapshotTree(join(userHome, '.vscode'));
    expect(run('win32').stderr).toBe('');
    expect(snapshotTree(join(userHome, '.vscode'))).toEqual(before);
  });
});
