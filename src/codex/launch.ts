// Spawn Codex CLI with relay-ai-launch profile.
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_LAUNCH_SANDBOX, profileName } from './profile.js';
import { codexProviderEnvKey } from './routing.js';
import type { CodexRoute } from './routing.js';
import { PROXY_PLACEHOLDER_KEY } from '../codex-proxy.js';

const isWindows = process.platform === 'win32';

/** CI env inherited from IDE/agent terminals can force Codex into read-only CI sandbox mode. */
const CODEX_CI_ENV_VARS = [
  'CI',
  'CODEX_CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'JENKINS_URL',
  'TF_BUILD',
  'BUILD_BUILDID',
] as const;

export function stripCodexInheritedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of CODEX_CI_ENV_VARS) {
    delete out[name];
  }
  return out;
}

const CODEX_FALLBACK_PATHS = isWindows
  ? [
      join(process.env['APPDATA'] ?? homedir(), 'npm', 'codex.cmd'),
      join(process.env['APPDATA'] ?? homedir(), 'npm', 'codex'),
    ]
  : [
      join(homedir(), '.local', 'bin', 'codex'),
      join(homedir(), '.npm', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ];

export function findCodexBinary(): string | null {
  try {
    const result = execSync(isWindows ? 'where.exe codex' : 'which codex', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const path = result.trim().split('\n')[0]?.trim();
    if (path) return path;
  } catch {
    // try fallbacks
  }
  for (const path of CODEX_FALLBACK_PATHS) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function codexArgsIncludeSandboxFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      arg === '-s'
      || arg === '--sandbox'
      || arg === '--dangerously-bypass-approvals-and-sandbox'
    ) {
      return true;
    }
    if (arg.startsWith('--sandbox=')) return true;
  }
  return false;
}

/** Default relay-ai launches to full access unless the user passed their own sandbox flag. */
export function ensureCodexSandboxArgs(extraArgs: string[]): string[] {
  if (codexArgsIncludeSandboxFlag(extraArgs)) return extraArgs;
  return ['-s', CODEX_LAUNCH_SANDBOX, ...extraArgs];
}

export function buildCodexChildEnv(route: CodexRoute, proxyPort?: number): NodeJS.ProcessEnv {
  const env = stripCodexInheritedEnv(process.env);

  if (route.tier === 'proxy' && proxyPort) {
    env['RELAY_AI_CODEX_KEY'] = PROXY_PLACEHOLDER_KEY;
  } else {
    const envKey = codexProviderEnvKey(route.providerId);
    env[envKey] = route.apiKey;
  }

  return env;
}

export function launchCodex(
  modelId: string,
  env: NodeJS.ProcessEnv,
  extraArgs: string[],
): Promise<number> {
  return new Promise((resolve) => {
    const codexPath = findCodexBinary()!;
    const args = ['--profile', profileName(), '-m', modelId, ...ensureCodexSandboxArgs(extraArgs)];
    const child = spawn(codexPath, args, {
      stdio: 'inherit',
      env,
      shell: isWindows,
    });

    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));

    child.on('exit', code => resolve(code ?? 0));
  });
}
