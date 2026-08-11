// src/providers-command.ts — clodex providers command

import pc from 'picocolors';
import * as p from '@clack/prompts';
import { resolveProviderCredentialWithSource } from './env.js';
import {
  formatRegistryAuthLabel,
  PROVIDER_DEFAULT_ACCOUNT_LABEL,
  resolveActiveAccount,
  resolveProvidersForDisplay,
  type ActiveAccount,
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
  setActiveOAuthAccount,
  toggleProviderEnabled,
} from './registry/crud.js';
import { reconcilePendingCredentialDeletes } from './registry/credential-lifecycle.js';
import { loadRegistry } from './registry/io.js';
import { withProviderMutationLock } from './registry/lock.js';
import type { RegistryProvider } from './registry/types.js';
import { refreshAllProviderModels, refreshProviderModelsWithCredential } from './registry/refresh-models.js';
import { authenticateProvider, providerAuthHelpText, validateOAuthAccountName, type ProviderAuthMethod } from './registry/provider-auth.js';
import { supportsNativeOAuth } from './oauth/types.js';
import { browseAllModels } from './prompts.js';
import { cachedModelToLocal, projectSelectedOAuthAccount } from './registry/materialize.js';
import { OAUTH_ACCOUNT_ENV } from './oauth-account-selection.js';
import { loadPreferences } from './config.js';
import type { LocalProvider } from './types.js';
import { readLiveServerRuntimeStates } from './server-runtime.js';
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

const CREDENTIAL_CLEANUP_PENDING_MESSAGE =
  'Credential cleanup is pending and will be retried by the next provider command.';

interface ProviderCommandCleanupState {
  reconciled: boolean;
  pending: boolean;
}

function reportCredentialCleanup(
  pending: boolean,
  state?: ProviderCommandCleanupState,
  reconciled = false,
): void {
  if (state) {
    state.reconciled ||= reconciled;
    state.pending ||= pending;
    return;
  }
  if (pending) {
    p.log.warn(CREDENTIAL_CLEANUP_PENDING_MESSAGE);
  }
}

async function reconcileCredentialCleanup(): Promise<boolean> {
  try {
    const cleanup = await reconcilePendingCredentialDeletes();
    return cleanup.pending.length > 0 || cleanup.persistenceError !== undefined;
  } catch {
    return true;
  }
}

async function runWithCredentialCleanup(
  run: (state: ProviderCommandCleanupState) => Promise<number>,
): Promise<number> {
  const state: ProviderCommandCleanupState = {
    reconciled: false,
    pending: false,
  };
  try {
    return await run(state);
  } finally {
    if (!state.reconciled) {
      state.pending = await reconcileCredentialCleanup();
    }
    reportCredentialCleanup(state.pending);
  }
}

export function parseProvidersArgs(args: string[]): {
  subcommand: ProvidersSubcommand;
  showHelp: boolean;
  removeId?: string;
  authMethod?: ProviderAuthMethod;
  authAccount?: string;
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
    let authAccount: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === '--native') authMethod = 'native';
      else if (arg === '--account') {
        const value = rest[i + 1];
        if (!value || value.startsWith('-')) {
          return { subcommand: 'auth', showHelp: false, error: 'Usage: clodex providers auth <id> --account <name>' };
        }
        authAccount = value;
        i++;
      } else if (arg.startsWith('-')) {
        return { subcommand: 'auth', showHelp: false, error: `Unknown auth option: ${arg}` };
      } else {
        positional.push(arg);
      }
    }
    if (positional.length !== 1) {
      return { subcommand: 'auth', showHelp: false, error: 'Usage: clodex providers auth <id>' };
    }
    return { subcommand: 'auth', showHelp: false, removeId: positional[0], authMethod, authAccount };
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
  return `${pc.bold('clodex providers')} — manage model providers

${pc.bold('Usage:')}
  clodex providers
  clodex providers add
  clodex providers list
  clodex providers remove <id>
  clodex providers refresh-models [id]
  clodex providers auth openai

${pc.bold('Subcommands:')}
  (none)      Provider hub wizard
  add         Add a built-in provider or sign in with ChatGPT
  auth        Sign in with ChatGPT/Codex-plan OAuth (device code)
  list        Show configured providers
  remove      Remove a provider by id
  refresh-models  Update cached model lists`;
}

