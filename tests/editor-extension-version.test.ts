// Issue #257: reading which Claude Code extension version an editor actually has installed, and
// the warning `clodex patch` / `clodex install-vscode-launcher` print when it differs from the
// install clodex patched. Everything runs against fake extension directories in a temp home.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeExtensionDriftWarnings,
  claudeInstallCommand,
  EDITOR_EXTENSION_ROOTS,
  findInstalledClaudeExtensions,
  readClaudeExtensionVersion,
  readNpmGlobalRoot,
} from '../src/editor-extension-version.js';
import {
  extensionsJsonEntry,
  installFakeExtension,
  snapshotTree,
  writeExtensionDir,
  writeFakeNpm,
} from './helpers/fake-editor-extension.js';

const NATIVE = '/Users/jane/.local/share/claude/versions/2.1.267';
const NPM_WIN = 'C:\\Users\\jane\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const NPM_MAC = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const NPM_ROOT_WIN = 'C:\\Users\\jane\\AppData\\Roaming\\npm\\node_modules';
const NPM_ROOT_MAC = '/opt/homebrew/lib/node_modules';
const root = (value: string | null) => () => value;
/** A resolver that fails the test if the fix-command choice asks npm at all. */
const npmNeverAsked = () => {
  throw new Error('npm root -g was consulted');
};

let home: string;
let extensionsDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clodex-editor-ext-'));
  extensionsDir = join(home, '.vscode', 'extensions');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('readClaudeExtensionVersion', () => {
  it('returns nothing when the extensions directory does not exist', () => {
    expect(readClaudeExtensionVersion(extensionsDir)).toBeNull();
  });

  it('takes the version extensions.json records over a newer directory still on disk', () => {
    mkdirSync(extensionsDir, { recursive: true });
    writeExtensionDir(extensionsDir, '2.1.267');
    writeExtensionDir(extensionsDir, '2.1.276');
    writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([
      { identifier: { id: 'ms-python.python' }, version: '9.9.9', relativeLocation: 'ms-python.python-9.9.9' },
      extensionsJsonEntry(extensionsDir, '2.1.267'),
    ]));

    expect(readClaudeExtensionVersion(extensionsDir)).toBe('2.1.267');
  });

  it('reports no extension when extensions.json does not list it, even with its directories on disk', () => {
    // An uninstalled extension leaves its directory behind until the editor cleans up.
    mkdirSync(extensionsDir, { recursive: true });
    writeExtensionDir(extensionsDir, '2.1.276');
    writeFileSync(join(extensionsDir, 'extensions.json'), '[]');

    expect(readClaudeExtensionVersion(extensionsDir)).toBeNull();
  });

  it('skips a listed entry whose directory is gone', () => {
    mkdirSync(extensionsDir, { recursive: true });
    writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([extensionsJsonEntry(extensionsDir, '2.1.276')]));

    expect(readClaudeExtensionVersion(extensionsDir)).toBeNull();
  });

  it('matches the extension id case-insensitively and locates an entry by its location alone', () => {
    mkdirSync(extensionsDir, { recursive: true });
    const name = writeExtensionDir(extensionsDir, '2.1.276', 'win32-x64');
    writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([{
      identifier: { id: 'Anthropic.claude-code' },
      version: '2.1.276',
      location: { $mid: 1, path: `/c:/Users/jane/.vscode/extensions/${name}`, scheme: 'file' },
    }]));

    expect(readClaudeExtensionVersion(extensionsDir)).toBe('2.1.276');
  });

  it('skips an entry located only by `location` when that directory is gone', () => {
    // No relativeLocation: `location` alone must name the directory, in each form VS Code writes.
    mkdirSync(extensionsDir, { recursive: true });
    writeExtensionDir(extensionsDir, '2.1.267', 'win32-x64');
    const gone = 'anthropic.claude-code-2.1.276-win32-x64';
    const entry = (location: unknown) => ({ identifier: { id: 'anthropic.claude-code' }, version: '2.1.276', location });
    for (const location of [
      { $mid: 1, path: `/c:/Users/jane/.vscode/extensions/${gone}`, scheme: 'file' },
      { $mid: 1, fsPath: `c:\\Users\\jane\\.vscode\\extensions\\${gone}`, scheme: 'file' },
      `/home/jane/.vscode/extensions/${gone}`,
    ]) {
      writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([entry(location)]));
      expect(readClaudeExtensionVersion(extensionsDir)).toBeNull();
    }
  });

  it('sorts directories by version, not lexically, when extensions.json is absent', () => {
    // Lexically "2.1.99" sorts after "2.1.276"; by version it is older.
    mkdirSync(extensionsDir, { recursive: true });
    writeExtensionDir(extensionsDir, '2.1.276', 'win32-x64');
    writeExtensionDir(extensionsDir, '2.1.99', 'win32-x64');

    expect(readClaudeExtensionVersion(extensionsDir)).toBe('2.1.276');
  });

  it('falls back to the directories when extensions.json is unreadable, skipping .obsolete ones', () => {
    mkdirSync(extensionsDir, { recursive: true });
    writeExtensionDir(extensionsDir, '2.1.267', 'linux-x64');
    const newer = writeExtensionDir(extensionsDir, '2.1.280', 'linux-x64');
    writeFileSync(join(extensionsDir, 'extensions.json'), '{ not json');
    writeFileSync(join(extensionsDir, '.obsolete'), JSON.stringify({ [newer]: true }));

    expect(readClaudeExtensionVersion(extensionsDir)).toBe('2.1.267');
  });

  it('parses directory names with and without a platform suffix, and ignores look-alikes', () => {
    mkdirSync(join(extensionsDir, 'anthropic.claude-code-2.1.250'), { recursive: true });
    mkdirSync(join(extensionsDir, 'anthropic.claude-code-helper-3.0.0'), { recursive: true });
    mkdirSync(join(extensionsDir, 'other.claude-code-4.0.0-darwin-arm64'), { recursive: true });

    expect(readClaudeExtensionVersion(extensionsDir)).toBe('2.1.250');
  });
});

