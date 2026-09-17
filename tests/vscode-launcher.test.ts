// `clodex install-vscode-launcher` — the Windows half of #234.
//
// Everything here runs on any platform: csc.exe is a fake script inside a fake %WINDIR% tree that
// records its argv and writes a placeholder .exe, and the platform is passed in. What no test here
// can prove is that the real csc.exe accepts the source or that the resulting executable behaves —
// that needs a Windows machine (see docs/windows-setup.md).

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { build } from 'tsup';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csharpStringLiteral,
  findCsc,
  formatWrapperSetting,
  installVscodeLauncher,
  launcherInstallPath,
  renderLauncherSource,
  runCsc,
  runInstallVscodeLauncherCommand,
} from '../src/vscode-launcher.js';
import { installVscodeLauncherHelpText, main, parseArgs, rootHelpText } from '../src/cli.js';

vi.mock('../src/first-run.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/first-run.js')>();
  return { ...actual, needsFirstRunSetup: vi.fn(async () => false) };
});

let dir: string;
let windir: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'clodex-vscode-launcher-test-')));
  windir = join(dir, 'Windows');
  home = join(dir, 'clodex-home');
  env = { WINDIR: windir, CLODEX_HOME: home, PATH: process.env.PATH };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const LAUNCHER_SOURCE = join(process.cwd(), 'launcher', 'clodex-claude-launcher.cs');

/** A csc.exe stand-in: records its argv and cwd, then behaves as instructed. */
function writeFakeCsc(
  path: string,
  behaviour: 'succeed' | 'fail' | 'fail-leaving-partial-exe' | 'silent-no-output' = 'succeed',
): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const bodies = {
    succeed: 'printf "%s\\n" "$@" > "$PWD/argv.txt"; pwd > "$PWD/cwd.txt"; printf "MZ fake launcher built from %s" "$(cat "$PWD/argv.txt" | tail -n 1)" > "$PWD/clodex-claude.exe"; exit 0',
    fail: 'echo "clodex-claude-launcher.cs(31,45): error CS1002: ; expected" >&2; echo "Microsoft (R) Visual C# Compiler"; exit 1',
    'fail-leaving-partial-exe': 'printf "MZ trunc" > "$PWD/clodex-claude.exe"; echo "error CS0016: could not write to output file" >&2; exit 1',
    'silent-no-output': 'exit 0',
  };
  const body = bodies[behaviour];
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function frameworkCsc(arch: 'Framework64' | 'Framework', version: string): string {
  return join(windir, 'Microsoft.NET', arch, version, 'csc.exe');
}

function writeWrapperScript(): string {
  const script = join(dir, 'clodex install', 'dist', 'claude-wrapper.js');
  mkdirSync(join(script, '..'), { recursive: true });
  writeFileSync(script, '// wrapper');
  return script;
}

describe('findCsc', () => {
  it('prefers the 64-bit framework directory and the newest v4 runtime inside it', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30320'));
    writeFakeCsc(frameworkCsc('Framework64', 'v2.0.50727'));
    writeFakeCsc(frameworkCsc('Framework', 'v4.0.30319'));
    expect(findCsc(env)).toBe(frameworkCsc('Framework64', 'v4.0.30320'));
  });

  it('falls back to the 32-bit framework directory when the 64-bit one has no v4 compiler', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v2.0.50727'));
    mkdirSync(join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319'), { recursive: true });
    writeFakeCsc(frameworkCsc('Framework', 'v4.0.30319'));
    expect(findCsc(env)).toBe(frameworkCsc('Framework', 'v4.0.30319'));
  });

  it('sorts runtime directories numerically, not lexically', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.10.1'));
    writeFakeCsc(frameworkCsc('Framework64', 'v4.9.9'));
    expect(findCsc(env)).toBe(frameworkCsc('Framework64', 'v4.10.1'));
  });

  it('reports no compiler when the tree only holds older runtimes or is absent', () => {
    expect(findCsc(env)).toBeNull();
    writeFakeCsc(frameworkCsc('Framework64', 'v3.5'));
    writeFakeCsc(frameworkCsc('Framework', 'v2.0.50727'));
    expect(findCsc(env)).toBeNull();
  });

  it('uses SystemRoot when WINDIR is unset', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    expect(findCsc({ SystemRoot: windir })).toBe(frameworkCsc('Framework64', 'v4.0.30319'));
  });
});

