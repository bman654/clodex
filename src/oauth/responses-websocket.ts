// responses-websocket.ts — persistent outbound WebSocket transport for OpenAI's
// ChatGPT/Codex Responses backend.
//
// The Vercel AI SDK still sees a fetch-like SSE response per model call. Behind
// that interface, relay-ai retains one sequential WebSocket chain per opaque
// Claude session/model/effort/account partition and uses previous_response_id
// only after proving the next translated conversation appends to the chain head.

import { createHash } from 'node:crypto';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import type { RawData, WebSocket as WsWebSocket } from 'ws';
import { CODEX_RESPONSES_WEBSOCKETS_BETA } from '../constants.js';

const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
const TERMINAL_EVENT_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete']);
const FAILURE_EVENT_TYPES = new Set(['error', 'response.failed', 'response.incomplete']);

export const RESPONSES_WS_HARD_TTL_MS = 55 * 60_000;
export const RESPONSES_WS_IDLE_TTL_MS = 30 * 60_000;
export const RESPONSES_WS_MAX_CONNECTIONS = 32;

export interface ResponsesWebSocketFetchOptions {
  providerId?: string;
  accountId?: string;
  /** Test overrides; production callers should leave these unset. */
  hardTtlMs?: number;
  idleTtlMs?: number;
  maxConnections?: number;
  now?: () => number;
}

type JsonObject = Record<string, unknown>;

interface OutputAccumulator {
  type?: string;
  itemId?: string;
  text: string;
  summaries: Map<number, string>;
  done?: JsonObject;
}

interface RequestContext {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  originalPayload: JsonObject;
  sendPayload: JsonObject;
  promptFieldHashes: Record<string, string>;
  instructionsSnapshot?: string;
  continued: boolean;
  retried: boolean;
  closed: boolean;
  frameCount: number;
  responseId?: string;
  pendingEvents: unknown[];
  emittedModelData: boolean;
  outputByIndex: Map<number, OutputAccumulator>;
  outputIndexByItemId: Map<string, number>;
  entry?: ConnectionEntry;
  createReplacement: () => ConnectionEntry;
  abortCleanup?: () => void;
}

interface ConnectionEntry {
  debugId: number;
  key?: string;
  socket: WsWebSocket;
  persistent: boolean;
  open: boolean;
  createdAt: number;
  lastUsedAt: number;
  inFlight: boolean;
  current?: RequestContext;
  promptFieldHashes?: Record<string, string>;
  instructionsSnapshot?: string;
  responseId?: string;
  requestInput?: unknown[];
  expectedAssistant?: unknown[];
  options: Required<Pick<ResponsesWebSocketFetchOptions, 'hardTtlMs' | 'idleTtlMs' | 'maxConnections' | 'now'>>;
  debug: (message: string) => void;
}

// A Claude session partition can have multiple valid conversation heads at
// once: rewinds/branches, hidden title-generation requests, and stop hooks can
// all share its model/effort/cache key. Retain each head and select by exact
// conversation prefix instead of letting the newest branch replace the rest.
const connections = new Map<string, Set<ConnectionEntry>>();
let nextConnectionDebugId = 1;

function connectionEntries(key?: string): ConnectionEntry[] {
  return key ? [...(connections.get(key) ?? [])] : [...connections.values()].flatMap(entries => [...entries]);
}

function connectionCount(): number {
  let count = 0;
  for (const entries of connections.values()) count += entries.size;
  return count;
}

function registerEntry(entry: ConnectionEntry): void {
  if (!entry.key) return;
  let entries = connections.get(entry.key);
  if (!entries) {
    entries = new Set();
    connections.set(entry.key, entries);
  }
  entries.add(entry);
}

function unregisterEntry(entry: ConnectionEntry): void {
  if (!entry.key) return;
  const entries = connections.get(entry.key);
  if (!entries) return;
  entries.delete(entry);
  if (entries.size === 0) connections.delete(entry.key);
}

function debugKey(key: string | undefined): string {
  return key ? key.slice(0, 12) : 'none';
}

/** Test-only cleanup, also useful for preventing leaked fake sockets. */
export function resetResponsesWebSocketConnectionsForTests(): void {
  for (const entry of connectionEntries()) {
    try { entry.socket.close(); } catch { /* ignore */ }
  }
  connections.clear();
  nextConnectionDebugId = 1;
}

