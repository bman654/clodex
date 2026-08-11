// responses-websocket.ts — persistent outbound WebSocket transport for OpenAI's
// ChatGPT/Codex Responses backend.
//
// The Vercel AI SDK still sees a fetch-like SSE response per model call. Behind
// that interface, clodex retains one sequential WebSocket chain per opaque
// Claude session/model/effort/account partition and uses previous_response_id
// only after proving the next translated conversation appends to the chain head.

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import type { RawData, WebSocket as WsWebSocket } from 'ws';
import { CODEX_RESPONSES_WEBSOCKETS_BETA } from '../constants.js';
import { outboundWsProxyAgent } from '../outbound-proxy.js';
import {
  anthropicErrorType,
  clampRetryAfterSeconds,
  frameStatusCode,
  MAX_RETRY_AFTER_SECONDS,
} from '../upstream-error.js';
import { sanitizeToolInput } from '../tool-input-sanitize.js';

const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
const TERMINAL_EVENT_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete']);
const FAILURE_EVENT_TYPES = new Set(['error', 'response.failed', 'response.incomplete']);

export const RESPONSES_WS_HARD_TTL_MS = 55 * 60_000;
export const RESPONSES_WS_IDLE_TTL_MS = 30 * 60_000;
export const RESPONSES_WS_NURSERY_IDLE_TTL_MS = 5 * 60_000;
export const RESPONSES_WS_MAX_CONNECTIONS = 32;
export const RESPONSES_WS_MAX_NURSERY_CONNECTIONS = 8;

export interface ResponsesWebSocketFetchOptions {
  providerId?: string;
  accountId?: string;
  /** Test overrides; production callers should leave these unset. */
  hardTtlMs?: number;
  idleTtlMs?: number;
  nurseryIdleTtlMs?: number;
  maxConnections?: number;
  maxNurseryConnections?: number;
  now?: () => number;
  /** Opt-in structured transport diagnostics; never receives conversation content. */
  onDiagnostic?: (event: ResponsesWebSocketDiagnosticEvent) => void;
}

export interface ResponsesWebSocketDiagnosticEvent extends Record<string, unknown> {
  event: string;
  requestId?: string;
}

export interface ResponsesWebSocketDiagnosticContext {
  requestId?: string;
  claudeSessionId?: string;
}

const diagnosticContext = new AsyncLocalStorage<ResponsesWebSocketDiagnosticContext>();

/** Correlate a gateway/proxy request with the lower-level SDK WebSocket fetch. */
export function withResponsesWebSocketDiagnosticContext<T>(
  context: ResponsesWebSocketDiagnosticContext,
  fn: () => T,
): T {
  return diagnosticContext.run(context, fn);
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
  emittedDownstreamData: boolean;
  transportRetryPending: boolean;
  outputByIndex: Map<number, OutputAccumulator>;
  outputIndexByItemId: Map<string, number>;
  reasoningPartsByItemId: Map<string, Map<number, ReasoningPartState>>;
  recentUpstreamEventTypes: string[];
  emittedProtocolAnomalies: Set<string>;
  emitDiagnostic?: (event: { event: string } & Record<string, unknown>) => void;
  entry?: ConnectionEntry;
  createReplacement: () => ConnectionEntry;
  abortCleanup?: () => void;
}

type ReasoningPartState = 'active' | 'can_conclude' | 'concluded';

interface ConnectionEntry {
  debugId: number;
  key?: string;
  socket: WsWebSocket;
  persistent: boolean;
  generation: 'nursery' | 'established' | 'isolated';
  open: boolean;
  createdAt: number;
  ttlPausedMs: number;
  inFlightStartedAt?: number;
  lastUsedAt: number;
  inFlight: boolean;
  current?: RequestContext;
  promptFieldHashes?: Record<string, string>;
  instructionsSnapshot?: string;
  responseId?: string;
  requestInput?: unknown[];
  expectedAssistant?: unknown[];
  /**
   * The per-tool `required` sets that were in force when `expectedAssistant`
   * was snapshotted. The strip rule's outcome depends on them, so a later turn
   * that declares different tools must not be used to re-derive what this head
   * stripped — that flips the gap verdict with no code change at all.
   */
  headRequiredToolProps?: Map<string, Set<string>>;
  /** Memoized canonical form of the stored prefix; cleared whenever it changes. */
  canonicalPrefix?: string[];
  canonicalEchoablePrefix?: string[];
  options: Required<Pick<ResponsesWebSocketFetchOptions, 'hardTtlMs' | 'idleTtlMs' | 'nurseryIdleTtlMs' | 'maxConnections' | 'now'>>;
  debug: (message: string) => void;
}

// A Claude session partition can have multiple valid conversation heads at
// once: rewinds/branches, hidden title-generation requests, and stop hooks can
// all share its model/effort/cache key. Retain each head and select by exact
// conversation prefix instead of letting the newest branch replace the rest.
// New heads live in a separately capped nursery LRU until their first reuse;
// established heads therefore never consume nursery capacity, and one-shot
// nursery traffic never consumes the established LRU's 32 reserved slots.
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