/**
 * Decodes one regular C# string literal (`"..."` with `\\`, `\"`, `\uXXXX` escapes) — the C#
 * specification's rules, written independently of the renderer so the two can disagree.
 */
function decodeCSharpLiteral(literal: string): string {
  expect(literal.startsWith('"') && literal.endsWith('"')).toBe(true);
  const body = literal.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== '\\') {
      expect(ch).not.toBe('"');
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === '\\') { out += '\\'; i += 1; }
    else if (next === '"') { out += '"'; i += 1; }
    else if (next === 'u') { out += String.fromCharCode(Number.parseInt(body.slice(i + 2, i + 6), 16)); i += 5; }
    else throw new Error(`unexpected escape \\${next} in ${literal}`);
  }
  return out;
}

function constantLiteral(source: string, name: string): string {
  const match = source.match(new RegExp(`const string ${name} = ("(?:[^"\\\\]|\\\\.)*");`));
  if (!match) throw new Error(`${name} constant not found`);
  return match[1]!;
}

describe('launcher source rendering', () => {
  const hostilePaths = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Users\\Zoë Müller\\AppData\\Roaming\\npm\\node_modules\\@bman654\\clodex\\dist\\claude-wrapper.js',
    'D:\\проект\\node.exe',
    'C:\\odd"quote\\node.exe',
    'C:\\trailing\\',
    'C:\\tab\there\\new\nline\\node.exe',
    'C:\\emoji\u{1F600}\\node.exe',
    '',
  ];

  it.each(hostilePaths)('round-trips %j through the rendered C# constants', hostile => {
    const template = readFileSync(LAUNCHER_SOURCE, 'utf8');
    const rendered = renderLauncherSource(template, { nodePath: hostile, wrapperScriptPath: `${hostile}\\w.js` });
    expect(decodeCSharpLiteral(constantLiteral(rendered, 'NodePath'))).toBe(hostile);
    expect(decodeCSharpLiteral(constantLiteral(rendered, 'WrapperScriptPath'))).toBe(`${hostile}\\w.js`);
    expect(rendered).not.toContain('__CLODEX_');
    // Nothing outside printable ASCII reaches the compiler, so the code page it assumes is moot.
    expect(constantLiteral(rendered, 'NodePath')).toMatch(/^[\x20-\x7e]*$/);
    expect(constantLiteral(rendered, 'WrapperScriptPath')).toMatch(/^[\x20-\x7e]*$/);
  });

  it('writes the exact escape text C# expects for backslashes, quotes and non-ASCII', () => {
    expect(csharpStringLiteral('C:\\a b\\n.exe')).toBe('"C:\\\\a b\\\\n.exe"');
    expect(csharpStringLiteral('say "hi"')).toBe('"say \\"hi\\""');
    expect(csharpStringLiteral('Zoë\u{1F600}')).toBe('"Zo\\u00eb\\ud83d\\ude00"');
    expect(csharpStringLiteral('\t')).toBe('"\\u0009"');
  });

  it('refuses a template that lost or duplicated a placeholder', () => {
    expect(() => renderLauncherSource('const string NodePath = "__CLODEX_NODE_PATH__";', { nodePath: 'n', wrapperScriptPath: 'w' }))
      .toThrow(/__CLODEX_WRAPPER_SCRIPT_PATH__/);
    expect(() => renderLauncherSource('"__CLODEX_NODE_PATH__" "__CLODEX_NODE_PATH__" "__CLODEX_WRAPPER_SCRIPT_PATH__"', { nodePath: 'n', wrapperScriptPath: 'w' }))
      .toThrow(/__CLODEX_NODE_PATH__/);
  });
});

