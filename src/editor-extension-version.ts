// src/editor-extension-version.ts — warn when an editor's Claude Code extension and the Claude Code
// clodex patched are different versions (issue #257).
//
// `clodex-claude` swaps the extension's bundled binary for the clodex-patched install only when the
// bundled file's full SHA-256 equals the pristine hash `clodex patch` recorded (see
// `wrapper-target.ts`). The extension and the CLI update independently (the extension from the
// marketplace, the CLI through its own auto-updater or by hand), so they can end up on different
// versions — and a CLI update also drops the clodex patch until `clodex patch` runs again. Once
// their versions differ the bundled bytes cannot be the recorded pristine bytes, so every chat runs
// the unpatched bundled binary and clodex models disappear from the editor's model picker — with
// nothing but one line in the extension's output channel to say so. `clodex patch` and
// `clodex install-vscode-launcher` are the moments a user is looking, so both call this.
//
// Version labels are the whole comparison, as the issue asks: a different version always means
// different bytes, but an equal version does not prove equal bytes, so silence here is not proof
// that substitution will happen.
//
// Strictly read-only: this lists directories and reads `extensions.json` / `.obsolete`, and — only
// once a warning is actually being printed — asks npm for its global root (`npm root -g`) to pick
// the fix command. It never runs in the wrapper or the launcher, which must stay fast and fail-open.

import { execFileSync, execSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/**
 * The editors checked, by the extensions directory each keeps under the user's home — the same
 * `os.homedir()` those editors use (`$HOME` on macOS/Linux, `%USERPROFILE%` on Windows). A
 * `VSCODE_EXTENSIONS` / `--extensions-dir` override, a portable install, and a non-default VS Code
 * profile (which keeps its own extension list elsewhere) are not checked.
 */
export const EDITOR_EXTENSION_ROOTS: ReadonlyArray<{ editor: string; dir: string }> = [
  { editor: 'VS Code', dir: '.vscode' },
  { editor: 'VS Code Insiders', dir: '.vscode-insiders' },
  { editor: 'VS Code (remote server)', dir: '.vscode-server' },
  { editor: 'VSCodium', dir: '.vscode-oss' },
  { editor: 'Cursor', dir: '.cursor' },
  { editor: 'Windsurf', dir: '.windsurf' },
];

/** The editor names above, for help text and docs. */
export const CHECKED_EDITORS_DESCRIPTION = EDITOR_EXTENSION_ROOTS.map(root => root.editor).join(', ');

/** Numeric release key of a strict `major.minor.patch` version, or null for anything else. */
export function releaseKey(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : null;
}

/** Orders two numeric version keys component by component; missing components count as 0. */
export function compareVersionKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The highest of `versions` by release order (never lexical: 2.1.276 outranks 2.1.99). */
function newestVersion(versions: string[]): string | null {
  let best: { version: string; key: number[] } | null = null;
  for (const version of versions) {
    const key = releaseKey(version);
    if (key && (!best || compareVersionKeys(key, best.key) > 0)) best = { version, key };
  }
  return best?.version ?? null;
}

/**
 * Extension directories are `anthropic.claude-code-<version>` with an optional `-<platform>`
 * suffix (`-win32-x64`, `-darwin-arm64`, `-linux-arm64`, ...). Marketplace versions are always
 * `major.minor.patch`, so the version is the first run of digits after the id.
 */
const EXTENSION_DIR_PATTERN = /^anthropic\.claude-code-(\d+\.\d+\.\d+)(?:-[a-z0-9]+)*$/i;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The directory an `extensions.json` entry names, relative to the extensions directory, if any. */
function entryDirectoryName(entry: Record<string, unknown>): string | null {
  if (typeof entry.relativeLocation === 'string') return entry.relativeLocation;
  const location = entry.location;
  const raw = typeof location === 'string'
    ? location
    : location && typeof location === 'object'
      ? (location as Record<string, unknown>).fsPath ?? (location as Record<string, unknown>).path
      : undefined;
  if (typeof raw !== 'string') return null;
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}

/**
 * The Claude Code extension version installed in one editor's extensions directory, or null when
 * there is none (or the directory is absent or unreadable).
 *
 * `extensions.json` is authoritative when it parses as the list VS Code writes: superseded
 * versions linger on disk until the editor cleans them up, so the newest directory is not
 * necessarily the one that runs, and a listed entry whose directory is gone is not installed.
 * Without a usable `extensions.json` the directories are scanned instead, skipping the ones
 * `.obsolete` marks for removal.
 */
export function readClaudeExtensionVersion(extensionsDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(extensionsDir);
  } catch {
    return null;
  }
  const present = new Set(names);

  const listed = readJson(join(extensionsDir, 'extensions.json'));
  if (Array.isArray(listed)) {
    const versions: string[] = [];
    for (const item of listed) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const identifier = entry.identifier as Record<string, unknown> | undefined;
      if (typeof identifier?.id !== 'string' || identifier.id.toLowerCase() !== CLAUDE_EXTENSION_ID) continue;
      if (typeof entry.version !== 'string') continue;
      const dirName = entryDirectoryName(entry);
      if (dirName !== null && !present.has(dirName)) continue;
      versions.push(entry.version);
    }
    return newestVersion(versions);
  }

  const obsoleteRaw = readJson(join(extensionsDir, '.obsolete'));
  const obsolete = obsoleteRaw && typeof obsoleteRaw === 'object' && !Array.isArray(obsoleteRaw)
    ? new Set(Object.entries(obsoleteRaw).filter(([, flagged]) => flagged).map(([name]) => name))
    : new Set<string>();
  const versions: string[] = [];
  for (const name of names) {
    if (obsolete.has(name)) continue;
    const match = EXTENSION_DIR_PATTERN.exec(name);
    if (match) versions.push(match[1]);
  }
  return newestVersion(versions);
}

