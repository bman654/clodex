// Fake editor extension directories for the #257 drift warning: the on-disk shape VS Code (and
// its forks) leave under `<home>/<editor dir>/extensions` — one `anthropic.claude-code-<version>-
// <platform>` directory per version still on disk, plus the `extensions.json` list of what is
// actually installed.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function extensionDirName(version: string, platform = 'darwin-arm64'): string {
  return `anthropic.claude-code-${version}-${platform}`;
}

/** Creates the extension's directory (with a bundled-binary stand-in) and returns its name. */
export function writeExtensionDir(extensionsDir: string, version: string, platform = 'darwin-arm64'): string {
  const name = extensionDirName(version, platform);
  const binary = join(extensionsDir, name, 'resources', 'native-binary');
  mkdirSync(binary, { recursive: true });
  writeFileSync(join(binary, 'claude'), `bundled claude ${version}\n`);
  writeFileSync(join(extensionsDir, name, 'package.json'), JSON.stringify({ name: 'claude-code', version }));
  return name;
}

/** An `extensions.json` entry in the shape VS Code writes it. */
export function extensionsJsonEntry(extensionsDir: string, version: string, platform = 'darwin-arm64') {
  const name = extensionDirName(version, platform);
  return {
    identifier: { id: 'anthropic.claude-code', uuid: '00000000-0000-0000-0000-000000000000' },
    version,
    location: { $mid: 1, fsPath: join(extensionsDir, name), path: join(extensionsDir, name), scheme: 'file' },
    relativeLocation: name,
    metadata: { installedTimestamp: 1, source: 'gallery', targetPlatform: platform },
  };
}

/**
 * Installs the extension for one editor the way an auto-update leaves it: every version in
 * `lingering` still on disk, `version` the one `extensions.json` records.
 */
export function installFakeExtension(
  home: string,
  editorDir: string,
  version: string,
  opts: { lingering?: string[]; platform?: string } = {},
): string {
  const extensionsDir = join(home, editorDir, 'extensions');
  mkdirSync(extensionsDir, { recursive: true });
  for (const old of opts.lingering ?? []) writeExtensionDir(extensionsDir, old, opts.platform);
  writeExtensionDir(extensionsDir, version, opts.platform);
  writeFileSync(
    join(extensionsDir, 'extensions.json'),
    JSON.stringify([extensionsJsonEntry(extensionsDir, version, opts.platform)]),
  );
  return extensionsDir;
}

/** Every path under `dir` with its size, mode, mtime and contents — equal snapshots mean untouched. */
export function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(`${path}/ ${stat.mode} ${stat.mtimeMs}`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else {
      out.push(`${path} ${stat.size} ${stat.mode} ${stat.mtimeMs} ${readFileSync(path, 'base64')}`);
    }
  };
  walk(dir);
  return out;
}

/**
 * A fake `npm` in `binDir` that answers `npm root -g` with `globalRoot` and fails anything else,
 * so the fix-command choice never depends on the host's npm. Put `binDir` first on PATH.
 */
export function writeFakeNpm(binDir: string, globalRoot: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'npm'),
    `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo '${globalRoot}'; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
}