describe('installVscodeLauncher', () => {
  it('compiles in a scratch directory with relative paths and publishes the exe under CLODEX_HOME\\bin', () => {
    const csc = frameworkCsc('Framework64', 'v4.0.30319');
    writeFakeCsc(csc);
    const wrapper = writeWrapperScript();
    const scratchRoot = join(dir, 'scratch');
    mkdirSync(scratchRoot);

    const result = installVscodeLauncher({
      platform: 'win32', env, nodePath: process.execPath, wrapperScriptPath: wrapper, tempRoot: scratchRoot,
    });

    expect(result).toEqual({
      ok: true,
      exePath: join(home, 'bin', 'clodex-claude.exe'),
      cscPath: csc,
      nodePath: process.execPath,
      wrapperScriptPath: wrapper,
    });
    // The output is the fake compiler's product, moved — not a copy of the source or anything else.
    expect(readFileSync(join(home, 'bin', 'clodex-claude.exe'), 'utf8')).toBe('MZ fake launcher built from clodex-claude-launcher.cs');
    // The scratch directory is gone, so nothing in it can be checked after the fact except through the
    // compiler's own record — which is why the fake copies its argv into the exe above. Resource delta:
    expect(readdirSync(scratchRoot)).toEqual([]);
    expect(readdirSync(join(home, 'bin'))).toEqual(['clodex-claude.exe']);
  });

  it('hands the compiler a BOM-prefixed source with both paths baked in and no absolute path in argv', () => {
    const csc = frameworkCsc('Framework64', 'v4.0.30319');
    const seen: { args: readonly string[]; cwd: string; source: string }[] = [];
    writeFakeCsc(csc);
    const wrapper = writeWrapperScript();
    const nodePath = join(dir, 'Program Files', 'nodejs', 'node.exe');
    mkdirSync(join(nodePath, '..'), { recursive: true });
    writeFileSync(nodePath, 'MZ');

    const result = installVscodeLauncher({
      platform: 'win32', env, nodePath, wrapperScriptPath: wrapper, tempRoot: dir,
      compile: (cscPath, args, cwd) => {
        seen.push({ args, cwd, source: readFileSync(join(cwd, 'clodex-claude-launcher.cs'), 'utf8') });
        return runCsc(cscPath, args, cwd);
      },
    });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const { args, cwd, source } = seen[0]!;
    expect(cwd.startsWith(dir)).toBe(true);
    expect(args).toEqual(['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/out:clodex-claude.exe', 'clodex-claude-launcher.cs']);
    expect(source.startsWith('\ufeff')).toBe(true);
    expect(decodeCSharpLiteral(constantLiteral(source, 'NodePath'))).toBe(nodePath);
    expect(decodeCSharpLiteral(constantLiteral(source, 'WrapperScriptPath'))).toBe(wrapper);
  });

  it('replaces an existing launcher as a new file rather than writing into the old one', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    const wrapper = writeWrapperScript();
    const exePath = join(home, 'bin', 'clodex-claude.exe');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(exePath, 'OLD LAUNCHER');
    // A second name for the same file: if the install wrote INTO the existing launcher this alias
    // would change too; a rename of a complete new file over the path leaves it untouched.
    const alias = join(home, 'old-launcher-alias.exe');
    linkSync(exePath, alias);

    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: wrapper, tempRoot: dir });

    expect(result.ok).toBe(true);
    expect(readFileSync(exePath, 'utf8')).toBe('MZ fake launcher built from clodex-claude-launcher.cs');
    expect(readFileSync(alias, 'utf8')).toBe('OLD LAUNCHER');
    // No temp file is left beside the launcher.
    expect(readdirSync(join(home, 'bin'))).toEqual(['clodex-claude.exe']);
  });

  it('is unnecessary off Windows and says why', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    const result = installVscodeLauncher({ platform: 'darwin', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });
    expect(result).toMatchObject({ ok: false, reason: 'not-windows' });
    expect((result as { message: string }).message).toMatch(/only needed on Windows/);
    expect((result as { message: string }).message).toMatch(/which clodex-claude/);
    expect(existsSync(join(home, 'bin'))).toBe(false);
  });

  it('fails clearly when no C# compiler is installed', () => {
    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });
    expect(result).toMatchObject({ ok: false, reason: 'no-csc' });
    expect((result as { message: string }).message).toContain(join(windir, 'Microsoft.NET', 'Framework64'));
    expect((result as { message: string }).message).toMatch(/\.NET Framework 4\.8/);
  });

  it('surfaces the compiler output when compilation fails and installs nothing', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'), 'fail');
    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });
    expect(result).toMatchObject({ ok: false, reason: 'compile-failed' });
    expect((result as { message: string }).message).toMatch(/exit 1/);
    expect((result as { detail: string }).detail).toContain('error CS1002: ; expected');
    expect((result as { detail: string }).detail).toContain('Visual C# Compiler');
    expect(existsSync(join(home, 'bin', 'clodex-claude.exe'))).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith('clodex-vscode-launcher-'))).toEqual([]);
  });

  it('never installs an exe left behind by a compiler that reported failure', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'), 'fail-leaving-partial-exe');
    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });
    expect(result).toMatchObject({ ok: false, reason: 'compile-failed' });
    expect((result as { detail: string }).detail).toContain('error CS0016');
    expect(existsSync(join(home, 'bin', 'clodex-claude.exe'))).toBe(false);
  });

  it('treats a compiler that exits 0 without producing the exe as a failure', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'), 'silent-no-output');
    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });
    expect(result).toMatchObject({ ok: false, reason: 'compile-failed' });
    expect(existsSync(join(home, 'bin', 'clodex-claude.exe'))).toBe(false);
  });

  it('reports a compiler that cannot be started', () => {
    const csc = frameworkCsc('Framework64', 'v4.0.30319');
    mkdirSync(join(csc, '..'), { recursive: true });
    writeFileSync(csc, 'not executable');
    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });
    expect(result).toMatchObject({ ok: false, reason: 'compile-failed' });
    expect((result as { message: string }).message).toContain(`could not run ${csc}`);
  });

  it('refuses to build when the wrapper script it would bake in does not exist', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    const missing = join(dir, 'nowhere', 'claude-wrapper.js');
    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: missing, tempRoot: dir });
    expect(result).toMatchObject({ ok: false, reason: 'missing-input' });
    expect((result as { message: string }).message).toContain(missing);
  });

  it('reports an unwritable destination', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    // CLODEX_HOME/bin is a FILE, so the directory cannot be created.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'bin'), 'in the way');
    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });
    expect(result).toMatchObject({ ok: false, reason: 'install-failed' });
    expect((result as { message: string }).message).toContain(join(home, 'bin', 'clodex-claude.exe'));
  });

  it('turns a compiler runner that throws into the ordinary one-line failure', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    const result = installVscodeLauncher({
      platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir,
      compile: () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'install-failed' });
    expect((result as { message: string }).message).toBe('could not build the launcher: EBUSY: resource busy or locked');
    expect(existsSync(join(home, 'bin', 'clodex-claude.exe'))).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith('clodex-vscode-launcher-'))).toEqual([]);
  });

  it('reports a scratch directory it could not remove as a warning without changing the outcome', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    let scratchDir = '';
    const result = installVscodeLauncher({
      platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir,
      compile: (cscPath, args, cwd) => {
        const compiled = runCsc(cscPath, args, cwd);
        // A directory the process cannot delete out of: the parent loses its write bit.
        scratchDir = cwd;
        chmodSync(cwd, 0o500);
        return compiled;
      },
    });
    try {
      expect(result).toMatchObject({ ok: true, exePath: join(home, 'bin', 'clodex-claude.exe') });
      expect(result.warning).toContain(`could not remove the scratch directory ${scratchDir}`);
      expect(readFileSync(join(home, 'bin', 'clodex-claude.exe'), 'utf8')).toBe('MZ fake launcher built from clodex-claude-launcher.cs');
    } finally {
      chmodSync(scratchDir, 0o700);
    }
  });

  it('reports an unusable temp directory instead of crashing', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    const missingTemp = join(dir, 'no-such-temp');
    const result = installVscodeLauncher({ platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: missingTemp });
    expect(result).toMatchObject({ ok: false, reason: 'install-failed' });
    expect((result as { message: string }).message).toContain(missingTemp);
  });

  it('places the launcher under the CLODEX_HOME override, not the real home', () => {
    expect(launcherInstallPath({ CLODEX_HOME: 'C:\\custom home' })).toBe(join('C:\\custom home', 'bin', 'clodex-claude.exe'));
    expect(launcherInstallPath({ USERPROFILE: 'C:\\Users\\jane' })).toBe(join('C:\\Users\\jane', '.clodex', 'bin', 'clodex-claude.exe'));
  });
});

