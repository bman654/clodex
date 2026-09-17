import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  finalizeWrapperTarget,
  prepareWrapperTarget,
  type WrapperTargetDecision,
} from '../src/wrapper-target.js';
import { readPatchManifest } from '../src/patch-manifest.js';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

let root: string;
let handedIn: string;
let patched: string;
let manifestPath: string;

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binaryPath: patched,
    claudeVersion: '2.1.273',
    configHash: 'current-config',
    patchedSize: statSync(patched).size,
    patchedSha256: digest(patched),
    backupPath: join(root, 'pristine.orig'),
    pristineSha256: digest(handedIn),
    patchedAt: '2026-09-16T12:00:00.000Z',
    ...overrides,
  };
}

function writeManifest(overrides: Record<string, unknown> = {}): void {
  writeFileSync(manifestPath, `${JSON.stringify(manifest(overrides))}\n`);
}

function decide(): WrapperTargetDecision {
  return finalizeWrapperTarget(prepareWrapperTarget(handedIn, { manifestPath }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clodex-wrapper-target-'));
  handedIn = join(root, 'extension-claude');
  patched = join(root, 'installed-claude');
  manifestPath = join(root, 'patch-state.json');
  writeExecutable(handedIn, 'known-pristine-build');
  writeExecutable(patched, 'known-patched-output');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('VS Code wrapper target selection', () => {
  it('selects only the patched output recorded for the handed-in pristine bytes', () => {
    writeManifest();

    expect(decide()).toEqual({
      path: patched,
      reason: 'verified-patched-install',
    });
  });

  it('hashes complete files across chunk boundaries before selecting', () => {
    writeFileSync(handedIn, Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from('tail-a')]), {
      mode: 0o755,
    });
    writeFileSync(patched, Buffer.concat([Buffer.alloc(1024 * 1024, 0x62), Buffer.from('tail-b')]), {
      mode: 0o755,
    });
    writeManifest();

    expect(decide()).toEqual({
      path: patched,
      reason: 'verified-patched-install',
    });
  });

  it('keeps a handed-in binary that is already the recorded patched output', () => {
    writeExecutable(handedIn, readFileSync(patched, 'utf8'));
    writeManifest({ pristineSha256: '0'.repeat(64) });

    expect(decide()).toEqual({
      path: handedIn,
      reason: 'handed-in-already-patched',
    });
  });

  it('keeps the handed-in path when it is the manifest target or the same file', () => {
    writeManifest({
      binaryPath: handedIn,
      patchedSize: statSync(handedIn).size,
      patchedSha256: digest(handedIn),
    });
    expect(decide()).toEqual({
      path: handedIn,
      reason: 'manifest-target-is-handed-in',
    });

    const alias = join(root, 'installed-alias');
    linkSync(handedIn, alias);
    manifestPath = join(root, 'same-file-manifest.json');
    patched = alias;
    writeManifest();
    expect(decide()).toEqual({
      path: handedIn,
      reason: 'manifest-target-is-handed-in',
    });
  });

  it('refuses a same-size handed-in artifact whose full pristine hash differs', () => {
    writeManifest();
    writeExecutable(handedIn, 'different-pristine!!');
    expect(statSync(handedIn).size).toBe('known-pristine-build'.length);

    const decision = decide();

    expect(decision).toMatchObject({
      path: handedIn,
      reason: 'handed-in-not-recorded-pristine',
    });
    expect(decision.notice).toContain('running');
    expect(decision.notice).toContain('bytes do not match the pristine source');
  });

  it('refuses a same-size candidate whose full patched hash differs', () => {
    const expected = manifest();
    writeExecutable(patched, 'altered-patched-data');
    expect(statSync(patched).size).toBe(Number(expected.patchedSize));
    writeManifest(expected);

    expect(decide()).toMatchObject({
      path: handedIn,
      reason: 'patched-install-verification-failed',
    });
  });

  it.each([
    ['missing', undefined, 'manifest-missing', false],
    ['malformed', '{not json', 'manifest-invalid', false],
    [
      'partial with a target hint',
      JSON.stringify({
        binaryPath: '__PATCHED__',
        claudeVersion: '2.1.273',
        configHash: 'legacy-config',
      }),
      'manifest-invalid',
      true,
    ],
  ] as const)(
    'keeps the handed-in binary for a %s manifest',
    (_label, serialized, reason, hasNotice) => {
      if (serialized !== undefined) {
        writeFileSync(manifestPath, serialized.replace('__PATCHED__', patched));
      }

      const decision = decide();

      expect(decision).toMatchObject({ path: handedIn, reason });
      expect(Boolean(decision.notice)).toBe(hasNotice);
    },
  );

  it('keeps unreadable manifest state silent when it identifies no other install', () => {
    rmSync(manifestPath, { force: true });
    // A directory deterministically makes the read fail on every supported host.
    mkdirSync(manifestPath);

    expect(decide()).toEqual({ path: handedIn, reason: 'manifest-invalid' });
  });

  it('rejects a genuine legacy manifest for substitution while the patcher still reads it', () => {
    const legacy = manifest();
    delete legacy.pristineSha256;
    writeFileSync(manifestPath, `${JSON.stringify(legacy)}\n`);

    const decision = decide();

    expect(decision).toMatchObject({ path: handedIn, reason: 'manifest-invalid' });
    expect(decision.notice).toContain('does not contain every fingerprint');
    expect(readPatchManifest(manifestPath)?.binaryPath).toBe(patched);
  });

  it('accepts assumed pristine provenance but rejects unknown provenance values', () => {
    writeManifest({ pristineProvenance: 'assumed' });
    expect(decide()).toEqual({ path: patched, reason: 'verified-patched-install' });

    writeManifest({ pristineProvenance: 'unknown' });
    expect(decide()).toMatchObject({ path: handedIn, reason: 'manifest-invalid' });
  });

  it.each([
    ['malformed patchedSha256', { patchedSha256: 'NOT-A-SHA256' }],
    ['missing patchedSha256', { patchedSha256: undefined }],
  ])('strictly rejects %s', (_label, overrides) => {
    writeManifest(overrides);

    const decision = decide();

    expect(decision).toMatchObject({ path: handedIn, reason: 'manifest-invalid' });
    expect(decision.notice).toContain('does not contain every fingerprint');
    expect(decision.notice).toContain(JSON.stringify(manifestPath));
  });

  it.each([
    ['missing', () => rmSync(patched), 'patched-install-unavailable'],
    ['not executable', () => chmodSync(patched, 0o644), 'patched-install-unavailable'],
    ['changed size', () => writeExecutable(patched, 'larger-patched-output!'), 'patched-install-size-changed'],
  ] as const)('keeps the handed-in binary when the patched install is %s', (_label, alter, reason) => {
    writeManifest();
    alter();

    const decision = decide();

    expect(decision).toMatchObject({ path: handedIn, reason });
    expect(decision.notice).toContain(JSON.stringify(handedIn));
    expect(decision.notice).toContain(JSON.stringify(patched));
  });

  it('keeps the handed-in binary when a full hash read is denied', () => {
    writeManifest();
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });

    const prepared = prepareWrapperTarget(handedIn, {
      manifestPath,
      fileOps: {
        stat: statSync,
        requireExecutable(path) {
          if (process.platform !== 'win32') accessSync(path, fsConstants.X_OK);
        },
        sha256(path) {
          if (path === patched) throw denied;
          return digest(path);
        },
      },
    });
    const decision = finalizeWrapperTarget(prepared);

    expect(decision).toMatchObject({
      path: handedIn,
      reason: 'patched-install-verification-failed',
    });
  });

  it('keeps the handed-in binary when its full hash cannot be read', () => {
    writeManifest();
    const prepared = prepareWrapperTarget(handedIn, {
      manifestPath,
      fileOps: {
        stat: statSync,
        requireExecutable(path) {
          if (process.platform !== 'win32') accessSync(path, fsConstants.X_OK);
        },
        sha256(path) {
          if (path === handedIn) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return digest(path);
        },
      },
    });

    const decision = finalizeWrapperTarget(prepared);
    expect(decision).toMatchObject({ path: handedIn, reason: 'handed-in-inspection-failed' });
    expect(decision.notice).toContain('could not be hashed');
  });

  it('declines substitution when the handed-in file changes during its hash', () => {
    writeManifest();
    const prepared = prepareWrapperTarget(handedIn, {
      manifestPath,
      fileOps: {
        stat: statSync,
        requireExecutable(path) {
          if (process.platform !== 'win32') accessSync(path, fsConstants.X_OK);
        },
        sha256(path) {
          const result = digest(path);
          if (path === handedIn) {
            const replacement = `${path}.during-hash`;
            writeFileSync(replacement, readFileSync(path), { mode: 0o755 });
            renameSync(replacement, path);
          }
          return result;
        },
      },
    });

    expect(finalizeWrapperTarget(prepared)).toMatchObject({
      path: handedIn,
      reason: 'input-changed-before-handoff',
    });
  });

  it('declines substitution when the candidate changes during its handoff hash', () => {
    writeManifest();
    const prepared = prepareWrapperTarget(handedIn, {
      manifestPath,
      fileOps: {
        stat: statSync,
        requireExecutable(path) {
          if (process.platform !== 'win32') accessSync(path, fsConstants.X_OK);
        },
        sha256(path) {
          const result = digest(path);
          if (path === patched) {
            const replacement = `${path}.during-hash`;
            writeFileSync(replacement, readFileSync(path), { mode: 0o755 });
            renameSync(replacement, path);
          }
          return result;
        },
      },
    });

    expect(finalizeWrapperTarget(prepared)).toMatchObject({
      path: handedIn,
      reason: 'input-changed-before-handoff',
    });
  });

  it('declines an in-place same-size handed-in change before handoff', () => {
    writeManifest();
    const prepared = prepareWrapperTarget(handedIn, { manifestPath });
    expect(prepared.kind).toBe('candidate');

    writeFileSync(handedIn, 'known-PRISTINE-build', { mode: 0o755 });
    expect(statSync(handedIn).size).toBe('known-pristine-build'.length);
    const past = new Date('2020-01-02T03:04:05.000Z');
    utimesSync(handedIn, past, past);

    expect(finalizeWrapperTarget(prepared)).toMatchObject({
      path: handedIn,
      reason: 'input-changed-before-handoff',
    });
  });

  it.each(['handed-in', 'candidate'] as const)(
    'declines substitution when the %s identity changes before handoff',
    (changed) => {
      writeManifest();
      const prepared = prepareWrapperTarget(handedIn, { manifestPath });
      expect(prepared.kind).toBe('candidate');

      const path = changed === 'handed-in' ? handedIn : patched;
      const replacement = `${path}.replacement`;
      const oldContents = readFileSync(path);
      writeFileSync(replacement, oldContents, { mode: 0o755 });
      renameSync(replacement, path);

      expect(finalizeWrapperTarget(prepared)).toMatchObject({
        path: handedIn,
        reason: 'input-changed-before-handoff',
      });
    },
  );
});
