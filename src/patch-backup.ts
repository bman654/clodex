// src/patch-backup.ts — pristine-backup identity for `clodex patch`.
//
// `clodex patch` patches PRISTINE bytes, never a patched binary (no patch on top
// of a patch). Those bytes come from a backup: `applyPatch` seeds its candidate
// from one and renames the result over the install, and `clodex patch --restore`
// copies one straight over the binary. Either way the chosen backup lands on the
// user's install, so picking the wrong one destroys it — a backup tagged with a
// version it does not actually contain silently downgrades Claude Code. Three
// rules make that unreachable:
//
//  1. Backups are CONTENT-ADDRESSED: `claude-<version>-<sha256 prefix>.orig`.
//     A file name can therefore never alias two different contents, and every
//     backup self-validates — rehash it and compare against its own name.
//  2. A backup is only ever used when its bytes are established as the pristine
//     bytes of the exact version being patched: the version tag must match the
//     version probed from the binary under the patch, integrity must verify, and
//     a legacy (pre-content-addressing) backup — which carries no hash to check —
//     must additionally report the same version when executed.
//  3. Bytes about to be patched must carry no clodex patch marker, whether they
//     came from the live binary or from a backup. A backup can be poisoned:
//     every clodex before content addressing snapshotted whatever was live when
//     no backup existed, and the version-resolution bug generated exactly that
//     state. Patching poisoned bytes would double-patch the install AND launder
//     the result into a content-addressed name that rule 1 then trusts on sight.
//  4. A version tag is not install provenance. The npm platform package and the
//     native installer ship DIFFERENT files under the same Claude Code version,
//     and both are supported, so a user can hold two same-version installs whose
//     bytes differ. The manifest is the only record of which install a backup was
//     made for, and it holds ONE install, so it can confirm a backup but never
//     rule one in by elimination: when it records a different install, or names
//     pristine bytes for this one that are no longer on disk, restoring is
//     refused rather than guessed (issue #199). What remains is the case of no
//     manifest at all, where selection still rests on the version tag; the plan
//     carries a note saying so.
//
// Everything here is deterministic given its inputs so the decisions can be
// tested directly; the caller performs the file copies.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Hex characters of the sha256 embedded in a content-addressed backup name. */
export const BACKUP_SHA_PREFIX_LENGTH = 16;

/** Backup directory, shared with tweakcc (`tweakcc --restore` reads it). */
export function backupDir(): string {
  return process.env['TWEAKCC_CONFIG_DIR']?.trim() || join(homedir(), '.tweakcc');
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Filename-safe form of a claude version string. */
export function backupVersionTag(version: string): string {
  const tag = version.trim().replace(/[^\w.-]+/g, '_');
  // Unreachable for a probed version (always `\d+.\d+.\d+`), but an empty tag
  // would make every version share one backup name — the aliasing this module
  // exists to prevent — so refuse rather than guess.
  if (!tag) throw new Error('clodex patch: refusing to name a pristine backup for an empty claude version');
  return tag;
}

/** `~/.tweakcc/claude-<version>-<sha256 prefix>.orig` — the name IS the content. */
export function contentAddressedBackupPath(version: string, sha256: string, dir = backupDir()): string {
  return join(dir, `claude-${backupVersionTag(version)}-${sha256.slice(0, BACKUP_SHA_PREFIX_LENGTH)}.orig`);
}

/** Pre-content-addressing name written by earlier clodex versions. */
export function legacyBackupPath(version: string, dir = backupDir()): string {
  return join(dir, `claude-${backupVersionTag(version)}.orig`);
}

/** tweakcc's own restore location, mirrored from the pristine backup. */
export function tweakccMirrorBackupPath(dir = backupDir()): string {
  return join(dir, 'native-binary.backup');
}

export interface BackupCandidate {
  path: string;
  /** `content-addressed` names carry a sha256 prefix; `legacy` ones do not. */
  kind: 'content-addressed' | 'legacy';
  /** sha256 of the file's CURRENT bytes. */
  sha256: string;
}

export interface BackupScan {
  /** Backups for this version whose bytes passed every check the name allows. */
  valid: BackupCandidate[];
  /** Content-addressed backups whose bytes no longer match their own name. */
  corrupt: string[];
}

/**
 * Find every backup on disk that claims to hold the pristine bytes of `version`.
 * Only names carrying this exact version tag are considered — a backup tagged
 * with a different version is never a candidate for restoring this binary, which
 * is what makes a mislabeled legacy file harmless instead of destructive.
 */
export function scanPristineBackups(version: string, dir = backupDir()): BackupScan {
  const tag = backupVersionTag(version);
  const pattern = new RegExp(`^claude-${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-([0-9a-f]{${BACKUP_SHA_PREFIX_LENGTH}}))?\\.orig$`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { valid: [], corrupt: [] };
  }
  const valid: BackupCandidate[] = [];
  const corrupt: string[] = [];
  for (const entry of entries.sort()) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const path = join(dir, entry);
    let sha256: string;
    try {
      if (!statSync(path).isFile()) continue;
      sha256 = sha256File(path);
    } catch {
      corrupt.push(path);
      continue;
    }
    const embedded = match[1];
    if (embedded) {
      // Self-validating: the bytes must still hash to the name they are stored under.
      if (sha256.slice(0, BACKUP_SHA_PREFIX_LENGTH) !== embedded) {
        corrupt.push(path);
        continue;
      }
      valid.push({ path, kind: 'content-addressed', sha256 });
    } else {
      valid.push({ path, kind: 'legacy', sha256 });
    }
  }
  return { valid, corrupt };
}

