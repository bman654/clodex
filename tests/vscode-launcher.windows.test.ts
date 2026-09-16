// The real thing, on a real Windows host: `clodex install-vscode-launcher` from the built
// `dist/cli.js` compiles `launcher/clodex-claude-launcher.cs` with the runner's own .NET Framework
// csc.exe, and the resulting clodex-claude.exe is spawned the way the VS Code extension spawns it —
// no shell, arguments as an array — with the extension's "bundled claude" argument pointing at
// node.exe plus a probe script. Every process boundary the launcher exists for is exercised:
// launcher → node claude-wrapper.js → (direct .exe spawn) → node probe.mjs → grandchild.
//
// Runs only on win32 (the `windows-launcher` CI job); on every other platform the suite is
// skipped at collection, so `pnpm test` stays green off Windows.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'cli.js');

const HOSTILE_ARGS = [
  'C:\\Users\\Jane Doe\\.vscode\\extensions\\anthropic.claude-code-2.1.267-win32-x64\\resources\\native-binary\\claude.exe',
  '--output-format',
  'stream-json',
  'with space',
  'embedded "quote" inside',
  '{"a":"b c","nested":{"x":[1,"two"]}}',
  '',
  '%PATH%',
  '&|<>^',
  'trailing\\',
  'Zoë → проект 😀',
  '--flag=value with "quotes" and \\backslashes\\',
];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runToEnd(child: ChildProcess, stdin?: string): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin!.end(stdin);
    else child.stdin!.end();
  });
}

