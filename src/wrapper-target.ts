import { accessSync, constants as fsConstants, statSync, type BigIntStats } from 'node:fs';
import { readWrapperPatchManifest, type WrapperPatchManifest } from './patch-manifest.js';
import { sha256File } from './patch-backup.js';

export type WrapperTargetReason =
  | 'verified-patched-install'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'manifest-target-is-handed-in'
  | 'handed-in-already-patched'
  | 'handed-in-not-recorded-pristine'
  | 'handed-in-inspection-failed'
  | 'patched-install-unavailable'
  | 'patched-install-size-changed'
  | 'patched-install-verification-failed'
  | 'input-changed-before-handoff';

export interface WrapperTargetDecision {
  path: string;
  reason: WrapperTargetReason;
  notice?: string;
}

/**
 * Everything `stat` reports that a rewrite of the file can disturb, held as bigints so nothing is
 * rounded. NTFS matters here: Node reports `ino` as the 64-bit file reference number (a 16-bit
 * sequence number above a 48-bit record index), which a double cannot hold exactly once the
 * sequence number reaches 32, and `ctime` as the NTFS ChangeTime — it moves on every write and on
 * `SetFileTime`, so an in-place rewrite that restores `mtime` still shows here. Times are
 * compared at nanosecond resolution (100 ns on NTFS) rather than the rounded `*Ms` doubles.
 */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface WrapperTargetFileOps {
  stat(path: string): BigIntStats;
  requireExecutable(path: string): void;
  sha256(path: string): string;
}

const WINDOWS_EXECUTABLE = /\.exe$/i;

/**
 * What "executable" means before either file may be run. POSIX asks the kernel. Windows has no
 * execute bit — libuv's `access(X_OK)` passes for any existing file — so the rule there is the one
 * the spawn path applies: a native `.exe`, which the wrapper spawns directly. The extension's
 * bundled `claude.exe` and every patch target clodex records on Windows (npm's `bin\claude.exe`,
 * the native installer's `claude.exe`) satisfy it; a `.cmd`/`.bat` launcher, which would be run
 * through `cmd.exe` and could name any program, is refused rather than hashed.
 */
export function requireWrapperExecutable(
  path: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    if (!WINDOWS_EXECUTABLE.test(path)) throw new Error('not a Windows executable');
    return;
  }
  accessSync(path, fsConstants.X_OK);
}

export const defaultWrapperTargetFileOps: WrapperTargetFileOps = {
  stat: path => statSync(path, { bigint: true }),
  requireExecutable: path => requireWrapperExecutable(path),
  sha256: sha256File,
};

export type PreparedWrapperTarget =
  | { kind: 'decided'; decision: WrapperTargetDecision }
  | {
      kind: 'candidate';
      handedInPath: string;
      candidatePath: string;
      manifestPath: string;
      manifest: WrapperPatchManifest;
      handedInIdentity: FileIdentity;
      candidateIdentity: FileIdentity;
      fileOps: WrapperTargetFileOps;
    };