function connectionCountByGeneration(generation: ConnectionEntry['generation']): number {
  return connectionEntries().filter(entry => entry.generation === generation).length;
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

function emitDiagnostic(
  options: ResponsesWebSocketFetchOptions,
  event: { event: string } & Record<string, unknown>,
  correlation = diagnosticContext.getStore(),
): void {
  if (!options.onDiagnostic) return;
  try {
    options.onDiagnostic({
      ...event,
      ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
      ...(correlation?.claudeSessionId ? { claudeSessionId: correlation.claudeSessionId } : {}),
    });
  } catch {
    // Diagnostics must never alter inference behavior.
  }
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

function authorizationHeaderFingerprint(headers: Record<string, string>): string {
  const authorization = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  return authorization ? createHash('sha256').update(authorization).digest('hex') : '';
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
 * separately before previous_response_id is used. The authorization fingerprint
 * prevents a refreshed credential from inheriting a socket authenticated with the
 * token that the upstream rejected.
 */
export function responsesWebSocketPartitionKey(
  wsUrl: string,
  payload: JsonObject,
  options: Pick<ResponsesWebSocketFetchOptions, 'providerId' | 'accountId'> = {},
  authorizationFingerprint = '',
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
    authorizationFingerprint,
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

  // A reasoning item comes back from the Responses API carrying an empty
  // `content: []`, which we retain when snapshotting the expected assistant
  // items. The SDK rebuilds the echoed item from the encrypted content and
  // summary alone, so it never re-emits that key and the chain head could
  // never match its own echo. An empty array carries no information; drop it
  // from both sides. A populated `content` is real data and still compared.
  if (record.type === 'reasoning') {
    if (Array.isArray(record.content) && record.content.length === 0) delete out.content;
    // `encrypted_content` IS the reasoning item's identity, and the real state
    // lives upstream under previous_response_id — the summary is display text.
    // It also cannot survive the round trip intact: the SDK emits one reasoning
    // part per summary part, but only the LAST part's `reasoning-end` carries the
    // encrypted content, so the unsigned earlier blocks are dropped on the way
    // back and a multi-part summary returns holding only its final part. Compare
    // on the blob and a head can match its own echo.
    if (typeof record.encrypted_content === 'string' && record.encrypted_content) delete out.summary;
  }
  return out;
}

function arraysEqual(left: unknown[], right: unknown[]): boolean {
  return canonicalJson(normalizeToolCallJson(left)) === canonicalJson(normalizeToolCallJson(right));
}

type ContinuationMatchMode = 'exact' | 'omitted_reasoning';

interface ContinuationMatch {
  delta: unknown[];
  mode: ContinuationMatchMode;
}

function conversationItemKind(value: unknown): string {
  if (!value || typeof value !== 'object') return typeof value;
  const record = value as JsonObject;
  if (typeof record.type === 'string') return record.type;
  if (typeof record.role === 'string') return record.role;
  return 'object';
}

function conversationItemHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(normalizeToolCallJson(value))).digest('hex').slice(0, 16);
}

/**
 * Names the fields that differ between the stored reasoning item and the one
 * Claude echoed back, but ONLY when both carry the same `encrypted_content`.
 *
 * That blob is the reasoning item's identity: when it matches, the two objects
 * describe the same reasoning and the continuation should have been accepted,
 * so any remaining difference is a normalization gap on our side. When it
 * differs the items are genuinely different reasoning (a divergent branch or a
 * fresh turn) and the mismatch is correct, not a defect — reporting those would
 * bury the signal in noise.
 */
function reasoningNormalizationGap(expected: unknown, actual: unknown): string[] | undefined {
  if (conversationItemKind(expected) !== 'reasoning' || conversationItemKind(actual) !== 'reasoning') return undefined;
  const left = expected as JsonObject;
  const right = actual as JsonObject;
  const blob = left.encrypted_content;
  if (typeof blob !== 'string' || !blob || blob !== right.encrypted_content) return undefined;
  // Diff the NORMALIZED items. Diffing the raw ones names fields that
  // normalization already reconciles, which points a reader at a red herring.
  const normalizedLeft = normalizeToolCallJson(left) as JsonObject;
  const normalizedRight = normalizeToolCallJson(right) as JsonObject;
  const fields = [...new Set([...Object.keys(normalizedLeft), ...Object.keys(normalizedRight)])].sort()
    .filter(key => canonicalJson(normalizedLeft[key]) !== canonicalJson(normalizedRight[key]));
  return fields.length ? fields : undefined;
}

/**
 * Describes the SHAPE of a reasoning gap without recording any reasoning text.
 *
 * Naming the differing fields says a gap exists but not why. Two mechanisms can
 * produce the same field list: one upstream reasoning item carrying several
 * summary parts and coming back split into several items, or a single item that
 * genuinely differs. Counting the summary/content elements on each side, plus how
 * many consecutive reasoning items share this `encrypted_content`, separates them
 * from the diagnostic log alone.
 */
function reasoningGapShape(
  expected: unknown,
  actual: unknown,
  full: unknown[],
  storedTail: unknown[],
  index: number,
): Record<string, unknown> {
  const describe = (value: unknown) => {
    const record = (value ?? {}) as JsonObject;
    return {
      keys: Object.keys(record).sort(),
      summaryParts: Array.isArray(record.summary) ? record.summary.length : 0,
      contentItems: Array.isArray(record.content) ? record.content.length : 0,
    };
  };
  const blob = (expected as JsonObject).encrypted_content;
  const runFrom = (items: unknown[], start: number) => {
    let count = 0;
    for (let at = start; at < items.length; at += 1) {
      const item = items[at] as JsonObject | undefined;
      if (conversationItemKind(item) !== 'reasoning' || item?.encrypted_content !== blob) break;
      count += 1;
    }
    return count;
  };
  const storedStart = storedTail.findIndex(item => (item as JsonObject)?.encrypted_content === blob);
  return {
    expected: describe(expected),
    actual: describe(actual),
    clientReasoningRun: runFrom(full, index),
    storedReasoningRun: storedStart < 0 ? 0 : runFrom(storedTail, storedStart),
  };
}

const warnedReasoningGaps = new Set<string>();
const MAX_REASONING_GAP_WARNINGS = 3;

/**
 * Surfaces a normalization gap on stderr so it is visible in the terminal that
 * started clodex without needing --trace. Deduplicated by the differing-field
 * signature and hard-capped, because this shares a terminal with Claude Code's
 * interactive UI and must never become a stream.
 */
function warnReasoningNormalizationGap(fields: string[], log?: (message: string) => void): void {
  const signature = fields.join(',');
  const message = 'clodex: warning: a reasoning item with identical encrypted_content failed the '
    + `continuation match on field(s): ${signature}. Prompt caching is degraded for this turn — `
    + 'this is a clodex normalization gap, please report it at '
    + 'https://github.com/bman654/clodex/issues';
  try { log?.(`reasoning normalization gap: ${signature}`); } catch { /* ignore */ }
  if (warnedReasoningGaps.has(signature)) return;
  if (warnedReasoningGaps.size >= MAX_REASONING_GAP_WARNINGS) return;
  warnedReasoningGaps.add(signature);
  try {
    process.stderr.write(`${message}\n`);
    if (warnedReasoningGaps.size === MAX_REASONING_GAP_WARNINGS) {
      process.stderr.write('clodex: warning: further reasoning-normalization warnings suppressed.\n');
    }
  } catch { /* a warning must never break a request */ }
}

/** Test seam: the warning cap is process-wide and would leak between cases. */
export function resetReasoningGapWarningsForTests(): void {
  warnedReasoningGaps.clear();
}

/**
 * Detects a `function_call` that diverged for a reason that can only be ours.
 *
 * `call_id` is the tool call's identity. Claude Code echoes back the call it was
 * handed, so when both sides are a `function_call` carrying the SAME `call_id`
 * and `name` yet comparing unequal, the two objects describe the same call and
 * the continuation should have been accepted — the remaining difference is a
 * normalization gap on our side. A genuine rewind or branch regenerates the call
 * and produces a NEW `call_id`, so those never reach here and the signal stays
 * clean.
 *
 * `equalAfterStrip` separates the two mechanisms. It re-compares the WHOLE
 * items with the shared filler-strip rule applied to `arguments` — not the
 * arguments alone, or a divergence in any other field would be reported as a
 * strip-rule gap the code never examined. When that makes them equal, the only
 * thing standing between the head and its own echo is filler the shared rule
 * removes, which is the shape #84 had. When they still differ, the difference
 * is one the strip rule cannot explain — arguments in a shape
 * `sanitizedCallArguments` deliberately passes through untouched (a scalar, an
 * array, or malformed JSON), a genuinely re-sent value, or a divergence
 * elsewhere in the item — which is worth counting but is not a regression.
 *
 * `requiredProps` must describe the turn that SNAPSHOTTED the head, because
 * that is the schema the head was stripped under. Reading the current turn's
 * tools instead lets an unrelated schema change flip the verdict in either
 * direction. It is a thunk so the tools array is only walked once the cheap
 * identity guards above have passed.
 */
function toolArgumentNormalizationGap(
  expected: unknown,
  actual: unknown,
  requiredProps: () => Map<string, Set<string>>,
): Record<string, unknown> | undefined {
  if (conversationItemKind(expected) !== 'function_call') return undefined;
  if (conversationItemKind(actual) !== 'function_call') return undefined;
  const left = expected as JsonObject;
  const right = actual as JsonObject;
  const callId = left.call_id;
  if (typeof callId !== 'string' || !callId || callId !== right.call_id) return undefined;
  if (typeof left.name !== 'string' || left.name !== right.name) return undefined;
  // Same call, same tool, different bytes. Compare NORMALIZED arguments so the
  // canonical-JSON reconciliation this file already applies is not re-reported.
  if (canonicalJson(normalizeToolCallJson(left)) === canonicalJson(normalizeToolCallJson(right))) {
    return undefined;
  }
  const required = requiredProps().get(left.name);
  const stripped = (item: JsonObject): string | undefined => {
    if (typeof item.arguments !== 'string') return undefined;
    const raw = item.arguments.trim();
    try {
      const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      // Carry the rest of the item along, so a difference somewhere other than
      // `arguments` cannot be reported as the filler-strip rule having forked.
      return canonicalJson({
        ...(normalizeToolCallJson(item) as JsonObject),
        arguments: canonicalJson(sanitizeToolInput(parsed as Record<string, unknown>, required)),
      });
    } catch { return undefined; }
  };
  const leftStripped = stripped(left);
  const rightStripped = stripped(right);
  return {
    tool: left.name,
    equalAfterStrip: leftStripped !== undefined && leftStripped === rightStripped,
  };
}

const warnedToolArgumentGaps = new Set<string>();
const MAX_TOOL_ARGUMENT_GAP_WARNINGS = 3;

/**
 * Surfaces a forked filler-strip rule on stderr, for the same reason the
 * reasoning one does: without it this failure is invisible without `--trace` or
 * `--ws-diagnostics`, and it presents only as a quietly larger prompt. #84 cost
 * real tokens for weeks and was found by mining 11k ledger records, not by anyone
 * noticing. Same dedup + hard cap, because this shares a terminal with Claude
 * Code's interactive UI and must never become a stream.
 */
function warnToolArgumentNormalizationGap(
  gap: Record<string, unknown>,
  log?: (message: string) => void,
): void {
  const tool = typeof gap.tool === 'string' ? gap.tool : 'unknown';
  const signature = `${tool}:filler`;
  // States what was observed, not why. `equalAfterStrip` proves the two sides
  // agree once today's shared rule runs; it does not prove which side stopped
  // applying it, and a first false positive is what teaches a user to ignore
  // the one warning whose value depends on being believed.
  // `--trace` is the diagnostic a `clodex claude` user can actually produce; the
  // richer per-head JSONL is `clodex server --ws-diagnostics`, which is a server
  // flag only, so naming it here would send most users after a flag their command
  // does not accept and silently forwards to the claude binary.
  const message = `clodex: warning: tool call "${tool}" failed the continuation match, but both `
    + "sides are identical once clodex's filler-strip rule is applied, so the head should have "
    + 'matched. Prompt caching is degraded for this turn — please report it, with the adapter debug '
    + 'log from --trace if you can, at https://github.com/bman654/clodex/issues';
  try { log?.(`tool argument normalization gap: ${signature}`); } catch { /* ignore */ }
  if (warnedToolArgumentGaps.has(signature)) return;
  if (warnedToolArgumentGaps.size >= MAX_TOOL_ARGUMENT_GAP_WARNINGS) return;
  warnedToolArgumentGaps.add(signature);
  try {
    process.stderr.write(`${message}\n`);
    if (warnedToolArgumentGaps.size === MAX_TOOL_ARGUMENT_GAP_WARNINGS) {
      process.stderr.write('clodex: warning: further tool-argument normalization warnings suppressed.\n');
    }
  } catch { /* a warning must never break a request */ }
}

/** Test seam: the warning cap is process-wide and would leak between cases. */
export function resetToolArgumentGapWarningsForTests(): void {
  warnedToolArgumentGaps.clear();
}

function continuationMismatchDetails(
  entry: ConnectionEntry,
  payload: JsonObject,
  log?: (message: string) => void,
  // Only the head clodex actually gave up on should reach stderr. Every candidate
  // head is described in the diagnostic, and a gap on a head that lost to a better
  // match costs nothing, so warning on those would overstate the damage.
  warnOnGap = false,
): Record<string, unknown> {
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
  const expected = mismatch < prefix.length ? prefix[mismatch] : undefined;
  const actual = mismatch < full.length ? full[mismatch] : undefined;
  const reasoningGap = reasoningNormalizationGap(expected, actual);
  if (reasoningGap && warnOnGap) warnReasoningNormalizationGap(reasoningGap, log);
  // Claude may legitimately omit stored reasoning items (continuationMatch's
  // omitted_reasoning mode), which shifts the exact-prefix divergence onto a
  // reasoning-vs-call pair and would hide a forked strip rule sitting on the
  // very next call. Align the canary to the first non-reasoning stored item
  // in that case; everything else still uses the exact divergence pair.
  let gapExpected = expected;
  if (conversationItemKind(expected) === 'reasoning' && conversationItemKind(actual) === 'function_call') {
    for (let index = mismatch; index < prefix.length; index += 1) {
      if (conversationItemKind(prefix[index]) !== 'reasoning') {
        gapExpected = prefix[index];
        break;
      }
    }
  }
  let toolArgumentGap: Record<string, unknown> | undefined;
  // Detection is pure bookkeeping on top of a request that already succeeded, so
  // it must not be able to reject one. No throw is reachable today; this is here
  // so the next person editing the predicate cannot make one fatal.
  try {
    toolArgumentGap = toolArgumentNormalizationGap(
      gapExpected,
      actual,
      // The head's own schema when it has one; the current turn's tools are only a
      // fallback for a head that predates the snapshot (see headRequiredToolProps).
      () => entry.headRequiredToolProps ?? requiredToolProps(payload),
    );
  } catch { /* a diagnostic must never break a request */ }
  // Only the provably-ours case reaches stderr. `equalAfterStrip === false` means
  // the arguments differ for a reason the strip rule cannot explain, and a client
  // that genuinely re-sent a different value under the same call_id is
  // indistinguishable from a defect — warning there would cry wolf in a terminal
  // shared with Claude Code's UI. Those are still recorded on the diagnostic, and
  // traced here so --trace alone shows a counted-but-not-warned gap.
  if (toolArgumentGap?.equalAfterStrip === true) {
    if (warnOnGap) warnToolArgumentNormalizationGap(toolArgumentGap, log);
  } else if (toolArgumentGap && warnOnGap) {
    // Same gating as the warner: only the head clodex gave up on is described,
    // so the per-candidate loop cannot turn one mismatch into a trace stream.
    try { log?.(`tool argument mismatch beyond the strip rule: ${String(toolArgumentGap.tool)}`); } catch { /* ignore */ }
  }
  return {
    fullItems: full.length,
    expectedPrefixItems: prefix.length,
    firstMismatch: mismatch,
    expectedKind: expected === undefined ? 'none' : conversationItemKind(expected),
    actualKind: actual === undefined ? 'none' : conversationItemKind(actual),
    ...(expected !== undefined ? { expectedHash: conversationItemHash(expected) } : {}),
    ...(actual !== undefined ? { actualHash: conversationItemHash(actual) } : {}),
    ...(reasoningGap
      ? {
          reasoningNormalizationGap: reasoningGap,
          reasoningGapShape: reasoningGapShape(
            expected, actual, full, entry.expectedAssistant ?? [], mismatch,
          ),
        }
      : {}),
    ...(toolArgumentGap ? { toolArgumentNormalizationGap: toolArgumentGap } : {}),
  };
}

function continuationMismatchSummary(
  entry: ConnectionEntry,
  payload: JsonObject,
  log?: (message: string) => void,
  mismatchDump = false,
  precomputedDetails?: Record<string, unknown>,
): string {
  const details = precomputedDetails ?? continuationMismatchDetails(entry, payload, log, true);
  let summary = `full_items=${details.fullItems} expected_prefix_items=${details.expectedPrefixItems} `
    + `first_mismatch=${details.firstMismatch} expected=${details.expectedKind} actual=${details.actualKind}`;
  // The hashes make same-kind mismatches diagnosable from the log alone. With
  // CLODEX_MISMATCH_DUMP=1 the canonical bytes of both divergent items land in
  // the adapter debug log too. That file is written through the redacting
  // trace logger at mode 0600 and is never re-printed to the terminal
  // (`printTraceLog` reads the separate Claude Code debug log); the CLAUDE.md
  // entry for the variable carries the privacy tradeoff.
  if (details.expectedHash || details.actualHash) {
    summary += ` expected_hash=${details.expectedHash ?? 'none'} actual_hash=${details.actualHash ?? 'none'}`;
    if (mismatchDump && log) {
      const full = inputArray(payload);
      const prefix = [...(entry.requestInput ?? []), ...(entry.expectedAssistant ?? [])];
      const index = details.firstMismatch as number;
      log(`mismatch dump expected[${index}]: ${mismatchDumpLine(prefix, index)}`);
      log(`mismatch dump actual[${index}]: ${mismatchDumpLine(full, index)}`);
    }
  }
  return summary;
}

/** One side of a mismatch dump: canonical item bytes, capped, or `(absent)`
 * when the divergence is one history simply ending before the other. */
function mismatchDumpLine(items: unknown[], index: number): string {
  if (index >= items.length) return '(absent)';
  const line = canonicalJson(normalizeToolCallJson(items[index]));
  const max = 2_000;
  const marker = ' [truncated]';
  return line.length <= max ? line : line.slice(0, max - marker.length) + marker;
}

/**
 * Canonical string per conversation item.
 *
 * `canonicalize` maps element-wise and a JSON array serializes as its elements
 * joined, so two equal-length arrays are equal exactly when every element's
 * canonical string is equal. Comparing item-wise is therefore identical in
 * meaning to comparing whole arrays, but it lets both sides be computed once
 * instead of re-serializing an entire conversation for every candidate head.
 */
function canonicalItemStrings(items: unknown[]): string[] {
  return items.map(item => canonicalJson(normalizeToolCallJson([item])));
}

/** True when `head` is a strict prefix of `client`. Exits at the first difference. */
function isStrictPrefix(head: string[], client: string[]): boolean {
  if (client.length <= head.length) return false;
  for (let index = 0; index < head.length; index += 1) {
    if (head[index] !== client[index]) return false;
  }
  return true;
}

function continuationMatch(
  entry: ConnectionEntry,
  payload: JsonObject,
  clientItems: string[],
): ContinuationMatch | undefined {
  if (!entry.responseId || !entry.requestInput || !entry.expectedAssistant) return undefined;
  const full = inputArray(payload);
  // The stored prefix only changes when a response completes, so canonicalize it
  // once per head rather than once per lookup.
  entry.canonicalPrefix ??= canonicalItemStrings([...entry.requestInput, ...entry.expectedAssistant]);
  if (isStrictPrefix(entry.canonicalPrefix, clientItems)) {
    return { delta: full.slice(entry.canonicalPrefix.length), mode: 'exact' };
  }

  // Claude does not always echo an OpenAI reasoning item back into its
  // Anthropic-format history, even though it faithfully echoes the function
  // call or assistant text that followed it. The omitted reasoning already
  // belongs to previous_response_id, so it is safe to continue only when the
  // remaining response items still match exactly.
  const echoedAssistant = entry.expectedAssistant.filter(item => conversationItemKind(item) !== 'reasoning');
  if (echoedAssistant.length === entry.expectedAssistant.length) return undefined;
  entry.canonicalEchoablePrefix ??= canonicalItemStrings([...entry.requestInput, ...echoedAssistant]);
  if (!isStrictPrefix(entry.canonicalEchoablePrefix, clientItems)) return undefined;
  return { delta: full.slice(entry.canonicalEchoablePrefix.length), mode: 'omitted_reasoning' };
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

/**
 * Error CLASS of a frame, e.g. `usage_limit_reached`. Deliberately does not
 * fall back to the frame's own `type`: on an error chunk that is the chunk
 * discriminator (`'error'`), which names nothing.
 */
function responseErrorType(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  const error = record.error && typeof record.error === 'object' ? record.error as JsonObject : undefined;
  if (typeof error?.type === 'string') return error.type;
  const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
  const responseError = response?.error && typeof response.error === 'object' ? response.error as JsonObject : undefined;
  return typeof responseError?.type === 'string' ? responseError.type : undefined;
}

function responseRetryAfterSeconds(event: unknown): number | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
  const candidates = [record, record.error, response?.error];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const error = candidate as JsonObject;
    const value = error.retry_after_seconds ?? error.retry_after;
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  }
  return undefined;
}

