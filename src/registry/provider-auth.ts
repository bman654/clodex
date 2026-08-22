// provider-auth.ts — clodex providers auth (native OpenAI device-code flow)

import { printOAuthBrowserPanel, printOAuthStepsPanel } from '../ui.js';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import open from 'open';
import {
  probeProviderCredentialStore,
  provisionProviderCredential,
  resolveProviderCredentialWithSource,
  saveProviderCredential,
} from '../env.js';
import { OAUTH_ACCOUNT_ENV } from '../oauth-account-selection.js';
import { credentialInstanceAuthRef } from '../credential-helper.js';
import { runOpenAiBrowserFlow, runOpenAiDeviceCodeFlow } from '../oauth/openai.js';
import {
  supportsNativeOAuth,
  tokensToStoredCredential,
  oauthCredentialToKeychainJson,
  type NativeOAuthProviderId,
  type StoredOAuthCredential,
} from '../oauth/types.js';
import { getTemplateById } from '../provider-templates.js';
import { oauthAuthRef, toOAuthRegistryId } from './import-build.js';
import {
  cancelCredentialDelete,
  journalCredentialWrite,
  queueCredentialDelete,
  reconcilePendingCredentialDeletes,
} from './credential-lifecycle.js';
import { loadRegistryStrict, saveRegistry } from './io.js';
import {
  withCredentialMutationLock,
  withProviderMutationLock,
  withRegistryWriteLock,
} from './lock.js';
import { refreshProviderModelsWithCredential } from './refresh-models.js';
import { OAUTH_ACCOUNT_NAME_RE, type RegistryProvider } from './types.js';
import {
  getOAuthAccountSlot,
  providerDefaultAuthRef,
  storeActiveOAuthAccount,
} from './oauth-account-storage.js';

export type { StoredOAuthCredential } from '../oauth/types.js';

export type ProviderAuthMethod = 'native' | 'browser';

export interface ProviderAuthOptions {
  method?: ProviderAuthMethod;
  /** Named account slot; stores a disjoint credential without touching the default. */
  account?: string;
}

