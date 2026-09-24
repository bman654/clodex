// Issue #257 end to end: `clodex patch` against a fake claude and fake editor extension
// directories, all under a throwaway HOME / CLODEX_HOME / TWEAKCC_CONFIG_DIR. Same harness shape as
// patcher-command.test.ts — the claude "binary" is a shell script that answers `--version` and
// carries its bundle after a sentinel, and tweakcc's three calls are mocked to read/write it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as p from '@clack/prompts';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPatchManifest, runPatchCommand } from '../src/patcher.js';
import { installFakeExtension, snapshotTree, writeFakeNpm } from './helpers/fake-editor-extension.js';

const hoisted = vi.hoisted(() => ({ sentinel: '\n#__CLAUDE_BUNDLE__\n' }));

vi.mock('tweakcc', () => ({
  tryDetectInstallation: async ({ path }: { path?: string }) => {
    if (!path || !existsSync(path)) throw new Error(`no installation at ${path}`);
    return { path, version: 'fake', kind: 'native' as const };
  },
  readContent: async (installation: { path: string }) => {
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

/** A minified stand-in for the Claude Code bundle carrying every required patch anchor. */
const PRISTINE_BUNDLE = [
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

let home: string;
let logs: string[];
const originalPath = process.env.PATH;

function writeFakeClaude(path: string, version: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexit 1\n`
      + hoisted.sentinel + PRISTINE_BUNDLE,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}

/** A native-installer claude: versioned file behind the `~/.local/bin/claude` symlink. */
function installNativeClaude(version: string): string {
  const real = join(home, '.local', 'share', 'claude', 'versions', version);
  writeFakeClaude(real, version);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(real, join(home, '.local', 'bin', 'claude'));
  return realpathSync(real);
}

/** Where the fake `npm root -g` on PATH says global packages live. */
const npmGlobalRoot = () => join(home, 'npm', 'lib', 'node_modules');

/**
 * A claude under `node_modules` at `packageRoot`, named to the patcher through
 * TWEAKCC_CC_INSTALLATION_PATH the way a user pins one.
 */
function installNodeModulesClaude(packageRoot: string, version: string): string {
  const real = join(packageRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  writeFakeClaude(real, version);
  process.env.TWEAKCC_CC_INSTALLATION_PATH = real;
  return realpathSync(real);
}

const driftWarnings = () => logs.filter(line => line.startsWith('warn:') && line.includes('Claude Code extension'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clodex-patch-drift-'));
  process.env.HOME = home;
  process.env.CLODEX_HOME = join(home, '.clodex');
  process.env.TWEAKCC_CONFIG_DIR = join(home, '.tweakcc');
  delete process.env.CLODEX_CLAUDE_PATH;
  delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
  // The fix command depends on `npm root -g`; answer it from a fake npm, never the host's.
  writeFakeNpm(join(home, 'fake-bin'), npmGlobalRoot());
  process.env.PATH = `${join(home, 'fake-bin')}:${originalPath}`;
  mkdirSync(join(home, '.clodex'), { recursive: true });
  writeFileSync(join(home, '.clodex', 'config.json'), JSON.stringify({
    favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
  }));
  logs = [];
  for (const level of ['info', 'warn', 'error', 'success', 'step', 'message'] as const) {
    vi.spyOn(p.log, level).mockImplementation((message?: unknown) => {
      logs.push(`${level}: ${String(message)}`);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.PATH = originalPath;
  delete process.env.TWEAKCC_CONFIG_DIR;
  delete process.env.TWEAKCC_CC_INSTALLATION_PATH;
  rmSync(home, { recursive: true, force: true });
});

describe('clodex patch warns when an editor extension and the patched Claude Code differ (#257)', () => {
  it('warns after patching, with the native installer command for a native install', async () => {
    const binary = installNativeClaude('2.1.267');
    installFakeExtension(home, '.vscode', '2.1.276', { lingering: ['2.1.267'] });

    expect(await runPatchCommand({})).toBe(0);

    expect(readPatchManifest()?.claudeVersion).toBe('2.1.267');
    const warnings = driftWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`VS Code's Claude Code extension is 2.1.276, but the Claude Code clodex patched is 2.1.267 (${binary}).`);
    expect(warnings[0]).toContain('clodex models will not appear in its model picker');
    expect(warnings[0]).toContain('To fix it, run:\n  claude install 2.1.276\n  clodex patch');
    expect(warnings[0]).not.toContain('npm install');
    // After the result, so it is the last thing the user reads.
    expect(logs.at(-1)).toBe(warnings[0]);
  });

  it('still warns when the patch is already current — the run a user makes after the extension updated', async () => {
    installNativeClaude('2.1.267');
    expect(await runPatchCommand({})).toBe(0);
    expect(driftWarnings()).toEqual([]);

    installFakeExtension(home, '.vscode', '2.1.276', { lingering: ['2.1.267'] });
    logs.length = 0;
    expect(await runPatchCommand({})).toBe(0);

    expect(logs.some(line => line.includes('already patched with the current model config'))).toBe(true);
    expect(driftWarnings()).toHaveLength(1);
    expect(driftWarnings()[0]).toContain('extension is 2.1.276');
  });

  it('prints the npm command for a global npm install', async () => {
    installNodeModulesClaude(npmGlobalRoot(), '2.1.267');
    installFakeExtension(home, '.vscode', '2.1.276', { platform: 'win32-x64' });

    expect(await runPatchCommand({})).toBe(0);

    expect(driftWarnings()).toHaveLength(1);
    expect(driftWarnings()[0]).toContain('To fix it, run:\n  npm install -g @anthropic-ai/claude-code@2.1.276\n  clodex patch');
  });

  it('does not prescribe npm install -g for an npm install it would not update', async () => {
    // Claude Code's own npm-local install and a project-local one: `npm install -g` updates a
    // different copy, and the next `clodex patch` would patch this one again.
    for (const packageRoot of [
      join(home, '.claude', 'local', 'node_modules'),
      join(home, 'proj', 'node_modules'),
    ]) {
      const binary = installNodeModulesClaude(packageRoot, '2.1.267');
      installFakeExtension(home, '.vscode', '2.1.276');
      logs.length = 0;

      expect(await runPatchCommand({})).toBe(0);

      expect(readPatchManifest()?.binaryPath).toBe(binary);
      expect(driftWarnings()).toHaveLength(1);
      expect(driftWarnings()[0]).toContain(`To fix it, update the Claude Code at ${binary} to 2.1.276 with the tool that installed it, then run:\n  clodex patch`);
      expect(driftWarnings()[0]).not.toContain('npm install');
    }
  });

  it('says nothing at all about extensions when no editor has one', async () => {
    installNativeClaude('2.1.267');
    mkdirSync(join(home, '.vscode', 'extensions'), { recursive: true });
    writeFileSync(join(home, '.vscode', 'extensions', 'extensions.json'), '[]');

    expect(await runPatchCommand({})).toBe(0);

    expect(logs.filter(line => /extension/i.test(line))).toEqual([]);
  });

  it('says nothing when the extension is the version that was patched', async () => {
    installNativeClaude('2.1.276');
    installFakeExtension(home, '.cursor', '2.1.276', { lingering: ['2.1.99'] });

    expect(await runPatchCommand({})).toBe(0);

    expect(driftWarnings()).toEqual([]);
  });

  it('reads the extension directory without modifying it', async () => {
    installNativeClaude('2.1.267');
    installFakeExtension(home, '.vscode', '2.1.276', { lingering: ['2.1.267'] });
    const before = snapshotTree(join(home, '.vscode'));

    expect(await runPatchCommand({})).toBe(0);
    expect(await runPatchCommand({})).toBe(0);

    expect(driftWarnings()).toHaveLength(2);
    expect(snapshotTree(join(home, '.vscode'))).toEqual(before);
  });

  it('does not check on --restore, which leaves nothing for the wrapper to substitute', async () => {
    installNativeClaude('2.1.267');
    expect(await runPatchCommand({})).toBe(0);
    installFakeExtension(home, '.vscode', '2.1.276');
    logs.length = 0;

    expect(await runPatchCommand({ restore: true })).toBe(0);

    expect(driftWarnings()).toEqual([]);
  });
});
