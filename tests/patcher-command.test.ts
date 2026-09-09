// End-to-end coverage for `clodex patch` against fake claude "binaries".
//
// The real binary is a native executable tweakcc repacks; here it is a tiny
// shell script that answers `--version` and carries its "bundled JS" after a
// sentinel, with tweakcc's three API calls mocked to read/write that payload.
// That is enough to exercise the whole command — version resolution, pristine
// backup selection, restore, and the manifest — without touching a real install.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as p from '@clack/prompts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runLaunchPatchCheck,
  runPatchCommand,
  readPatchManifest,
  resolveClaudeBinaryForPatch,
} from '../src/patcher.js';
import { LEGACY_LAUNCHERS, NATIVE_LAUNCHERS } from './helpers/npm-launchers.js';

const NATIVE_PLACEHOLDER_BYTES = readFileSync(fileURLToPath(
  new URL('./fixtures/claude-native-placeholder-2.1.266.exe', import.meta.url),
));

const NATIVE_PACKAGE_NAMES = [
  '@anthropic-ai/claude-code-darwin-arm64',
  '@anthropic-ai/claude-code-darwin-x64',
  '@anthropic-ai/claude-code-linux-x64',
  '@anthropic-ai/claude-code-linux-arm64',
  '@anthropic-ai/claude-code-linux-x64-musl',
  '@anthropic-ai/claude-code-linux-arm64-musl',
  '@anthropic-ai/claude-code-linux-arm64-android',
  '@anthropic-ai/claude-code-linux-x64-android',
  '@anthropic-ai/claude-code-win32-x64',
  '@anthropic-ai/claude-code-win32-arm64',
] as const;

const hoisted = vi.hoisted(() => ({
  sentinel: '\n#__CLAUDE_BUNDLE__\n',
  /** Paths passed to readContent, so tests can pin how MANY extractions ran. */
  readContentCalls: [] as string[],
}));

vi.mock('tweakcc', () => ({
  tryDetectInstallation: async ({ path }: { path?: string }) => {
    if (!path || !existsSync(path)) throw new Error(`no installation at ${path}`);
    return { path, version: 'fake', kind: 'native' as const };
  },
  readContent: async (installation: { path: string }) => {
    hoisted.readContentCalls.push(installation.path);
    const raw = readFileSync(installation.path, 'utf8');
    const index = raw.indexOf(hoisted.sentinel);
    if (index === -1) throw new Error('Failed to extract JavaScript from native installation');
    return raw.slice(index + hoisted.sentinel.length);
  },
  writeContent: async (installation: { path: string }, content: string) => {
    const raw = readFileSync(installation.path, 'utf8');
    const head = raw.slice(0, raw.indexOf(hoisted.sentinel));
    writeFileSync(installation.path, head + hoisted.sentinel + content, { mode: 0o755 });
  },
}));

/** A minified stand-in for the Claude Code bundle carrying every patch anchor. */
const PRISTINE_BUNDLE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
  // PATCH 8a/8b/8c/9 anchors — these sites are REQUIRED (applyPatch throws when
  // any of them FAILs), so the fixture has to carry them or every patch aborts.
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
  'function cwdOf(){let p=process.env.PWD;return p}',
  'function childEnv(){let e=extra(),t=Object.keys(e).length>0,n=Object.keys(e).length>0,s=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};let o=[process.env.CLAUDE_CODE_OAUTH_TOKEN,process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE,process.env.CLAUDE_BG_PTY_AUTH,"OTEL_",process.env.CLAUDE_CODE_OTEL_DIAG_STDERR],u=["CLAUDE_CODE_OAUTH_TOKEN"];if(!t&&!n&&!o[0])return process.env;let v={...process.env,...e,...s};for(let k of u)delete v[k],delete v[`INPUT_${k}`];return v}function mcpAllow(){let e=process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV;return e}',
].join('\n');

let home: string;
let clodexHome: string;
let tweakccDir: string;
let logs: string[];

