import { accessSync, constants as fsConstants, statSync, type Stats } from 'node:fs';
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

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface WrapperTargetFileOps {
  stat(path: string): Stats;
  requireExecutable(path: string): void;
  sha256(path: string): string;
}

const defaultFileOps: WrapperTargetFileOps = {
  stat: statSync,
  requireExecutable(path) {
    if (process.platform !== 'win32') accessSync(path, fsConstants.X_OK);
  },
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
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
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
  const fileOps = options.fileOps ?? defaultFileOps;
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
  if (candidateIdentity.size !== manifest.patchedSize) {
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
