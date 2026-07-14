// src/trace-log.ts — debug log paths under ~/.relay-ai/logs/ with secret redaction

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import pc from 'picocolors';
import { getLogsPath } from './paths.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const CLAUDE_DEBUG_LOG = 'claude-debug.log';
export const PROXY_DEBUG_LOG = 'proxy-debug.log';
export const CODEX_PROXY_DEBUG_LOG = 'codex-proxy-debug.log';
export const GEMINI_PROXY_DEBUG_LOG = 'gemini-proxy-debug.log';
export const PROVIDER_DEBUG_LOG = 'provider-debug.log';
export const UI_DEBUG_LOG = 'ui-debug.log';
export const INFERENCE_REQUEST_LOG = 'inference-requests.jsonl';
export const INFERENCE_PROGRESS_INTERVAL_MS = 30_000;
const INFERENCE_SESSION_DIR = 'sessions';
let inferenceSessionSequence = 0;

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

export function prepareClaudeTraceLog(path = getClaudeDebugLogPath()): string {
  resetTraceLog(path);
  return path;
}

export function getProxyDebugLogPath(): string {
  return join(ensureLogsDir(), PROXY_DEBUG_LOG);
}

export function getCodexProxyDebugLogPath(): string {
  return join(ensureLogsDir(), CODEX_PROXY_DEBUG_LOG);
}

export function getGeminiProxyDebugLogPath(): string {
  return join(ensureLogsDir(), GEMINI_PROXY_DEBUG_LOG);
}

export function getProviderDebugLogPath(): string {
  return join(ensureLogsDir(), PROVIDER_DEBUG_LOG);
}

export function getUiDebugLogPath(): string {
  return join(ensureLogsDir(), UI_DEBUG_LOG);
}

export function getInferenceRequestLogPath(): string {
  return join(ensureLogsDir(), INFERENCE_REQUEST_LOG);
}

/** Create a collision-resistant log path for one short-lived process. */
export function getSessionLogPath(label = 'session', extension = 'log'): string {
  const dir = join(ensureLogsDir(), INFERENCE_SESSION_DIR);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // best-effort
  }
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'proxy';
  const safeExtension = extension.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'log';
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  const sequence = inferenceSessionSequence++;
  return join(dir, `${timestamp}-${safeLabel}-pid${process.pid}-${sequence}.${safeExtension}`);
}

/** Create a collision-resistant JSONL path for one short-lived proxy process. */
export function getInferenceSessionLogPath(label = 'proxy'): string {
  return getSessionLogPath(label, 'jsonl');
}

const REQUEST_PREVIEW_ENV = 'RELAY_AI_LOG_REQUEST_PREVIEW';
const REQUEST_PREVIEW_MAX = 240;
const RESPONSE_ERROR_MAX = 2_000;

function compactLogValue(value: string, max = 500): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactLogValueWithMarker(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  const marker = ' [truncated]';
  return compact.slice(0, max - marker.length) + marker;
}

function systemPreview(system: unknown): string | undefined {
  if (typeof system === 'string') return compactLogValue(system, REQUEST_PREVIEW_MAX) || undefined;
  if (!Array.isArray(system)) return undefined;
  const text = system
    .map(block => typeof block === 'string'
      ? block
      : block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string'
        ? (block as Record<string, unknown>).text as string
        : '')
    .filter(Boolean)
    .join(' ');
  return compactLogValue(text, REQUEST_PREVIEW_MAX) || undefined;
}

function inlineSystemPreview(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'system') continue;
    const preview = systemPreview(record.content);
    if (preview) return preview;
  }
  return undefined;
}