function processAlive(pid: number): boolean {
  const list = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return list.stdout.includes(`"${pid}"`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

describe.skipIf(process.platform !== 'win32')('clodex-claude.exe built by clodex install-vscode-launcher', () => {
  let home: string;
  let work: string;
  let exePath: string;
  let probePath: string;
  const launched: ChildProcess[] = [];

  function launcherEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CLODEX_HOME: home, ...extra };
    delete env.CLODEX_REQUIRE_SERVER;
    return env;
  }

  function install(): Run {
    const run = spawnSync(process.execPath, [cliPath, 'install-vscode-launcher'], {
      encoding: 'utf8',
      env: launcherEnv(),
    });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  /** Spawn exactly as the extension does: the executable, an argv array, no shell. */
  function launch(args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess {
    const child = spawn(exePath, [process.execPath, probePath, ...args], {
      env: launcherEnv(extra),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    launched.push(child);
    return child;
  }

  beforeAll(() => {
    expect(existsSync(cliPath), 'run `pnpm build` first — this suite drives the built dist/cli.js').toBe(true);
    home = process.env.CLODEX_HOME!;
    work = join(home, '..', 'launcher-work');
    mkdirSync(work, { recursive: true });
    exePath = join(home, 'bin', 'clodex-claude.exe');
    probePath = join(work, 'probe.mjs');
    writeFileSync(probePath, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      'if (process.env.CLODEX_PROBE_LINGER) {',
      '  // Stand in for a long chat: stay alive with a grandchild until something kills us.',
      "  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      '  writeFileSync(process.env.CLODEX_PROBE_PIDS, JSON.stringify({ probe: process.pid, grandchild: grandchild.pid }));',
      '  setInterval(() => {}, 1000);',
      '} else {',
      '  let stdin = "";',
      "  process.stdin.setEncoding('utf8');",
      '  for await (const chunk of process.stdin) stdin += chunk;',
      '  const report = { argv: process.argv.slice(2), stdin, pid: process.pid, cwd: process.cwd() };',
      "  process.stdout.write(JSON.stringify(report) + '\\n');",
      '  process.exit(Number(process.env.CLODEX_PROBE_EXIT ?? 0));',
      '}',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    for (const child of launched.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('compiles the shipped source with the machine\'s own csc.exe and prints the setting', () => {
    const run = install();
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Built ${exePath}`);
    expect(run.stdout).toMatch(/compiler: .*\\Microsoft\.NET\\Framework(64)?\\v4\.[\d.]+\\csc\.exe/);
    expect(run.stdout).toContain(`"claudeCode.claudeProcessWrapper": ${JSON.stringify(exePath)}`);
    expect(readFileSync(exePath).subarray(0, 2).toString('latin1')).toBe('MZ');
  }, 180_000);

  it('hands every argument value to Claude through node and the wrapper unchanged, relays stdin, and returns the exit code', async () => {
    const run = await runToEnd(launch(HOSTILE_ARGS, { CLODEX_PROBE_EXIT: '7' }), 'stdin line one\nline two ✓\n');
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as { argv: string[]; stdin: string; cwd: string };
    // The probe's argv is what the wrapper spawned it with: the extension's arguments after the
    // "bundled claude" path, which the wrapper consumed as its target (process.execPath here).
    expect(report.argv).toEqual(HOSTILE_ARGS);
    expect(report.stdin).toBe('stdin line one\nline two ✓\n');
    expect(report.cwd).toBe(process.cwd());
    expect(run.code).toBe(7);
  }, 60_000);

  it('returns 0 when Claude does', async () => {
    const run = await runToEnd(launch(['-p', 'hello']), '');
    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { argv: string[] }).argv).toEqual(['-p', 'hello']);
  }, 60_000);

  it('takes node, the wrapper and the grandchild down when the extension kills the launcher', async () => {
    const pidsFile = join(work, `pids-${Date.now()}.json`);
    const child = launch(['--linger'], { CLODEX_PROBE_LINGER: '1', CLODEX_PROBE_PIDS: pidsFile });
    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    await waitFor(() => existsSync(pidsFile), 30_000, 'the probe to start');
    const { probe, grandchild } = JSON.parse(readFileSync(pidsFile, 'utf8')) as { probe: number; grandchild: number };
    expect(processAlive(probe)).toBe(true);
    expect(processAlive(grandchild)).toBe(true);
    expect(stderr).toBe('');

    expect(child.kill()).toBe(true);

    await waitFor(() => !processAlive(probe) && !processAlive(grandchild), 10_000, 'the probe and its grandchild to die');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000, 'the launcher to exit');
  }, 60_000);

  it('reports a running launcher clearly when re-installed over it, and still works afterwards', async () => {
    const pidsFile = join(work, `pids-busy-${Date.now()}.json`);
    const child = launch(['--linger'], { CLODEX_PROBE_LINGER: '1', CLODEX_PROBE_PIDS: pidsFile });
    await waitFor(() => existsSync(pidsFile), 30_000, 'the probe to start');

    const run = install();
    // Windows may or may not let a running image be replaced by rename; either way the command
    // must end in a one-line verdict, never a stack trace, and must leave a working launcher.
    expect(run.stderr).not.toMatch(/\n\s+at /);
    if (run.code !== 0) {
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^clodex: could not write .*clodex-claude\.exe: .*If VS Code is running a chat through the launcher, close it and re-run\./m);
    }

    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000, 'the launcher to exit');
    const after = await runToEnd(launch(['still', 'works']), '');
    expect(after.code).toBe(0);
    expect((JSON.parse(after.stdout) as { argv: string[] }).argv).toEqual(['still', 'works']);
  }, 180_000);

  it('exits 127 with a re-run hint when the baked wrapper script is gone', async () => {
    // A second copy of the package, so its dist/claude-wrapper.js can be deleted after the
    // launcher was baked against it without touching the real build.
    const pkg = join(work, 'moved-pkg');
    cpSync(join(projectRoot, 'dist'), join(pkg, 'dist'), { recursive: true });
    cpSync(join(projectRoot, 'launcher'), join(pkg, 'launcher'), { recursive: true });
    symlinkSync(join(projectRoot, 'node_modules'), join(pkg, 'node_modules'), 'junction');
    const staleHome = join(work, 'stale-home');
    const build = spawnSync(process.execPath, [join(pkg, 'dist', 'cli.js'), 'install-vscode-launcher'], {
      encoding: 'utf8',
      env: launcherEnv({ CLODEX_HOME: staleHome }),
    });
    expect(build.stderr).toBe('');
    expect(build.status).toBe(0);
    rmSync(join(pkg, 'dist', 'claude-wrapper.js'));

    const child = spawn(join(staleHome, 'bin', 'clodex-claude.exe'), [process.execPath, probePath, '-p', 'x'], {
      env: launcherEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    launched.push(child);
    const run = await runToEnd(child, '');
    expect(run.code).toBe(127);
    expect(run.stdout).toBe('');
    expect(run.stderr.trim()).toBe(
      `clodex-claude.exe: clodex's claude-wrapper.js is no longer at ${join(pkg, 'dist', 'claude-wrapper.js')}; re-run \`clodex install-vscode-launcher\``,
    );
  }, 180_000);
});
