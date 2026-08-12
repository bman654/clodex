// src/patcher.ts — clodex patch: first-class Claude Code binary patcher.
//
// Uses tweakcc's programmatic API (readContent/writeContent — an exact-pinned,
// declared dependency; no npx, no network) to extract the bundled JS from the
// Claude Code binary, applies the clodex patch sites in-process
// (see patch-transforms.ts), and repacks. Adds:
//  - auto-config: the patch map is built from clodex favorites + aliases,
//    context windows resolved from registry model metadata (never asked),
//  - auto-apply: no confirmation, concise summary,
//  - idempotence: a manifest (~/.clodex/patch-state.json) records the claude
//    version + config hash; unchanged config → fast no-op,
//  - re-patch: stale config/version → seed the candidate from the pristine
//    backup instead of the live binary, so a patch is never stacked on a patch,
//  - a content-addressed pristine backup per version+content
//    (~/.tweakcc/claude-<ver>-<sha>.orig, see patch-backup.ts) that is only ever
//    used once its provenance is established,
//  - atomic publication: the patch is built in a sibling temp dir and renamed
//    over the live binary only after it fully succeeds,
//  - a pid lock (~/.clodex/patch.lock) so concurrent launches cannot race.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { getAppHome } from './paths.js';
import { loadPreferences, savePreferences } from './config.js';
import {
  applyLocalPatches,
  inspectLocalPatchSource,
  type LocalPatchSource,
} from './local-patches.js';
import {
  builtInPatchProofsChanged,
  captureBuiltInPatchProofs,
  type BuiltInPatchProof,
} from './built-in-patch-proofs.js';
import { loadRegistry } from './registry/io.js';
import { projectProviderCachedModels } from './registry/materialize.js';
import { isRetainedOpenCodeGoProvider } from './registry/resolve-template.js';
import { findModelsDevModel } from './registry/models-dev.js';
import { findClaudeBinary, getClaudeVersionForBinary } from './launch.js';
import {
  backupDir,
  collectPristineFacts,
  contentAddressedBackupPath,
  isPatchedClaudeSource,
  looksLikeLegacyClodexPatch,
  planInspectedPristineSource,
  planPristineSource,
  planRestoreOnly,
  sha256File,
  tweakccMirrorBackupPath,
  type PristineFacts,
  type PristinePlan,
  type ResolvedPristinePlan,
} from './patch-backup.js';
import type { Installation } from 'tweakcc';
import { httpProxyDisplayName, httpProxyModelId } from './http-proxy/routes.js';
import { stripOneMContextSuffix } from './context-model-id.js';
import { getPatchReasoningCapabilities } from './provider-factory.js';
import {
  describeModelAliasRejection,
  normalizeModelAliases,
  type ModelAliasRejection,
  type StoredModelAlias,
} from './model-aliases.js';
import {
  applyClodexPatches,
  formatPatchSiteLine,
  PatchApplyError,
  projectNativeEffort,
  PATCH_TRANSFORMS_VERSION,
  type PatchSiteResult,
  type PatchScriptModelConfig,
} from './patch-transforms.js';

// ── Manifest ────────────────────────────────────────────────────────────────

export interface PatchManifest {
  /** Resolved (real) path of the patched claude binary. */
  binaryPath: string;
  /** `claude --version` at patch time. */
  claudeVersion: string;
  /** sha256 of the transform-set version and desired patch model config. */
  configHash: string;
  /** Size in bytes of the binary after patching (cheap staleness probe). */
  patchedSize: number;
  /** sha256 of the binary after patching. */
  patchedSha256: string;
  /** Pristine backup used for restore. */
  backupPath: string;
  /**
   * sha256 of the pristine bytes in `backupPath`. Written since content-addressed
   * backups landed; absent in manifests from older installs, so readers must
   * treat it as optional.
   */
  pristineSha256?: string;
  patchedAt: string;
}

export function getPatchManifestPath(): string {
  return join(getAppHome(), 'patch-state.json');
}

export function getPatchLockPath(): string {
  return join(getAppHome(), 'patch.lock');
}

export function readPatchManifest(path = getPatchManifestPath()): PatchManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PatchManifest;
    if (parsed && typeof parsed.binaryPath === 'string' && typeof parsed.configHash === 'string') {
      return parsed;
    }
  } catch {
    // missing or invalid manifest → unpatched
  }
  return null;
}

