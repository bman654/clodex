import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_SHA_PREFIX_LENGTH,
  backupVersionTag,
  contentAddressedBackupPath,
  isPatchedClaudeSource,
  looksLikeLegacyClodexPatch,
  legacyBackupPath,
  installProvenancePath,
  readInstallProvenance,
  recordBackupProvenance,
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

  it('reports the installs each backup is recorded for', () => {
    const bytes = 'pristine 2.1.220';
    const path = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
    const unrecorded = store('claude-2.1.220.orig', bytes);
    recordBackupProvenance(path, '/install/native', { assumed: false });
    recordBackupProvenance(path, '/install/npm', { assumed: false });

    const scan = scanPristineBackups('2.1.220', dir);
    expect(scan.valid.find(candidate => candidate.path === path)?.installs)
      .toEqual(['/install/native', '/install/npm']);
    expect(scan.valid.find(candidate => candidate.path === unrecorded)?.installs).toEqual([]);
  });

  it('keeps an assumed record out of the established installs', () => {
    const bytes = 'pristine 2.1.220';
    const path = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
    recordBackupProvenance(path, '/install/guessed', { assumed: true });

    const scan = scanPristineBackups('2.1.220', dir);
    expect(scan.valid[0]?.installs).toEqual([]);
    expect(scan.valid[0]?.damagedProvenance).toEqual([]);
  });

  it('reports a provenance record it cannot read instead of ignoring it', () => {
    const bytes = 'pristine 2.1.220';
    const path = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
    const record = installProvenancePath(path, '/install/claude');
    writeFileSync(record, '{"install": "/install/cla');

    const scan = scanPristineBackups('2.1.220', dir);
    expect(scan.valid[0]?.installs).toEqual([]);
    expect(scan.valid[0]?.damagedProvenance).toEqual([record]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'treats a record it cannot open as damaged, not as absent',
    () => {
      // The name is right there in the directory listing, so this is not "no record":
      // it is one that exists and cannot be read. Reading it as absent is what let the
      // version-tag fallback run on a backup another install had already claimed.
      const bytes = 'pristine 2.1.220';
      const path = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
      const record = installProvenancePath(path, '/install/claude');
      writeFileSync(record, JSON.stringify({ install: '/install/claude', assumed: false }));
      chmodSync(record, 0o000);
      try {
        const scan = scanPristineBackups('2.1.220', dir);
        expect(scan.valid[0]?.installs).toEqual([]);
        expect(scan.valid[0]?.damagedProvenance).toEqual([record]);
      } finally {
        chmodSync(record, 0o600);
      }
    },
  );

  it('treats a record whose name does not match the install it holds as damaged', () => {
    // The name is derived from the install path, so a mismatch means one of the two
    // is wrong — including a hash-prefix collision that would otherwise let a record
    // be selected for an install it was not written for.
    const bytes = 'pristine 2.1.220';
    const path = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
    const record = installProvenancePath(path, '/install/claude');
    writeFileSync(record, JSON.stringify({ install: '/somewhere/else/claude', assumed: false }));

    const scan = scanPristineBackups('2.1.220', dir);
    expect(scan.valid[0]?.installs).toEqual([]);
    expect(scan.valid[0]?.damagedProvenance).toEqual([record]);
  });

  it('does not mistake a provenance record for a backup', () => {
    const bytes = 'pristine 2.1.220';
    const path = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
    recordBackupProvenance(path, '/install/claude', { assumed: false });

    const scan = scanPristineBackups('2.1.220', dir);
    expect(scan.valid.map(candidate => candidate.path)).toEqual([path]);
    expect(scan.corrupt).toEqual([]);
  });

  it('reads only the records belonging to its own backup', () => {
    const bytes = 'pristine 2.1.220';
    const mine = store(`claude-2.1.220-${sha(bytes).slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`, bytes);
    const other = store('claude-2.1.220.orig', bytes);
    recordBackupProvenance(other, '/install/other', { assumed: false });

    const scan = scanPristineBackups('2.1.220', dir);
    expect(scan.valid.find(candidate => candidate.path === mine)?.installs).toEqual([]);
    expect(scan.valid.find(candidate => candidate.path === other)?.installs).toEqual(['/install/other']);
  });
});

