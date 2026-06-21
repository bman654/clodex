// src/gemini/launch.ts
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';

const GEMINI_FALLBACK_PATHS = isWindows
  ? [
      join(process.env['APPDATA'] ?? homedir(), 'npm', 'gemini.cmd'),
      join(process.env['APPDATA'] ?? homedir(), 'npm', 'gemini'),
    ]
  : [
      join(homedir(), '.local', 'bin', 'gemini'),
      join(homedir(), '.npm', 'bin', 'gemini'),
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini',
    ];

export function findGeminiBinary(): string | null {
  try {
    const result = execSync(isWindows ? 'where.exe gemini' : 'which gemini', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const path = result.trim().split('\n')[0]?.trim();
    if (path) return path;
  } catch {
    // try fallbacks
  }
  for (const path of GEMINI_FALLBACK_PATHS) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function buildGeminiChildEnv(proxyPort: number, proxyToken: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  
  // Isolate by removing any conflicting/existing credentials
  delete env['GOOGLE_GEMINI_BASE_URL'];
  delete env['GEMINI_API_KEY'];
  delete env['GOOGLE_API_KEY'];
  delete env['GOOGLE_GENAI_API_KEY'];

  // Route to the local proxy
  env['GOOGLE_GEMINI_BASE_URL'] = `http://127.0.0.1:${proxyPort}`;
  env['GEMINI_API_KEY'] = proxyToken;

  return env;
}

export function launchGemini(
  geminiPath: string,
  modelId: string,
  env: NodeJS.ProcessEnv,
  extraArgs: string[],
): Promise<number> {
  return new Promise((resolve) => {
    // Instruct the Gemini CLI to use the chosen model via -m flag
    const args = ['-m', modelId, ...extraArgs];
    const child = spawn(geminiPath, args, {
      stdio: 'inherit',
      env,
      shell: isWindows,
    });

    const onSigInt = () => child.kill('SIGINT');
    const onSigTerm = () => child.kill('SIGTERM');
    process.once('SIGINT', onSigInt);
    process.once('SIGTERM', onSigTerm);

    const done = (code: number) => {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      resolve(code);
    };

    child.on('error', () => done(1));
    child.on('exit', (code) => done(code ?? 0));
  });
}
