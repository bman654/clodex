import pc from 'picocolors';
import * as p from '@clack/prompts';
import { fetchProviderCatalog, providersForPicker } from './provider-catalog.js';
import { loadPreferences, savePreferences } from './config.js';
import { resolveProviderCredential, resolveApiKey, readFromCredentialStore } from './env.js';
import { resolveOrCollectApiKey } from './key-setup.js';
import { oauthAuthRef } from './registry/import-build.js';
import { loadRegistry } from './registry/io.js';
import { pickCodexProvider, pickCodexModel } from './codex/prompts.js';
import {
  codexCompatibleProviders,
  routableModelsForProvider,
} from './codex/routing.js';
import { startServer, type ServerHandle } from './server/router.js';
import { createGatewayModelCatalog, type ServerModelInfo } from './server/models.js';
import { BACKENDS } from './constants.js';
import { loadServerModels } from './server/index.js';
import { filterServerModelsByFavorites } from './server/catalog-filter.js';
import { writeRelayAiConfig, getClaudeDesktopHome } from './claude-desktop/app-config.js';
import { getProxyDebugLogPath } from './trace-log.js';
import { readSessionLock, recoverSession, hasStaleSession, writeSessionLock, setupExitCleanup, cleanupSession, backupMetaJson, isConcurrentLiveSession, waitForShutdown } from './claude-desktop/app-session.js';
import { launchOrRestartClaudeApp, claudeAppSupported, isClaudeAppRunning, quitClaudeAppGracefully } from './claude-desktop/app-launch.js';
import type { LocalProvider } from './types.js';

export function claudeAppHelpText(): string {
  return `${pc.bold('relay-ai claude-app')} — launch Claude Desktop app in 3P mode with your registry providers

${pc.bold('Usage:')}
  relay-ai claude-app [options]
  relay-ai claude-app --trace
  relay-ai claude-app --restore
  relay-ai claude-app --help
  relay-ai claude-app --version

${pc.bold('Options:')}
  --trace      Write proxy debug logs to ~/.relay-ai/logs/
  --restore    Restore Claude Desktop config after an interrupted app session
  --help       Show this command help
  --version    Show version

${pc.bold('Description:')}
  Picks a provider and model from ~/.relay-ai/providers.json, patches Claude Desktop config
  (with backup + restore on Ctrl+C), starts a local Responses proxy, and opens
  the Claude Desktop app. Keep this terminal open while using Claude.

${pc.bold('Platforms:')}
  macOS and Windows. Linux is not supported.

${pc.bold('Cleanup:')}
  Ctrl+C stops the proxy and restores your previous Claude config.
  After a crash: relay-ai claude-app --restore
`;
}

function providerForClaudePicker(provider: LocalProvider): LocalProvider {
  return { ...provider, models: routableModelsForProvider(provider, 'codex-app') };
}

