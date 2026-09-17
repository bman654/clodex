// src/vscode-launcher.ts — `clodex install-vscode-launcher`.
//
// The Claude Code VS Code extension spawns `claudeCode.claudeProcessWrapper` as a bare executable
// (no shell) with the bundled claude.exe as the first argument. On Windows npm installs
// `clodex-claude` as three script shims (extensionless POSIX shell, .cmd, .ps1) and no executable;
// the .cmd is what the setting reached, and that spawn rejects it with `spawn EINVAL` (#196, #234). This command compiles `launcher/clodex-claude-launcher.cs` — a small native executable
// that runs `node.exe dist/claude-wrapper.js <args...>` — on the user's own machine with the C#
// compiler that ships inside the .NET Framework on every Windows 10/11 install, and places it at
// `<CLODEX_HOME>\bin\clodex-claude.exe`.
//
// Nothing here is prebuilt or downloaded, and no npm lifecycle script runs it: unsigned prebuilt
// executables trip Defender/SmartScreen, and install scripts are blocked by pnpm 10 and run silently
// by npm. The command is explicit and re-runnable. It never touches VS Code settings or
// ~/.claude/settings.json — it prints the setting to paste.
//
// The paths to node.exe and the wrapper script are baked into the executable as string constants at
// compile time, so the launcher has nothing to look up at spawn time and no config file that could
// drift. The cost is that a Node version switch or a moved clodex install needs a re-run, which the
// launcher itself reports (exit 127 with a one-line message) when its baked wrapper path is gone.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppHome } from './paths.js';
import { publishFileByRename } from './patcher.js';

export const LAUNCHER_EXE_NAME = 'clodex-claude.exe';
export const VSCODE_WRAPPER_SETTING = 'claudeCode.claudeProcessWrapper';

const NODE_PATH_PLACEHOLDER = '"__CLODEX_NODE_PATH__"';
const WRAPPER_PATH_PLACEHOLDER = '"__CLODEX_WRAPPER_SCRIPT_PATH__"';
const LAUNCHER_SOURCE_FILE = 'clodex-claude-launcher.cs';
/** csc.exe reads a BOM-less source in the ANSI code page; the BOM makes it read UTF-8. */
const UTF8_BOM = '\ufeff';

/** Compiler flags: a console .exe for any CPU, optimized, without the csc banner. */
export const CSC_ARGS = ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${LAUNCHER_EXE_NAME}`, LAUNCHER_SOURCE_FILE] as const;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The paths a fresh install of this package puts the two runtime inputs at. */
export function defaultLauncherInputs(): { launcherSourcePath: string; wrapperScriptPath: string } {
  return {
    launcherSourcePath: join(packageRoot, 'launcher', LAUNCHER_SOURCE_FILE),
    wrapperScriptPath: join(packageRoot, 'dist', 'claude-wrapper.js'),
  };
}

/** Where the compiled launcher lives: `<CLODEX_HOME>\bin\clodex-claude.exe`. */
export function launcherInstallPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAppHome(env), 'bin', LAUNCHER_EXE_NAME);
}

/**
 * Renders `value` as a regular C# string literal. Every character outside printable ASCII —
 * backslash and quote included — becomes an escape, so the literal is the same bytes whatever code
 * page the compiler assumes and whatever the path contains (spaces, quotes, non-ASCII, controls).
 * Iterates UTF-16 code units, so a surrogate pair becomes two `\uXXXX` escapes, which C# accepts.
 */
export function csharpStringLiteral(value: string): string {
  let literal = '"';
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit === 0x5c) literal += '\\\\';
    else if (unit === 0x22) literal += '\\"';
    else if (unit >= 0x20 && unit <= 0x7e) literal += value[i];
    else literal += `\\u${unit.toString(16).padStart(4, '0')}`;
  }
  return `${literal}"`;
}

/**
 * Bakes the two absolute paths into the launcher source. Each placeholder must occur exactly once:
 * a template that lost one is a packaging defect, and rendering it would compile a launcher that
 * runs a literal placeholder path.
 */
export function renderLauncherSource(
  template: string,
  paths: { nodePath: string; wrapperScriptPath: string },
): string {
  const replaceOnce = (source: string, placeholder: string, value: string): string => {
    const first = source.indexOf(placeholder);
    if (first === -1 || source.indexOf(placeholder, first + 1) !== -1) {
      throw new Error(`launcher source must contain ${placeholder} exactly once`);
    }
    return source.slice(0, first) + csharpStringLiteral(value) + source.slice(first + placeholder.length);
  };
  const withNode = replaceOnce(template, NODE_PATH_PLACEHOLDER, paths.nodePath);
  return replaceOnce(withNode, WRAPPER_PATH_PLACEHOLDER, paths.wrapperScriptPath);
}