/** Normalize the SDK's HeadersInit into a plain record for `ws`. */
function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) out[key] = String(value);
  }
  return out;
}

function hasResponsesLiteHeader(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([key, value]) => key.toLowerCase() === RESPONSES_LITE_HEADER && value.toLowerCase() === 'true',
  );
}

function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body)).toString('utf8');
  return String(body);
}

function applyResponsesLiteShape(payload: JsonObject): JsonObject {
  const reasoning = payload.reasoning && typeof payload.reasoning === 'object'
    ? { ...(payload.reasoning as JsonObject) }
    : {};
  reasoning.context = 'all_turns';
  return { ...payload, reasoning, parallel_tool_calls: false, store: false };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value as JsonObject).sort()) {
    const child = (value as JsonObject)[key];
    if (child !== undefined) out[key] = canonicalize(child);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Fingerprint non-conversation request fields for privacy-safe diagnostics. */
export function responsesWebSocketPromptFingerprint(payload: JsonObject): string {
  const stable = { ...payload };
  delete stable.input;
  delete stable.previous_response_id;
  delete stable.stream;
  delete stable.background;
  return createHash('sha256').update(canonicalJson(stable)).digest('hex');
}

function responsesWebSocketPromptFieldHashes(payload: JsonObject): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const key of Object.keys(payload).sort()) {
    if (key === 'input' || key === 'previous_response_id' || key === 'stream' || key === 'background') continue;
    hashes[key] = createHash('sha256').update(canonicalJson(payload[key])).digest('hex').slice(0, 12);
  }
  return hashes;
}

function changedPromptFields(
  previous: Record<string, string> | undefined,
  current: Record<string, string>,
): string[] {
  if (!previous) return [];
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter(key => previous[key] !== current[key])
    .sort();
}

function instructionsFromPayload(payload: JsonObject): string | undefined {
  return typeof payload.instructions === 'string' ? payload.instructions : undefined;
}

function instructionChangeSummary(previous: string | undefined, current: string | undefined): string | undefined {
  if (previous === undefined || current === undefined || previous === current) return undefined;
  const comparable = Math.min(previous.length, current.length);
  let prefix = 0;
  while (prefix < comparable && previous[prefix] === current[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < comparable - prefix
    && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) suffix += 1;
  const firstDiffLine = previous.slice(0, prefix).split('\n').length;
  return `instructions changed: previous_chars=${previous.length} current_chars=${current.length} common_prefix_chars=${prefix} common_suffix_chars=${suffix} first_diff_line=${firstDiffLine}`;
}

/**
 * Opaque socket partition key. Prompt fields intentionally are not part of this
 * key: Responses accepts fresh instructions/tools on each create, and Claude can
 * change them during a normal tool loop. Exact conversation lineage is validated
 * separately before previous_response_id is used.
 */
export function responsesWebSocketPartitionKey(
  wsUrl: string,
  payload: JsonObject,
  options: Pick<ResponsesWebSocketFetchOptions, 'providerId' | 'accountId'> = {},
): string | undefined {
  const promptCacheKey = payload.prompt_cache_key;
  const model = payload.model;
  if (typeof promptCacheKey !== 'string' || !promptCacheKey || typeof model !== 'string' || !model) return undefined;
  const reasoning = payload.reasoning && typeof payload.reasoning === 'object'
    ? payload.reasoning as JsonObject
    : undefined;
  const effort = typeof reasoning?.effort === 'string' ? reasoning.effort.trim().toLowerCase() : '';
  const material = [
    wsUrl,
    options.providerId ?? 'openai',
    options.accountId ?? '',
    model,
    effort,
    promptCacheKey,
  ].join('\x1f');
  return createHash('sha256').update(material).digest('hex');
}

function inputArray(payload: JsonObject): unknown[] {
  return Array.isArray(payload.input) ? payload.input : [];
}

function normalizeToolCallJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeToolCallJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as JsonObject;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(record)) out[key] = normalizeToolCallJson(child);

  // Claude parses tool_use input into an object. The OpenAI SDK later serializes
  // it again, so insignificant whitespace and object-key order can differ from
  // the model's original function-call argument string. Compare the JSON value,
  // while leaving message text and function_call_output strings exact.
  const jsonField = record.type === 'function_call'
    ? 'arguments'
    : record.type === 'custom_tool_call' ? 'input' : undefined;
  if (jsonField && typeof record[jsonField] === 'string') {
    try {
      out[jsonField] = canonicalJson(JSON.parse(record[jsonField] as string));
    } catch {
      // A malformed/non-JSON custom-tool input must still match byte-for-byte.
    }
  }
  return out;
}

