import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPatchModelConfig,
  computePatchConfigHash,
  evaluatePatchState,
  tryAcquirePatchLock,
  type PatchManifest,
} from '../src/patcher.js';
import { renderPatchScript } from '../src/patch-script-template.js';

describe('buildPatchModelConfig', () => {
  const favorites = [
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    { providerId: 'openai', modelId: 'mystery-model' },
  ];
  const aliases = [
    { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
  ];
  const meta = new Map([
    ['openai-oauth:gpt-5.6-sol', { contextWindow: 272_000, displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))' }],
    ['openai-oauth:gpt-5.6-luna', { contextWindow: 272_000, displayName: 'GPT-5.6 Luna (OpenAI (ChatGPT))' }],
  ]);

  it('builds clodex-prefixed entries with aliases, context windows, and display labels', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      favorites,
      aliases,
      (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    );

    expect(config['clodex:openai-oauth:gpt-5.6-sol']).toEqual({
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
    });
    expect(config['clodex:openai-oauth:gpt-5.6-luna']).toEqual({
      context: 272_000,
      display: 'GPT-5.6 Luna (OpenAI (ChatGPT))',
    });
    // Unknown window → no context (Claude Code's 200k default) + warning entry
    expect(config['clodex:openai:mystery-model']).toEqual({});
    expect(unknownWindows).toEqual(['clodex:openai:mystery-model']);
  });

  it('omits context when the window equals the 200k default', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 200_000 }),
    );
    expect(config['clodex:openai:davinci-002']).toEqual({});
    expect(unknownWindows).toEqual([]);
  });

  it('omits a blank display label rather than baking an empty string', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 272_000, displayName: '   ' }),
    );
    expect(config['clodex:openai:davinci-002']).toEqual({ context: 272_000 });
  });
});

describe('computePatchConfigHash', () => {
  it('is stable across key ordering and sensitive to changes', () => {
    const a = { 'clodex:p:m1': { alias: 'x', context: 1000 }, 'clodex:p:m2': {} };
    const b = { 'clodex:p:m2': {}, 'clodex:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(a)).toBe(computePatchConfigHash(b));
    expect(computePatchConfigHash(a)).not.toBe(
      computePatchConfigHash({ ...a, 'clodex:p:m1': { alias: 'y', context: 1000 } }),
    );
    expect(computePatchConfigHash(a)).not.toBe(
      computePatchConfigHash({ ...a, 'clodex:p:m1': { alias: 'x', context: 2000 } }),
    );
  });

  it('changes when only the display label changes (so an old patch reads as stale)', () => {
    const base = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } }),
    );
    expect(computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } })).not.toBe(
      computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (Q)' } }),
    );
  });
});

describe('evaluatePatchState', () => {
  const manifest: PatchManifest = {
    binaryPath: '/opt/claude/claude',
    claudeVersion: '2.1.183',
    configHash: 'hash-1',
    patchedSize: 1234,
    patchedSha256: 'sha',
    backupPath: '/backups/claude-2.1.183.orig',
    patchedAt: '2026-07-19T00:00:00.000Z',
  };

  it('reports unpatched without a manifest or for a different binary', () => {
    expect(evaluatePatchState(null, { binaryPath: '/opt/claude/claude', claudeVersion: '2.1.183', configHash: 'hash-1' })).toBe('unpatched');
    expect(evaluatePatchState(manifest, { binaryPath: '/other/claude', claudeVersion: '2.1.183', configHash: 'hash-1' })).toBe('unpatched');
  });

  it('reports current when version, size, and config hash match', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-1',
      binarySize: 1234,
    })).toBe('current');
  });

  it('reports stale-config when the desired config hash changed', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-2',
      binarySize: 1234,
    })).toBe('stale-config');
  });

  it('reports stale-binary when claude was updated or replaced', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.2.0',
      configHash: 'hash-1',
    })).toBe('stale-binary');
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-1',
      binarySize: 9999,
    })).toBe('stale-binary');
  });
});

describe('tryAcquirePatchLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clodex-patch-lock-'));
    lockPath = join(dir, 'patch.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires and releases the lock', () => {
    const release = tryAcquirePatchLock(lockPath);
    expect(release).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses the lock while a live process holds it', () => {
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    expect(tryAcquirePatchLock(lockPath, { isAlive: () => true })).toBeNull();
    release!();
  });

  it('steals a lock left by a dead process', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }));
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => false });
    expect(release).not.toBeNull();
    release!();
  });

  it('steals a stale lock older than the timeout even when the pid is alive', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 11 * 60 * 1000 }));
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    release!();
  });

  it('steals an unreadable lock file', () => {
    writeFileSync(lockPath, 'not-json');
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    release!();
  });
});

