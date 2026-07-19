import * as p from '@clack/prompts';
import pc from 'picocolors';
import { printFavoritesOnlyPanel, printGatewayMaskPanel, printNetworkWarningPanel } from '../ui.js';

export type ListenMode = 'local' | 'network';
export type ServerStartMode = 'configure' | 'quick';

export async function askServerStartMode(): Promise<ServerStartMode | null> {
  const mode = await p.select<ServerStartMode>({
    message: 'How do you want to start the server?',
    options: [
      { value: 'configure', label: pc.cyan('Configure & start'), hint: 'Providers, discovery masking, listen mode' },
      { value: 'quick', label: pc.cyan('Start with saved settings'), hint: 'Use last server configuration' },
    ],
    initialValue: 'configure',
  });
  if (p.isCancel(mode)) {
    p.cancel('Cancelled.');
    return null;
  }
  return mode;
}

export async function askMaskGatewayIds(initialValue: boolean): Promise<boolean | null> {
  const mask = await p.confirm({
    message: 'Mask gateway model ids for discovery? (Needed for Claude Desktop / Cowork)',
    initialValue,
  });
  if (p.isCancel(mask)) {
    p.cancel('Cancelled.');
    return null;
  }
  return Boolean(mask);
}

export async function askFavoritesOnly(initialValue: boolean): Promise<boolean | null> {
  printFavoritesOnlyPanel();
  const favoritesOnly = await p.confirm({
    message: 'Expose only favorite models?',
    initialValue,
  });
  if (p.isCancel(favoritesOnly)) {
    p.cancel('Cancelled.');
    return null;
  }
  return Boolean(favoritesOnly);
}

export async function askListenMode(): Promise<ListenMode | null> {
  const mode = await p.select<ListenMode>({
    message: 'Where should the server listen?',
    options: [
      { value: 'local', label: pc.cyan('Local only'), hint: 'Only this computer can use it' },
      { value: 'network', label: pc.cyan('Network'), hint: 'Other computers on your network can use it' },
    ],
    initialValue: 'local',
  });
  if (p.isCancel(mode)) {
    p.cancel('Cancelled.');
    return null;
  }
  return mode;
}

export async function askServerPassword(): Promise<string | null> {
  printNetworkWarningPanel();

  const password = await p.text({
    message: 'Choose a server password for this run:',
    validate: value => value.trim() ? undefined : 'Password cannot be empty',
  });
  if (p.isCancel(password)) {
    p.cancel('Cancelled.');
    return null;
  }
  return String(password).trim();
}

export async function askUseSavedServerPassword(): Promise<'use-saved' | 'new-password' | null> {
  const choice = await p.select<'use-saved' | 'new-password'>({
    message: 'Use saved server password?',
    options: [
      { value: 'use-saved', label: pc.cyan('Use saved password') },
      { value: 'new-password', label: pc.cyan('Enter a new password') },
    ],
    initialValue: 'use-saved',
  });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return null;
  }
  return choice;
}

export async function askSaveServerPassword(): Promise<boolean | null> {
  const save = await p.confirm({
    message: 'Save this server password for future server runs?',
    initialValue: false,
  });
  if (p.isCancel(save)) {
    p.cancel('Cancelled.');
    return null;
  }
  return Boolean(save);
}
