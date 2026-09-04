import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAINBASE = process.env['MAINBASE_DIR'] ?? '../clodex-review/mainbase';
// NOTE: this file does not exist in the repository and never has — it was not
// committed with the harness. Both probes below therefore exit 1 at module
// resolution before running anything. Recorded rather than silently left: the
// call this harness makes into src/upstream-retry.ts was updated when
// `upstreamMaxRetries` was removed, so the harness is correct by inspection but
// still not executable until this hook is supplied.
const REGISTER_HOOK = join(ROOT, 'tests/helpers/register-ts-resolve-hook.mjs');
const LAUNCH_URL = pathToFileURL(join(ROOT, 'src/launch.ts')).href;
const NOTICE_URL = pathToFileURL(join(ROOT, 'src/parent-notice.ts')).href;
const scratchDirs: string[] = [];
const tmuxSessions: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clodex-zz-round2-'));
  scratchDirs.push(dir);
  return dir;
}

function waitFor(path: string, timeoutMs = 15_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    execFileSync('sleep', ['0.02']);
  }
}

function nodeArgs(probe: string): string[] {
  return ['--experimental-strip-types', '--no-warnings', '--import', REGISTER_HOOK, probe];
}

function makeWaitingChild(dir: string, body = ''): { child: string; started: string; release: string } {
  const child = join(dir, 'fake-claude.sh');
  const started = join(dir, 'child-started');
  const release = join(dir, 'child-release');
  writeFileSync(child, `#!/bin/sh\n${body}\ntouch ${JSON.stringify(started)}\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done\n`);
  chmodSync(child, 0o755);
  return { child, started, release };
}

