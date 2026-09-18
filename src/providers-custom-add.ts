// src/providers-custom-add.ts — `clodex providers add` → a custom OpenAI-compatible server

import * as p from '@clack/prompts';
import { addCustomEndpointProvider, type AddCustomEndpointResult } from './registry/custom-endpoint.js';
import { printableServerText } from './registry/server-text.js';
import { logConnected } from './ui.js';

/**
 * Add a provider from any OpenAI-compatible base URL: OpenRouter, Together, a
 * local LM Studio or vLLM server. The registry side is `addCustomEndpointProvider`,
 * which validates the URL, lists the server's models, and stores the key.
 *
 * `onResult` receives the registry's result before it is reported, so the
 * caller can fold `credentialCleanupPending` into its own cleanup state.
 */
export async function runCustomEndpointAddFlow(
  onResult: (result: AddCustomEndpointResult) => void,
): Promise<number> {
  const displayName = await p.text({
    message: 'Name for this provider:',
    placeholder: 'OpenRouter',
    validate: value => value.trim() ? undefined : 'Name is required',
  });
  if (p.isCancel(displayName)) {
    p.cancel('Cancelled.');
    return 0;
  }

  const baseUrl = await p.text({
    message: 'Base URL of the OpenAI-compatible API (the part before /chat/completions):',
    placeholder: 'https://openrouter.ai/api/v1',
    validate: value => value.trim() ? undefined : 'URL is required',
  });
  if (p.isCancel(baseUrl)) {
    p.cancel('Cancelled.');
    return 0;
  }

  let allowInsecureLocal = false;
  if (/^http:\/\//i.test(String(baseUrl).trim())) {
    p.log.warn('HTTP is not encrypted. Only use it for a trusted local or LAN server.');
    const allow = await p.confirm({
      message: 'Allow insecure HTTP for this local/LAN server?',
      initialValue: true,
    });
    if (p.isCancel(allow)) {
      p.cancel('Cancelled.');
      return 0;
    }
    allowInsecureLocal = allow === true;
  }

  const apiKey = await p.password({
    message: 'API key (leave empty for a local server without auth):',
  });
  if (p.isCancel(apiKey)) {
    p.cancel('Cancelled.');
    return 0;
  }

  const spinner = p.spinner();
  spinner.start('Testing connection...');
  const result = await addCustomEndpointProvider({
    displayName: String(displayName).trim(),
    baseUrl: String(baseUrl).trim(),
    apiKey: String(apiKey ?? '').trim(),
    kind: 'openai',
    allowInsecureLocal,
  });
  spinner.stop('');
  onResult(result);

  if (!result.added || !result.provider) {
    // The hint can carry the server's own error body, so control characters are stripped.
    p.log.error(printableServerText(result.error ?? 'Could not add the provider.'));
    const hint = printableServerText(result.hint ?? '');
    if (hint) p.log.info(hint);
    return 1;
  }

  logConnected(result.provider.name, result.modelCount ?? 0);
  p.log.info(`Provider id: ${result.provider.id}. Its models are named clodex:${result.provider.id}:<model>.`);
  return 0;
}
