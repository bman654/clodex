import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_SHA_PREFIX_LENGTH,
  backupVersionTag,
  contentAddressedBackupPath,
  isPatchedClaudeSource,
  looksLikeLegacyClodexPatch,
  legacyBackupPath,
  planInspectedPristineSource,
  planPristineSource,
  planRestoreOnly,
  scanPristineBackups,
  type BackupCandidate,
  type PristineFacts,
} from '../src/patch-backup.js';
import { applyClodexPatches } from '../src/patch-transforms.js';

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

describe('backup naming', () => {
  it('embeds the version and a prefix of the stored content hash', () => {
    const digest = sha('pristine-bytes');
    expect(contentAddressedBackupPath('2.1.220', digest, '/backups')).toBe(
      join('/backups', `claude-2.1.220-${digest.slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`),
    );
  });

  it('never gives two different contents the same name', () => {
    const a = contentAddressedBackupPath('2.1.220', sha('a'), '/backups');
    const b = contentAddressedBackupPath('2.1.220', sha('b'), '/backups');
    expect(a).not.toBe(b);
  });

  it('refuses to name a backup for an empty version instead of aliasing every version', () => {
    expect(() => backupVersionTag('   ')).toThrow(/empty claude version/);
  });
});

describe('scanPristineBackups', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clodex-backup-scan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = (name: string, content: string) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };

  it('collects this version\'s content-addressed and legacy backups only', () => {
    const bytes = 'pristine 2.1.220';
    const contentPath = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
    const legacy = store('claude-2.1.220.orig', bytes);
    store('claude-2.1.215.orig', 'pristine 2.1.215');
    store(`claude-2.1.215-${sha('pristine 2.1.215').slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, 'pristine 2.1.215');

    const scan = scanPristineBackups('2.1.220', dir);
    expect(scan.corrupt).toEqual([]);
    expect(scan.valid.map(candidate => [candidate.path, candidate.kind, candidate.sha256]).sort()).toEqual([
      [contentPath, 'content-addressed', sha(bytes)],
      [legacy, 'legacy', sha(bytes)],
    ].sort());
  });

  it('rejects a content-addressed backup whose bytes no longer match its own name', () => {
    const bytes = 'pristine 2.1.220';
    const path = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
    writeFileSync(path, 'corrupted');

    const scan = scanPristineBackups('2.1.220', dir);
    expect(scan.valid).toEqual([]);
    expect(scan.corrupt).toEqual([path]);
  });

  it('returns nothing when the backup directory does not exist', () => {
    expect(scanPristineBackups('2.1.220', join(dir, 'missing'))).toEqual({ valid: [], corrupt: [] });
  });
});

describe('isPatchedClaudeSource', () => {
  const FIXTURE = [
    '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
    'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
    'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
    'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
    'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
    // The required effort sites (PATCH 8a/8b/8c/9). Every binary current clodex
    // publishes carries their `ccpatch` comments, which is why those alone are
    // strong enough to be the blocking signal.
    'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
    'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
    'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
    'function ait(e){return ww(lo(e))?.default_effort??"high"}',
  ].join('\n');

  it('is false for pristine Claude Code source', () => {
    expect(isPatchedClaudeSource(FIXTURE)).toBe(false);
  });

  it('is true for source carrying an aliased clodex patch', () => {
    const patched = applyClodexPatches(FIXTURE, {
      'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000, display: 'GPT-5.6 Sol' },
    }).content;
    expect(isPatchedClaudeSource(patched)).toBe(true);
  });

  it('is true for source patched with unaliased models and no context windows', () => {
    const patched = applyClodexPatches(FIXTURE, { 'clodex:openai:mystery': {} }).content;
    expect(isPatchedClaudeSource(patched)).toBe(true);
  });

  it('blocks only on clodex\'s own comment marker, never on a guessable fragment', () => {
    // Everything current clodex publishes carries a `ccpatch` comment, because the
    // effort sites are required. Nothing else may block: a false positive on a
    // fragment that could occur in Claude Code's own bytes is unrecoverable —
    // the advice is to reinstall, which reproduces the same bytes and refusal.
    const legacyOnly = `${FIXTURE}\nvar d="Additional custom models: sol.";`;
    expect(legacyOnly).not.toContain('/*ccpatch:');
    expect(isPatchedClaudeSource(legacyOnly)).toBe(false);
    expect(looksLikeLegacyClodexPatch(legacyOnly)).toBe(true);
    expect(isPatchedClaudeSource(`${FIXTURE}\n/*clodex-local:example*/`)).toBe(false);
  });

  it('reports no legacy suspicion once the proof marker is present', () => {
    // The two tiers are exclusive, so a current patch warns about nothing.
    const patched = applyClodexPatches(FIXTURE, {
      'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000, display: 'GPT-5.6 Sol' },
    }).content;
    expect(isPatchedClaudeSource(patched)).toBe(true);
    expect(looksLikeLegacyClodexPatch(patched)).toBe(false);
  });

  it('is silent on pristine source in both tiers', () => {
    expect(looksLikeLegacyClodexPatch(FIXTURE)).toBe(false);
  });
});

// ── Planning ────────────────────────────────────────────────────────────────

const PRISTINE = sha('pristine 2.1.220');
const PATCHED = sha('patched 2.1.220');
const OTHER_VERSION = sha('pristine 2.1.215');

function candidate(overrides: Partial<BackupCandidate> = {}): BackupCandidate {
  return {
    path: contentAddressedBackupPath('2.1.220', PRISTINE, '/backups'),
    kind: 'content-addressed',
    sha256: PRISTINE,
    ...overrides,
  };
}

function facts(overrides: Partial<PristineFacts> = {}): PristineFacts {
  return {
    version: '2.1.220',
    binaryPath: '/install/claude',
    liveSha256: PATCHED,
    manifest: null,
    backups: [],
    ...overrides,
  };
}

describe('planPristineSource', () => {
  it('reuses the live binary when its bytes match a stored backup', () => {
    const plan = planPristineSource(facts({ liveSha256: PRISTINE, backups: [candidate()] }));
    expect(plan).toMatchObject({ action: 'reuse', pristineSha256: PRISTINE });
  });

  it('prefers the self-validating name when a legacy copy holds the same bytes', () => {
    const legacy = candidate({ path: legacyBackupPath('2.1.220', '/backups'), kind: 'legacy' });
    const plan = planPristineSource(facts({ liveSha256: PRISTINE, backups: [legacy, candidate()] }));
    expect(plan).toMatchObject({ action: 'reuse', backupPath: candidate().path });
  });

  it('restores the recorded pristine content when the manifest says the live bytes are its patch', () => {
    const plan = planPristineSource(facts({
      backups: [candidate()],
      manifest: {
        binaryPath: '/install/claude',
        backupPath: candidate().path,
        patchedSha256: PATCHED,
        pristineSha256: PRISTINE,
      },
    }));
    expect(plan).toMatchObject({
      action: 'restore',
      backupPath: candidate().path,
      pristineSha256: PRISTINE,
      probeVersion: false,
    });
  });

  it('refuses a manifest backup tagged with another version instead of downgrading the binary', () => {
    // The pre-fix bug: a manifest written while the version was misresolved
    // points at another version's backup. It is not among this version's
    // candidates, so it can never be copied over the binary.
    const plan = planPristineSource(facts({
      backups: [],
      manifest: {
        binaryPath: '/install/claude',
        backupPath: legacyBackupPath('2.1.215', '/backups'),
        patchedSha256: PATCHED,
        pristineSha256: OTHER_VERSION,
      },
    }));
    expect(plan.action).toBe('error');
    expect((plan as { message: string }).message).toMatch(/no trustworthy pristine backup/);
  });

  it('asks for source inspection when the live bytes are unrecognized', () => {
    expect(planPristineSource(facts({ backups: [candidate()] }))).toEqual({ action: 'inspect' });
  });
});

describe('planInspectedPristineSource', () => {
  it('snapshots an unpatched binary as the pristine backup', () => {
    const plan = planInspectedPristineSource(facts({ liveSha256: PRISTINE }), { patched: false });
    expect(plan).toMatchObject({
      action: 'snapshot',
      backupPath: contentAddressedBackupPath('2.1.220', PRISTINE),
      pristineSha256: PRISTINE,
    });
  });

  it('keeps both files and warns when an existing backup for the version disagrees', () => {
    const plan = planInspectedPristineSource(
      facts({ liveSha256: PRISTINE, backups: [candidate({ sha256: OTHER_VERSION })] }),
      { patched: false },
    );
    expect(plan.action).toBe('snapshot');
    expect((plan as { notes: string[] }).notes.join(' ')).toMatch(/hold different bytes/);
  });

  it('NEVER snapshots a patched binary — it errors instead', () => {
    const plan = planInspectedPristineSource(facts(), { patched: true });
    expect(plan.action).toBe('error');
    expect((plan as { message: string }).message).toMatch(/already patched and no trustworthy pristine backup/);
  });

  it('restores the version\'s backup when the binary is patched', () => {
    const plan = planInspectedPristineSource(facts({ backups: [candidate()] }), { patched: true });
    expect(plan).toMatchObject({ action: 'restore', backupPath: candidate().path, probeVersion: false });
  });

  it('demands a version probe before restoring an unverifiable legacy backup', () => {
    const legacy = candidate({ path: legacyBackupPath('2.1.220', '/backups'), kind: 'legacy' });
    const plan = planInspectedPristineSource(facts({ backups: [legacy] }), { patched: true });
    expect(plan).toMatchObject({ action: 'restore', backupPath: legacy.path, probeVersion: true });
  });

  it('refuses to guess between backups that disagree about the same version', () => {
    const plan = planInspectedPristineSource(
      facts({
        backups: [
          candidate(),
          candidate({ path: legacyBackupPath('2.1.220', '/backups'), kind: 'legacy', sha256: OTHER_VERSION }),
        ],
      }),
      { patched: true },
    );
    expect(plan.action).toBe('error');
    expect((plan as { message: string }).message).toMatch(/conflicting pristine backups/);
  });

  it('mentions ignored corrupt backups when nothing is restorable', () => {
    const plan = planInspectedPristineSource(
      facts({ corruptBackups: ['/backups/claude-2.1.220-deadbeefdeadbeef.orig'] }),
      { patched: true },
    );
    expect((plan as { message: string }).message).toMatch(/failed integrity checks/);
  });
});

describe('planRestoreOnly', () => {
  it('restores the manifest-recorded pristine content', () => {
    const plan = planRestoreOnly(facts({
      backups: [candidate()],
      manifest: { binaryPath: '/install/claude', backupPath: candidate().path, pristineSha256: PRISTINE },
    }));
    expect(plan).toMatchObject({ action: 'restore', backupPath: candidate().path });
  });

  it('errors rather than restoring when nothing for this version is trustworthy', () => {
    expect(planRestoreOnly(facts()).action).toBe('error');
  });
});