function writeNativePlaceholder(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, NATIVE_PLACEHOLDER_BYTES, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function writeFakeClaude(path: string, version: string, bundle = PRISTINE_BUNDLE): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexit 1\n`
      + hoisted.sentinel + bundle,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}

const bundleOf = (path: string) => {
  const raw = readFileSync(path, 'utf8');
  return raw.slice(raw.indexOf(hoisted.sentinel) + hoisted.sentinel.length);
};
const versionOf = (path: string) =>
  execFileSync(path, ['--version'], { encoding: 'utf8' }).trim().split(' ')[0];
const sha256Of = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sha256OfBuffer = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const backupFiles = () => (existsSync(tweakccDir) ? readdirSync(tweakccDir).sort() : []);

/** Install path a native claude uses: versioned file + stable ~/.local/bin symlink. */
function installClaude(version: string, bundle = PRISTINE_BUNDLE): string {
  const real = join(home, '.local', 'share', 'claude', 'versions', version);
  writeFakeClaude(real, version, bundle);
  const link = join(home, '.local', 'bin', 'claude');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  if (existsSync(link)) rmSync(link);
  symlinkSync(real, link);
  // The patcher records the resolved path; on macOS /var is itself a symlink.
  return realpathSync(real);
}

/**
 * A SECOND same-version install with different bytes — the npm platform package
 * beside a native install, which is the shape issue #199 turns destructive.
 */
function installOtherClaude(version: string, bundle = `${PRISTINE_BUNDLE}\n// npm platform build\n`): string {
  const real = join(home, 'npm', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli');
  writeFakeClaude(real, version, bundle);
  return realpathSync(real);
}

function saveFavorites(): void {
  mkdirSync(clodexHome, { recursive: true });
  writeFileSync(join(clodexHome, 'config.json'), JSON.stringify({
    favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
  }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clodex-patch-e2e-'));
  clodexHome = join(home, '.clodex');
  tweakccDir = join(home, '.tweakcc');
  process.env.HOME = home;
  process.env.CLODEX_HOME = clodexHome;
  process.env.TWEAKCC_CONFIG_DIR = tweakccDir;
  delete process.env.CLODEX_CLAUDE_PATH;
  delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
  saveFavorites();

  hoisted.readContentCalls.length = 0;
  logs = [];
  for (const level of ['info', 'warn', 'error', 'success', 'step', 'message'] as const) {
    vi.spyOn(p.log, level).mockImplementation((message?: unknown) => {
      logs.push(`${level}: ${String(message)}`);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TWEAKCC_CONFIG_DIR;
  delete process.env.CLODEX_CLAUDE_PATH;
  delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
  rmSync(home, { recursive: true, force: true });
});

describe('runPatchCommand version resolution', () => {
  it('patches the resolved install and never downgrades it to a PATH shim\'s version', async () => {
    // The reproduced failure: `claude` on PATH is a wrapper shim reporting an
    // older version than the real install, and a pristine backup for the SHIM's
    // version exists from when the user genuinely ran it. Keying the backup on
    // the shim's version restored 2.1.215's bytes over the 2.1.220 install.
    const real = installClaude('2.1.220');
    const pristineBytes = readFileSync(real);

    const shim = join(home, 'shim', 'claude');
    writeFakeClaude(shim, '2.1.215');
    process.env.CLODEX_CLAUDE_PATH = shim;

    mkdirSync(tweakccDir, { recursive: true });
    const olderBackup = join(tweakccDir, 'claude-2.1.215.orig');
    writeFakeClaude(olderBackup, '2.1.215');
    const olderBackupBytes = readFileSync(olderBackup);

    expect(await runPatchCommand({})).toBe(0);

    // The install is still 2.1.220 — not overwritten with 2.1.215's bytes.
    expect(versionOf(real)).toBe('2.1.220');
    expect(bundleOf(real)).toContain('"sol"');
    expect(readFileSync(olderBackup)).toEqual(olderBackupBytes);

    const manifest = readPatchManifest();
    expect(manifest?.claudeVersion).toBe('2.1.220');
    expect(manifest?.binaryPath).toBe(real);

    // The pristine snapshot is the 2.1.220 binary, stored under its content address.
    const backup = manifest!.backupPath;
    expect(backup).toMatch(/claude-2\.1\.220-[0-9a-f]{16}\.orig$/);
    expect(readFileSync(backup)).toEqual(pristineBytes);
    expect(manifest?.pristineSha256).toBe(createHash('sha256').update(pristineBytes).digest('hex'));
  });

  it('says so when it can only read the one module tweakcc names', async () => {
    // These fixtures carry their "bundle" after a sentinel rather than in a Bun blob, so the
    // module table is unreadable and the single-module fallback is what runs — the same state a
    // real binary would be in if its blob ever stopped parsing.
    //
    // On Claude Code 2.1.242 and later that fallback returns a stub with no anchors in it, and the
    // patch then fails at its first required site. Without this line the report names that site
    // and nothing else, which reads exactly like an anchor that drifted upstream and sends whoever
    // triages it looking in the wrong place.
    const real = installClaude('2.1.220');

    expect(await runPatchCommand({})).toBe(0);

    expect(bundleOf(real)).toContain('"sol"');
    expect(logs.join('\n')).toMatch(/Could not read .* as a Bun module table/);
    expect(logs.join('\n')).toMatch(/the cause is this read, not a changed anchor/);
  });

  it('takes the version from TWEAKCC_CC_INSTALLATION_PATH\'s binary, not from PATH', async () => {
    const target = join(home, 'opt', 'claude-2.1.999');
    writeFakeClaude(target, '2.1.999');
    process.env.TWEAKCC_CC_INSTALLATION_PATH = target;

    const shim = join(home, 'shim', 'claude');
    writeFakeClaude(shim, '2.1.215');
    process.env.CLODEX_CLAUDE_PATH = shim;

    expect(await runPatchCommand({})).toBe(0);
    expect(readPatchManifest()?.claudeVersion).toBe('2.1.999');
    expect(backupFiles()).toContainEqual(expect.stringMatching(/^claude-2\.1\.999-[0-9a-f]{16}\.orig$/));
  });

  it('fails with a version-specific message — not "binary not found" — when the version cannot be read', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(real, 'not an executable at all');
    const before = readFileSync(real);

    expect(await runPatchCommand({})).toBe(1);
    expect(logs.join('\n')).toMatch(/Could not determine the version of/);
    expect(logs.join('\n')).not.toMatch(/binary not found/);
    expect(readFileSync(real)).toEqual(before);
    expect(backupFiles()).toEqual([]);
  });

  it('keeps a launch alive when the version cannot be read', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(real, 'not an executable at all');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runLaunchPatchCheck({})).resolves.toBeUndefined();

    expect(stderr.mock.calls.join('\n')).toMatch(/Could not determine the version/);
    expect(readPatchManifest()).toBeNull();
  });

  it('reports an incomplete npm install for a directly selected placeholder before any write', async () => {
    const program = join(home, 'npm-direct', 'bin', 'claude.exe');
    writeNativePlaceholder(program);
    process.env.TWEAKCC_CC_INSTALLATION_PATH = program;
    const before = readFileSync(program);
    const inode = statSync(program).ino;

    expect(await runPatchCommand({})).toBe(1);

    const output = logs.join('\n');
    expect(output).toMatch(/npm install is incomplete/);
    expect(output).toMatch(/could not determine whether the platform-native package is installed/);
    expect(output).toContain('node node_modules/@anthropic-ai/claude-code/install.cjs');
    expect(output).toContain('reinstall Claude Code without `--ignore-scripts` / `--omit=optional`');
    expect(output).toContain('Then run `clodex patch` again');
    expect(output).toContain('set TWEAKCC_CC_INSTALLATION_PATH');
    expect(output).not.toMatch(/Could not determine the version/);
    expect(readFileSync(program)).toEqual(before);
    expect(statSync(program).ino).toBe(inode);
    expect(backupFiles()).toEqual([]);
    expect(readPatchManifest()).toBeNull();
    expect(readdirSync(dirname(program))).toEqual(['claude.exe']);
    expect(hoisted.readContentCalls).toEqual([]);
  });

  it('detects an executable placeholder before running its version command', async () => {
    const program = join(home, 'ordering', 'bin', 'claude.exe');
    const probeMarker = join(home, 'version-probe-ran');
    mkdirSync(dirname(program), { recursive: true });
    writeFileSync(
      program,
      `#!/bin/sh\nprintf probed > ${JSON.stringify(probeMarker)}\n${NATIVE_PLACEHOLDER_BYTES.toString('utf8')}`,
      { mode: 0o755 },
    );
    chmodSync(program, 0o755);
    process.env.TWEAKCC_CC_INSTALLATION_PATH = program;

    expect(await runPatchCommand({})).toBe(1);

    expect(logs.join('\n')).toMatch(/npm install is incomplete/);
    expect(existsSync(probeMarker)).toBe(false);
    expect(readPatchManifest()).toBeNull();
    expect(backupFiles()).toEqual([]);
  });
});

describe('runPatchCommand npm launcher resolution', () => {
  /**
   * The reporter's Windows layout (issue #193): `npm install -g` puts the three
   * launchers it writes on PATH and the program itself under `node_modules`.
   * `where.exe claude` returns the launchers; none of them is Claude Code.
   */
  function installNpmClaude(
    version: string,
    bundle = PRISTINE_BUNDLE,
    nativePackage?: 'present' | 'missing',
  ): {
    binDir: string;
    program: string;
    installScript: string | null;
    launchers: { sh: string; cmd: string; ps1: string };
  } {
    const binDir = join(home, 'nodejs');
    const packageRoot = join(binDir, 'node_modules', '@anthropic-ai', 'claude-code');
    const program = join(packageRoot, 'bin', 'claude.exe');
    writeFakeClaude(program, version, bundle);

    let installScript: string | null = null;
    if (nativePackage !== undefined) {
      installScript = join(packageRoot, 'install.cjs');
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@anthropic-ai/claude-code',
        version,
        optionalDependencies: Object.fromEntries(
          NATIVE_PACKAGE_NAMES.map(name => [name, version]),
        ),
      }));
      writeFileSync(installScript, '// fixture for package resolution\n');
      if (nativePackage === 'present') {
        for (const name of NATIVE_PACKAGE_NAMES) {
          const nativeRoot = join(binDir, 'node_modules', ...name.split('/'));
          mkdirSync(nativeRoot, { recursive: true });
          writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({ name, version }));
        }
      }
    }

    const launchers = {
      sh: join(binDir, 'claude'),
      cmd: join(binDir, 'claude.cmd'),
      ps1: join(binDir, 'claude.ps1'),
    };
    writeFileSync(launchers.sh, NATIVE_LAUNCHERS.sh, { mode: 0o755 });
    writeFileSync(launchers.cmd, NATIVE_LAUNCHERS.cmd, { mode: 0o755 });
    writeFileSync(launchers.ps1, NATIVE_LAUNCHERS.ps1, { mode: 0o755 });
    return {
      binDir,
      program: realpathSync(program),
      installScript: installScript === null ? null : realpathSync(installScript),
      launchers,
    };
  }

  const candidateDirsIn = (directory: string) =>
    readdirSync(directory).filter(name => name.startsWith('.clodex-patch-'));

  const launcherNames = ['cmd', 'ps1', 'sh'] as const;

  it.each(launcherNames)(
    'patches the program a %s launcher starts and leaves every launcher byte-identical',
    async kind => {
      const { binDir, program, launchers } = installNpmClaude('2.1.266');
      const pristineBytes = readFileSync(program);
      const launcherBytes = {
        sh: readFileSync(launchers.sh),
        cmd: readFileSync(launchers.cmd),
        ps1: readFileSync(launchers.ps1),
      };
      process.env.CLODEX_CLAUDE_PATH = launchers[kind];

      expect(await runPatchCommand({})).toBe(0);

      // The program was patched...
      expect(bundleOf(program)).toContain('"sol"');
      // ...and the launchers were not touched at all.
      expect(readFileSync(launchers.sh)).toEqual(launcherBytes.sh);
      expect(readFileSync(launchers.cmd)).toEqual(launcherBytes.cmd);
      expect(readFileSync(launchers.ps1)).toEqual(launcherBytes.ps1);
      // The candidate is created beside the PROGRAM, not beside the launcher, so
      // that is where a leak would show up.
      expect(candidateDirsIn(dirname(program))).toEqual([]);
      expect(candidateDirsIn(binDir)).toEqual([]);

      // Backup and manifest key off the PROGRAM, which is what makes --restore
      // able to find them again.
      const manifest = readPatchManifest();
      expect(manifest?.binaryPath).toBe(program);
      expect(manifest?.claudeVersion).toBe('2.1.266');
      expect(manifest?.backupPath).toMatch(/claude-2\.1\.266-[0-9a-f]{16}\.orig$/);
      expect(readFileSync(manifest!.backupPath)).toEqual(pristineBytes);
      expect(manifest?.pristineSha256).toBe(sha256OfBuffer(pristineBytes));
    },
  );

  it('reports an incomplete npm install after following a launcher, before any write', async () => {
    const { binDir, program, installScript, launchers } = installNpmClaude(
      '2.1.266',
      PRISTINE_BUNDLE,
      'present',
    );
    writeNativePlaceholder(program);
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;
    const programBefore = readFileSync(program);
    const programInode = statSync(program).ino;
    const launcherBefore = readFileSync(launchers.cmd);

    expect(await runPatchCommand({})).toBe(1);

    const output = logs.join('\n');
    expect(output).toMatch(/npm install is incomplete/);
    expect(output).toContain(program);
    expect(output).toMatch(/platform-native package is installed/);
    expect(output).toContain(`node "${installScript}"`);
    expect(output).not.toMatch(/Reinstall Claude Code/);
    expect(output).not.toMatch(/Could not determine the version/);
    expect(readFileSync(program)).toEqual(programBefore);
    expect(statSync(program).ino).toBe(programInode);
    expect(readFileSync(launchers.cmd)).toEqual(launcherBefore);
    expect(backupFiles()).toEqual([]);
    expect(readPatchManifest()).toBeNull();
    expect(candidateDirsIn(binDir)).toEqual([]);
    expect(candidateDirsIn(dirname(program))).toEqual([]);
    expect(hoisted.readContentCalls).toEqual([]);
  });

  it('reports the incomplete install on --restore without selecting or writing a backup', async () => {
    const { binDir, program, installScript, launchers } = installNpmClaude(
      '2.1.266',
      PRISTINE_BUNDLE,
      'missing',
    );
    writeNativePlaceholder(program);
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;
    const programBefore = readFileSync(program);
    const programInode = statSync(program).ino;
    const launcherBefore = readFileSync(launchers.cmd);

    expect(await runPatchCommand({ restore: true })).toBe(1);

    const output = logs.join('\n');
    expect(output).toMatch(/npm install is incomplete/);
    expect(output).toMatch(/platform-native optional package is missing/);
    expect(output).toMatch(/`install\.cjs` cannot repair this state/);
    expect(output).toMatch(/Reinstall Claude Code without `--ignore-scripts` \/ `--omit=optional`/);
    expect(output).not.toContain(`node "${installScript}"`);
    expect(output).toContain('Then run `clodex patch --restore` again');
    expect(output).toContain(`pristine backups are in ${tweakccDir}`);
    expect(output).not.toMatch(/no patch manifest records a pristine backup/);
    expect(output).not.toMatch(/claude --version` failed/);
    expect(readFileSync(program)).toEqual(programBefore);
    expect(statSync(program).ino).toBe(programInode);
    expect(readFileSync(launchers.cmd)).toEqual(launcherBefore);
    expect(backupFiles()).toEqual([]);
    expect(readPatchManifest()).toBeNull();
    expect(candidateDirsIn(binDir)).toEqual([]);
    expect(candidateDirsIn(dirname(program))).toEqual([]);
    expect(hoisted.readContentCalls).toEqual([]);
  });

  it('refuses --restore without consuming an existing manifest or pristine backup', async () => {
    const { binDir, program, installScript, launchers } = installNpmClaude(
      '2.1.266',
      PRISTINE_BUNDLE,
      'missing',
    );
    const launcherBefore = readFileSync(launchers.cmd);
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;

    expect(await runPatchCommand({})).toBe(0);
    const manifestBefore = readPatchManifest();
    expect(manifestBefore).not.toBeNull();
    const backupSnapshots = backupFiles().map(name => ({
      name,
      bytes: readFileSync(join(tweakccDir, name)),
    }));

    writeNativePlaceholder(program);
    const placeholderBefore = readFileSync(program);
    const programInode = statSync(program).ino;
    logs.length = 0;
    hoisted.readContentCalls.length = 0;

    expect(await runPatchCommand({ restore: true })).toBe(1);

    const output = logs.join('\n');
    expect(output).toMatch(/npm install is incomplete/);
    expect(output).toMatch(/platform-native optional package is missing/);
    expect(output).not.toContain(`node "${installScript}"`);
    expect(output).toContain('Then run `clodex patch --restore` again');
    expect(output).toContain(`pristine backups are in ${tweakccDir}`);
    expect(readFileSync(program)).toEqual(placeholderBefore);
    expect(statSync(program).ino).toBe(programInode);
    expect(readFileSync(launchers.cmd)).toEqual(launcherBefore);
    expect(readPatchManifest()).toEqual(manifestBefore);
    expect(backupFiles()).toEqual(backupSnapshots.map(snapshot => snapshot.name));
    for (const snapshot of backupSnapshots) {
      expect(readFileSync(join(tweakccDir, snapshot.name))).toEqual(snapshot.bytes);
    }
    expect(candidateDirsIn(binDir)).toEqual([]);
    expect(candidateDirsIn(dirname(program))).toEqual([]);
    expect(hoisted.readContentCalls).toEqual([]);
  });

  it('keeps launch-time patch checks non-fatal for an incomplete npm install', async () => {
    const { program, installScript, launchers } = installNpmClaude(
      '2.1.266',
      PRISTINE_BUNDLE,
      'present',
    );
    writeNativePlaceholder(program);
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;
    const before = readFileSync(program);
    const inode = statSync(program).ino;
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runLaunchPatchCheck({})).resolves.toBeUndefined();

    const output = stderr.mock.calls.flat().join('\n');
    expect(output).toMatch(/npm install is incomplete/);
    expect(output).toMatch(/platform-native package is installed/);
    expect(output).toContain(`node "${installScript}"`);
    expect(output).toContain('Then run the command again');
    expect(readFileSync(program)).toEqual(before);
    expect(statSync(program).ino).toBe(inode);
    expect(backupFiles()).toEqual([]);
    expect(readPatchManifest()).toBeNull();
    expect(hoisted.readContentCalls).toEqual([]);
  });

  it('restores the program a launcher starts, not the launcher', async () => {
    const { program, launchers } = installNpmClaude('2.1.266');
    const pristineBytes = readFileSync(program);
    const launcherBytes = readFileSync(launchers.cmd);
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;

    expect(await runPatchCommand({})).toBe(0);
    expect(readFileSync(program)).not.toEqual(pristineBytes);

    expect(await runPatchCommand({ restore: true })).toBe(0);
    expect(readFileSync(program)).toEqual(pristineBytes);
    expect(readFileSync(launchers.cmd)).toEqual(launcherBytes);
    expect(readPatchManifest()).toBeNull();
  });

  it('restores through a stale launcher after the program it named has gone', async () => {
    // The rescue that failed issue #193's reporter. A patch succeeded, then the
    // program disappeared (a broken reinstall, a moved node_modules). The
    // launcher still NAMES it, so the failure carries that path rather than the
    // launcher's — which is the only thing that lets the manifest recorded
    // against the program still be recognised.
    const { program, launchers } = installNpmClaude('2.1.266');
    const pristineBytes = readFileSync(program);
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;

    expect(await runPatchCommand({})).toBe(0);
    expect(readFileSync(program)).not.toEqual(pristineBytes);
    rmSync(program);

    expect(await runPatchCommand({ restore: true })).toBe(0);

    expect(existsSync(program)).toBe(true);
    expect(readFileSync(program)).toEqual(pristineBytes);
    expect(readPatchManifest()).toBeNull();
    expect(logs.join('\n')).toMatch(/Restored pristine claude 2\.1\.266/);
  });

  it('refuses before any write when the launcher names a program that is gone', async () => {
    const { binDir, program, launchers } = installNpmClaude('2.1.266');
    rmSync(program);
    const launcherBytes = readFileSync(launchers.cmd);
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;

    expect(await runPatchCommand({})).toBe(1);

    expect(logs.join('\n')).toMatch(/does not exist/);
    expect(logs.join('\n')).toMatch(/CLODEX_CLAUDE_PATH/);
    expect(readFileSync(launchers.cmd)).toEqual(launcherBytes);
    expect(backupFiles()).toEqual([]);
    expect(readPatchManifest()).toBeNull();
    expect(candidateDirsIn(binDir)).toEqual([]);
    expect(candidateDirsIn(dirname(program))).toEqual([]);
  });

  it('refuses a Windows launcher it cannot read instead of handing it to the patcher', async () => {
    const { binDir, program, launchers } = installNpmClaude('2.1.266');
    writeFileSync(launchers.cmd, '@ECHO off\r\nnode "%~dp0\\..\\thing.js" %1\r\n');
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;

    expect(await runPatchCommand({})).toBe(1);

    expect(logs.join('\n')).toMatch(/could not read which file it starts/);
    expect(logs.join('\n')).toMatch(/CLODEX_CLAUDE_PATH/);
    expect(backupFiles()).toEqual([]);
    expect(readPatchManifest()).toBeNull();
    expect(candidateDirsIn(binDir)).toEqual([]);
    expect(candidateDirsIn(dirname(program))).toEqual([]);
  });

  it('keeps a launch alive, with one line of advice, when a launcher cannot be followed', async () => {
    const { program, launchers } = installNpmClaude('2.1.266');
    rmSync(program);
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runLaunchPatchCheck({})).resolves.toBeUndefined();

    expect(stderr.mock.calls.flat().join('\n')).toMatch(/CLODEX_CLAUDE_PATH/);
    expect(readPatchManifest()).toBeNull();
  });

  it('follows a legacy launcher to an npm cli.js and reads its version with node', () => {
    // Older Claude Code packages declared `bin: cli.js`, so npm generated the
    // node-plus-script launchers instead. A `cli.js` carries no executable bit
    // on Windows and need not carry one anywhere, so the version has to be read
    // by running it with node — from that exact file, never guessed.
    const binDir = join(home, 'nodejs');
    const cli = join(binDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(
      cli,
      'if (process.argv.includes("--version")) console.log("2.1.266 (Claude Code)");\n',
      { mode: 0o644 },
    );
    writeFileSync(join(binDir, 'claude.cmd'), LEGACY_LAUNCHERS.cmd, { mode: 0o755 });
    process.env.CLODEX_CLAUDE_PATH = join(binDir, 'claude.cmd');

    expect(resolveClaudeBinaryForPatch()).toEqual({
      ok: true,
      binaryPath: realpathSync(cli),
      version: '2.1.266',
    });
  });

  it('refuses a launcher that names two different programs, before any write', async () => {
    // No real cmd-shim output names two DISTINCT programs. A hand-edited one can,
    // and picking either would patch an install the shell may never start.
    const { binDir, program, launchers } = installNpmClaude('2.1.266');
    const programBytes = readFileSync(program);
    writeFileSync(launchers.cmd, [
      '@ECHO off',
      '"%dp0%\\decoy.exe"   %*',
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
      '',
    ].join('\r\n'));
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;

    expect(await runPatchCommand({})).toBe(1);

    expect(logs.join('\n')).toMatch(/names more than one program/);
    expect(logs.join('\n')).toMatch(/CLODEX_CLAUDE_PATH/);
    expect(readFileSync(program)).toEqual(programBytes);
    expect(backupFiles()).toEqual([]);
    expect(readPatchManifest()).toBeNull();
    expect(candidateDirsIn(binDir)).toEqual([]);
    expect(candidateDirsIn(dirname(program))).toEqual([]);
  });

  it('tells the user the launcher could not be read, not that a version probe failed', async () => {
    // `--restore` refuses before any version probe when the launcher names no
    // program at all, so reporting a failed `claude --version` would name the
    // wrong cause and send the user to the wrong remedy.
    const { launchers } = installNpmClaude('2.1.266');
    writeFileSync(launchers.cmd, '@ECHO off\r\nnode "%~dp0\\..\\thing.js" %1\r\n');
    process.env.CLODEX_CLAUDE_PATH = launchers.cmd;

    expect(await runPatchCommand({ restore: true })).toBe(1);

    expect(logs.join('\n')).toMatch(/could not read which file it starts/);
    expect(logs.join('\n')).toMatch(/CLODEX_CLAUDE_PATH/);
    expect(logs.join('\n')).not.toMatch(/claude --version` failed/);
    expect(backupFiles()).toEqual([]);
  });

  it('patches a wrapper-style claude that is not an npm launcher rather than following it', async () => {
    // The over-scope negative. A hand-written wrapper (cmux installs one) execs
    // an absolute path and is NOT a cmd-shim; clodex must patch the file it
    // found, exactly as it did before launcher resolution existed.
    const real = installClaude('2.1.220', `${PRISTINE_BUNDLE}\nexec "/opt/real/claude" "$@"`);

    expect(await runPatchCommand({})).toBe(0);
    expect(bundleOf(real)).toContain('"sol"');
    expect(readPatchManifest()?.binaryPath).toBe(real);
  });
});

