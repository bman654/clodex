// Ambient types for tweakcc's programmatic API (dist/lib/index.mjs).
//
// tweakcc 4.3.0 declares `"types": "./dist/lib/index.d.ts"` but does not ship
// that file in the npm tarball, so we declare the (verified) surface we use.
// Signatures confirmed against the installed dist/lib source: an Installation
// is `{ path, version, kind }`; `readContent` extracts the bundled JS from a
// native binary (or reads cli.js for npm installs) and `writeContent` repacks
// it. Re-verify this surface when bumping the pinned tweakcc version.
declare module 'tweakcc' {
  export interface Installation {
    /** Resolved path to the cli.js file or native binary. */
    path: string;
    /** Claude Code version extracted from the installation. */
    version: string;
    kind: 'npm' | 'native';
  }

  /**
   * Detect a Claude Code installation. With `path`, detects that file's kind
   * (cli.js vs native binary) and version directly — no config/env lookup.
   */
  export function tryDetectInstallation(options?: {
    path?: string;
    interactive?: boolean;
  }): Promise<Installation>;

  /** All Claude Code installations found via tweakcc's search paths. */
  export function findAllInstallations(): Promise<Installation[]>;

  /** Extract the bundled Claude Code JS source as a UTF-8 string. */
  export function readContent(installation: Installation): Promise<string>;

  /** Write (repack for native installs) the JS source back into the installation. */
  export function writeContent(installation: Installation, content: string): Promise<void>;

  /** Copy `src` to `dst`, creating parent directories. */
  export function backupFile(src: string, dst: string): Promise<void>;

  /** Restore a backup file over `target` (throws when the backup is missing). */
  export function restoreBackup(backup: string, target: string): Promise<void>;
}
