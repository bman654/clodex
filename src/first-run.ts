// src/first-run.ts — inline first-run setup for clodex claude (never dead-end)

import pc from 'picocolors';
import * as p from '@clack/prompts';
import { printWelcomePanel } from './ui.js';
import { loadRegistry } from './registry/io.js';
import { promptOAuthMethod, runProvidersAdd, runProvidersAuth } from './providers-command.js';

export type FirstRunResult = 'continue' | 'cancel';

/** True when the user has no registry entries configured. */
export async function needsFirstRunSetup(): Promise<boolean> {
  const registry = loadRegistry();
  return registry.providers.length === 0;
}

/** Inline welcome wizard — every path should end with continue (launch) or explicit cancel. */
export async function runFirstRunWizard(_trace = false): Promise<FirstRunResult> {
  printWelcomePanel();

  const choice = await p.select({
    message: 'How do you want to connect to OpenAI?',
    options: [
      {
        value: 'oauth',
        label: pc.cyan('Sign in with ChatGPT (Plus/Pro plan)'),
        hint: 'OAuth (device code or browser) — uses your ChatGPT/Codex plan',
      },
      {
        value: 'apikey',
        label: pc.cyan('Use an OpenAI API key'),
        hint: 'platform.openai.com key (usage-billed)',
      },
    ],
  });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return 'cancel';
  }

  let code: number;
  if (choice === 'oauth') {
    const method = await promptOAuthMethod();
    if (method === null) return 'cancel';
    code = await runProvidersAuth('openai', method);
  } else {
    code = await runProvidersAdd();
  }
  if (code !== 0) return 'cancel';

  if ((await needsFirstRunSetup())) return 'cancel';
  p.log.success('OpenAI provider ready — picking a model next.');
  return 'continue';
}
