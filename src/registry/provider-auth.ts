// provider-auth.ts — relay-ai providers auth (native device-code + OpenCode broker)

import { printOAuthStepsPanel } from '../ui.js';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { saveProviderCredential } from '../env.js';
import { runOpenAiDeviceCodeFlow } from '../oauth/openai.js';
import {
  supportsNativeOAuth,
  tokensToStoredCredential,
  type NativeOAuthProviderId,
} from '../oauth/types.js';
import { runXaiDeviceCodeFlow } from '../oauth/xai.js';
import { runGithubDeviceCodeFlow } from '../oauth/github.js';
import { getTemplateById } from '../provider-templates.js';
import { fetchRawOpencodeProviders } from '../opencode-serve.js';
import { findOpencodeBinary } from '../opencode-serve.js';
import { runOpencodeAuthBroker } from './auth-broker.js';
import { localProviderToRegistry } from './convert.js';
import { buildImportProviderList, oauthAuthRef } from './import-build.js';
import { loadRegistry, saveRegistry } from './io.js';
import { oauthCredentialToKeychainJson, type OpencodeOAuthCredential } from './opencode-auth.js';
import { refreshProviderModels } from './refresh-models.js';
import type { RegistryProvider } from './types.js';

export type ProviderAuthMethod = 'native' | 'broker';

export interface ProviderAuthOptions {
  method?: ProviderAuthMethod;
  brokerMethod?: string;
}

export interface ProviderAuthResult {
  providerId: string;
  credential: OpencodeOAuthCredential;
  registryProvider: RegistryProvider;
}

const PROVIDER_DISPLAY: Record<NativeOAuthProviderId, string> = {
  xai: 'xAI Grok (SuperGrok)',
  openai: 'OpenAI ChatGPT Plus/Pro',
  'github-copilot': 'GitHub Copilot (Individual / Business)',
};

async function runNativeDeviceCode(providerId: NativeOAuthProviderId): Promise<OpencodeOAuthCredential> {
  const label = PROVIDER_DISPLAY[providerId];
  printOAuthStepsPanel(`${label} — Sign in`, label);

  const spinner = p.spinner();
  spinner.start('Waiting for authorization...');

  try {
    if (providerId === 'xai') {
      const tokens = await runXaiDeviceCodeFlow(({ url, userCode }) => {
        spinner.stop('');
        p.log.info(`Visit: ${pc.cyan(url)}`);
        p.log.info(`Enter code: ${pc.bold(userCode)}`);
        spinner.start('Waiting for authorization...');
      });
      spinner.stop(pc.green('Signed in to xAI'));
      return tokensToStoredCredential(tokens);
    }

    if (providerId === 'github-copilot') {
      const tokens = await runGithubDeviceCodeFlow(({ url, userCode }) => {
        spinner.stop('');
        p.log.info(`Visit: ${pc.cyan(url)}`);
        p.log.info(`Enter code: ${pc.bold(userCode)}`);
        spinner.start('Waiting for authorization...');
      });
      spinner.stop(pc.green('Signed in to GitHub Copilot'));
      return tokensToStoredCredential(tokens);
    }

    const { tokens, accountId } = await runOpenAiDeviceCodeFlow(({ url, userCode }) => {
      spinner.stop('');
      p.log.info(`Visit: ${pc.cyan(url)}`);
      p.log.info(`Enter code: ${pc.bold(userCode)}`);
      spinner.start('Waiting for authorization...');
    });
    spinner.stop(pc.green('Signed in to OpenAI ChatGPT'));
    return tokensToStoredCredential(tokens, undefined, accountId);
  } catch (err) {
    spinner.stop('');
    throw err;
  }
}