describe('findInstalledClaudeExtensions', () => {
  it('checks every listed editor and reports only those with the extension', () => {
    installFakeExtension(home, '.cursor', '2.1.270');
    installFakeExtension(home, '.vscode-insiders', '2.1.281');
    mkdirSync(join(home, '.windsurf', 'extensions'), { recursive: true });

    expect(findInstalledClaudeExtensions(home).map(({ editor, version }) => [editor, version])).toEqual([
      ['VS Code Insiders', '2.1.281'],
      ['Cursor', '2.1.270'],
    ]);
  });

  it('covers the editors the docs name', () => {
    expect(EDITOR_EXTENSION_ROOTS.map(root => root.dir)).toEqual([
      '.vscode', '.vscode-insiders', '.vscode-server', '.vscode-oss', '.cursor', '.windsurf',
    ]);
  });
});

describe('claudeInstallCommand', () => {
  it('uses npm for a global npm install on any platform', () => {
    const npm = 'npm install -g @anthropic-ai/claude-code@2.1.276';
    expect(claudeInstallCommand(NPM_WIN, '2.1.276', root(NPM_ROOT_WIN))).toBe(npm);
    // Windows paths compare case-insensitively, whatever case npm prints.
    expect(claudeInstallCommand(NPM_WIN, '2.1.276', root(NPM_ROOT_WIN.toLowerCase() + '\\'))).toBe(npm);
    expect(claudeInstallCommand(NPM_MAC, '2.1.276', root(NPM_ROOT_MAC))).toBe(npm);
    // The per-platform native package, hoisted beside the main package.
    expect(claudeInstallCommand('/usr/lib/node_modules/@anthropic-ai/claude-code-linux-x64/claude', '2.1.276', root('/usr/lib/node_modules')))
      .toBe(npm);
  });

  it('finds the global npm install through a symlinked npm root', () => {
    const real = join(realpathSync(home), 'real-prefix', 'lib', 'node_modules');
    const binary = join(real, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, '');
    symlinkSync(join(real, '..', '..'), join(home, 'linked-prefix'));

    expect(claudeInstallCommand(binary, '2.1.276', root(join(home, 'linked-prefix', 'lib', 'node_modules'))))
      .toBe('npm install -g @anthropic-ai/claude-code@2.1.276');
  });

  it('names no npm command for a node_modules install that `npm install -g` does not update', () => {
    for (const path of [
      // Claude Code's own npm-local install, which its auto-updater keeps separately.
      '/Users/jane/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js',
      // A project-local install.
      '/Users/jane/proj/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      // Another Node version's global root, not the npm on PATH.
      '/Users/jane/.nvm/versions/node/v20.0.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      // pnpm and bun global stores.
      '/home/j/.local/share/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.267/node_modules/@anthropic-ai/claude-code/cli.js',
      '/home/j/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js',
      // A look-alike package under the real root.
      `${NPM_ROOT_MAC}/@anthropic-ai/claude-codex/bin/claude.exe`,
    ]) {
      expect(claudeInstallCommand(path, '2.1.276', root(NPM_ROOT_MAC)), path).toBeNull();
    }
  });

  it('names no npm command when npm cannot say where its global root is', () => {
    expect(claudeInstallCommand(NPM_MAC, '2.1.276', root(null))).toBeNull();
  });

  it('uses the native installer for a native install, where npm would install a copy clodex never patches', () => {
    expect(claudeInstallCommand(NATIVE, '2.1.276', npmNeverAsked)).toBe('claude install 2.1.276');
  });

  it('names no command, and never asks npm, for an install outside any node_modules', () => {
    expect(claudeInstallCommand('/opt/homebrew/Caskroom/claude-code/2.1.267/claude', '2.1.276', npmNeverAsked)).toBeNull();
  });
});