export interface InstalledClaudeExtension {
  editor: string;
  extensionsDir: string;
  version: string;
}

/** Every checked editor that has the Claude Code extension installed, with its version. */
export function findInstalledClaudeExtensions(home: string = homedir()): InstalledClaudeExtension[] {
  const found: InstalledClaudeExtension[] = [];
  for (const root of EDITOR_EXTENSION_ROOTS) {
    const extensionsDir = join(home, root.dir, 'extensions');
    const version = readClaudeExtensionVersion(extensionsDir);
    if (version) found.push({ editor: root.editor, extensionsDir, version });
  }
  return found;
}

/** Where `npm install -g` puts packages, or null when npm is absent or fails. */
export type NpmGlobalRootResolver = () => string | null;

const NPM_ROOT_TIMEOUT_MS = 10_000;

/**
 * `npm root -g`, from the npm on `env`'s PATH — the one that `npm install -g` would run. Never
 * throws. Windows needs a shell: `npm` there is `npm.cmd`, which Node will not spawn directly.
 */
export function readNpmGlobalRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const options = {
      env,
      encoding: 'utf8' as const,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
      timeout: NPM_ROOT_TIMEOUT_MS,
    };
    const output = process.platform === 'win32'
      ? execSync('npm root -g', options)
      : execFileSync('npm', ['root', '-g'], options);
    const root = output.trim().split(/\r?\n/).at(-1)?.trim();
    return root || null;
  } catch {
    return null;
  }
}

/** `path` with symlinks resolved when it exists, `/` separators, and no trailing separator. */
function comparablePath(path: string): string {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // A path that is not on this disk still compares by its text.
  }
  const normalized = real.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows drive paths compare case-insensitively.
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * The command that moves the patched install to `version`, chosen from where it lives.
 *
 * `npm install -g` is named only when the patched file is inside the global npm package, found by
 * comparing it against `npm root -g` rather than by its shape: Claude Code's own npm-local install
 * (`~/.claude/local/node_modules/...`), a project's `node_modules`, another Node version's global
 * root and pnpm/bun/yarn stores are all `node_modules` paths that `npm install -g` never updates,
 * so the next `clodex patch` would patch the old copy again. Likewise the npm command for a
 * native-installer install would install a second Claude Code that `clodex patch` never touches
 * (it prefers `~/.local/bin/claude`). Installs clodex cannot place get no command.
 */
export function claudeInstallCommand(
  binaryPath: string,
  version: string,
  npmGlobalRoot: NpmGlobalRootResolver,
): string | null {
  const path = comparablePath(binaryPath);
  if (/\/\.local\/share\/claude\/versions\/[^/]+$/.test(path)) return `claude install ${version}`;
  if (/\/node_modules\/@anthropic-ai\/claude-code/.test(path)) {
    const root = npmGlobalRoot();
    // The package itself or its per-platform native package (`claude-code-<platform>`), whether
    // nested under it or hoisted beside it.
    const packagePrefix = root === null ? null : `${comparablePath(root)}/@anthropic-ai/claude-code`;
    const underGlobalPackage = packagePrefix !== null && path.startsWith(packagePrefix)
      && ['/', '-'].includes(path.charAt(packagePrefix.length));
    if (underGlobalPackage) return `npm install -g @anthropic-ai/claude-code@${version}`;
  }
  return null;
}

/** The warning for one editor whose extension differs from the patched install, or null. */
export function describeExtensionDrift(
  extension: InstalledClaudeExtension,
  patched: { binaryPath: string; version: string },
  npmGlobalRoot: NpmGlobalRootResolver,
): string | null {
  const extensionKey = releaseKey(extension.version);
  const patchedKey = releaseKey(patched.version);
  if (!extensionKey || !patchedKey) return null;
  const order = compareVersionKeys(extensionKey, patchedKey);
  if (order === 0) return null;
  const { editor, version } = extension;
  const install = claudeInstallCommand(patched.binaryPath, version, npmGlobalRoot);
  const lines = [
    `${editor}'s Claude Code extension is ${version}, but the Claude Code clodex patched is `
      + `${patched.version} (${patched.binaryPath}).`,
    `When ${editor} launches Claude Code through clodex-claude (claudeCode.claudeProcessWrapper), `
      + `its chats run the extension's own bundled ${version} binary and clodex models will not `
      + 'appear in its model picker.',
    ...(install
      ? ['To fix it, run:', `  ${install}`, '  clodex patch']
      : [`To fix it, update the Claude Code at ${patched.binaryPath} to ${version} with the tool `
        + 'that installed it, then run:', '  clodex patch']),
  ];
  if (order < 0) lines.push(`Or update the extension in ${editor} to ${patched.version}.`);
  return lines.join('\n');
}

/**
 * One warning per checked editor whose installed Claude Code extension is a different version
 * from the install clodex patched. Empty — and therefore silent — when no editor has the
 * extension, which is the common case for CLI-only users. Never throws: a check that only
 * advises must not fail the command it runs in.
 */
export function claudeExtensionDriftWarnings(
  patched: { binaryPath: string; version: string },
  home: string = homedir(),
  npmGlobalRoot: NpmGlobalRootResolver = () => readNpmGlobalRoot(),
): string[] {
  // Asked at most once, and only when some editor has drifted.
  let root: { value: string | null } | null = null;
  const cachedRoot = () => (root ??= { value: npmGlobalRoot() }).value;
  try {
    return findInstalledClaudeExtensions(home)
      .map(extension => describeExtensionDrift(extension, patched, cachedRoot))
      .filter((warning): warning is string => warning !== null);
  } catch {
    return [];
  }
}
