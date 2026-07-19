// src/providers-command.ts — clodex providers command

import pc from 'picocolors';
import * as p from '@clack/prompts';
import { resolveProviderCredential } from './env.js';
import {
  formatRegistryAuthLabel,
  resolveProvidersForDisplay,
  type ProviderDisplayEntry,
} from './provider-catalog.js';
import {
  listAddableTemplates,
  listVisibleOAuthTemplates,
  getTemplateById,
} from './provider-templates.js';
import { addProviderFromTemplate } from './registry/add-template.js';
import {
  removeProviderFromRegistry,
  toggleProviderEnabled,
} from './registry/crud.js';
import { loadRegistry } from './registry/io.js';
import { refreshAllProviderModels, refreshProviderModels } from './registry/refresh-models.js';
import { resolveRefreshCredential } from './registry/refresh-credentials.js';
import { authenticateProvider, providerAuthHelpText, type ProviderAuthMethod } from './registry/provider-auth.js';
import { supportsNativeOAuth } from './oauth/types.js';
import { browseAllModels } from './prompts.js';
import { cachedModelToLocal } from './registry/materialize.js';
import { loadPreferences } from './config.js';
import type { LocalProvider } from './types.js';
import {
  fmtEnabledStar,
  fmtProvider,
  fmtUrl,
  logConnected,
  printPanel,
  printProviderDetailPanel,
  relayIntro,
} from './ui.js';

export type ProvidersSubcommand = 'hub' | 'add' | 'list' | 'remove' | 'refresh-models' | 'auth' | 'help';

export function parseProvidersArgs(args: string[]): {
  subcommand: ProvidersSubcommand;
  showHelp: boolean;
  removeId?: string;
  authMethod?: ProviderAuthMethod;
  error?: string;
} {
  if (args.length === 0) return { subcommand: 'hub', showHelp: false };
  const [first, ...rest] = args;
  if (first === '--help' || first === '-h') return { subcommand: 'help', showHelp: true };
  if (first === 'add') {
    if (rest.length > 0) return { subcommand: 'add', showHelp: false, error: `Unknown add option: ${rest[0]}` };
    return { subcommand: 'add', showHelp: false };
  }
  if (first === 'list') {
    if (rest.length > 0) return { subcommand: 'list', showHelp: false, error: `Unknown list option: ${rest[0]}` };
    return { subcommand: 'list', showHelp: false };
  }
  if (first === 'auth') {
    if (rest.length === 0) return { subcommand: 'auth', showHelp: true };
    let authMethod: ProviderAuthMethod | undefined;
    const positional: string[] = [];
    for (const arg of rest) {
      if (arg === '--native') authMethod = 'native';
      else if (arg.startsWith('-')) {
        return { subcommand: 'auth', showHelp: false, error: `Unknown auth option: ${arg}` };
      } else {
        positional.push(arg);
      }
    }
    if (positional.length !== 1) {
      return { subcommand: 'auth', showHelp: false, error: 'Usage: clodex providers auth <id>' };
    }
    return { subcommand: 'auth', showHelp: false, removeId: positional[0], authMethod };
  }
  if (first === 'remove') {
    if (rest.length === 0) return { subcommand: 'remove', showHelp: false, error: 'Usage: clodex providers remove <id>' };
    if (rest.length > 1) return { subcommand: 'remove', showHelp: false, error: `Unknown remove option: ${rest[1]}` };
    return { subcommand: 'remove', showHelp: false, removeId: rest[0] };
  }
  if (first === 'refresh-models') {
    if (rest.length === 0) return { subcommand: 'refresh-models', showHelp: false };
    if (rest.length > 1) return { subcommand: 'refresh-models', showHelp: false, error: `Unknown refresh-models option: ${rest[1]}` };
    return { subcommand: 'refresh-models', showHelp: false, removeId: rest[0] };
  }
  return { subcommand: 'hub', showHelp: false, error: `Unknown providers subcommand: ${first}` };
}

export function providersHelpText(): string {
  return `${pc.bold('clodex providers')} — manage your OpenAI providers

${pc.bold('Usage:')}
  clodex providers
  clodex providers add
  clodex providers list
  clodex providers remove <id>
  clodex providers refresh-models [id]
  clodex providers auth openai

${pc.bold('Subcommands:')}
  (none)      Provider hub wizard
  add         Add OpenAI with an API key
  auth        Sign in with ChatGPT/Codex-plan OAuth (device code)
  list        Show configured providers
  remove      Remove a provider by id
  refresh-models  Update cached model lists`;
}

