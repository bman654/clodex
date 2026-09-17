// The VS Code patched-install substitution, on a real Windows host (the `windows-launcher` CI job).
//
// Two things only a Windows machine can settle, so neither is claimed from documentation:
//
// 1. What Node actually reports about files on NTFS — the selector in src/wrapper-target.ts guards
//    the window between inspecting a file and executing it with `dev`/`ino`/`size`/`mode`/`mtime`/
//    `ctime`, and each of those has a Windows-specific meaning (or none). The first suite measures
//    them and pins the facts the selector depends on, so a libuv change that breaks one is caught.
//
// 2. That the whole chain works end to end: `clodex install-vscode-launcher` builds
//    clodex-claude.exe with the runner's csc.exe; a fake claude.exe (tests/fixtures/fake-claude.cs,
//    compiled with the same csc) is patched by the REAL `clodex patch` command with tweakcc mocked
//    the way tests/patcher-command.test.ts mocks it; and the launcher, spawned the way the extension
//    spawns it, is handed a pristine copy and runs the patched one — with the fallback notice and
//    silent helper spawns proven on the same path.
//
// Off Windows both suites are skipped at collection, so `pnpm test` stays green elsewhere.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256File } from '../src/patch-backup.js';
import { readPatchManifest } from '../src/patch-manifest.js';
import { runPatchCommand } from '../src/patcher.js';
import { CSC_ARGS, findCsc, runCsc } from '../src/vscode-launcher.js';
import { finalizeWrapperTarget, prepareWrapperTarget } from '../src/wrapper-target.js';

const hoisted = vi.hoisted(() => ({ sentinel: '\n#__CLAUDE_BUNDLE__\n' }));

// Byte-preserving stand-in for tweakcc: the fake "binary" is a real PE image with the bundle
// appended after a sentinel, so the head has to survive the round trip untouched — latin1 maps
// every byte to exactly one code unit, where utf8 would replace invalid sequences.
vi.mock('tweakcc', () => ({
  tryDetectInstallation: async ({ path }: { path?: string }) => {
    if (!path || !existsSync(path)) throw new Error(`no installation at ${path}`);
    return { path, version: 'fake', kind: 'native' as const };
  },
  readContent: async (installation: { path: string }) => {
    const raw = readFileSync(installation.path, 'latin1');
    const index = raw.indexOf(hoisted.sentinel);
    if (index === -1) throw new Error('missing fake Claude bundle');
    return raw.slice(index + hoisted.sentinel.length);
  },
  writeContent: async (installation: { path: string }, content: string) => {
    const raw = readFileSync(installation.path, 'latin1');
    const head = raw.slice(0, raw.indexOf(hoisted.sentinel));
    writeFileSync(installation.path, Buffer.from(head + hoisted.sentinel + content, 'latin1'));
  },
}));

/** Minimal fake bundle carrying every required clodex patch anchor (same as the POSIX fixture). */
const PATCHABLE_BUNDLE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
  'function cwdOf(){let p=process.env.PWD;return p}',
  'function childEnv(){let e=extra(),t=Object.keys(e).length>0,n=Object.keys(e).length>0,s=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};let o=[process.env.CLAUDE_CODE_OAUTH_TOKEN,process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE,process.env.CLAUDE_BG_PTY_AUTH,"OTEL_",process.env.CLAUDE_CODE_OTEL_DIAG_STDERR],u=["CLAUDE_CODE_OAUTH_TOKEN"];if(!t&&!n&&!o[0])return process.env;let v={...process.env,...e,...s};for(let k of u)delete v[k],delete v[`INPUT_${k}`];return v}function mcpAllow(){let e=process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV;return e}',
].join('\n');

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'cli.js');
const onWindows = process.platform === 'win32';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const bigStat = (path: string) => statSync(path, { bigint: true });
const TWO_POW_53 = BigInt(2) ** BigInt(53);

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runToEnd(child: ChildProcess): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
    child.stdin?.end();
  });
}

function powershell(expression: string): string {
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', expression], { encoding: 'utf8' });
  expect(run.status, `powershell ${expression}: ${run.stderr}`).toBe(0);
  return run.stdout.trim();
}