/**
 * Whether the provider detail menu offers "Switch account".
 *
 * Slots OR a stored selection — not slots alone. An orphaned selector (a
 * selection whose slot table is gone, a state the parser and serializer
 * deliberately accept) makes every launch fail with advice to come here and
 * clear it, so gating on slots would hide the one repair the error recommends
 * and leave re-authenticating or hand-editing the registry as the only ways out.
 */
/**
 * What to tell the user after a selection is saved.
 *
 * Resolved from the saved state, not from the picker choice: persisting
 * succeeds under the write lock while a nonblank CLODEX_OAUTH_ACCOUNT naming a
 * missing slot still makes every launch throw. Reporting the choice back
 * verbatim therefore confirms a repair that did not happen — the third surface
 * in this file to decide a launch outcome without asking the resolver, so it
 * asks the resolver.
 */
export function accountSwitchOutcome(
  providerName: string,
  saved: string | undefined,
  effective: ActiveAccount,
): { ok: boolean; message: string; confirmsLaunch?: true } {
  const savedLabel = saved ?? PROVIDER_DEFAULT_ACCOUNT_LABEL;

  if (effective.kind === 'credential-override') {
    const variable = effective.credentialOverride.variable;
    if (effective.inactiveReason === 'non-oauth') {
      return {
        ok: false,
        message: `Saved ${savedLabel} for ${providerName}, but this provider is not configured for OAuth account selection; `
          + `${variable} is configured and blocks launch because it has no isolated model catalog. Save that credential `
          + 'as a provider or unset the variable.',
      };
    }
    if (effective.inactiveReason === 'disabled') {
      return {
        ok: false,
        message: `Saved ${savedLabel} for ${providerName} (provider disabled); ${variable} has no isolated model `
          + 'catalog, so enabling the provider in this shell will fail until that credential is saved and refreshed '
          + 'or the variable is unset.',
      };
    }
    return {
      ok: false,
      message: `Saved ${savedLabel} for ${providerName}, but ${variable} has no isolated model catalog, so launches `
        + 'are blocked. Save that credential as a provider or account and refresh its models, or unset the variable.',
    };
  }

  if (effective.inactiveReason === 'non-oauth') {
    return {
      ok: true,
      message: `Saved ${savedLabel} for ${providerName}, but this provider is not configured for OAuth account selection.`,
    };
  }

  if (effective.inactiveReason === 'disabled') {
    if (effective.kind === 'broken') {
      const blockedOverride = effective.credentialOverride
        ? ` ${effective.credentialOverride.variable} is configured, but OAuth account selection is validated before credential resolution.`
        : '';
      return {
        ok: false,
        message: effective.fromEnvironment
          ? `Saved ${savedLabel} for ${providerName} (provider disabled), but ${OAUTH_ACCOUNT_ENV}=${effective.name} `
            + `names no such account — enabling it in this shell will fail until the variable is unset or corrected.${blockedOverride}`
          : `Saved ${savedLabel} for ${providerName} (provider disabled), but that account no longer exists — `
            + `enabling the provider will fail.${blockedOverride}`,
      };
    }
    if (effective.kind === 'slot' && effective.fromEnvironment && effective.name !== saved) {
      return {
        ok: true,
        message: `Saved ${savedLabel} for ${providerName} (provider disabled); if enabled in this shell, `
          + `${OAUTH_ACCOUNT_ENV}=${effective.name} will override it.`,
      };
    }
    return {
      ok: true,
      message: `Saved ${savedLabel} for ${providerName} (provider disabled).`,
    };
  }

  if (effective.kind === 'broken') {
    const blockedOverride = effective.credentialOverride
      ? ` ${effective.credentialOverride.variable} is configured, but OAuth account selection is validated before credential resolution.`
      : '';
    return {
      ok: false,
      message: effective.fromEnvironment
        ? `Saved ${savedLabel} for ${providerName}, but ${OAUTH_ACCOUNT_ENV}=${effective.name} `
          + `names no such account — every launch fails until it is unset or corrected.${blockedOverride}`
        : `Saved ${savedLabel} for ${providerName}, but it names no existing account — `
          + `every launch fails.${blockedOverride}`,
    };
  }
  if (effective.kind === 'slot' && effective.fromEnvironment && effective.name !== saved) {
    return {
      ok: true,
      message: `Saved ${savedLabel} for ${providerName}, but ${OAUTH_ACCOUNT_ENV}=${effective.name} `
        + 'overrides it in this shell.',
    };
  }
  return {
    ok: true,
    message: `${providerName} will launch as ${savedLabel}.`,
    confirmsLaunch: true,
  };
}