function providerLabel(name: string, modelCount: number, enabled: boolean): string {
  return `${fmtEnabledStar(enabled)} ${fmtProvider(name)} ${pc.dim(`(${modelCount} model${modelCount === 1 ? '' : 's'})`)}`;
}

export async function runProvidersAuth(providerId: string, method?: ProviderAuthMethod): Promise<number> {
  try {
    const result = await authenticateProvider(providerId, { method });
    p.log.success(`Signed in to ${result.registryProvider.name} — credential saved to Keychain.`);
    return 0;
  } catch (err) {
    if (err instanceof Error && err.message === 'Cancelled') {
      p.cancel('Cancelled.');
      return 0;
    }
    p.log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runProvidersRefreshModels(providerId?: string): Promise<number> {
  const resolveKey = async (provider: import('./registry/types.js').RegistryProvider) =>
    resolveProviderCredential(provider.id, provider.authRef);

  if (providerId) {
    const registry = loadRegistry();
    const provider = registry.providers.find(p => p.id === providerId);
    if (!provider) {
      p.log.error(`Provider not found: ${providerId}`);
      return 1;
    }
    const spinner = p.spinner();
    spinner.start(`Refreshing ${provider.name}...`);
    const key = await resolveRefreshCredential(provider, async p =>
      resolveProviderCredential(p.id, p.authRef),
    );
    const result = await refreshProviderModels(providerId, key);
    spinner.stop('');
    if (result.skipped) {
      const countNote = result.modelCount ? ` (${result.modelCount} cached models kept)` : '';
      p.log.warn(`${result.name}: ${result.reason}${countNote}`);
      return 0;
    }
    if (!result.ok) {
      p.log.error(`${result.name}: ${result.reason ?? 'Refresh failed.'}`);
      return 1;
    }
    const diff = result.previousModelCount === undefined
      ? 0
      : (result.modelCount ?? 0) - result.previousModelCount;
    const diffStr = result.previousModelCount === undefined
      ? ''
      : diff > 0 ? ` (+${diff})` : diff < 0 ? ` (${diff})` : '';
    p.log.success(`${result.name}: ${result.modelCount} model${result.modelCount === 1 ? '' : 's'} updated${diffStr}.`);
    if (result.reason) {
      p.log.warn(result.reason);
    }
    return 0;
  }

  const spinner = p.spinner();
  spinner.start('Refreshing model lists...');
  const { refreshed } = await refreshAllProviderModels(resolveKey);
  spinner.stop('');

  const ok = refreshed.filter(r => r.ok && !r.skipped);
  const skipped = refreshed.filter(r => r.skipped);
  const failed = refreshed.filter(r => !r.ok);

  if (ok.length > 0) {
    p.log.success(`Updated ${ok.length} provider${ok.length === 1 ? '' : 's'}.`);
    for (const r of ok) {
      const diff = r.previousModelCount === undefined
        ? 0
        : (r.modelCount ?? 0) - r.previousModelCount;
      const diffStr = r.previousModelCount === undefined
        ? ''
        : diff > 0 ? ` (+${diff})` : diff < 0 ? ` (${diff})` : '';
      p.log.info(`  ${r.name}: ${r.modelCount} model${r.modelCount === 1 ? '' : 's'}${diffStr}`);
      if (r.reason) {
        p.log.warn(`  ${r.reason}`);
      }
    }
  }
  for (const r of skipped) {
    const countNote = r.modelCount ? ` (${r.modelCount} cached models kept)` : '';
    p.log.warn(`Skipped ${r.name}: ${r.reason}${countNote}`);
  }
  for (const r of failed) {
    p.log.error(`${r.name}: ${r.reason ?? 'Refresh failed.'}`);
  }
  return failed.length > 0 ? 1 : 0;
}

export async function runProvidersList(): Promise<number> {
  const entries = await resolveProvidersForDisplay();
  if (entries.length === 0) {
    p.log.info('No providers configured. Run clodex providers add or clodex providers auth openai.');
    return 0;
  }

  console.log('');
  for (const entry of entries) {
    const status = entry.enabled ? pc.green('●') : pc.dim('○');
    console.log(
      `  ${status} ${pc.bold(entry.name)} ${pc.dim(`(${entry.id})`)} — `
      + `${entry.modelCount} model${entry.modelCount === 1 ? '' : 's'}, auth: ${entry.authLabel}`,
    );
  }
  console.log('');
  return 0;
}

/** Add the OpenAI API-key provider (the only addable template in clodex). */
async function runTemplateAddFlow(): Promise<number> {
  const registry = loadRegistry();
  const configuredIds = registry.providers.map(p => p.id);
  const template = listAddableTemplates(configuredIds).find(t => t.id === 'openai')
    ?? getTemplateById('openai');
  if (!template || configuredIds.includes('openai')) {
    p.log.info('OpenAI is already configured. Use clodex providers auth openai for ChatGPT OAuth.');
    return 0;
  }

  if (template.signupUrl) {
    printPanel(fmtProvider(template.name), [
      `${pc.white('Get an API key at:')} ${fmtUrl(template.signupUrl)}`,
    ]);
  }

  const apiKeyInput = await p.password({
    message: `Paste your ${template.name} API key:`,
    validate: val => val.trim() ? undefined : 'Key cannot be empty',
  });
  if (p.isCancel(apiKeyInput)) {
    p.cancel('Cancelled.');
    return 0;
  }

  const apiKey = String(apiKeyInput).trim();

  const spinner = p.spinner();
  spinner.start(`Testing connection to ${template.name}...`);
  const result = await addProviderFromTemplate(template, apiKey);
  spinner.stop('');

  if (!result.added) {
    p.log.error(result.error ?? 'Could not add provider.');
    if (result.hint) p.log.info(result.hint);
    return 1;
  }

  logConnected(template.name, result.modelCount ?? 0);
  return 0;
}

export async function runProvidersAdd(): Promise<number> {
  const choice = await p.select({
    message: 'Add a provider',
    options: [
      {
        value: 'oauth',
        label: 'Sign in with ChatGPT (Plus/Pro plan)',
        hint: 'OAuth device code — no API key needed',
      },
      {
        value: 'apikey',
        label: 'OpenAI API key',
        hint: 'platform.openai.com key (usage-billed)',
      },
    ],
  });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return 0;
  }

  if (choice === 'oauth') return runProvidersAuth('openai');
  return runTemplateAddFlow();
}

export async function runProvidersRemove(id: string, interactive = false): Promise<number> {
  const registry = loadRegistry();
  const provider = registry.providers.find(pr => pr.id === id);
  if (!provider) {
    p.log.error(`Provider not found: ${id}`);
    return 1;
  }

  if (interactive) {
    const confirm = await p.confirm({
      message: `Remove ${provider.name} (${id})?`,
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Cancelled.');
      return 0;
    }
  }

  const result = await removeProviderFromRegistry(id);
  if (!result.removed) {
    p.log.error(result.error ?? `Could not remove ${id}`);
    return 1;
  }

  p.log.success(`Removed ${result.name ?? id}.`);
  if (result.credentialDeleted) {
    p.log.info('Provider API key removed from Keychain.');
  }
  return 0;
}

export function providerHubChoiceValue(entry: ProviderDisplayEntry): string {
  return `provider:${entry.id}`;
}

async function runProviderDetail(id: string): Promise<'back' | 'removed'> {
  const registry = loadRegistry();
  const provider = registry.providers.find(pr => pr.id === id);
  if (!provider) return 'back';

  const modelCount = provider.modelsCache?.models.length ?? 0;
  const authLabel = formatRegistryAuthLabel(provider);
  printProviderDetailPanel(provider.name, modelCount, authLabel);

  const detailOptions: Array<{ value: string; label: string; hint?: string }> = [];
  if (modelCount > 0) {
    detailOptions.push({
      value: 'browse',
      label: 'Browse models',
      hint: `Search or browse ${modelCount} model${modelCount === 1 ? '' : 's'}`,
    });
  }
  detailOptions.push({
    value: 'refresh',
    label: 'Refresh model list',
    hint: 'Fetch latest models from the provider API',
  });
  if (supportsNativeOAuth(id) || provider.authType === 'oauth') {
    detailOptions.push({
      value: 'auth',
      label: 'Sign in again (OAuth)',
      hint: 'Refresh OAuth tokens or switch accounts',
    });
  }
  detailOptions.push(
    {
      value: 'toggle',
      label: provider.enabled ? 'Disable provider' : 'Enable provider',
      hint: provider.enabled ? 'Hide from clodex claude picker' : 'Show in clodex claude picker',
    },
    { value: 'remove', label: 'Remove provider', hint: 'Delete from registry and Keychain when safe' },
    { value: 'back', label: 'Back', hint: '' },
  );

  const action = await p.select({
    message: 'What would you like to do?',
    options: detailOptions,
  });
  if (p.isCancel(action) || action === 'back') return 'back';

  if (action === 'browse') {
    const cachedModels = provider.modelsCache?.models ?? [];
    const localModels = cachedModels
      .map(m => cachedModelToLocal(m, provider))
      .filter((m): m is NonNullable<typeof m> => m !== null);
    const localProvider: LocalProvider = {
      id: provider.id,
      name: provider.name,
      apiKey: '',
      models: localModels,
    };
    await browseAllModels(localProvider, loadPreferences());
    return 'back';
  }

  if (action === 'refresh') {
    await runProvidersRefreshModels(id);
    return 'back';
  }

  if (action === 'auth') {
    await runProvidersAuth(id);
    return 'back';
  }

  if (action === 'toggle') {
    const result = toggleProviderEnabled(id);
    if (result.toggled) {
      p.log.success(`${provider.name} ${result.enabled ? 'enabled' : 'disabled'}.`);
    }
    return 'back';
  }

  const code = await runProvidersRemove(id, true);
  return code === 0 ? 'removed' : 'back';
}

export async function runProvidersHub(): Promise<number> {
  while (true) {
    const entries = await resolveProvidersForDisplay();
    const options: Array<{ value: string; label: string; hint?: string }> = [
      { value: 'add', label: pc.bold('+ Add a provider'), hint: '' },
    ];

    for (const entry of entries) {
      const hint = entry.id;
      const value = providerHubChoiceValue(entry);
      options.push({
        value,
        label: providerLabel(entry.name, entry.modelCount, entry.enabled),
        hint,
      });
    }

    const configuredIds = new Set(entries.map(entry => entry.id));
    if (listVisibleOAuthTemplates(configuredIds).length > 0) {
      options.push({ value: 'auth-menu', label: '→ Sign in with ChatGPT (OAuth)', hint: 'device code' });
    }
    if (entries.length > 0) {
      options.push({ value: 'refresh-all', label: '↺ Refresh all models', hint: 'Update model lists for all providers' });
    }
    options.push({ value: 'done', label: 'Done', hint: '' });

    const choice = await p.select({
      message: entries.length > 0 ? 'Your OpenAI providers' : 'Get started',
      options,
    });
    if (p.isCancel(choice) || choice === 'done') {
      return 0;
    }
    if (choice === 'add') {
      await runProvidersAdd();
      continue;
    }
    if (choice === 'refresh-all') {
      await runProvidersRefreshModels();
      continue;
    }
    if (choice === 'auth-menu') {
      await runProvidersAuth('openai');
      continue;
    }
    if (typeof choice === 'string' && choice.startsWith('provider:')) {
      const id = choice.slice('provider:'.length);
      const outcome = await runProviderDetail(id);
      if (outcome === 'removed') continue;
    }
  }
}

export async function runProvidersCommand(args: string[]): Promise<number> {
  const parsed = parseProvidersArgs(args);
  if (parsed.error) {
    p.log.error(parsed.error);
    return 1;
  }
  if (parsed.showHelp && parsed.subcommand !== 'auth') {
    console.log(providersHelpText());
    return 0;
  }

  if (parsed.subcommand === 'list') return runProvidersList();
  if (parsed.subcommand === 'add') return runProvidersAdd();
  if (parsed.subcommand === 'remove' && parsed.removeId) return runProvidersRemove(parsed.removeId);
  if (parsed.subcommand === 'refresh-models') return runProvidersRefreshModels(parsed.removeId);
  if (parsed.subcommand === 'auth') {
    if (parsed.showHelp || !parsed.removeId) {
      console.log(providerAuthHelpText());
      return 0;
    }
    return runProvidersAuth(parsed.removeId, parsed.authMethod);
  }

  relayIntro('Your OpenAI providers');
  return runProvidersHub();
}