export function getLatestMessagePreview(messages: unknown, system?: unknown): string | undefined {
  let blockSummary: string | undefined;
  if (Array.isArray(messages) && messages.length > 0) {
    const message = messages[messages.length - 1];
    if (message && typeof message === 'object') {
      const record = message as Record<string, unknown>;
      const role = typeof record.role === 'string' ? record.role : 'message';
      const content = record.content;
      let summary: string | undefined;

      if (typeof content === 'string') {
        summary = content;
      } else if (Array.isArray(content)) {
        const text = content
          .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object'))
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text as string)
          .join(' ');
        if (text.trim()) {
          summary = text;
        } else {
          const blockTypes = [...new Set(content
            .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object'))
            .map(block => typeof block.type === 'string' ? block.type : 'unknown'))];
          if (blockTypes.length > 0) blockSummary = `${role}: [${blockTypes.join(', ')}]`;
        }
      }

      const compact = summary ? compactLogValue(summary, REQUEST_PREVIEW_MAX) : '';
      if (compact) return `${role}: ${compact}`;
    }
  }

  const systemText = systemPreview(system) ?? inlineSystemPreview(messages);
  if (!systemText) return blockSummary;
  const preview = blockSummary
    ? `${blockSummary} | system: ${systemText}`
    : `system: ${systemText}`;
  return compactLogValue(preview, REQUEST_PREVIEW_MAX + 20);
}

export interface InferenceRequestLogEntry {
  requestId?: string;
  modelId: string;
  provider: string;
  effort?: string;
  route: 'passthrough' | 'translated';
  stream?: boolean;
  requestPreview?: string;
}

export interface InferenceResponseErrorLogEntry {
  requestId?: string;
  modelId: string;
  provider: string;
  route: 'passthrough' | 'translated';
  statusCode: number;
  errorContent?: string;
  isRetryable?: boolean;
  attemptCount?: number;
}

export type InferenceResponseLifecycleEvent =
  | 'translation_dispatched'
  | 'translation_started'
  | 'translation_progress'
  | 'translation_completed'
  | 'translation_cancelled'
  | 'translation_failed'
  | 'response_started'
  | 'response_progress'
  | 'response_completed'
  | 'response_failed'
  | 'response_client_disconnected'
  | 'response_usage';

export type InferenceResponsePhase =
  | 'preparing_translation'
  | 'waiting_for_sdk'
  | 'translating'
  | 'waiting_for_headers'
  | 'waiting_for_first_byte'
  | 'streaming'
  | 'delivering';

export interface InferenceResponseLifecycleLogEntry {
  event: InferenceResponseLifecycleEvent;
  requestId: string;
  modelId: string;
  provider: string;
  route: 'passthrough' | 'translated';
  statusCode?: number;
  phase?: InferenceResponsePhase;
  durationMs?: number;
  timeToFirstByteMs?: number;
  idleMs?: number;
  bytes?: number;
  chunks?: number;
  sdkParts?: number;
  sdkIdleMs?: number;
  translatedBytes?: number;
  translatedChunks?: number;
  outputIdleMs?: number;
  usageStage?: 'message_start' | 'message_delta';
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  lastPartType?: string;
  errorType?: string;
  errorSignature?: string;
}

export type ProxyLifecycleEvent =
  | 'proxy_started'
  | 'proxy_stopping'
  | 'proxy_stopped'
  | 'proxy_process_exit';

export interface ProxyLifecycleLogEntry {
  event: ProxyLifecycleEvent;
  pid: number;
  parentPid?: number;
  host?: string;
  port?: number;
  adapterPort?: number;
  inheritedProxyPort?: number;
  exitCode?: number;
  reason?: string;
}

export interface WebSocketDiagnosticRequestLogEntry {
  requestId: string;
  provider?: string;
  route?: 'passthrough' | 'translated';
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

const REDACTED_DIAGNOSTIC_HEADER = '[REDACTED]';
const SENSITIVE_DIAGNOSTIC_HEADER = /(?:^|[-_])(?:authorization|api[-_]?key|cookie|token|secret|credential)(?:$|[-_])/i;
const CONVERSATION_BODY_FIELDS = new Set(['system', 'messages', 'tools']);

function canonicalDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDiagnosticValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalDiagnosticValue(child)]),
  );
}

function diagnosticHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalDiagnosticValue(value)) ?? 'undefined')
    .digest('hex')
    .slice(0, 16);
}

function diagnosticBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

/** Preserve every inbound header except credential-bearing values. */
export function sanitizeDiagnosticHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = SENSITIVE_DIAGNOSTIC_HEADER.test(name)
      ? REDACTED_DIAGNOSTIC_HEADER
      : value;
  }
  return out;
}

function contentKinds(content: unknown): string[] {
  if (typeof content === 'string') return ['text'];
  if (!Array.isArray(content)) return [typeof content];
  return content.map(item => {
    if (!item || typeof item !== 'object') return typeof item;
    const record = item as Record<string, unknown>;
    return typeof record.type === 'string' ? record.type : 'object';
  });
}

