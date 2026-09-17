import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome } from './paths.js';

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
   * backups landed; absent in manifests from older installs, so legacy readers
   * must treat it as optional.
   */
  pristineSha256?: string;
  /**
   * `assumed` when this run tied `backupPath` to `binaryPath` by the claude version
   * in a file name alone, rather than by a record or an earlier manifest.
   * Absent means established; preserving the distinction prevents a later run
   * from promoting a guess into independent proof (issue #204).
   */
  pristineProvenance?: 'assumed';
  patchedAt: string;
}

/** The complete manifest shape required before the wrapper may execute another file. */
export type WrapperPatchManifest = PatchManifest & { pristineSha256: string };

export function getPatchManifestPath(): string {
  return join(getAppHome(), 'patch-state.json');
}

/**
 * Legacy-tolerant reader used by patch and restore. Its intentionally narrow
 * validation is unchanged: old and partial manifests remain available to their
 * existing recovery rules.
 */
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

export type WrapperPatchManifestRead =
  | { status: 'missing'; path: string }
  | {
      status: 'invalid';
      path: string;
      /** A usable target hint lets the wrapper explain a legacy/incomplete state. */
      binaryPath?: string;
      claudeVersion?: string;
    }
  | { status: 'valid'; path: string; manifest: WrapperPatchManifest };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Strict, read-only manifest view for executable substitution. Unlike restore,
 * the wrapper has no compatibility reason to act on incomplete testimony.
 */
export function readWrapperPatchManifest(
  path = getPatchManifestPath(),
): WrapperPatchManifestRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing', path }
      : { status: 'invalid', path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', path };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'invalid', path };
  }

  const value = parsed as Record<string, unknown>;
  const hint = {
    ...(typeof value.binaryPath === 'string' && value.binaryPath.trim()
      ? { binaryPath: value.binaryPath }
      : {}),
    ...(typeof value.claudeVersion === 'string' && value.claudeVersion.trim()
      ? { claudeVersion: value.claudeVersion }
      : {}),
  };
  const valid = typeof value.binaryPath === 'string'
    && value.binaryPath.trim().length > 0
    && typeof value.claudeVersion === 'string'
    && value.claudeVersion.trim().length > 0
    && typeof value.configHash === 'string'
    && value.configHash.trim().length > 0
    && typeof value.patchedSize === 'number'
    && Number.isSafeInteger(value.patchedSize)
    && value.patchedSize >= 0
    && typeof value.patchedSha256 === 'string'
    && SHA256_HEX.test(value.patchedSha256)
    && typeof value.backupPath === 'string'
    && value.backupPath.trim().length > 0
    && typeof value.pristineSha256 === 'string'
    && SHA256_HEX.test(value.pristineSha256)
    && typeof value.patchedAt === 'string'
    && value.patchedAt.trim().length > 0
    && (value.pristineProvenance === undefined || value.pristineProvenance === 'assumed');

  if (!valid) return { status: 'invalid', path, ...hint };
  return { status: 'valid', path, manifest: value as unknown as WrapperPatchManifest };
}
