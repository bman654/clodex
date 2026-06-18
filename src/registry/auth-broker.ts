// auth-broker.ts — delegate OAuth login to OpenCode CLI, copy tokens into relay-ai keychain

import { spawn } from 'node:child_process';
import { findOpencodeBinary } from '../opencode-serve.js';
import {
  isOpencodeOAuth,
  readOpencodeAuthFile,
  type OpencodeOAuthCredential,
} from './opencode-auth.js';

export interface OpencodeAuthBrokerOptions {
  method?: string;
}

export async function runOpencodeAuthBroker(
  providerId: string,
  options: OpencodeAuthBrokerOptions = {},
): Promise<OpencodeOAuthCredential> {
  const binary = findOpencodeBinary();
  if (!binary) {
    throw new Error('OpenCode CLI not found. Install from https://opencode.ai or use native device-code auth.');
  }

  const args = ['auth', 'login', '--provider', providerId];
  if (options.method) args.push('-m', options.method);

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`OpenCode auth login failed (exit ${exitCode})`);
  }

  const authFile = readOpencodeAuthFile();
  const entry = authFile?.entries[providerId];
  if (!isOpencodeOAuth(entry)) {
    throw new Error(`No OAuth token found for "${providerId}" after OpenCode login`);
  }
  return entry;
}