/**
 * HTTP status carried by an in-band error frame. The Codex backend reports it
 * as a top-level `status` (e.g. 400 alongside an `unsupported_parameter`
 * error); `response.status` is the response lifecycle state, not a status code,
 * so it is deliberately not consulted here.
 */
function responseErrorStatus(event: unknown): number | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  for (const candidate of [record.status, (record.error as JsonObject | undefined)?.status]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)
      && candidate >= 400 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

function responseErrorMessage(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  const response = record.response && typeof record.response === 'object'
    ? record.response as JsonObject
    : undefined;
  for (const candidate of [record.error, response?.error, record]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const message = (candidate as JsonObject).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function boundedDiagnosticIdentifier(value: unknown): string | undefined {
  const identifier = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof identifier !== 'string') return undefined;
  const normalized = identifier.trim();
  return normalized && /^[a-zA-Z0-9_.:/-]+$/.test(normalized)
    ? normalized.slice(0, 128)
    : undefined;
}

function diagnosticTextFingerprint(
  field: 'errorMessage' | 'closeReason' | 'upstreamMessage',
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  return {
    [`${field}Bytes`]: Buffer.byteLength(value),
    [`${field}Hash`]: createHash('sha256').update(value).digest('hex').slice(0, 16),
  };
}

function responseFailureDetails(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== 'object') return {};
  const record = event as JsonObject;
  const response = record.response && typeof record.response === 'object'
    ? record.response as JsonObject
    : undefined;
  const error = record.error && typeof record.error === 'object'
    ? record.error as JsonObject
    : response?.error && typeof response.error === 'object'
      ? response.error as JsonObject
      : undefined;
  const incomplete = response?.incomplete_details && typeof response.incomplete_details === 'object'
    ? response.incomplete_details as JsonObject
    : undefined;
  const message = typeof error?.message === 'string'
    ? error.message
    : typeof record.message === 'string' ? record.message : undefined;
  return {
    errorType: boundedDiagnosticIdentifier(error?.type ?? record.type),
    errorCode: boundedDiagnosticIdentifier(error?.code ?? record.code),
    responseStatus: boundedDiagnosticIdentifier(response?.status),
    incompleteReason: boundedDiagnosticIdentifier(incomplete?.reason),
    ...diagnosticTextFingerprint('errorMessage', message),
  };
}