describe('runPatchCommand local patches', () => {
  it('persists explicit opt-in and applies the fixed local module after built-ins', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      export default [{
        id: 'example-site',
        apply(source, { marker }) {
          if (!source.includes('/*ccpatch:effort*/')) throw new Error('built-ins missing');
          return source + '\\n' + marker + 'example-change';
        },
      }];
    `);

    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toContain('/*ccpatch:effort*/');
    expect(bundleOf(real)).toContain('/*clodex-local:example-site*/example-change');
    expect(JSON.parse(readFileSync(join(clodexHome, 'config.json'), 'utf8'))).toMatchObject({
      localPatchesEnabled: true,
    });
    expect(logs.join('\n')).toMatch(/LOCAL example-site/);
  });

  it('reapplies from pristine bytes when only the local module changes', async () => {
    const real = installClaude('2.1.220');
    const pristine = readFileSync(real);
    const modulePath = join(clodexHome, 'local-patches.mjs');
    const writeModule = (label: string) => writeFileSync(modulePath, `
      export default [{
        id: 'editable-site',
        apply(source, { marker }) { return source + '\\n' + marker + ${JSON.stringify(label)}; },
      }];
    `);

    writeModule('first-version');
    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toContain('/*clodex-local:editable-site*/first-version');

    writeModule('second-version');
    expect(await runPatchCommand({})).toBe(0);
    expect(bundleOf(real)).toContain('/*clodex-local:editable-site*/second-version');
    expect(bundleOf(real)).not.toContain('first-version');
    expect(readFileSync(readPatchManifest()!.backupPath)).toEqual(pristine);
  });

  it('rebuilds a built-in-only patch when local execution is disabled', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      export default [{
        id: 'removable-site',
        apply(source, { marker }) { return source + '\\n' + marker + 'local-change'; },
      }];
    `);

    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toContain('/*clodex-local:removable-site*/');

    expect(await runPatchCommand({ localPatches: false })).toBe(0);
    expect(bundleOf(real)).toContain('/*ccpatch:effort*/');
    expect(bundleOf(real)).not.toContain('/*clodex-local:');
    expect(JSON.parse(readFileSync(join(clodexHome, 'config.json'), 'utf8'))).toMatchObject({
      localPatchesEnabled: false,
    });
  });

  it('publishes complete built-ins but no partial locals when a local site fails', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      export default [
        {
          id: 'first',
          apply(source, { marker }) { return source + '\\n' + marker + 'partial'; },
        },
        {
          id: 'fails',
          apply(source) { return source; },
        },
      ];
    `);

    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toContain('/*ccpatch:effort*/');
    expect(bundleOf(real)).not.toContain('/*clodex-local:');
    expect(logs.join('\n')).toMatch(/SKIP\s+LOCAL first.*rolled back/);
    expect(logs.join('\n')).toMatch(/FAIL\s+LOCAL fails/);
    expect(readPatchManifest()).not.toBeNull();
  });

  it('hashes but never executes local code during a launch freshness check', async () => {
    installClaude('2.1.220');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const proofPath = join(home, 'local-module-executed');
    writeFileSync(join(clodexHome, 'config.json'), JSON.stringify({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      localPatchesEnabled: true,
    }));
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(proofPath)}, 'executed');
      export default [];
    `);

    await expect(runLaunchPatchCheck({ dryRun: true })).resolves.toBeUndefined();
    expect(existsSync(proofPath)).toBe(false);
    expect(stderr).toHaveBeenCalled();
  });

  it('detects an edited local module as stale without executing the new bytes', async () => {
    const real = installClaude('2.1.220');
    const modulePath = join(clodexHome, 'local-patches.mjs');
    writeFileSync(modulePath, `
      export default [{
        id: 'first',
        apply(source, { marker }) { return source + '\\n' + marker; },
      }];
    `);
    expect(await runPatchCommand({ localPatches: true })).toBe(0);

    const proofPath = join(home, 'edited-module-executed');
    writeFileSync(modulePath, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(proofPath)}, 'executed');
      export default [{
        id: 'second',
        apply(source, { marker }) { return source + '\\n' + marker; },
      }];
    `);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runLaunchPatchCheck({ dryRun: true })).resolves.toBeUndefined();
    expect(stderr.mock.calls.join('\n')).toContain('stale-patched');
    expect(existsSync(proofPath)).toBe(false);
    expect(bundleOf(real)).toContain('/*clodex-local:first*/');
    expect(bundleOf(real)).not.toContain('/*clodex-local:second*/');
  });

  it('reports a missing opted-in module without blocking built-in publication', async () => {
    const real = installClaude('2.1.220');

    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toContain('/*ccpatch:effort*/');
    expect(logs.join('\n')).toMatch(/FAIL\s+LOCAL PATCH SET/);
    expect(logs.join('\n')).toContain(join(clodexHome, 'local-patches.mjs'));
  });

  it('does not execute local code when a required built-in site fails', async () => {
    const bundle = PRISTINE_BUNDLE
      .split('\n')
      .filter(line => !line.startsWith('function OI('))
      .join('\n');
    const real = installClaude('2.1.220', bundle);
    const before = readFileSync(real);
    const proofPath = join(home, 'local-module-executed');
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(proofPath)}, 'executed');
      export default [];
    `);

    expect(await runPatchCommand({ localPatches: true })).toBe(1);
    expect(existsSync(proofPath)).toBe(false);
    expect(readFileSync(real)).toEqual(before);
  });

  it('rolls back locals that remove a native member from a built-in routing site', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      export default [{
        id: 'damages-built-in',
        apply(source, { marker }) {
          return source.replace('"fable","sol"', '"sol"') + '\\n' + marker;
        },
      }];
    `);

    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toContain('.enum(["sonnet","opus","haiku","fable","sol"])');
    expect(bundleOf(real)).not.toContain('/*clodex-local:damages-built-in*/');
    expect(logs.join('\n')).toMatch(/FAIL\s+LOCAL PATCH SET.*changed built-in patch sites/);
  });

  it('publishes built-ins when a local proof cannot be captured', async () => {
    const bundle = PRISTINE_BUNDLE.replace(
      'case"best":{return "opus"}default:return null',
      'case"best":{return "opus"}case"sol":return "native";default:return null',
    );
    const real = installClaude('2.1.220', bundle);
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      export default [{
        id: 'must-not-run',
        apply(source, { marker }) { return source + '\\n' + marker; },
      }];
    `);

    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toContain('/*ccpatch:effort*/');
    expect(bundleOf(real)).toContain('case"sol":return "native";');
    expect(bundleOf(real)).not.toContain('/*clodex-local:must-not-run*/');
    expect(logs.join('\n')).toMatch(/FAIL\s+LOCAL PATCH SET.*postconditions/);
  });

  it('allows a local edit adjacent to an intact built-in postcondition', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      export default [{
        id: 'adjacent-site',
        apply(source, { marker }) {
          const close = 'Additional custom models: sol.' + String.fromCharCode(96) + ')';
          return source.replace(close, close + marker + 'adjacent-change');
        },
      }];
    `);

    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toContain(
      String.fromCharCode(96) + ')/*clodex-local:adjacent-site*/adjacent-change',
    );
    expect(logs.join('\n')).toMatch(/OK\s+LOCAL adjacent-site/);
  });

  it('rolls back locals that move a reserved marker away from its built-in code', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(join(clodexHome, 'local-patches.mjs'), `
      export default [{
        id: 'moves-marker',
        apply(source, { marker }) {
          const damaged = source.replace(
            /\\/\\*ccpatch:effort\\*\\/var _ccv=.*?if\\(_ccv!==void 0\\)return _ccv;/,
            '',
          );
          return damaged + '\\n/*ccpatch:effort*/\\n' + marker;
        },
      }];
    `);

    expect(await runPatchCommand({ localPatches: true })).toBe(0);
    expect(bundleOf(real)).toMatch(/\/\*ccpatch:effort\*\/var _ccv=/);
    expect(bundleOf(real)).not.toContain('/*clodex-local:moves-marker*/');
    expect(logs.join('\n')).toMatch(/FAIL\s+LOCAL PATCH SET.*changed built-in patch sites/);
  });
});

describe('runPatchCommand pristine backup safety', () => {
  it('re-patches from the pristine backup instead of patching on top of a patch', async () => {
    const real = installClaude('2.1.220');
    const pristineBytes = readFileSync(real);
    expect(await runPatchCommand({})).toBe(0);
    const firstPass = bundleOf(real);

    // Config change → stale-config → repatch. The bundle must come from the
    // pristine backup, so the second pass equals a fresh patch of the new config.
    writeFileSync(join(clodexHome, 'config.json'), JSON.stringify({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }],
      modelAliases: [{ name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }],
    }));
    expect(await runPatchCommand({})).toBe(0);

    expect(bundleOf(real)).not.toBe(firstPass);
    expect(bundleOf(real)).toContain('"luna"');
    expect(bundleOf(real)).not.toContain('"sol"');
    expect(readFileSync(readPatchManifest()!.backupPath)).toEqual(pristineBytes);
  });

  it('refuses to restore a corrupted backup and leaves the binary untouched', async () => {
    const real = installClaude('2.1.220');
    expect(await runPatchCommand({})).toBe(0);
    const patchedBytes = readFileSync(real);
    const backup = readPatchManifest()!.backupPath;

    // Corrupt the stored pristine bytes, then force a repatch.
    writeFileSync(backup, 'truncated garbage');
    writeFileSync(join(clodexHome, 'config.json'), JSON.stringify({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }],
      modelAliases: [{ name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }],
    }));

    expect(await runPatchCommand({})).toBe(1);
    expect(readFileSync(real)).toEqual(patchedBytes);
    expect(logs.join('\n')).toMatch(/failed its integrity check/);
  });

  it('never stores an already-patched binary as the pristine backup', async () => {
    // A patched install with no backup and no manifest (e.g. ~/.clodex wiped).
    const patchedBundle = PRISTINE_BUNDLE
      .replace('.enum(["sonnet","opus","haiku","fable"])', '.enum(["sonnet","opus","haiku","fable","sol"])')
      + '\n/*ccpatch:ctx*/var _ccw=({"sol":272000})[String(e||"").trim().toLowerCase()];if(_ccw!==void 0)return _ccw;';
    const real = installClaude('2.1.220', patchedBundle);
    const before = readFileSync(real);

    expect(await runPatchCommand({})).toBe(1);
    expect(logs.join('\n')).toMatch(/already patched and no trustworthy pristine backup/);
    expect(readFileSync(real)).toEqual(before);
    expect(backupFiles()).toEqual([]);
  });

  it('refuses a legacy backup whose bytes belong to another version', async () => {
    // A legacy name carries no hash; this one was mislabeled by the version bug.
    const real = installClaude('2.1.220', `${PRISTINE_BUNDLE}\n/*ccpatch:ctx*/var _ccw=({})[""];`);
    const before = readFileSync(real);
    mkdirSync(tweakccDir, { recursive: true });
    writeFakeClaude(join(tweakccDir, 'claude-2.1.220.orig'), '2.1.215');

    expect(await runPatchCommand({})).toBe(1);
    expect(logs.join('\n')).toMatch(/Refusing to use .*it reports version 2\.1\.215/);
    expect(readFileSync(real)).toEqual(before);
  });
});

describe('runPatchCommand legacy backup compatibility', () => {
  it('adopts an existing claude-<ver>.orig backup instead of orphaning it', async () => {
    const real = installClaude('2.1.220');
    const pristineBytes = readFileSync(real);
    mkdirSync(tweakccDir, { recursive: true });
    const legacy = join(tweakccDir, 'claude-2.1.220.orig');
    writeFileSync(legacy, pristineBytes, { mode: 0o755 });

    expect(await runPatchCommand({})).toBe(0);

    // The legacy file is still there, byte-for-byte, and is now also stored
    // under a self-validating content address that the manifest points at.
    expect(readFileSync(legacy)).toEqual(pristineBytes);
    const manifest = readPatchManifest()!;
    expect(manifest.backupPath).toMatch(/claude-2\.1\.220-[0-9a-f]{16}\.orig$/);
    expect(readFileSync(manifest.backupPath)).toEqual(pristineBytes);
    expect(bundleOf(real)).toContain('"sol"');
  });

  it('extracts the bundle exactly once when bootstrapping a pristine install', async () => {
    // The bootstrap path inspects the candidate to answer "already patched?" and
    // then patches that same extraction. Dropping the reuse would be invisible in
    // behaviour but doubles the cost of the most common run, on a ~250 MB binary.
    const real = installClaude('2.1.220');

    expect(await runPatchCommand({})).toBe(0);

    expect(hoisted.readContentCalls).toHaveLength(1);
    // ...and it read the candidate, never the live binary.
    expect(hoisted.readContentCalls[0]).not.toBe(real);
    expect(bundleOf(real)).toContain('"sol"');
  });

  it('re-seeds from a content-addressed backup when the live binary turns out to be patched', async () => {
    // No manifest, so the patched state is discovered only by inspecting the live
    // binary; the backup is content-addressed, so it needs no version probe.
    const pristineBytes = (() => {
      const staging = join(home, 'staging-claude');
      writeFakeClaude(staging, '2.1.220');
      return readFileSync(staging);
    })();
    const real = installClaude('2.1.220', `${PRISTINE_BUNDLE}\n/*ccpatch:ctx*/var _ccw=({})[""];`);
    mkdirSync(tweakccDir, { recursive: true });
    const backup = join(tweakccDir, `claude-2.1.220-${sha256OfBuffer(pristineBytes).slice(0, 16)}.orig`);
    writeFileSync(backup, pristineBytes, { mode: 0o755 });

    expect(await runPatchCommand({})).toBe(0);

    expect(versionOf(real)).toBe('2.1.220');
    expect(bundleOf(real)).toContain('"sol"');
    // The stale patch is gone: the candidate came from the backup, not the binary.
    expect(bundleOf(real)).not.toContain('/*ccpatch:ctx*/var _ccw=({})[""]');
    expect(readPatchManifest()!.backupPath).toBe(backup);
    // Two extractions: the live binary (to detect the patch), then the backup.
    expect(hoisted.readContentCalls).toHaveLength(2);
  });

  it('restores a patched binary from a legacy backup that proves its version', async () => {
    const legacyBytes = (() => {
      const staging = join(home, 'staging-claude');
      writeFakeClaude(staging, '2.1.220');
      return readFileSync(staging);
    })();
    const real = installClaude('2.1.220', `${PRISTINE_BUNDLE}\n/*ccpatch:ctx*/var _ccw=({})[""];`);
    mkdirSync(tweakccDir, { recursive: true });
    writeFileSync(join(tweakccDir, 'claude-2.1.220.orig'), legacyBytes, { mode: 0o755 });

    expect(await runPatchCommand({})).toBe(0);
    expect(versionOf(real)).toBe('2.1.220');
    expect(bundleOf(real)).toContain('"sol"');
    // Restored from the legacy pristine bytes, so the stale patch is gone.
    expect(bundleOf(real)).not.toContain('/*ccpatch:ctx*/var _ccw=({})[""]');
  });
});

describe('runPatchCommand --restore', () => {
  it('restores the pristine binary and drops the manifest', async () => {
    const real = installClaude('2.1.220');
    const pristineBytes = readFileSync(real);
    expect(await runPatchCommand({})).toBe(0);
    expect(readFileSync(real)).not.toEqual(pristineBytes);

    expect(await runPatchCommand({ restore: true })).toBe(0);
    expect(readFileSync(real)).toEqual(pristineBytes);
    expect(readPatchManifest()).toBeNull();
  });

  // Issue #199. Two supported installs of ONE Claude Code version are different
  // files (npm platform package vs native installer), so "same version tag" was
  // never proof that a backup belongs to the install being restored.
  it('refuses to restore another install\'s backup over a same-version install', async () => {
    const patched = installClaude('2.1.220');
    expect(await runPatchCommand({})).toBe(0);
    expect(readPatchManifest()?.binaryPath).toBe(patched);

    // A second, pristine 2.1.220 install becomes the target — a stale
    // CLODEX_CLAUDE_PATH, a PATH change, or a corrected launcher all do this.
    const other = installOtherClaude('2.1.220');
    const otherBytes = readFileSync(other);
    process.env.TWEAKCC_CC_INSTALLATION_PATH = other;

    expect(await runPatchCommand({ restore: true })).toBe(1);

    // The install it had no backup for is untouched, and the manifest that can
    // still rescue the FIRST install survives.
    expect(readFileSync(other)).toEqual(otherBytes);
    expect(readPatchManifest()?.binaryPath).toBe(patched);
    expect(logs.join('\n')).toMatch(/records a different Claude Code install/);

    // And the rescue the manifest exists for still works.
    delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
    expect(await runPatchCommand({ restore: true })).toBe(0);
    expect(readPatchManifest()).toBeNull();
  });

  it('refuses even when both installs were patched and both backups are on disk', async () => {
    // Tempting to restore "the backup the manifest did NOT name" — and unsound.
    // The manifest holds one install, so an unnamed backup is only an install the
    // manifest is silent about: this one, or a third whose backup was never
    // recorded. Nothing on disk tells them apart, so this refuses.
    const other = installOtherClaude('2.1.220');
    process.env.TWEAKCC_CC_INSTALLATION_PATH = other;
    expect(await runPatchCommand({})).toBe(0);
    const otherPatched = readFileSync(other);

    delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
    const native = installClaude('2.1.220');
    expect(await runPatchCommand({})).toBe(0);
    expect(readPatchManifest()?.binaryPath).toBe(native);
    expect(backupFiles().filter(name => name.endsWith('.orig'))).toHaveLength(2);

    process.env.TWEAKCC_CC_INSTALLATION_PATH = other;
    expect(await runPatchCommand({ restore: true })).toBe(1);
    expect(readFileSync(other)).toEqual(otherPatched);
    expect(readPatchManifest()?.binaryPath).toBe(native);
    expect(logs.join('\n')).toMatch(/records a different Claude Code install/);
  });

  it('still restores an install the manifest passed over at a DIFFERENT version', async () => {
    // Patch 2.1.220 here, patch a second install at 2.1.221, then come back. The
    // manifest names a 2.1.221 backup, which is not a candidate for 2.1.220 at
    // all, so it is no reason to refuse — this used to be a working restore.
    const real = installClaude('2.1.220');
    const pristineBytes = readFileSync(real);
    expect(await runPatchCommand({})).toBe(0);

    const other = installOtherClaude('2.1.221');
    process.env.TWEAKCC_CC_INSTALLATION_PATH = other;
    expect(await runPatchCommand({})).toBe(0);
    expect(readPatchManifest()?.claudeVersion).toBe('2.1.221');

    delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
    expect(await runPatchCommand({ restore: true })).toBe(0);
    expect(readFileSync(real)).toEqual(pristineBytes);
    expect(logs.join('\n')).toMatch(/version tag alone/);
  });

  it('refuses when the manifest records this install but its backup was deleted', async () => {
    // The user is told to remove a bad backup by clodex's own error text, so this
    // state is reachable. The remaining same-version backup belongs to the OTHER
    // install, and the manifest says so.
    const other = installOtherClaude('2.1.220');
    process.env.TWEAKCC_CC_INSTALLATION_PATH = other;
    expect(await runPatchCommand({})).toBe(0);

    delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
    const native = installClaude('2.1.220');
    expect(await runPatchCommand({})).toBe(0);
    const nativeBackup = readPatchManifest()!.backupPath;
    const nativePatched = readFileSync(native);
    rmSync(nativeBackup);

    expect(await runPatchCommand({ restore: true })).toBe(1);
    expect(readFileSync(native)).toEqual(nativePatched);
    expect(logs.join('\n')).toMatch(/as the pristine content of/);
  });

  it('reports an error instead of restoring when no trustworthy backup exists', async () => {
    const real = installClaude('2.1.220');
    const before = sha256Of(real);

    expect(await runPatchCommand({ restore: true })).toBe(1);
    expect(sha256Of(real)).toBe(before);
    expect(logs.join('\n')).toMatch(/no trustworthy pristine backup/);
  });

  it('still restores when the binary is too broken to report its version', async () => {
    // The whole point of a pristine backup is recovery from a broken install, so
    // requiring the broken binary to run would defeat the command. The manifest
    // recorded the version when the binary was patched; that is enough.
    const real = installClaude('2.1.220');
    const pristineBytes = readFileSync(real);
    expect(await runPatchCommand({})).toBe(0);
    expect(readFileSync(real)).not.toEqual(pristineBytes);

    writeFileSync(real, '#!/bin/sh\nexit 3\n', { mode: 0o755 });

    expect(await runPatchCommand({ restore: true })).toBe(0);
    expect(readFileSync(real)).toEqual(pristineBytes);
    expect(versionOf(real)).toBe('2.1.220');
    expect(readPatchManifest()).toBeNull();
    expect(logs.join('\n')).toMatch(/using claude 2\.1\.220 from the patch manifest/);
  });

  it('refuses to guess which backup to restore when nothing identifies the install', async () => {
    // Same unreadable binary, but no manifest — clodex cannot tell which version
    // this install is, so it must not pick a backup by guesswork.
    const real = installClaude('2.1.220');
    writeFileSync(real, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const before = sha256Of(real);

    expect(await runPatchCommand({ restore: true })).toBe(1);
    expect(sha256Of(real)).toBe(before);
    expect(logs.join('\n')).toMatch(/no patch manifest records a pristine backup for it/);
  });

  it('keeps the patch path failing on an unreadable version, pointing at --restore', async () => {
    const real = installClaude('2.1.220');
    writeFileSync(real, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const before = sha256Of(real);

    expect(await runPatchCommand({})).toBe(1);
    expect(sha256Of(real)).toBe(before);
    expect(logs.join('\n')).toMatch(/clodex patch --restore` still works/);
  });
});