describe('renderPatchScript', () => {
  it('bakes the model config in and produces parseable JavaScript', () => {
    const script = renderPatchScript({
      'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000 },
      'clodex:openai-oauth:gpt-5.6-terra': { context: 272_000 },
      'clodex:openai:mystery': {},
    });
    expect(script).toContain('"clodex:openai-oauth:gpt-5.6-sol"');
    expect(script).toContain('"alias": "sol"');
    // The script runs in tweakcc's sandbox with `js` as a global and returns the
    // patched source — wrap it as a function body to validate the syntax.
    expect(() => new Function('js', script)).not.toThrow();
  });

  it('rejects unsafe aliases at patch-script runtime', () => {
    const script = renderPatchScript({
      'clodex:openai:model': { alias: 'Bad Alias!' },
    });
    expect(() => new Function('js', script)('var x = 1;')).toThrow(/not a safe lowercase alias/);
  });
});

// A minified stand-in for the Claude Code bundle carrying every anchor the
// patch script keys on, so the rendered script can be executed end to end.
const CLAUDE_FIXTURE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');

function runPatchScript(config: Parameters<typeof renderPatchScript>[0], source = CLAUDE_FIXTURE): string {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return new Function('js', renderPatchScript(config))(source) as string;
  } finally {
    errors.mockRestore();
  }
}

describe('patch script identity naming', () => {
  const config = {
    'clodex:openai-oauth:gpt-5.6-sol': {
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
    },
    'clodex:openai:mystery': { context: 128_000, display: 'Mystery (OpenAI)' },
  };

  it('injects the ALIAS — not the canonical id — as the model identity', () => {
    const out = runPatchScript(config);

    // PATCH 1: Agent-tool zod enum (the same enum agent/skill `model:` frontmatter
    // is validated against) gets "sol", never the canonical id.
    expect(out).toContain('.enum(["sonnet","opus","haiku","fable","sol","clodex:openai:mystery"]).optional().describe(');
    // PATCH 3: known-alias validator list.
    expect(out).toContain('["sonnet","opus","haiku","fable","opusplan","sol","clodex:openai:mystery"]');
    // The aliased model's canonical id never appears as an identity in either
    // list (it survives only as an extra key in the context table).
    expect(out).not.toMatch(/\.enum\(\[[^\]]*gpt-5\.6-sol/);
    expect(out).not.toMatch(/KNOWN=\[[^\]]*gpt-5\.6-sol/);
  });

  it('resolves an alias to ITSELF so the sent name and the context-map key stay identical', () => {
    const out = runPatchScript(config);
    // PATCH 6 must emit the case (not skip it — default: returns null) but map
    // the alias to itself rather than to the canonical id.
    expect(out).toContain('case"sol":return "sol";');
    expect(out).not.toContain('case"sol":return "clodex:openai-oauth:gpt-5.6-sol"');
  });

  it('keys the context-window table by the alias (and still by the canonical id)', () => {
    const out = runPatchScript(config);
    const table = out.match(/\/\*ccpatch:ctx\*\/var _ccw=\((\{[^}]*\})\)/)?.[1];
    expect(table).toBeTruthy();
    const parsed = JSON.parse(table!) as Record<string, number>;
    expect(parsed['sol']).toBe(272_000);
    expect(parsed['clodex:openai-oauth:gpt-5.6-sol']).toBe(272_000);
    expect(parsed['clodex:openai:mystery']).toBe(128_000);
  });

  it('falls back to the canonical id as the identity when a model has no alias', () => {
    const out = runPatchScript({ 'clodex:openai:mystery': { context: 128_000 } });
    expect(out).toContain('.enum(["sonnet","opus","haiku","fable","clodex:openai:mystery"])');
    expect(out).toContain('"clodex:openai:mystery"');
    // No alias → nothing to resolve and no picker entry.
    expect(out).not.toContain('case"clodex:openai:mystery":return');
    expect(out).not.toContain('value:"clodex:openai:mystery"');
  });

  it('uses the real display label in the /model picker and the Agent tool description', () => {
    const out = runPatchScript(config);
    expect(out).toContain('{value:"sol",label:"Sol",description:"GPT-5.6 Sol (OpenAI (ChatGPT))"}');
    expect(out).not.toContain('Custom model (');
    expect(out).toContain('Additional custom models: sol = GPT-5.6 Sol (OpenAI (ChatGPT)); '
      + 'clodex:openai:mystery = Mystery (OpenAI).');
  });

  it('falls back to the old "Custom model (id)" description when no label is known', () => {
    const out = runPatchScript({ 'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000 } });
    expect(out).toContain('{value:"sol",label:"Sol",description:"Custom model (clodex:openai-oauth:gpt-5.6-sol)"}');
    expect(out).toContain('Additional custom models: sol.');
  });

  it('is idempotent — re-running the same patch changes nothing', () => {
    const once = runPatchScript(config);
    expect(runPatchScript(config, once)).toBe(once);
  });
});
