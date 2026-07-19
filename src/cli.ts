// src/cli.ts
import pc from 'picocolors';
import { relayIntro, relayOutro, providerSelectOption, fmtModel, fmtEnabledStar, formatModelLabel } from './ui.js';
import * as p from '@clack/prompts';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findClaudeBinary, launchClaude } from './launch.js';
import { detectConflicts, buildChildEnv, buildHttpProxyChildEnv } from './env.js';
import { claudeCodeClientModelId } from './context-model-id.js';
import { needsFirstRunSetup, runFirstRunWizard } from './first-run.js';
import { MAX_MODEL_CATALOG } from './constants.js';
import { startProxy, startProxyCatalog } from './proxy.js';
import type { ProxyHandle, ProxyRoute } from './proxy.js';
import {
  buildCatalogRoutes,
  makeRouteResolver,
} from './catalog.js';
import { runServerCommand } from './server/index.js';
import { loadPreferences, savePreferences, recordLaunchSelection, resolveBridgeMode } from './config.js';
import { pickLocalModel } from './prompts.js';
import { fetchProviderCatalog, providersForPicker, resolveLocalProviderApiKey } from './provider-catalog.js';
import { VERSION } from './constants.js';
import type { ParsedArgs, FavoriteModel, LocalProvider, LocalProviderModel } from './types.js';
import { addFavorite, removeFavorite, isFavorite } from './favorites.js';
import { isValidModelAlias, modelAliasTarget, parseModelAliasAssignment } from './model-aliases.js';
import {
  browseByProviderChoice,
  buildGlobalFavoriteIndex,
  pickGlobalFavoriteModel,
} from './favorites-picker.js';
import { favoriteProviderDisplayName } from './favorite-provider-display.js';
import { runProvidersCommand, providersHelpText } from './providers-command.js';
import {
  getInferenceSessionLogPath,
  getSessionLogPath,
  prepareClaudeTraceLog,
  printTraceLog,
  writeProxyLifecycleLog,
} from './trace-log.js';
import { providersForTarget } from './target-compatibility.js';
import { refreshModelsDevCacheAsync } from './registry/models-dev.js';
import { setAgentStdoutMode, isAgentStdoutMode } from './agent-io.js';
import {
  findProviderAndModel,
  normalizeClaudeAgentArgs,
  planLaunchWizard,
  wantsCleanAgentStdout,
} from './launch-target.js';
import {
  loadHttpProxyRoutes,
  printHttpProxyModels,
  reportSkippedHttpProxyFavorites,
  startConfiguredHttpProxy,
} from './http-proxy/index.js';
import { runPatchCommand, runLaunchPatchCheck } from './patcher.js';
const STARTER_CLAUDE_FLAGS = new Set(['--dry-run', '--trace', '--endpoint', '--proxy', '--http-proxy', '--help', '-h', '--version', '-v']);
const CLODEX_LAUNCH_FLAGS = new Set(['--provider', '--model']);

function parseClodexLaunchFlag(
  arg: string,
  rest: string[],
  index: number,
  parsed: ParsedArgs,
): number | 'error' {
  if (arg === '--provider' || arg === '--model') {
    const value = rest[index + 1];
    if (!value || value.startsWith('-')) {
      parsed.error = `Missing value for ${arg}`;
      return 'error';
    }
    if (arg === '--provider') parsed.launchProvider = value;
    else parsed.launchModel = value;
    return index + 1;
  }
  if (arg.startsWith('--provider=')) {
    parsed.launchProvider = arg.slice('--provider='.length);
    return index;
  }
  if (arg.startsWith('--model=')) {
    parsed.launchModel = arg.slice('--model='.length);
    return index;
  }
  return index;
}

function tryConsumeClodexLaunchFlag(
  arg: string,
  rest: string[],
  index: number,
  parsed: ParsedArgs,
): { next: number } | { error: true } | null {
  if (!CLODEX_LAUNCH_FLAGS.has(arg) && !arg.startsWith('--provider=') && !arg.startsWith('--model=')) {
    return null;
  }
  const next = parseClodexLaunchFlag(arg, rest, index, parsed);
  if (next === 'error') return { error: true };
  return { next };
}

function consumeServerOptionValue(
  arg: string,
  rest: string[],
  index: number,
  flag: string,
  parsed: ParsedArgs,
): { value: string; next: number } | null {
  if (arg.startsWith(`${flag}=`)) {
    return { value: arg.slice(flag.length + 1), next: index };
  }
  if (arg !== flag) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith('--')) {
    parsed.error = `Missing value for ${flag}`;
    return null;
  }
  return { value, next: index + 1 };
}

function applyServerProvidersOption(value: string, parsed: ParsedArgs): void {
  const trimmed = value.trim();
  if (trimmed === 'all') {
    parsed.serverProvidersMode = 'all';
    parsed.serverProviderIds = undefined;
    return;
  }
  if (trimmed === 'favorites') {
    parsed.serverProvidersMode = 'favorites';
    parsed.serverProviderIds = undefined;
    return;
  }

  const ids = trimmed.split(',').map(id => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    parsed.error = 'Missing provider ids for --providers';
    return;
  }
  parsed.serverProvidersMode = 'specific';
  parsed.serverProviderIds = ids;
}

function emptyParsed(command: ParsedArgs['command']): ParsedArgs {
  return {
    command,
    showHelp: false,
    showVersion: false,
    dryRun: false,
    trace: false,
    claudeArgs: [],
  };
}

function consumeBridgeModeFlag(arg: string, parsed: ParsedArgs): boolean {
  if (arg === '--endpoint') {
    parsed.bridgeMode = 'endpoint';
    return true;
  }
  if (arg === '--proxy' || arg === '--http-proxy') {
    parsed.bridgeMode = 'proxy';
    return true;
  }
  return false;
}