function arraysEqual(left: unknown[], right: unknown[]): boolean {
  return canonicalJson(normalizeToolCallJson(left)) === canonicalJson(normalizeToolCallJson(right));
}

function conversationItemKind(value: unknown): string {
  if (!value || typeof value !== 'object') return typeof value;
  const record = value as JsonObject;
  if (typeof record.type === 'string') return record.type;
  if (typeof record.role === 'string') return record.role;
  return 'object';
}

function continuationMismatchSummary(entry: ConnectionEntry, payload: JsonObject): string {
  const full = inputArray(payload);
  const prefix = [...(entry.requestInput ?? []), ...(entry.expectedAssistant ?? [])];
  const comparable = Math.min(full.length, prefix.length);
  let mismatch = comparable;
  for (let index = 0; index < comparable; index += 1) {
    if (!arraysEqual([full[index]], [prefix[index]])) {
      mismatch = index;
      break;
    }
  }
  const expected = mismatch < prefix.length ? conversationItemKind(prefix[mismatch]) : 'none';
  const actual = mismatch < full.length ? conversationItemKind(full[mismatch]) : 'none';
  return `full_items=${full.length} expected_prefix_items=${prefix.length} first_mismatch=${mismatch} expected=${expected} actual=${actual}`;
}

function continuationDelta(entry: ConnectionEntry, payload: JsonObject): unknown[] | undefined {
  if (!entry.responseId || !entry.requestInput || !entry.expectedAssistant) return undefined;
  const full = inputArray(payload);
  const prefix = [...entry.requestInput, ...entry.expectedAssistant];
  if (full.length <= prefix.length || !arraysEqual(full.slice(0, prefix.length), prefix)) return undefined;
  return full.slice(prefix.length);
}

function eventType(event: unknown): string | undefined {
  return event && typeof event === 'object' && typeof (event as JsonObject).type === 'string'
    ? (event as JsonObject).type as string
    : undefined;
}

function responseErrorCode(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  if (typeof record.code === 'string') return record.code;
  const error = record.error && typeof record.error === 'object' ? record.error as JsonObject : undefined;
  if (typeof error?.code === 'string') return error.code;
  const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
  const responseError = response?.error && typeof response.error === 'object' ? response.error as JsonObject : undefined;
  return typeof responseError?.code === 'string' ? responseError.code : undefined;
}

function responseIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const response = (event as JsonObject).response;
  if (!response || typeof response !== 'object') return undefined;
  return typeof (response as JsonObject).id === 'string' ? (response as JsonObject).id as string : undefined;
}

function responseUsageDebug(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const response = (event as JsonObject).response;
  if (!response || typeof response !== 'object') return undefined;
  const usage = (response as JsonObject).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const usageRecord = usage as JsonObject;
  const details = usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object'
    ? usageRecord.input_tokens_details as JsonObject
    : {};
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `usage input_tokens=${number(usageRecord.input_tokens)} `
    + `cached_tokens=${number(details.cached_tokens)} `
    + `cache_write_tokens=${number(details.cache_write_tokens ?? usageRecord.cache_write_tokens)} `
    + `output_tokens=${number(usageRecord.output_tokens)}`;
}

function outputAccumulator(ctx: RequestContext, index: number): OutputAccumulator {
  let accumulator = ctx.outputByIndex.get(index);
  if (!accumulator) {
    accumulator = { text: '', summaries: new Map() };
    ctx.outputByIndex.set(index, accumulator);
  }
  return accumulator;
}

