// Read/merge/restore ~/.codex/config.toml for Codex App.
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  CODEX_APP_PROVIDER_ID,
  buildCodexAppRootConfig,
  type CodexAppConfigSpec,
} from './app-profile.js';
import { getReasoningCapabilities } from '../provider-factory.js';
import { getCodexHome } from './session.js';

type TomlRecord = Record<string, unknown>;

export function getCodexConfigPath(): string {
  return join(getCodexHome(), 'config.toml');
}

export function getCodexAppSidecarProfilePath(): string {
  return join(getCodexHome(), `${CODEX_APP_PROVIDER_ID}.config.toml`);
}

export interface CodexAppRestoreState {
  hadProfile: boolean;
  profile?: string;
  hadModel: boolean;
  model?: string;
  hadModelProvider: boolean;
  modelProvider?: string;
  hadModelCatalogJson: boolean;
  modelCatalogJson?: string;
  hadOpenAIBaseUrl?: boolean;
  openAIBaseUrl?: string;
  hadModelReasoningEffort: boolean;
  modelReasoningEffort?: string;
}

function asRecord(value: unknown): TomlRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as TomlRecord
    : {};
}

function rootString(config: TomlRecord, key: string): { had: boolean; value: string } {
  if (!(key in config)) return { had: false, value: '' };
  const v = config[key];
  return { had: true, value: typeof v === 'string' ? v : String(v ?? '') };
}

export function readCodexConfigText(path = getCodexConfigPath()): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

export function parseCodexConfig(text: string): TomlRecord {
  if (!text.trim()) return {};
  return asRecord(parse(text));
}

export function captureRestoreState(text: string): CodexAppRestoreState {
  const config = parseCodexConfig(text);
  const profile = rootString(config, 'profile');
  const model = rootString(config, 'model');
  const modelProvider = rootString(config, 'model_provider');
  const modelCatalog = rootString(config, 'model_catalog_json');
  const openAIBaseUrl = rootString(config, 'openai_base_url');
  const reasoning = rootString(config, 'model_reasoning_effort');
  return {
    hadProfile: profile.had,
    profile: profile.value,
    hadModel: model.had,
    model: model.value,
    hadModelProvider: modelProvider.had,
    modelProvider: modelProvider.value,
    hadModelCatalogJson: modelCatalog.had,
    modelCatalogJson: modelCatalog.value,
    hadOpenAIBaseUrl: openAIBaseUrl.had,
    openAIBaseUrl: openAIBaseUrl.value,
    hadModelReasoningEffort: reasoning.had,
    modelReasoningEffort: reasoning.value,
  };
}

export function isAppManagedConfig(text: string): boolean {
  const config = parseCodexConfig(text);
  const mp = rootString(config, 'model_provider');
  if (mp.had && mp.value === CODEX_APP_PROVIDER_ID) return true;
  const baseUrl = rootString(config, 'openai_base_url');
  const catalog = rootString(config, 'model_catalog_json');
  return mp.value === 'openai'
    && /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl.value)
    && /(?:^|[\\/])app-models-[^\\/]+\.json$/.test(catalog.value);
}

function mergeAppConfig(existing: TomlRecord, spec: CodexAppConfigSpec): TomlRecord {
  const patch = buildCodexAppRootConfig(spec);
  const out: TomlRecord = { ...existing };
  delete out.profile;
  out.model = patch.model;
  out.model_provider = patch.model_provider;
  out.openai_base_url = patch.openai_base_url;
  out.model_catalog_json = patch.model_catalog_json;
  const providers = asRecord(out.model_providers);
  delete providers[CODEX_APP_PROVIDER_ID];
  const profiles = asRecord(out.profiles);
  delete profiles[CODEX_APP_PROVIDER_ID];
  if (Object.keys(profiles).length === 0) {
    delete out.profiles;
  } else {
    out.profiles = profiles;
  }
  if (Object.keys(providers).length === 0) {
    delete out.model_providers;
  } else {
    out.model_providers = providers;
  }

  const existingEffort = typeof out.model_reasoning_effort === 'string' ? out.model_reasoning_effort : undefined;
  if (existingEffort !== undefined) {
      const caps = getReasoningCapabilities(spec.route.npm, spec.route.modelId, {
        providerId: spec.route.providerId,
        apiBaseUrl: spec.route.baseURL,
        supportedParameters: spec.route.supportedParameters,
        reasoning: spec.route.reasoning,
        interleavedReasoningField: spec.route.interleavedReasoningField,
      });
    if (caps.levels.length === 0 || !caps.levels.includes(existingEffort)) {
      if (caps.levels.length > 0 && caps.defaultLevel) {
        out.model_reasoning_effort = caps.defaultLevel;
      } else {
        delete out.model_reasoning_effort;
      }
    }
  }

  return out;
}

