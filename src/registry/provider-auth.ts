// provider-auth.ts — clodex providers auth (native OpenAI device-code flow)

import { printOAuthStepsPanel } from '../ui.js';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import open from 'open';
import { saveProviderCredential } from '../env.js';
import { runOpenAiDeviceCodeFlow } from '../oauth/openai.js';
import {
  supportsNativeOAuth,
  tokensToStoredCredential,
  oauthCredentialToKeychainJson,
  type NativeOAuthProviderId,
  type StoredOAuthCredential,
} from '../oauth/types.js';
import { getTemplateById } from '../provider-templates.js';
import { oauthAuthRef, toOAuthRegistryId } from './import-build.js';
import { loadRegistry, saveRegistry } from './io.js';
import { refreshProviderModels } from './refresh-models.js';
import type { RegistryProvider } from './types.js';

export type { StoredOAuthCredential } from '../oauth/types.js';

export type ProviderAuthMethod = 'native';

export interface ProviderAuthOptions {
  method?: ProviderAuthMethod;
}

export interface ProviderAuthResult {
  providerId: string;
  credential: StoredOAuthCredential;
  registryProvider: RegistryProvider;
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

export async function saveNativeOAuthCredential(
  providerId: string,
  tokens: import('../oauth/types.js').OAuthTokenResponse,
  accountId?: string,
  providerData?: Record<string, unknown>,
): Promise<void> {
  const cred = tokensToStoredCredential(tokens, undefined, accountId, providerData);
  const registryId = toOAuthRegistryId(providerId);
  let diagMsg = '';
  const saved = await saveProviderCredential(
    oauthAuthRef(registryId),
    oauthCredentialToKeychainJson(cred),
    (msg) => { diagMsg = msg; },
  );
  if (!saved) throw new Error(`Could not save OAuth tokens to Keychain${diagMsg ? ` — ${diagMsg}` : ' — grant access and try again'}`);
  await upsertOAuthProvider(providerId, cred);
}

/**
 * The OAuth provider shares a templateId with the API-key provider (openai),
 * so it needs a distinguishing display name for pickers.
 */
function oauthDisplayName(registryId: string, fallbackName: string): string {
  if (registryId === 'openai-oauth') return 'OpenAI (ChatGPT)';
  return fallbackName;
}

async function upsertOAuthProvider(providerId: string, cred: StoredOAuthCredential): Promise<RegistryProvider> {
  const registryId = toOAuthRegistryId(providerId);
  const templateId = providerId.replace(/-oauth$/, '') || providerId;

  const registry = loadRegistry();
  const authRef = oauthAuthRef(registryId);
  const template = getTemplateById(templateId);
  let entry: RegistryProvider | undefined = registry.providers.find(pr => pr.id === registryId);

  if (!entry) {
    if (!template) {
      throw new Error(`Provider "${providerId}" is not in your registry and has no template`);
    }
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
  } else {
    entry = { ...entry, authType: 'oauth', authRef, templateId };
  }

  const idx = registry.providers.findIndex(pr => pr.id === registryId);
  if (idx >= 0) registry.providers[idx] = entry;
  else registry.providers.push(entry);
  saveRegistry(registry);
  return entry;
}

export async function authenticateProvider(
  providerId: string,
  _options: ProviderAuthOptions = {},
): Promise<ProviderAuthResult> {
  const registryId = toOAuthRegistryId(providerId);

  if (!supportsNativeOAuth(providerId)) {
    throw new Error('OAuth sign-in is only available for openai (ChatGPT Plus/Pro).');
  }

  const cred = await runNativeDeviceCode(providerId);

  let nativeDiagMsg = '';
  const saved = await saveProviderCredential(
    oauthAuthRef(registryId),
    oauthCredentialToKeychainJson(cred),
    (msg) => { nativeDiagMsg = msg; },
  );
  if (!saved) {
    p.log.warn(`Could not save OAuth tokens to Keychain — ${nativeDiagMsg || 'session may not persist.'}`);
  }

  const registryProvider = await upsertOAuthProvider(providerId, cred);

  const refreshSpinner = p.spinner();
  refreshSpinner.start('Refreshing model list...');
  try {
    await refreshProviderModels(registryId, cred.access);
    refreshSpinner.stop('Models refreshed');
  } catch {
    refreshSpinner.stop('Could not refresh models — run clodex providers refresh-models later');
  }

  return { providerId: registryId, credential: cred, registryProvider };
}

export function providerAuthHelpText(): string {
  return `${pc.bold('clodex providers auth')} — sign in with OAuth

${pc.bold('Usage:')}
  clodex providers auth openai

${pc.bold('Device code (works on SSH/VPS):')}
  openai   ChatGPT Plus/Pro (device code at auth.openai.com/codex/device)`;
}