afterAll(() => {
  for (const session of tmuxSessions) spawnSync('tmux', ['kill-session', '-t', session]);
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe('round-two parent notice runtime review', () => {
  it('sends no notice bytes to a live real Claude TUI and flushes after child termination', () => {
    const dir = scratch();
    const emitted = join(dir, 'notice-emitted');
    const childExited = join(dir, 'child-exited');
    const release = join(dir, 'release-probe');
    const probe = join(dir, 'probe.mjs');
    const launcher = join(dir, 'launcher.sh');
    const session = `clodex-zz-real-${process.pid}-${Math.random().toString(16).slice(2)}`;
    tmuxSessions.push(session);

    writeFileSync(probe, `import { existsSync, writeFileSync } from 'node:fs';\nimport { launchClaude } from ${JSON.stringify(LAUNCH_URL)};\nimport { emitParentNotice } from ${JSON.stringify(NOTICE_URL)};\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\nprocess.env.CLODEX_CLAUDE_PATH = '${JSON.stringify(process.env['CLODEX_CLAUDE_PATH'] ?? 'claude')}';\nconst running = launchClaude({ ...process.env }, undefined, []);\nawait sleep(5000);\nemitParentNotice('clodex: warning: REAL-TUI-ROUND2');\nwriteFileSync(${JSON.stringify(emitted)}, '');\nconst code = await running;\nwriteFileSync(${JSON.stringify(childExited)}, String(code));\nwhile (!existsSync(${JSON.stringify(release)})) await sleep(20);\n`);
    writeFileSync(launcher, `#!/bin/sh\nexec env CLODEX_HOME=${JSON.stringify(join(dir, 'home'))} ${JSON.stringify(process.execPath)} --experimental-strip-types --no-warnings --import ${JSON.stringify(REGISTER_HOOK)} ${JSON.stringify(probe)}\n`);
    chmodSync(launcher, 0o755);

    const launched = spawnSync('tmux', ['new-session', '-d', '-x', '120', '-y', '30', '-s', session, launcher]);
    expect(launched.status, String(launched.stderr)).toBe(0);
    waitFor(emitted);
    const livePane = execFileSync('tmux', ['capture-pane', '-p', '-t', session], { encoding: 'utf8' });
    expect(livePane).not.toContain('REAL-TUI-ROUND2');

    const probePid = Number(execFileSync('tmux', ['display-message', '-p', '-t', session, '#{pane_pid}'], { encoding: 'utf8' }).trim());
    const claudePid = Number(execFileSync('pgrep', ['-P', String(probePid)], { encoding: 'utf8' }).trim().split('\n')[0]);
    process.kill(claudePid, 'SIGTERM');
    waitFor(childExited);
    const exitedPane = execFileSync('tmux', ['capture-pane', '-p', '-S', '-100', '-t', session], { encoding: 'utf8' });
    console.log(`REAL TUI LIVE:\n${livePane}\nREAL TUI AFTER EXIT:\n${exitedPane}`);
    expect(readFileSync(childExited, 'utf8')).toBe('143');
    expect(exitedPane).toContain('clodex: warning: REAL-TUI-ROUND2');
    expect(exitedPane.match(/REAL-TUI-ROUND2/g)).toHaveLength(1);
    writeFileSync(release, '');
  }, 30_000);

  it('copies to the debug file immediately while keeping terminal delivery deferred', async () => {
    const dir = scratch();
    const { child, started, release } = makeWaitingChild(dir);
    const emitted = join(dir, 'emitted');
    const debug = join(dir, 'debug.log');
    const probe = join(dir, 'debug-probe.mjs');
    writeFileSync(debug, '');
    writeFileSync(probe, `import { existsSync, writeFileSync } from 'node:fs';\nimport { launchClaude } from ${JSON.stringify(LAUNCH_URL)};\nimport { emitParentNotice } from ${JSON.stringify(NOTICE_URL)};\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\nprocess.env.CLODEX_CLAUDE_PATH = ${JSON.stringify(child)};\nconst running = launchClaude({ ...process.env }, undefined, ['--debug-file', ${JSON.stringify(debug)}]);\nwhile (!existsSync(${JSON.stringify(started)})) await sleep(10);\nemitParentNotice('DEBUG-IMMEDIATE');\nwriteFileSync(${JSON.stringify(emitted)}, '');\nawait running;\n`);
    const launched = spawn(process.execPath, nodeArgs(probe), { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    launched.stderr.on('data', chunk => { stderr += String(chunk); });
    waitFor(emitted);
    const debugWhileLive = readFileSync(debug, 'utf8');
    const stderrWhileLive = stderr;
    writeFileSync(release, '');
    const status = await new Promise<number | null>((resolve, reject) => {
      launched.on('error', reject);
      launched.on('exit', resolve);
    });
    console.log(`DEBUG IMMEDIATE status=${status} liveDebug=${JSON.stringify(debugWhileLive)} liveStderr=${JSON.stringify(stderrWhileLive)} finalStderr=${JSON.stringify(stderr)}`);
    expect(status).toBe(0);
    expect(debugWhileLive).toContain('[parent] DEBUG-IMMEDIATE');
    expect(stderrWhileLive).not.toContain('DEBUG-IMMEDIATE');
    expect(stderr).toContain('DEBUG-IMMEDIATE');
  });

  it('matches mainbase on deferred EPIPE and also closes the immediate path', () => {
    const runDeferred = (root: string, label: string): string => {
      const dir = scratch();
      const started = join(dir, 'started');
      const child = join(dir, 'child.sh');
      const probe = join(dir, 'probe.mjs');
      const runner = join(dir, 'runner.sh');
      const launchUrl = pathToFileURL(join(root, 'src/launch.ts')).href;
      const retryUrl = pathToFileURL(join(root, 'src/upstream-retry.ts')).href;
      writeFileSync(child, `#!/bin/sh\nprintf 'child-first-line\\n'\ntouch ${JSON.stringify(started)}\nsleep 1\n`);
      chmodSync(child, 0o755);
      writeFileSync(probe, `import { existsSync } from 'node:fs';\nimport { launchClaude } from ${JSON.stringify(launchUrl)};\nimport { upstreamRequestBudget } from ${JSON.stringify(retryUrl)};\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\nprocess.env.CLODEX_CLAUDE_PATH = ${JSON.stringify(child)};\nconst running = launchClaude({ ...process.env }, undefined, []);\nwhile (!existsSync(${JSON.stringify(started)})) await sleep(10);\nawait sleep(300);\nupstreamRequestBudget({ env: { CLODEX_UPSTREAM_MAX_RETRIES: '6' } });\nawait running;\nawait sleep(200);\n`);
      writeFileSync(runner, `#!/bin/bash\nset +e\nset -o pipefail\n${JSON.stringify(process.execPath)} --experimental-strip-types --no-warnings --import ${JSON.stringify(REGISTER_HOOK)} ${JSON.stringify(probe)} 2>&1 | head -n 1\ncodes=(\"\${PIPESTATUS[@]}\")\nprintf '${label}_node=%s head=%s\\n' \"\${codes[0]}\" \"\${codes[1]}\"\n`);
      chmodSync(runner, 0o755);
      return execFileSync(runner, { encoding: 'utf8', env: { ...process.env, CLODEX_HOME: join(dir, 'home') } });
    };

    const baseline = runDeferred(MAINBASE, 'mainbase');
    const current = runDeferred(ROOT, 'b592b69');

    const immediateDir = scratch();
    const immediateProbe = join(immediateDir, 'immediate.mjs');
    const immediateRunner = join(immediateDir, 'immediate.sh');
    writeFileSync(immediateProbe, `import { emitParentNotice } from ${JSON.stringify(NOTICE_URL)};\nawait new Promise(r => setTimeout(r, 200));\nemitParentNotice('immediate closed pipe');\nawait new Promise(r => setTimeout(r, 200));\n`);
    writeFileSync(immediateRunner, `#!/bin/bash\nset +e\nset -o pipefail\n{ printf 'first-line\\n'; ${JSON.stringify(process.execPath)} --experimental-strip-types --no-warnings --import ${JSON.stringify(REGISTER_HOOK)} ${JSON.stringify(immediateProbe)}; } 2>&1 | head -n 1\ncodes=(\"\${PIPESTATUS[@]}\")\nprintf 'immediate_writer=%s head=%s\\n' \"\${codes[0]}\" \"\${codes[1]}\"\n`);
    chmodSync(immediateRunner, 0o755);
    const immediate = execFileSync(immediateRunner, { encoding: 'utf8' });

    console.log(`EPIPE baseline=${JSON.stringify(baseline)} current=${JSON.stringify(current)} immediate=${JSON.stringify(immediate)}`);
    expect(baseline).toContain('mainbase_node=0 head=0');
    expect(current).toContain('b592b69_node=0 head=0');
    expect(immediate).toContain('immediate_writer=0 head=0');
  }, 15_000);

  it.each(['SIGINT', 'SIGTERM'] as const)('flushes after forwarding %s through the child exit path', async signal => {
    const dir = scratch();
    const started = join(dir, 'signal-started');
    const childScript = join(dir, 'signal-child.sh');
    const probe = join(dir, 'signal-probe.mjs');
    writeFileSync(childScript, `#!/bin/sh\ntrap 'printf "CHILD-${signal}\\n" >&2; exit 42' INT TERM\ntouch ${JSON.stringify(started)}\nwhile :; do sleep 0.05; done\n`);
    chmodSync(childScript, 0o755);
    writeFileSync(probe, `import { launchClaude } from ${JSON.stringify(LAUNCH_URL)};\nimport { emitParentNotice } from ${JSON.stringify(NOTICE_URL)};\nprocess.env.CLODEX_CLAUDE_PATH = ${JSON.stringify(childScript)};\nconst running = launchClaude({ ...process.env }, undefined, []);\nemitParentNotice('QUEUED-${signal}');\nconst code = await running;\nprocess.stderr.write('AFTER-${signal}-' + code + '\\n');\n`);
    const child = spawn(process.execPath, nodeArgs(probe), { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    waitFor(started);
    child.kill(signal);
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    console.log(`${signal} status=${status} stderr=${JSON.stringify(stderr)}`);
    expect(status).toBe(0);
    expect(stderr).toContain(`CHILD-${signal}`);
    expect(stderr).toContain(`QUEUED-${signal}`);
    expect(stderr).toContain(`AFTER-${signal}-42`);
    expect(stderr.indexOf(`QUEUED-${signal}`)).toBeGreaterThan(stderr.indexOf(`CHILD-${signal}`));
  });

  it('flushes synchronously on process.exit and uncaught exception without duplicates', () => {
    const run = (mode: 'exit' | 'throw'): { status: number | null; stderr: string } => {
      const dir = scratch();
      const child = join(dir, 'backstop-child.sh');
      const started = join(dir, 'backstop-started');
      const probe = join(dir, 'probe.mjs');
      writeFileSync(child, `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 1\n`);
      chmodSync(child, 0o755);
      writeFileSync(probe, `import { existsSync } from 'node:fs';\nimport { launchClaude } from ${JSON.stringify(LAUNCH_URL)};\nimport { emitParentNotice } from ${JSON.stringify(NOTICE_URL)};\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\nprocess.env.CLODEX_CLAUDE_PATH = ${JSON.stringify(child)};\nvoid launchClaude({ ...process.env }, undefined, []);\nwhile (!existsSync(${JSON.stringify(started)})) await sleep(10);\nemitParentNotice('BACKSTOP-${mode}');\n${mode === 'exit' ? 'process.exit(23);' : "throw new Error('fatal-probe');"}\n`);
      const result = spawnSync(process.execPath, nodeArgs(probe), { encoding: 'utf8', timeout: 10_000 });
      return { status: result.status, stderr: result.stderr };
    };

    const exited = run('exit');
    const threw = run('throw');
    console.log(`BACKSTOP exit=${JSON.stringify(exited)} throw=${JSON.stringify(threw)}`);
    expect(exited.status).toBe(23);
    expect(exited.stderr.match(/BACKSTOP-exit/g)).toHaveLength(1);
    expect(threw.status).toBe(1);
    expect(threw.stderr).toContain('fatal-probe');
    expect(threw.stderr.match(/BACKSTOP-throw/g)).toHaveLength(1);
  }, 20_000);

  it('keeps the synchronous exit backstop survivable after stderr closes', () => {
    const dir = scratch();
    const started = join(dir, 'closed-exit-started');
    const childScript = join(dir, 'closed-exit-child.sh');
    const probe = join(dir, 'closed-exit-probe.mjs');
    const runner = join(dir, 'closed-exit-runner.sh');
    writeFileSync(childScript, `#!/bin/sh\nprintf 'first-line\\n'\ntouch ${JSON.stringify(started)}\nsleep 1\n`);
    chmodSync(childScript, 0o755);
    writeFileSync(probe, `import { existsSync } from 'node:fs';\nimport { launchClaude } from ${JSON.stringify(LAUNCH_URL)};\nimport { emitParentNotice } from ${JSON.stringify(NOTICE_URL)};\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\nprocess.env.CLODEX_CLAUDE_PATH = ${JSON.stringify(childScript)};\nvoid launchClaude({ ...process.env }, undefined, []);\nwhile (!existsSync(${JSON.stringify(started)})) await sleep(10);\nemitParentNotice('CLOSED-BACKSTOP');\nawait sleep(200);\nprocess.exit(23);\n`);
    writeFileSync(runner, `#!/bin/bash\nset +e\nset -o pipefail\n${JSON.stringify(process.execPath)} --experimental-strip-types --no-warnings --import ${JSON.stringify(REGISTER_HOOK)} ${JSON.stringify(probe)} 2>&1 | head -n 1\ncodes=(\"\${PIPESTATUS[@]}\")\nprintf 'closed_backstop_node=%s head=%s\\n' \"\${codes[0]}\" \"\${codes[1]}\"\n`);
    chmodSync(runner, 0o755);
    const output = execFileSync(runner, { encoding: 'utf8' });
    console.log(`CLOSED BACKSTOP ${JSON.stringify(output)}`);
    expect(output).toContain('closed_backstop_node=23 head=0');
  }, 10_000);

  it('keeps FIFO order, flushes once, and applies the 50-line cap without off-by-one errors', () => {
    const run = (count: number): { stderr: string; debug: string } => {
      const dir = scratch();
      const { child, started, release } = makeWaitingChild(dir);
      const debug = join(dir, 'debug.log');
      const probe = join(dir, 'probe.mjs');
      writeFileSync(debug, '');
      writeFileSync(probe, `import { existsSync, writeFileSync } from 'node:fs';\nimport { launchClaude } from ${JSON.stringify(LAUNCH_URL)};\nimport { emitParentNotice } from ${JSON.stringify(NOTICE_URL)};\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\nprocess.env.CLODEX_CLAUDE_PATH = ${JSON.stringify(child)};\nconst running = launchClaude({ ...process.env }, undefined, ['--debug-file', ${JSON.stringify(debug)}]);\nwhile (!existsSync(${JSON.stringify(started)})) await sleep(10);\nfor (let i = 1; i <= ${count}; i++) emitParentNotice('Q-' + String(i).padStart(2, '0'));\nwriteFileSync(${JSON.stringify(release)}, '');\nawait running;\nprocess.stderr.write('AFTER-LAUNCH\\n');\nprocess.exit(0);\n`);
      const result = spawnSync(process.execPath, nodeArgs(probe), { encoding: 'utf8' });
      expect(result.status).toBe(0);
      return { stderr: result.stderr, debug: readFileSync(debug, 'utf8') };
    };

    const fifty = run(50);
    const fiftyOne = run(51);
    const fiftyTwo = run(52);
    console.log(`CAP 50-lines=${fifty.stderr.trim().split('\n').length} 51-tail=${JSON.stringify(fiftyOne.stderr.split('\n').slice(-4))} 52-tail=${JSON.stringify(fiftyTwo.stderr.split('\n').slice(-4))}`);

    expect(fifty.stderr.match(/^Q-/gm)).toHaveLength(50);
    expect(fifty.stderr).not.toContain('suppressed while');
    expect(fiftyOne.stderr.match(/^Q-/gm)).toHaveLength(50);
    expect(fiftyOne.stderr).toContain('and 1 further notice suppressed');
    expect(fiftyTwo.stderr.match(/^Q-/gm)).toHaveLength(50);
    expect(fiftyTwo.stderr).toContain('and 2 further notices suppressed');
    expect(fiftyTwo.stderr).not.toContain('Q-51');
    expect(fiftyTwo.stderr).not.toContain('Q-52');
    expect(fiftyTwo.stderr.lastIndexOf('AFTER-LAUNCH')).toBeGreaterThan(fiftyTwo.stderr.lastIndexOf('suppressed while'));
    expect(fiftyTwo.debug.match(/^\[parent\] Q-/gm)).toHaveLength(52);
    expect(fiftyTwo.stderr.match(/Q-01/g)).toHaveLength(1);
  }, 20_000);

  it('does not silently truncate the maximum queued flush before explicit process.exit', () => {
    const dir = scratch();
    const child = join(dir, 'child.sh');
    const probe = join(dir, 'probe.mjs');
    const runner = join(dir, 'runner.sh');
    writeFileSync(child, '#!/bin/sh\nexit 0\n');
    chmodSync(child, 0o755);
    writeFileSync(probe, `import { launchClaude } from ${JSON.stringify(LAUNCH_URL)};\nimport { emitParentNotice } from ${JSON.stringify(NOTICE_URL)};\nprocess.env.CLODEX_CLAUDE_PATH = ${JSON.stringify(child)};\nconst running = launchClaude({ ...process.env }, undefined, []);\nfor (let i = 0; i < 50; i++) emitParentNotice('x'.repeat(2000));\nconst code = await running;\nprocess.exit(code);\n`);
    writeFileSync(runner, `#!/bin/bash\nset -o pipefail\n${JSON.stringify(process.execPath)} --experimental-strip-types --no-warnings --import ${JSON.stringify(REGISTER_HOOK)} ${JSON.stringify(probe)} 2>&1 | { sleep 1; wc -c; }\nprintf 'pipeline=%s\\n' \"$?\"\n`);
    chmodSync(runner, 0o755);
    const output = execFileSync(runner, { encoding: 'utf8', timeout: 10_000 });
    console.log(`MAX FLUSH ${JSON.stringify(output)}`);
    expect(output).toContain('100050');
    expect(output).toContain('pipeline=0');
  }, 15_000);
});