function captureOutput(ctx: RequestContext, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const record = event as JsonObject;
  const type = eventType(event);
  if (type === 'response.created') {
    ctx.responseId = responseIdFromEvent(event) ?? ctx.responseId;
    return;
  }
  if (type === 'response.output_item.added' && typeof record.output_index === 'number') {
    const item = record.item && typeof record.item === 'object' ? record.item as JsonObject : {};
    const accumulator = outputAccumulator(ctx, record.output_index);
    accumulator.type = typeof item.type === 'string' ? item.type : accumulator.type;
    accumulator.itemId = typeof item.id === 'string' ? item.id : accumulator.itemId;
    if (accumulator.itemId) ctx.outputIndexByItemId.set(accumulator.itemId, record.output_index);
    return;
  }
  if (type === 'response.output_text.delta' && typeof record.item_id === 'string') {
    const index = ctx.outputIndexByItemId.get(record.item_id);
    if (index !== undefined && typeof record.delta === 'string') outputAccumulator(ctx, index).text += record.delta;
    return;
  }
  if (type === 'response.reasoning_summary_text.delta' && typeof record.item_id === 'string') {
    const index = ctx.outputIndexByItemId.get(record.item_id);
    if (index !== undefined && typeof record.delta === 'string') {
      const accumulator = outputAccumulator(ctx, index);
      const summaryIndex = typeof record.summary_index === 'number' ? record.summary_index : 0;
      accumulator.summaries.set(summaryIndex, (accumulator.summaries.get(summaryIndex) ?? '') + record.delta);
    }
    return;
  }
  if (type === 'response.output_item.done' && typeof record.output_index === 'number') {
    const item = record.item && typeof record.item === 'object' ? record.item as JsonObject : {};
    const accumulator = outputAccumulator(ctx, record.output_index);
    accumulator.type = typeof item.type === 'string' ? item.type : accumulator.type;
    accumulator.done = item;
    return;
  }
  if (TERMINAL_EVENT_TYPES.has(type ?? '')) {
    ctx.responseId = responseIdFromEvent(event) ?? ctx.responseId;
    const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
    if (Array.isArray(response?.output) && ctx.outputByIndex.size === 0) {
      response.output.forEach((item, index) => {
        if (item && typeof item === 'object') {
          outputAccumulator(ctx, index).done = item as JsonObject;
          outputAccumulator(ctx, index).type = typeof (item as JsonObject).type === 'string'
            ? (item as JsonObject).type as string
            : undefined;
        }
      });
    }
  }
}

function withoutEphemeralFields(item: JsonObject): JsonObject {
  const out = { ...item };
  delete out.id;
  delete out.status;
  delete out.phase;
  delete out.role;
  for (const [key, value] of Object.entries(out)) {
    if (value == null) delete out[key];
  }
  return out;
}

function expectedAssistantItems(ctx: RequestContext): unknown[] {
  const output: unknown[] = [];
  for (const [, accumulator] of [...ctx.outputByIndex.entries()].sort(([left], [right]) => left - right)) {
      const done = accumulator.done ?? {};
      const type = accumulator.type ?? (typeof done.type === 'string' ? done.type : undefined);
      if (type === 'message') {
        const doneContent = Array.isArray(done.content) ? done.content : undefined;
        const text = accumulator.text || (doneContent
          ? doneContent.filter(part => part && typeof part === 'object' && (part as JsonObject).type === 'output_text')
            .map(part => String((part as JsonObject).text ?? '')).join('')
          : '');
        output.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
        continue;
      }
      if (type === 'reasoning') {
        const summary = accumulator.summaries.size
          ? [...accumulator.summaries.entries()].sort(([a], [b]) => a - b)
            .map(([, text]) => ({ type: 'summary_text', text }))
          : Array.isArray(done.summary) ? done.summary : [];
        output.push({ ...withoutEphemeralFields(done), type: 'reasoning', summary });
        continue;
      }
      if (type === 'function_call' || type === 'custom_tool_call') {
        output.push({ ...withoutEphemeralFields(done), type });
      }
  }
  return output;
}