function emitContextDiagnostic(
  entry: ConnectionEntry,
  ctx: RequestContext,
  details: { event: string } & Record<string, unknown>,
): void {
  ctx.emitDiagnostic?.({
    connectionId: entry.debugId,
    generation: entry.generation,
    continued: ctx.continued,
    retried: ctx.retried,
    frameCount: ctx.frameCount,
    emittedModelData: ctx.emittedModelData,
    emittedDownstreamData: ctx.emittedDownstreamData,
    responseIdReceived: Boolean(ctx.responseId),
    inFlightMs: entry.inFlightStartedAt === undefined
      ? undefined
      : Math.max(0, entry.options.now() - entry.inFlightStartedAt),
    ...details,
  });
}

function emitResponseErrorDiagnostic(
  entry: ConnectionEntry,
  ctx: RequestContext,
  details: Record<string, unknown>,
): void {
  emitContextDiagnostic(entry, ctx, { event: 'ws_response_error', ...details });
}

function diagnosticItemIdHash(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? createHash('sha256').update(value).digest('hex').slice(0, 16)
    : undefined;
}

function reasoningPartIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function emitProtocolAnomaly(
  entry: ConnectionEntry,
  ctx: RequestContext,
  anomaly: string,
  itemId: unknown,
  summaryIndex: number | undefined,
  upstreamEventType: string,
): void {
  const itemIdHash = diagnosticItemIdHash(itemId);
  const key = `${anomaly}:${itemIdHash ?? 'none'}:${summaryIndex ?? 'none'}`;
  if (ctx.emittedProtocolAnomalies.has(key)) return;
  ctx.emittedProtocolAnomalies.add(key);
  const parts = typeof itemId === 'string' ? ctx.reasoningPartsByItemId.get(itemId) : undefined;
  emitContextDiagnostic(entry, ctx, {
    event: 'ws_response_protocol_anomaly',
    source: 'response_event_sequence',
    anomaly,
    upstreamEventType,
    itemIdHash,
    summaryIndex,
    knownSummaryParts: parts
      ? [...parts.entries()].sort(([left], [right]) => left - right)
        .map(([index, state]) => ({ summaryIndex: index, state }))
      : [],
    recentUpstreamEventTypes: [...ctx.recentUpstreamEventTypes],
  });
}

function trackReasoningProtocol(
  entry: ConnectionEntry,
  ctx: RequestContext,
  event: unknown,
  type: string | undefined,
): void {
  if (!type || !event || typeof event !== 'object') return;
  ctx.recentUpstreamEventTypes.push(boundedDiagnosticIdentifier(type) ?? 'unknown');
  if (ctx.recentUpstreamEventTypes.length > 20) ctx.recentUpstreamEventTypes.shift();

  const record = event as JsonObject;
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = record.item && typeof record.item === 'object' ? record.item as JsonObject : undefined;
    if (item?.type !== 'reasoning') return;
    const itemId = item.id;
    if (typeof itemId !== 'string' || itemId.length === 0) return;
    const current = ctx.reasoningPartsByItemId.get(itemId);
    if (type === 'response.output_item.added') {
      if (current) {
        emitProtocolAnomaly(entry, ctx, 'duplicate_reasoning_item_added', itemId, 0, type);
      }
      ctx.reasoningPartsByItemId.set(itemId, new Map([[0, 'active']]));
    } else {
      if (!current) {
        emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_item_done', itemId, undefined, type);
      }
      ctx.reasoningPartsByItemId.delete(itemId);
    }
    return;
  }

  if (!type.startsWith('response.reasoning_summary_')) {
    if (type === 'response.completed' && ctx.reasoningPartsByItemId.size > 0) {
      for (const itemId of ctx.reasoningPartsByItemId.keys()) {
        emitProtocolAnomaly(entry, ctx, 'reasoning_item_done_missing_before_completion', itemId, undefined, type);
      }
    }
    return;
  }

  const itemId = record.item_id;
  const summaryIndex = reasoningPartIndex(record.summary_index);
  if (typeof itemId !== 'string' || summaryIndex === undefined) return;
  const parts = ctx.reasoningPartsByItemId.get(itemId);
  const state = parts?.get(summaryIndex);

  if (type === 'response.reasoning_summary_part.added') {
    if (!parts) {
      emitProtocolAnomaly(entry, ctx, 'reasoning_item_missing_before_summary_part', itemId, summaryIndex, type);
      return;
    }
    if (summaryIndex > 0) {
      for (const [index, partState] of parts) {
        if (partState === 'can_conclude') parts.set(index, 'concluded');
      }
      if (state === 'active' || state === 'can_conclude') {
        emitProtocolAnomaly(entry, ctx, 'duplicate_reasoning_summary_part_added', itemId, summaryIndex, type);
      }
      parts.set(summaryIndex, 'active');
    }
    return;
  }

  if (type === 'response.reasoning_summary_text.delta') {
    if (state === undefined || state === 'concluded') {
      emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_delta', itemId, summaryIndex, type);
    }
    return;
  }

  if (type === 'response.reasoning_summary_part.done') {
    if (state === undefined || state === 'concluded') {
      emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_part_done', itemId, summaryIndex, type);
      return;
    }
    parts!.set(summaryIndex, ctx.originalPayload.store === true ? 'concluded' : 'can_conclude');
  }
}

function responseIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const response = (event as JsonObject).response;
  if (!response || typeof response !== 'object') return undefined;
  return typeof (response as JsonObject).id === 'string' ? (response as JsonObject).id as string : undefined;
}

interface ResponseUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

function responseUsage(event: unknown): ResponseUsage | undefined {
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
  return {
    inputTokens: number(usageRecord.input_tokens),
    cachedTokens: number(details.cached_tokens),
    cacheWriteTokens: number(details.cache_write_tokens ?? usageRecord.cache_write_tokens),
    outputTokens: number(usageRecord.output_tokens),
  };
}

function responseUsageDebug(usage: ResponseUsage): string {
  return `usage input_tokens=${usage.inputTokens} `
    + `cached_tokens=${usage.cachedTokens} `
    + `cache_write_tokens=${usage.cacheWriteTokens} `
    + `output_tokens=${usage.outputTokens}`;
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

/**
 * Per-tool `required` property sets, read from the request's own `tools`
 * array. The Responses provider passes each function tool's JSON schema
 * through as `parameters` unmodified, so these are the same `required` sets
 * the Anthropic translation layer consults when it sanitizes tool input on
 * the way to the client (the shared `sanitizeToolInput` in tool-input-sanitize.ts).
 */
function requiredToolProps(payload: JsonObject): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (tool: unknown): void => {
    if (!tool || typeof tool !== 'object') return;
    const record = tool as JsonObject;
    if (record.type === 'namespace' && Array.isArray(record.tools)) {
      for (const nested of record.tools) add(nested);
      return;
    }
    if (record.type !== 'function' || typeof record.name !== 'string') return;
    const parameters = record.parameters;
    const required = parameters && typeof parameters === 'object'
      && Array.isArray((parameters as JsonObject).required)
      ? (parameters as JsonObject).required as unknown[] : [];
    map.set(record.name, new Set(required.filter((p): p is string => typeof p === 'string')));
  };
  if (Array.isArray(payload.tools)) for (const tool of payload.tools) add(tool);
  return map;
}