describe('the printed setting', () => {
  it('is a JSON line the user can paste, with backslashes escaped', () => {
    expect(formatWrapperSetting('C:\\Users\\jane\\.clodex\\bin\\clodex-claude.exe'))
      .toBe('"claudeCode.claudeProcessWrapper": "C:\\\\Users\\\\jane\\\\.clodex\\\\bin\\\\clodex-claude.exe"');
    expect(JSON.parse(`{${formatWrapperSetting('C:\\a b\\x.exe')}}`)).toEqual({ 'claudeCode.claudeProcessWrapper': 'C:\\a b\\x.exe' });
  });
});

describe('clodex install-vscode-launcher command', () => {
  it('prints the path, the setting and the re-run reminder on success', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    const wrapper = writeWrapperScript();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = runInstallVscodeLauncherCommand({ platform: 'win32', env, wrapperScriptPath: wrapper, tempRoot: dir });

    expect(code).toBe(0);
    expect(error).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join('\n');
    const exePath = join(home, 'bin', 'clodex-claude.exe');
    expect(output).toContain(`Built ${exePath}`);
    expect(output).toContain(`"claudeCode.claudeProcessWrapper": ${JSON.stringify(exePath)}`);
    expect(output).toContain(wrapper);
    expect(output).toMatch(/switching Node versions/);
    expect(output).toMatch(/clodex server --proxy/);
    expect(output).toMatch(/claudeCode.environmentVariables/);
    expect(output).toMatch(/runs that patched\ninstall in place of the extension's bundled claude\.exe when the two builds match/);
    expect(output).not.toMatch(/not enabled on Windows/);
  });

  it('prints the failure and compiler output to stderr and exits 1', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'), 'fail');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = runInstallVscodeLauncherCommand({ platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });

    expect(code).toBe(1);
    expect(log).not.toHaveBeenCalled();
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('error CS1002');
  });

  it('prints a cleanup warning on stderr while still reporting success', () => {
    writeFakeCsc(frameworkCsc('Framework64', 'v4.0.30319'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let scratchDir = '';
    const code = runInstallVscodeLauncherCommand({
      platform: 'win32', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir,
      compile: (cscPath, args, cwd) => {
        const compiled = runCsc(cscPath, args, cwd);
        scratchDir = cwd;
        chmodSync(cwd, 0o500);
        return compiled;
      },
    });
    try {
      expect(code).toBe(0);
      expect(error.mock.calls.flat().join('\n')).toMatch(/^clodex: warning: could not remove the scratch directory/);
      expect(log.mock.calls.flat().join('\n')).toContain('Built ');
    } finally {
      chmodSync(scratchDir, 0o700);
    }
  });

  it('exits 1 off Windows with the pointer to clodex-claude', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = runInstallVscodeLauncherCommand({ platform: 'linux', env, wrapperScriptPath: writeWrapperScript(), tempRoot: dir });
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toMatch(/only needed on Windows/);
  });
});

