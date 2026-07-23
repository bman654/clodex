// src/registry/io.ts — load/save providers.json with secure permissions

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ensureLegacyAppHomeMigrated, getAppHome, getProvidersPath } from '../paths.js';
import type { ProviderRegistry, RegistryProvider } from './types.js';
import { REGISTRY_SCHEMA_VERSION } from './types.js';
import {
  assertRegistryWriteOwnership,
  withRegistryWriteLockSync,
} from './lock.js';
import { migrateOAuthOpenAiProvider } from './migrate.js';
import { isValidProviderId } from './validate.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function ensureSecureAppHome(): void {
  const home = getAppHome();
  mkdirSync(home, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(home, DIR_MODE);
  } catch {
    // best-effort on platforms that restrict chmod
  }
}

function writeSecureFile(path: string, content: string): void {
  ensureSecureAppHome();
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const fd = openSync(path, 'wx', FILE_MODE);
  try {
    const payload = Buffer.from(content);
    let offset = 0;
    while (offset < payload.length) {
      const written = writeSync(fd, payload, offset, payload.length - offset);
      if (written <= 0) {
        throw new Error(`Could not complete secure file write: ${path}`);
      }
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // best-effort
  }
}

function syncParentDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseProvider(raw: unknown): RegistryProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !isValidProviderId(p.id)) return null;
  if (typeof p.templateId !== 'string' || !p.templateId) return null;
  if (typeof p.name !== 'string' || !p.name) return null;
  if (typeof p.enabled !== 'boolean') return null;
  if (typeof p.authRef !== 'string' || !p.authRef) return null;
  if (typeof p.addedAt !== 'string' || !p.addedAt) return null;
  const api = p.api;
  if (!api || typeof api !== 'object') return null;

  const provider: RegistryProvider = {
    id: p.id,
    templateId: p.templateId,
    name: p.name,
    enabled: p.enabled,
    authRef: p.authRef,
    api: api as RegistryProvider['api'],
    addedAt: p.addedAt,
  };

  if (p.subscriptionFilter === 'free') {
    provider.subscriptionFilter = p.subscriptionFilter;
  }
  if (p.authType === 'api' || p.authType === 'oauth' || p.authType === 'none') {
    provider.authType = p.authType;
  }
  if (typeof p.refreshedAt === 'string') provider.refreshedAt = p.refreshedAt;
  if (p.modelsCache && typeof p.modelsCache === 'object') {
    const cache = p.modelsCache as { fetchedAt?: string; models?: unknown[] };
    if (typeof cache.fetchedAt === 'string' && Array.isArray(cache.models)) {
      provider.modelsCache = {
        fetchedAt: cache.fetchedAt,
        models: cache.models.filter(m => m && typeof m === 'object') as RegistryProvider['modelsCache'] extends infer C
          ? C extends { models: infer M } ? M : never
          : never,
      };
    }
  }
  return provider;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasValidStrictProviderFields(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const provider = raw as Record<string, unknown>;
  if (hasOwn(provider, 'subscriptionFilter') && provider.subscriptionFilter !== 'free') {
    return false;
  }
  if (
    hasOwn(provider, 'authType')
    && provider.authType !== 'api'
    && provider.authType !== 'oauth'
    && provider.authType !== 'none'
  ) {
    return false;
  }
  if (hasOwn(provider, 'refreshedAt') && typeof provider.refreshedAt !== 'string') {
    return false;
  }
  if (hasOwn(provider, 'modelsCache')) {
    const cache = provider.modelsCache;
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return false;
    const fields = cache as Record<string, unknown>;
    if (typeof fields.fetchedAt !== 'string' || !Array.isArray(fields.models)) {
      return false;
    }
    if (fields.models.some(model => !model || typeof model !== 'object' || Array.isArray(model))) {
      return false;
    }
  }
  return true;
}

function parseRegistry(raw: unknown): ProviderRegistry {
  const empty: ProviderRegistry = { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const data = raw as Record<string, unknown>;
  const providers: RegistryProvider[] = [];
  if (Array.isArray(data.providers)) {
    for (const entry of data.providers) {
      const parsed = parseProvider(entry);
      if (parsed) providers.push(parsed);
    }
  }
  const registry: ProviderRegistry = {
    schemaVersion:
      typeof data.schemaVersion === 'number' ? data.schemaVersion : REGISTRY_SCHEMA_VERSION,
    providers,
  };
  if (typeof data.importedAt === 'string') registry.importedAt = data.importedAt;
  if (typeof data.pricingCacheAt === 'string') registry.pricingCacheAt = data.pricingCacheAt;
  return registry;
}

function parseRegistryStrict(raw: unknown): ProviderRegistry {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Provider registry must be a JSON object.');
  }
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error('Provider registry has an unsupported schema version.');
  }
  if (!Array.isArray(data.providers)) {
    throw new Error('Provider registry is missing its providers list.');
  }
  for (const entry of data.providers) {
    if (!parseProvider(entry) || !hasValidStrictProviderFields(entry)) {
      throw new Error('Provider registry contains an invalid provider entry.');
    }
  }
  return parseRegistry(raw);
}

function readRegistryStrict(path: string): ProviderRegistry {
  return parseRegistryStrict(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadRegistry(path = getProvidersPath()): ProviderRegistry {
  ensureLegacyAppHomeMigrated();
  if (!existsSync(path)) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const registry = parseRegistry(raw);
    const migrated = migrateOAuthOpenAiProvider(registry);
    if (migrated) {
      try {
        withRegistryWriteLockSync(() => {
          if (!existsSync(path)) return;
          const current = readRegistryStrict(path);
          if (migrateOAuthOpenAiProvider(current)) saveRegistry(current, path);
        }, { lockPath: `${path}.lock` });
      } catch {
        // Parsed data remains usable even when migration persistence fails.
      }
    }
    return registry;
  } catch {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
}

/**
 * Load a registry for destructive decisions. Unlike `loadRegistry`, read,
 * parse, and provider-shape errors propagate so callers cannot confuse an
 * unreadable registry with an empty one.
 */
export function loadRegistryStrict(path = getProvidersPath()): ProviderRegistry {
  ensureLegacyAppHomeMigrated();
  if (!existsSync(path)) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
  const registry = readRegistryStrict(path);
  migrateOAuthOpenAiProvider(registry);
  return registry;
}

export function saveRegistry(registry: ProviderRegistry, path = getProvidersPath()): void {
  assertRegistryWriteOwnership(path);
  const payload = `${JSON.stringify(registry, null, 2)}\n`;
  const backup = `${path}.bak`;
  if (existsSync(path)) {
    try {
      copyFileSync(path, backup);
    } catch {
      // backup is best-effort
    }
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeSecureFile(tmp, payload);
    assertRegistryWriteOwnership(path);
    renameSync(tmp, path);
    syncParentDirectory(path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

export function emptyRegistry(): ProviderRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
}