describe('runPatchCommand poisoned backup safety', () => {
  /** Bytes that pass every provenance check but already carry a clodex patch. */
  function poisonedBackupBytes(): Buffer {
    const staging = join(home, 'poisoned-claude');
    writeFakeClaude(staging, '2.1.220', `${PRISTINE_BUNDLE}\n/*ccpatch:effort*/var _ccc={};`);
    return readFileSync(staging);
  }

  it('refuses to patch from a backup whose bytes are already patched', async () => {
    // Reachable without hand-editing: every clodex before content addressing
    // snapshotted whatever was live when no backup existed, and the version bug
    // this PR fixes is a generator of exactly that state. The version probe
    // cannot catch it — a patched claude reports its own version fine.
    const poisoned = poisonedBackupBytes();
    mkdirSync(tweakccDir, { recursive: true });
    const backup = join(tweakccDir, `claude-2.1.220-${sha256OfBuffer(poisoned).slice(0, 16)}.orig`);
    writeFileSync(backup, poisoned, { mode: 0o755 });
    // A live binary that differs from the backup, so the plan is `restore`.
    const real = installClaude('2.1.220', `${PRISTINE_BUNDLE}\n/*ccpatch:ctx*/var _ccw=({})[""];`);
    const patchedLive = sha256Of(real);

    expect(await runPatchCommand({})).toBe(1);
    expect(logs.join('\n')).toMatch(/already carry a clodex patch/);
    // The install is untouched, and nothing was laundered or clobbered.
    expect(sha256Of(real)).toBe(patchedLive);
    expect(existsSync(join(tweakccDir, 'native-binary.backup'))).toBe(false);
    expect(backupFiles()).toEqual([basename(backup)]);
  });

  it('does not adopt a poisoned legacy backup into a content-addressed name', async () => {
    // Adoption is what converts "delete the bad .orig" into permanent trust,
    // because a content-addressed name is later believed without a version probe.
    const real = installClaude('2.1.220', `${PRISTINE_BUNDLE}\n/*ccpatch:ctx*/var _ccw=({})[""];`);
    const before = sha256Of(real);
    const poisoned = poisonedBackupBytes();
    mkdirSync(tweakccDir, { recursive: true });
    writeFileSync(join(tweakccDir, 'claude-2.1.220.orig'), poisoned, { mode: 0o755 });

    expect(await runPatchCommand({})).toBe(1);
    expect(logs.join('\n')).toMatch(/already carry a clodex patch/);
    expect(sha256Of(real)).toBe(before);
    expect(backupFiles()).toEqual(['claude-2.1.220.orig']);
  });
});