/**
 * Capture the complete non-conversation envelope plus hashes/shapes for prompt
 * fields. Hashes make rewinds and harness requests comparable without writing
 * message, system-prompt, tool-description, schema, or tool-result content.
 */
export function summarizeDiagnosticRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const parameters = Object.fromEntries(
    Object.entries(body).filter(([key]) => !CONVERSATION_BODY_FIELDS.has(key)),
  );
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    topLevelKeys: Object.keys(body).sort(),
    parameters,
    system: body.system === undefined ? undefined : {
      hash: diagnosticHash(body.system),
      bytes: diagnosticBytes(body.system),
      blocks: Array.isArray(body.system) ? body.system.length : 1,
    },
    messages: {
      count: messages.length,
      items: messages.map(message => {
        const record = message && typeof message === 'object' ? message as Record<string, unknown> : {};
        return {
          role: typeof record.role === 'string' ? record.role : 'unknown',
          contentKinds: contentKinds(record.content),
          hash: diagnosticHash(message),
          bytes: diagnosticBytes(message),
        };
      }),
    },
    tools: {
      count: tools.length,
      items: tools.map(tool => {
        const record = tool && typeof tool === 'object' ? tool as Record<string, unknown> : {};
        return {
          name: typeof record.name === 'string' ? compactLogValue(record.name, 200) : 'unknown',
          descriptionHash: diagnosticHash(record.description),
          schemaHash: diagnosticHash(record.input_schema),
          hash: diagnosticHash(tool),
        };
      }),
    },
  };
}

/** Append privacy-minimal routing metadata, plus an explicitly enabled request preview. */
export function writeInferenceRequestLog(
  path: string,
  entry: InferenceRequestLogEntry,
): void {
  const includePreview = process.env[REQUEST_PREVIEW_ENV] === '1' && entry.requestPreview;
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...(entry.requestId ? { requestId: compactLogValue(entry.requestId, 100) } : {}),
    modelId: compactLogValue(entry.modelId),
    ...(entry.effort ? { effort: compactLogValue(entry.effort, 100) } : {}),
    provider: compactLogValue(entry.provider, 200),
    route: entry.route,
    ...(entry.stream !== undefined ? { stream: entry.stream } : {}),
    ...(includePreview ? { requestPreview: compactLogValue(entry.requestPreview!, REQUEST_PREVIEW_MAX + 20) } : {}),
  }));
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}

/** Append privacy-minimal response timing and delivery metadata. */
export function writeInferenceResponseLifecycleLog(
  path: string,
  entry: InferenceResponseLifecycleLogEntry,
): void {
  const statusCode = nonNegativeInteger(entry.statusCode);
  const durationMs = nonNegativeInteger(entry.durationMs);
  const timeToFirstByteMs = nonNegativeInteger(entry.timeToFirstByteMs);
  const idleMs = nonNegativeInteger(entry.idleMs);
  const bytes = nonNegativeInteger(entry.bytes);
  const chunks = nonNegativeInteger(entry.chunks);
  const sdkParts = nonNegativeInteger(entry.sdkParts);
  const sdkIdleMs = nonNegativeInteger(entry.sdkIdleMs);
  const translatedBytes = nonNegativeInteger(entry.translatedBytes);
  const translatedChunks = nonNegativeInteger(entry.translatedChunks);
  const outputIdleMs = nonNegativeInteger(entry.outputIdleMs);
  const inputTokens = nonNegativeInteger(entry.inputTokens);
  const outputTokens = nonNegativeInteger(entry.outputTokens);
  const cacheCreationInputTokens = nonNegativeInteger(entry.cacheCreationInputTokens);
  const cacheReadInputTokens = nonNegativeInteger(entry.cacheReadInputTokens);
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: entry.event,
    requestId: compactLogValue(entry.requestId, 100),
    modelId: compactLogValue(entry.modelId),
    provider: compactLogValue(entry.provider, 200),
    route: entry.route,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(entry.phase ? { phase: entry.phase } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(timeToFirstByteMs !== undefined ? { timeToFirstByteMs } : {}),
    ...(idleMs !== undefined ? { idleMs } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(chunks !== undefined ? { chunks } : {}),
    ...(sdkParts !== undefined ? { sdkParts } : {}),
    ...(sdkIdleMs !== undefined ? { sdkIdleMs } : {}),
    ...(translatedBytes !== undefined ? { translatedBytes } : {}),
    ...(translatedChunks !== undefined ? { translatedChunks } : {}),
    ...(outputIdleMs !== undefined ? { outputIdleMs } : {}),
    ...(entry.usageStage ? { usageStage: entry.usageStage } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(entry.lastPartType ? { lastPartType: compactLogValue(entry.lastPartType, 100) } : {}),
    ...(entry.errorType ? { errorType: compactLogValue(entry.errorType, 200) } : {}),
    ...(entry.errorSignature ? { errorSignature: compactLogValue(entry.errorSignature, 100) } : {}),
  }));
}

