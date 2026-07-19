import type { UserPreferences, FavoriteModel } from './types.js';
import { dirname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getAppHome, getConfigPath, getLegacyAppHome, getLegacyConfPath } from './paths.js';

function readJsonFile(path: string): UserPreferences | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as UserPreferences : null;
  } catch {
    return null;
  }
}

function ensureAppHomeMigrated(): void {
  const configPath = getConfigPath();
  if (existsSync(configPath)) return;

  const legacyConfig = join(getLegacyAppHome(), 'config.json');
  if (!existsSync(legacyConfig)) return;

  mkdirSync(getAppHome(), { recursive: true, mode: 0o700 });
  copyFileSync(legacyConfig, configPath);

  const legacyVertex = join(getLegacyAppHome(), 'vertex-models.json');
  const vertexPath = join(getAppHome(), 'vertex-models.json');
  if (existsSync(legacyVertex) && !existsSync(vertexPath)) {
    copyFileSync(legacyVertex, vertexPath);
  }
}

function ensureConfigMigrated(): void {
  ensureAppHomeMigrated();

  const configPath = getConfigPath();
  if (existsSync(configPath)) return;

  const legacyPath = getLegacyConfPath();
  if (!existsSync(legacyPath)) return;

  const legacy = readJsonFile(legacyPath);
  if (!legacy) return;

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  try {
    renameSync(legacyPath, `${legacyPath}.migrated`);
  } catch {
    // Migration copy is enough; renaming is best-effort.
  }
}

function readConfig(): UserPreferences {
  ensureConfigMigrated();
  return readJsonFile(getConfigPath()) ?? {};
}

function writeConfig(config: UserPreferences): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function loadPreferences(): UserPreferences {
  const config = readConfig();
  return {
    lastModel: config.lastModel,
    lastProvider: config.lastProvider,
    recentModelsByProvider: config.recentModelsByProvider,
    favoriteModels: config.favoriteModels,
    modelAliases: config.modelAliases,
    claudeBridgeMode: config.claudeBridgeMode,
    serverBridgeMode: config.serverBridgeMode,
    appPathOverrides: config.appPathOverrides,
    recentLaunchFolders: config.recentLaunchFolders,
    server: config.server,
  };
}

export function savePreferences(prefs: Partial<Pick<UserPreferences, 'lastModel' | 'lastProvider' | 'recentModelsByProvider' | 'favoriteModels' | 'modelAliases' | 'claudeBridgeMode' | 'serverBridgeMode' | 'appPathOverrides' | 'recentLaunchFolders'>>): void {
  const config = readConfig();
  if (prefs.lastModel !== undefined) config.lastModel = prefs.lastModel;
  if (prefs.lastProvider !== undefined) config.lastProvider = prefs.lastProvider;
  if (prefs.recentModelsByProvider !== undefined) config.recentModelsByProvider = prefs.recentModelsByProvider;
  if (prefs.favoriteModels !== undefined) config.favoriteModels = prefs.favoriteModels;
  if (prefs.modelAliases !== undefined) config.modelAliases = prefs.modelAliases;
  if (prefs.claudeBridgeMode !== undefined) config.claudeBridgeMode = prefs.claudeBridgeMode;
  if (prefs.serverBridgeMode !== undefined) config.serverBridgeMode = prefs.serverBridgeMode;
  if (prefs.appPathOverrides !== undefined) config.appPathOverrides = prefs.appPathOverrides;
  if (prefs.recentLaunchFolders !== undefined) config.recentLaunchFolders = prefs.recentLaunchFolders;
  writeConfig(config);
}

