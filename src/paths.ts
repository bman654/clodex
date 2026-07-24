import { homedir } from 'node:os';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

export const APP_DIR_NAME = 'clodex';
/** One-time silent migration source: the relay-ai config home. */
export const LEGACY_APP_DIR_NAME = 'relay-ai';

interface HomeEnv {
  HOME?: string;
  CLODEX_HOME?: string;
  USERPROFILE?: string;
}

function userHome(env: HomeEnv = process.env): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

export function resolveAppHomeOverride(env: HomeEnv = process.env): string | undefined {
  const override = env.CLODEX_HOME;
  return override?.trim() || undefined;
}

export function getAppHome(env: HomeEnv = process.env): string {
  const override = resolveAppHomeOverride(env);
  if (override) return override;
  return join(userHome(env), `.${APP_DIR_NAME}`);
}

export function getLegacyAppHome(env: HomeEnv = process.env): string {
  return join(userHome(env), `.${LEGACY_APP_DIR_NAME}`);
}

let legacyMigrationDone = false;

/**
 * One-time silent migration: when the clodex home does not exist yet but a
 * legacy ~/.relay-ai does, copy its config + auth state over so existing
 * providers and OAuth credentials keep working. The legacy directory itself is
 * never modified or deleted.
 */
export function ensureLegacyAppHomeMigrated(env: HomeEnv = process.env): void {
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;
  try {
    const appHome = getAppHome(env);
    if (existsSync(appHome)) return;
    const legacyHome = getLegacyAppHome(env);
    if (!existsSync(legacyHome)) return;

    mkdirSync(appHome, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(legacyHome)) {
      if (entry === 'logs') continue; // session logs are not config/auth state
      cpSync(join(legacyHome, entry), join(appHome, entry), { recursive: true });
    }
  } catch {
    // Migration is best-effort; a fresh home still works.
  }
}

/** Test hook: allow the migration to run again against a new CLODEX_HOME. */
export function resetLegacyMigrationForTests(): void {
  legacyMigrationDone = false;
}

export function getConfigPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'config.json');
}

export function getProvidersPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'providers.json');
}

export function getCredentialCleanupPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'credential-cleanup.json');
}

export function getLogsPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'logs');
}