export async function runClaudeAppCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(claudeAppHelpText());
    return 0;
  }

  if (args.includes('--restore')) {
    recoverSession();
    console.log('Restored Claude Desktop relay-ai config.');
    return 0;
  }

  const trace = args.includes('--trace');
  const debugLogPath = trace ? getProxyDebugLogPath() : undefined;
  if (trace) console.log(`Debug log: ${debugLogPath}`);

  try {
    claudeAppSupported();
  } catch (err) {
    console.error(pc.red(String(err instanceof Error ? err.message : err)));
    return 1;
  }

  const isTty = Boolean(process.stdin.isTTY);
  if (!isTty) {
    console.error(pc.red('relay-ai claude-app requires an interactive terminal.'));
    return 1;
  }

  if (isConcurrentLiveSession()) {
    console.error(pc.yellow(`Another relay-ai claude-app session may be running.`));
    console.error('Stop it with Ctrl+C in that terminal.');
    return 1;
  }

  if (hasStaleSession()) {
    p.log.warn('Recovered from an interrupted claude-app session.');
    recoverSession();
  }

  const catalogSpinner = p.spinner();
  catalogSpinner.start('Loading your providers...');
  let catalog;
  try {
    catalog = await fetchProviderCatalog({ agent: 'codex-app' });
  } catch (err) {
    catalogSpinner.stop('');
    console.error(pc.red(String(err instanceof Error ? err.message : err)));
    return 1;
  }
  catalogSpinner.stop('');

  const compatible = codexCompatibleProviders(providersForPicker(catalog), 'codex-app');
  if (compatible.length === 0) {
    p.log.warn('No compatible providers in your registry.');
    return 0;
  }

  const prefs = loadPreferences();
  const favorites = prefs.favoriteModels ?? [];
  const hasFavorites = favorites.length > 0;

  let activeProvider: LocalProvider | null = null;
  let selectedModel: any = null;
  let useFavorites = false;

  const pickedProvider = await pickCodexProvider(compatible, prefs, hasFavorites);
  if (!pickedProvider) return 0;

  if (pickedProvider === '__favorites__') {
    useFavorites = true;
  } else {
    activeProvider = providerForClaudePicker(pickedProvider);
    const pickedModel = await pickCodexModel(activeProvider, prefs);
    if (!pickedModel) return 0;
    selectedModel = pickedModel;

    const regEntry = loadRegistry().providers.find(pr => pr.id === activeProvider?.id);
    const authRef = regEntry?.authRef
      ?? (activeProvider.apiKey ? `keyring:provider:${activeProvider.id}` : oauthAuthRef(activeProvider.id));
    const apiKey = activeProvider.apiKey?.trim()
      || await resolveProviderCredential(activeProvider.id, authRef);
    if (!apiKey) {
      p.log.error(`No credential for ${activeProvider.name}. Run relay-ai providers auth ${activeProvider.id}.`);
      return 1;
    }

    activeProvider.apiKey = apiKey;
  }

  let serverModels: ServerModelInfo[] = [];

  if (useFavorites) {
    const allModels = await loadServerModels();
    serverModels = filterServerModelsByFavorites(allModels, favorites);
  } else {
    serverModels = [{
      id: selectedModel.id,
      name: selectedModel.name,
      isFree: selectedModel.isFree ?? false,
      brand: selectedModel.brand ?? '',
      providerLabel: activeProvider!.name,
      providerId: activeProvider!.id,
      sourceBackend: activeProvider!.id,
      modelFormat: selectedModel.modelFormat,
      upstreamModelId: selectedModel.upstreamModelId,
      cost: selectedModel.cost,
      baseUrl: selectedModel.baseUrl,
      completionsUrl: selectedModel.completionsUrl,
      npm: selectedModel.npm,
      apiBaseUrl: selectedModel.apiBaseUrl,
      apiKey: activeProvider!.apiKey,
      contextWindow: selectedModel.contextWindow,
    }];
  }

  let proxyHandle: ServerHandle | null = null;
  let sessionActive = false;

  try {
    backupMetaJson();

    proxyHandle = await startServer({
      host: '127.0.0.1',
      port: 0, // random port
      apiKey: 'dummy',
      serverPassword: null,
      catalog: createGatewayModelCatalog(serverModels, { maskGatewayIds: true }),
      backends: BACKENDS,
      gateway: { maskGatewayIds: true },
      debugLogPath,
    });

    const uuid = writeRelayAiConfig(proxyHandle.port);

    writeSessionLock({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      uuid,
      proxyPort: proxyHandle.port
    });
    sessionActive = true;
    setupExitCleanup(uuid);

    if (!useFavorites) {
      const prevRecent = prefs.recentModelsByProvider?.[activeProvider!.id] ?? [];
      const updatedRecent = [selectedModel.id, ...prevRecent.filter((id: string) => id !== selectedModel.id)].slice(0, 3);
      savePreferences({
        lastCodexProvider: activeProvider!.id,
        lastCodexModel: selectedModel.id,
        recentModelsByProvider: { ...prefs.recentModelsByProvider, [activeProvider!.id]: updatedRecent },
      });
    }

    console.log(`\n${pc.green('✔')} Proxy started on port ${proxyHandle.port}`);

    try {
      await launchOrRestartClaudeApp();
    } catch (err) {
      p.log.warn(String(err instanceof Error ? err.message : err));
    }

    console.log(`\n${pc.bold('Claude Desktop 3P Mode Active')}`);
    if (useFavorites) {
      console.log(`${pc.dim('Catalog:')}  Favorite models only`);
    } else {
      console.log(`${pc.dim('Model:')}    ${selectedModel.id}`);
      console.log(`${pc.dim('Provider:')} ${activeProvider!.name}`);
    }
    console.log(`${pc.cyan('Press Ctrl+C to stop and restore config.')}`);

    await waitForShutdown();
    console.log('');
    
    // We do cleanup before prompting so that Claude gets restored ASAP
    // and if the user hits Ctrl+C again during the prompt, it's already restored.
    cleanupSession(uuid);
    sessionActive = false;

    if (isClaudeAppRunning()) {
      const shouldClose = await p.confirm({ message: 'Claude Desktop is still running. Close it?' });
      if (shouldClose && !p.isCancel(shouldClose)) {
        quitClaudeAppGracefully();
      }
    }
    return 0;

  } catch (err) {
    if (proxyHandle) await proxyHandle.close();
    if (sessionActive && proxyHandle) {
      cleanupSession(proxyHandle.port.toString());
    }
    return 1;
  }
}