describe('cli integration', () => {
  it('parses the command, its help, and rejects unknown options', () => {
    expect(parseArgs(['install-vscode-launcher'])).toMatchObject({ command: 'install-vscode-launcher', showHelp: false });
    expect(parseArgs(['install-vscode-launcher', '--help'])).toMatchObject({ command: 'install-vscode-launcher', showHelp: true });
    expect(parseArgs(['install-vscode-launcher', '--bogus'])).toMatchObject({ error: 'Unknown install-vscode-launcher option: --bogus' });
  });

  it('documents the command in root help and its own help', () => {
    expect(rootHelpText()).toContain('clodex install-vscode-launcher');
    const help = installVscodeLauncherHelpText();
    expect(help).toContain('clodex install-vscode-launcher');
    expect(help).toContain('claudeCode.claudeProcessWrapper');
    expect(help).toContain('spawn EINVAL');
    expect(help).toContain('csc.exe');
    expect(help).toContain('docs/windows-setup.md');
    expect(help).not.toContain('relay-ai');
  });

  it('prints the command help through main', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['install-vscode-launcher', '--help']);
    expect(code).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).includes('clodex install-vscode-launcher'))).toBe(true);
  });

  it('runs the command through main and reports the platform verdict on this machine', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['install-vscode-launcher']);
    if (process.platform === 'win32') {
      // A real Windows CI host would build or report csc/compile problems; either way it must not throw.
      expect([0, 1]).toContain(code);
    } else {
      expect(code).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toMatch(/only needed on Windows/);
      expect(log).not.toHaveBeenCalled();
    }
  });
});