describe.skipIf(!onWindows)('what Node reports about files on NTFS', () => {
  let dir: string;
  let drive: string;

  beforeAll(() => {
    dir = join(process.env.CLODEX_HOME!, '..', 'ntfs-probe');
    mkdirSync(dir, { recursive: true });
    drive = resolve(dir).slice(0, 2);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is measuring an NTFS volume', () => {
    const format = powershell(`([System.IO.DriveInfo]${JSON.stringify(drive)}).DriveFormat`);
    console.log(`[ntfs] ${drive} is ${format}; probe dir ${dir}; node ${process.version}`);
    expect(format).toBe('NTFS');
  });

  it('reports ino as a stable, non-zero 64-bit file id shared by hard links, and dev as the volume serial', () => {
    const a = join(dir, 'a.bin');
    const b = join(dir, 'b.bin');
    const aLink = join(dir, 'a-link.bin');
    writeFileSync(a, 'file a');
    writeFileSync(b, 'file b');
    linkSync(a, aLink);

    const first = bigStat(a);
    const second = bigStat(a);
    const fd = openSync(a, 'r');
    let viaHandle;
    try {
      viaHandle = fstatSync(fd, { bigint: true });
    } finally {
      closeSync(fd);
    }
    const other = bigStat(b);
    const linked = bigStat(aLink);

    const roundTrips = BigInt(Number(first.ino)) === first.ino;
    console.log(`[ntfs] ino(a)=${first.ino} (record ${first.ino & ((BigInt(1) << BigInt(48)) - BigInt(1))}, `
      + `sequence ${first.ino >> BigInt(48)}) > 2^53: ${first.ino > TWO_POW_53}; exact as a double: ${roundTrips}; `
      + `ino(b)=${other.ino}; dev=${first.dev} (0x${first.dev.toString(16)})`);

    expect(typeof first.ino).toBe('bigint');
    expect(first.ino).not.toBe(BigInt(0));
    expect(second.ino).toBe(first.ino);
    expect(viaHandle.ino).toBe(first.ino);
    expect(linked.ino).toBe(first.ino);
    expect(other.ino).not.toBe(first.ino);
    expect(first.dev).not.toBe(BigInt(0));
    expect(other.dev).toBe(first.dev);

    // Win32_LogicalDisk reports the same 32-bit serial libuv reads from FILE_FS_VOLUME_INFORMATION,
    // as eight hex digits and independent of the display language.
    const serial = powershell(`(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").VolumeSerialNumber`);
    expect(serial).toMatch(/^[0-9A-F]{8}$/i);
    expect(first.dev).toBe(BigInt(`0x${serial}`));
  });

  it('moves ctime on an in-place rewrite that restores mtime (ctime is the NTFS change time, not creation time)', async () => {
    // Integer seconds convert to FILETIME exactly, so the restored mtime is bit-identical.
    const T = 1_600_000_000;
    const path = join(dir, 'rewritten.bin');
    writeFileSync(path, 'known-pristine-build');
    utimesSync(path, T, T);
    const before = bigStat(path);
    await sleep(80);

    writeFileSync(path, 'known-PRISTINE-build');
    utimesSync(path, T, T);
    const after = bigStat(path);

    console.log(`[ntfs] rewrite: mtimeNs ${before.mtimeNs} -> ${after.mtimeNs}; ctimeNs ${before.ctimeNs} -> ${after.ctimeNs} `
      + `(+${(after.ctimeNs - before.ctimeNs) / BigInt(1_000_000)} ms); birthtimeNs ${before.birthtimeNs} -> ${after.birthtimeNs}`);
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.mtimeNs).toBe(BigInt(T) * BigInt(1_000_000_000));
    expect(after.ctimeNs > before.ctimeNs).toBe(true);
    expect(after.birthtimeNs).toBe(before.birthtimeNs);
  });

  it('carries the read-only attribute in mode, and passes X_OK for any existing file', () => {
    const path = join(dir, 'plain.txt');
    writeFileSync(path, 'not a program');
    const writable = bigStat(path).mode;
    chmodSync(path, 0o444);
    const readOnly = bigStat(path).mode;
    chmodSync(path, 0o644);
    console.log(`[ntfs] mode writable=0o${writable.toString(8)} read-only=0o${readOnly.toString(8)}`);

    expect(readOnly).not.toBe(writable);
    // Why src/wrapper-target.ts spells out its own Windows executable rule.
    expect(() => accessSync(path, fsConstants.X_OK)).not.toThrow();
  });

  it('lets the selector decline a same-size, mtime-restored rewrite of the handed-in file before handoff', () => {
    const handedIn = join(dir, 'extension-claude.exe');
    const patched = join(dir, 'installed-claude.exe');
    const manifestPath = join(dir, 'patch-state.json');
    const T = 1_600_000_000;
    writeFileSync(handedIn, 'known-pristine-build');
    writeFileSync(patched, 'known-patched-output');
    utimesSync(handedIn, T, T);
    writeFileSync(manifestPath, JSON.stringify({
      binaryPath: patched,
      claudeVersion: '2.1.273',
      configHash: 'current-config',
      patchedSize: statSync(patched).size,
      patchedSha256: sha256File(patched),
      backupPath: join(dir, 'pristine.orig'),
      pristineSha256: sha256File(handedIn),
      patchedAt: '2026-09-16T12:00:00.000Z',
    }));
    expect(finalizeWrapperTarget(prepareWrapperTarget(handedIn, { manifestPath })))
      .toEqual({ path: patched, reason: 'verified-patched-install' });

    const prepared = prepareWrapperTarget(handedIn, { manifestPath });
    expect(prepared.kind).toBe('candidate');
    writeFileSync(handedIn, 'known-PRISTINE-build');
    utimesSync(handedIn, T, T);
    expect(statSync(handedIn).size).toBe('known-pristine-build'.length);

    expect(finalizeWrapperTarget(prepared)).toMatchObject({
      path: handedIn,
      reason: 'input-changed-before-handoff',
    });
  });

  it('hashes a 200 MB file in a measured time', () => {
    const path = join(dir, 'two-hundred-mb.bin');
    const chunk = randomBytes(1 << 20);
    const expected = createHash('sha256');
    const fd = openSync(path, 'w');
    try {
      for (let i = 0; i < 200; i += 1) {
        writeSync(fd, chunk);
        expected.update(chunk);
      }
    } finally {
      closeSync(fd);
    }
    const expectedDigest = expected.digest('hex');
    const time = () => {
      const started = process.hrtime.bigint();
      const digest = sha256File(path);
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
      expect(digest).toBe(expectedDigest);
      return elapsed;
    };
    const first = time();
    const second = time();
    console.log(`[ntfs] sha256 of ${statSync(path).size} bytes: first ${first.toFixed(0)} ms, second ${second.toFixed(0)} ms `
      + '(both after the write, so warm; the runner offers no cache eviction)');
    expect(second).toBeLessThan(30_000);
  }, 120_000);
});