describe('runPatchCommand backup directory integrity', () => {
  it('replaces a corrupt file squatting the content address instead of adopting it', async () => {
    // The likely cause is an interrupted ~250 MB copy. Trusting the NAME made
    // `clodex patch` fail forever with a misleading extraction error.
    const real = installClaude('2.1.220');
    const pristineBytes = readFileSync(real);
    mkdirSync(tweakccDir, { recursive: true });
    writeFileSync(join(tweakccDir, 'claude-2.1.220.orig'), pristineBytes, { mode: 0o755 });
    const canonical = join(tweakccDir, `claude-2.1.220-${sha256OfBuffer(pristineBytes).slice(0, 16)}.orig`);
    writeFileSync(canonical, 'truncated garbage', { mode: 0o755 });

    expect(await runPatchCommand({})).toBe(0);

    // The squatter was overwritten with the bytes its name asserts.
    expect(readFileSync(canonical)).toEqual(pristineBytes);
    expect(readPatchManifest()!.backupPath).toBe(canonical);
    expect(bundleOf(real)).toContain('"sol"');
  });

  it('leaves no half-written temp file in the backup directory', async () => {
    const real = installClaude('2.1.220');
    expect(await runPatchCommand({})).toBe(0);
    // Backups are published temp-then-rename, so no `.tmp-*` may survive.
    expect(backupFiles().filter(name => name.includes('.tmp-'))).toEqual([]);
    expect(bundleOf(real)).toContain('"sol"');
  });
});