export function accountSwitchServerRestartWarning(
  liveServerCount: number,
  selectionChanged = true,
): string | null {
  if (!selectionChanged || !Number.isInteger(liveServerCount) || liveServerCount <= 0) return null;
  return `Restart ${liveServerCount} running standalone clodex server${liveServerCount === 1 ? '' : 's'} `
    + `${liveServerCount === 1 ? 'because it retains' : 'because they retain'} the previous provider and credential snapshot.`;
}

/**
 * The detail-menu hint for "Switch account", derived from the SAME resolver the
 * listing reads. A broken selection has to read as broken here: this is the
 * screen the launch error sends people to, so telling them the missing account
 * is in use is the least useful thing it could say.
 */
export function accountSwitchHint(
  provider: Pick<RegistryProvider, 'activeAuthAccount'>,
  effective: ActiveAccount,
): string {
  if (effective.kind === 'credential-override') {
    const variable = effective.credentialOverride.variable;
    const selected = effective.selection;
    const account = selected.kind === 'slot'
      ? `account ${selected.name}`
      : selected.kind === 'default'
        ? PROVIDER_DEFAULT_ACCOUNT_LABEL
        : `missing stored OAuth account "${selected.name}"`;
    const masked = selected.latentOrphan
      ? `; stored "${selected.latentOrphan}" is missing and will fail without ${OAUTH_ACCOUNT_ENV}`
      : '';
    if (effective.inactiveReason === 'non-oauth') {
      return `${variable} is configured but launches are blocked because it has no isolated model catalog; OAuth `
        + `selection (${account}) is stored but inactive because this provider is not configured for OAuth${masked}`;
    }
    if (effective.inactiveReason === 'disabled') {
      return `${variable} is configured for ${account} but has no isolated model catalog; enabling this provider `
        + `will fail until that credential is saved and refreshed or the variable is unset${masked}`;
    }
    return `${variable} is configured for ${account}, but launches are blocked because it has no isolated model `
      + `catalog; save and refresh that credential or unset the variable${masked}`;
  }

  if (effective.inactiveReason === 'non-oauth') {
    if (effective.kind === 'broken') {
      return `Stored OAuth account "${effective.name}" no longer exists — provider is not configured for OAuth selection`;
    }
    if (effective.kind === 'slot') {
      return `Stored OAuth account: ${effective.name} (provider is not configured for OAuth selection)`;
    }
    return 'OAuth account selection inactive (provider is not configured for OAuth)';
  }

  if (effective.inactiveReason === 'disabled') {
    const masked = effective.latentOrphan
      ? `; stored "${effective.latentOrphan}" is missing and will fail if enabled without the override`
      : '';
    if (effective.kind === 'broken') {
      const blockedOverride = effective.credentialOverride
        ? `; ${effective.credentialOverride.variable} cannot bypass account selection`
        : '';
      return effective.fromEnvironment
        ? `${OAUTH_ACCOUNT_ENV}=${effective.name} names no such account — enabling this provider will fail${masked}${blockedOverride}`
        : `Selected account "${effective.name}" no longer exists — enabling this provider will fail${blockedOverride}`;
    }
    if (effective.kind === 'slot') {
      return effective.fromEnvironment
        ? `If enabled, ${OAUTH_ACCOUNT_ENV}=${effective.name} overrides the stored `
          + `${provider.activeAuthAccount ?? PROVIDER_DEFAULT_ACCOUNT_LABEL}${masked}`
        : `Saved account: ${effective.name} (provider disabled)`;
    }
    return `Saved account: ${PROVIDER_DEFAULT_ACCOUNT_LABEL} (provider disabled)`;
  }

  if (effective.kind === 'broken') {
    // A broken override can hide a second, independent breakage: the stored
    // selection behind it. Unsetting the variable would otherwise just swap
    // one unexplained failure for another.
    const also = effective.latentOrphan
      ? ` (and stored "${effective.latentOrphan}" is missing too)`
      : '';
    const blockedOverride = effective.credentialOverride
      ? `; ${effective.credentialOverride.variable} cannot bypass account selection`
      : '';
    return effective.fromEnvironment
      ? `${OAUTH_ACCOUNT_ENV}=${effective.name} names no such account — every launch fails${also}`
        + blockedOverride
      : `Selected account "${effective.name}" no longer exists — every launch fails; clear it here${blockedOverride}`;
  }
  // A stored selection an override is masking is still broken; say so, or this
  // screen reads as healthy until the variable is unset.
  const masked = effective.latentOrphan
    ? ` — stored "${effective.latentOrphan}" no longer exists and will fail without it`
    : '';
  if (effective.kind === 'default') {
    return `Every launch currently uses ${PROVIDER_DEFAULT_ACCOUNT_LABEL}${masked}`;
  }
  return effective.fromEnvironment
    ? `${OAUTH_ACCOUNT_ENV}=${effective.name} overrides the stored `
      + `${provider.activeAuthAccount ?? PROVIDER_DEFAULT_ACCOUNT_LABEL}${masked}`
    : `Every launch currently uses ${effective.name}${masked}`;
}