/** Validate a named-account slot; the name lands in credential-store scopes and env values. */
export function validateOAuthAccountName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!OAUTH_ACCOUNT_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid account name "${name}" — use 1-32 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.`,
    );
  }
  return trimmed;
}

export interface ProviderAuthResult {
  providerId: string;
  credential: StoredOAuthCredential;
  registryProvider: RegistryProvider;
  credentialCleanupPending: boolean;
}

const OPENAI_DISPLAY = 'OpenAI ChatGPT Plus/Pro';
const PROVIDER_DISPLAY: Record<NativeOAuthProviderId, string> = {
  openai: OPENAI_DISPLAY,
  'openai-oauth': OPENAI_DISPLAY,
};

function openBrowser(url: string): void {
  open(url).catch(() => {});
}

async function runNativeDeviceCode(providerId: NativeOAuthProviderId): Promise<StoredOAuthCredential> {
  const label = PROVIDER_DISPLAY[providerId];
  printOAuthStepsPanel(`${label} — Sign in`, label);

  const spinner = p.spinner();
  spinner.start('Waiting for authorization...');

  try {
    const { tokens, accountId } = await runOpenAiDeviceCodeFlow(({ url, userCode }) => {
      spinner.stop('');
      p.log.info(`Visit: ${pc.cyan(url)}`);
      p.log.info(`Enter code: ${pc.bold(userCode)}`);
      openBrowser(url);
      spinner.start('Waiting for authorization...');
    });
    spinner.stop(pc.green('Signed in to OpenAI ChatGPT'));
    return tokensToStoredCredential(tokens, undefined, accountId);
  } catch (err) {
    spinner.stop('');
    throw err;
  }
}

async function runNativeBrowserSignIn(providerId: NativeOAuthProviderId): Promise<StoredOAuthCredential> {
  const label = PROVIDER_DISPLAY[providerId];
  printOAuthBrowserPanel(`${label} — Sign in`, label);

  const spinner = p.spinner();
  spinner.start('Opening your browser...');

  try {
    const { tokens, accountId } = await runOpenAiBrowserFlow(({ url }) => {
      spinner.stop('');
      p.log.info(`If the browser did not open, visit: ${pc.cyan(url)}`);
      openBrowser(url);
      spinner.start('Waiting for sign-in in your browser...');
    });
    spinner.stop(pc.green('Signed in to OpenAI ChatGPT'));
    return tokensToStoredCredential(tokens, undefined, accountId);
  } catch (err) {
    spinner.stop('');
    throw err;
  }
}

async function upsertOAuthAccountSlot(
  registryId: string,
  account: string,
  authRef: string,
  expectedAuthRef: string | undefined,
): Promise<RegistryProvider> {
  return withRegistryWriteLock(async () => {
    const registry = loadRegistryStrict();
    const entry = registry.providers.find(pr => pr.id === registryId);
    if (!entry) {
      throw new Error(
        `Provider "${registryId}" is not configured yet — run the default sign-in first: clodex providers auth openai`,
      );
    }
    const previousAuthRef = getOAuthAccountSlot(entry, account)?.authRef;
    if (previousAuthRef !== expectedAuthRef) {
      throw new Error(`Account "${account}" of "${registryId}" changed while its credential was being saved`);
    }
    const updated: RegistryProvider = {
      ...entry,
      authAccounts: {
        ...entry.authAccounts,
        [account]: {
          authRef,
          addedAt: new Date().toISOString(),
        },
      },
    };
    if (entry.activeAuthAccount === account) {
      // The selected slot is also the downgrade-visible top-level reference.
      // This additionally repairs a legacy broken selector when reauth creates
      // its missing slot: the old top-level ref is still the proven default.
      storeActiveOAuthAccount(updated, account, authRef);
      delete updated.modelsCache;
      delete updated.refreshedAt;
    }
    const idx = registry.providers.findIndex(provider => provider.id === registryId);
    registry.providers[idx] = updated;
    if (previousAuthRef && previousAuthRef !== authRef) {
      await queueCredentialDelete(previousAuthRef);
    }
    saveRegistry(registry);
    try {
      await cancelCredentialDelete(authRef);
    } catch {
      // Reconciliation below reports and retries the committed marker.
    }
    return updated;
  });
}

export async function saveNativeOAuthCredential(
  providerId: string,
  tokens: import('../oauth/types.js').OAuthTokenResponse,
  accountId?: string,
  providerData?: Record<string, unknown>,
): Promise<void> {
  const cred = tokensToStoredCredential(tokens, undefined, accountId, providerData);
  await persistNativeOAuthCredential(providerId, cred);
}

/**
 * The OAuth provider shares a templateId with the API-key provider (openai),
 * so it needs a distinguishing display name for pickers.
 */
function oauthDisplayName(registryId: string, fallbackName: string): string {
  if (registryId === 'openai-oauth') return 'OpenAI (ChatGPT)';
  return fallbackName;
}

async function upsertOAuthProvider(
  providerId: string,
  authRef: string,
  expectedAuthRef: string | undefined,
): Promise<RegistryProvider> {
  return withRegistryWriteLock(async () => {
    const registryId = toOAuthRegistryId(providerId);
    const templateId = providerId.replace(/-oauth$/, '') || providerId;
    const registry = loadRegistryStrict();
    const template = getTemplateById(templateId);
    let entry: RegistryProvider | undefined = registry.providers.find(pr => pr.id === registryId);
    if ((entry ? providerDefaultAuthRef(entry) : undefined) !== expectedAuthRef) {
      throw new Error(`Provider "${registryId}" changed while its credential was being saved`);
    }

    if (!entry) {
      if (!template) {
        throw new Error(`Provider "${providerId}" is not in your registry and has no template`);
      }
    }

    const previousAuthRef = entry ? providerDefaultAuthRef(entry) : undefined;
    if (!entry) {
      if (!template) throw new Error(`Provider "${providerId}" has no template`);
      const displayName = oauthDisplayName(registryId, template.name);
      entry = {
        id: registryId,
        templateId,
        name: displayName,
        enabled: true,
        authRef,
        authType: 'oauth',
        api: {
          npm: template.npm,
          url: template.defaultBaseUrl ?? '',
          ...(template.headers ? { headers: template.headers } : {}),
        },
        addedAt: new Date().toISOString(),
      };
    } else if (entry.activeAuthAccount) {
      const selected = getOAuthAccountSlot(entry, entry.activeAuthAccount);
      if (!selected) {
        throw new Error(
          `Provider "${registryId}" is set to use account "${entry.activeAuthAccount}", which no longer exists`,
        );
      }
      // Reauthenticating the inactive provider default must not replace the
      // selected slot published in authRef or invalidate its entitlement cache.
      entry = {
        ...entry,
        authType: 'oauth',
        authRef: selected.authRef,
        defaultAuthRef: authRef,
        templateId,
      };
      // The parked catalog belonged to the replaced default credential.
      delete entry.defaultModelsCache;
      // A dormant non-OAuth selector may carry a top-level catalog owned by
      // its prior API credential. Once OAuth is restored, the top-level cache
      // must describe the selected slot for both current and downgraded
      // readers. Never pair the selected credential with that prior cache.
      if (selected.modelsCache) {
        entry.modelsCache = selected.modelsCache;
        entry.refreshedAt = selected.modelsCache.fetchedAt;
      } else {
        delete entry.modelsCache;
        delete entry.refreshedAt;
      }
    } else {
      entry = { ...entry, authType: 'oauth', authRef, templateId };
      delete entry.defaultAuthRef;
      delete entry.defaultModelsCache;
      delete entry.modelsCache;
      delete entry.refreshedAt;
    }

    const idx = registry.providers.findIndex(provider => provider.id === registryId);
    if (idx >= 0) registry.providers[idx] = entry;
    else registry.providers.push(entry);
    if (previousAuthRef && previousAuthRef !== authRef) {
      await queueCredentialDelete(previousAuthRef);
    }
    saveRegistry(registry);
    try {
      await cancelCredentialDelete(authRef);
    } catch {
      // Reconciliation below reports and retries the committed marker.
    }
    return entry;
  });
}

async function persistNativeOAuthCredential(
  providerId: string,
  cred: StoredOAuthCredential,
  accountName?: string,
): Promise<{ registryProvider: RegistryProvider; credentialCleanupPending: boolean }> {
  const registryId = toOAuthRegistryId(providerId);
  const account = accountName
    ? `oauth:provider:${registryId}:account:${accountName}`
    : `oauth:provider:${registryId}`;
  const registryProvider = await withProviderMutationLock(registryId, async () => {
    const existingAuthRef = await withRegistryWriteLock(
      () => {
        const registry = loadRegistryStrict();
        const templateId = providerId.replace(/-oauth$/, '') || providerId;
        const existing = registry.providers.find(provider => provider.id === registryId);
        if (!existing && !getTemplateById(templateId)) {
          throw new Error(`Provider "${providerId}" is not in your registry and has no template`);
        }
        if (accountName && !existing) {
          throw new Error(
            `Provider "${registryId}" is not configured yet — run the default sign-in first: clodex providers auth openai`,
          );
        }
        if (accountName && existing?.authType !== 'oauth') {
          throw new Error(
            `Provider "${registryId}" does not currently have a default OAuth sign-in — `
            + 'run clodex providers auth openai without --account first.',
          );
        }
        return accountName
          ? existing ? getOAuthAccountSlot(existing, accountName)?.authRef : undefined
          : existing ? providerDefaultAuthRef(existing) : undefined;
      },
    );
    const authRef = credentialInstanceAuthRef(account);
    return withCredentialMutationLock(authRef, async () => {
      await journalCredentialWrite(authRef);
      let diagMsg = '';
      const saved =
        existingAuthRef === authRef
          ? await saveProviderCredential(authRef, oauthCredentialToKeychainJson(cred), msg => {
              diagMsg = msg;
            })
          : await provisionProviderCredential(authRef, oauthCredentialToKeychainJson(cred), msg => {
              diagMsg = msg;
            });
      if (!saved) {
        throw new Error(
          `Could not save OAuth tokens to the credential store${
            diagMsg ? ` — ${diagMsg}` : ' — check access and try again'
          }`,
        );
      }
      return accountName
        ? upsertOAuthAccountSlot(registryId, accountName, authRef, existingAuthRef)
        : upsertOAuthProvider(providerId, authRef, existingAuthRef);
    });
  });

  let credentialCleanupPending = true;
  try {
    const cleanup = await reconcilePendingCredentialDeletes();
    credentialCleanupPending =
      cleanup.pending.length > 0 || cleanup.persistenceError !== undefined;
  } catch {
    credentialCleanupPending = true;
  }
  return {
    registryProvider,
    credentialCleanupPending,
  };
}

export async function authenticateProvider(
  providerId: string,
  options: ProviderAuthOptions = {},
): Promise<ProviderAuthResult> {
  const registryId = toOAuthRegistryId(providerId);
  const accountName = options.account === undefined ? undefined : validateOAuthAccountName(options.account);

  if (!supportsNativeOAuth(providerId)) {
    throw new Error('OAuth sign-in is only available for openai (ChatGPT Plus/Pro).');
  }

  if (accountName) {
    // Fail before probing (which writes/deletes a disposable credential) or
    // starting the interactive device-code ceremony. The locked check inside
    // persistNativeOAuthCredential remains authoritative against concurrent
    // provider replacements during the ceremony.
    const existing = loadRegistryStrict().providers.find(provider => provider.id === registryId);
    if (!existing) {
      throw new Error(
        `Provider "${registryId}" is not configured yet — run the default sign-in first: clodex providers auth openai`,
      );
    }
    if (existing.authType !== 'oauth') {
      throw new Error(
        `Provider "${registryId}" does not currently have a default OAuth sign-in — `
        + 'run clodex providers auth openai without --account first.',
      );
    }
  }

  let storeDiagMsg = '';
  const storeReady = await probeProviderCredentialStore(oauthAuthRef(registryId), msg => {
    storeDiagMsg = msg;
  });
  if (!storeReady) {
    throw new Error(
      `Credential store is unavailable${storeDiagMsg ? `: ${storeDiagMsg}` : ''}. `
      + 'Set CLODEX_CREDENTIAL_HELPER to an absolute path to an external credential helper and try again.',
    );
  }

  const cred = options.method === 'browser'
    ? await runNativeBrowserSignIn(providerId)
    : await runNativeDeviceCode(providerId);
  const persisted = await persistNativeOAuthCredential(providerId, cred, accountName);

  const refreshSpinner = p.spinner();
  refreshSpinner.start('Refreshing model list...');
  try {
    // A named sign-in invalidates that slot's account-specific cache, so
    // rebuild that exact slot even when another account currently wins. A
    // default sign-in with no stored slot likewise invalidates the top-level
    // cache and must ignore a one-process account selection. When a stored
    // slot remains active, its top-level cache is still valid and the normal
    // per-process selection can be refreshed instead.
    const accountOverride = accountName
      ?? (persisted.registryProvider.activeAuthAccount === undefined
        ? null
        : process.env[OAUTH_ACCOUNT_ENV] ?? null);
    const refreshResult = await refreshProviderModelsWithCredential(
      registryId,
      async provider => resolveProviderCredentialWithSource(
        provider.id,
        provider.authRef,
        undefined,
        { ignoreProviderOverride: true },
      ),
      accountOverride,
      { ignoreProviderOverride: true },
    );
    if (refreshResult.skipped) {
      refreshSpinner.stop(`Models not refreshed${refreshResult.reason ? ` — ${refreshResult.reason}` : ''}`);
    } else if (refreshResult.ok) {
      refreshSpinner.stop('Models refreshed');
    } else {
      refreshSpinner.stop(`Could not refresh models${refreshResult.reason ? ` — ${refreshResult.reason}` : ''}`);
    }
  } catch {
    refreshSpinner.stop('Could not refresh models — run clodex providers refresh-models later');
  }

  return {
    providerId: registryId,
    credential: cred,
    registryProvider: persisted.registryProvider,
    credentialCleanupPending: persisted.credentialCleanupPending,
  };
}

export function providerAuthHelpText(): string {
  return `${pc.bold('clodex providers auth')} — sign in with OAuth

${pc.bold('Usage:')}
  clodex providers auth openai
  clodex providers auth openai --browser
  clodex providers auth openai --account work

${pc.bold('Device code (works on SSH/VPS):')}
  openai   ChatGPT Plus/Pro (device code at auth.openai.com/codex/device)

${pc.bold('Browser sign-in:')}
  --browser   sign in through your browser instead of a device code — use this
              when your workspace admin has disabled device code authorization.
              Needs a local browser, so it does not work over plain SSH.

${pc.bold('Named accounts:')}
  --account <name>   store an additional ChatGPT account under a named slot
                     (the default sign-in is untouched). Select one at launch:
                     CLODEX_OAUTH_ACCOUNT=work clodex claude`;
}