describe('readNpmGlobalRoot', () => {
  it('reads `npm root -g` from the npm on PATH', () => {
    const bin = join(home, 'bin');
    writeFakeNpm(bin, '/opt/fake/lib/node_modules');
    expect(readNpmGlobalRoot({ PATH: bin })).toBe('/opt/fake/lib/node_modules');
  });

  it('returns null, never throwing, when there is no npm', () => {
    const bin = join(home, 'empty-bin');
    mkdirSync(bin, { recursive: true });
    expect(readNpmGlobalRoot({ PATH: bin })).toBeNull();
  });
});

describe('claudeExtensionDriftWarnings', () => {
  it('is silent when no editor has the extension', () => {
    expect(claudeExtensionDriftWarnings({ binaryPath: NATIVE, version: '2.1.267' }, home)).toEqual([]);
  });

  it('is silent when the installed extension is the version clodex patched', () => {
    installFakeExtension(home, '.vscode', '2.1.267', { lingering: ['2.1.260'] });
    expect(claudeExtensionDriftWarnings({ binaryPath: NATIVE, version: '2.1.267' }, home)).toEqual([]);
  });

  it('names both versions, the consequence and the exact commands when the extension is newer', () => {
    installFakeExtension(home, '.vscode', '2.1.276', { lingering: ['2.1.267'], platform: 'win32-x64' });

    const warnings = claudeExtensionDriftWarnings({ binaryPath: NPM_WIN, version: '2.1.267' }, home, root(NPM_ROOT_WIN));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe([
      `VS Code's Claude Code extension is 2.1.276, but the Claude Code clodex patched is 2.1.267 (${NPM_WIN}).`,
      'When VS Code launches Claude Code through clodex-claude (claudeCode.claudeProcessWrapper), its '
        + 'chats run the extension\'s own bundled 2.1.276 binary and clodex models will not appear in '
        + 'its model picker.',
      'To fix it, run:',
      '  npm install -g @anthropic-ai/claude-code@2.1.276',
      '  clodex patch',
    ].join('\n'));
  });

  it('also offers updating the extension when it is the older of the two', () => {
    installFakeExtension(home, '.cursor', '2.1.260');

    const [warning] = claudeExtensionDriftWarnings({ binaryPath: NATIVE, version: '2.1.267' }, home);

    expect(warning).toContain('Cursor\'s Claude Code extension is 2.1.260');
    expect(warning).toContain('\n  claude install 2.1.260\n  clodex patch\n');
    expect(warning).toMatch(/Or update the extension in Cursor to 2\.1\.267\.$/);
  });

  it('warns once per drifted editor and not for an editor that matches', () => {
    installFakeExtension(home, '.vscode', '2.1.276');
    installFakeExtension(home, '.vscode-insiders', '2.1.267');
    installFakeExtension(home, '.vscode-server', '2.1.280', { platform: 'linux-x64' });

    const warnings = claudeExtensionDriftWarnings({ binaryPath: NATIVE, version: '2.1.267' }, home);

    expect(warnings.map(warning => warning.split('\'')[0])).toEqual(['VS Code', 'VS Code (remote server)']);
  });

  it('asks npm for its global root once however many editors drifted, and not at all without drift', () => {
    let asked = 0;
    const counting = () => {
      asked += 1;
      return NPM_ROOT_MAC;
    };
    const patched = { binaryPath: NPM_MAC, version: '2.1.267' };
    installFakeExtension(home, '.vscode', '2.1.267');
    expect(claudeExtensionDriftWarnings(patched, home, counting)).toEqual([]);
    expect(asked).toBe(0);

    installFakeExtension(home, '.cursor', '2.1.276');
    installFakeExtension(home, '.windsurf', '2.1.280');
    const warnings = claudeExtensionDriftWarnings(patched, home, counting);
    expect(warnings).toHaveLength(2);
    expect(warnings.every(warning => warning.includes('npm install -g'))).toBe(true);
    expect(asked).toBe(1);
  });

  it('gives the generic instruction for Claude Code\'s own npm-local install', () => {
    installFakeExtension(home, '.vscode', '2.1.276');
    const local = '/Users/jane/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js';

    const [warning] = claudeExtensionDriftWarnings({ binaryPath: local, version: '2.1.267' }, home, root(NPM_ROOT_MAC));

    expect(warning).toContain(`update the Claude Code at ${local} to 2.1.276 with the tool that installed it`);
    expect(warning).not.toContain('npm install');
  });

  it('tells the user to update by hand when it cannot tell how Claude Code was installed', () => {
    installFakeExtension(home, '.vscode', '2.1.276');
    const other = '/opt/homebrew/Caskroom/claude-code/2.1.267/claude';

    const [warning] = claudeExtensionDriftWarnings({ binaryPath: other, version: '2.1.267' }, home);

    expect(warning).toContain(`update the Claude Code at ${other} to 2.1.276 with the tool that installed it`);
    expect(warning).not.toContain('npm install');
    expect(warning).toMatch(/\n {2}clodex patch$/);
  });

  it('is silent when either version is not a release version', () => {
    installFakeExtension(home, '.vscode', '2.1.276');
    expect(claudeExtensionDriftWarnings({ binaryPath: NATIVE, version: 'unknown' }, home)).toEqual([]);
  });

  it('never writes to the extension directory', () => {
    const dir = installFakeExtension(home, '.vscode', '2.1.276', { lingering: ['2.1.99'] });
    writeFileSync(join(dir, '.obsolete'), JSON.stringify({ [`anthropic.claude-code-2.1.99-darwin-arm64`]: true }));
    const before = snapshotTree(join(home, '.vscode'));

    expect(claudeExtensionDriftWarnings({ binaryPath: NATIVE, version: '2.1.267' }, home)).toHaveLength(1);

    expect(snapshotTree(join(home, '.vscode'))).toEqual(before);
  });
});
