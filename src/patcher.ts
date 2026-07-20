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
//  - re-patch: stale config/version → restore the pristine backup, patch fresh,
//  - a pristine per-version backup (~/.tweakcc/claude-<ver>.orig) compatible
//    with `tweakcc --restore`,
//  - a pid lock (~/.clodex/patch.lock) so concurrent launches cannot race.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { getAppHome } from './paths.js';
import { loadPreferences } from './config.js';
import { loadRegistry } from './registry/io.js';
import { findClaudeBinary, getInstalledClaudeVersion } from './launch.js';
import { httpProxyDisplayName, httpProxyModelId } from './http-proxy/routes.js';
import { stripOneMContextSuffix } from './context-model-id.js';
import {
  applyClodexPatches,
  formatPatchSiteLine,
  PatchApplyError,
  type PatchSiteResult,
  type PatchScriptModelConfig,
} from './patch-transforms.js';

// ── Manifest ────────────────────────────────────────────────────────────────

export interface PatchManifest {
  /** Resolved (real) path of the patched claude binary. */
  binaryPath: string;
  /** `claude --version` at patch time. */
  claudeVersion: string;
  /** sha256 of the desired patch model config (canonical JSON). */
  configHash: string;
  /** Size in bytes of the binary after patching (cheap staleness probe). */
  patchedSize: number;
  /** sha256 of the binary after patching. */
  patchedSha256: string;
  /** Pristine backup used for restore. */
  backupPath: string;
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
}

/** Model metadata the patch bakes in, resolved from the registry models cache. */
export interface PatchModelMeta {
  contextWindow?: number;
  /** Canonical label, e.g. `GPT-5.6 Sol (OpenAI (ChatGPT))`. */
  displayName?: string;
}

/**
 * Build the patch model config from favorites + aliases.
 * Keys are the bare `clodex:<provider>:<model>` ids (no [1m] suffix — the
 * context patch and the suffix are mutually exclusive). When an entry has an
 * alias, that alias becomes the model's identity inside the patched binary.
 */
export function buildPatchModelConfig(
  favorites: Array<{ providerId: string; modelId: string }>,
  aliases: Array<{ name: string; providerId: string; modelId: string }>,
  modelMetaFor: (providerId: string, modelId: string) => PatchModelMeta | undefined,
): DesiredPatchConfig {
  const config: PatchScriptModelConfig = {};
  const unknownWindows: string[] = [];
  const aliasByFavorite = new Map(aliases.map(a => [`${a.providerId}:${a.modelId}`, a.name]));

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
    config[id] = entry;
  }
  return { config, unknownWindows };
}

