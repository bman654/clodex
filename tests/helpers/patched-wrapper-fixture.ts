import * as p from '@clack/prompts';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { runPatchCommand } from '../../src/patcher.js';

/** Minimal fake bundle carrying every required clodex patch anchor. */
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

export interface PatchedWrapperFixture {
  handedInPath: string;
  patchedPath: string;
  markerPath: string;
}

export async function createPatchedWrapperFixture(options: {
  testRoot: string;
  clodexHome: string;
  sentinel: string;
}): Promise<PatchedWrapperFixture> {
  const { testRoot, clodexHome, sentinel } = options;
  const patchedPath = join(testRoot, 'installed-claude');
  const handedInPath = join(testRoot, 'extension-claude');
  const markerPath = join(testRoot, 'vscode-claude-launched.json');
  const resultHelper = join(testRoot, 'vscode-result-helper.mjs');
  writeFileSync(
    resultHelper,
    [
      "import { writeFileSync } from 'node:fs';",
      'const [identity, ...args] = process.argv.slice(2);',
      'const result = {',
      '  identity,',
      '  pid: process.pid,',
      '  args,',
      '  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,',
      '  httpProxy: process.env.HTTP_PROXY ?? null,',
      '  httpsProxy: process.env.HTTPS_PROXY ?? null,',
      '  caPath: process.env.NODE_EXTRA_CA_CERTS ?? null,',
      '};',
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(result));`,
      "process.stdout.write(JSON.stringify(result) + '\\n');",
      'process.exit(Number(process.env.FAKE_EXIT_CODE ?? 0));',
      '',
    ].join('\n'),
  );
  const writePatchableClaude = (path: string) => {
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "2.1.273 (Claude Code)"; exit 0; fi',
        'if grep -q \'/[*]ccpatch:\' "$0"; then identity=patched-install; else identity=extension-bundle; fi',
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resultHelper)} "$identity" "$@"`,
        '',
      ].join('\n') + sentinel + PATCHABLE_BUNDLE,
      { mode: 0o755 },
    );
    chmodSync(path, 0o755);
  };
  writePatchableClaude(patchedPath);
  copyFileSync(patchedPath, handedInPath);
  chmodSync(handedInPath, 0o755);
  mkdirSync(clodexHome, { recursive: true });
  writeFileSync(join(clodexHome, 'config.json'), JSON.stringify({
    favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
  }));

  const saved = {
    CLODEX_HOME: process.env.CLODEX_HOME,
    TWEAKCC_CONFIG_DIR: process.env.TWEAKCC_CONFIG_DIR,
    TWEAKCC_CC_INSTALLATION_PATH: process.env.TWEAKCC_CC_INSTALLATION_PATH,
  };
  process.env.CLODEX_HOME = clodexHome;
  process.env.TWEAKCC_CONFIG_DIR = join(testRoot, 'tweakcc');
  process.env.TWEAKCC_CC_INSTALLATION_PATH = patchedPath;
  const logSpies = (['info', 'warn', 'error', 'success', 'step', 'message'] as const)
    .map(level => vi.spyOn(p.log, level).mockImplementation(() => {}));
  try {
    const exitCode = await runPatchCommand({});
    if (exitCode !== 0) throw new Error(`fake clodex patch exited ${exitCode}`);
  } finally {
    for (const spy of logSpies) spy.mockRestore();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  return { handedInPath, patchedPath, markerPath };
}

export interface WrapperResult {
  pid: number | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function wrapperEnv(
  clodexHome: string,
  envOverrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLODEX_HOME: clodexHome,
    ...envOverrides,
  };
  for (const name of [
    'CLODEX_REQUIRE_SERVER',
    'CLODEX_OAUTH_ACCOUNT',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDECODE',
  ]) {
    if (!Object.hasOwn(envOverrides, name)) delete env[name];
  }
  for (const name of Object.keys(env)) {
    if (/^CLODEX_KEY_[A-Z0-9_]+$/.test(name) && !Object.hasOwn(envOverrides, name)) {
      delete env[name];
    }
  }
  return env;
}

export async function runBuiltWrapper(options: {
  wrapperPath: string;
  clodexHome: string;
  args: string[];
  envOverrides?: NodeJS.ProcessEnv;
}): Promise<WrapperResult> {
  const { wrapperPath, clodexHome, args, envOverrides = {} } = options;
  const env = wrapperEnv(clodexHome, envOverrides);
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`wrapper timed out for arguments: ${args.join(' ')}`));
    }, 5_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ pid: child.pid, code, signal, stdout, stderr });
    });
  });
}

export async function runBuiltWrapperWithClosedStderr(options: {
  wrapperPath: string;
  clodexHome: string;
  args: string[];
  envOverrides?: NodeJS.ProcessEnv;
}): Promise<Omit<WrapperResult, 'stderr'>> {
  const { wrapperPath, clodexHome, args, envOverrides = {} } = options;
  const env = wrapperEnv(clodexHome, envOverrides);
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    // Close the reader before the wrapper's synchronous notice write. A notice
    // must not turn the launch into EPIPE/exit 134.
    child.stderr.destroy();

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('wrapper with closed stderr timed out'));
    }, 5_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ pid: child.pid, code, signal, stdout });
    });
  });
}