function writePatchManifest(manifest: PatchManifest, path = getPatchManifestPath()): void {
  mkdirSync(getAppHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

// ── Desired patch config (pure given inputs) ────────────────────────────────

export interface DesiredPatchConfig {
  config: PatchScriptModelConfig;
  /** Model ids whose context window is unknown (defaulting to Claude Code's 200k). */
  unknownWindows: string[];
  /** Saved aliases excluded from the patch while remaining in configuration. */
  rejectedAliases: StoredModelAlias[];
  rejectedAliasRejections: ModelAliasRejection[];
}

/** Model metadata the patch bakes in, resolved from the registry models cache. */
export interface PatchModelMeta {
  contextWindow?: number;
  /** Canonical label, e.g. `GPT-5.6 Sol (OpenAI (ChatGPT))`. */
  displayName?: string;
  effort?: {
    levels: string[];
    defaultLevel: string;
  };
}

/**
 * Build the patch model config from favorites + aliases.
 * Keys are the bare `clodex:<provider>:<model>` ids (no [1m] suffix — the
 * context patch and the suffix are mutually exclusive). When an entry has an
 * alias, that alias becomes the model's identity inside the patched binary.
 */
export function buildPatchModelConfig(
  favorites: Array<{ providerId: string; modelId: string }>,
  aliases: unknown,
  modelMetaFor: (providerId: string, modelId: string) => PatchModelMeta | undefined,
): DesiredPatchConfig {
  const config: PatchScriptModelConfig = {};
  const unknownWindows: string[] = [];
  const normalizedAliases = normalizeModelAliases(aliases);
  const favoriteTargets = new Set(
    favorites.map(favorite => `${favorite.providerId}:${favorite.modelId}`),
  );
  const targetRejections: ModelAliasRejection[] = normalizedAliases.accepted
    .filter(({ alias }) => (
      !favoriteTargets.has(`${alias.providerId}:${alias.modelId}`)
    ))
    .flatMap(({ sources }) => sources.map(source => ({
      alias: source,
      reason: 'target-not-favorite',
    })));
  const aliasByFavorite = new Map(
    normalizedAliases.aliases
      .filter(alias => favoriteTargets.has(`${alias.providerId}:${alias.modelId}`))
      .map(alias => [
        `${alias.providerId}:${alias.modelId}`,
        alias.name,
      ]),
  );

  for (const favorite of favorites) {
    const id = stripOneMContextSuffix(httpProxyModelId(favorite.providerId, favorite.modelId));
    if (config[id]) continue;
    const meta = modelMetaFor(favorite.providerId, favorite.modelId);
    const context = meta?.contextWindow;
    const alias = aliasByFavorite.get(`${favorite.providerId}:${favorite.modelId}`);
    const entry: PatchScriptModelConfig[string] = {};
    if (alias) entry.alias = alias;
    if (context === undefined || context <= 0) unknownWindows.push(id);
    else if (context !== 200_000) entry.context = context;
    const display = meta?.displayName?.trim();
    if (display) entry.display = display;
    const effort = projectNativeEffort(meta?.effort);
    if (effort) entry.effort = effort;
    config[id] = entry;
  }
  return {
    config,
    unknownWindows,
    rejectedAliases: [
      ...normalizedAliases.rejected,
      ...targetRejections.map(rejection => rejection.alias),
    ],
    rejectedAliasRejections: [
      ...normalizedAliases.rejections,
      ...targetRejections,
    ],
  };
}

export function reportRejectedModelAliases(
  rejections: ModelAliasRejection[],
): void {
  for (const rejection of rejections) {
    p.log.warn(
      `Saved model alias ${JSON.stringify(rejection.alias.name)} was not patched — `
      + `${describeModelAliasRejection(rejection.reason)}. The saved entry was preserved.`,
    );
  }
}

/** Canonical (key-sorted) hash of the transform-set version and patch model config. */
export function computePatchConfigHash(
  config: PatchScriptModelConfig,
  transformsVersion = PATCH_TRANSFORMS_VERSION,
  localPatchIdentity?: string,
): string {
  const canonical = Object.keys(config).sort().map(key => {
    const entry = config[key]!;
    return [
      key,
      entry.alias ?? null,
      entry.context ?? null,
      entry.display ?? null,
      entry.effort?.levels ?? null,
      entry.effort?.defaultLevel ?? null,
    ];
  });
  const payload: unknown[] = [transformsVersion, canonical];
  if (localPatchIdentity !== undefined) {
    payload.push(['local-patches', localPatchIdentity]);
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Read favorites + aliases + registry model metadata from disk (no network, no credentials). */
export function buildDesiredPatchConfig(): DesiredPatchConfig {
  const prefs = loadPreferences();
  const favorites = prefs.favoriteModels ?? [];
  const aliases = prefs.modelAliases;
  const registry = loadRegistry();

  const providerById = new Map(registry.providers.map(provider => [provider.id, provider]));
  const projectedModelsByProvider = new Map<string, ReturnType<typeof projectProviderCachedModels>>();
  const meta = new Map<string, PatchModelMeta>();
  for (const provider of registry.providers) {
    const projectedModels = projectProviderCachedModels(provider);
    projectedModelsByProvider.set(provider.id, projectedModels);
    for (const model of projectedModels) {
      const npm = model.npm ?? provider.api.npm ?? '';
      const upstreamModelId = model.upstreamModelId ?? model.id;
      const modelsDev = findModelsDevModel(provider.id, model.id);
      const effort = getPatchReasoningCapabilities(npm, upstreamModelId, {
        providerId: provider.id,
        apiBaseUrl: model.apiUrl ?? provider.api.url,
        supportedParameters: model.supportedParameters,
        reasoning: model.reasoning ?? modelsDev?.reasoning,
        interleavedReasoningField:
          model.interleavedReasoningField ?? modelsDev?.interleaved?.field,
        compatibility: model.compatibility,
        upstreamModelId,
      });
      meta.set(`${provider.id}:${model.id}`, {
        contextWindow: model.contextWindow && model.contextWindow > 0 ? model.contextWindow : undefined,
        // Same label `clodex server` prints at startup and `models --list` shows.
        displayName: httpProxyDisplayName(model, provider.name),
        effort: effort.mode === 'controllable'
          ? { levels: effort.levels, defaultLevel: effort.defaultLevel }
          : undefined,
      });
    }
  }

  const projectedFavorites = favorites.filter(favorite => {
    const provider = providerById.get(favorite.providerId);
    if (!provider || !isRetainedOpenCodeGoProvider(provider)) return true;
    return projectedModelsByProvider.get(provider.id)?.some(model => model.id === favorite.modelId) ?? false;
  });

  return buildPatchModelConfig(
    projectedFavorites,
    aliases,
    (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
  );
}

// ── Staleness (pure) ────────────────────────────────────────────────────────

export type PatchState = 'unpatched' | 'current' | 'stale-config' | 'stale-binary';

export function evaluatePatchState(
  manifest: PatchManifest | null,
  current: { binaryPath: string; claudeVersion: string; configHash: string; binarySize?: number },
): PatchState {
  if (!manifest) return 'unpatched';
  if (manifest.binaryPath !== current.binaryPath) return 'unpatched';
  if (manifest.claudeVersion !== current.claudeVersion) return 'stale-binary';
  if (current.binarySize !== undefined && manifest.patchedSize !== current.binarySize) return 'stale-binary';
  if (manifest.configHash !== current.configHash) return 'stale-config';
  return 'current';
}

// ── Lock (pid + staleness) ──────────────────────────────────────────────────

const PATCH_LOCK_STALE_MS = 10 * 60 * 1000;

interface PatchLockContent {
  pid: number;
  startedAt: number;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Try to take the patch lock. Returns a release function, or null when another
 * live process holds it. A lock left by a dead pid or older than 10 minutes is
 * treated as stale and replaced.
 */
export function tryAcquirePatchLock(
  lockPath = getPatchLockPath(),
  opts: { now?: number; isAlive?: (pid: number) => boolean } = {},
): (() => void) | null {
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? pidIsAlive;
  mkdirSync(join(lockPath, '..'), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      const content: PatchLockContent = { pid: process.pid, startedAt: now };
      writeFileSync(fd, JSON.stringify(content));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch {
      // Lock exists — check staleness.
      let stale = false;
      try {
        const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as PatchLockContent;
        stale = !existing.pid
          || !isAlive(existing.pid)
          || (typeof existing.startedAt === 'number' && now - existing.startedAt > PATCH_LOCK_STALE_MS);
      } catch {
        stale = true; // unreadable lock file → stale
      }
      if (!stale) return null;
      try {
        unlinkSync(lockPath);
      } catch {
        // raced with the owner's cleanup — retry loop handles it
      }
    }
  }
  return null;
}

// ── Binary + backup helpers ─────────────────────────────────────────────────

/** Outcome of locating the binary `clodex patch` should operate on. */
export type ClaudePatchTarget =
  | { ok: true; binaryPath: string; version: string }
  | { ok: false; reason: 'binary-not-found' }
  | { ok: false; reason: 'version-unknown'; binaryPath: string };

/**
 * Locate the REAL native binary, bypassing wrapper shims (e.g. cmux) that a
 * plain PATH lookup can return. Order (ported from the relay-ai wrapper):
 * TWEAKCC_CC_INSTALLATION_PATH → ~/.local/bin/claude (stable native-install
 * symlink) → findClaudeBinary() PATH lookup.
 *
 * The version is probed from THAT binary, never from whatever `claude` PATH
 * resolves to. The two chains diverge exactly when the overrides matter (a shim
 * on PATH, a different install under the override), and the version selects the
 * pristine backup that seeds the patch candidate — so a version borrowed from
 * another install publishes those other bytes over the user's Claude Code. There
 * is no fallback version for the same reason: an unprobeable binary is an error.
 */
export function resolveClaudeBinaryForPatch(): ClaudePatchTarget {
  const envOverride = process.env['TWEAKCC_CC_INSTALLATION_PATH'];
  const nativeSymlink = join(homedir(), '.local', 'bin', 'claude');
  const source = envOverride?.trim()
    || (existsSync(nativeSymlink) ? nativeSymlink : null)
    || findClaudeBinary();
  if (!source) return { ok: false, reason: 'binary-not-found' };
  let resolved: string;
  try {
    resolved = realpathSync(source);
  } catch {
    return { ok: false, reason: 'binary-not-found' };
  }
  try {
    if (!statSync(resolved).isFile()) return { ok: false, reason: 'binary-not-found' };
  } catch {
    return { ok: false, reason: 'binary-not-found' };
  }
  const version = getClaudeVersionForBinary(resolved);
  if (!version) return { ok: false, reason: 'version-unknown', binaryPath: resolved };
  return { ok: true, binaryPath: resolved, version };
}

/** Accurate, actionable message per failure reason — the two are NOT the same problem. */
export function describePatchTargetFailure(target: Extract<ClaudePatchTarget, { ok: false }>): string {
  return target.reason === 'binary-not-found'
    ? 'claude binary not found. Install Claude Code or set TWEAKCC_CC_INSTALLATION_PATH.'
    : `Could not determine the version of ${target.binaryPath} (\`claude --version\` failed). `
      + 'clodex will not patch a binary whose version it cannot read, because the version selects the '
      + 'pristine backup it patches from. If a previous patch left the install broken, '
      + '`clodex patch --restore` still works — it reads the version from the patch manifest.';
}

// ── Patch reporting ─────────────────────────────────────────────────────────

/** Per-site report lines + summary, same shape the old tweakcc output showed. */
export function summarizePatchResults(results: PatchSiteResult[]): string[] {
  const lines = results.map(formatPatchSiteLine);
  const ok = results.filter(r => r.status === 'OK').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const failed = results.filter(r => r.status === 'FAIL');
  lines.push(`clodex patch: ${ok} applied, ${skip} skipped, ${failed.length} failed`);
  if (failed.length) {
    lines.push(`clodex patch: FAILED patches: ${failed.map(f => f.name).join('; ')}`);
  }
  return lines;
}

// ── Apply / restore ─────────────────────────────────────────────────────────

export interface ApplyOutcome {
  ok: boolean;
  message: string;
  detailLines?: string[];
}

/**
 * Establish that a backup really holds the pristine bytes of `version` before
 * anything is built from it. Content-addressed backups are already self-validated
 * by name; a legacy `claude-<ver>.orig` carries no hash, so the only evidence
 * that its bytes are that version is running it.
 *
 * Both callers put these bytes on the user's install — `applyPatch` seeds the
 * patch candidate from them and renames it into place, `--restore` copies them
 * over the binary directly — so an unverified backup is a silent downgrade
 * either way.
 */
function verifyPristineSource(
  plan: Extract<PristinePlan, { action: 'restore' }>,
  version: string,
): { ok: true } | { ok: false; message: string } {
  if (!plan.probeVersion) return { ok: true };
  const backupVersion = getClaudeVersionForBinary(plan.backupPath);
  if (backupVersion === version) return { ok: true };
  return {
    ok: false,
    message: `Refusing to use ${plan.backupPath} as the pristine source for claude ${version}: it reports `
      + `${backupVersion ? `version ${backupVersion}` : 'no version at all'}. `
      + 'That backup predates content-addressed backup names and does not hold this version\'s bytes. '
      + 'Remove it (or reinstall Claude Code), then run `clodex patch`.',
  };
}

/**
 * Publish a file into the backup directory atomically: write a temp file beside
 * the destination, then rename it into place.
 *
 * A plain `copyFileSync` of a ~250 MB binary that is interrupted (Ctrl-C, crash,
 * ENOSPC) leaves a TRUNCATED file under a name asserting its content hash. That
 * is the one corruption content-addressing cannot notice without re-hashing, and
 * it made `clodex patch` fail permanently with a misleading extraction error.
 * `rename` within one directory is atomic, so a backup file is either absent or
 * complete — never half-written.
 */
function publishBackupFile(from: string, to: string): void {
  const temp = `${to}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    copyFileSync(from, temp);
    renameSync(temp, to);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort — the temp name is unique and does not match the scanner's
      // `claude-*.orig` pattern, so a leftover is never mistaken for a backup.
    }
    throw err;
  }
}

/**
 * Refuse bytes that already carry a clodex patch. `planInspectedPristineSource`
 * applies this rule to the LIVE binary; this is the same rule for bytes that came
 * out of a BACKUP, which `verifyPristineSource` cannot cover because it only
 * proves the version — and a patched claude reports its own version perfectly.
 */
function describePoisonedPristineSource(backupPath: string, version: string): string {
  return `Refusing to patch from ${backupPath}: those bytes already carry a clodex patch, `
    + 'so they are not pristine and patching them would stack a patch on a patch. '
    + `That backup was recorded as pristine for claude ${version} by an older clodex, which `
    + 'snapshotted whatever binary was live when no backup existed. '
    + `Delete ${backupPath}, reinstall Claude Code, then run \`clodex patch\`.`;
}

function requiredEffortPatchFailures(results: PatchSiteResult[]): PatchSiteResult[] {
  return results.filter(result =>
    result.status === 'FAIL'
    && (
      result.name.startsWith('PATCH 8a:')
      || result.name.startsWith('PATCH 8b:')
      || result.name.startsWith('PATCH 8c:')
      || result.name.startsWith('PATCH 9:')
    ),
  );
}

function builtInPatchVerificationFailed(
  source: string,
  config: PatchScriptModelConfig,
  expected: PatchSiteResult[],
  proofs: BuiltInPatchProof[],
): boolean {
  if (builtInPatchProofsChanged(source, proofs)) return true;

  let verification: ReturnType<typeof applyClodexPatches>;
  try {
    verification = applyClodexPatches(source, config);
  } catch {
    return true;
  }
  if (verification.content !== source || verification.results.length !== expected.length) {
    return true;
  }

  const expectedByName = new Map(expected.map(result => [
    result.name.replace(/ \(refresh\)$/, ''),
    result,
  ]));
  for (const result of verification.results) {
    const original = expectedByName.get(result.name.replace(/ \(refresh\)$/, ''));
    if (!original) return true;
    if (original.status === 'FAIL') {
      if (result.status !== 'FAIL' || result.extra !== original.extra) return true;
    } else if (result.status !== 'SKIP') {
      return true;
    }
  }
  return false;
}

function discardLocalPatchOutcome(
  builtInContent: string,
  results: PatchSiteResult[],
): { content: string; results: PatchSiteResult[] } {
  return {
    content: builtInContent,
    results: [
      ...results.map(result => result.status === 'OK'
        ? {
            status: 'SKIP' as const,
            name: result.name,
            extra: 'rolled back after built-in verification failed',
          }
        : result),
      {
        status: 'FAIL',
        name: 'LOCAL PATCH SET',
        extra: 'local output changed built-in patch sites',
      },
    ],
  };
}

export async function applyPatch(
  binaryPath: string,
  version: string,
  desired: DesiredPatchConfig,
  configHash: string,
  opts: {
    trace: boolean;
    manifest: PatchManifest | null;
    localPatches?: LocalPatchSource;
  },
): Promise<ApplyOutcome> {
  let candidateDir: string | undefined;
  let results: PatchSiteResult[];
  let patchedSize: number;
  let patchedSha256: string;
  let backup: string;
  let pristineSha256: string;
  try {
    mkdirSync(backupDir(), { recursive: true });

    // tweakcc's lib entry pulls in its interactive-picker deps (ink/react), so
    // load it lazily — only when a patch is actually applied.
    const { tryDetectInstallation, readContent, writeContent } = await import('tweakcc');

    // Everything below reads and writes the CANDIDATE; the live binary is only
    // touched by the final rename. Seeding it is also how the source gets
    // extracted, so no path pays for the (expensive, ~250 MB) extraction twice
    // unless the seed itself has to change.
    candidateDir = mkdtempSync(join(dirname(binaryPath), '.clodex-patch-'));
    const candidatePath = join(candidateDir, basename(binaryPath));
    const seedCandidate = async (from: string): Promise<{ installation: Installation; source: string }> => {
      copyFileSync(from, candidatePath);
      const installation = await tryDetectInstallation({ path: candidatePath });
      return { installation, source: await readContent(installation) };
    };

    const facts: PristineFacts = collectPristineFacts({
      version,
      binaryPath,
      manifest: opts.manifest,
    });

    const initial = planPristineSource(facts);
    let loaded: { installation: Installation; source: string } | null = null;
    let plan: ResolvedPristinePlan;
    if (initial.action === 'inspect') {
      // Unrecognized bytes. The only reliable "is this already patched?" signal
      // lives in the extracted JS (the native binary compresses it, so a raw
      // byte scan finds nothing), so seed the candidate from the LIVE binary and
      // inspect that copy — byte-identical, so it answers the question about the
      // live binary, which is what the R1 guard below turns on.
      loaded = await seedCandidate(binaryPath);
      if (looksLikeLegacyClodexPatch(loaded.source)) {
        p.log.warn(
          `${binaryPath} carries no clodex patch marker but does look like a patch from a clodex `
          + 'older than the effort patch sites. Treating it as pristine; if `/model` shows stale '
          + 'entries afterwards, reinstall Claude Code and run `clodex patch` again.',
        );
      }
      plan = planInspectedPristineSource(facts, { patched: isPatchedClaudeSource(loaded.source) });
      // Only an unpatched live binary may be both snapshotted AND patched from.
      // Any other verdict means these bytes are not pristine: drop them and
      // re-seed from an established backup below.
      if (plan.action !== 'snapshot') loaded = null;
    } else {
      plan = initial;
    }

    if (plan.action === 'error') return { ok: false, message: plan.message };
    for (const note of plan.notes) p.log.warn(note);

    if (plan.action === 'restore') {
      const verified = verifyPristineSource(plan, version);
      if (!verified.ok) return { ok: false, message: verified.message };
      p.log.info(`Binary differs from its pristine backup — building a fresh patch candidate from ${plan.backupPath}.`);
    }
    pristineSha256 = plan.pristineSha256;
    backup = plan.backupPath;

    // Seed from the established backup on the `reuse` and `restore` paths
    // (`snapshot` already inspected the live binary's own bytes), then hold EVERY
    // path to the same rule: the bytes about to be patched must carry no clodex
    // patch marker. `verifyPristineSource` above only proves the version, and a
    // patched claude reports its version perfectly well.
    //
    // Nothing has been written to the backup directory yet, deliberately. A
    // poisoned backup must not be laundered into a content-addressed name (which
    // later runs then trust without a probe), and must not clobber the tweakcc
    // mirror on its way to failing.
    if (!loaded) {
      loaded = await seedCandidate(backup);
      if (isPatchedClaudeSource(loaded.source)) {
        return { ok: false, message: describePoisonedPristineSource(backup, version) };
      }
    } else if (plan.action === 'snapshot') {
      // Bootstrap, from the candidate rather than re-reading the live binary:
      // these are the exact bytes just inspected and found unpatched, and
      // `writeContent` has not run yet. Sourcing the backup from them makes
      // name/content/inspected-bytes agreement structural instead of incidental.
      // Written unconditionally: this branch is only reached when no VALID backup
      // holds these bytes, so an existing file at this content address is a
      // corrupt one being replaced by the bytes its name asserts.
      publishBackupFile(candidatePath, plan.backupPath);
    }

    // Adopt a legacy `claude-<ver>.orig` under its content address so later runs
    // can self-validate it instead of re-running the version probe. The original
    // file is left alone — `tweakcc --restore` and older clodex still find it.
    //
    // Whether the canonical name already holds the right bytes is decided from
    // CONTENT, not existence: `facts.backups` carries the hash the scan already
    // computed, and anything at that name the scan rejected (truncated, foreign)
    // is absent from it and gets replaced rather than adopted and published.
    const canonical = contentAddressedBackupPath(version, pristineSha256);
    if (canonical !== backup) {
      const alreadyStored = facts.backups.some(
        candidate => candidate.path === canonical && candidate.sha256 === pristineSha256,
      );
      if (!alreadyStored) publishBackupFile(backup, canonical);
      backup = canonical;
    }

    // Mirror the pristine copy to tweakcc's restore location (always from the
    // backup, never the live binary — so it stays pristine after patching).
    publishBackupFile(backup, tweakccMirrorBackupPath());

    const builtIn = applyClodexPatches(loaded.source, desired.config);
    results = builtIn.results;
    const failedEffortPatches = requiredEffortPatchFailures(results);
    if (failedEffortPatches.length > 0) {
      throw new PatchApplyError(
        `clodex patch: required effort patches failed: ${
          failedEffortPatches.map(result => result.name).join('; ')
        }`,
        results,
      );
    }
    let builtInProofs: BuiltInPatchProof[] = [];
    let local: { content: string; results: PatchSiteResult[] } | undefined;
    if (opts.localPatches?.enabled && typeof opts.localPatches.source === 'string') {
      try {
        builtInProofs = captureBuiltInPatchProofs(
          builtIn.content,
          desired.config,
          builtIn.results,
        );
      } catch {
        local = {
          content: builtIn.content,
          results: [{
            status: 'FAIL',
            name: 'LOCAL PATCH SET',
            extra: 'could not capture built-in postconditions',
          }],
        };
      }
    }
    local ??= opts.localPatches
      ? await applyLocalPatches(builtIn.content, opts.localPatches)
      : { content: builtIn.content, results: [] };
    if (
      local.results.some(result => result.status === 'OK')
      && builtInPatchVerificationFailed(
        local.content,
        desired.config,
        builtIn.results,
        builtInProofs,
      )
    ) {
      local = discardLocalPatchOutcome(builtIn.content, local.results);
    }
    results = [...results, ...local.results];
    await writeContent(loaded.installation, local.content);
    patchedSize = statSync(candidatePath).size;
    patchedSha256 = sha256File(candidatePath);
    renameSync(candidatePath, binaryPath);
  } catch (err) {
    const detailLines = err instanceof PatchApplyError ? summarizePatchResults(err.results) : [];
    if (opts.trace && detailLines.length) {
      process.stderr.write(`${detailLines.join('\n')}\n`);
    }
    return {
      ok: false,
      message: `Patch failed: ${err instanceof Error ? err.message : String(err)}`,
      detailLines,
    };
  } finally {
    if (candidateDir !== undefined) {
      try {
        rmSync(candidateDir, { recursive: true, force: true });
      } catch (err) {
        if (opts.trace) {
          process.stderr.write(
            `clodex patch: could not remove temporary candidate directory: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
      }
    }
  }
  if (opts.trace) {
    process.stderr.write(`${summarizePatchResults(results).join('\n')}\n`);
  }

  const manifest: PatchManifest = {
    binaryPath,
    claudeVersion: version,
    configHash,
    patchedSize,
    patchedSha256,
    backupPath: backup,
    pristineSha256,
    patchedAt: new Date().toISOString(),
  };
  writePatchManifest(manifest);

  const modelCount = Object.keys(desired.config).length;
  const aliasCount = Object.values(desired.config).filter(entry => entry.alias).length;
  const windowCount = Object.values(desired.config).filter(entry => entry.context).length;
  return {
    ok: true,
    message: `Patched claude ${version}: ${modelCount} model${modelCount === 1 ? '' : 's'}, `
      + `${aliasCount} alias${aliasCount === 1 ? '' : 'es'}, ${windowCount} context window${windowCount === 1 ? '' : 's'}.`,
    detailLines: summarizePatchResults(results),
  };
}

/**
 * `clodex patch --restore` — put the pristine bytes back over the live binary.
 *
 * A pristine backup exists PRECISELY for the case where the install is broken, so
 * recovery must not require the broken binary to run. When `--version` cannot be
 * probed, the version comes from the manifest instead — it recorded
 * `claudeVersion`, `backupPath` and `pristineSha256` when the binary was patched,
 * which establishes provenance without executing anything. The patch path keeps
 * the hard failure: patching an unidentifiable binary is elective, restoring one
 * is the user's way out.
 */
function runRestoreCommand(target: ClaudePatchTarget): number {
  if (!target.ok && target.reason === 'binary-not-found') {
    p.log.error(describePatchTargetFailure(target));
    return 1;
  }
  const binaryPath = target.binaryPath;
  const manifest = readPatchManifest();

  let version: string;
  if (target.ok) {
    version = target.version;
  } else if (manifest?.binaryPath === binaryPath && manifest.claudeVersion) {
    version = manifest.claudeVersion;
    p.log.warn(
      `Could not read the version of ${binaryPath} (\`claude --version\` failed) — using claude `
      + `${version} from the patch manifest, which recorded it when this binary was patched. `
      + 'This is expected when a bad patch left the install unable to run.',
    );
  } else {
    p.log.error(
      `Could not determine the version of ${binaryPath} (\`claude --version\` failed), and `
      + 'no patch manifest records a pristine backup for it, so clodex cannot tell which backup '
      + `belongs to this install. Restore it by hand from ${backupDir()} (or reinstall Claude Code).`,
    );
    return 1;
  }

  // Unlike the patch path, this copies straight over the live binary — there is
  // nothing to publish atomically — so it carries the full provenance check.
  const plan = planRestoreOnly(collectPristineFacts({ version, binaryPath, manifest }));
  if (plan.action === 'error') {
    p.log.error(plan.message);
    return 1;
  }
  for (const note of plan.notes) p.log.warn(note);
  const verified = verifyPristineSource(plan, version);
  if (!verified.ok) {
    p.log.error(verified.message);
    return 1;
  }
  copyFileSync(plan.backupPath, binaryPath);
  try {
    unlinkSync(getPatchManifestPath());
  } catch {
    // no manifest to remove
  }
  p.log.success(`Restored pristine claude ${version} from ${plan.backupPath}.`);
  return 0;
}

export async function runPatchCommand(opts: {
  restore?: boolean;
  trace?: boolean;
  localPatches?: boolean;
} = {}): Promise<number> {
  const target = resolveClaudeBinaryForPatch();

  // Handled BEFORE the patch path's version check, because `--restore` has its
  // own rules: it must still work on a binary that no longer runs.
  if (opts.restore) return runRestoreCommand(target);

  if (!target.ok) {
    p.log.error(describePatchTargetFailure(target));
    return 1;
  }
  const { binaryPath, version } = target;

  if (opts.localPatches !== undefined) {
    savePreferences({ localPatchesEnabled: opts.localPatches });
  }

  const desired = buildDesiredPatchConfig();
  if (Object.keys(desired.config).length === 0) {
    p.log.error('No favorite models to patch. Save favorites with `clodex models` first.');
    return 1;
  }
  for (const id of desired.unknownWindows) {
    p.log.warn(`No context window metadata for ${id} — Claude Code will assume the 200k default.`);
  }
  reportRejectedModelAliases(desired.rejectedAliasRejections);

  const localPatches = inspectLocalPatchSource(
    loadPreferences().localPatchesEnabled === true,
  );
  const configHash = computePatchConfigHash(
    desired.config,
    PATCH_TRANSFORMS_VERSION,
    localPatches.enabled ? localPatches.configIdentity : undefined,
  );
  const manifest = readPatchManifest();
  const state = evaluatePatchState(manifest, {
    binaryPath,
    claudeVersion: version,
    configHash,
    binarySize: statSync(binaryPath).size,
  });

  if (state === 'current') {
    p.log.success(`claude ${version} is already patched with the current model config — nothing to do.`);
    return 0;
  }

  const release = tryAcquirePatchLock();
  if (!release) {
    p.log.warn('Another clodex process is patching the claude binary right now — skipped.');
    return 1;
  }

  try {
    // Never patch on top of a patch: applyPatch decides from the pristine
    // backups for THIS version (and the manifest) whether the live binary is
    // already patched, and seeds the candidate from established pristine bytes
    // rather than from the live binary whenever it is not.
    const outcome = await applyPatch(binaryPath, version, desired, configHash, {
      trace: opts.trace ?? false,
      manifest,
      localPatches,
    });
    if (!outcome.ok) {
      p.log.error(outcome.message);
      for (const line of outcome.detailLines ?? []) p.log.info(pc.dim(line));
      return 1;
    }
    p.log.success(outcome.message);
    if (!opts.trace) {
      for (const line of outcome.detailLines ?? []) p.log.info(pc.dim(line));
    }
    return 0;
  } finally {
    release();
  }
}

// ── Launch-time check ───────────────────────────────────────────────────────

/**
 * Cheap patch-state probe for `clodex claude`:
 *  - TTY: offer to patch (y/N); declining continues the launch.
 *  - non-TTY (or agent stdout mode): one-line notice, never prompt, never block.
 *  - concurrent launches: the lock loser prints a notice and continues.
 */
export async function runLaunchPatchCheck(opts: { agentStdout?: boolean; dryRun?: boolean } = {}): Promise<void> {
  try {
    const desired = buildDesiredPatchConfig();
    if (Object.keys(desired.config).length === 0) return; // nothing to patch

    const target = resolveClaudeBinaryForPatch();
    if (!target.ok) {
      // A patch check must never break a launch. "Not found" is silent (the user
      // may not use the patcher at all); an unreadable version is a real problem
      // worth one dim line, since it also blocks `clodex patch`.
      if (target.reason === 'version-unknown' && !opts.agentStdout) {
        console.error(pc.dim(`clodex: ${describePatchTargetFailure(target)}`));
      }
      return;
    }
    const resolved = target;

    const localPatches = inspectLocalPatchSource(
      loadPreferences().localPatchesEnabled === true,
    );
    const configHash = computePatchConfigHash(
      desired.config,
      PATCH_TRANSFORMS_VERSION,
      localPatches.enabled ? localPatches.configIdentity : undefined,
    );
    const manifest = readPatchManifest();
    const state = evaluatePatchState(manifest, {
      binaryPath: resolved.binaryPath,
      claudeVersion: resolved.version,
      configHash,
      binarySize: statSync(resolved.binaryPath).size,
    });
    if (state === 'current') return;

    const interactive = !opts.dryRun && !opts.agentStdout
      && process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) {
      if (!opts.agentStdout) {
        console.error(pc.dim(`clodex: claude binary is ${state === 'unpatched' ? 'not patched' : 'stale-patched'} for your favorites — run \`clodex patch\`.`));
      }
      return;
    }

    const answer = await p.confirm({
      message: state === 'unpatched'
        ? 'Claude Code is not patched for your clodex favorites. Patch now?'
        : 'The Claude Code patch is stale (config or claude version changed). Re-patch now?',
      initialValue: false,
    });
    if (p.isCancel(answer) || answer !== true) return;

    await runPatchCommand({});
  } catch (err) {
    // The patch check must never block a launch.
    console.error(pc.dim(`clodex: patch check skipped (${err instanceof Error ? err.message : String(err)})`));
  }
}