/** Canonical (key-sorted) hash of a patch model config. */
export function computePatchConfigHash(config: PatchScriptModelConfig): string {
  const canonical = Object.keys(config).sort().map(key => {
    const entry = config[key]!;
    return [key, entry.alias ?? null, entry.context ?? null, entry.display ?? null];
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Read favorites + aliases + registry model metadata from disk (no network, no credentials). */
export function buildDesiredPatchConfig(): DesiredPatchConfig {
  const prefs = loadPreferences();
  const favorites = prefs.favoriteModels ?? [];
  const aliases = prefs.modelAliases ?? [];
  const registry = loadRegistry();

  const meta = new Map<string, PatchModelMeta>();
  for (const provider of registry.providers) {
    for (const model of provider.modelsCache?.models ?? []) {
      meta.set(`${provider.id}:${model.id}`, {
        contextWindow: model.contextWindow && model.contextWindow > 0 ? model.contextWindow : undefined,
        // Same label `clodex server` prints at startup and `models --list` shows.
        displayName: httpProxyDisplayName(model, provider.name),
      });
    }
  }

  return buildPatchModelConfig(
    favorites,
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

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Locate the REAL native binary, bypassing wrapper shims (e.g. cmux) that a
 * plain PATH lookup can return. Order (ported from the relay-ai wrapper):
 * TWEAKCC_CC_INSTALLATION_PATH → ~/.local/bin/claude (stable native-install
 * symlink) → findClaudeBinary() PATH lookup.
 */
export function resolveClaudeBinaryForPatch(): { binaryPath: string; version: string } | null {
  const envOverride = process.env['TWEAKCC_CC_INSTALLATION_PATH'];
  const nativeSymlink = join(homedir(), '.local', 'bin', 'claude');
  const source = envOverride?.trim()
    || (existsSync(nativeSymlink) ? nativeSymlink : null)
    || findClaudeBinary();
  if (!source) return null;
  let resolved: string;
  try {
    resolved = realpathSync(source);
  } catch {
    return null;
  }
  try {
    if (!statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return { binaryPath: resolved, version: getInstalledClaudeVersion() };
}

function backupDir(): string {
  return process.env['TWEAKCC_CONFIG_DIR']?.trim() || join(homedir(), '.tweakcc');
}

function pristineBackupPath(version: string, binaryPath: string): string {
  const tag = version.replace(/[^\w.-]+/g, '_') || basename(binaryPath);
  return join(backupDir(), `claude-${tag}.orig`);
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

interface ApplyOutcome {
  ok: boolean;
  message: string;
  detailLines?: string[];
}

async function applyPatch(
  binaryPath: string,
  version: string,
  desired: DesiredPatchConfig,
  configHash: string,
  opts: { trace: boolean; restoreFirst: boolean },
): Promise<ApplyOutcome> {
  const backup = pristineBackupPath(version, binaryPath);
  mkdirSync(backupDir(), { recursive: true });

  if (opts.restoreFirst) {
    if (!existsSync(backup)) {
      return { ok: false, message: `Cannot re-patch: pristine backup missing at ${backup}. Reinstall claude, then run clodex patch.` };
    }
    copyFileSync(backup, binaryPath);
  } else if (!existsSync(backup)) {
    copyFileSync(binaryPath, backup);
  }
  // Mirror the pristine copy to tweakcc's restore location (always from the
  // backup, never the live binary — so it stays pristine even after patching).
  copyFileSync(backup, join(backupDir(), 'native-binary.backup'));

  // tweakcc's lib entry pulls in its interactive-picker deps (ink/react), so
  // load it lazily — only when a patch is actually applied.
  const { tryDetectInstallation, readContent, writeContent } = await import('tweakcc');

  let results: PatchSiteResult[];
  try {
    const installation = await tryDetectInstallation({ path: binaryPath });
    const source = await readContent(installation);
    const patched = applyClodexPatches(source, desired.config);
    results = patched.results;
    await writeContent(installation, patched.content);
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
  }
  if (opts.trace) {
    process.stderr.write(`${summarizePatchResults(results).join('\n')}\n`);
  }

  const manifest: PatchManifest = {
    binaryPath,
    claudeVersion: version,
    configHash,
    patchedSize: statSync(binaryPath).size,
    patchedSha256: sha256File(binaryPath),
    backupPath: backup,
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

export async function runPatchCommand(opts: { restore?: boolean; trace?: boolean } = {}): Promise<number> {
  const resolved = resolveClaudeBinaryForPatch();
  if (!resolved) {
    p.log.error('claude binary not found. Install Claude Code or set TWEAKCC_CC_INSTALLATION_PATH.');
    return 1;
  }
  const { binaryPath, version } = resolved;

  if (opts.restore) {
    const manifest = readPatchManifest();
    const backup = manifest?.backupPath && existsSync(manifest.backupPath)
      ? manifest.backupPath
      : pristineBackupPath(version, binaryPath);
    if (!existsSync(backup)) {
      p.log.error(`No pristine backup found for claude ${version} (${backup}).`);
      return 1;
    }
    copyFileSync(backup, binaryPath);
    try {
      unlinkSync(getPatchManifestPath());
    } catch {
      // no manifest to remove
    }
    p.log.success(`Restored pristine claude ${version} from ${backup}.`);
    return 0;
  }

  const desired = buildDesiredPatchConfig();
  if (Object.keys(desired.config).length === 0) {
    p.log.error('No favorite models to patch. Save favorites with `clodex models` first.');
    return 1;
  }
  for (const id of desired.unknownWindows) {
    p.log.warn(`No context window metadata for ${id} — Claude Code will assume the 200k default.`);
  }

  const configHash = computePatchConfigHash(desired.config);
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
    // Never patch on top of a patch: whenever a pristine backup exists for this
    // version and the live binary differs from it (stale clodex patch, an old
    // relay-ai patch, or a lost manifest), restore the backup before patching.
    const backup = pristineBackupPath(version, binaryPath);
    const restoreFirst = existsSync(backup) && sha256File(backup) !== sha256File(binaryPath);
    if (restoreFirst) {
      p.log.info('Binary differs from its pristine backup — restoring it before patching fresh.');
    }
    const outcome = await applyPatch(binaryPath, version, desired, configHash, {
      trace: opts.trace ?? false,
      restoreFirst,
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

    const resolved = resolveClaudeBinaryForPatch();
    if (!resolved) return;

    const configHash = computePatchConfigHash(desired.config);
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