export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) return { ...emptyParsed('root'), showHelp: true };

  const [first, ...rest] = args;

  if (first === '--help' || first === '-h') {
    return { ...emptyParsed('root'), showHelp: true };
  }
  if (first === '--version' || first === '-v') {
    return { ...emptyParsed('root'), showVersion: true };
  }

  if (first === 'server') {
    const parsed = emptyParsed('server');
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else if (consumeBridgeModeFlag(arg, parsed)) continue;
      else if (arg === '--ws-diagnostics') parsed.serverWsDiagnostics = true;
      else if (arg === '--quick' || arg === '--saved') parsed.serverQuick = true;
      else if (arg === '--mask-gateway-ids') parsed.serverMaskGatewayIds = true;
      else if (arg === '--no-mask-gateway-ids') parsed.serverMaskGatewayIds = false;
      else if (arg === '--listen' || arg.startsWith('--listen=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--listen', parsed);
        if (!consumed) return parsed;
        if (consumed.value !== 'local' && consumed.value !== 'network') {
          parsed.error = '--listen must be "local" or "network"';
          return parsed;
        }
        parsed.serverListenMode = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--providers' || arg.startsWith('--providers=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--providers', parsed);
        if (!consumed) return parsed;
        applyServerProvidersOption(consumed.value, parsed);
        if (parsed.error) return parsed;
        i = consumed.next;
      }
      else if (arg === '--password' || arg.startsWith('--password=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--password', parsed);
        if (!consumed) return parsed;
        parsed.serverPassword = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--port' || arg.startsWith('--port=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--port', parsed);
        if (!consumed) return parsed;
        const port = Number(consumed.value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          parsed.error = '--port must be an integer between 1 and 65535';
          return parsed;
        }
        parsed.serverPort = port;
        i = consumed.next;
      }
      else if (!parsed.error) parsed.error = `Unknown server option: ${arg}`;
    }
    return parsed;
  }

  if (first === 'models' || first === 'favorites') {
    const parsed = emptyParsed('models');
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else if (arg === '--list') parsed.favoritesList = true;
      else if (arg === '--alias' || arg.startsWith('--alias=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--alias', parsed);
        if (!consumed) return parsed;
        parsed.favoritesAlias = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--unalias' || arg.startsWith('--unalias=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--unalias', parsed);
        if (!consumed) return parsed;
        parsed.favoritesUnalias = consumed.value;
        i = consumed.next;
      }
      else if (!parsed.error) parsed.error = `Unknown models option: ${arg}`;
    }
    return parsed;
  }

  if (first === 'providers') {
    const parsed = emptyParsed('providers');
    parsed.claudeArgs = [];
    for (const arg of rest) {
      if (arg === '--trace') parsed.trace = true;
      else if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else parsed.claudeArgs.push(arg);
    }
    return parsed;
  }

  if (first === 'patch') {
    const parsed = emptyParsed('patch');
    for (const arg of rest) {
      if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else if (arg === '--restore') parsed.patchRestore = true;
      else if (arg === '--trace') parsed.trace = true;
      else if (!parsed.error) parsed.error = `Unknown patch option: ${arg}`;
    }
    return parsed;
  }

  if (first !== 'claude') {
    return {
      ...emptyParsed('root'),
      error: first.startsWith('-') ? `Unknown root option: ${first}` : `Unknown command: ${first}`,
    };
  }

  const parsed = emptyParsed('claude');
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--') {
      parsed.claudeArgs.push(...rest.slice(i + 1));
      break;
    }

    const consumed = tryConsumeClodexLaunchFlag(arg, rest, i, parsed);
    if (consumed !== null) {
      if ('error' in consumed) return parsed;
      i = consumed.next;
      continue;
    }

    if (!STARTER_CLAUDE_FLAGS.has(arg)) {
      parsed.claudeArgs.push(arg);
      continue;
    }

    if (arg === '--dry-run') parsed.dryRun = true;
    if (arg === '--trace') parsed.trace = true;
    consumeBridgeModeFlag(arg, parsed);
    if (arg === '--help' || arg === '-h') parsed.showHelp = true;
    if (arg === '--version' || arg === '-v') parsed.showVersion = true;
  }

  return parsed;
}

export function rootHelpText(): string {
  return `${pc.bold('clodex')} v${VERSION}
Bridge Claude Code to OpenAI models — OpenAI API key or ChatGPT/Codex-plan OAuth.

${pc.bold('Usage:')}
  clodex claude [options] [claude-flags]
  clodex server [options]
  clodex patch [--restore]
  clodex models
  clodex favorites
  clodex providers
  clodex --help
  clodex --version

${pc.bold('Root options:')}
  -h, --help       Show this help
  -v, --version    Show version

${pc.bold('Commands:')}
  claude      Launch Claude Code bridged to OpenAI models
  server      Run a foreground gateway (endpoint or proxy mode)
  patch       Patch the Claude Code binary so clodex models are first-class
  models      Manage favorite models and aliases (max ${MAX_MODEL_CATALOG})
  favorites   Alias for models
  providers   Add or sign in to your OpenAI providers

${pc.bold('Bridge modes (claude and server):')}
  --endpoint  Local Anthropic-format gateway; Claude Code launches with
              ANTHROPIC_BASE_URL pointed at it (default on first run)
  --proxy     Selective MITM of api.anthropic.com; Claude Code keeps its
              normal Anthropic auth, clodex: models route to OpenAI
              (--http-proxy is an alias)
  Using either flag remembers it as that command's default.

${pc.bold('Examples:')}
  clodex claude
  clodex claude --proxy
  clodex models
  clodex patch
  clodex server
  clodex claude -c
  clodex claude -- --print "hello"`;
}