export function shouldOfferAccountSwitch(
  provider: Pick<RegistryProvider, 'authAccounts' | 'activeAuthAccount'>,
): boolean {
  return Object.keys(provider.authAccounts ?? {}).length > 0
    || provider.activeAuthAccount !== undefined;
}

function providerLabel(name: string, modelCount: number, enabled: boolean): string {
  return `${fmtEnabledStar(enabled)} ${fmtProvider(name)} ${pc.dim(`(${modelCount} model${modelCount === 1 ? '' : 's'})`)}`;
}

async function runProvidersAuthWithCleanupState(
  providerId: string,
  method?: ProviderAuthMethod,
  cleanupState?: ProviderCommandCleanupState,
  account?: string,
): Promise<number> {
  try {
    const result = await authenticateProvider(providerId, { method, account });
    // Print the NORMALIZED slot name: the credential is stored under it, and
    // applySelectedOAuthAccount does not normalize the env value, so echoing
    // the raw spelling ("Work") would recommend a selector that fails.
    const slot = account === undefined ? undefined : validateOAuthAccountName(account);
    p.log.success(
      slot
        ? `Signed in to ${result.registryProvider.name} (account "${slot}") — make it the account every launch uses with: clodex providers`
        : `Signed in to ${result.registryProvider.name} — credential saved to the credential store.`,
    );
    reportCredentialCleanup(result.credentialCleanupPending, cleanupState, true);
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

export async function runProvidersAuth(providerId: string, method?: ProviderAuthMethod): Promise<number> {
  return runProvidersAuthWithCleanupState(providerId, method);
}

export async function runProvidersRefreshModels(
  providerId?: string,
  options: {
    accountOverride?: string | null;
    ignoreProviderCredentialOverride?: boolean;
  } = {},
): Promise<number> {
  const resolveKey = async (provider: import('./registry/types.js').RegistryProvider) =>
    resolveProviderCredentialWithSource(provider.id, provider.authRef);

  if (providerId) {
    const registry = loadRegistry();
    const provider = registry.providers.find(p => p.id === providerId);
    if (!provider) {
      p.log.error(`Provider not found: ${providerId}`);
      return 1;
    }
    const spinner = p.spinner();
    spinner.start(`Refreshing ${provider.name}...`);
    const accountOverride = options.accountOverride === undefined
      ? process.env[OAUTH_ACCOUNT_ENV] ?? null
      : options.accountOverride;
    let result: Awaited<ReturnType<typeof refreshProviderModelsWithCredential>>;
    try {
      result = await refreshProviderModelsWithCredential(
        providerId,
        async candidate => resolveProviderCredentialWithSource(
          candidate.id,
          candidate.authRef,
          undefined,
          { ignoreProviderOverride: options.ignoreProviderCredentialOverride },
        ),
        accountOverride,
        { ignoreProviderOverride: options.ignoreProviderCredentialOverride },
      );
    } catch (err) {
      spinner.stop('');
      p.log.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
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

/** Add one API-key provider from a built-in template. */
async function runTemplateAddFlow(
  templateId: string,
  cleanupState?: ProviderCommandCleanupState,
): Promise<number> {
  const registry = loadRegistry();
  const configuredIds = registry.providers.map(provider => provider.id);
  const template = listAddableTemplates(configuredIds).find(candidate => candidate.id === templateId);
  if (!template) {
    const known = getTemplateById(templateId);
    p.log.info(known ? `${known.name} is already configured.` : `Unknown provider template: ${templateId}`);
    return known ? 0 : 1;
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
  reportCredentialCleanup(
    result.credentialCleanupPending === true,
    cleanupState,
    result.credentialCleanupReconciled === true,
  );

  if (!result.added) {
    p.log.error(result.error ?? 'Could not add provider.');
    if (result.hint) p.log.info(result.hint);
    return 1;
  }

  logConnected(template.name, result.modelCount ?? 0);
  return 0;
}

async function runProvidersAddWithCleanupState(
  cleanupState?: ProviderCommandCleanupState,
): Promise<number> {
  const configuredIds = loadRegistry().providers.map(provider => provider.id);
  const options: Array<{ value: string; label: string; hint: string }> = [];

  if (!configuredIds.includes('openai-oauth')) {
    options.push({
      value: 'oauth',
      label: 'Sign in with ChatGPT (Plus/Pro plan)',
      hint: 'OAuth device code — no API key needed',
    });
  }
  for (const template of listAddableTemplates(configuredIds)) {
    options.push({
      value: `api:${template.id}`,
      label: `${template.name} API key`,
      hint: template.id === 'openai'
        ? 'platform.openai.com key (usage-billed)'
        : 'provider API key (usage-billed)',
    });
  }

  if (options.length === 0) {
    p.log.info('All built-in providers are already configured.');
    return 0;
  }

  const choice = await p.select({
    message: 'Add a provider',
    options,
  });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return 0;
  }

  if (choice === 'oauth') {
    return runProvidersAuthWithCleanupState('openai', undefined, cleanupState);
  }
  if (typeof choice === 'string' && choice.startsWith('api:')) {
    return runTemplateAddFlow(choice.slice('api:'.length), cleanupState);
  }
  return 0;
}

export async function runProvidersAdd(): Promise<number> {
  return runProvidersAddWithCleanupState();
}

async function runProvidersRemoveWithCleanupState(
  id: string,
  interactive = false,
  cleanupState?: ProviderCommandCleanupState,
): Promise<number> {
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
  reportCredentialCleanup(
    result.credentialCleanupPending === true,
    cleanupState,
    result.credentialCleanupReconciled === true,
  );
  if (!result.removed) {
    p.log.error(result.error ?? `Could not remove ${id}`);
    return 1;
  }
  if (result.error) {
    p.log.error(result.error);
    return 1;
  }

  p.log.success(`Removed ${result.name ?? id}.`);
  if (result.credentialDeleted) {
    p.log.info('Provider API key removed from the credential store.');
  }
  return 0;
}

export async function runProvidersRemove(id: string, interactive = false): Promise<number> {
  return runProvidersRemoveWithCleanupState(id, interactive);
}

export function providerHubChoiceValue(entry: ProviderDisplayEntry): string {
  return `provider:${entry.id}`;
}

async function runProviderDetail(id: string): Promise<'back' | 'removed'> {
  const registry = loadRegistry();
  const provider = registry.providers.find(pr => pr.id === id);
  if (!provider) return 'back';
  const effective = resolveActiveAccount(provider);

  // The detail/browse surface must describe the same account a launch from
  // this process will use. If the selection is broken, fail closed to an
  // empty catalog while leaving the account controls available for repair.
  let modelProvider: RegistryProvider;
  try {
    modelProvider = projectSelectedOAuthAccount(provider);
    if (effective.kind === 'credential-override') {
      modelProvider = { ...modelProvider };
      delete modelProvider.modelsCache;
      delete modelProvider.refreshedAt;
    }
  } catch {
    modelProvider = { ...provider };
    delete modelProvider.modelsCache;
    delete modelProvider.refreshedAt;
  }
  const modelCount = modelProvider.modelsCache?.models.length ?? 0;
  const authLabel = (await resolveProvidersForDisplay()).find(entry => entry.id === id)?.authLabel
    ?? formatRegistryAuthLabel(provider);
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
  const accountSlots = Object.keys(provider.authAccounts ?? {}).sort();
  if (supportsNativeOAuth(id) || provider.authType === 'oauth') {
    detailOptions.push({
      value: 'auth',
      label: 'Sign in again (OAuth)',
      // Says what the action DOES. It calls the auth flow with no account
      // name, so it re-authenticates the provider's own credential and cannot
      // create or refresh a named slot — the previous wording advertised
      // exactly the thing it does not do, which is worst when the account
      // needing reauthentication is a named one that this would leave broken
      // while overwriting the default.
      hint: accountSlots.length > 0
        ? `Re-authenticate ${PROVIDER_DEFAULT_ACCOUNT_LABEL} only — for a named account: clodex providers auth ${id} --account <name>`
        : `Re-authenticate ${PROVIDER_DEFAULT_ACCOUNT_LABEL}`,
    });
  }
  if (shouldOfferAccountSwitch(provider)) {
    detailOptions.push({
      value: 'account',
      label: 'Switch account',
      // Same resolver the list view uses, so this screen cannot contradict it
      // about which identity is live — including when the answer is "none of
      // them, the launch fails", which this hint previously reported as a
      // working account.
      hint: accountSwitchHint(provider, effective),
    });
  }
  detailOptions.push(
    {
      value: 'toggle',
      label: provider.enabled ? 'Disable provider' : 'Enable provider',
      hint: provider.enabled ? 'Hide from clodex claude picker' : 'Show in clodex claude picker',
    },
    { value: 'remove', label: 'Remove provider', hint: 'Delete from registry and credential store when safe' },
    { value: 'back', label: 'Back', hint: '' },
  );

  const action = await p.select({
    message: 'What would you like to do?',
    options: detailOptions,
  });
  if (p.isCancel(action) || action === 'back') return 'back';

  if (action === 'browse') {
    const cachedModels = modelProvider.modelsCache?.models ?? [];
    const localModels = cachedModels
      .map(m => cachedModelToLocal(m, modelProvider))
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
    await runWithCredentialCleanup(state =>
      runProvidersAuthWithCleanupState(id, undefined, state));
    return 'back';
  }

  if (action === 'account') {
    // Not a bare 'default': OAUTH_ACCOUNT_NAME_RE accepts "default" as a slot
    // name, so a real account could shadow the sentinel. This value cannot.
    const providerDefault = '<default>';
    // An orphaned selector names a slot that is gone, so it cannot be the
    // initial value — the widget would open on an option that is not in the
    // list. Landing on the provider default is also the repair such a user came
    // here to perform.
    const stored = provider.activeAuthAccount;
    const current = stored !== undefined && accountSlots.includes(stored) ? stored : providerDefault;
    const chosen = await p.select({
      message: 'Which account should every launch use?',
      initialValue: current,
      options: [
        {
          value: providerDefault,
          label: PROVIDER_DEFAULT_ACCOUNT_LABEL,
          hint: "the provider's original sign-in",
        },
        ...accountSlots.map(name => ({
          value: name,
          label: name,
          hint: effective.kind === 'slot' && effective.name === name
            ? (effective.fromEnvironment ? `active via ${OAUTH_ACCOUNT_ENV}` : 'current')
            : name === provider.activeAuthAccount ? 'stored' : '',
        })),
      ],
    });
    // Only isCancel: a falsy check would read the sentinel as a cancellation.
    if (p.isCancel(chosen)) return 'back';
    return withProviderMutationLock<'back'>(id, async (): Promise<'back'> => {
      const result = await setActiveOAuthAccount(id, chosen === providerDefault ? undefined : chosen);
      if (!result.updated) {
        p.log.error(result.error ?? 'Could not switch account.');
        return 'back';
      }
      if (!result.provider) {
        p.log.error('Account selection was saved, but the resulting provider state could not be read.');
        return 'back';
      }
      // The catalog belongs to the credential identity. Keep the saved
      // selection and its targeted refresh in one provider mutation. Otherwise
      // a concurrent switch can win between the two and make this command
      // refresh and report a different account.
      //
      // Refresh every explicit selection, including a selection no-op. Cache
      // presence does not prove that its credential still resolves, and this
      // makes the recovery instruction below a real retry rather than another
      // false success.
      const refreshExitCode = await runProvidersRefreshModels(id, {
        accountOverride: null,
        ignoreProviderCredentialOverride: true,
      });
      const currentProvider = loadRegistry().providers.find(candidate => candidate.id === id);
      if (!currentProvider) {
        p.log.error('Account selection was saved, but the resulting provider state could not be read.');
        return 'back';
      }
      // Re-resolved against the state that won the same provider lock rather
      // than reported from the picker choice.
      const outcome = accountSwitchOutcome(
        currentProvider.name,
        result.account,
        resolveActiveAccount(currentProvider),
      );
      const selectedCatalogReady = Boolean(currentProvider.modelsCache?.models.length);
      if (
        outcome.ok
        && currentProvider.enabled
        && currentProvider.authType === 'oauth'
        && (refreshExitCode !== 0 || !selectedCatalogReady)
      ) {
        const savedLabel = result.account ?? PROVIDER_DEFAULT_ACCOUNT_LABEL;
        const savedContext = outcome.confirmsLaunch
          ? `Saved ${savedLabel} for ${currentProvider.name}.`
          : outcome.message;
        p.log.warn(
          `${savedContext} Automatic model refresh for the saved selection did not produce a usable catalog; `
          + 'choose Switch account again to retry it before relying on that selection for launches.',
        );
      } else if (outcome.ok) {
        p.log.success(outcome.message);
      } else {
        p.log.warn(outcome.message);
      }
      const restartWarning = accountSwitchServerRestartWarning(
        readLiveServerRuntimeStates().length,
        result.changed,
      );
      if (restartWarning) p.log.warn(restartWarning);
      return 'back';
    });
  }

  if (action === 'toggle') {
    const result = toggleProviderEnabled(id);
    if (result.toggled) {
      p.log.success(`${provider.name} ${result.enabled ? 'enabled' : 'disabled'}.`);
    }
    return 'back';
  }

  const code = await runWithCredentialCleanup(state =>
    runProvidersRemoveWithCleanupState(id, true, state));
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
    } else if (configuredIds.has('openai-oauth')) {
      options.push({
        value: 'auth-account',
        label: '→ Add another ChatGPT account',
        hint: 'named slot; pick which one launches via Switch account',
      });
    }
    if (entries.length > 0) {
      options.push({ value: 'refresh-all', label: '↺ Refresh all models', hint: 'Update model lists for all providers' });
    }
    options.push({ value: 'done', label: 'Done', hint: '' });

    const choice = await p.select({
      message: entries.length > 0 ? 'Your providers' : 'Get started',
      options,
    });
    if (p.isCancel(choice) || choice === 'done') {
      return 0;
    }
    if (choice === 'add') {
      await runWithCredentialCleanup(state => runProvidersAddWithCleanupState(state));
      continue;
    }
    if (choice === 'refresh-all') {
      await runProvidersRefreshModels();
      continue;
    }
    if (choice === 'auth-menu') {
      await runWithCredentialCleanup(state =>
        runProvidersAuthWithCleanupState('openai', undefined, state));
      continue;
    }
    if (choice === 'auth-account') {
      const name = await p.text({
        message: 'Name for this account (choose which one launches with: clodex providers)',
        placeholder: 'work',
        validate: value => {
          try {
            validateOAuthAccountName(String(value ?? ''));
            return undefined;
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        },
      });
      if (p.isCancel(name)) continue;
      await runWithCredentialCleanup(state =>
        runProvidersAuthWithCleanupState('openai', undefined, state, String(name)));
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

  const reconcilesDuringMutation =
    parsed.subcommand === 'add'
    || parsed.subcommand === 'remove'
    || (
      parsed.subcommand === 'auth'
      && !parsed.showHelp
      && parsed.removeId !== undefined
    );
  if (!reconcilesDuringMutation) {
    reportCredentialCleanup(await reconcileCredentialCleanup());
  }

  if (parsed.subcommand === 'list') return runProvidersList();
  if (parsed.subcommand === 'add') {
    return runWithCredentialCleanup(state => runProvidersAddWithCleanupState(state));
  }
  if (parsed.subcommand === 'remove' && parsed.removeId) {
    return runWithCredentialCleanup(state =>
      runProvidersRemoveWithCleanupState(parsed.removeId!, false, state));
  }
  if (parsed.subcommand === 'refresh-models') return runProvidersRefreshModels(parsed.removeId);
  if (parsed.subcommand === 'auth') {
    if (parsed.showHelp || !parsed.removeId) {
      console.log(providerAuthHelpText());
      return 0;
    }
    return runWithCredentialCleanup(state =>
      runProvidersAuthWithCleanupState(parsed.removeId!, parsed.authMethod, state, parsed.authAccount));
  }

  relayIntro('Your providers');
  return runProvidersHub();
}