// ── Patched-binary detection ────────────────────────────────────────────────

/**
 * PROOF that the source carries a clodex patch: the `ccpatch` comments the patch
 * sites inject. The text is OURS, not Claude Code's, so a false positive would
 * take a Claude Code bundle literally shipping this prefix.
 *
 * It covers every binary current clodex publishes: PATCH 8a/8b/8c/9 emit the
 * `effort`, `xhigh-effort`, `max-effort` and `default-effort` variants, and those
 * sites are REQUIRED (applyPatch throws when any FAILs), so at least one is
 * always present. PATCH 7 adds the `ctx` variant when any model has a
 * non-default context window.
 *
 * Raw byte inspection of the native binary cannot see these (the bundle is
 * compressed inside it), so this runs on the JS `readContent` extracts.
 */
const CLODEX_PATCH_COMMENT_PREFIX = '/*ccpatch:';

/**
 * WEAKER signals, used only to warn. These identify a patch applied by a clodex
 * old enough to predate the required effort sites: back then the `ctx` comment
 * was the only marker, and it appears only when some model carried a non-default
 * context window — so such a binary can carry no proof marker at all (verified
 * against the real 2.1.220 bundle).
 *
 * They do NOT block, because unlike the proof marker they can in principle
 * collide with Claude Code's own bytes, and a false positive there is
 * UNRECOVERABLE: refusing to bootstrap tells the user to reinstall Claude Code,
 * which yields the very same bytes and the very same refusal. A missed legacy
 * patch, by contrast, is recoverable — delete the bad backup, reinstall, and the
 * reinstalled binary carries proof markers the moment clodex patches it.
 * So: proof blocks, heuristic warns.
 */
const LEGACY_CLODEX_PATCH_MARKERS = [
  'Additional custom models: ',                // PATCH 4 — Agent tool model description
  'function(_i){return _i.value===_o.value}',  // PATCH 5 — picker dedupe guard
  '"clodex:',                                  // PATCH 1/3 — canonical ids as model identities
];

/**
 * True when the extracted Claude Code source provably carries a clodex patch.
 * This is the gate on treating bytes as pristine — see the marker docs above for
 * why only the unambiguous marker is allowed to block.
 */
export function isPatchedClaudeSource(source: string): boolean {
  return source.includes(CLODEX_PATCH_COMMENT_PREFIX);
}

/**
 * True when the source carries no proof marker but does look like a patch from a
 * pre-effort-sites clodex. Callers warn; they must not refuse on this alone.
 */
export function looksLikeLegacyClodexPatch(source: string): boolean {
  return !isPatchedClaudeSource(source)
    && LEGACY_CLODEX_PATCH_MARKERS.some(marker => source.includes(marker));
}

// ── Planning ────────────────────────────────────────────────────────────────

