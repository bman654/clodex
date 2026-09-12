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
//     refused rather than guessed (issue #199). A manifest is not enough on its
//     own, though: it holds one install and a successful `--restore` DELETES it,
//     so a backup routinely outlives the only record of what it belonged to. Each
//     backup therefore also carries a PROVENANCE RECORD PER INSTALL beside it,
//     naming an install whose pristine content it is and whether that association
//     was established or merely assumed. Those records survive the manifest, and
//     they are what lets two same-version installs coexist instead of one of them
//     being handed the other's bytes (issue #204). A record that exists but cannot
//     be read refuses rather than falling back — something claimed those bytes — and
//     so does a manifest that disagrees with a record about the same install, unless
//     the manifest describes the live bytes and is therefore provably the current one. Backups written before the records existed carry none
//     at all; for those, and only those, selection still rests on the version tag,
//     and then the plan says so and the guess itself is recorded as a guess so no
//     later run can re-derive it as proof.
//
// Everything that decides anything here is deterministic given its inputs so the
// decisions can be tested directly; the caller performs the file copies. The one
// write this module owns is a provenance record, which belongs beside the naming
// and scanning rules it is read by.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * On-disk shape of one provenance record: which install the backup beside it was
 * made for, and whether that association was ESTABLISHED or merely assumed.
 */
interface InstallProvenance {
  install: string;
  /**
   * True when the only thing that tied this backup to that install was the claude
   * version in its file name (issue #204's remaining compatibility fallback). Such
   * a record never selects and never refuses anything — it exists to stop the guess
   * from being promoted to an established one later, which is how a warned fallback
   * used to turn into a permanent fact every run then trusted on sight.
   */
  assumed: boolean;
}

/**
 * ONE FILE PER INSTALL, beside the backup: `<backup>.for-<hash>.json`.
 *
 * A single shared list would have to be read, merged and rewritten, and the patch
 * lock lives under `CLODEX_HOME` while the backup directory is shared — two
 * concurrent patches under different `CLODEX_HOME`s would lose one install's entry.
 * A file per install is created once and never merged, so there is nothing to lose.
 * The install path is hashed to keep the name filesystem-safe and fixed-length; the
 * path itself is inside the file, which is what selection reads.
 *
 * The suffix keeps these out of the `claude-*.orig` pattern the scanner matches, and
 * `tweakcc` only ever names `native-binary.backup` explicitly, so neither mistakes a
 * record for a backup.
 */
export function installProvenancePath(backupPath: string, binaryPath: string): string {
  const tag = createHash('sha256').update(binaryPath).digest('hex').slice(0, BACKUP_SHA_PREFIX_LENGTH);
  return `${backupPath}.for-${tag}.json`;
}

