import pc from 'picocolors';
import { networkInterfaces } from 'node:os';
import * as p from '@clack/prompts';
import { relayIntro } from '../ui.js';
import {
  getSavedServerPassword,
  getServerExposedProviders,
  getServerFavoritesOnly,
  getServerListenMode,
  getServerMaskGatewayIds,
  loadPreferences,
  setSavedServerPassword,
  setServerExposedProviders,
  setServerFavoritesOnly,
  setServerListenMode,
  setServerMaskGatewayIds,
} from '../config.js';
import { MAX_MODEL_CATALOG, DEFAULT_SERVER_PORT } from '../constants.js';
import {
  fetchProviderCatalog,
  localProvidersToServerModels,
} from '../provider-catalog.js';
import { providersForTarget } from '../target-compatibility.js';
import { loadRegistry } from '../registry/io.js';
import type { ServerModelInfo, GatewayModelOptions } from './models.js';
import {
  upstreamModelId,
  gatewayProviderLabel,
  buildDedupedModelRows,
} from './models.js';
import { getReasoningCapabilities } from '../provider-factory.js';
import {
  askFavoritesOnly,
  askListenMode,
  askMaskGatewayIds,
  askSaveServerPassword,
  askServerPassword,
  askServerStartMode,
  askUseSavedServerPassword,
} from './prompts.js';
import { createGatewayModelCatalog } from './models.js';
import { startServer } from './router.js';
import {
  filterServerModelsByFavorites,
  filterServerModelsByProviders,
  summarizeServerProviders,
} from './catalog-filter.js';
import { selectServerProviders, type ServerProviderOption } from './provider-select.js';
import { runHttpProxyServerCommand } from '../http-proxy/index.js';
import { getInferenceRequestLogPath, getSessionLogPath } from '../trace-log.js';

export interface ServerRunConfig {
  exposedProviders: string[] | null;
  maskGatewayIds: boolean;
  favoritesOnly: boolean;
  listenMode: 'local' | 'network';
}

export interface ServerCommandOptions {
  httpProxy?: boolean;
  quick?: boolean;
  listenMode?: 'local' | 'network';
  providersMode?: 'all' | 'favorites' | 'specific';
  providerIds?: string[];
  maskGatewayIds?: boolean;
  password?: string;
  wsDiagnostics?: boolean;
  /** TCP port override; defaults to DEFAULT_SERVER_PORT (17645). Applies to gateway and http-proxy modes. */
  port?: number;
}

export function getLocalIps(): Array<{ name: string; address: string }> {
  const ifaces = networkInterfaces();
  const result: Array<{ name: string; address: string }> = [];
  for (const [name, iface] of Object.entries(ifaces)) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({ name, address: addr.address });
      }
    }
  }
  return result;
}

function cappedWidth(values: string[], label: string, cap: number): number {
  return Math.max(label.length, ...values.map(value => Math.min(value.length, cap)));
}

export function formatModelCatalogLines(models: ServerModelInfo[], gateway?: GatewayModelOptions): string[] {
  if (models.length === 0) return [];

  const groups = new Map<string, ServerModelInfo[]>();
  for (const model of models) {
    const label = gatewayProviderLabel(model);
    let list = groups.get(label);
    if (!list) {
      list = [];
      groups.set(label, list);
    }
    list.push(model);
  }

  const lines: string[] = ['Model catalog:', ''];
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [label, groupModels] of sortedGroups) {
    const rows = buildDedupedModelRows(groupModels, gateway);
    const hiddenDuplicates = groupModels.length - rows.length;
    const duplicateNote = hiddenDuplicates > 0 ? `, ${hiddenDuplicates} duplicate${hiddenDuplicates !== 1 ? 's' : ''} hidden` : '';
    const nameWidth = cappedWidth(rows.map(row => row.name), 'Model', 28);
    const anthropicWidth = cappedWidth(rows.map(row => row.anthropicId), 'Anthropic ID', 46);
    const indexWidth = Math.max(String(rows.length).length, 1);

    lines.push(`  ${label} (${rows.length}${duplicateNote})`);
    lines.push(`  ${'#'.padStart(indexWidth)}  ${'Model'.padEnd(nameWidth)}  ${'Anthropic ID'.padEnd(anthropicWidth)}  OpenAI ID`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      lines.push(`  ${String(i + 1).padStart(indexWidth)}  ${row.name.padEnd(nameWidth)}  ${row.anthropicId.padEnd(anthropicWidth)}  ${row.openaiId}`);
    }
    lines.push('');
  }
  return lines;
}