export function getAppPathOverride(appId: string): string | undefined {
  const value = loadPreferences().appPathOverrides?.[appId];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function setAppPathOverride(appId: string, path: string | null): Record<string, string> {
  const config = readConfig();
  const next = { ...(config.appPathOverrides ?? {}) };
  const trimmed = path?.trim() ?? '';
  if (trimmed) next[appId] = trimmed;
  else delete next[appId];
  config.appPathOverrides = next;
  if (Object.keys(next).length === 0) delete config.appPathOverrides;
  writeConfig(config);
  return next;
}

/** Resolve the bridge mode for a command: explicit flag wins (and persists); else remembered; else endpoint. */
export function resolveBridgeMode(
  command: 'claude' | 'server',
  explicit: import('./types.js').BridgeMode | undefined,
  opts: { persist?: boolean } = {},
): import('./types.js').BridgeMode {
  const key = command === 'claude' ? 'claudeBridgeMode' : 'serverBridgeMode';
  if (explicit) {
    if (opts.persist !== false) savePreferences({ [key]: explicit });
    return explicit;
  }
  return loadPreferences()[key] ?? 'endpoint';
}

const MAX_RECENT_MODELS = 3;
const MAX_RECENT_LAUNCH_FOLDERS = 6;

export function recordLaunchFolder(folder: string): string[] {
  const trimmed = folder.trim();
  if (!trimmed) return loadPreferences().recentLaunchFolders ?? [];
  const config = readConfig();
  const prev = config.recentLaunchFolders ?? [];
  const next = [trimmed, ...prev.filter(path => path !== trimmed)].slice(0, MAX_RECENT_LAUNCH_FOLDERS);
  config.recentLaunchFolders = next;
  writeConfig(config);
  return next;
}

export function recordLaunchSelection(
  _agent: 'claude',
  providerId: string,
  modelId: string,
  prefs: UserPreferences,
): void {
  const prevRecent = prefs.recentModelsByProvider?.[providerId] ?? [];
  const updatedRecent = [modelId, ...prevRecent.filter(id => id !== modelId)].slice(0, MAX_RECENT_MODELS);
  savePreferences({
    lastProvider: providerId,
    lastModel: modelId,
    recentModelsByProvider: { ...prefs.recentModelsByProvider, [providerId]: updatedRecent },
  });
}

const SERVER_PASSWORD_SERVICE = 'relay-ai-server-password';
const SERVER_PASSWORD_ACCOUNT = 'server-password';

async function getServerPasswordKeyring(): Promise<any | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry(SERVER_PASSWORD_SERVICE, SERVER_PASSWORD_ACCOUNT);
  } catch {
    return null;
  }
}

export async function getSavedServerPassword(): Promise<string | null> {
  const config = readConfig();
  if (config.server?.savedPassword) {
    const pwd = config.server.savedPassword;
    const keyring = await getServerPasswordKeyring();
    if (keyring) {
      try {
        await keyring.setPassword(pwd);
        delete config.server.savedPassword;
        if (Object.keys(config.server).length === 0) delete config.server;
        writeConfig(config);
      } catch {
        // Fallback: keep in config.json if keyring fails
      }
    }
    return pwd;
  }

  const keyring = await getServerPasswordKeyring();
  if (keyring) {
    try {
      return await keyring.getPassword();
    } catch {
      return null;
    }
  }
  return null;
}

export async function setSavedServerPassword(password: string): Promise<void> {
  const keyring = await getServerPasswordKeyring();
  if (keyring) {
    try {
      await keyring.setPassword(password);
      return;
    } catch {
      // Fallback
    }
  }
  const config = readConfig();
  config.server = {
    ...(config.server ?? {}),
    savedPassword: password,
  };
  writeConfig(config);
}

export async function clearSavedServerPassword(): Promise<void> {
  const keyring = await getServerPasswordKeyring();
  if (keyring) {
    try {
      await keyring.deletePassword();
    } catch {
      // Ignore
    }
  }
  const config = readConfig();
  if (!config.server) return;
  delete config.server.savedPassword;
  if (Object.keys(config.server).length === 0) delete config.server;
  writeConfig(config);
}

export function getServerExposedProviders(): string[] | null {
  const list = readConfig().server?.exposedProviders;
  return list && list.length > 0 ? list : null;
}

export function setServerExposedProviders(providerIds: string[]): void {
  const config = readConfig();
  config.server = {
    ...(config.server ?? {}),
    exposedProviders: providerIds,
  };
  writeConfig(config);
}

export function getServerMaskGatewayIds(): boolean {
  return readConfig().server?.maskGatewayIds ?? true;
}

export function setServerMaskGatewayIds(mask: boolean): void {
  const config = readConfig();
  config.server = {
    ...(config.server ?? {}),
    maskGatewayIds: mask,
  };
  writeConfig(config);
}

export function getServerFavoritesOnly(): boolean {
  return readConfig().server?.favoritesOnly ?? false;
}

export function setServerFavoritesOnly(favoritesOnly: boolean): void {
  const config = readConfig();
  config.server = {
    ...(config.server ?? {}),
    favoritesOnly,
  };
  writeConfig(config);
}

export function getServerListenMode(): 'local' | 'network' {
  return readConfig().server?.listenMode === 'network' ? 'network' : 'local';
}

export function setServerListenMode(listenMode: 'local' | 'network'): void {
  const config = readConfig();
  config.server = {
    ...(config.server ?? {}),
    listenMode,
  };
  writeConfig(config);
}