/** Matches any install's provenance record for the backup file `name`. */
function installProvenancePattern(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.for-[0-9a-f]{${BACKUP_SHA_PREFIX_LENGTH}}\\.json$`);
}

/** What one provenance record says, or `damaged` when it cannot be read. */
export type ProvenanceRecord = InstallProvenance | 'damaged';

export function readInstallProvenance(path: string): ProvenanceRecord | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'damaged';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'damaged';
  const { install, assumed } = parsed as { install?: unknown; assumed?: unknown };
  // Both fields are required, and `assumed` must be a real boolean: anything else
  // would read as `false` — the ESTABLISHED value — so a damaged former guess would
  // silently become the strongest evidence in the directory.
  if (typeof install !== 'string' || install === '') return 'damaged';
  if (typeof assumed !== 'boolean') return 'damaged';
  return { install, assumed };
}

/**
 * Record `binaryPath` as an install whose pristine content `backupPath` holds, and
 * report the confidence that now stands on disk.
 *
 * Idempotent. An ESTABLISHED record is never downgraded to a guess: callers ask for
 * `assumed` from what THIS run can prove, and a run that can prove less than an
 * earlier one must not erase what the earlier one knew. Promotion the other way is
 * allowed and necessary — a fresh snapshot inspects the install's own bytes, which is
 * evidence no guess produced — so callers must pass `assumed: true` whenever their
 * evidence is derived from an earlier guess rather than independent of it.
 *
 * The return value is what the caller must act on: `--restore` may only drop a patch
 * manifest once an ESTABLISHED record has replaced it, or the manifest's testimony is
 * destroyed and nothing takes its place.
 */
export function recordBackupProvenance(
  backupPath: string,
  binaryPath: string,
  opts: { assumed: boolean },
): 'established' | 'assumed' {
  const target = installProvenancePath(backupPath, binaryPath);
  const existing = readInstallProvenance(target);
  if (existing && existing !== 'damaged' && existing.install === binaryPath) {
    // Nothing to write: already at this confidence, or already stronger.
    if (existing.assumed === opts.assumed) return existing.assumed ? 'assumed' : 'established';
    if (!existing.assumed) return 'established';
  }
  const record: InstallProvenance = { install: binaryPath, assumed: opts.assumed };
  // Temp + rename for the same reason the backups use it: a half-written record
  // reads as damaged, and a damaged record refuses rather than falling back.
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, target);
    return opts.assumed ? 'assumed' : 'established';
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort — the temp name matches neither the backup pattern nor the
      // record one, so a leftover is inert.
    }
    throw err;
  }
}

export interface BackupCandidate {
  path: string;
  /** `content-addressed` names carry a sha256 prefix; `legacy` ones do not. */
  kind: 'content-addressed' | 'legacy';
  /** sha256 of the file's CURRENT bytes. */
  sha256: string;
  /**
   * Installs whose pristine content these bytes are ESTABLISHED to be. Empty for a
   * backup written before records existed — the one remaining case where a version
   * tag is all that ties a backup to an install. Assumed records are deliberately
   * absent: they are not evidence, and only the writer consults them.
   */
  installs: string[];
  /**
   * Installs recorded beside this backup as a GUESS. Not evidence: these never
   * select and never promote. They do block the version-tag fallback for a
   * DIFFERENT install, because "these bytes were once handed to that install" is
   * still a reason not to hand them to this one.
   */
  assumedInstalls: string[];
  /**
   * Provenance records beside this backup that could not be read. Something was
   * recorded and we cannot tell what, so the version-tag fallback is refused rather
   * than treating damaged positive evidence as if it had never existed.
   */
  damagedProvenance: string[];
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
  // One readdir for the backups AND their provenance records: the records are named
  // after the backup they belong to, so they are already in this listing.
  const provenanceOf = (
    name: string,
  ): Pick<BackupCandidate, 'installs' | 'assumedInstalls' | 'damagedProvenance'> => {
    const recordPattern = installProvenancePattern(name);
    const installs: string[] = [];
    const assumedInstalls: string[] = [];
    const damagedProvenance: string[] = [];
    for (const entry of entries) {
      if (!recordPattern.test(entry)) continue;
      const path = join(dir, entry);
      const record = readInstallProvenance(path);
      // The name came out of this same listing, so `null` here is not "no record":
      // it is one that exists and cannot be opened — a directory, a dangling link,
      // mode 000, an I/O error. Reading that as absent is what let the version-tag
      // fallback run on a backup that had already been claimed.
      if (record === null || record === 'damaged' || installProvenancePath(join(dir, name), record.install) !== path) {
        damagedProvenance.push(path);
        continue;
      }
      (record.assumed ? assumedInstalls : installs).push(record.install);
    }
    return {
      installs: installs.sort(),
      assumedInstalls: assumedInstalls.sort(),
      damagedProvenance: damagedProvenance.sort(),
    };
  };
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
      valid.push({ path, kind: 'content-addressed', sha256, ...provenanceOf(entry) });
    } else {
      valid.push({ path, kind: 'legacy', sha256, ...provenanceOf(entry) });
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
  /**
   * `assumed` when the run that wrote this manifest tied its backup to its install
   * by the claude version in a file name alone. Absent means established — which is
   * the right reading for every manifest written before this field existed, since a
   * guess back then was reported but not recorded anywhere else either.
   */
  pristineProvenance?: 'assumed';
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
  | {
      action: 'restore';
      backupPath: string;
      pristineSha256: string;
      probeVersion: boolean;
      /**
       * True when nothing but the version tag tied these bytes to this install —
       * no manifest for it, and no provenance sidecar anywhere. The restore still
       * happens (refusing would strand every backup written before sidecars
       * existed), but the caller must not record the guess as provenance.
       */
      assumedForThisInstall: boolean;
      notes: string[];
    }
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
  return `clodex holds no pristine backup of claude ${facts.version} it can attribute to `
    + `${facts.binaryPath}: none was found in ${backupDir()}${corrupt}. If that binary is patched, `
    + 'reinstall Claude Code to get a pristine one and run `clodex patch` again. If it was never '
    + 'patched, there is nothing to restore.';
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

/** Every backup on disk is recorded as belonging to some OTHER install. */
function otherInstallProvenanceMessage(facts: PristineFacts, recorded: BackupCandidate[]): string {
  const owners = [...new Set(recorded.flatMap(backup => backup.installs))];
  return `The pristine backup(s) of claude ${facts.version} in ${backupDir()} are recorded as the `
    + `pristine content of ${owners.join(', ')}, not of ${facts.binaryPath}. Two installs of one `
    + 'Claude Code version are different files, so restoring one of those would overwrite this '
    + `install with bytes that were never its own. Set TWEAKCC_CC_INSTALLATION_PATH=${owners[0]} to `
    + 'restore that install instead, or reinstall Claude Code to make this one pristine.';
}

/** A provenance record exists beside a backup but cannot be read. */
function damagedProvenanceMessage(facts: PristineFacts, damaged: string[]): string {
  return `A pristine backup of claude ${facts.version} in ${backupDir()} carries a provenance record `
    + `that clodex cannot read (${damaged.join(', ')}). Something recorded which install those bytes `
    + 'belong to and that record is damaged, so clodex will not fall back to matching on the claude '
    + `version in the file name — on a machine with more than one install that would hand `
    + `${facts.binaryPath} bytes that were never its own. Delete the unreadable record to accept that `
    + 'fallback, or reinstall Claude Code to make this install pristine.';
}

/** Two backups holding different bytes both claim to be this install's pristine content. */
function contradictoryProvenanceMessage(facts: PristineFacts, mine: BackupCandidate[]): string {
  return `More than one pristine backup of claude ${facts.version} is recorded as the pristine `
    + `content of ${facts.binaryPath} (${mine.map(backup => backup.path).join(', ')}), and they do `
    + 'not hold the same bytes, so clodex cannot tell which one that install holds now — being '
    + 'snapshotted twice, at two different sets of unpatched bytes, reaches this state without either '
    + 'record being wrong. Delete whichever is stale to decide it: '
    + `${mine.map(backup => installProvenancePath(backup.path, facts.binaryPath)).join(', ')}. `
    + `Or reinstall the Claude Code at ${facts.binaryPath} and delete both.`;
}

/** The manifest and an established record disagree about this install's pristine bytes. */
function manifestContradictsRecordMessage(
  facts: PristineFacts,
  manifestChoice: string,
  recorded: BackupCandidate[],
): string {
  return `The patch manifest names ${manifestChoice} as the pristine content of ${facts.binaryPath}, `
    + `but ${recorded.map(backup => backup.path).join(', ')} is recorded as that install's pristine `
    + 'content and holds different bytes. Nothing establishes which of them the install at that path '
    + 'is now — an executable replaced in place with a different build of the same claude version '
    + 'reaches exactly this state — so clodex will not pick one. Delete whichever of these records is '
    + `stale to decide it: ${recorded.map(backup => installProvenancePath(backup.path, facts.binaryPath)).join(', ')}. `
    + `Or reinstall the Claude Code at ${facts.binaryPath} and delete both: a pristine install needs `
    + 'no backup, and `clodex patch` will record its own.';
}