export function validateAppConfigText(text: string, spec: CodexAppConfigSpec): void {
  const config = parseCodexConfig(text);
  if ('profile' in config) {
    throw new Error('Generated config still contains legacy root profile key');
  }
  const profiles = asRecord(config.profiles);
  if (profiles[CODEX_APP_PROVIDER_ID]) {
    throw new Error('Generated config still contains legacy profiles table');
  }
  const mp = rootString(config, 'model_provider');
  if (mp.value !== 'openai') {
    throw new Error('Generated config must keep the built-in OpenAI model_provider');
  }
  const baseUrl = rootString(config, 'openai_base_url');
  if (baseUrl.value !== `http://127.0.0.1:${spec.proxyPort}/v1`) {
    throw new Error('Generated config openai_base_url mismatch');
  }
  const catalog = rootString(config, 'model_catalog_json');
  if (catalog.value !== spec.catalogPath) {
    throw new Error('Generated config model_catalog_json mismatch');
  }
}

export function applyAppConfigPatch(spec: CodexAppConfigSpec, configPath = getCodexConfigPath()): string {
  const existingText = readCodexConfigText(configPath);
  let existing: TomlRecord;
  try {
    existing = parseCodexConfig(existingText);
  } catch (err) {
    throw new Error(`Invalid existing Codex config at ${configPath}: ${err instanceof Error ? err.message : err}`);
  }
  const merged = mergeAppConfig(existing, spec);
  const text = `${stringify(merged)}\n`;
  validateAppConfigText(text, spec);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, text, 'utf8');
  return text;
}

function applyRestoreKey(config: TomlRecord, key: string, had: boolean, value: string | undefined): void {
  if (had && value !== undefined) {
    config[key] = value;
  } else {
    delete config[key];
  }
}

export function restoreConfigFromState(state: CodexAppRestoreState, configPath = getCodexConfigPath()): boolean {
  const existingText = readCodexConfigText(configPath);
  const config = parseCodexConfig(existingText);
  const providers = asRecord(config.model_providers);
  delete providers[CODEX_APP_PROVIDER_ID];
  if (Object.keys(providers).length === 0) {
    delete config.model_providers;
  } else {
    config.model_providers = providers;
  }

  if (state.hadProfile && state.profile) {
    config.profile = state.profile;
  } else {
    delete config.profile;
  }
  applyRestoreKey(config, 'model', state.hadModel, state.model);
  applyRestoreKey(config, 'model_provider', state.hadModelProvider, state.modelProvider);
  applyRestoreKey(config, 'model_catalog_json', state.hadModelCatalogJson, state.modelCatalogJson);
  // Restore states written by relay-ai <= 0.2.6 predate this field. The old
  // overlay preserved openai_base_url, so leave it untouched during recovery.
  if ('hadOpenAIBaseUrl' in state) {
    applyRestoreKey(config, 'openai_base_url', Boolean(state.hadOpenAIBaseUrl), state.openAIBaseUrl);
  }
  applyRestoreKey(config, 'model_reasoning_effort', state.hadModelReasoningEffort, state.modelReasoningEffort);

  const sidecar = getCodexAppSidecarProfilePath();
  if (existsSync(sidecar)) {
    try { rmSync(sidecar, { force: true }); } catch { /* ignore */ }
  }

  const hadFile = existsSync(configPath);
  const empty =
    Object.keys(config).length === 0
    || (Object.keys(config).length === 1 && 'model_providers' in config && Object.keys(asRecord(config.model_providers)).length === 0);

  if (!hadFile && empty) return false;
  if (empty) {
    rmSync(configPath, { force: true });
    return true;
  }
  writeFileSync(configPath, `${stringify(config)}\n`, 'utf8');
  return true;
}

export function previewAppConfigToml(spec: CodexAppConfigSpec): string {
  const text = `${stringify(buildCodexAppRootConfig(spec))}\n`;
  validateAppConfigText(text, spec);
  return text;
}