function identityOf(path: string, fileOps: WrapperTargetFileOps): FileIdentity {
  const stat = fileOps.stat(path);
  if (!stat.isFile()) throw new Error('not a file');
  fileOps.requireExecutable(path);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fallbackNotice(
  handedInPath: string,
  candidatePath: string,
  manifestPath: string,
  claudeVersion: string | undefined,
  detail: string,
): string {
  const version = claudeVersion ? ` for patched Claude ${claudeVersion}` : '';
  return `clodex-claude: running ${JSON.stringify(handedInPath)} because ${detail}${version}; `
    + `the patched install ${JSON.stringify(candidatePath)} was not selected, so clodex model-picker `
    + `entries may be absent; manifest=${JSON.stringify(manifestPath)}; align the VS Code and Claude `
    + 'Code builds, then run `clodex patch` again.';
}

function fallback(
  handedInPath: string,
  candidatePath: string,
  manifestPath: string,
  claudeVersion: string | undefined,
  reason: WrapperTargetReason,
  detail: string,
): WrapperTargetDecision {
  return {
    path: handedInPath,
    reason,
    notice: fallbackNotice(handedInPath, candidatePath, manifestPath, claudeVersion, detail),
  };
}

/**
 * Inspect the handed-in binary and the one strict patch manifest that may replace
 * it. This stage hashes only the handed-in file. The patched file's full hash is
 * deliberately deferred to `finalizeWrapperTarget`, immediately before exec.
 */
export function prepareWrapperTarget(
  handedInPath: string,
  options: {
    manifestPath?: string;
    fileOps?: WrapperTargetFileOps;
  } = {},
): PreparedWrapperTarget {
  const manifestRead = readWrapperPatchManifest(options.manifestPath);
  if (manifestRead.status === 'missing') {
    return {
      kind: 'decided',
      decision: { path: handedInPath, reason: 'manifest-missing' },
    };
  }
  if (manifestRead.status === 'invalid') {
    const candidatePath = manifestRead.binaryPath;
    if (!candidatePath || candidatePath === handedInPath || !manifestRead.claudeVersion) {
      return {
        kind: 'decided',
        decision: { path: handedInPath, reason: 'manifest-invalid' },
      };
    }
    return {
      kind: 'decided',
      decision: fallback(
        handedInPath,
        candidatePath,
        manifestRead.path,
        manifestRead.claudeVersion,
        'manifest-invalid',
        'the patch manifest does not contain every fingerprint required for safe substitution',
      ),
    };
  }

  const { manifest } = manifestRead;
  const candidatePath = manifest.binaryPath;
  const fileOps = options.fileOps ?? defaultWrapperTargetFileOps;
  let handedInIdentity: FileIdentity;
  let candidateIdentity: FileIdentity;
  try {
    handedInIdentity = identityOf(handedInPath, fileOps);
  } catch {
    return {
      kind: 'decided',
      decision: fallback(
        handedInPath,
        candidatePath,
        manifestRead.path,
        manifest.claudeVersion,
        'handed-in-inspection-failed',
        'VS Code\'s handed-in executable could not be inspected',
      ),
    };
  }
  try {
    candidateIdentity = identityOf(candidatePath, fileOps);
  } catch {
    return {
      kind: 'decided',
      decision: fallback(
        handedInPath,
        candidatePath,
        manifestRead.path,
        manifest.claudeVersion,
        'patched-install-unavailable',
        'the recorded patched executable is missing, unreadable, or not executable',
      ),
    };
  }

  if (candidatePath === handedInPath || sameFile(handedInIdentity, candidateIdentity)) {
    return {
      kind: 'decided',
      decision: { path: handedInPath, reason: 'manifest-target-is-handed-in' },
    };
  }
  if (candidateIdentity.size !== BigInt(manifest.patchedSize)) {
    return {
      kind: 'decided',
      decision: fallback(
        handedInPath,
        candidatePath,
        manifestRead.path,
        manifest.claudeVersion,
        'patched-install-size-changed',
        'the recorded patched executable has changed size since it was patched',
      ),
    };
  }

  let handedInSha256: string;
  try {
    handedInSha256 = fileOps.sha256(handedInPath);
    const afterHash = identityOf(handedInPath, fileOps);
    if (!sameIdentity(handedInIdentity, afterHash)) {
      return {
        kind: 'decided',
        decision: fallback(
          handedInPath,
          candidatePath,
          manifestRead.path,
          manifest.claudeVersion,
          'input-changed-before-handoff',
          'VS Code\'s handed-in executable changed while its identity was being checked',
        ),
      };
    }
    handedInIdentity = afterHash;
  } catch {
    return {
      kind: 'decided',
      decision: fallback(
        handedInPath,
        candidatePath,
        manifestRead.path,
        manifest.claudeVersion,
        'handed-in-inspection-failed',
        'VS Code\'s handed-in executable could not be hashed',
      ),
    };
  }

  if (handedInSha256 === manifest.patchedSha256) {
    return {
      kind: 'decided',
      decision: { path: handedInPath, reason: 'handed-in-already-patched' },
    };
  }
  if (handedInSha256 !== manifest.pristineSha256) {
    return {
      kind: 'decided',
      decision: fallback(
        handedInPath,
        candidatePath,
        manifestRead.path,
        manifest.claudeVersion,
        'handed-in-not-recorded-pristine',
        'VS Code\'s handed-in bytes do not match the pristine source recorded by clodex',
      ),
    };
  }

  return {
    kind: 'candidate',
    handedInPath,
    candidatePath,
    manifestPath: manifestRead.path,
    manifest,
    handedInIdentity,
    candidateIdentity,
    fileOps,
  };
}

/**
 * Verify the selected executable at the handoff. Both inspected path identities
 * are rechecked around the patched file's full hash so an updater race declines
 * substitution. The remaining hash-to-exec path race is inherent to execve.
 */
export function finalizeWrapperTarget(
  prepared: PreparedWrapperTarget,
): WrapperTargetDecision {
  if (prepared.kind === 'decided') return prepared.decision;

  const {
    handedInPath,
    candidatePath,
    manifestPath,
    manifest,
    handedInIdentity,
    candidateIdentity,
    fileOps,
  } = prepared;
  const changed = () => fallback(
    handedInPath,
    candidatePath,
    manifestPath,
    manifest.claudeVersion,
    'input-changed-before-handoff',
    'one of the executables changed between inspection and launch',
  );

  try {
    if (!sameIdentity(handedInIdentity, identityOf(handedInPath, fileOps))) return changed();
    if (!sameIdentity(candidateIdentity, identityOf(candidatePath, fileOps))) return changed();

    const candidateSha256 = fileOps.sha256(candidatePath);
    if (!sameIdentity(candidateIdentity, identityOf(candidatePath, fileOps))) return changed();
    if (!sameIdentity(handedInIdentity, identityOf(handedInPath, fileOps))) return changed();
    if (candidateSha256 !== manifest.patchedSha256) {
      return fallback(
        handedInPath,
        candidatePath,
        manifestPath,
        manifest.claudeVersion,
        'patched-install-verification-failed',
        'the recorded patched executable no longer has the SHA-256 clodex published',
      );
    }
  } catch {
    return fallback(
      handedInPath,
      candidatePath,
      manifestPath,
      manifest.claudeVersion,
      'patched-install-verification-failed',
      'one of the executables could not be verified at launch',
    );
  }

  return { path: candidatePath, reason: 'verified-patched-install' };
}