export function claudeHelpText(): string {
  return `${pc.bold('clodex claude')} v${VERSION}
Launch Claude Code bridged to OpenAI models.

${pc.bold('Usage:')}
  clodex claude [options] [claude-flags]
  clodex claude --help
  clodex claude --version

${pc.bold('Options:')}
  --endpoint   Endpoint bridge mode: local gateway + ANTHROPIC_BASE_URL (persisted)
  --proxy      Proxy bridge mode: keep Claude Code's Anthropic auth; route
               clodex: models to OpenAI (--http-proxy is an alias; persisted)
  --dry-run    Run the wizard but show a preview instead of launching Claude Code
  --trace      Write debug logs to ~/.clodex/logs/ and show errors on exit
  --provider   Boot provider id (skip wizard when paired with --model or in print mode)
  --model      Boot model id (skip wizard when paired with --provider or in print mode)
  --help       Show this command help
  --version    Show version

${pc.bold('Providers:')}
  openai         OpenAI API key (platform.openai.com)
  openai-oauth   ChatGPT/Codex plan OAuth — sign in with clodex providers auth openai

${pc.bold('Model switching:')}
  Run clodex models to save favorites (max ${MAX_MODEL_CATALOG}).
  When favorites exist, endpoint mode starts a multi-route proxy and Claude
  Code /model lists your starting model plus favorites for live switching.
  With no favorites, launch uses a single model.

${pc.bold('Proxy mode:')}
  clodex claude --proxy leaves ANTHROPIC_BASE_URL unset and launches
  Claude Code with its normal Anthropic login. Favorite OpenAI models are
  available by typing /model clodex:<provider-id>:<model-id>.
  Save short names with clodex models --alias, and run --list to print them.
  Run clodex patch to make those names first-class inside Claude Code.

${pc.bold('Note:')}
  Claude Code may save the launched model to ~/.claude/settings.json.
  Bare claude later can still show that model — reset with claude --model sonnet.

${pc.bold('Examples:')}
  clodex claude
  clodex claude -c
  clodex claude --resume abc-123
  clodex claude --dry-run -c
  clodex claude --trace --resume abc-123
  clodex claude --proxy
  clodex claude --provider openai-oauth --model gpt-5.6-sol
  clodex claude -- --print "hello"
  clodex claude -- --dangerously-skip-permissions`;
}

export function serverHelpText(): string {
  return `${pc.bold('clodex server')} v${VERSION}
Run a foreground gateway bridging Anthropic-format requests to OpenAI models.

${pc.bold('Usage:')}
  clodex server
  clodex server --quick
  clodex server --listen network --password <password>
  clodex server --proxy
  clodex server --help
  clodex server --version

${pc.bold('Options:')}
  --endpoint                   Endpoint mode: Anthropic-format HTTP gateway (persisted)
  --proxy                      Proxy mode: selective api.anthropic.com MITM proxy
                               (--http-proxy is an alias; persisted; local only)
  --quick, --saved             Start immediately from saved/default settings
  --listen local|network       One-run listen mode override
  --providers all|favorites|id1,id2
                               One-run provider catalog override
  --mask-gateway-ids           Mask provider names in Anthropic model ids
  --no-mask-gateway-ids        Keep provider names in Anthropic model ids
  --password <value>           One-run network-mode server password
  --port <1-65535>             Listen port (default 17645); applies to both modes
  --ws-diagnostics             Log sanitized request envelopes and WebSocket head decisions

${pc.bold('Behavior:')}
  Endpoint default: interactive wizard for exposed providers, discovery id
  masking, optional favorites-only catalog, then listen mode. Quick mode skips
  prompts and uses saved settings. Any one-run option also starts without
  prompts. Non-interactive stdin uses quick mode automatically. Network quick
  mode requires a saved password or --password.
  Binds to port 17645 (override with --port). Network mode asks for a password.

${pc.bold('Proxy mode env:')}
  Start clodex server --proxy, then export the HTTPS_PROXY, HTTP_PROXY,
  and NODE_EXTRA_CA_CERTS values it prints. Do not set ANTHROPIC_BASE_URL.

${pc.bold('Gateway endpoints (endpoint mode):')}
  Anthropic-compatible:  ANTHROPIC_BASE_URL=http://127.0.0.1:17645/anthropic
  OpenAI-compatible:     OPENAI_BASE_URL=http://127.0.0.1:17645/openai/v1
  API key: use anything locally; use the server password in network mode.`;
}

export function modelsHelpText(): string {
  return `${pc.bold('clodex favorites')} v${VERSION}
Manage favorite models for mid-session switching.

${pc.bold('Usage:')}
  clodex favorites
  clodex models --list
  clodex models --alias sol=clodex:openai-oauth:gpt-5.6-sol
  clodex models --unalias sol
  clodex models
  clodex favorites --help
  clodex favorites --version

${pc.bold('Behavior:')}
  Opens an interactive manager to add or remove favorites.
  Search all providers at once (paginated results) or browse one provider at a time.
  Favorites are saved to ~/.clodex/config.json (max ${MAX_MODEL_CATALOG}).
  --list prints the exact clodex:<provider-id>:<model-id> names available in
  proxy mode, without opening the interactive manager.
  --alias <name=target> saves a short name for a proxy-mode favorite. The
  target is clodex:<provider-id>:<model-id> (the clodex: prefix is optional).
  --unalias <name> removes a saved short name.

${pc.bold('How it works:')}
  claude and server use the global favorites list.
  Favorites appear in the /model switch menu (endpoint mode) and are routable
  by name in proxy mode. clodex patch bakes favorites + aliases into the
  Claude Code binary so they pass model validation and report real context.

${pc.bold('Examples:')}
  clodex favorites
  clodex models --alias sol=clodex:openai-oauth:gpt-5.6-sol
  clodex claude    # switch menu active when favorites are set`;
}

export function patchHelpText(): string {
  return `${pc.bold('clodex patch')} v${VERSION}
Patch the installed Claude Code binary so clodex favorites and aliases are
first-class: accepted by the Agent tool, listed in /model, resolved to their
real ids, and reporting the correct context window.

${pc.bold('Usage:')}
  clodex patch
  clodex patch --restore
  clodex patch --help

${pc.bold('Options:')}
  --restore    Restore the pristine (unpatched) Claude Code binary
  --trace      Show the underlying tweakcc output

${pc.bold('Behavior:')}
  The patch map is built automatically from your clodex favorites and aliases
  (clodex models); context windows come from provider metadata. A pristine
  per-version backup is kept, and a manifest (~/.clodex/patch-state.json)
  makes re-runs no-ops until your config or Claude Code version changes —
  then the binary is restored first and re-patched fresh.
  Run clodex patch again after every claude update.`;
}

