// src/trace-log.ts — debug log paths under ~/.relay-ai/logs/ with secret redaction

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { getLogsPath } from './paths.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const CLAUDE_DEBUG_LOG = 'claude-debug.log';
export const PROXY_DEBUG_LOG = 'proxy-debug.log';
export const CODEX_PROXY_DEBUG_LOG = 'codex-proxy-debug.log';

export function ensureLogsDir(): string {
  const dir = getLogsPath();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // best-effort
  }
  return dir;
}

export function getClaudeDebugLogPath(): string {
  return join(ensureLogsDir(), CLAUDE_DEBUG_LOG);
}

export function prepareClaudeTraceLog(): string {
  const path = getClaudeDebugLogPath();
  resetTraceLog(path);
  return path;
}

export function getProxyDebugLogPath(): string {
  return join(ensureLogsDir(), PROXY_DEBUG_LOG);
}

export function getCodexProxyDebugLogPath(): string {
  return join(ensureLogsDir(), CODEX_PROXY_DEBUG_LOG);
}

/** Reset log file and return a writer that redacts secrets. */
export function makeTraceLogger(logPath: string): (message: string) => void {
  resetTraceLog(logPath);
  return (message: string) => writeSecureLogLine(logPath, `${new Date().toISOString()} ${message}`);
}

/** Remove prior session log so --trace shows only the latest run. */
export function resetTraceLog(path: string): void {
  ensureLogsDir();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

const REDACTION_PATTERNS: Array<(line: string) => string> = [
  // Bearer / Authorization headers
  line => line.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]'),
  line => line.replace(/("authorization"\s*:\s*")[^"]+/gi, '$1[REDACTED]'),
  line => line.replace(/(x-api-key"\s*:\s*")[^"]+/gi, '$1[REDACTED]'),
  // Common API key prefixes
  line => line.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]'),
  line => line.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, 'sk-ant-[REDACTED]'),
  line => line.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, 'AIza[REDACTED]'),
  line => line.replace(/\bgsk_[A-Za-z0-9]{20,}\b/g, 'gsk_[REDACTED]'),
];

export function redactTraceLine(line: string): string {
  let out = line;
  for (const apply of REDACTION_PATTERNS) {
    out = apply(out);
  }
  return out;
}

export function redactTraceLog(content: string): string {
  return content.split('\n').map(redactTraceLine).join('\n');
}

export function writeSecureLogLine(path: string, line: string): void {
  ensureLogsDir();
  const redacted = redactTraceLine(line);
  try {
    writeFileSync(path, `${redacted}\n`, { flag: 'a', mode: FILE_MODE });
    chmodSync(path, FILE_MODE);
  } catch {
    // ignore
  }
}

export function printTraceLog(debugLogPath: string): void {
  if (!existsSync(debugLogPath)) return;
  const raw = readFileSync(debugLogPath, 'utf8');
  const log = redactTraceLog(raw);
  const errorLines = log.split('\n').filter(l =>
    l.includes('error') || l.includes('Error') || l.includes('"type":"error"') || l.includes('status'),
  );
  console.log('\n' + pc.bold(pc.cyan('── Debug trace ──')));
  if (errorLines.length > 0) {
    errorLines.slice(0, 30).forEach(l => console.log(pc.dim(l)));
  } else {
    console.log(pc.dim('(no errors found in debug log)'));
  }
  console.log(pc.dim(`Full log: ${debugLogPath}`));
}
