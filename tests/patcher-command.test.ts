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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runLaunchPatchCheck, runPatchCommand, readPatchManifest } from '../src/patcher.js';

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
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
  // PATCH 8a–8f/9 anchors — these sites are REQUIRED (applyPatch throws when
  // any of them FAILs), so the fixture has to carry them or every patch aborts.
  'var PM=["low","medium","high","xhigh","max"];',
  'function iJe(e,t){return!0}',
  'function a3e(e){return PM.filter((t)=>iJe(t,e))}',
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
  'var EM1={...o&&{supportsEffort:!0,supportedEffortLevels:PM.filter((l)=>{if(l==="max"&&!eqe(n))return!1;if(l==="xhigh"&&!I_e(n))return!1;return!0})}};',
  'var EM2={...To&&{supportsEffort:!0,supportedEffortLevels:PM.filter((Fo)=>{if(Fo==="max"&&!eqe(Et))return!1;if(Fo==="xhigh"&&!I_e(Et))return!1;return!0})}};',
  'function nEu(e,t){let r=e;if(typeof r==="string"&&a_e(r))r=IDe(r,t);if(r==="max"&&!eqe(t))r="high";if(r==="xhigh"&&!I_e(t))r="high";return r}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

let home: string;
let clodexHome: string;
let tweakccDir: string;
let logs: string[];

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

function saveFavorites(): void {
  mkdirSync(clodexHome, { recursive: true });
  writeFileSync(join(clodexHome, 'config.json'), JSON.stringify({
    favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
  }));
}

function saveDroppedOpenCodeFavorite(): void {
  mkdirSync(clodexHome, { recursive: true });
  writeFileSync(join(clodexHome, 'config.json'), JSON.stringify({
    favoriteModels: [{ providerId: 'opencode-go', modelId: 'gpt-5.6-luna' }],
    modelAliases: [{ name: 'luna', providerId: 'opencode-go', modelId: 'gpt-5.6-luna' }],
  }));
  writeFileSync(join(clodexHome, 'providers.json'), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
      modelsCache: {
        fetchedAt: '2026-08-09T00:00:00.000Z',
        models: [{
          id: 'gpt-5.6-luna',
          upstreamModelId: 'gpt-5.6-luna',
          name: 'GPT-5.6 Luna',
          modelFormat: 'openai',
        }],
      },
      addedAt: '2026-08-09T00:00:00.000Z',
    }],
  }));
}

function saveValidAndDroppedFavorites(): void {
  mkdirSync(clodexHome, { recursive: true });
  writeFileSync(join(clodexHome, 'config.json'), JSON.stringify({
    favoriteModels: [
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
      { providerId: 'opencode-go', modelId: 'gpt-5.6-luna' },
    ],
    modelAliases: [
      { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
      { name: 'luna', providerId: 'opencode-go', modelId: 'gpt-5.6-luna' },
    ],
  }));
  writeFileSync(join(clodexHome, 'providers.json'), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:provider:opencode-go',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
      modelsCache: {
        fetchedAt: '2026-08-09T00:00:00.000Z',
        models: [{
          id: 'gpt-5.6-luna',
          upstreamModelId: 'gpt-5.6-luna',
          name: 'GPT-5.6 Luna',
          modelFormat: 'openai',
        }],
      },
      addedAt: '2026-08-09T00:00:00.000Z',
    }],
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

  it('names dropped favorites and aliases and directs explicit patch users to restore', async () => {
    installClaude('2.1.220');
    saveDroppedOpenCodeFavorite();

    expect(await runPatchCommand({})).toBe(1);

    expect(logs.join('\n')).toContain('Saved model alias "luna" was not patched');
    expect(logs.join('\n')).toContain('saved favorite target is no longer exposed');
    expect(logs.join('\n')).toContain('clodex:opencode-go:gpt-5.6-luna');
    expect(logs.join('\n')).toContain('clodex patch --restore');
    expect(readPatchManifest()).toBeNull();
  });

  it('warns launch users to restore when only removed favorites remain in an old patch', async () => {
    const real = installClaude('2.1.220');
    expect(await runPatchCommand({})).toBe(0);
    expect(readPatchManifest()).not.toBeNull();
    const patchedBytes = readFileSync(real);
    saveDroppedOpenCodeFavorite();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runLaunchPatchCheck({})).resolves.toBeUndefined();

    const output = stderr.mock.calls.join('\n');
    expect(output).toContain('clodex:opencode-go:gpt-5.6-luna');
    expect(output).toContain('a previous clodex patch is recorded');
    expect(output).toContain('if Claude Code still shows an old removed entry');
    expect(output).toContain('clodex patch --restore');
    expect(output).not.toContain('is still installed');
    expect(readFileSync(real)).toEqual(patchedBytes);
    expect(readPatchManifest()).not.toBeNull();
  });

  it('keeps agent stdout mode silent when only removed favorites remain in an old patch', async () => {
    installClaude('2.1.220');
    expect(await runPatchCommand({})).toBe(0);
    saveDroppedOpenCodeFavorite();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runLaunchPatchCheck({ agentStdout: true })).resolves.toBeUndefined();

    expect(stderr).not.toHaveBeenCalled();
    expect(readPatchManifest()).not.toBeNull();
  });

  it('reports a newly dropped favorite even when the existing valid patch is current', async () => {
    const real = installClaude('2.1.220');
    expect(await runPatchCommand({})).toBe(0);
    const patchedBytes = readFileSync(real);
    const priorHash = readPatchManifest()?.configHash;
    saveValidAndDroppedFavorites();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runLaunchPatchCheck({})).resolves.toBeUndefined();

    const output = stderr.mock.calls.join('\n');
    expect(output).toContain('clodex:opencode-go:gpt-5.6-luna');
    expect(output).toContain('not included in the current patch configuration');
    expect(output).not.toContain('remains in the old Claude Code patch');
    expect(readFileSync(real)).toEqual(patchedBytes);
    expect(readPatchManifest()?.configHash).toBe(priorHash);
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
    expect(logs.join('\n')).toMatch(/no trustworthy pristine backup/);
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