/** Record enough process lifetime metadata to distinguish a dead local proxy from an upstream failure. */
export function writeProxyLifecycleLog(path: string, entry: ProxyLifecycleLogEntry): void {
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: entry.event,
    pid: nonNegativeInteger(entry.pid),
    ...(entry.parentPid !== undefined ? { parentPid: nonNegativeInteger(entry.parentPid) } : {}),
    ...(entry.host ? { host: compactLogValue(entry.host, 200) } : {}),
    ...(entry.port !== undefined ? { port: nonNegativeInteger(entry.port) } : {}),
    ...(entry.adapterPort !== undefined ? { adapterPort: nonNegativeInteger(entry.adapterPort) } : {}),
    ...(entry.inheritedProxyPort !== undefined ? { inheritedProxyPort: nonNegativeInteger(entry.inheritedProxyPort) } : {}),
    ...(entry.exitCode !== undefined ? { exitCode: Math.round(entry.exitCode) } : {}),
    ...(entry.reason ? { reason: compactLogValue(entry.reason, 200) } : {}),
  }));
}

/** Write one opt-in request-envelope diagnostic without conversation content. */
export function writeWebSocketDiagnosticRequestLog(
  path: string,
  entry: WebSocketDiagnosticRequestLogEntry,
): void {
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'request_diagnostic',
    requestId: compactLogValue(entry.requestId, 100),
    ...(entry.provider ? { provider: compactLogValue(entry.provider, 200) } : {}),
    ...(entry.route ? { route: entry.route } : {}),
    headers: sanitizeDiagnosticHeaders(entry.headers),
    body: summarizeDiagnosticRequestBody(entry.body),
  }));
}

/** Append a structured WebSocket transport diagnostic event. */
export function writeWebSocketDiagnosticLog(
  path: string,
  entry: Record<string, unknown>,
): void {
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  }));
}

/** Append an upstream HTTP failure; response content follows the request-preview opt-in. */
export function writeInferenceResponseErrorLog(
  path: string,
  entry: InferenceResponseErrorLogEntry,
): void {
  const includeContent = process.env[REQUEST_PREVIEW_ENV] === '1' && entry.errorContent;
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'upstream_error',
    ...(entry.requestId ? { requestId: compactLogValue(entry.requestId, 100) } : {}),
    modelId: compactLogValue(entry.modelId),
    provider: compactLogValue(entry.provider, 200),
    route: entry.route,
    statusCode: entry.statusCode,
    ...(entry.isRetryable !== undefined ? { isRetryable: entry.isRetryable } : {}),
    ...(entry.attemptCount !== undefined ? { attemptCount: entry.attemptCount } : {}),
    ...(includeContent ? { errorContent: compactLogValueWithMarker(entry.errorContent!, RESPONSE_ERROR_MAX) } : {}),
  }));
}

export function prepareProviderTraceLog(): string {
  const path = getProviderDebugLogPath();
  resetTraceLog(path);
  return path;
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
    l.includes('error') || l.includes('Error') || l.includes('"type":"error"') || l.includes('status') || l.includes('resolveModel failed') || l.includes('resolveModel fallback'),
  );
  console.log('\n' + pc.bold(pc.cyan('── Debug trace ──')));
  if (errorLines.length > 0) {
    errorLines.slice(0, 30).forEach(l => console.log(pc.dim(l)));
  } else {
    console.log(pc.dim('(no errors found in debug log)'));
  }
  console.log(pc.dim(`Full log: ${debugLogPath}`));
}