async function upsertOAuthProvider(providerId: string, cred: OpencodeOAuthCredential): Promise<RegistryProvider> {
  const registry = loadRegistry();
  const authRef = oauthAuthRef(providerId);
  let entry: RegistryProvider | undefined = registry.providers.find(pr => pr.id === providerId);

  if (!entry) {
    const raw = await fetchRawOpencodeProviders();
    if (raw) {
      const { providers } = buildImportProviderList(raw, { [providerId]: cred });
      const lp = providers.find(pr => pr.id === providerId);
      if (lp) {
        entry = localProviderToRegistry(lp, { authType: 'oauth', authRef }) ?? undefined;
      }
    }
  }

  if (!entry) {
    const template = getTemplateById(providerId);
    if (!template) {
      throw new Error(`Provider "${providerId}" is not in your registry and has no template`);
    }
    entry = {
      id: providerId,
      templateId: template.id,
      name: template.name,
      enabled: true,
      authRef,
      authType: 'oauth',
      api: { npm: template.npm, url: template.defaultBaseUrl ?? '' },
      addedAt: new Date().toISOString(),
    };
  } else {
    entry = { ...entry, authType: 'oauth', authRef };
  }

  const idx = registry.providers.findIndex(pr => pr.id === providerId);
  if (idx >= 0) registry.providers[idx] = entry;
  else registry.providers.push(entry);
  saveRegistry(registry);
  return entry;
}

export async function authenticateProvider(
  providerId: string,
  options: ProviderAuthOptions = {},
): Promise<ProviderAuthResult> {
  if (!supportsNativeOAuth(providerId)) {
    if (findOpencodeBinary()) {
      const cred = await runOpencodeAuthBroker(providerId, { method: options.brokerMethod });
      const saved = await saveProviderCredential(oauthAuthRef(providerId), oauthCredentialToKeychainJson(cred));
      if (!saved) {
        p.log.warn('Could not save OAuth tokens to Keychain — session may not persist.');
      }
      const registryProvider = await upsertOAuthProvider(providerId, cred);
      return { providerId, credential: cred, registryProvider };
    }
    throw new Error(
      `Native OAuth is only built in for xai and openai. Install OpenCode for other OAuth providers.`,
    );
  }

  let method = options.method;
  if (!method) {
    const hasOpencode = findOpencodeBinary() !== null;
    if (hasOpencode) {
      const choice = await p.select({
        message: 'How would you like to sign in?',
        options: [
          { value: 'native', label: 'Device code (recommended)', hint: 'Works on SSH/VPS — open URL on any device' },
          { value: 'broker', label: 'Via OpenCode', hint: 'Uses opencode auth login' },
        ],
      });
      if (p.isCancel(choice)) throw new Error('Cancelled');
      method = choice as ProviderAuthMethod;
    } else {
      method = 'native';
    }
  }

  const cred = method === 'broker'
    ? await runOpencodeAuthBroker(providerId, { method: options.brokerMethod })
    : await runNativeDeviceCode(providerId);

  const saved = await saveProviderCredential(oauthAuthRef(providerId), oauthCredentialToKeychainJson(cred));
  if (!saved) {
    p.log.warn('Could not save OAuth tokens to Keychain — session may not persist.');
  }

  const registryProvider = await upsertOAuthProvider(providerId, cred);

  const refreshSpinner = p.spinner();
  refreshSpinner.start('Refreshing model list...');
  try {
    await refreshProviderModels(providerId, cred.access);
    refreshSpinner.stop('Models refreshed');
  } catch {
    refreshSpinner.stop('Could not refresh models — run relay-ai providers refresh-models later');
  }

  return { providerId, credential: cred, registryProvider };
}

export function providerAuthHelpText(): string {
  return `${pc.bold('relay-ai providers auth')} — sign in with OAuth

${pc.bold('Usage:')}
  relay-ai providers auth <id>
  relay-ai providers auth xai --native
  relay-ai providers auth openai --broker
  relay-ai providers auth github-copilot

${pc.bold('Options:')}
  --native    Use built-in device-code flow (xai, openai, github-copilot)
  --broker    Delegate to OpenCode auth login

${pc.bold('Supported native OAuth:')}
  xai              SuperGrok / X Premium (device code at x.ai/device)
  openai           ChatGPT Plus/Pro (device code at auth.openai.com/codex/device)
  github-copilot   GitHub Copilot Individual/Business (device code at github.com/login/device)`;
}