export interface PatchManifestFacts {
  binaryPath: string;
  /**
   * The claude version the manifest was written for. A manifest that recorded a
   * DIFFERENT version says nothing about the backups tagged with the version now
   * being restored — its own backup is not even among them — so its testimony is
   * scoped to its version rather than applied across an upgrade. Absent in
   * hand-edited or truncated manifests, which are treated as same-version.
   */
  claudeVersion?: string;
  backupPath?: string;
  patchedSha256?: string;
  pristineSha256?: string;
}

export interface PristineFacts {
  /** Version probed from the binary that is about to be patched. */
  version: string;
  binaryPath: string;
  /** sha256 of the live binary's current bytes. */
  liveSha256: string;
  manifest: PatchManifestFacts | null;
  backups: BackupCandidate[];
  corruptBackups?: string[];
}

export type PristinePlan =
  /** The live binary IS the pristine bytes — patch it, no restore. */
  | { action: 'reuse'; backupPath: string; pristineSha256: string; notes: string[] }
  /** Restore these pristine bytes over the live binary, then patch. */
  | { action: 'restore'; backupPath: string; pristineSha256: string; probeVersion: boolean; notes: string[] }
  /** Undecidable from bytes alone — extract the source and re-plan. */
  | { action: 'inspect' }
  /** Bootstrap: store the live binary as this version's pristine backup. */
  | { action: 'snapshot'; backupPath: string; pristineSha256: string; notes: string[] }
  /** Nothing safe to do. Never fall back to a destructive copy. */
  | { action: 'error'; message: string };

/** A plan the caller can act on — `inspect` has already been resolved away. */
export type ResolvedPristinePlan = Exclude<PristinePlan, { action: 'inspect' }>;

/** Restoring pristine bytes either works from an established backup, or fails. */
export type RestorePlan = Extract<PristinePlan, { action: 'restore' } | { action: 'error' }>;

function noBackupMessage(facts: PristineFacts): string {
  const corrupt = facts.corruptBackups?.length
    ? ` (${facts.corruptBackups.length} backup file(s) for this version failed integrity checks and were ignored)`
    : '';
  return `claude ${facts.version} is already patched and no trustworthy pristine backup for that version exists in ${backupDir()}${corrupt}. `
    + 'Reinstall Claude Code to get a pristine binary, then run `clodex patch`.';
}

/**
 * True when `manifest` recorded WHICH backup holds its install's pristine bytes.
 * `pristineSha256` is absent from manifests written before content addressing,
 * so the recorded path counts too; a manifest carrying neither identifies
 * nothing and can neither confirm nor disqualify a backup.
 */
function identifiesABackup(manifest: PatchManifestFacts): boolean {
  return manifest.pristineSha256 !== undefined || manifest.backupPath !== undefined;
}

/** The manifest named this install's pristine bytes, and they are no longer usable. */
function recordedBackupGoneMessage(facts: PristineFacts, manifest: PatchManifestFacts): string {
  const named = manifest.backupPath ?? `the backup holding sha256 ${manifest.pristineSha256}`;
  const corrupt = facts.corruptBackups?.length
    ? ` (${facts.corruptBackups.length} backup file(s) for this version failed integrity checks and were ignored)`
    : '';
  const others = facts.backups.length
    ? `The ${facts.backups.length} other pristine backup(s) tagged claude ${facts.version} there were made `
      + 'for some other install — two installs of one Claude Code version are different files, so '
      + 'restoring one of them would overwrite this install with bytes that were never its own. '
    : '';
  return `The patch manifest records ${named} as the pristine content of ${facts.binaryPath}, and clodex `
    + `cannot use it: it is missing from ${backupDir()}, failed its integrity check, or holds a `
    + `different claude version${corrupt}. ${others}`
    + 'Reinstall Claude Code to get a pristine binary, then run `clodex patch`.';
}

/** A manifest for a DIFFERENT install cannot vouch for anything in the backup directory. */
function otherInstallMessage(facts: PristineFacts, otherBinaryPath: string): string {
  return `The patch manifest records a different Claude Code install (${otherBinaryPath}), so nothing `
    + `establishes that a pristine backup tagged claude ${facts.version} in ${backupDir()} belongs to `
    + `${facts.binaryPath}. Two installs of one Claude Code version are different files, so restoring `
    + 'by version tag alone would overwrite this install with another one\'s bytes. Set '
    + `TWEAKCC_CC_INSTALLATION_PATH=${otherBinaryPath} to restore that install instead, or reinstall `
    + 'Claude Code to make this one pristine.';
}