/**
 * The client never sees the raw upstream `arguments` string: the translation
 * layer strips `null`-valued keys and non-required empty arrays from tool
 * input before it reaches the client, and the client echoes that sanitized
 * object back. A head that snapshots the raw upstream string can therefore
 * never match its own echo, and the chain is lost on the next turn (#84).
 * Snapshot the arguments in the same downstream shape instead, using the
 * same shared strip rule the translation layer applies
 * (`sanitizeToolInput` in tool-input-sanitize.ts). Compare-only: the payload
 * actually sent upstream is untouched.
 */
function sanitizedCallArguments(item: JsonObject, requiredProps: Map<string, Set<string>>): JsonObject {
  if (typeof item.arguments !== 'string') return item;
  // The client-side SDK parses a blank arguments string as `{}` before the
  // client ever sees it, so a zero-argument tool call is echoed back as
  // `"{}"`. Mirror that here, or the raw-`""` snapshot loses the chain with
  // the same tail-index signature as #84.
  const raw = item.arguments.trim();
  let parsed: unknown;
  try { parsed = raw === '' ? {} : JSON.parse(raw); } catch { return item; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return item;
  const required = requiredProps.get(typeof item.name === 'string' ? item.name : '');
  return {
    ...item,
    arguments: JSON.stringify(sanitizeToolInput(parsed as Record<string, unknown>, required)),
  };
}

function expectedAssistantItems(ctx: RequestContext): unknown[] {
  const output: unknown[] = [];
  const requiredProps = requiredToolProps(ctx.originalPayload);
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
      if (type === 'function_call') {
        output.push({ ...sanitizedCallArguments(withoutEphemeralFields(done), requiredProps), type });
        continue;
      }
      if (type === 'custom_tool_call') {
        output.push({ ...withoutEphemeralFields(done), type });
      }
  }
  return output;
}

function encodeSse(ctx: RequestContext, event: unknown): void {
  if (ctx.closed) return;
  ctx.emittedDownstreamData = true;
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

function failContext(
  entry: ConnectionEntry,
  ctx: RequestContext,
  message: string,
  diagnosticDetails: Record<string, unknown>,
  statusCode?: number,
  retryAfterSeconds?: number,
): void {
  if (ctx.closed || entry.current !== ctx) return;
  entry.debug(`fail: ${message}`);
  emitResponseErrorDiagnostic(entry, ctx, {
    ...diagnosticDetails,
    ...diagnosticTextFingerprint('errorMessage', message),
  });
  flushPending(ctx);
  encodeSse(ctx, {
    type: 'error',
    sequence_number: ctx.frameCount,
    error: {
      type: statusCode === undefined ? 'transport_error' : anthropicErrorType(statusCode),
      code: statusCode === undefined ? 'websocket_transport_error' : String(statusCode),
      message,
      param: null,
      ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
    },
  });
  deleteEntry(entry);
  closeContext(ctx);
}

function retryTransportFailure(
  entry: ConnectionEntry,
  ctx: RequestContext,
  diagnosticDetails: Record<string, unknown>,
): boolean {
  if (
    ctx.closed
    || entry.current !== ctx
    || ctx.retried
    || !transportReplaySafe(ctx)
  ) {
    return false;
  }

  ctx.retried = true;
  ctx.transportRetryPending = true;
  entry.debug('transport failed before downstream output; retrying once with full context');
  emitContextDiagnostic(entry, ctx, {
    event: 'ws_transport_retry',
    outcome: 'started',
    ...diagnosticDetails,
  });
  deleteEntry(entry);
  if (ctx.closed) {
    ctx.transportRetryPending = false;
    entry.debug('transport retry cancelled before replacement');
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_transport_retry',
      outcome: 'cancelled',
    });
    return true;
  }
  resetContextForRetry(ctx);
  const replacement = ctx.createReplacement();
  if (ctx.closed) {
    ctx.transportRetryPending = false;
    deleteEntry(replacement);
    replacement.debug('transport retry cancelled while creating replacement');
    emitContextDiagnostic(replacement, ctx, {
      event: 'ws_transport_retry',
      outcome: 'cancelled',
    });
    return true;
  }
  dispatchContext(replacement, ctx);
  return true;
}

function handleTransportFailure(
  entry: ConnectionEntry,
  ctx: RequestContext,
  message: string,
  diagnosticDetails: Record<string, unknown>,
): void {
  if (retryTransportFailure(entry, ctx, diagnosticDetails)) return;
  if (ctx.closed || entry.current !== ctx) return;
  if (ctx.retried && ctx.transportRetryPending && transportReplaySafe(ctx)) {
    ctx.transportRetryPending = false;
    entry.debug('transport retry exhausted before downstream output');
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_transport_retry',
      outcome: 'exhausted',
      ...diagnosticDetails,
    });
  }
  failContext(entry, ctx, message, diagnosticDetails);
}

function cleanupExpiredConnections(now: number): Array<Record<string, unknown>> {
  const evictions: Array<Record<string, unknown>> = [];
  for (const entry of connectionEntries()) {
    if (entry.inFlight) continue;
    const idleTtlMs = entry.generation === 'nursery'
      ? entry.options.nurseryIdleTtlMs
      : entry.options.idleTtlMs;
    const ttlAgeMs = Math.max(0, now - entry.createdAt - entry.ttlPausedMs);
    if (ttlAgeMs >= entry.options.hardTtlMs || now - entry.lastUsedAt >= idleTtlMs) {
      entry.debug('evicting expired idle connection');
      evictions.push({
        connectionId: entry.debugId,
        partitionKey: entry.key,
        generation: entry.generation,
        reason: ttlAgeMs >= entry.options.hardTtlMs
          ? 'hard_ttl'
          : entry.generation === 'nursery' ? 'nursery_idle_ttl' : 'idle_ttl',
      });
      deleteEntry(entry);
    }
  }
  return evictions;
}

function evictOldestIdleGeneration(
  generation: 'nursery' | 'established',
  maxConnections: number,
  reason: 'nursery_lru_cap' | 'established_lru_cap',
): Array<Record<string, unknown>> {
  const evictions: Array<Record<string, unknown>> = [];
  const idle = connectionEntries()
    .filter(entry => !entry.inFlight && entry.generation === generation)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  while (connectionCountByGeneration(generation) >= maxConnections && idle.length) {
    const oldest = idle.shift();
    if (oldest) {
      evictions.push({
        connectionId: oldest.debugId,
        partitionKey: oldest.key,
        generation: oldest.generation,
        reason,
      });
      deleteEntry(oldest);
    }
  }
  return evictions;
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
  options: { headers: Record<string, string>; agent?: import('node:http').Agent },
) => WsWebSocket;