describe.skipIf(!onWindows)('clodex-claude.exe runs the clodex-patched install for the VS Code extension', () => {
  let home: string;
  let work: string;
  let launcherExe: string;
  let handedIn: string;
  let patched: string;
  let pristineBytes: Buffer;
  let markerPath: string;
  let manifestPath: string;
  let recordedPatched: string;
  let caPath: string;
  let proxy: { server: Server; port: number };
  const launched: ChildProcess[] = [];

  function launcherEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLODEX_HOME: home,
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      CLODEX_FAKE_MARKER: markerPath,
      ...extra,
    };
    for (const name of [
      'CLODEX_REQUIRE_SERVER',
      'CLODEX_OAUTH_ACCOUNT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDECODE',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'ANTHROPIC_BASE_URL',
    ]) {
      if (!Object.hasOwn(extra, name)) delete env[name];
    }
    for (const name of Object.keys(env)) {
      if (/^CLODEX_KEY_[A-Z0-9_]+$/i.test(name) && !Object.hasOwn(extra, name)) delete env[name];
    }
    return env;
  }

  /** Spawn exactly as the extension does: the launcher, the handed-in binary first, no shell. */
  function launch(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
    rmSync(markerPath, { force: true });
    const child = spawn(launcherExe, [handedIn, ...args], {
      env: launcherEnv(extra),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    launched.push(child);
    return runToEnd(child);
  }

  function readMarker(): { identity: string; pid: number; args: string[] } {
    return JSON.parse(readFileSync(markerPath, 'utf8'));
  }

  function rewriteHandedInOverlay(from: string, to: string): void {
    const raw = readFileSync(handedIn, 'latin1');
    expect(raw).toContain(from);
    expect(from.length).toBe(to.length);
    writeFileSync(handedIn, Buffer.from(raw.replace(from, to), 'latin1'));
    expect(statSync(handedIn).size).toBe(pristineBytes.length);
  }

  async function openLoopbackServer(): Promise<{ server: Server; port: number }> {
    const server = createServer(socket => socket.end());
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen({ port: 0, host: '127.0.0.1' }, () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    return { server, port: address.port };
  }

  beforeAll(async () => {
    expect(existsSync(cliPath), 'run `pnpm build` first — this suite drives the built dist/cli.js').toBe(true);
    home = process.env.CLODEX_HOME!;
    work = join(home, '..', 'substitution-work');
    mkdirSync(work, { recursive: true });
    mkdirSync(home, { recursive: true });
    markerPath = join(work, 'launched.json');
    manifestPath = join(home, 'patch-state.json');

    // 1. The launcher, built by the real command with the runner's own csc.exe.
    const install = spawnSync(process.execPath, [cliPath, 'install-vscode-launcher'], {
      encoding: 'utf8',
      env: { ...process.env, CLODEX_HOME: home },
    });
    expect(install.status, install.stderr).toBe(0);
    launcherExe = join(home, 'bin', 'clodex-claude.exe');
    expect(existsSync(launcherExe)).toBe(true);

    // 2. A fake claude.exe from the same compiler, carrying the bundle as overlay bytes.
    const csc = findCsc();
    expect(csc).not.toBeNull();
    const scratch = join(work, 'fake-claude-build');
    mkdirSync(scratch, { recursive: true });
    copyFileSync(join(projectRoot, 'tests', 'fixtures', 'fake-claude.cs'), join(scratch, 'fake-claude.cs'));
    const cscArgs = CSC_ARGS.map(arg => arg.replace('clodex-claude.exe', 'fake-claude.exe').replace('clodex-claude-launcher.cs', 'fake-claude.cs'));
    const compiled = runCsc(csc!, cscArgs, scratch);
    expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
    patched = join(work, 'installed-claude.exe');
    handedIn = join(work, 'extension-claude.exe');
    copyFileSync(join(scratch, 'fake-claude.exe'), patched);
    appendFileSync(patched, hoisted.sentinel + PATCHABLE_BUNDLE);
    copyFileSync(patched, handedIn);
    pristineBytes = readFileSync(handedIn);
    const version = spawnSync(patched, ['--version'], { encoding: 'utf8' });
    expect(version.stdout.trim()).toBe('2.1.273 (Claude Code)');

    // 3. The real `clodex patch`, in-process, against that install.
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    }));
    process.env.TWEAKCC_CONFIG_DIR = join(work, 'tweakcc');
    process.env.TWEAKCC_CC_INSTALLATION_PATH = patched;
    const logs: string[] = [];
    const logSpies = [
      ...(['info', 'warn', 'error', 'success', 'step'] as const)
        .map(level => vi.spyOn(p.log, level).mockImplementation((message: string) => { logs.push(`${level}: ${message}`); })),
      vi.spyOn(p.log, 'message').mockImplementation(() => {}),
    ];
    let exitCode: number;
    try {
      exitCode = await runPatchCommand({});
    } finally {
      for (const spy of logSpies) spy.mockRestore();
      delete process.env.TWEAKCC_CONFIG_DIR;
      delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
    }
    expect(exitCode, logs.join('\n')).toBe(0);
    const manifest = readPatchManifest(manifestPath);
    expect(manifest).not.toBeNull();
    recordedPatched = manifest!.binaryPath;
    // The manifest records the resolved path (the runner's TEMP is an 8.3 name); same file either way.
    expect(bigStat(recordedPatched).ino).toBe(bigStat(patched).ino);
    expect(manifest!.pristineSha256).toBe(sha256File(handedIn));
    expect(manifest!.patchedSha256).toBe(sha256File(patched));
    expect(manifest!.patchedSha256).not.toBe(manifest!.pristineSha256);
    expect(readFileSync(patched, 'latin1')).toContain('/*ccpatch:');
    expect(readFileSync(handedIn, 'latin1')).not.toContain('/*ccpatch:');

    // 4. A live proxy-mode server, as `clodex server --proxy` would advertise itself.
    proxy = await openLoopbackServer();
    caPath = join(work, 'proxy-ca.pem');
    writeFileSync(caPath, `${rootCertificates[0]}\n`);
    writeFileSync(join(home, 'server-runtime.json'), `${JSON.stringify([{
      mode: 'proxy',
      port: proxy.port,
      pid: process.pid,
      caPath,
      startedAt: new Date().toISOString(),
    }])}\n`);
  }, 300_000);

  // Every test starts from the pristine handed-in copy; a test that wants a mismatch makes it.
  beforeEach(() => {
    if (pristineBytes) writeFileSync(handedIn, pristineBytes);
  });

  afterAll(async () => {
    for (const child of launched) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    if (proxy?.server.listening) {
      await new Promise<void>(resolveClose => proxy.server.close(() => resolveClose()));
    }
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('runs the patched install, not the bundled copy, with the chat arguments and bridge env intact', async () => {
    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json', 'two words', 'double"quote', 'Zoë → проект', ''];
    const run = await launch(args, { FAKE_EXIT_CODE: '37' });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(37);
    const launchedProcess = readMarker();
    const expected = {
      identity: 'patched-install',
      pid: launchedProcess.pid,
      args,
      baseUrl: null,
      httpProxy: `http://127.0.0.1:${proxy.port}`,
      httpsProxy: `http://127.0.0.1:${proxy.port}`,
      caPath,
    };
    expect(JSON.parse(run.stdout)).toEqual(expected);
    expect(launchedProcess).toEqual(expected);
  }, 60_000);

  it('substitutes a helper spawn too, silently', async () => {
    const run = await launch(['auth', 'status', '--json']);
    expect(run).toMatchObject({ code: 0, stderr: '' });
    expect(readMarker()).toMatchObject({ identity: 'patched-install', args: ['auth', 'status', '--json'] });
  }, 60_000);

  it('falls back to the bundled copy with one stderr line when its bytes differ at the same size', async () => {
    rewriteHandedInOverlay('Defaults to inherit.', 'Defaults to another.');
    const args = ['--output-format', 'stream-json', 'space value', '"quoted"', ''];
    const run = await launch(args, { FAKE_EXIT_CODE: '29' });

    expect(run.code).toBe(29);
    expect(JSON.parse(run.stdout)).toMatchObject({ identity: 'extension-bundle', args });
    expect(run.stdout).not.toContain('clodex-claude:');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain(`clodex-claude: running ${JSON.stringify(handedIn)}`);
    expect(run.stderr).toContain('bytes do not match the pristine source');
    expect(run.stderr).toContain(JSON.stringify(recordedPatched));
    expect(run.stderr).toContain(JSON.stringify(manifestPath));
    expect(run.stderr).toContain('run `clodex patch` again');
  }, 60_000);

  it('delivers that notice on the shared stderr ahead of the bundled binary\'s own output', async () => {
    // Both fds into one file, in the order the extension's output channel receives them. The
    // wrapper writes the notice synchronously before it spawns (code order, src/claude-wrapper.ts);
    // this observes that the launcher's inherited handles carry it through, not the ordering
    // itself — a notice written just after the spawn would usually still land first.
    rewriteHandedInOverlay('Defaults to inherit.', 'Defaults to another.');
    const merged = join(work, 'merged-output.log');
    const fd = openSync(merged, 'w');
    let child: ChildProcess;
    try {
      child = spawn(launcherExe, [handedIn, '--output-format', 'stream-json'], {
        env: launcherEnv(),
        stdio: ['pipe', fd, fd],
        windowsHide: true,
      });
    } finally {
      closeSync(fd);
    }
    launched.push(child);
    child.stdin!.end();
    await new Promise<void>((resolveExit, reject) => {
      child.on('error', reject);
      child.on('close', () => resolveExit());
    });

    const lines = readFileSync(merged, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^clodex-claude: running /);
    expect(JSON.parse(lines[1]!)).toMatchObject({ identity: 'extension-bundle' });
  }, 60_000);

  it.each([
    ['nonpersistent suggestions query', ['--output-format', 'stream-json', '--no-session-persistence', '-p', 'suggest']],
    ['auth helper', ['auth', 'status', '--json']],
  ])('keeps a refused %s silent', async (_label, args) => {
    rewriteHandedInOverlay('Defaults to inherit.', 'Defaults to another.');
    const run = await launch(args, { FAKE_EXIT_CODE: '43' });
    expect(run).toMatchObject({ code: 43, stderr: '' });
    expect(JSON.parse(run.stdout)).toMatchObject({ identity: 'extension-bundle', args });
  }, 60_000);

  it('decides afresh on every spawn: a mismatch is not remembered once the pristine bytes are back', async () => {
    rewriteHandedInOverlay('Defaults to inherit.', 'Defaults to another.');
    const refused = await launch(['--output-format', 'stream-json']);
    expect(readMarker()).toMatchObject({ identity: 'extension-bundle' });
    expect(refused.stderr.trimEnd().split('\n')).toHaveLength(1);

    writeFileSync(handedIn, pristineBytes);
    const run = await launch(['--output-format', 'stream-json']);
    expect(run).toMatchObject({ code: 0, stderr: '' });
    expect(readMarker()).toMatchObject({ identity: 'patched-install' });
  }, 60_000);

  it('does not substitute without a live server', async () => {
    await new Promise<void>(resolveClose => proxy.server.close(() => resolveClose()));
    const run = await launch(['--output-format', 'stream-json']);
    expect(run).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(run.stdout)).toMatchObject({ identity: 'extension-bundle', httpProxy: null });
  }, 60_000);
});