function printModelCatalog(models: ServerModelInfo[], gateway?: GatewayModelOptions): void {
  if (models.length === 0) return;

  for (const line of formatModelCatalogLines(models, gateway)) {
    if (line === 'Model catalog:') {
      console.log(pc.bold(line));
    } else if (/^  [^#\d\s].+\(\d+/.test(line)) {
      console.log(pc.bold(line));
    } else if (/^  \s*#\s+Model\s+Anthropic ID\s+OpenAI ID/.test(line)) {
      console.log(pc.dim(line));
    } else {
      console.log(line);
    }
  }
}

export function providerOptionsFromCatalog(catalog: import('../types.js').LocalProvider[]): ServerProviderOption[] {
  const options: ServerProviderOption[] = [];
  for (const provider of providersForTarget(catalog, 'server')) {
    options.push({
      id: provider.id,
      name: provider.name,
      modelCount: provider.models.length,
    });
  }
  return options;
}

export async function loadServerModels(): Promise<ServerModelInfo[]> {
  const catalog = await fetchProviderCatalog({ agent: 'server' });
  const models: ServerModelInfo[] = [];

  const serverProviders = providersForTarget(catalog, 'server');
  if (serverProviders.length > 0) {
    models.push(...localProvidersToServerModels(serverProviders));
  }

  return models.map(enrichServerModelReasoning);
}

export function enrichServerModelReasoning(model: ServerModelInfo): ServerModelInfo {
  if (!model.npm || model.modelFormat !== 'openai') return model;
  const caps = getReasoningCapabilities(model.npm, upstreamModelId(model), {
    providerId: model.providerId,
    apiBaseUrl: model.apiBaseUrl,
    supportedParameters: model.supportedParameters,
    reasoning: model.reasoning,
    interleavedReasoningField: model.interleavedReasoningField,
  });
  if (!caps.defaultLevel) return model;
  return { ...model, defaultEffort: caps.defaultLevel };
}

function waitForShutdown(): Promise<void> {
  return new Promise(resolve => {
    const cleanup = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
    const onSignal = () => {
      cleanup();
      resolve();
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

async function getServerPasswordForMode(
  mode: 'local' | 'network',
): Promise<{ password: string | null; wasSaved: boolean } | undefined> {
  if (mode === 'local') return { password: null, wasSaved: false };

  const savedPassword = await getSavedServerPassword();
  let serverPassword: string | null = null;
  let wasSaved = false;

  if (savedPassword) {
    const savedChoice = await askUseSavedServerPassword();
    if (!savedChoice) return undefined;
    if (savedChoice === 'use-saved') {
      serverPassword = savedPassword;
      wasSaved = true;
    } else {
      serverPassword = await askServerPassword();
    }
  } else {
    serverPassword = await askServerPassword();
  }

  if (!serverPassword) return undefined;

  if (serverPassword !== savedPassword) {
    const savePassword = await askSaveServerPassword();
    if (savePassword === null) return undefined;
    if (savePassword) {
      await setSavedServerPassword(serverPassword);
      wasSaved = true;
    }
  }

  return { password: serverPassword, wasSaved };
}

async function getServerPasswordForQuickMode(
  mode: 'local' | 'network',
  passwordOverride?: string,
): Promise<{ password: string | null; wasSaved: boolean } | undefined> {
  if (mode === 'local') return { password: null, wasSaved: false };

  const trimmedOverride = passwordOverride?.trim();
  if (trimmedOverride) return { password: trimmedOverride, wasSaved: false };

  const savedPassword = await getSavedServerPassword();
  if (savedPassword) return { password: savedPassword, wasSaved: true };

  p.log.error('Network server quick-start needs a saved server password or `--password <value>`.');
  p.log.info('Run `clodex server` and choose Configure & start to save one, or pass a one-run password.');
  return undefined;
}

function savedServerRunConfig(): ServerRunConfig {
  return {
    exposedProviders: getServerExposedProviders(),
    maskGatewayIds: getServerMaskGatewayIds(),
    favoritesOnly: getServerFavoritesOnly(),
    listenMode: getServerListenMode(),
  };
}

function hasServerRunOverrides(options: ServerCommandOptions): boolean {
  return options.listenMode !== undefined
    || options.providersMode !== undefined
    || options.maskGatewayIds !== undefined
    || options.password !== undefined;
}

function applyServerRunOverrides(config: ServerRunConfig, options: ServerCommandOptions): ServerRunConfig {
  const next: ServerRunConfig = { ...config };

  if (options.listenMode) next.listenMode = options.listenMode;
  if (options.maskGatewayIds !== undefined) next.maskGatewayIds = options.maskGatewayIds;

  if (options.providersMode === 'all') {
    next.favoritesOnly = false;
    next.exposedProviders = null;
  } else if (options.providersMode === 'favorites') {
    next.favoritesOnly = true;
    next.exposedProviders = null;
  } else if (options.providersMode === 'specific') {
    next.favoritesOnly = false;
    next.exposedProviders = options.providerIds ?? [];
  }

  return next;
}

function shouldUseQuickServerMode(options: ServerCommandOptions): boolean {
  return Boolean(options.quick || hasServerRunOverrides(options) || !process.stdin.isTTY);
}

async function configureExposedProviders(): Promise<string[] | null | undefined> {
  p.log.info('Add providers to expose. Listed providers are removed when selected — like favorites.');
  const spinner = p.spinner();
  spinner.start('Loading providers...');
  const catalog = await fetchProviderCatalog({ agent: 'server' });
  spinner.stop('');

  const available = providerOptionsFromCatalog(catalog);
  const picked = await selectServerProviders(available, getServerExposedProviders() ?? undefined);
  if (!picked) return undefined;
  setServerExposedProviders(picked);
  p.log.success(`Saved ${picked.length} provider${picked.length !== 1 ? 's' : ''} for future server runs.`);
  return picked;
}

async function runServerWizard(): Promise<{ runConfig: ServerRunConfig; promptForPassword: boolean } | undefined> {
  relayIntro('Server');

  const startMode = await askServerStartMode();
  if (!startMode) return undefined;

  if (startMode === 'quick') {
    return { runConfig: savedServerRunConfig(), promptForPassword: false };
  }

  const favoritesOnly = await askFavoritesOnly(getServerFavoritesOnly());
  if (favoritesOnly === null) return undefined;
  setServerFavoritesOnly(favoritesOnly);
  if (favoritesOnly) {
    p.log.info('Manage favorites with `clodex models`.');
  }


  let exposedProviders: string[] | null | undefined = null;
  if (!favoritesOnly) {
    exposedProviders = await configureExposedProviders();
    if (exposedProviders === undefined) return undefined;
  }

  const maskGatewayIds = await askMaskGatewayIds(getServerMaskGatewayIds());
  if (maskGatewayIds === null) return undefined;
  setServerMaskGatewayIds(maskGatewayIds);

  const listenMode = await askListenMode();
  if (!listenMode) return undefined;
  setServerListenMode(listenMode);

  return {
    runConfig: { exposedProviders, maskGatewayIds, favoritesOnly, listenMode },
    promptForPassword: true,
  };
}

export async function resolveServerUpstreamApiKey(): Promise<string | null> {
  const catalog = await fetchProviderCatalog({ agent: 'server' });
  if (catalog.some(provider => provider.apiKey.trim() || provider.models.length > 0)) {
    return 'registry-local';
  }

  return null;
}

export async function runServerCommand(options: ServerCommandOptions = {}): Promise<number> {
  if (options.httpProxy) {
    const hasGatewayOptions = options.quick
      || options.listenMode !== undefined
      || options.providersMode !== undefined
      || options.maskGatewayIds !== undefined
      || options.password !== undefined;
    if (hasGatewayOptions) {
      p.log.error('--http-proxy is a local-only server mode and cannot be combined with gateway server options.');
      return 1;
    }
    return runHttpProxyServerCommand(false, options.wsDiagnostics, options.port);
  }
  const apiKey = await resolveServerUpstreamApiKey();
  if (!apiKey) {
    p.log.error('No providers configured. Run `clodex providers` to add OpenAI.');
    return 1;
  }

  const quickMode = shouldUseQuickServerMode(options);
  const resolved = quickMode
    ? {
        runConfig: applyServerRunOverrides(savedServerRunConfig(), options),
        promptForPassword: false,
      }
    : await runServerWizard();
  if (!resolved) return 0;

  const { runConfig, promptForPassword } = resolved;
  const pwResult = promptForPassword
    ? await getServerPasswordForMode(runConfig.listenMode)
    : await getServerPasswordForQuickMode(runConfig.listenMode, options.password);
  if (pwResult === undefined) return promptForPassword ? 0 : 1;
  const { password: serverPassword, wasSaved: passwordWasSaved } = pwResult;

  const mode = runConfig.listenMode;
  const host = mode === 'network' ? '0.0.0.0' : '127.0.0.1';
  const spinner = p.spinner();
  spinner.start('Fetching available models...');

  let models: ServerModelInfo[];
  try {
    models = await loadServerModels();
    if (runConfig.exposedProviders) {
      models = filterServerModelsByProviders(models, runConfig.exposedProviders);
    }
    if (runConfig.favoritesOnly) {
      const favorites = loadPreferences().favoriteModels ?? [];
      if (favorites.length === 0) {
        spinner.stop(pc.red('No favorite models configured'));
        p.log.error('Run `clodex models` to add favorites, or turn off favorites-only in the server wizard.');
        return 1;
      }
      models = filterServerModelsByFavorites(models, favorites).slice(0, MAX_MODEL_CATALOG);
      if (models.length === 0) {
        spinner.stop(pc.red('No favorite models matched the current provider filter'));
        p.log.error('Adjust favorites with `clodex models` or change exposed providers in the server wizard.');
        return 1;
      }
    }
    if (runConfig.favoritesOnly) {
      p.log.info(
        `Favorites-only mode active — GET /anthropic/v1/models returns ${models.length} favorites.`,
      );
      p.log.info('Desktop/Cowork picker will only show these. Edit with `clodex models`.');
    }
    if (models.length === 0) {
      spinner.stop(pc.red('No models to expose'));
      p.log.error('Add providers with `clodex providers add` or configure exposed providers in the server wizard.');
      return 1;
    }

    const localCount = models.filter(m => m.apiKey !== undefined).length;
    const summary = summarizeServerProviders(models);
    const filterNote = runConfig.exposedProviders
      ? ` — ${runConfig.exposedProviders.length} provider${runConfig.exposedProviders.length !== 1 ? 's' : ''}`
      : '';
    const favoritesNote = runConfig.favoritesOnly ? ' — favorites only' : '';
    const maskNote = runConfig.maskGatewayIds ? ' — discovery ids masked' : '';
    spinner.stop(`Loaded ${models.length} models (${localCount} from registry providers)${filterNote}${favoritesNote}${maskNote}`);
    if (summary) p.log.info(summary);
  } catch (err) {
    spinner.stop(pc.red('Failed to load models'));
    console.error(pc.red(String(err instanceof Error ? err.message : err)));
    return 1;
  }

  const gateway = runConfig.maskGatewayIds ? { maskGatewayIds: true as const } : undefined;
  const inferenceLogPath = getInferenceRequestLogPath();
  const webSocketDiagnosticsLogPath = options.wsDiagnostics
    ? getSessionLogPath('server-websocket-diagnostics', 'jsonl')
    : undefined;
  const server = await startServer({
    host,
    port: options.port ?? DEFAULT_SERVER_PORT,
    apiKey,
    serverPassword,
    catalog: createGatewayModelCatalog(models, gateway),
    gateway,
    inferenceLogPath,
    webSocketDiagnosticsLogPath,
  });

  console.log('');
  console.log(pc.bold(pc.green('clodex server running')));
  console.log(`  Anthropic:  http://127.0.0.1:${server.port}/anthropic`);
  console.log(`  OpenAI:     http://127.0.0.1:${server.port}/openai/v1`);
  console.log(`  Request log: ${inferenceLogPath}`);
  if (webSocketDiagnosticsLogPath) {
    console.log(`  WebSocket diagnostics: ${webSocketDiagnosticsLogPath}`);
    console.log(pc.yellow('  Diagnostic mode records request headers and metadata; credential headers are redacted.'));
  }
  if (mode === 'network') {
    for (const { name, address } of getLocalIps()) {
      console.log(`  Network (${name}):`);
      console.log(`    Anthropic:  http://${address}:${server.port}/anthropic`);
      console.log(`    OpenAI:     http://${address}:${server.port}/openai/v1`);
    }
    if (passwordWasSaved) {
      console.log('  API key:    saved, rotate with `clodex server --setup`');
    } else {
      console.log(`  API key:    ${serverPassword}`);
    }
  } else {
    console.log('  API key:    any non-empty value');
  }
  if (runConfig.exposedProviders) {
    console.log(pc.dim(`  Providers:  ${runConfig.exposedProviders.join(', ')}`));
  }
  if (runConfig.favoritesOnly) {
    console.log(pc.dim('  Catalog:    favorite models only'));
  }
  if (runConfig.maskGatewayIds) {
    console.log(pc.dim('  Discovery:  gateway ids masked for Claude Desktop / Cowork'));
  }
  console.log('');
  printModelCatalog(models, gateway);
  console.log(pc.dim('Press Ctrl+C to stop.'));

  await waitForShutdown();
  await server.close();
  return 0;
}