function sendContext(entry: ConnectionEntry, ctx: RequestContext): void {
  const outgoing = outgoingPayload(ctx.sendPayload);
  entry.debug(
    `connection=${entry.debugId} key=${debugKey(entry.key)} sending ${outgoing.length}B payload`
    + (ctx.continued ? ' (continuation)' : ''),
  );
  try {
    entry.socket.send(outgoing, error => {
      if (!error) return;
      handleTransportFailure(entry, ctx, error.message, {
        source: 'socket_send',
        failureMode: 'callback',
        socketErrorName: boundedDiagnosticIdentifier(error.name),
        socketErrorCode: boundedDiagnosticIdentifier((error as NodeJS.ErrnoException).code),
        ...diagnosticTextFingerprint('errorMessage', error.message),
      });
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('WebSocket send failed');
    handleTransportFailure(entry, ctx, failure.message, {
      source: 'socket_send',
      failureMode: 'synchronous',
      socketErrorName: boundedDiagnosticIdentifier(failure.name),
      socketErrorCode: boundedDiagnosticIdentifier((failure as NodeJS.ErrnoException).code),
      ...diagnosticTextFingerprint('errorMessage', failure.message),
    });
  }
}

function dispatchContext(entry: ConnectionEntry, ctx: RequestContext): void {
  const now = entry.options.now();
  entry.inFlight = true;
  entry.inFlightStartedAt = now;
  entry.current = ctx;
  ctx.entry = entry;
  if (entry.open) sendContext(entry, ctx);
}

function finishInFlightPeriod(entry: ConnectionEntry, now: number): void {
  if (entry.inFlightStartedAt !== undefined) {
    entry.ttlPausedMs += Math.max(0, now - entry.inFlightStartedAt);
    entry.inFlightStartedAt = undefined;
  }
}

function resetContextForRetry(ctx: RequestContext): void {
  ctx.continued = false;
  ctx.sendPayload = ctx.originalPayload;
  ctx.pendingEvents = [];
  ctx.emittedModelData = false;
  ctx.responseId = undefined;
  ctx.outputByIndex.clear();
  ctx.outputIndexByItemId.clear();
  ctx.reasoningPartsByItemId.clear();
  ctx.recentUpstreamEventTypes = [];
  ctx.emittedProtocolAnomalies.clear();
}

function transportReplaySafe(ctx: RequestContext): boolean {
  return !ctx.emittedDownstreamData
    && !ctx.emittedModelData
    && ctx.outputByIndex.size === 0;
}

function handleSocketMessage(entry: ConnectionEntry, data: RawData): void {
  const ctx = entry.current;
  if (!ctx || ctx.closed) return;
  const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8');
  ctx.frameCount += 1;
  if (ctx.transportRetryPending) {
    ctx.transportRetryPending = false;
    entry.debug('transport retry received its first response frame');
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_transport_retry',
      outcome: 'recovered',
    });
  }
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    ctx.pendingEvents.push(text.replace(/\r?\n/g, ' '));
    flushPending(ctx);
    return;
  }

  const type = eventType(event);
  trackReasoningProtocol(entry, ctx, event, type);
  captureOutput(ctx, event);
  if (type === 'response.completed') {
    const usage = responseUsage(event);
    if (usage) {
      entry.debug(responseUsageDebug(usage));
      ctx.emitDiagnostic?.({
        event: 'ws_response_usage',
        connectionId: entry.debugId,
        generation: entry.generation,
        continued: ctx.continued,
        retried: ctx.retried,
        ...usage,
      });
    }
  }
  if (isModelDataEvent(type)) ctx.emittedModelData = true;

  const errorCode = responseErrorCode(event);
  const previousMissing = errorCode === 'previous_response_not_found';
  const willRetry = previousMissing && ctx.continued && !ctx.retried && !ctx.emittedModelData;
  if (errorCode === 'websocket_connection_limit_reached' && !ctx.emittedModelData) {
    const retryAfterSeconds = clampRetryAfterSeconds(responseRetryAfterSeconds(event));
    failContext(
      entry,
      ctx,
      `OpenAI reported the Responses WebSocket connection limit was reached; retry after ${retryAfterSeconds}s`,
      {
        source: 'error_frame',
        errorCode,
        mappedStatusCode: 429,
        retryAfterSeconds,
      },
      429,
      retryAfterSeconds,
    );
    return;
  }
  // A bare `error` frame carrying an HTTP status is a rejected request, not a
  // response: forwarding it verbatim ends the stream with no content, so the
  // client sees an empty 200 and reports a generic failure instead of the
  // upstream reason. Map it to a real error frame while nothing has been
  // emitted yet — once model data is downstream the stream is already
  // committed, and the existing partial-output path must keep handling it.
  //
  // Resolved here, above the generic failure record, only so that record can be
  // suppressed when the rejection branch below emits its own. The branch itself
  // must stay after the `willRetry` return — ahead of it, it would swallow a
  // `previous_response_not_found` frame (which carries a 400) and kill the retry.
  const errorStatus = type === 'error' && !ctx.emittedModelData
    ? responseErrorStatus(event)
    : undefined;
  // A failure terminal with no HTTP status to map (`response.failed`,
  // `response.incomplete`, or a bare `error` frame that named no status) is the
  // same defect one layer over: forwarded verbatim it ends the stream having
  // emitted nothing, so downstream reads a SUCCESSFUL, EMPTY 200 and renders a
  // turn in which the model said nothing. That is indistinguishable from a
  // deliberately silent turn, so the actual reason — a usage limit, a rejected
  // reconstruction, an aborted response — never reaches the operator and the
  // session simply appears to stop answering, one prompt after another.
  //
  // Gated on `!emittedModelData` for the same reason as the branch above: once
  // model data is downstream the stream is committed and the existing
  // partial-output path must keep handling it.
  const emptyFailureTerminal = FAILURE_EVENT_TYPES.has(type ?? '')
    && errorStatus === undefined
    && !willRetry
    && !ctx.emittedModelData;
  // One rejection, one diagnostic record. Without this gate a rejected request
  // emits both this record and `failContext`'s, under different `source` values
  // with disjoint fields, reading as two failures of one request.
  if (
    FAILURE_EVENT_TYPES.has(type ?? '')
    && (errorStatus === undefined || willRetry)
    && !emptyFailureTerminal
  ) {
    emitResponseErrorDiagnostic(entry, ctx, {
      source: 'response_event',
      upstreamEventType: type,
      willRetry,
      ...responseFailureDetails(event),
    });
  }
  if (willRetry) {
    ctx.retried = true;
    entry.debug('previous response unavailable; retrying once with full context');
    deleteEntry(entry);
    resetContextForRetry(ctx);
    const replacement = ctx.createReplacement();
    dispatchContext(replacement, ctx);
    return;
  }

  if (errorStatus !== undefined) {
    const usageLimited = [responseErrorType(event), errorCode].some(value => (
      typeof value === 'string' && value.toLowerCase().includes('usage_limit')
    ));
    // A generic 5xx field is only a fallback when a structured plan-limit class
    // is present. Otherwise it masks the more specific 429 signal carried by the
    // same frame. Explicit deterministic 4xx statuses remain authoritative.
    const statusCode = usageLimited && errorStatus >= 500 ? 429 : errorStatus;
    // The AI SDK strips unknown frame fields, so a backoff hint survives only
    // baked into the message text — same reason the connection-limit branch
    // above spells it out. Only forward a value upstream actually gave. An
    // oversized ordinary rate-limit hint is capped, but omitting an oversized
    // plan-limit hint is more honest than claiming the 60s cap is its reset time.
    const statedRetryAfter = statusCode === 429 ? responseRetryAfterSeconds(event) : undefined;
    const retryAfterSeconds = statedRetryAfter !== undefined
      && (!usageLimited || statedRetryAfter <= MAX_RETRY_AFTER_SECONDS)
      ? clampRetryAfterSeconds(statedRetryAfter)
      : undefined;
    const reason = responseErrorMessage(event) ?? `OpenAI rejected the request (HTTP ${statusCode})`;
    failContext(
      entry,
      ctx,
      retryAfterSeconds === undefined ? reason : `${reason}; retry after ${retryAfterSeconds}s`,
      {
        source: 'error_frame',
        // Names the failure. Without it this record — now the ONLY one for a
        // rejection — can carry no indication of what failed, since a bare
        // error frame often has no `code` at all.
        errorType: boundedDiagnosticIdentifier(responseErrorType(event)),
        // Upstream-controlled, so bounded like every other identifier in this
        // file's diagnostics. The connection-limit branch can pass its code raw
        // only because it has just been compared `===` to a known constant.
        errorCode: boundedDiagnosticIdentifier(errorCode),
        mappedStatusCode: statusCode,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
      statusCode,
      retryAfterSeconds,
    );
    return;
  }

  if (emptyFailureTerminal) {
    const details = responseFailureDetails(event);
    // The bounded identifiers are the whole diagnostic value here: they are what
    // names `usage_limit_reached` (or whatever else) in the debug log the next
    // time a session goes silent, without dumping upstream text.
    const named = [details.errorType, details.errorCode, details.incompleteReason]
      .filter((value): value is string => typeof value === 'string');
    const summary = 'OpenAI ended the response with no output'
      + (named.length ? ` (${named.join(' / ')})` : ` (${type})`);
    // Classified by the SAME discriminator rules a status-carrying frame goes
    // through, rather than a local whitelist that would drift from them.
    //
    // That matters beyond tidiness: `context_length_exceeded` has to land on
    // 400. `isContextLengthExceededError` trusts a frame's structured
    // discriminator over its prose, and the proxy handlers require a 400 before
    // emitting Claude Code's prompt-too-long response — so as a 502 a
    // long-context request is retried as a server fault AND loses the
    // auto-compaction signal that would have made room for it.
    //
    // 502 stands in only where the shared classifier has no opinion (its 500
    // default): an indeterminate failure genuinely is worth retrying, and 502
    // is the honest "upstream gave us nothing usable" for an output-less
    // terminal. Every class it does recognise — deterministic 400s, usage
    // limits, auth, overload — keeps the status the rest of the stack expects.
    const discriminator = [details.errorType, details.errorCode]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    // `incomplete_details.reason` is a DIFFERENT vocabulary from a frame's
    // code/type, so it is classified here rather than fed to frameStatusCode,
    // which documents itself as reading the latter. These are the reasons that
    // describe a settled outcome rather than a fault: retrying re-runs a
    // request upstream has already answered.
    const settledReason = details.incompleteReason === 'content_filter'
      || details.incompleteReason === 'max_output_tokens';
    // errorCode passed as the CODE argument, not folded into the discriminator:
    // frameStatusCode recognises a numeric HTTP code only through that first
    // parameter, and clodex's own synthetic frames set `code` to the
    // stringified status. Fold it in as prose instead and a terminal carrying
    // `code: '401'` matches no rule, lands on the 500 default, and gets
    // rewritten as a retryable 502.
    const numericOrNamed = typeof details.errorCode === 'string' ? details.errorCode : undefined;
    const classified = frameStatusCode(numericOrNamed, discriminator);
    const statusCode = classified !== 500
      ? classified
      : settledReason ? 400 : 502;
    const usageLimited = statusCode === 429;
    const planLimited = discriminator.includes('usage_limit');
    // Only when upstream stated one, and only baked into the TEXT: the AI SDK's
    // chunk schema is a closed zod object that strips `retry_after_seconds`, so
    // a hint carried only in the frame field never reaches the client. This is
    // the same reason the status-carrying branch above spells it out.
    const statedRetryAfter = usageLimited ? responseRetryAfterSeconds(event) : undefined;
    const retryAfterSeconds = statedRetryAfter !== undefined
      && (!planLimited || statedRetryAfter <= MAX_RETRY_AFTER_SECONDS)
      ? clampRetryAfterSeconds(statedRetryAfter)
      : undefined;
    // The BOUNDED summary is the message, upstream's prose is not used at all.
    // A `response.failed` body can echo request content or backend detail, and
    // it does not stay in one place: the synthetic error is rethrown by the SDK
    // and `proxy.ts` writes both the formatted message and `errorContent` to the
    // persistent proxy log, which `redactTraceLine` only scrubs of known
    // credential shapes. Protecting the immediate `fail:` line while the same
    // text reaches disk one frame later is not protection. The summary names
    // the cause — the identifiers are what diagnose a silent session — and the
    // raw message survives as a length+hash in the diagnostic.
    failContext(
      entry,
      ctx,
      retryAfterSeconds === undefined ? summary : `${summary}; retry after ${retryAfterSeconds}s`,
      {
        source: 'empty_failure_terminal',
        upstreamEventType: type,
        ...details,
        // Under DISTINCT keys. `failContext` fingerprints the message it was
        // given after spreading these, so an `errorMessage*` pair here is
        // overwritten by the summary's — which would silently discard the only
        // content-free evidence of what upstream actually said, and leave two
        // failures with the same type and code indistinguishable. `errorMessage*`
        // now means "what the client was told", `upstreamMessage*` means "what
        // upstream said", and both survive.
        ...diagnosticTextFingerprint('upstreamMessage', responseErrorMessage(event)),
      },
      statusCode,
      retryAfterSeconds,
    );
    return;
  }

  ctx.pendingEvents.push(event);
  if (isModelDataEvent(type)) flushPending(ctx);

  if (TERMINAL_EVENT_TYPES.has(type ?? '') || type === 'error') {
    flushPending(ctx);
    const failed = FAILURE_EVENT_TYPES.has(type ?? '');
    if (!failed && ctx.responseId && entry.persistent) {
      const now = entry.options.now();
      finishInFlightPeriod(entry, now);
      entry.responseId = ctx.responseId;
      entry.requestInput = inputArray(ctx.originalPayload);
      entry.expectedAssistant = expectedAssistantItems(ctx);
      entry.headRequiredToolProps = requiredToolProps(ctx.originalPayload);
      // The stored prefix just changed, so the memoized canonical form is stale.
      entry.canonicalPrefix = undefined;
      entry.canonicalEchoablePrefix = undefined;
      entry.promptFieldHashes = ctx.promptFieldHashes;
      entry.instructionsSnapshot = ctx.instructionsSnapshot;
      entry.lastUsedAt = now;
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

function numericRetryAfterHeader(value: string | string[] | undefined): number | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && /^\d+$/.test(single.trim())
    ? Number(single.trim())
    : undefined;
}

function createConnection(
  WebSocket: WebSocketConstructor,
  wsUrl: string,
  headers: Record<string, string>,
  persistent: boolean,
  key: string | undefined,
  options: ConnectionEntry['options'],
  debug: ConnectionEntry['debug'],
  /** Optional HTTP(S)_PROXY CONNECT-tunnel agent (see src/outbound-proxy.ts). */
  agent?: import('node:http').Agent,
): ConnectionEntry {
  const now = options.now();
  const socket = new WebSocket(wsUrl, agent ? { headers, agent } : { headers });
  const entry: ConnectionEntry = {
    debugId: nextConnectionDebugId++,
    key: persistent ? key : undefined,
    socket,
    persistent,
    generation: persistent ? 'nursery' : 'isolated',
    open: false,
    createdAt: now,
    ttlPausedMs: 0,
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
    // Persistent cache sockets must not keep a finished clodex CLI process alive.
    (socket as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
    const ctx = entry.current;
    if (ctx && !ctx.closed) sendContext(entry, ctx);
  });
  socket.on('unexpected-response', (_request, response) => {
    const statusCode = response.statusCode ?? 502;
    debug(`unexpected-response status=${statusCode}`);
    // Fire-and-forget drain. Upgrade failures are classified by status alone —
    // the body is never read, so nothing here is deferred into a callback.
    response.resume();
    const ctx = entry.current;
    if (!ctx || ctx.closed) {
      deleteEntry(entry);
      return;
    }
    if (statusCode === 403) {
      // OpenAI's edge/WAF rejects the upgrade with HTTP 403 when the ChatGPT
      // account's concurrency/usage throttle trips, before the request ever
      // reaches the application. Terminal conditions are 401 (re-auth) or a
      // 429 with a JSON body; the only application 403 is a geo restriction,
      // and the official codex client retries ALL 403s. Map every upgrade 403
      // to a retryable Anthropic 429 synchronously; failContext closes the
      // context here, so the socket error/close transport-retry path sees a
      // finished request and cannot double-handle this failure.
      const retryAfterSeconds = clampRetryAfterSeconds(
        numericRetryAfterHeader(response.headers['retry-after']),
      );
      // "retry after Ns" is load-bearing: the AI SDK strips unknown frame
      // fields, so sdkUpstreamErrorDetails recovers the hint from this text.
      failContext(entry, ctx, 'OpenAI edge throttled the Responses WebSocket upgrade '
        + `(HTTP 403); retry after ${retryAfterSeconds}s`, {
        source: 'unexpected_response',
        httpStatusCode: statusCode,
        mappedStatusCode: 429,
        retryAfterSeconds,
      }, 429, retryAfterSeconds);
      return;
    }
    failContext(entry, ctx, `WebSocket upgrade failed (HTTP ${statusCode})`, {
      source: 'unexpected_response',
      httpStatusCode: statusCode,
    }, statusCode);
  });
  socket.on('message', (data: RawData) => handleSocketMessage(entry, data));
  socket.on('error', (error: Error) => {
    const ctx = entry.current;
    if (ctx) {
      const details = {
        source: 'socket_error',
        socketErrorName: boundedDiagnosticIdentifier(error.name),
        socketErrorCode: boundedDiagnosticIdentifier((error as NodeJS.ErrnoException).code),
        ...diagnosticTextFingerprint('errorMessage', error.message),
      };
      handleTransportFailure(entry, ctx, error.message, details);
    } else deleteEntry(entry);
  });
  socket.on('close', (code: number, reason: Buffer) => {
    entry.open = false;
    const ctx = entry.current;
    debug(`connection=${entry.debugId} closed code=${code} in_flight=${Boolean(ctx && !ctx.closed)}`);
    if (ctx && !ctx.closed) {
      const reasonText = reason?.length ? reason.toString('utf8') : '';
      const suffix = reasonText ? `: ${reasonText}` : '';
      handleTransportFailure(entry, ctx, `WebSocket closed (${code})${suffix}`, {
        source: 'socket_close',
        closeCode: code,
        ...diagnosticTextFingerprint('closeReason', reasonText),
      });
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
/**
 * Reads a connection-pool cap from the environment.
 *
 * Both pools are process-wide, so a workload that fans out into many concurrent
 * subagent conversations can evict heads before their next turn arrives. An
 * explicit option still wins, so tests are never perturbed by a stray variable.
 * A malformed value is reported and ignored rather than silently reinterpreted.
 */
function envConnectionCap(name: string, log?: (message: string) => void): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > 1024) {
    try { log?.(`ws: ignoring ${name}=${raw} (expected an integer between 1 and 1024)`); } catch { /* ignore */ }
    return undefined;
  }
  return value;
}

export function createResponsesWebSocketFetch(
  wsUrl: string,
  log?: (message: string) => void,
  options: ResponsesWebSocketFetchOptions = {},
): FetchFunction {
  const debug = (message: string) => { try { log?.(`ws: ${message}`); } catch { /* ignore */ } };
  // Resolved once per transport, like the connection caps: the dump is a
  // diagnostic opt-in, not something to re-read per request.
  const mismatchDump = process.env.CLODEX_MISMATCH_DUMP === '1';
  const resolvedOptions = {
    hardTtlMs: options.hardTtlMs ?? RESPONSES_WS_HARD_TTL_MS,
    idleTtlMs: options.idleTtlMs ?? RESPONSES_WS_IDLE_TTL_MS,
    nurseryIdleTtlMs: options.nurseryIdleTtlMs
      ?? Math.min(RESPONSES_WS_NURSERY_IDLE_TTL_MS, options.idleTtlMs ?? RESPONSES_WS_IDLE_TTL_MS),
    maxConnections: options.maxConnections
      ?? envConnectionCap('CLODEX_WS_MAX_CONNECTIONS', log)
      ?? RESPONSES_WS_MAX_CONNECTIONS,
    maxNurseryConnections: options.maxNurseryConnections
      ?? envConnectionCap('CLODEX_WS_MAX_NURSERY_CONNECTIONS', log)
      ?? RESPONSES_WS_MAX_NURSERY_CONNECTIONS,
    now: options.now ?? Date.now,
  };

  return async (_input, init): Promise<Response> => {
    const { WebSocket } = await import('ws');
    // ws does not honor HTTP(S)_PROXY env vars itself; tunnel through the
    // configured outbound proxy when one applies to this wss URL.
    const proxyAgent = await outboundWsProxyAgent(wsUrl);
    const headers = toHeaderRecord(init?.headers);
    headers['OpenAI-Beta'] = CODEX_RESPONSES_WEBSOCKETS_BETA;

    let payload: JsonObject;
    try {
      payload = JSON.parse(bodyToString(init?.body)) as JsonObject;
    } catch {
      payload = {};
    }
    if (hasResponsesLiteHeader(headers)) payload = applyResponsesLiteShape(payload);

    const authorizationFingerprint = authorizationHeaderFingerprint(headers);
    const partitionKey = responsesWebSocketPartitionKey(
      wsUrl,
      payload,
      options,
      authorizationFingerprint,
    );
    const promptFingerprint = responsesWebSocketPromptFingerprint(payload);
    const promptFieldHashes = responsesWebSocketPromptFieldHashes(payload);
    const instructionsSnapshot = instructionsFromPayload(payload);
    const diagnosticCorrelation = diagnosticContext.getStore();
    const now = resolvedOptions.now();
    const evictions = cleanupExpiredConnections(now);

    const candidates = partitionKey ? connectionEntries(partitionKey) : [];
    const idleCandidates = candidates.filter(entry => !entry.inFlight);
    // Canonicalize the incoming conversation ONCE, not once per candidate head.
    const clientItems = idleCandidates.length ? canonicalItemStrings(inputArray(payload)) : [];
    const matches = idleCandidates
      .map(entry => ({ entry, match: continuationMatch(entry, payload, clientItems) }))
      .filter((candidate): candidate is { entry: ConnectionEntry; match: ContinuationMatch } => candidate.match !== undefined)
      // Prefer the longest matching history, which produces the smallest delta.
      .sort((left, right) => left.match.delta.length - right.match.delta.length
        || (left.match.mode === right.match.mode ? 0 : left.match.mode === 'exact' ? -1 : 1));
    let selected: ConnectionEntry | undefined = matches[0]?.entry;
    const selectedMatch = matches[0]?.match;
    const selectedDelta = selectedMatch?.delta;
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
    let promotedConnectionId: number | undefined;
    let decision: 'continuation' | 'parallel_isolated' | 'history_mismatch_new_head' | 'new_partition_head' | 'unpartitioned_socket';
    let candidateMismatchDetails: Map<ConnectionEntry, Record<string, unknown>> | undefined;

    if (selected && selectedDelta) {
      sendPayload = { ...payload, input: selectedDelta, previous_response_id: selected.responseId };
      continued = true;
      if (selected.generation === 'nursery') {
        evictions.push(...evictOldestIdleGeneration(
          'established',
          resolvedOptions.maxConnections,
          'established_lru_cap',
        ));
        selected.generation = 'established';
        promotedConnectionId = selected.debugId;
      }
      decision = 'continuation';
      debug(
        `continuing chain with ${selectedDelta.length} incremental input item(s)`
        + (selectedMatch.mode === 'omitted_reasoning' ? ' after accepting omitted reasoning' : ''),
      );
    } else if (candidates.some(entry => entry.inFlight)) {
      // Claude auxiliary requests can share a session id. Never multiplex or
      // queue a request whose lineage cannot yet include the active response.
      selected = undefined;
      persistent = false;
      decision = 'parallel_isolated';
      debug('parallel request using an isolated socket');
    } else if (diagnosticEntry) {
      // A rewind, branch, or hidden auxiliary inference gets its own full-context
      // head. Existing heads remain eligible for later exact-prefix matches.
      const diagnosticMismatch = continuationMismatchDetails(diagnosticEntry, payload, debug, true);
      candidateMismatchDetails = new Map([[diagnosticEntry, diagnosticMismatch]]);
      // Every abandoned non-diagnostic head warns independently of diagnostics.
      // Cache each mismatch so the diagnostic payload does not evaluate it again.
      for (const candidate of candidates) {
        if (candidate === diagnosticEntry) continue;
        candidateMismatchDetails.set(
          candidate,
          continuationMismatchDetails(candidate, payload, debug, true),
        );
      }
      debug(
        `history mismatch starting an additional chain; retained ${candidates.length} existing head(s) `
        + `(${continuationMismatchSummary(
          diagnosticEntry,
          payload,
          debug,
          mismatchDump,
          diagnosticMismatch,
        )})`,
      );
      decision = 'history_mismatch_new_head';
    } else if (partitionKey) {
      decision = 'new_partition_head';
    } else {
      decision = 'unpartitioned_socket';
    }

    if (!selected && persistent) {
      evictions.push(...evictOldestIdleGeneration(
        'nursery',
        resolvedOptions.maxNurseryConnections,
        'nursery_lru_cap',
      ));
    }

    const requestInput = inputArray(payload);
    emitDiagnostic(options, {
      event: 'ws_head_decision',
      decision,
      partitionKey,
      keyTuple: {
        wsUrl,
        providerId: options.providerId ?? 'openai',
        accountIdHash: options.accountId
          ? createHash('sha256').update(options.accountId).digest('hex').slice(0, 16)
          : '',
        model: typeof payload.model === 'string' ? payload.model : undefined,
        effort: typeof (payload.reasoning as JsonObject | undefined)?.effort === 'string'
          ? String((payload.reasoning as JsonObject).effort).trim().toLowerCase()
          : '',
        promptCacheKey: typeof payload.prompt_cache_key === 'string' ? payload.prompt_cache_key : undefined,
      },
      promptFingerprint,
      promptFieldHashes,
      promptChanges,
      input: {
        count: requestInput.length,
        kinds: requestInput.map(conversationItemKind),
        hashes: requestInput.map(conversationItemHash),
      },
      candidateCount: candidates.length,
      idleCandidateCount: idleCandidates.length,
      matchingCandidateCount: matches.length,
      activeConnectionCount: connectionCount(),
      nurseryConnectionCount: connectionCountByGeneration('nursery'),
      establishedConnectionCount: connectionCountByGeneration('established'),
      maxConnections: resolvedOptions.maxConnections,
      maxNurseryConnections: resolvedOptions.maxNurseryConnections,
      selectedConnectionId: selected?.debugId,
      selectedGeneration: selected?.generation,
      continuationMatchMode: selectedMatch?.mode,
      promotedConnectionId,
      createdConnectionId: selected ? undefined : nextConnectionDebugId,
      createdGeneration: selected ? undefined : persistent ? 'nursery' : 'isolated',
      incrementalInputItems: selectedDelta?.length,
      heads: candidates.map(entry => ({
        connectionId: entry.debugId,
        generation: entry.generation,
        inFlight: entry.inFlight,
        ageMs: Math.max(0, now - entry.createdAt - entry.ttlPausedMs),
        physicalAgeMs: Math.max(0, now - entry.createdAt),
        ttlPausedMs: entry.ttlPausedMs,
        idleMs: Math.max(0, now - entry.lastUsedAt),
        promptChanges: changedPromptFields(entry.promptFieldHashes, promptFieldHashes),
        mismatch: candidateMismatchDetails?.get(entry)
          ?? continuationMismatchDetails(entry, payload, debug),
      })),
      evictions,
    }, diagnosticCorrelation);

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
          emittedDownstreamData: false,
          transportRetryPending: false,
          outputByIndex: new Map(),
          outputIndexByItemId: new Map(),
          reasoningPartsByItemId: new Map(),
          recentUpstreamEventTypes: [],
          emittedProtocolAnomalies: new Set(),
          emitDiagnostic: options.onDiagnostic
            ? event => emitDiagnostic(options, event, diagnosticCorrelation)
            : undefined,
          createReplacement: () => createConnection(
            WebSocket as unknown as WebSocketConstructor,
            wsUrl,
            headers,
            persistent,
            partitionKey,
            resolvedOptions,
            debug,
            proxyAgent,
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
          proxyAgent,
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