/** The directories that can hold the .NET Framework C# compiler, most preferred first. */
export function cscSearchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const windir = env.WINDIR?.trim() || env.SystemRoot?.trim() || 'C:\\Windows';
  const dotnet = join(windir, 'Microsoft.NET');
  return [join(dotnet, 'Framework64'), join(dotnet, 'Framework')];
}

function frameworkVersionKey(name: string): number[] {
  return name.slice(1).split('.').map(part => Number.parseInt(part, 10) || 0);
}

function compareVersionKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Finds csc.exe: the 64-bit Framework directory first, then the 32-bit one, and within each the
 * newest `v4.*` runtime directory that actually contains the compiler. Older runtimes (v2/v3.5)
 * ship a C# 3 compiler that cannot build the launcher, so they are never candidates.
 */
export function findCsc(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const root of cscSearchRoots(env)) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const candidates = entries
      .filter(name => /^v4\.\d+(\.\d+)*$/i.test(name))
      .sort((a, b) => compareVersionKeys(frameworkVersionKey(b), frameworkVersionKey(a)));
    for (const version of candidates) {
      const csc = join(root, version, 'csc.exe');
      try {
        if (statSync(csc).isFile()) return csc;
      } catch {
        // No compiler in this runtime directory (a runtime-only install); try the next.
      }
    }
  }
  return null;
}

/** JSON-escaped for pasting into settings.json (backslashes doubled). */
export function formatWrapperSetting(exePath: string): string {
  return `"${VSCODE_WRAPPER_SETTING}": ${JSON.stringify(exePath)}`;
}

export interface CompileResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the compiler could not be started at all (ENOENT, EACCES). */
  error?: Error;
}

export type CompileRunner = (cscPath: string, args: readonly string[], cwd: string) => CompileResult;

/** Runs csc.exe directly — no shell — in the scratch directory, so every path it sees is relative. */
export const runCsc: CompileRunner = (cscPath, args, cwd) => {
  const result = spawnSync(cscPath, [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
};

export interface InstallVscodeLauncherOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The node.exe to bake in; defaults to the Node running this command. */
  nodePath?: string;
  wrapperScriptPath?: string;
  launcherSourcePath?: string;
  compile?: CompileRunner;
  tempRoot?: string;
}

export type InstallVscodeLauncherResult =
  | { ok: true; exePath: string; cscPath: string; nodePath: string; wrapperScriptPath: string; warning?: string }
  | { ok: false; reason: 'not-windows' | 'no-csc' | 'missing-input' | 'compile-failed' | 'install-failed'; message: string; detail?: string; warning?: string };

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds and installs the launcher. Pure with respect to its inputs: every environmental
 * dependency (platform, env, node path, compiler, scratch root) is an option so the whole path —
 * render → compile in a scratch dir → atomic publish — runs under test with a fake compiler.
 */
export function installVscodeLauncher(opts: InstallVscodeLauncherOptions = {}): InstallVscodeLauncherResult {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const defaults = defaultLauncherInputs();
  const nodePath = opts.nodePath ?? process.execPath;
  const wrapperScriptPath = opts.wrapperScriptPath ?? defaults.wrapperScriptPath;
  const launcherSourcePath = opts.launcherSourcePath ?? defaults.launcherSourcePath;
  const compile = opts.compile ?? runCsc;

  if (platform !== 'win32') {
    return {
      ok: false,
      reason: 'not-windows',
      message: 'clodex install-vscode-launcher is only needed on Windows. On macOS and Linux npm installs '
        + 'clodex-claude as a program the VS Code extension can spawn directly: set '
        + `${VSCODE_WRAPPER_SETTING} to the path printed by \`which clodex-claude\`.`,
    };
  }

  const cscPath = findCsc(env);
  if (!cscPath) {
    return {
      ok: false,
      reason: 'no-csc',
      message: 'could not find the .NET Framework C# compiler (csc.exe). It ships with Windows 10/11 under '
        + `${cscSearchRoots(env).join(' or ')}\\v4.*; if it is missing, install .NET Framework 4.8 from Microsoft and re-run.`,
    };
  }
  for (const [label, path] of [['claude-wrapper.js', wrapperScriptPath], ['node.exe', nodePath], ['launcher source', launcherSourcePath]] as const) {
    if (!existsSync(path)) {
      return { ok: false, reason: 'missing-input', message: `${label} is not at ${path}; reinstall clodex and re-run.` };
    }
  }

  let source: string;
  try {
    source = renderLauncherSource(readFileSync(launcherSourcePath, 'utf8'), { nodePath, wrapperScriptPath });
  } catch (err) {
    return { ok: false, reason: 'missing-input', message: `could not prepare the launcher source: ${describeError(err)}` };
  }

  const exePath = launcherInstallPath(env);
  const tempRoot = opts.tempRoot ?? tmpdir();
  let scratch: string;
  try {
    scratch = mkdtempSync(join(tempRoot, 'clodex-vscode-launcher-'));
  } catch (err) {
    return { ok: false, reason: 'install-failed', message: `could not create a scratch directory under ${tempRoot}: ${describeError(err)}` };
  }
  let result: InstallVscodeLauncherResult;
  try {
    result = buildAndPublish({ scratch, source, cscPath, compile, exePath, nodePath, wrapperScriptPath });
  } catch (err) {
    // Anything the build phase throws — a scratch write refused, a compiler runner that throws
    // instead of returning, EBUSY/EPERM from the filesystem — is the command's ordinary failure,
    // reported in one line, never a stack trace.
    result = { ok: false, reason: 'install-failed', message: `could not build the launcher: ${describeError(err)}` };
  }
  const cleanupWarning = removeScratch(scratch);
  return cleanupWarning ? { ...result, warning: cleanupWarning } : result;
}

/** Compiles in `scratch` and publishes the result; every failure is a result, not a throw. */
function buildAndPublish(step: {
  scratch: string; source: string; cscPath: string; compile: CompileRunner;
  exePath: string; nodePath: string; wrapperScriptPath: string;
}): InstallVscodeLauncherResult {
  const { scratch, cscPath, exePath } = step;
  writeFileSync(join(scratch, LAUNCHER_SOURCE_FILE), UTF8_BOM + step.source, 'utf8');
  const compiled = step.compile(cscPath, CSC_ARGS, scratch);
  const builtExe = join(scratch, LAUNCHER_EXE_NAME);
  if (compiled.error || compiled.status !== 0 || !existsSync(builtExe)) {
    const output = [compiled.stdout, compiled.stderr].map(text => text.trim()).filter(Boolean).join('\n');
    return {
      ok: false,
      reason: 'compile-failed',
      message: compiled.error
        ? `could not run ${cscPath}: ${compiled.error.message}`
        : `${cscPath} failed (exit ${compiled.status ?? 'signal'}) while building the launcher.`,
      ...(output ? { detail: output } : {}),
    };
  }
  try {
    mkdirSync(dirname(exePath), { recursive: true });
    // Copy beside the destination and rename over it, so an interrupted install never leaves a
    // half-written .exe at the path VS Code is configured to spawn.
    publishFileByRename(builtExe, exePath);
  } catch (err) {
    return {
      ok: false,
      reason: 'install-failed',
      message: `could not write ${exePath}: ${describeError(err)}. `
        + 'If VS Code is running a chat through the launcher, close it and re-run.',
    };
  }
  return { ok: true, exePath, cscPath, nodePath: step.nodePath, wrapperScriptPath: step.wrapperScriptPath };
}

/**
 * Best-effort scratch removal. Windows can hold a just-written file open for a moment (indexer,
 * antivirus), so `rmSync` retries; a leftover is reported as a warning and never changes the
 * install's outcome.
 */
function removeScratch(scratch: string): string | undefined {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return undefined;
  } catch (err) {
    return `could not remove the scratch directory ${scratch}: ${describeError(err)}`;
  }
}