/**
 * Pick the pristine bytes to restore over an already-patched binary.
 * Every branch requires bytes whose provenance is established; when none are,
 * the result is an error rather than a guess.
 */
function selectRestoreSource(facts: PristineFacts): RestorePlan {
  const notes: string[] = [];
  const recorded = facts.manifest;
  // A manifest speaks only for the version it was written for. After an upgrade
  // it records a backup of the OLD version, which is not among this version's
  // candidates — treating that as "the recorded backup is gone" refused a restore
  // that was never in danger, and treating it as evidence about another install
  // refused one for a version it had never seen.
  const speaksForThisVersion = !recorded?.claudeVersion || recorded.claudeVersion === facts.version;
  const manifest = recorded && recorded.binaryPath === facts.binaryPath && speaksForThisVersion
    ? recorded
    : null;
  // A manifest recorded against a DIFFERENT install is not the same thing as no
  // manifest: it is positive evidence about the backup directory. The bytes it
  // names are that other install's pristine bytes, and two supported installs of
  // ONE Claude Code version are genuinely different files (the npm platform
  // package and the native installer ship different binaries under the same
  // version). Discarding the manifest and falling through to version-tag
  // selection published one install's bytes over the other and then deleted the
  // manifest, leaving no backup of what it clobbered — issue #199. Same version
  // is not the same install.
  const other = recorded && recorded.binaryPath !== facts.binaryPath && speaksForThisVersion
    ? recorded
    : null;

  // 1. The manifest's recorded pristine content, wherever it now lives. Matching
  //    on content (not path) also survives the legacy → content-addressed rename.
  let chosen = manifest?.pristineSha256
    ? facts.backups.find(backup => backup.sha256 === manifest.pristineSha256)
    : undefined;

  // 2. The manifest's recorded backup path. Only candidates carrying THIS
  //    version's tag are in `facts.backups`, so a manifest left by a version-
  //    resolution bug (path tagged with some other version) simply does not
  //    match here instead of being copied over a newer binary.
  if (!chosen && manifest?.backupPath) {
    chosen = facts.backups.find(backup => backup.path === manifest.backupPath);
  }

  // 2b. The manifest speaks FOR this install: it recorded which bytes are its
  //     pristine content. When neither the recorded hash nor the recorded path is
  //     on disk any more, every remaining same-version backup was made for some
  //     other install, and the manifest's own testimony says so. Falling through
  //     to version-tag selection here published another install's bytes.
  if (!chosen && manifest && identifiesABackup(manifest)) {
    return { action: 'error', message: recordedBackupGoneMessage(facts, manifest) };
  }

  // 3. No manifest help: fall back to the version's backups, but only when they
  //    agree on the content. Two different "pristine" snapshots of one version
  //    mean at least one is wrong; guessing is exactly the destructive move.
  if (!chosen) {
    // A manifest recorded against a DIFFERENT install vouches for nothing here.
    // Disqualifying only the backup IT names is not enough: the manifest holds one
    // install, so every earlier install's backup is an unrecorded orphan carrying
    // the same version tag, and picking "the one it did not name" hands a third
    // install's bytes to this one. There is no evidence to select on — refuse.
    if (other) {
      return facts.backups.length
        ? { action: 'error', message: otherInstallMessage(facts, other.binaryPath) }
        : { action: 'error', message: noBackupMessage(facts) };
    }
    const distinct = [...new Set(facts.backups.map(backup => backup.sha256))];
    if (distinct.length > 1) {
      return {
        action: 'error',
        message: `Found conflicting pristine backups for claude ${facts.version}: `
          + `${facts.backups.map(backup => backup.path).join(', ')}. `
          + 'They do not hold the same bytes, so clodex cannot tell which one is pristine. '
          + 'If this machine has more than one Claude Code install, both are probably genuine — one '
          + `per install — and deleting either one is a guess. Reinstall the Claude Code at `
          + `${facts.binaryPath} instead: a pristine install needs no backup, and \`clodex patch\` `
          + 'will record its own.',
      };
    }
    // Prefer a self-validating name when both spellings hold the same bytes.
    chosen = facts.backups.find(backup => backup.kind === 'content-addressed') ?? facts.backups[0];
    if (chosen) {
      // Say so out loud: no manifest records this install, so the ONLY thing tying
      // these bytes to it is the version tag in the file name. That is the last
      // place a same-version backup from another install can still be selected.
      notes.push(
        `No patch manifest records ${facts.binaryPath}, so ${chosen.path} is being used as its `
        + `pristine content on the strength of its claude ${facts.version} version tag alone. On a `
        + 'machine with more than one Claude Code install those bytes may belong to the other one — '
        + 'a clodex that had recorded this install would have refused rather than guess.',
      );
    }
  }

  if (!chosen) return { action: 'error', message: noBackupMessage(facts) };
  return {
    action: 'restore',
    backupPath: chosen.path,
    pristineSha256: chosen.sha256,
    // A legacy name carries no hash, so its bytes could be anything — including
    // another version's binary, stored under a mislabeled name by an older
    // clodex. Executing it is the only evidence available; require it.
    probeVersion: chosen.kind === 'legacy',
    notes,
  };
}