function encodeSse(ctx: RequestContext, event: unknown): void {
  if (ctx.closed) return;
  ctx.controller.enqueue(ctx.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

function flushPending(ctx: RequestContext): void {
  for (const event of ctx.pendingEvents) encodeSse(ctx, event);
  ctx.pendingEvents = [];
}

function closeContext(ctx: RequestContext): void {
  if (ctx.closed) return;
  ctx.closed = true;
  ctx.abortCleanup?.();
  try { ctx.controller.close(); } catch { /* already closed */ }
}

function deleteEntry(entry: ConnectionEntry, closeSocket = true): void {
  entry.inFlight = false;
  entry.current = undefined;
  unregisterEntry(entry);
  if (closeSocket) {
    try { entry.socket.close(); } catch { /* ignore */ }
  }
}

function failContext(entry: ConnectionEntry, ctx: RequestContext, message: string): void {
  if (ctx.closed || entry.current !== ctx) return;
  entry.debug(`fail: ${message}`);
  flushPending(ctx);
  encodeSse(ctx, { type: 'error', error: { message } });
  deleteEntry(entry);
  closeContext(ctx);
}

function cleanupConnections(now: number, maxConnections: number): void {
  for (const entry of connectionEntries()) {
    if (entry.inFlight) continue;
    if (now - entry.createdAt >= entry.options.hardTtlMs || now - entry.lastUsedAt >= entry.options.idleTtlMs) {
      entry.debug('evicting expired idle connection');
      deleteEntry(entry);
    }
  }
  const idle = connectionEntries()
    .filter(entry => !entry.inFlight)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  while (connectionCount() >= maxConnections && idle.length) {
    const oldest = idle.shift();
    if (oldest) deleteEntry(oldest);
  }
}

function isModelDataEvent(type: string | undefined): boolean {
  return Boolean(type && (
    type.includes('.delta')
    || type === 'response.output_item.added'
    || type === 'response.output_item.done'
  ));
}

function outgoingPayload(payload: JsonObject): string {
  return JSON.stringify({ type: 'response.create', ...payload });
}

type WebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WsWebSocket;

function sendContext(entry: ConnectionEntry, ctx: RequestContext): void {
  const outgoing = outgoingPayload(ctx.sendPayload);
  entry.debug(
    `connection=${entry.debugId} key=${debugKey(entry.key)} sending ${outgoing.length}B payload`
    + (ctx.continued ? ' (continuation)' : ''),
  );
  entry.socket.send(outgoing);
}

function dispatchContext(entry: ConnectionEntry, ctx: RequestContext): void {
  entry.inFlight = true;
  entry.current = ctx;
  entry.lastUsedAt = entry.options.now();
  ctx.entry = entry;
  if (entry.open) sendContext(entry, ctx);
}

function resetContextForRetry(ctx: RequestContext): void {
  ctx.continued = false;
  ctx.sendPayload = ctx.originalPayload;
  ctx.pendingEvents = [];
  ctx.emittedModelData = false;
  ctx.responseId = undefined;
  ctx.outputByIndex.clear();
  ctx.outputIndexByItemId.clear();
}

function handleSocketMessage(entry: ConnectionEntry, data: RawData): void {
  const ctx = entry.current;
  if (!ctx || ctx.closed) return;
  const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8');
  ctx.frameCount += 1;
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    ctx.pendingEvents.push(text.replace(/\r?\n/g, ' '));
    flushPending(ctx);
    return;
  }

  const type = eventType(event);
  captureOutput(ctx, event);
  if (type === 'response.completed') {
    const usage = responseUsageDebug(event);
    if (usage) entry.debug(usage);
  }
  if (isModelDataEvent(type)) ctx.emittedModelData = true;

  const previousMissing = responseErrorCode(event) === 'previous_response_not_found';
  if (previousMissing && ctx.continued && !ctx.retried && !ctx.emittedModelData) {
    ctx.retried = true;
    entry.debug('previous response unavailable; retrying once with full context');
    deleteEntry(entry);
    resetContextForRetry(ctx);
    const replacement = ctx.createReplacement();
    dispatchContext(replacement, ctx);
    return;
  }

  ctx.pendingEvents.push(event);
  if (isModelDataEvent(type)) flushPending(ctx);

  if (TERMINAL_EVENT_TYPES.has(type ?? '') || type === 'error') {
    flushPending(ctx);
    const failed = FAILURE_EVENT_TYPES.has(type ?? '');
    if (!failed && ctx.responseId && entry.persistent) {
      entry.responseId = ctx.responseId;
      entry.requestInput = inputArray(ctx.originalPayload);
      entry.expectedAssistant = expectedAssistantItems(ctx);
      entry.promptFieldHashes = ctx.promptFieldHashes;
      entry.instructionsSnapshot = ctx.instructionsSnapshot;
      entry.lastUsedAt = entry.options.now();
      entry.inFlight = false;
      entry.current = undefined;
      entry.debug(`chain head updated; socket retained (${ctx.frameCount} frame(s))`);
    } else {
      deleteEntry(entry);
    }
    if (!entry.persistent) {
      try { entry.socket.close(); } catch { /* ignore */ }
    }
    closeContext(ctx);
  }
}

function createConnection(
  WebSocket: WebSocketConstructor,
  wsUrl: string,
  headers: Record<string, string>,
  persistent: boolean,
  key: string | undefined,
  options: ConnectionEntry['options'],
  debug: ConnectionEntry['debug'],
): ConnectionEntry {
  const now = options.now();
  const socket = new WebSocket(wsUrl, { headers });
  const entry: ConnectionEntry = {
    debugId: nextConnectionDebugId++,
    key: persistent ? key : undefined,
    socket,
    persistent,
    open: false,
    createdAt: now,
    lastUsedAt: now,
    inFlight: false,
    options,
    debug,
  };
  if (persistent && key) registerEntry(entry);
  debug(
    `connection=${entry.debugId} key=${debugKey(entry.key)} created persistent=${persistent}`,
  );

  socket.on('open', () => {
    entry.open = true;
    debug(`connection=${entry.debugId} opened`);
    // Persistent cache sockets must not keep a finished relay-ai CLI process alive.
    (socket as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
    const ctx = entry.current;
    if (ctx && !ctx.closed) sendContext(entry, ctx);
  });
  socket.on('unexpected-response', (_request, response) => {
    debug(`unexpected-response status=${response.statusCode}`);
  });
  socket.on('message', (data: RawData) => handleSocketMessage(entry, data));
  socket.on('error', (error: Error) => {
    const ctx = entry.current;
    if (ctx) failContext(entry, ctx, error.message);
    else deleteEntry(entry);
  });
  socket.on('close', (code: number, reason: Buffer) => {
    entry.open = false;
    const ctx = entry.current;
    debug(`connection=${entry.debugId} closed code=${code} in_flight=${Boolean(ctx && !ctx.closed)}`);
    if (ctx && !ctx.closed) {
      const suffix = reason?.length ? `: ${reason.toString('utf8')}` : '';
      failContext(entry, ctx, `WebSocket closed (${code})${suffix}`);
    } else {
      deleteEntry(entry, false);
    }
  });
  return entry;
}

/**
 * Build a fetch transport backed by persistent, session-aware Responses sockets.
 * Each returned Response still represents exactly one AI SDK request.
 */
export function createResponsesWebSocketFetch(
  wsUrl: string,
  log?: (message: string) => void,
  options: ResponsesWebSocketFetchOptions = {},
): FetchFunction {
  const debug = (message: string) => { try { log?.(`ws: ${message}`); } catch { /* ignore */ } };
  const resolvedOptions = {
    hardTtlMs: options.hardTtlMs ?? RESPONSES_WS_HARD_TTL_MS,
    idleTtlMs: options.idleTtlMs ?? RESPONSES_WS_IDLE_TTL_MS,
    maxConnections: options.maxConnections ?? RESPONSES_WS_MAX_CONNECTIONS,
    now: options.now ?? Date.now,
  };

  return async (_input, init): Promise<Response> => {
    const { WebSocket } = await import('ws');
    const headers = toHeaderRecord(init?.headers);
    headers['OpenAI-Beta'] = CODEX_RESPONSES_WEBSOCKETS_BETA;

    let payload: JsonObject;
    try {
      payload = JSON.parse(bodyToString(init?.body)) as JsonObject;
    } catch {
      payload = {};
    }
    if (hasResponsesLiteHeader(headers)) payload = applyResponsesLiteShape(payload);

    const partitionKey = responsesWebSocketPartitionKey(wsUrl, payload, options);
    const promptFingerprint = responsesWebSocketPromptFingerprint(payload);
    const promptFieldHashes = responsesWebSocketPromptFieldHashes(payload);
    const instructionsSnapshot = instructionsFromPayload(payload);
    const now = resolvedOptions.now();
    cleanupConnections(now, resolvedOptions.maxConnections);

    const candidates = partitionKey ? connectionEntries(partitionKey) : [];
    const idleCandidates = candidates.filter(entry => !entry.inFlight);
    const matches = idleCandidates
      .map(entry => ({ entry, delta: continuationDelta(entry, payload) }))
      .filter((match): match is { entry: ConnectionEntry; delta: unknown[] } => match.delta !== undefined)
      // Prefer the longest matching history, which produces the smallest delta.
      .sort((left, right) => left.delta.length - right.delta.length);
    let selected: ConnectionEntry | undefined = matches[0]?.entry;
    const selectedDelta = matches[0]?.delta;
    const diagnosticEntry = selected
      ?? [...idleCandidates].sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0]
      ?? candidates[0];
    debug(
      `lookup key=${debugKey(partitionKey)} prompt=${debugKey(promptFingerprint)} hit=${candidates.length > 0} heads=${candidates.length} active_connections=${connectionCount()}`,
    );
    const promptChanges = changedPromptFields(diagnosticEntry?.promptFieldHashes, promptFieldHashes);
    if (promptChanges.length) debug(`prompt fields changed: ${promptChanges.join(',')}`);
    if (promptChanges.includes('instructions')) {
      const summary = instructionChangeSummary(diagnosticEntry?.instructionsSnapshot, instructionsSnapshot);
      if (summary) debug(summary);
    }
    let sendPayload = payload;
    let continued = false;
    let persistent = Boolean(partitionKey);

    if (selected && selectedDelta) {
      sendPayload = { ...payload, input: selectedDelta, previous_response_id: selected.responseId };
      continued = true;
      debug(`continuing chain with ${selectedDelta.length} incremental input item(s)`);
    } else if (candidates.some(entry => entry.inFlight)) {
      // Claude auxiliary requests can share a session id. Never multiplex or
      // queue a request whose lineage cannot yet include the active response.
      selected = undefined;
      persistent = false;
      debug('parallel request using an isolated socket');
    } else if (diagnosticEntry) {
      // A rewind, branch, or hidden auxiliary inference gets its own full-context
      // head. Existing heads remain eligible for later exact-prefix matches.
      debug(
        `history mismatch starting an additional chain; retained ${candidates.length} existing head(s) `
        + `(${continuationMismatchSummary(diagnosticEntry, payload)})`,
      );
    }

    let activeContext: RequestContext | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const ctx: RequestContext = {
          controller,
          encoder: new TextEncoder(),
          originalPayload: payload,
          sendPayload,
          promptFieldHashes,
          instructionsSnapshot,
          continued,
          retried: false,
          closed: false,
          frameCount: 0,
          pendingEvents: [],
          emittedModelData: false,
          outputByIndex: new Map(),
          outputIndexByItemId: new Map(),
          createReplacement: () => createConnection(
            WebSocket as unknown as WebSocketConstructor,
            wsUrl,
            headers,
            Boolean(partitionKey),
            partitionKey,
            resolvedOptions,
            debug,
          ),
        };
        activeContext = ctx;

        const entry = selected ?? createConnection(
          WebSocket as unknown as WebSocketConstructor,
          wsUrl,
          headers,
          persistent,
          partitionKey,
          resolvedOptions,
          debug,
        );
        dispatchContext(entry, ctx);

        const signal = init?.signal;
        if (signal) {
          const abort = () => {
            if (ctx.closed) return;
            if (ctx.entry) deleteEntry(ctx.entry);
            closeContext(ctx);
          };
          if (signal.aborted) abort();
          else {
            signal.addEventListener('abort', abort, { once: true });
            ctx.abortCleanup = () => signal.removeEventListener('abort', abort);
          }
        }
      },
      cancel() {
        // The SDK cancelling the synthetic response invalidates any in-flight
        // connection-local state; the AbortSignal path normally runs first.
        const ctx = activeContext;
        if (!ctx || ctx.closed) return;
        if (ctx.entry) deleteEntry(ctx.entry);
        closeContext(ctx);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };
}