/** Bytes this machine has already handed to a DIFFERENT install, as a guess. */
function assumedElsewhereMessage(facts: PristineFacts, backups: BackupCandidate[]): string {
  const others = [...new Set(backups.flatMap(backup => backup.assumedInstalls))];
  return `The pristine backup(s) of claude ${facts.version} in ${backupDir()} have already been `
    + `restored onto ${others.join(', ')} — not onto ${facts.binaryPath}. That was itself matched on `
    + 'the claude version in a file name, so it is not proof of ownership, but it is a reason not to '
    + `hand the same bytes to a second install: two installs of one version are different files. Set `
    + `TWEAKCC_CC_INSTALLATION_PATH=${others[0]} to restore that install, or reinstall Claude Code to `
    + 'make this one pristine.';
}

/**
 * Pick the pristine bytes to restore over an already-patched binary.
 * Every branch requires bytes whose provenance is established; when none are,
 * the result is an error rather than a guess.
 */
function selectRestoreSource(facts: PristineFacts): RestorePlan {
  const notes: string[] = [];
  let assumedForThisInstall = false;
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

  // 2c. The manifest chose, but a record for this same install names bytes that are
  //     not those. That state is reachable BOTH ways round: one install path can be
  //     rewritten in place with a different build of the same claude version (the
  //     manifest is then stale), and one install can legitimately be snapshotted
  //     twice — tweakcc theming rewrites the binary, and the snapshot path keeps both
  //     files on purpose — leaving two true records of what it held at two times.
  //
  //     What separates them is whether the manifest describes the binary in front of
  //     us. When its `patchedSha256` IS the live bytes, clodex provably wrote them
  //     last, so it is the current record and its backup is the right source. Only
  //     when it does not is there nothing to date either claim by, and then refusing
  //     is the only safe answer: refusing in the other case made every later patch
  //     AND restore of an ordinary single-install machine fail permanently, with a
  //     message telling the user to reinstall, which does not clear a record.
  const manifestDescribesLiveBytes = !!manifest?.patchedSha256
    && manifest.patchedSha256 === facts.liveSha256;
  if (chosen && !manifestDescribesLiveBytes) {
    const manifestChoice = chosen;
    const contradicting = facts.backups.filter(
      backup => backup.installs.includes(facts.binaryPath) && backup.sha256 !== manifestChoice.sha256,
    );
    if (contradicting.length) {
      return {
        action: 'error',
        message: manifestContradictsRecordMessage(facts, manifestChoice.path, contradicting),
      };
    }
  }

  // 3. No manifest help: fall back to the version's backups, but only when they
  //    agree on the content. Two different "pristine" snapshots of one version
  //    mean at least one is wrong; guessing is exactly the destructive move.
  // 3. The provenance records: which backups were made FOR this install. This is
  //    the record that outlives the manifest, so it is the evidence available on
  //    exactly the paths #199's manifest fix could not reach — after a successful
  //    `--restore` deleted the manifest, or with a wiped `~/.clodex`. It also
  //    settles a two-install machine positively rather than by refusal: each
  //    install's own backup names it, so both can be restored.
  if (!chosen) {
    const mine = facts.backups.filter(backup => backup.installs.includes(facts.binaryPath));
    if (mine.length) {
      if (new Set(mine.map(backup => backup.sha256)).size > 1) {
        return { action: 'error', message: contradictoryProvenanceMessage(facts, mine) };
      }
      // Prefer a self-validating name when both spellings hold the same bytes.
      chosen = mine.find(backup => backup.kind === 'content-addressed') ?? mine[0];
    }
  }

  // 4. Nothing establishes a backup for this install. Refuse on any positive
  //    evidence that the bytes on disk belong elsewhere, and fall back to the
  //    version tag only for backups that carry no record at all.
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
    // A sidecar naming some other install is the same kind of positive evidence,
    // and it is the one that survives the manifest being deleted. Without it,
    // restoring here published one install's pristine bytes over another and then
    // reported success — issue #204.
    const recordedElsewhere = facts.backups.filter(backup => backup.installs.length > 0);
    if (recordedElsewhere.length) {
      return { action: 'error', message: otherInstallProvenanceMessage(facts, recordedElsewhere) };
    }
    // A record that cannot be read is not the same as no record: something was
    // written, and reading it as "unattributed" is what would let the version-tag
    // fallback below run on a backup that had already been claimed.
    const damaged = facts.backups.flatMap(backup => backup.damagedProvenance);
    if (damaged.length) {
      return { action: 'error', message: damagedProvenanceMessage(facts, damaged) };
    }
    // These bytes have already been restored onto some OTHER install by this same
    // fallback. The guess proves nothing about ownership, so it neither selects nor
    // establishes — but running the fallback AGAIN for a second install is how one
    // install's bytes reach two, and the first guess is warning enough not to.
    // A guess recorded for THIS install is not a reason to refuse: it is the same
    // decision, being repeated.
    const assumedElsewhere = facts.backups.filter(
      backup => backup.assumedInstalls.some(install => install !== facts.binaryPath),
    );
    if (assumedElsewhere.length) {
      return { action: 'error', message: assumedElsewhereMessage(facts, assumedElsewhere) };
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
      // Say so out loud: nothing records which install this backup was made for,
      // so the ONLY thing tying these bytes to this one is the version tag in the
      // file name. That is the last place a same-version backup from another
      // install can still be selected, and it is reachable only for a backup
      // written before clodex recorded provenance beside it.
      assumedForThisInstall = true;
      notes.push(
        `Neither a patch manifest nor a provenance record ties ${chosen.path} to ${facts.binaryPath}, `
        + `so it is being used as that install's pristine content on the strength of its claude `
        + `${facts.version} version tag alone — it predates the records clodex now writes. On a `
        + 'machine with more than one Claude Code install those bytes may belong to the other one, '
        + 'and clodex will not record this guess as provenance.',
      );
    }
  }

  if (!chosen) return { action: 'error', message: noBackupMessage(facts) };
  // A manifest written by a run that guessed is not independent evidence — it is the
  // guess, written down. Carrying its own confidence forward is what stops the next
  // run from reading it as proof and promoting the record beside the backup.
  if (manifest?.pristineProvenance === 'assumed') assumedForThisInstall = true;
  return {
    action: 'restore',
    backupPath: chosen.path,
    pristineSha256: chosen.sha256,
    // A legacy name carries no hash, so its bytes could be anything — including
    // another version's binary, stored under a mislabeled name by an older
    // clodex. Executing it is the only evidence available; require it.
    probeVersion: chosen.kind === 'legacy',
    assumedForThisInstall,
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
