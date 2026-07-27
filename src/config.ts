import type { UserPreferences } from './types.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync } from 'node:fs';
import { getConfigPath } from './paths.js';
import { syncParentDirectory, writeSecureFile } from './registry/io.js';
import {
  assertRegistryWriteOwnership,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from './registry/lock.js';

function readJsonFile(path: string): UserPreferences | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as UserPreferences : null;
  } catch {
    return null;
  }
}

function readConfig(): UserPreferences {
  return readJsonFile(getConfigPath()) ?? {};
}

function writeConfig(config: UserPreferences): void {
  const configPath = getConfigPath();
  assertRegistryWriteOwnership(configPath);
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const tmp = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeSecureFile(tmp, payload);
    assertRegistryWriteOwnership(configPath);
    renameSync(tmp, configPath);
    syncParentDirectory(configPath);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function updateConfig<T>(mutate: (config: UserPreferences) => T): T {
  const configPath = getConfigPath();
  return withRegistryWriteLockSync(() => {
    const config = readJsonFile(configPath) ?? {};
    const result = mutate(config);
    writeConfig(config);
    return result;
  }, { lockPath: `${configPath}.lock` });
}

interface AsyncConfigUpdate<T> {
  result: T;
  write: boolean;
}

async function updateConfigAsync<T>(
  mutate: (
    config: UserPreferences,
  ) => Promise<AsyncConfigUpdate<T>> | AsyncConfigUpdate<T>,
): Promise<T> {
  const configPath = getConfigPath();
  return withRegistryWriteLock(async () => {
    const config = readJsonFile(configPath) ?? {};
    const update = await mutate(config);
    if (update.write) writeConfig(config);
    return update.result;
  }, { lockPath: `${configPath}.lock` });
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
  updateConfig(config => {
    if (prefs.lastModel !== undefined) config.lastModel = prefs.lastModel;
    if (prefs.lastProvider !== undefined) config.lastProvider = prefs.lastProvider;
    if (prefs.recentModelsByProvider !== undefined) config.recentModelsByProvider = prefs.recentModelsByProvider;
    if (prefs.favoriteModels !== undefined) config.favoriteModels = prefs.favoriteModels;
    if (prefs.modelAliases !== undefined) config.modelAliases = prefs.modelAliases;
    if (prefs.claudeBridgeMode !== undefined) config.claudeBridgeMode = prefs.claudeBridgeMode;
    if (prefs.serverBridgeMode !== undefined) config.serverBridgeMode = prefs.serverBridgeMode;
    if (prefs.appPathOverrides !== undefined) config.appPathOverrides = prefs.appPathOverrides;
    if (prefs.recentLaunchFolders !== undefined) config.recentLaunchFolders = prefs.recentLaunchFolders;
  });
}

export function getAppPathOverride(appId: string): string | undefined {
  const value = loadPreferences().appPathOverrides?.[appId];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function setAppPathOverride(appId: string, path: string | null): Record<string, string> {
  return updateConfig(config => {
    const next = { ...(config.appPathOverrides ?? {}) };
    const trimmed = path?.trim() ?? '';
    if (trimmed) next[appId] = trimmed;
    else delete next[appId];
    config.appPathOverrides = next;
    if (Object.keys(next).length === 0) delete config.appPathOverrides;
    return next;
  });
}

/**
 * Resolve the bridge mode for a command. An explicit flag applies to that run only —
 * it is persisted as the command's default ONLY when the caller opts in (--save-mode).
 * With no flag, the saved per-command default applies; with no saved default, proxy.
 */
export function resolveBridgeMode(
  command: 'claude' | 'server',
  explicit: import('./types.js').BridgeMode | undefined,
  opts: { persist?: boolean } = {},
): import('./types.js').BridgeMode {
  const key = command === 'claude' ? 'claudeBridgeMode' : 'serverBridgeMode';
  if (explicit) {
    if (opts.persist === true) savePreferences({ [key]: explicit });
    return explicit;
  }
  return loadPreferences()[key] ?? 'proxy';
}

const MAX_RECENT_MODELS = 3;
const MAX_RECENT_LAUNCH_FOLDERS = 6;

export function recordLaunchFolder(folder: string): string[] {
  const trimmed = folder.trim();
  if (!trimmed) return loadPreferences().recentLaunchFolders ?? [];
  return updateConfig(config => {
    const prev = config.recentLaunchFolders ?? [];
    const next = [trimmed, ...prev.filter(path => path !== trimmed)].slice(0, MAX_RECENT_LAUNCH_FOLDERS);
    config.recentLaunchFolders = next;
    return next;
  });
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

const SERVER_PASSWORD_SERVICE = 'clodex-server-password';
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
  const keyring = await getServerPasswordKeyring();
  if (!keyring) return readConfig().server?.savedPassword ?? null;

  const savedPassword = await updateConfigAsync(async config => {
    const server = config.server;
    const password = server?.savedPassword;
    if (!password) return { result: null, write: false };
    try {
      await keyring.setPassword(password);
      delete server.savedPassword;
      if (Object.keys(server).length === 0) delete config.server;
      return { result: password, write: true };
    } catch {
      // Fallback: keep in config.json if keyring fails
      return { result: password, write: false };
    }
  });
  if (savedPassword) return savedPassword;

  try {
    return await keyring.getPassword();
  } catch {
    return null;
  }
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
  await updateConfigAsync(config => {
    config.server = {
      ...(config.server ?? {}),
      savedPassword: password,
    };
    return { result: undefined, write: true };
  });
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
  await updateConfigAsync(config => {
    if (!config.server) return { result: undefined, write: false };
    delete config.server.savedPassword;
    if (Object.keys(config.server).length === 0) delete config.server;
    return { result: undefined, write: true };
  });
}

export function getServerExposedProviders(): string[] | null {
  const list = readConfig().server?.exposedProviders;
  return list && list.length > 0 ? list : null;
}

export function setServerExposedProviders(providerIds: string[]): void {
  updateConfig(config => {
    config.server = {
      ...(config.server ?? {}),
      exposedProviders: providerIds,
    };
  });
}

export function getServerMaskGatewayIds(): boolean {
  return readConfig().server?.maskGatewayIds ?? true;
}

export function setServerMaskGatewayIds(mask: boolean): void {
  updateConfig(config => {
    config.server = {
      ...(config.server ?? {}),
      maskGatewayIds: mask,
    };
  });
}

export function getServerFavoritesOnly(): boolean {
  return readConfig().server?.favoritesOnly ?? false;
}

export function setServerFavoritesOnly(favoritesOnly: boolean): void {
  updateConfig(config => {
    config.server = {
      ...(config.server ?? {}),
      favoritesOnly,
    };
  });
}

export function getServerListenMode(): 'local' | 'network' {
  return readConfig().server?.listenMode === 'network' ? 'network' : 'local';
}

export function setServerListenMode(listenMode: 'local' | 'network'): void {
  updateConfig(config => {
    config.server = {
      ...(config.server ?? {}),
      listenMode,
    };
  });
}