describe('backup provenance records', () => {
  let dir: string;
  let backup: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clodex-backup-prov-'));
    backup = join(dir, 'claude-2.1.220-abcdef0123456789.orig');
    writeFileSync(backup, 'pristine');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads nothing for a backup that has no record', () => {
    expect(readInstallProvenance(installProvenancePath(backup, '/install/native'))).toBeNull();
  });

  it('gives each install its own file, so no merge can lose one', () => {
    recordBackupProvenance(backup, '/install/native', { assumed: false });
    recordBackupProvenance(backup, '/install/npm', { assumed: false });
    expect(readInstallProvenance(installProvenancePath(backup, '/install/native')))
      .toEqual({ install: '/install/native', assumed: false });
    expect(readInstallProvenance(installProvenancePath(backup, '/install/npm')))
      .toEqual({ install: '/install/npm', assumed: false });
  });

  it('is idempotent, so repeated patches rewrite nothing', () => {
    recordBackupProvenance(backup, '/install/native', { assumed: false });
    const before = readFileSync(installProvenancePath(backup, '/install/native'), 'utf8');
    recordBackupProvenance(backup, '/install/native', { assumed: false });
    expect(readFileSync(installProvenancePath(backup, '/install/native'), 'utf8')).toBe(before);
  });

  it('never downgrades an established record to a guess', () => {
    // Callers ask for the confidence THIS run can prove. One that can prove less
    // than an earlier run must not erase what the earlier one knew.
    recordBackupProvenance(backup, '/install/npm', { assumed: false });
    expect(recordBackupProvenance(backup, '/install/npm', { assumed: true })).toBe('established');
    expect(readInstallProvenance(installProvenancePath(backup, '/install/npm')))
      .toEqual({ install: '/install/npm', assumed: false });
  });

  it('promotes a guess when the caller has independent evidence', () => {
    // A fresh snapshot inspects the install's own bytes, which no guess produces —
    // refusing to promote there would let one old guess suppress the proof forever.
    // Keeping a guess a guess is the CALLER's job: it passes `assumed` whenever its
    // evidence is derived from an earlier one.
    recordBackupProvenance(backup, '/install/npm', { assumed: true });
    expect(recordBackupProvenance(backup, '/install/npm', { assumed: false })).toBe('established');
    expect(readInstallProvenance(installProvenancePath(backup, '/install/npm')))
      .toEqual({ install: '/install/npm', assumed: false });
  });

  it('reports the confidence that stands on disk', () => {
    expect(recordBackupProvenance(backup, '/install/npm', { assumed: true })).toBe('assumed');
    expect(recordBackupProvenance(backup, '/install/npm', { assumed: true })).toBe('assumed');
    expect(recordBackupProvenance(backup, '/install/native', { assumed: false })).toBe('established');
  });

  it('rejects a record whose assumed flag is not a boolean', () => {
    // It would read as `false` — the ESTABLISHED value — so a damaged former guess
    // would become the strongest evidence in the directory.
    const record = installProvenancePath(backup, '/install/native');
    writeFileSync(record, JSON.stringify({ install: '/install/native', assumed: 'true' }));
    expect(readInstallProvenance(record)).toBe('damaged');
  });

  it('still records an established install beside an assumed one', () => {
    recordBackupProvenance(backup, '/install/npm', { assumed: true });
    recordBackupProvenance(backup, '/install/native', { assumed: false });
    expect(readInstallProvenance(installProvenancePath(backup, '/install/native')))
      .toEqual({ install: '/install/native', assumed: false });
  });

  it('reports an unreadable record as damaged rather than as absent', () => {
    const record = installProvenancePath(backup, '/install/native');
    writeFileSync(record, '{"install": "/install/nat');
    expect(readInstallProvenance(record)).toBe('damaged');
  });

  it('reports a record that names no install as damaged', () => {
    const record = installProvenancePath(backup, '/install/native');
    writeFileSync(record, JSON.stringify({ assumed: false }));
    expect(readInstallProvenance(record)).toBe('damaged');
  });

  it('replaces a damaged record on the next patch', () => {
    const record = installProvenancePath(backup, '/install/native');
    writeFileSync(record, 'not json');
    recordBackupProvenance(backup, '/install/native', { assumed: false });
    expect(readInstallProvenance(record)).toEqual({ install: '/install/native', assumed: false });
  });

  it('leaves no temp file behind', () => {
    recordBackupProvenance(backup, '/install/native', { assumed: false });
    expect(readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
});

describe('isPatchedClaudeSource', () => {
  const FIXTURE = [
    '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
    'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
    'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
    'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
    'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
    // The required effort sites (PATCH 8a/8b/8c/9). Every binary current clodex
    // publishes carries their `ccpatch` comments, which is why those alone are
    // strong enough to be the blocking signal.
    'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
    'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
    'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
    'function ait(e){return ww(lo(e))?.default_effort??"high"}',
    'function cwdOf(){let p=process.env.PWD;return p}',
    'function childEnv(){let e=extra(),t=Object.keys(e).length>0,n=Object.keys(e).length>0,s=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};let o=[process.env.CLAUDE_CODE_OAUTH_TOKEN,process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE,process.env.CLAUDE_BG_PTY_AUTH,"OTEL_",process.env.CLAUDE_CODE_OTEL_DIAG_STDERR],u=["CLAUDE_CODE_OAUTH_TOKEN"];if(!t&&!n&&!o[0])return process.env;let v={...process.env,...e,...s};for(let k of u)delete v[k],delete v[`INPUT_${k}`];return v}function mcpAllow(){let e=process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV;return e}',
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
/** Same claude version, different artifact — an npm-platform binary next to a native one. */
const OTHER_INSTALL_PRISTINE = sha('pristine 2.1.220 npm build');

function candidate(overrides: Partial<BackupCandidate> = {}): BackupCandidate {
  return {
    path: contentAddressedBackupPath('2.1.220', PRISTINE, '/backups'),
    kind: 'content-addressed',
    sha256: PRISTINE,
    installs: [],
    assumedInstalls: [],
    damagedProvenance: [],
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
    expect((plan as { message: string }).message).toMatch(/as the pristine content of .*, and clodex cannot use it/);
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
    expect((plan as { message: string }).message).toMatch(/holds no pristine backup of claude 2\.1\.220 it can attribute to/);
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

  // Issue #199: a version tag is not install provenance. The npm platform package
  // and the native installer ship different bytes under the SAME version, so a
  // backup belonging to the install the manifest records must never be published
  // over a different install just because the version tags agree.
  describe('a manifest recorded against another install', () => {
    const otherInstall = {
      binaryPath: '/other-install/claude',
      backupPath: candidate().path,
      patchedSha256: sha('patched other install'),
      pristineSha256: PRISTINE,
    };

    it('refuses instead of publishing that install\'s backup over this one', () => {
      const plan = planRestoreOnly(facts({ backups: [candidate()], manifest: otherInstall }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/records a different Claude Code install/);
      expect((plan as { message: string }).message).toContain('/other-install/claude');
    });

    it('refuses on the patch path too, where the same selection seeds the candidate', () => {
      const plan = planInspectedPristineSource(
        facts({ backups: [candidate()], manifest: otherInstall }),
        { patched: true },
      );
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/records a different Claude Code install/);
    });

    it('disqualifies the recorded backup by path when the manifest predates content addressing', () => {
      const legacyRecord = { binaryPath: '/other-install/claude', backupPath: candidate().path };
      const plan = planRestoreOnly(facts({ backups: [candidate()], manifest: legacyRecord }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/records a different Claude Code install/);
    });

    it('refuses outright when the manifest identifies no backup to disqualify', () => {
      const plan = planRestoreOnly(facts({
        backups: [candidate()],
        manifest: { binaryPath: '/other-install/claude' },
      }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/records a different Claude Code install/);
    });

    it('refuses even when a backup that install did NOT record is available', () => {
      // Tempting to restore "the one it did not name" — and wrong. The manifest
      // holds ONE install, so an unrecorded backup is just an install the manifest
      // is silent about: this one, or a third one whose backup was never recorded.
      // Nothing in the facts tells them apart, so selection here is a guess.
      const unrecorded = candidate({
        path: contentAddressedBackupPath('2.1.220', OTHER_INSTALL_PRISTINE, '/backups'),
        sha256: OTHER_INSTALL_PRISTINE,
      });
      const plan = planRestoreOnly(facts({ backups: [candidate(), unrecorded], manifest: otherInstall }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/records a different Claude Code install/);
    });

    it('refuses when a THIRD install is the target and the orphan is install A\'s', () => {
      // Patch A (backup X, manifest→A), patch B (backup Y, manifest→B), then
      // restore against C. Disqualifying only Y would leave X — install A's bytes
      // — looking unanimous, and publish them over C.
      const orphanOfA = candidate();
      const recordedForB = candidate({
        path: contentAddressedBackupPath('2.1.220', OTHER_INSTALL_PRISTINE, '/backups'),
        sha256: OTHER_INSTALL_PRISTINE,
      });
      const plan = planRestoreOnly(facts({
        binaryPath: '/third-install/claude',
        backups: [orphanOfA, recordedForB],
        manifest: { binaryPath: '/other-install/claude', backupPath: recordedForB.path, pristineSha256: OTHER_INSTALL_PRISTINE },
      }));
      expect(plan.action).toBe('error');
    });

    it('is not evidence about a version it was never written for', () => {
      // Patch install A at 2.1.220, patch install B at 2.1.221, then restore A.
      // B's manifest records a 2.1.221 backup, which is not even among 2.1.220's
      // candidates — refusing here rejected a restore that was never in danger.
      const plan = planRestoreOnly(facts({
        backups: [candidate()],
        manifest: { ...otherInstall, claudeVersion: '2.1.221' },
      }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: candidate().path });
      expect((plan as { notes: string[] }).notes.join(' ')).toMatch(/version tag alone/);
    });

    it('still refuses when it was written for the version being restored', () => {
      const plan = planRestoreOnly(facts({
        backups: [candidate()],
        manifest: { ...otherInstall, claudeVersion: '2.1.220' },
      }));
      expect(plan.action).toBe('error');
    });

    it('reports the ordinary no-backup error when the version has no backups at all', () => {
      const plan = planRestoreOnly(facts({ backups: [], manifest: otherInstall }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/holds no pristine backup of claude 2\.1\.220 it can attribute to/);
    });
  });

  // The manifest records THIS install and names bytes that are gone. Its own
  // testimony then says the same-version backups still on disk are some other
  // install's — so falling back to them was never safe.
  describe('a manifest whose recorded backup has been deleted', () => {
    it('refuses instead of restoring a different backup with the same version tag', () => {
      const orphan = candidate({
        path: contentAddressedBackupPath('2.1.220', OTHER_INSTALL_PRISTINE, '/backups'),
        sha256: OTHER_INSTALL_PRISTINE,
      });
      const plan = planRestoreOnly(facts({
        backups: [orphan],
        manifest: { binaryPath: '/install/claude', backupPath: candidate().path, pristineSha256: PRISTINE },
      }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/as the pristine content of .*, and clodex cannot use it/);
    });

    it('does not refuse when the manifest simply predates an upgrade', () => {
      // The recorded backup is intact; it just belongs to the version this binary
      // used to be. That is not a missing backup, and this version's own backup is
      // still the only candidate.
      const plan = planRestoreOnly(facts({
        backups: [candidate()],
        manifest: {
          binaryPath: '/install/claude',
          claudeVersion: '2.1.215',
          backupPath: legacyBackupPath('2.1.215', '/backups'),
          pristineSha256: OTHER_VERSION,
        },
      }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: candidate().path });
    });

    it('refuses a legacy orphan too, where only a version probe stood in the way', () => {
      const legacyOrphan = candidate({
        path: legacyBackupPath('2.1.220', '/backups'),
        kind: 'legacy',
        sha256: OTHER_INSTALL_PRISTINE,
      });
      const plan = planRestoreOnly(facts({
        backups: [legacyOrphan],
        manifest: { binaryPath: '/install/claude', backupPath: candidate().path },
      }));
      expect(plan.action).toBe('error');
    });
  });

  describe('no manifest at all', () => {
    it('still restores, and says the version tag is the only thing tying the backup to the install', () => {
      const plan = planRestoreOnly(facts({ backups: [candidate()], manifest: null }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: candidate().path, assumedForThisInstall: true });
      expect((plan as { notes: string[] }).notes.join(' ')).toMatch(/version tag alone/);
    });

    it('adds no such note when the manifest records THIS install', () => {
      const plan = planRestoreOnly(facts({
        backups: [candidate()],
        manifest: { binaryPath: '/install/claude', backupPath: candidate().path, pristineSha256: PRISTINE },
      }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: candidate().path, assumedForThisInstall: false });
      expect((plan as { notes: string[] }).notes).toEqual([]);
    });
  });

  // Issue #204. A successful restore deletes the manifest and the manifest holds
  // one install, so it cannot be the only record of which install a backup belongs
  // to. Each backup carries its own.
  describe('provenance recorded beside the backup', () => {
    const mine = () => candidate({ installs: ['/install/claude'] });
    const theirs = () => candidate({
      path: contentAddressedBackupPath('2.1.220', OTHER_INSTALL_PRISTINE, '/backups'),
      sha256: OTHER_INSTALL_PRISTINE,
      installs: ['/other-install/claude'],
    });

    it('refuses a backup recorded for another install when no manifest survives', () => {
      const plan = planRestoreOnly(facts({ backups: [theirs()], manifest: null }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message)
        .toMatch(/recorded as the pristine content of \/other-install\/claude, not of \/install\/claude/);
    });

    it('restores this install\'s own backup while another install\'s sits beside it', () => {
      const plan = planRestoreOnly(facts({ backups: [mine(), theirs()], manifest: null }));
      expect(plan).toMatchObject({
        action: 'restore',
        backupPath: mine().path,
        pristineSha256: PRISTINE,
        assumedForThisInstall: false,
      });
      expect((plan as { notes: string[] }).notes).toEqual([]);
    });

    it('outranks a manifest that records some other install', () => {
      // The manifest is about a different install, and used to be reason enough to
      // refuse. A record naming THIS install is direct evidence, so it decides.
      const plan = planRestoreOnly(facts({
        backups: [mine(), theirs()],
        manifest: { binaryPath: '/other-install/claude', backupPath: theirs().path, pristineSha256: OTHER_INSTALL_PRISTINE },
      }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: mine().path });
    });

    it('restores bytes recorded for both installs at once', () => {
      // Content-addressed: two installs whose pristine bytes are identical share
      // one backup file, and it is correct for either of them.
      const shared = candidate({ installs: ['/other-install/claude', '/install/claude'] });
      const plan = planRestoreOnly(facts({ backups: [shared], manifest: null }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: shared.path, assumedForThisInstall: false });
    });

    it('prefers a self-validating name over a legacy one recorded for the same install', () => {
      const legacy = candidate({
        path: legacyBackupPath('2.1.220', '/backups'),
        kind: 'legacy',
        installs: ['/install/claude'],
      });
      const plan = planRestoreOnly(facts({ backups: [legacy, mine()], manifest: null }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: mine().path, probeVersion: false });
    });

    it('refuses when the manifest and a record disagree about this install\'s bytes', () => {
      // Nothing dates either one, so "the manifest is newer" is an assumption. The
      // state is reachable by replacing the executable at one path with a different
      // build of the same claude version, where the MANIFEST is the stale one.
      const contradicting = candidate({
        path: contentAddressedBackupPath('2.1.220', OTHER_INSTALL_PRISTINE, '/backups'),
        sha256: OTHER_INSTALL_PRISTINE,
        installs: ['/install/claude'],
      });
      const plan = planRestoreOnly(facts({
        backups: [contradicting, mine()],
        manifest: { binaryPath: '/install/claude', backupPath: mine().path, pristineSha256: PRISTINE },
      }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/holds different bytes/);
    });

    it('still lets the manifest decide when the records agree with it', () => {
      const plan = planRestoreOnly(facts({
        backups: [mine()],
        manifest: { binaryPath: '/install/claude', backupPath: mine().path, pristineSha256: PRISTINE },
      }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: mine().path, assumedForThisInstall: false });
    });

    it('carries a guessing run\'s manifest forward as a guess', () => {
      // The manifest a guessing run wrote is the guess, written down. Reading it as
      // independent proof is what promoted the guess on the next run.
      const plan = planRestoreOnly(facts({
        backups: [candidate()],
        manifest: {
          binaryPath: '/install/claude',
          backupPath: candidate().path,
          pristineSha256: PRISTINE,
          pristineProvenance: 'assumed',
        },
      }));
      expect(plan).toMatchObject({ action: 'restore', assumedForThisInstall: true });
    });

    it('refuses the fallback for an install these bytes were never guessed onto', () => {
      // The first guess proves nothing about ownership, but running the fallback a
      // SECOND time is how one install's bytes reach two.
      const guessedElsewhere = candidate({ assumedInstalls: ['/other-install/claude'] });
      const plan = planRestoreOnly(facts({ backups: [guessedElsewhere], manifest: null }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/have already been restored onto/);
    });

    it('still repeats the fallback for the install it already guessed for', () => {
      // Same decision, being made again — refusing here would strand the ordinary
      // single-install machine on its second restore.
      const guessedForMe = candidate({ assumedInstalls: ['/install/claude'] });
      const plan = planRestoreOnly(facts({ backups: [guessedForMe], manifest: null }));
      expect(plan).toMatchObject({ action: 'restore', assumedForThisInstall: true });
    });

    it('refuses when two records for this install disagree about its bytes', () => {
      const contradiction = candidate({
        path: contentAddressedBackupPath('2.1.220', OTHER_INSTALL_PRISTINE, '/backups'),
        sha256: OTHER_INSTALL_PRISTINE,
        installs: ['/install/claude'],
      });
      const plan = planRestoreOnly(facts({ backups: [mine(), contradiction], manifest: null }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/cannot tell which one that install holds now/);
    });

    it('keeps restoring a backup from before sidecars existed', () => {
      // Refusing here would strand every backup written by an earlier clodex, so
      // the version-tag fallback survives for records that do not exist at all —
      // and only for those. The plan still says the association is assumed.
      const plan = planRestoreOnly(facts({ backups: [candidate({ installs: [] })], manifest: null }));
      expect(plan).toMatchObject({ action: 'restore', assumedForThisInstall: true });
    });

    it('refuses when only SOME of the backups carry a record, none of them this install\'s', () => {
      const unrecorded = candidate({
        path: contentAddressedBackupPath('2.1.220', sha('third install pristine'), '/backups'),
        sha256: sha('third install pristine'),
      });
      const plan = planRestoreOnly(facts({ backups: [theirs(), unrecorded], manifest: null }));
      expect(plan.action).toBe('error');
      // Specifically the provenance refusal, not the conflicting-backups one: with
      // two backups on disk both messages are available, and only this one names the
      // install the bytes DO belong to.
      expect((plan as { message: string }).message)
        .toMatch(/recorded as the pristine content of \/other-install\/claude, not of \/install\/claude/);
    });

    it('refuses the version-tag fallback when a record beside the backup is damaged', () => {
      // Something recorded which install those bytes belong to and the record cannot
      // be read. Treating that as "never recorded" is what would let the fallback run
      // on a backup that had already been claimed.
      const plan = planRestoreOnly(facts({
        backups: [candidate({ damagedProvenance: ['/backups/claude-2.1.220-x.orig.for-abc.json'] })],
        manifest: null,
      }));
      expect(plan.action).toBe('error');
      expect((plan as { message: string }).message).toMatch(/provenance record that clodex cannot read/);
    });

    it('still restores on a record for this install even when another backup\'s record is damaged', () => {
      const damaged = candidate({
        path: contentAddressedBackupPath('2.1.220', OTHER_INSTALL_PRISTINE, '/backups'),
        sha256: OTHER_INSTALL_PRISTINE,
        damagedProvenance: ['/backups/other.for-abc.json'],
      });
      const plan = planRestoreOnly(facts({ backups: [mine(), damaged], manifest: null }));
      expect(plan).toMatchObject({ action: 'restore', backupPath: mine().path });
    });
  });
});