/**
 * The packaged layout: `dist/cli.js` next to `dist/claude-wrapper.js`, with `launcher/` beside
 * `dist/`. Built by tsup into a scratch package so the command's DEFAULT input resolution — not an
 * injected path — is what gets exercised, on a process whose platform is forced to win32.
 */
describe('packaged default paths', () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let pkgRoot: string;

  beforeAll(async () => {
    pkgRoot = realpathSync(mkdtempSync(join(tmpdir(), 'clodex-launcher-pkg-')));
    await build({
      entry: [join(projectRoot, 'src', 'cli.ts'), join(projectRoot, 'src', 'claude-wrapper.ts')],
      format: ['esm'],
      target: 'node22',
      platform: 'node',
      outDir: join(pkgRoot, 'dist'),
      clean: true,
      dts: false,
      minify: false,
      silent: true,
      sourcemap: false,
      splitting: false,
      external: ['@napi-rs/keyring', 'ws', /^@ai-sdk\//, 'open', 'undici', 'https-proxy-agent', 'tweakcc'],
    });
    cpSync(join(projectRoot, 'launcher'), join(pkgRoot, 'launcher'), { recursive: true });
    // The bundle resolves its externals from node_modules; a link to the repo's is enough.
    symlinkSync(join(projectRoot, 'node_modules'), join(pkgRoot, 'node_modules'), 'junction');
  }, 180_000);

  afterAll(() => {
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  it('bakes the sibling dist/claude-wrapper.js and ships launcher/ without any override', () => {
    const csc = frameworkCsc('Framework64', 'v4.0.30319');
    writeFakeCsc(csc);
    const capture = join(dir, 'captured-source.cs');
    // The fake compiler keeps a copy of the source it was handed, the only record once scratch is gone.
    writeFileSync(csc, `#!/bin/sh\ncp clodex-claude-launcher.cs "${capture}"; printf "MZ packaged" > clodex-claude.exe; exit 0\n`);
    const preload = join(dir, 'force-win32.mjs');
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });\n");
    const temp = join(dir, 'temp');
    mkdirSync(temp);

    const run = spawnSync(process.execPath, ['--import', preload, join(pkgRoot, 'dist', 'cli.js'), 'install-vscode-launcher'], {
      encoding: 'utf8',
      env: { ...process.env, WINDIR: windir, CLODEX_HOME: home, TEMP: temp, TMP: temp },
    });

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(readFileSync(join(home, 'bin', 'clodex-claude.exe'), 'utf8')).toBe('MZ packaged');
    const source = readFileSync(capture, 'utf8');
    expect(decodeCSharpLiteral(constantLiteral(source, 'WrapperScriptPath'))).toBe(join(pkgRoot, 'dist', 'claude-wrapper.js'));
    expect(decodeCSharpLiteral(constantLiteral(source, 'NodePath'))).toBe(process.execPath);
    expect(run.stdout).toContain(`runs:     ${process.execPath} ${join(pkgRoot, 'dist', 'claude-wrapper.js')}`);
    expect(readdirSync(temp)).toEqual([]);
  });
});