/** The lines printed after a successful install: where it went and exactly what to paste. */
export function successReport(result: Extract<InstallVscodeLauncherResult, { ok: true }>): string[] {
  return [
    `Built ${result.exePath}`,
    `  compiler: ${result.cscPath}`,
    `  runs:     ${result.nodePath} ${result.wrapperScriptPath}`,
    '',
    'Add this to your VS Code settings (Ctrl+Shift+P → Preferences: Open User Settings (JSON)):',
    '',
    `  ${formatWrapperSetting(result.exePath)}`,
    '',
    'Then reload the window (Developer: Reload Window). Keep `clodex server --proxy` running:',
    'the launcher starts clodex-claude, which finds that server and bridges each session to it,',
    'so HTTPS_PROXY/HTTP_PROXY/NODE_EXTRA_CA_CERTS entries in claudeCode.environmentVariables',
    'are no longer needed (remove them so Claude still starts when the server is down).',
    '',
    'With `clodex patch` applied to your installed Claude Code, clodex-claude runs that patched',
    'install in place of the extension\'s bundled claude.exe when the two builds match, which is',
    'what puts clodex models in the extension\'s model picker. Re-run `clodex patch` after either',
    'the extension or the CLI updates; a mismatched chat runs the bundled binary and logs one line',
    'to the extension\'s "Claude VSCode" output channel.',
    '',
    'Re-run `clodex install-vscode-launcher` after switching Node versions or moving the clodex',
    'install: the paths above are compiled into the executable.',
  ];
}

/** The `clodex install-vscode-launcher` command: install, print, return the exit code. */
export function runInstallVscodeLauncherCommand(opts: InstallVscodeLauncherOptions = {}): number {
  const result = installVscodeLauncher(opts);
  if (result.warning) console.error(`clodex: warning: ${result.warning}`);
  if (!result.ok) {
    console.error(`clodex: ${result.message}`);
    if (result.detail) console.error(result.detail);
    return 1;
  }
  console.log(successReport(result).join('\n'));
  return 0;
}