/**
 * First planning pass — decided from file hashes alone (no extraction).
 * Returns `inspect` when the live binary's bytes are unrecognized, meaning the
 * caller must extract the source and call `planInspectedPristineSource`.
 */
export function planPristineSource(facts: PristineFacts): PristinePlan {
  // The live binary matches a backup we already hold for this version → it is
  // provably pristine. Patch in place; no restore, no new snapshot.
  // Prefer a self-validating name when both spellings hold the same bytes; the
  // caller adopts a legacy-only match under its content address.
  const identical = facts.backups.find(backup => backup.sha256 === facts.liveSha256 && backup.kind === 'content-addressed')
    ?? facts.backups.find(backup => backup.sha256 === facts.liveSha256);
  if (identical) {
    return { action: 'reuse', backupPath: identical.path, pristineSha256: identical.sha256, notes: [] };
  }

  // The manifest says these exact bytes are the patch clodex applied to this
  // binary → it is patched; restore before patching again.
  const manifest = facts.manifest;
  if (manifest && manifest.binaryPath === facts.binaryPath && manifest.patchedSha256 === facts.liveSha256) {
    return selectRestoreSource(facts);
  }

  return { action: 'inspect' };
}

/**
 * Second planning pass, once the Claude Code source has been extracted and
 * checked for clodex patch markers.
 */
export function planInspectedPristineSource(
  facts: PristineFacts,
  inspection: { patched: boolean },
): ResolvedPristinePlan {
  if (inspection.patched) return selectRestoreSource(facts);

  // Bootstrap. The only way a first backup ever exists is by snapshotting a
  // binary whose provenance clodex cannot prove, so this decision is explicit:
  // snapshot ONLY a binary that carries no clodex patch marker. That is what
  // keeps a patched binary from being stored as "pristine" and poisoning every
  // later restore. The name is derived from the bytes being stored, so it can
  // never overwrite a different backup's content.
  const notes: string[] = [];
  const conflicting = facts.backups.filter(backup => backup.sha256 !== facts.liveSha256);
  if (conflicting.length) {
    notes.push(
      `Existing backup(s) for claude ${facts.version} hold different bytes (${conflicting.map(b => b.path).join(', ')}); `
      + 'the binary being patched carries no clodex patch marker, so it is being stored under its own content address. '
      + 'Both files are kept.',
    );
  }
  return {
    action: 'snapshot',
    backupPath: contentAddressedBackupPath(facts.version, facts.liveSha256),
    pristineSha256: facts.liveSha256,
    notes,
  };
}

/**
 * Plan for `clodex patch --restore`: the live binary is assumed patched, so the
 * same "establish the provenance or refuse" rules apply.
 */
export function planRestoreOnly(facts: PristineFacts): RestorePlan {
  return selectRestoreSource(facts);
}

/** Gather the on-disk facts a plan needs (hashes every backup for the version). */
export function collectPristineFacts(args: {
  version: string;
  binaryPath: string;
  manifest: PatchManifestFacts | null;
  dir?: string;
}): PristineFacts {
  const dir = args.dir ?? backupDir();
  const scan = scanPristineBackups(args.version, dir);
  return {
    version: args.version,
    binaryPath: args.binaryPath,
    liveSha256: existsSync(args.binaryPath) ? sha256File(args.binaryPath) : '',
    manifest: args.manifest,
    backups: scan.valid,
    corruptBackups: scan.corrupt,
  };
}