function printHelp(text: string): void {
  console.log(`\n${text}\n`);
}

async function launchClaudeViaCatalog(
  catalogRoutes: ProxyRoute[],
  startingRoute: ProxyRoute,
  contextWindow: number | undefined,
  trace: boolean,
  claudeArgs: string[],
): Promise<number> {
  let proxyHandle: ProxyHandle;
  try {
    proxyHandle = await startProxyCatalog(catalogRoutes, startingRoute.aliasId, trace);
    p.log.info(
      `Switch menu active — proxy on port ${proxyHandle.port} ` +
      pc.dim(`(${catalogRoutes.length} model${catalogRoutes.length !== 1 ? 's' : ''} in /model)`),
    );
  } catch (err) {
    p.log.error(`Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const childEnv = buildChildEnv(
    `http://127.0.0.1:${proxyHandle.port}`,
    startingRoute.aliasId,
    proxyHandle.token,
    proxyHandle.port,
    contextWindow,
    true,
  );

  const debugLogPath = prepareClaudeTraceLog();
  const traceArgs = trace ? ['--debug-file', debugLogPath] : [];
  if (trace) p.log.info(`Debug log: ${debugLogPath}`);

  const exitCode = await launchClaude(
    childEnv,
    claudeCodeClientModelId(startingRoute.aliasId, contextWindow),
    [...traceArgs, ...claudeArgs],
  );
  proxyHandle.close();
  if (trace) printTraceLog(debugLogPath);
  return exitCode;
}

interface FavoritesCommandOptions {
  list?: boolean;
  alias?: string;
  unalias?: string;
}

export async function runModelsCommand(opts: FavoritesCommandOptions = {}): Promise<number> {
  const changesAlias = opts.alias !== undefined || opts.unalias !== undefined;
  if (changesAlias && (opts.list || (opts.alias !== undefined && opts.unalias !== undefined))) {
    p.log.error('--alias/--unalias apply one at a time to proxy-mode favorites.');
    return 1;
  }
  if (opts.alias !== undefined) {
    const parsed = parseModelAliasAssignment(opts.alias);
    if ('error' in parsed) {
      p.log.error(parsed.error);
      return 1;
    }
    const prefs = loadPreferences();
    const isSavedFavorite = (prefs.favoriteModels ?? []).some(
      favorite => favorite.providerId === parsed.providerId && favorite.modelId === parsed.modelId,
    );
    if (!isSavedFavorite) {
      p.log.error(`${modelAliasTarget(parsed)} is not a saved favorite.`);
      p.log.info('Add it with `clodex models`, then save the alias.');
      return 1;
    }
    const modelAliases = (prefs.modelAliases ?? []).filter(alias => alias.name !== parsed.name);
    modelAliases.push(parsed);
    savePreferences({ modelAliases });
    p.log.success(`Saved model alias ${parsed.name} → ${modelAliasTarget(parsed)}.`);
    return 0;
  }
  if (opts.unalias !== undefined) {
    const name = opts.unalias.trim();
    if (!isValidModelAlias(name)) {
      p.log.error('Alias names must be 1-64 letters, numbers, dots, underscores, or hyphens.');
      return 1;
    }
    const prefs = loadPreferences();
    const aliases = prefs.modelAliases ?? [];
    const modelAliases = aliases.filter(alias => alias.name !== name);
    if (modelAliases.length === aliases.length) {
      p.log.error(`No model alias named ${name} is saved.`);
      return 1;
    }
    savePreferences({ modelAliases });
    p.log.success(`Removed model alias ${name}.`);
    return 0;
  }
  if (opts.list) {
    try {
      const loaded = await loadHttpProxyRoutes();
      printHttpProxyModels(loaded.routes, loaded.aliases);
      reportSkippedHttpProxyFavorites(loaded);
      return 0;
    } catch (err) {
      p.log.error(`Could not load proxy models: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const maxFavorites = MAX_MODEL_CATALOG;
  const scopeName = 'Favorite Models';
  relayIntro(scopeName);

  const spinner = p.spinner();
  spinner.start('Loading providers...');

  const catalog = await fetchProviderCatalog();
  spinner.stop('');

  const allProviders = providersForPicker(catalog);
  const favoriteProviders = allProviders.map(provider => ({
    ...provider,
    name: favoriteProviderDisplayName(provider),
  }));

  if (favoriteProviders.length === 0) {
    p.log.warn('No providers found.');
    p.log.info(`${pc.dim('Add a provider with ')}${pc.cyan('clodex providers')}${pc.dim('.')}`);
    relayOutro('Done');
    return 0;
  }

  // Build a flat name lookup: "providerId:modelId" → display label
  const modelLookup = new Map<string, { modelName: string; providerName: string }>();
  for (const ap of favoriteProviders) {
    for (const m of ap.models) {
      modelLookup.set(`${ap.id}:${m.id}`, { modelName: m.name || m.id, providerName: ap.name });
    }
  }

  const prefs = loadPreferences();
  let favorites = prefs.favoriteModels ?? [];
  let favoritesDirty = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    type MenuChoice = string;
    const options: Array<{ value: MenuChoice; label: string; hint: string }> = [];

    // One entry per saved favorite; selecting it removes it
    for (let i = 0; i < favorites.length; i++) {
      const fav = favorites[i]!;
      const entry = modelLookup.get(`${fav.providerId}:${fav.modelId}`);
      const label = entry
        ? `${fmtEnabledStar(true)} ${fmtModel(entry.modelName)} ${pc.dim(`(${entry.providerName})`)}`
        : pc.dim(`★ ${fav.modelId} — provider gone`);
      options.push({ value: `fav-${i}`, label, hint: 'select to remove' });
    }

    const atCap = favorites.length >= maxFavorites;
    options.push({
      value: '__add__',
      label: atCap ? pc.dim(`+ Add a model → (limit of ${maxFavorites} reached)`) : pc.cyan('+ Add a model →'),
      hint: atCap
        ? 'Remove a favorite first to make room'
        : `${allProviders.length} provider${allProviders.length !== 1 ? 's' : ''} available`,
    });
    options.push({ value: '__done__', label: 'Done', hint: '' });

    const header = favorites.length === 0
      ? `${scopeName} (0/${maxFavorites})`
      : `${scopeName} (${favorites.length}/${maxFavorites}) — select to remove`;

    const choice = await p.select<string>({
      message: header,
      options,
      initialValue: '__done__',
    });

    if (p.isCancel(choice) || choice === '__done__') break;

    if (choice === '__add__') {
      if (atCap) {
        p.log.warn(`Limit of ${maxFavorites} favorites reached — remove one first.`);
        continue;
      }

      const globalCount = buildGlobalFavoriteIndex(favoriteProviders).length;
      const addPath = await p.select<string>({
        message: 'Add a favorite',
        options: [
          {
            value: 'global',
            label: pc.cyan('Search all providers'),
                hint: `${globalCount} models · ${favoriteProviders.length} provider${favoriteProviders.length !== 1 ? 's' : ''}`,
          },
          {
            value: 'provider',
            label: pc.cyan('Browse by provider →'),
            hint: 'Pick one provider first',
          },
        ],
      });
      if (p.isCancel(addPath)) continue;

      let provider: LocalProvider | undefined;
      let browsedMultiple: LocalProviderModel[] = [];

      if (addPath === 'global') {
        const globalPick = await pickGlobalFavoriteModel(favoriteProviders, favorites);
        if (globalPick === null) continue;
        if (globalPick !== browseByProviderChoice) {
          provider = favoriteProviders.find(ap => ap.id === globalPick.providerId);
          browsedMultiple = [globalPick.model];
        }
      }

      if (browsedMultiple.length === 0) {
        let currentInitialProvider: string | undefined = undefined;
        while (true) {
          const providerOptions = favoriteProviders.map(ap => providerSelectOption(ap));
          const pickedProviderId: string | symbol = await p.select({
            message: 'Which provider?',
            options: providerOptions,
            initialValue: currentInitialProvider,
          });
          if (p.isCancel(pickedProviderId)) break;

          provider = favoriteProviders.find(ap => ap.id === pickedProviderId)!;

          const options = provider.models.map(m => {
            const favorited = isFavorite(favorites, { providerId: provider!.id, modelId: m.id });
            const label = formatModelLabel(m);
            return {
              value: m.id,
              label: fmtModel(label, m.id),
              hint: favorited ? pc.yellow('★ already favorite') : '',
            };
          });

          const pickedModelIds = await p.multiselect({
            message: `Select models to add from ${provider.name} ${pc.dim('(Space to select, Enter to confirm)')}`,
            options,
            required: false,
          });

          if (p.isCancel(pickedModelIds)) {
            currentInitialProvider = provider.id;
            continue;
          }

          if (pickedModelIds.length === 0) {
            currentInitialProvider = provider.id;
            continue;
          }

          browsedMultiple = provider.models.filter(m => (pickedModelIds as string[]).includes(m.id));
          break;
        }
        if (browsedMultiple.length === 0) continue;
      }

      const addedModels: LocalProviderModel[] = [];
      let duplicateCount = 0;
      let limitReached = false;

      for (const model of browsedMultiple) {
        const fav: FavoriteModel = { providerId: provider!.id, modelId: model.id };
        const result = addFavorite(favorites, fav, maxFavorites);
        if (!result.ok) {
          if (result.reason === 'duplicate') {
            duplicateCount++;
          } else {
            limitReached = true;
            break;
          }
        } else {
          favorites = result.list;
          favoritesDirty = true;
          addedModels.push(model);
        }
      }

      if (addedModels.length > 0) {
        if (addedModels.length === 1) {
          const modelName = addedModels[0].name || addedModels[0].id;
          p.log.success(`Added ${modelName} (${provider!.name}) to favorites.`);
        } else {
          p.log.success(`Added ${addedModels.length} models from ${provider!.name} to favorites.`);
        }
      }
      if (duplicateCount > 0) {
        p.log.warn(`${duplicateCount} selected model(s) were already in your favorites.`);
      }
      if (limitReached) {
        p.log.warn(`Limit of ${maxFavorites} favorites reached — some selected models could not be added.`);
      }
    } else if ((choice as string).startsWith('fav-')) {
      const idx = parseInt((choice as string).slice(4), 10);
      const fav = favorites[idx]!;
      const entry = modelLookup.get(`${fav.providerId}:${fav.modelId}`);
      const label = entry ? `${entry.modelName} (${entry.providerName})` : fav.modelId;
      const confirmed = await p.confirm({ message: `Remove ${label} from favorites?` });
      if (p.isCancel(confirmed) || !confirmed) continue;
      favorites = removeFavorite(favorites, fav);
      favoritesDirty = true;
      p.log.success(`Removed ${label} from favorites.`);
    }
  }

  if (favoritesDirty) {
    savePreferences({ favoriteModels: favorites });
  }

  relayOutro(
    favorites.length === 0
      ? 'No favorites saved'
      : `${favorites.length} favorite${favorites.length !== 1 ? 's' : ''} saved`,
    favorites.length === 0
      ? pc.dim('Launch uses single-model mode')
      : pc.cyan('/model menu ready on next launch'),
  );
  return 0;
}

async function runClaudeHttpProxyCommand(
  parsed: ParsedArgs,
  claudeArgs: string[],
  agentStdout: boolean,
): Promise<number> {
  if (parsed.launchProvider || parsed.launchModel) {
    p.log.error('--provider/--model select endpoint-mode routes and cannot be combined with --proxy.');
    p.log.info('Use `-- --model clodex:<provider-id>:<model-id>` to start on a listed proxy-mode favorite.');
    return 1;
  }

  if (!agentStdout) relayIntro('Claude Code — Proxy Mode');

  if (parsed.dryRun) {
    try {
      const loaded = await loadHttpProxyRoutes();
      console.log('');
      console.log(pc.bold(pc.cyan('  DRY RUN — proxy bridge mode')));
      console.log('  ANTHROPIC_BASE_URL is not set by clodex.');
      console.log('  HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:<random-port>');
      console.log('  NODE_EXTRA_CA_CERTS=~/.clodex/http-proxy/clodex-ca.pem');
      console.log('');
      printHttpProxyModels(loaded.routes, loaded.aliases);
      reportSkippedHttpProxyFavorites(loaded);
      console.log('');
      return 0;
    } catch (err) {
      p.log.error(`Could not load proxy models: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const inferenceLogPath = getInferenceSessionLogPath('claude-http-proxy');
  const proxyDebugLogPath = parsed.trace ? getSessionLogPath('claude-proxy-debug') : undefined;
  let started: Awaited<ReturnType<typeof startConfiguredHttpProxy>>;
  try {
    started = await startConfiguredHttpProxy(0, parsed.trace, inferenceLogPath, proxyDebugLogPath);
  } catch (err) {
    p.log.error(`Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { handle, loaded } = started;
  const inheritedProxyPort = (() => {
    const value = process.env['HTTPS_PROXY'] ?? process.env['HTTP_PROXY']
      ?? process.env['https_proxy'] ?? process.env['http_proxy'];
    if (!value) return undefined;
    try {
      const parsedUrl = new URL(value);
      return (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost') && parsedUrl.port
        ? Number(parsedUrl.port)
        : undefined;
    } catch {
      return undefined;
    }
  })();
  writeProxyLifecycleLog(inferenceLogPath, {
    event: 'proxy_started',
    pid: process.pid,
    parentPid: process.ppid,
    host: handle.host,
    port: handle.port,
    inheritedProxyPort,
  });
  let cleanlyStopped = false;
  const onProcessExit = (exitCode: number) => {
    if (cleanlyStopped) return;
    writeProxyLifecycleLog(inferenceLogPath, {
      event: 'proxy_process_exit',
      pid: process.pid,
      parentPid: process.ppid,
      port: handle.port,
      exitCode,
      reason: 'process exited before proxy cleanup completed',
    });
  };
  process.once('exit', onProcessExit);
  if (!agentStdout) {
    p.log.info(`Proxy started on port ${handle.port}; Claude Code's Anthropic auth remains active.`);
    p.log.info(`Inference request log: ${handle.inferenceLogPath}`);
    printHttpProxyModels(loaded.routes, loaded.aliases);
    reportSkippedHttpProxyFavorites(loaded);
    if (loaded.routes.length > 0) {
      p.log.info('Switch with `/model <listed-name>`.');
    }
  }

  const childEnv = buildHttpProxyChildEnv(handle.port, handle.caCertPath);
  const debugLogPath = parsed.trace
    ? prepareClaudeTraceLog(getSessionLogPath('claude-debug'))
    : undefined;
  const traceArgs = debugLogPath ? ['--debug-file', debugLogPath] : [];
  if (debugLogPath && !agentStdout) {
    p.log.info(`Claude debug log: ${debugLogPath}`);
    if (proxyDebugLogPath) p.log.info(`Adapter debug log: ${proxyDebugLogPath}`);
  }

  try {
    const exitCode = await launchClaude(childEnv, undefined, [...traceArgs, ...claudeArgs]);
    if (debugLogPath) printTraceLog(debugLogPath);
    return exitCode;
  } finally {
    writeProxyLifecycleLog(inferenceLogPath, {
      event: 'proxy_stopping',
      pid: process.pid,
      parentPid: process.ppid,
      port: handle.port,
      reason: 'Claude child exited',
    });
    await handle.close();
    cleanlyStopped = true;
    process.off('exit', onProcessExit);
    writeProxyLifecycleLog(inferenceLogPath, {
      event: 'proxy_stopped',
      pid: process.pid,
      parentPid: process.ppid,
      port: handle.port,
    });
  }
}

export async function runClaudeCommand(parsed: ParsedArgs): Promise<number> {
  const { dryRun, trace, launchProvider, launchModel } = parsed;
  const claudeArgs = normalizeClaudeAgentArgs(parsed.claudeArgs);
  const agentStdout = wantsCleanAgentStdout('claude', claudeArgs);
  setAgentStdoutMode(agentStdout);

  // Prerequisite: claude binary
  const claudePath = findClaudeBinary();
  if (!claudePath) {
    console.error(pc.red('\nError: claude binary not found on PATH.\n'));
    console.error('Install Claude Code:');
    console.error('  npm install -g @anthropic-ai/claude-code\n');
    return 1;
  }

  const bridgeMode = resolveBridgeMode('claude', parsed.bridgeMode, { persist: !dryRun });

  // Launch-time patch check: prompt on TTY, notice otherwise. Never blocks the launch.
  if (!dryRun) {
    await runLaunchPatchCheck({ agentStdout });
  }

  if (bridgeMode === 'proxy') {
    return runClaudeHttpProxyCommand(parsed, claudeArgs, agentStdout);
  }

  const prefs = dryRun ? {} as ReturnType<typeof loadPreferences> : loadPreferences();
  const conflicts = detectConflicts();

  const favorites = dryRun ? [] : (prefs.favoriteModels ?? []);
  const launchPlan = planLaunchWizard({
    explicit: { providerId: launchProvider, modelId: launchModel },
    childArgs: claudeArgs,
    agent: 'claude',
    prefs,
  });
  if (launchPlan.error) {
    console.error(pc.red(`\nError: ${launchPlan.error}\n`));
    return 1;
  }
  const switchMenuActive = favorites.length > 0 && !launchPlan.skip;

  if (!agentStdout) relayIntro('Claude Code');

  if (!dryRun && await needsFirstRunSetup()) {
    const firstRun = await runFirstRunWizard(trace);
    if (firstRun === 'cancel') return 0;
  }

  let catalog: Awaited<ReturnType<typeof fetchProviderCatalog>>;
  if (agentStdout) {
    try {
      catalog = await fetchProviderCatalog();
    } catch (err) {
      console.error(pc.red(String(err instanceof Error ? err.message : err)));
      return 1;
    }
  } else {
    const catalogSpinner = p.spinner();
    catalogSpinner.start('Loading your providers...');
    try {
      catalog = await fetchProviderCatalog();
    } catch (err) {
      catalogSpinner.stop('');
      console.error(pc.red(String(err instanceof Error ? err.message : err)));
      return 1;
    }
    catalogSpinner.stop('');
  }

  const allProviders = providersForTarget(providersForPicker(catalog), 'claude');
  if (allProviders.length === 0) {
    p.log.warn('No providers available.');
    p.log.info(pc.dim('Run clodex providers to get started.'));
    return 0;
  }

  const providerOptions = allProviders.map(lp => providerSelectOption(lp));

  if (switchMenuActive) {
    providerOptions.unshift({
      value: '__favorites__',
      label: '⭐ Favorites Catalog',
      hint: `${favorites.length} saved favorites`,
    });
  }

  const initialProvider =
    prefs.lastProvider && providerOptions.some(o => o.value === prefs.lastProvider)
      ? prefs.lastProvider
      : providerOptions[0]!.value;

  let activeProvider: LocalProvider;
  let selectedModel: LocalProviderModel;

  if (launchPlan.skip && launchPlan.target) {
    const resolved = findProviderAndModel(allProviders, launchPlan.target);
    if (!resolved) {
      p.log.error(
        `Provider/model not found: ${launchPlan.target.providerId} / ${launchPlan.target.modelId}`,
      );
      return 1;
    }
    activeProvider = resolved.provider;
    selectedModel = resolved.model;
    if (!agentStdout) {
      p.log.step(`Using ${selectedModel.name || selectedModel.id} (${activeProvider.name})`);
    }
    if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
  } else {
    let currentInitialProvider = initialProvider;
    while (true) {
      const chosen = await p.select<string>({
        message: 'Which provider?',
        options: providerOptions,
        initialValue: currentInitialProvider,
      });

      if (p.isCancel(chosen)) {
        p.cancel('Cancelled.');
        return 0;
      }

      const providerChoice = chosen as string;

      if (providerChoice === '__favorites__') {
        const available: Array<{ provider: LocalProvider; model: LocalProviderModel }> = [];
        for (const fav of favorites) {
          const prov = allProviders.find(lp => lp.id === fav.providerId);
          const mod = prov?.models.find(m => m.id === fav.modelId);
          if (prov && mod) available.push({ provider: prov, model: mod });
        }
        if (available.length === 0) {
          p.log.warn('No saved favorites are currently available.');
          return 0;
        }
        const favOptions = available.map((f, i) => ({
          value: String(i),
          label: `${f.model.name || f.model.id} — ${f.provider.name}`,
          hint: f.model.id,
        }));
        const pickedIdx = await p.select<string>({
          message: 'Starting model?',
          options: favOptions,
          initialValue: '0',
        });
        if (p.isCancel(pickedIdx)) { p.cancel('Cancelled.'); return 0; }
        const sel = available[Number(pickedIdx)]!;
        activeProvider = sel.provider;
        selectedModel = sel.model;
        if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
        break;
      } else {
        activeProvider = allProviders.find(lp => lp.id === providerChoice)!;
        const pickedModelResult = await pickLocalModel(activeProvider, conflicts, prefs);
        if (pickedModelResult === 'back') {
          currentInitialProvider = activeProvider.id;
          continue;
        }
        if (!pickedModelResult) return 0;
        selectedModel = pickedModelResult;

        if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
        break;
      }
    }
  }

  const localProviders = catalog.length > 0 ? catalog : null;
  if (switchMenuActive) {
    const resolveRoute = makeRouteResolver(
      localProviders,
    );
    const startingRoute = resolveRoute(activeProvider.id, selectedModel.id) ?? null;
    if (!startingRoute) {
      p.log.error('Could not resolve a proxy route for the selected model.');
      return 1;
    }
    const { routes: catalogRoutes, droppedFavorites } = buildCatalogRoutes(startingRoute, favorites, resolveRoute);
    if (droppedFavorites.length > 0) {
      p.log.warn(
        `Skipping ${droppedFavorites.length} favorite${droppedFavorites.length === 1 ? '' : 's'} `
        + 'that are no longer available in /model',
      );
    }

    if (dryRun) {
      const endpoint = selectedModel.baseUrl ?? selectedModel.completionsUrl ?? '(unknown)';
      console.log('');
      console.log(pc.bold(pc.cyan('  DRY RUN — would execute (switch-menu mode):')));
      console.log('');
      console.log(`  ${pc.bold('Provider:')}      ${activeProvider.name}`);
      console.log(`  ${pc.bold('Starting model:')} ${selectedModel.id}`);
      console.log(`  ${pc.bold('Endpoint:')}      ${endpoint}`);
      console.log(`  ${pc.bold('/model catalog:')} ${catalogRoutes.length} model(s)`);
      catalogRoutes.forEach(r => console.log(`    ${pc.dim(r.displayName)}`));
      console.log('');
      console.log(pc.dim('  (dry run complete — Claude Code was NOT launched)'));
      console.log('');
      return 0;
    }

    return launchClaudeViaCatalog(
      catalogRoutes,
      startingRoute,
      selectedModel.contextWindow,
      trace,
      claudeArgs,
    );
  }

  // ── Single-model path ──

  if (dryRun) {
    const formatDesc = selectedModel.modelFormat === 'anthropic'
      ? 'direct passthrough'
      : 'via SDK adapter proxy';
    const endpoint = selectedModel.modelFormat === 'anthropic'
      ? (selectedModel.baseUrl ?? '(unknown)')
      : (selectedModel.npm ?? 'SDK');
    console.log('');
    console.log(pc.bold(pc.cyan('  DRY RUN — would execute:')));
    console.log('');
    console.log(`  ${pc.bold('Provider:')}  ${activeProvider.name}`);
    console.log(`  ${pc.bold('Model:')}     ${selectedModel.id}`);
    console.log(`  ${pc.bold('Format:')}    ${selectedModel.modelFormat} (${formatDesc})`);
    console.log(`  ${pc.bold(selectedModel.modelFormat === 'anthropic' ? 'Endpoint:' : 'SDK npm:')} ${endpoint}`);
    console.log(`  ${pc.bold('Key:')}       ${activeProvider.name} provider key`);
    console.log('');
    console.log(pc.dim('  (dry run complete — Claude Code was NOT launched)'));
    console.log('');
    return 0;
  }

  const launchApiKey = await resolveLocalProviderApiKey(activeProvider);
  if (!launchApiKey?.trim()) {
    p.log.error(
      `No credential found for ${activeProvider.name}. Add a key or sign in with clodex providers.`,
    );
    return 1;
  }

  let proxyHandle: ProxyHandle | null = null;
  let childEnv: NodeJS.ProcessEnv;

  const isOAuthAnthropic = selectedModel.modelFormat === 'anthropic' && activeProvider.authType === 'oauth';

  if (isOAuthAnthropic) {
    // Anthropic OAuth passthrough — proxy injects compatibility metadata and Bearer auth.
    try {
      proxyHandle = await startProxy(
        selectedModel.baseUrl ?? 'https://api.anthropic.com',
        selectedModel.id,
        trace,
        selectedModel.contextWindow,
        {
          providerId: activeProvider.id,
          authType: 'oauth',
          oauthAccountId: activeProvider.oauthAccountId,
          providerData: activeProvider.providerData,
          modelFormat: 'anthropic',
        },
        launchApiKey,
      );
      if (!isAgentStdoutMode()) p.log.info(`OAuth proxy started on port ${proxyHandle.port}`);
    } catch (err) {
      p.log.error(`Failed to start OAuth proxy: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    childEnv = buildChildEnv(
      `http://127.0.0.1:${proxyHandle.port}`,
      selectedModel.id,
      proxyHandle.token,
      proxyHandle.port,
      selectedModel.contextWindow,
    );
  } else if (selectedModel.modelFormat === 'anthropic') {
    childEnv = buildChildEnv(
      selectedModel.baseUrl!,
      selectedModel.id,
      launchApiKey,
      undefined,
      selectedModel.contextWindow,
    );
  } else {
    try {
      proxyHandle = await startProxy(
        selectedModel.completionsUrl ?? '',
        selectedModel.id,
        trace,
        selectedModel.contextWindow,
        {
          npm: selectedModel.npm,
          baseURL: selectedModel.apiBaseUrl,
          upstreamModelId: selectedModel.upstreamModelId,
          providerId: activeProvider.id,
          authType: activeProvider.authType,
          oauthAccountId: activeProvider.oauthAccountId,
          supportedParameters: selectedModel.supportedParameters,
          reasoning: selectedModel.reasoning,
          interleavedReasoningField: selectedModel.interleavedReasoningField,
          useResponsesLite: selectedModel.useResponsesLite,
          preferWebSockets: selectedModel.preferWebSockets,
        },
        launchApiKey,
      );
      if (!isAgentStdoutMode()) {
        p.log.info(
          `SDK adapter proxy started on port ${proxyHandle.port}` +
          (selectedModel.npm ? pc.dim(` (${selectedModel.npm})`) : ''),
        );
      }
    } catch (err) {
      p.log.error(`Failed to start SDK adapter proxy: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    childEnv = buildChildEnv(
      `http://127.0.0.1:${proxyHandle.port}`,
      selectedModel.id,
      proxyHandle.token,
      proxyHandle.port,
      selectedModel.contextWindow,
    );
  }

  if (selectedModel.modelFormat === 'anthropic' && !isOAuthAnthropic) {
    childEnv['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'] = '1';
  }

  const debugLogPath = prepareClaudeTraceLog();
  const traceArgs = trace ? ['--debug-file', debugLogPath] : [];
  if (trace) p.log.info(`Debug log: ${debugLogPath}`);

  const exitCode = await launchClaude(
    childEnv,
    claudeCodeClientModelId(selectedModel.id, selectedModel.contextWindow),
    [...traceArgs, ...claudeArgs],
  );
  proxyHandle?.close();
  if (trace) printTraceLog(debugLogPath);
  return exitCode;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.error) {
    console.error(pc.red(`\nError: ${parsed.error}\n`));
    printHelp(rootHelpText());
    return 1;
  }

  if (!parsed.showVersion) {
    refreshModelsDevCacheAsync();
  }

  if (parsed.command === 'root') {
    if (parsed.showVersion) {
      console.log(VERSION);
    } else {
      printHelp(rootHelpText());
    }
    return 0;
  }

  if (parsed.command === 'server') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(serverHelpText());
      return 0;
    }
    const bridgeMode = resolveBridgeMode('server', parsed.bridgeMode);
    return runServerCommand({
      httpProxy: bridgeMode === 'proxy',
      quick: parsed.serverQuick,
      listenMode: parsed.serverListenMode,
      providersMode: parsed.serverProvidersMode,
      providerIds: parsed.serverProviderIds,
      maskGatewayIds: parsed.serverMaskGatewayIds,
      password: parsed.serverPassword,
      wsDiagnostics: parsed.serverWsDiagnostics,
      port: parsed.serverPort,
    });
  }

  if (parsed.command === 'models') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(modelsHelpText());
      return 0;
    }
    return runModelsCommand({
      list: parsed.favoritesList,
      alias: parsed.favoritesAlias,
      unalias: parsed.favoritesUnalias,
    });
  }

  if (parsed.command === 'providers') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(providersHelpText());
      return 0;
    }
    if (parsed.trace) {
      process.env.CLODEX_TRACE = '1';
    }
    return runProvidersCommand(parsed.claudeArgs);
  }

  if (parsed.command === 'patch') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(patchHelpText());
      return 0;
    }
    return runPatchCommand({ restore: parsed.patchRestore, trace: parsed.trace });
  }

  if (parsed.showVersion) {
    console.log(VERSION);
    return 0;
  }
  if (parsed.showHelp) {
    printHelp(claudeHelpText());
    return 0;
  }

  return runClaudeCommand(parsed);
}

function isCliEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((err: unknown) => {
    if (err === Symbol.for('clack:cancel')) {
      process.exit(0);
    }
    console.error(pc.red('\nUnexpected error:'), err);
    process.exit(1);
  });
}
