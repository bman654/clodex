// Anthropic /v1/messages ↔ Vercel AI SDK. One turn per request; Claude Code owns the tool loop.
import { createHash } from 'node:crypto';
import { streamText, generateText, tool, jsonSchema } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import {
  sseChunk,
  encodeToolUseId,
  splitToolUseId,
  serializeToolResultContent,
  silenceSdkWarnings,
  type FullStreamPart,
  grabRoundTripSignature,
} from './proxy-shared.js';
import {
  deepMergeProviderOptions,
  effortProviderOptions,
  thinkingProviderOptions,
  type ReasoningMetadata,
} from './provider-factory.js';
import { resolveUpstreamTools } from './tool-search.js';
import type { AnthropicRequestMessage, AnthropicToolDefinition } from './proxy-types.js';
import { anthropicErrorType, upstreamHttpStatus } from './codex/upstream-error.js';
import { CLAUDE_CODE_BILLING_HEADER_PREFIX } from './oauth/claude-identity.js';

export { silenceSdkWarnings };

export type SdkTranslationErrorSignature =
  | 'reasoning_part_not_found'
  | 'text_part_not_found';

/** Classify privacy-safe AI SDK stream-state errors without logging dynamic part ids. */
export function sdkTranslationErrorSignature(error: unknown): SdkTranslationErrorSignature | undefined {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : undefined;
  if (!message) return undefined;
  if (/\breasoning part \S+ not found\b/i.test(message)) return 'reasoning_part_not_found';
  if (/\btext part \S+ not found\b/i.test(message)) return 'text_part_not_found';
  return undefined;
}

// ── Anthropic request shapes (only the fields we read) ───────────────────────
interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  source?: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string };
  cache_control?: { type?: string; ttl?: string };
  // internal: resolved tool name for a tool_result, set by annotateToolNames
  _name?: string;
}
interface AnthropicMsg { role: 'user' | 'assistant' | 'system'; content: string | AnthropicBlock[]; }
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type?: string; ttl?: string };
}
export interface AnthropicRequest {
  model: string;
  system?: string | Array<string | { text?: string; cache_control?: { type?: string; ttl?: string } }>;
  messages: AnthropicMsg[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  metadata?: { user_id?: unknown };
}

export interface TranslateRequestOptions {
  /** Fallback when the client omits effort (e.g. Claude Desktop gateway). */
  defaultEffort?: string;
  reasoningMetadata?: ReasoningMetadata;
  /** ChatGPT Codex OAuth requires instructions and manages its own output limit. */
  openAiOAuth?: boolean;
  /** Fallback session identity from X-Claude-Code-Session-Id. Body metadata wins. */
  claudeSessionId?: string;
  /** Hard cap on tools sent to the provider (e.g. Groq: 128). Excess tools are silently dropped. */
  maxTools?: number;
}

const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validClaudeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return CLAUDE_SESSION_ID_RE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** Extract Claude Code's stable session UUID without accepting arbitrary metadata. */
export function extractClaudeSessionId(
  body: Pick<AnthropicRequest, 'metadata'>,
  headerFallback?: string,
): string | undefined {
  const userId = body.metadata?.user_id;
  if (typeof userId === 'string') {
    try {
      const parsed = JSON.parse(userId) as { session_id?: unknown };
      const fromMetadata = validClaudeSessionId(parsed?.session_id);
      if (fromMetadata) return fromMetadata;
    } catch {
      // Malformed or non-JSON metadata is ignored; the header remains usable.
    }
  }
  return validClaudeSessionId(headerFallback);
}

/** Opaque prompt-cache partition derived from a Claude session UUID. */
export function claudeSessionPromptCacheKey(sessionId: string): string {
  return 'relay-session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

/** Read reasoning effort from an Anthropic-format request body. */
export function anthropicEffortFromRequest(body: AnthropicRequest): string | undefined {
  const effort = body.output_config?.effort;
  if (typeof effort === 'string' && effort.trim()) return effort.trim();
  return undefined;
}

/**
 * Stable OpenAI `prompt_cache_key` derived from the request's cacheable prefix
 * (top-level system prompt + tool definitions). OpenAI caches prompt prefixes
 * automatically; this key routes requests that share that prefix to the same
 * cache partition, raising hit rate — important in server mode where many
 * concurrent Claude Code sessions share one relay process.
 *
 * Keyed only on the STABLE prefix: within one Claude Code session every turn
 * sends byte-identical system+tools → same key → warm routing, while distinct
 * sessions (a different date/cwd baked into the system prompt) get distinct
 * keys, which is correct since they share no cacheable prefix. Deliberately
 * excludes folded inline system-reminders — those carry per-request-volatile
 * content (fresh timestamps, injected context) that would churn the key every
 * turn and defeat grouping.
 */
export function openAiPromptCacheKey(
  system: string | undefined,
  tools: AnthropicTool[] | undefined,
): string {
  const toolSig = (tools ?? [])
    .map(t => `${t.name}\x01${t.description ?? ''}\x01${JSON.stringify(t.input_schema ?? {})}`)
    .join('\x02');
  const material = `${system ?? ''}\0${toolSig}`;
  return 'relay-' + createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** Public OpenAI models that implement explicit prompt-cache breakpoints. */
export function supportsOpenAiPromptCacheBreakpoints(modelId: string): boolean {
  const match = modelId.toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

export interface SdkCallParams {
  instructions?: string;
  messages: ModelMessage[];
  allowSystemInMessages?: boolean;
  tools?: Record<string, ReturnType<typeof tool>>;
  toolChoice?: 'auto' | 'required' | { type: 'tool'; toolName: string };
  maxOutputTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

// ── system ───────────────────────────────────────────────────────────────────
function stripClaudeCodeBillingHeader(text: string): string | undefined {
  if (!text.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX)) return text;
  const newline = text.indexOf('\n');
  return newline === -1 ? undefined : text.slice(newline + 1);
}

function systemToString(
  system: AnthropicRequest['system'],
  stripAnthropicBillingHeader = false,
): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') {
    return stripAnthropicBillingHeader ? stripClaudeCodeBillingHeader(system) : system;
  }
  const blocks = system.map(b => (typeof b === 'string' ? b : b.text ?? ''));
  if (!stripAnthropicBillingHeader) return blocks.join('\n');
  return blocks.flatMap(text => {
    const stripped = stripClaudeCodeBillingHeader(text);
    return stripped === undefined ? [] : [stripped];
  }).join('\n');
}

function openAiCacheBreakpoint(block: AnthropicBlock, enabled: boolean): Record<string, unknown> | undefined {
  if (!enabled || !block.cache_control) return undefined;
  return { openai: { promptCacheBreakpoint: { mode: 'explicit' } } };
}

function translateTopLevelSystemForOpenAi(
  system: AnthropicRequest['system'],
): ModelMessage[] {
  if (!system) return [];
  if (typeof system === 'string') {
    return system.trim() ? [{ role: 'system', content: system } as ModelMessage] : [];
  }
  return system.flatMap(block => {
    const text = typeof block === 'string' ? block : block.text ?? '';
    if (!text.trim()) return [];
    const cacheControl = typeof block === 'string' ? undefined : block.cache_control;
    return [{
      role: 'system',
      content: text,
      ...(cacheControl
        ? { providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } }
        : {}),
    } as unknown as ModelMessage];
  });
}

// ── images ───────────────────────────────────────────────────────────────────
function imagePart(block: AnthropicBlock): {
  type: 'file';
  data: { type: 'data'; data: Uint8Array } | { type: 'url'; url: URL };
  mediaType: string;
} | null {
  const src = block.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    return {
      type: 'file',
      data: { type: 'data', data: Buffer.from(src.data, 'base64') },
      mediaType: src.media_type ?? 'image',
    };
  }
  if (src.type === 'url' && src.url) {
    return {
      type: 'file',
      data: { type: 'url', url: new URL(src.url) },
      mediaType: src.media_type ?? 'image',
    };
  }
  return null;
}

// ── tool_result name resolution (tool messages need the tool name) ────────────
export function annotateToolNames(messages: AnthropicMsg[]): void {
  const nameById = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.id && b.name) nameById.set(splitToolUseId(b.id).rawId, b.name);
    }
  }
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        b._name = nameById.get(splitToolUseId(b.tool_use_id).rawId);
      }
    }
  }
}

function thinkingToSdkPart(
  block: AnthropicBlock,
  npm: string,
): Record<string, unknown> | null {
  const text = block.thinking ?? '';
  if (npm === '@ai-sdk/openai' && !block.signature && !text.trim()) return null;

  const part: Record<string, unknown> = { type: 'reasoning', text };
  if (block.signature) {
    if (npm === '@ai-sdk/google') {
      part.providerOptions = { google: { thoughtSignature: block.signature } };
    } else if (npm === '@ai-sdk/openai' || npm === '@ai-sdk/openai-compatible') {
      part.providerOptions = { openai: { reasoningEncryptedContent: block.signature } };
    }
  }
  return part;
}

// ── messages: Anthropic → SDK ModelMessage[] ─────────────────────────────────
export function translateMessages(
  messages: AnthropicMsg[],
  npm: string,
  openAiPromptCacheBreakpoints = false,
): ModelMessage[] {
  const isGoogle = npm === '@ai-sdk/google';
  const out: ModelMessage[] = [];

  for (const msg of messages) {
    const blocks: AnthropicBlock[] = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : msg.content ?? [];

    if (msg.role === 'system') {
      // Claude Code deliberately injects trusted system messages within the
      // conversation. Preserve their position instead of moving volatile
      // reminders ahead of the stable history and invalidating the whole cache.
      for (const block of blocks) {
        if (block.type !== 'text' || !block.text?.trim()) continue;
        out.push({
          role: 'system',
          content: block.text,
          ...(openAiCacheBreakpoint(block, openAiPromptCacheBreakpoints)
            ? { providerOptions: openAiCacheBreakpoint(block, openAiPromptCacheBreakpoints) }
            : {}),
        } as unknown as ModelMessage);
      }
    } else if (msg.role === 'user') {
      const toolResults = blocks.filter(b => b.type === 'tool_result');
      const parts: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          parts.push({
            type: 'text',
            text: b.text ?? '',
            ...(openAiCacheBreakpoint(b, openAiPromptCacheBreakpoints)
              ? { providerOptions: openAiCacheBreakpoint(b, openAiPromptCacheBreakpoints) }
              : {}),
          });
        } else if (b.type === 'image') {
          const p = imagePart(b);
          if (p) {
            parts.push({
              ...p,
              ...(openAiCacheBreakpoint(b, openAiPromptCacheBreakpoints)
                ? { providerOptions: openAiCacheBreakpoint(b, openAiPromptCacheBreakpoints) }
                : {}),
            });
          }
        }
      }
      if (toolResults.length) {
        out.push({
          role: 'tool',
          content: toolResults.map(tr => ({
            type: 'tool-result',
            toolCallId: splitToolUseId(tr.tool_use_id ?? '').rawId,
            toolName: tr._name ?? 'unknown',
            output: { type: 'text', value: serializeToolResultContent(tr.content) },
            ...(openAiCacheBreakpoint(tr, openAiPromptCacheBreakpoints)
              ? { providerOptions: openAiCacheBreakpoint(tr, openAiPromptCacheBreakpoints) }
              : {}),
          })),
        } as unknown as ModelMessage);
      }
      if (parts.length) out.push({ role: 'user', content: parts } as unknown as ModelMessage);
    } else if (msg.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          // The OpenAI Responses API currently accepts breakpoints on input
          // content, not prior assistant output_text items.
          parts.push({ type: 'text', text: b.text ?? '' });
        } else if (b.type === 'thinking') {
          const part = thinkingToSdkPart(b, npm);
          if (part) parts.push(part);
        } else if (b.type === 'tool_use' && b.id) {
          const { rawId, thoughtSignature } = splitToolUseId(b.id);
          const part: Record<string, unknown> = {
            type: 'tool-call', toolCallId: rawId, toolName: b.name, input: b.input ?? {},
          };
          if (thoughtSignature && isGoogle) part.providerOptions = { google: { thoughtSignature } };
          parts.push(part);
        }
      }
      if (parts.length) out.push({ role: 'assistant', content: parts } as unknown as ModelMessage);
    }
  }
  return out;
}

/** Strip top-level null values so models that emit `null` for optional params don't fail schema validation. */
function stripNullInputs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

export function translateTools(anthropicTools?: AnthropicTool[]): Record<string, ReturnType<typeof tool>> | undefined {
  if (!anthropicTools?.length) return undefined;
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const t of anthropicTools) {
    if (!t.name || !t.input_schema) continue;
    tools[t.name] = tool({ description: t.description ?? '', inputSchema: jsonSchema(t.input_schema) });
  }
  return Object.keys(tools).length ? tools : undefined;
}

export function translateToolChoice(tc: AnthropicRequest['tool_choice']): SdkCallParams['toolChoice'] {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'tool', toolName: tc.name };
  return undefined;
}

export function translateRequest(
  body: AnthropicRequest,
  npm: string,
  options?: TranslateRequestOptions,
): SdkCallParams {
  const messages = body.messages ?? [];
  annotateToolNames(messages);

  // Claude Code prepends an Anthropic-only billing attribution block whose
  // `cch` value changes every request. It is envelope metadata, not a model
  // instruction, and forwarding it to OpenAI would invalidate the stable
  // prompt prefix. Anthropic passthrough and non-OAuth providers are untouched.
  const baseSystem = systemToString(body.system, options?.openAiOAuth === true);
  const systemText = baseSystem?.trim() || (options?.openAiOAuth ? 'You are a coding assistant.' : undefined);

  // resolveUpstreamTools uses the shared proxy types; the adapter keeps its own
  // minimal request shapes, so cast at this boundary.
  let upstreamTools = resolveUpstreamTools(
    body.tools as unknown as AnthropicToolDefinition[] | undefined,
    messages as unknown as AnthropicRequestMessage[],
  ) as unknown as AnthropicTool[];
  if (options?.maxTools !== undefined && upstreamTools.length > options.maxTools) {
    upstreamTools = upstreamTools.slice(0, options.maxTools);
  }
  const effort = anthropicEffortFromRequest(body) ?? options?.defaultEffort;
  let providerOptions = deepMergeProviderOptions(
    thinkingProviderOptions(npm),
    effortProviderOptions(npm, effort, options?.reasoningMetadata?.upstreamModelId ?? body.model, options?.reasoningMetadata),
  );

  // ChatGPT Codex OAuth backend requires `instructions` in providerOptions and
  // rejects the standard `system` field. It also manages its own output limit.
  if (options?.openAiOAuth && systemText) {
    providerOptions = deepMergeProviderOptions(providerOptions, {
      openai: { instructions: systemText },
    });
  }

  const upstreamModelId = options?.reasoningMetadata?.upstreamModelId ?? body.model;
  const supportsExplicitOpenAiCaching = !options?.openAiOAuth
    && supportsOpenAiPromptCacheBreakpoints(upstreamModelId);

  // Keep related requests in one cache partition. Prefer Claude Code's stable
  // session identity when available; the system/tools hash remains the fallback
  // for other Anthropic clients and API-server callers.
  //
  // GPT-5.6+ public-API implicit mode also
  // honors the explicit breakpoints copied from Claude Code's cache_control
  // blocks, while retaining an automatic latest-message breakpoint as fallback.
  if (npm === '@ai-sdk/openai') {
    const claudeSessionId = extractClaudeSessionId(body, options?.claudeSessionId);
    providerOptions = deepMergeProviderOptions(providerOptions, {
      openai: {
        promptCacheKey: claudeSessionId
          ? claudeSessionPromptCacheKey(claudeSessionId)
          : openAiPromptCacheKey(baseSystem, upstreamTools),
        ...(supportsExplicitOpenAiCaching
          ? { promptCacheOptions: { mode: 'implicit', ttl: '30m' } }
          : {}),
      },
    });
  }

  return {
    instructions: options?.openAiOAuth || supportsExplicitOpenAiCaching ? undefined : systemText,
    messages: [
      ...(supportsExplicitOpenAiCaching ? translateTopLevelSystemForOpenAi(body.system) : []),
      ...translateMessages(messages, npm, supportsExplicitOpenAiCaching),
    ],
    allowSystemInMessages: true,
    tools: translateTools(upstreamTools.length ? upstreamTools : undefined),
    toolChoice: translateToolChoice(body.tool_choice),
    maxOutputTokens: options?.openAiOAuth ? undefined : body.max_tokens,
    temperature: body.temperature,
    providerOptions,
  };
}

// ── usage: SDK → Anthropic ────────────────────────────────────────────────────
interface SdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  /** AI SDK 6 compatibility for older third-party LanguageModel implementations. */
  cachedInputTokens?: number;
}
interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Map SDK usage → Anthropic usage. SDK providers report the cache-hit subset in
 * `inputTokenDetails`, counted WITHIN the prompt total. The Anthropic schema
 * expects cache reads and writes in separate fields, so subtract both subsets
 * from input_tokens to avoid double-counting. GPT-5.6+ reports cache writes;
 * older models generally report reads only.
 */
function toAnthropicUsage(u?: SdkUsage): AnthropicUsage {
  const total = u?.inputTokens ?? 0;
  const cacheRead = u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens ?? 0;
  const cacheWrite = u?.inputTokenDetails?.cacheWriteTokens ?? 0;
  return {
    input_tokens: Math.max(0, total - cacheRead - cacheWrite),
    output_tokens: u?.outputTokens ?? 0,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
}

// ── response: SDK fullStream → Anthropic SSE ─────────────────────────────────
type WriteFn = (chunk: string) => void;

type LogFn = (msg: () => string) => void;

export interface AnthropicStreamObserver {
  /** Called for every AI SDK fullStream part before Relay translates it. */
  onPart?: (partType: string) => void;
  /** Local estimate used until the provider reports actual usage at stream completion. */
  initialInputTokens?: number;
  abortSignal?: AbortSignal;
  /** Abort if the provider produces no stream event for this long. */
  idleTimeoutMs?: number;
}

const SDK_STREAM_IDLE_TIMEOUT_MS = 120_000;
const SDK_TOTAL_TIMEOUT_MS = 10 * 60_000;

function streamAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal?.reason === 'string' ? signal.reason : 'SDK stream aborted',
  );
  error.name = 'AbortError';
  return error;
}

export async function writeAnthropicStream(
  stream: AsyncIterable<FullStreamPart>,
  modelId: string,
  write: WriteFn,
  log?: LogFn,
  observer?: AnthropicStreamObserver,
): Promise<void> {
  const messageId = 'msg_' + Date.now();
  let blockIndex = -1;
  let started = false;
  let openType: 'text' | 'thinking' | 'tool' | null = null;
  let pendingThinkingSig: string | undefined;
  const idToBlock = new Map<string, number>();
  let finishReason = 'end_turn';
  let usage: AnthropicUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  const emit = (event: string, data: unknown) => write(sseChunk(event, data));
  const ensureStart = () => {
    if (started) return;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', content: [],
        model: modelId, stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: observer?.initialInputTokens ?? 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    started = true;
  };
  const closeOpen = () => {
    if (openType === 'thinking') {
      emit('content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'signature_delta', signature: pendingThinkingSig ?? '' },
      });
      pendingThinkingSig = undefined;
    }
    if (openType) emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openType = null;
  };
  const openBlock = (type: 'text' | 'thinking' | 'tool', contentBlock: unknown) => {
    ensureStart(); closeOpen(); blockIndex++; openType = type;
    emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: contentBlock });
  };

  for await (const part of stream) {
    observer?.onPart?.(part.type);
    if (observer?.abortSignal?.aborted) throw streamAbortError(observer.abortSignal);
    switch (part.type) {
      // The SDK emits start before it knows whether the provider accepted the
      // request. Wait for content/finish so a pre-content HTTP failure can still
      // propagate through the proxy with its real non-2xx status.
      case 'start': break;

      // An abort is terminal but is not an error part in the AI SDK stream. If
      // treated like an unknown part, the loop ends and Relay synthesizes a
      // message_start/message_delta/message_stop after the client disconnected.
      // Throw so the HTTP layer follows its cancellation path and emits nothing.
      case 'abort':
        throw streamAbortError(observer?.abortSignal);

      case 'reasoning-start':
        openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
        break;
      case 'reasoning-delta':
        if (openType !== 'thinking') openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
        emit('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'thinking_delta', thinking: part.text ?? '' },
        });
        break;
      case 'reasoning-end': {
        const sig = grabRoundTripSignature(part);
        if (sig) pendingThinkingSig = sig;
        break;
      }

      case 'text-start':
        openBlock('text', { type: 'text', text: '' });
        break;
      case 'text-delta':
        if (openType !== 'text') openBlock('text', { type: 'text', text: '' });
        emit('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'text_delta', text: part.text ?? '' },
        });
        break;
      case 'text-end': break;

      case 'tool-input-start': {
        const sig = grabRoundTripSignature(part);
        openBlock('tool', {
          type: 'tool_use', id: encodeToolUseId(part.id ?? '', sig), name: part.toolName, input: {},
        });
        idToBlock.set(part.id ?? '', blockIndex);
        break;
      }
      case 'tool-input-delta':
        emit('content_block_delta', {
          type: 'content_block_delta', index: idToBlock.get(part.id ?? '') ?? blockIndex,
          delta: { type: 'input_json_delta', partial_json: part.delta ?? part.text ?? '' },
        });
        break;
      case 'tool-input-end': break;

      case 'tool-call': {
        finishReason = 'tool_use';
        // Non-streamed tool call (no input-start/delta arrived): emit a full block.
        if (!idToBlock.has(part.toolCallId ?? '') && openType !== 'tool') {
          const sig = grabRoundTripSignature(part);
          openBlock('tool', {
            type: 'tool_use', id: encodeToolUseId(part.toolCallId ?? '', sig), name: part.toolName, input: {},
          });
          emit('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(stripNullInputs(part.input as Record<string, unknown> ?? {})) },
          });
        }
        break;
      }

      case 'finish':
        if (part.totalUsage) {
          usage = toAnthropicUsage(part.totalUsage);
        }
        if (part.finishReason === 'tool-calls') finishReason = 'tool_use';
        else if (part.finishReason === 'length') finishReason = 'max_tokens';
        else if (part.finishReason === 'stop' && finishReason !== 'tool_use') finishReason = 'end_turn';
        break;

      case 'error': {
        const e = part.error as { data?: unknown; message?: string } | undefined;
        const errMsg = e?.message || (typeof part.error === 'string' ? part.error : JSON.stringify(e?.data ?? part.error));
        const errorType = anthropicErrorType(upstreamHttpStatus(part.error, errMsg));
        log?.(() => `sdk stream error (${errorType}): ${errMsg}`);
        closeOpen();
        throw part.error instanceof Error || (part.error && typeof part.error === 'object')
          ? part.error
          : new Error(errMsg);
      }

      default: break;
    }
  }

  // Some SDK transports end the iterator without yielding an explicit abort
  // part. Never synthesize completion frames for an already-cancelled request.
  if (observer?.abortSignal?.aborted) throw streamAbortError(observer.abortSignal);

  closeOpen();
  ensureStart();
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: null }, usage });
  emit('message_stop', { type: 'message_stop' });
}

// ── high-level entry points ──────────────────────────────────────────────────
export async function streamAnthropicResponse(
  model: LanguageModel,
  params: SdkCallParams,
  modelId: string,
  write: WriteFn,
  log?: LogFn,
  observer?: AnthropicStreamObserver,
): Promise<void> {
  const idleTimeoutMs = observer?.idleTimeoutMs ?? SDK_STREAM_IDLE_TIMEOUT_MS;
  const idleAbort = new AbortController();
  const abortSignal = observer?.abortSignal
    ? AbortSignal.any([observer.abortSignal, idleAbort.signal])
    : idleAbort.signal;
  let idleTimer = setTimeout(
    () => idleAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
    idleTimeoutMs,
  );
  const result = streamText({
    model,
    ...params,
    abortSignal,
    timeout: { totalMs: SDK_TOTAL_TIMEOUT_MS, chunkMs: idleTimeoutMs },
    onError: () => {},
  } as Parameters<typeof streamText>[0]);
  // Prevent unhandled promise rejections on stream properties:
  Promise.resolve(result.text).catch(() => {});
  Promise.resolve(result.toolCalls).catch(() => {});
  Promise.resolve(result.toolResults).catch(() => {});
  Promise.resolve(result.finishReason).catch(() => {});
  Promise.resolve(result.usage).catch(() => {});

  const watchedStream = (async function* () {
    try {
      for await (const part of result.stream as AsyncIterable<FullStreamPart>) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => idleAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
          idleTimeoutMs,
        );
        yield part;
      }
    } finally {
      clearTimeout(idleTimer);
    }
  })();

  await writeAnthropicStream(watchedStream, modelId, write, log, { ...observer, abortSignal });
}

export async function generateAnthropicResponse(
  model: LanguageModel,
  params: SdkCallParams,
  modelId: string,
  options?: {
    forceStream?: boolean;
    abortSignal?: AbortSignal;
    onPart?: (partType: string) => void;
    idleTimeoutMs?: number;
  },
): Promise<Record<string, unknown>> {
  let text: string;
  let toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  let finishReason: string;
  let usage: SdkUsage | undefined;

  if (options?.forceStream) {
    // Some upstreams (e.g. ChatGPT's Codex backend) reject non-streaming requests
    // outright. Request a real stream from the SDK and collect it into one
    // response instead of forwarding the client's non-streaming request upstream.
    const r = streamText({
      model,
      ...params,
      abortSignal: options.abortSignal,
      timeout: {
        totalMs: SDK_TOTAL_TIMEOUT_MS,
        chunkMs: options.idleTimeoutMs ?? SDK_STREAM_IDLE_TIMEOUT_MS,
      },
      onError: () => {},
    } as Parameters<typeof streamText>[0]);
    Promise.resolve(r.toolResults).catch(() => {});
    const observeParts = (async () => {
      for await (const part of r.stream as AsyncIterable<FullStreamPart>) {
        options.onPart?.(part.type);
        if (options.abortSignal?.aborted || part.type === 'abort') {
          throw streamAbortError(options.abortSignal);
        }
      }
      if (options.abortSignal?.aborted) throw streamAbortError(options.abortSignal);
    })();
    [text, toolCalls, finishReason, usage] = await Promise.all([
      r.text,
      r.toolCalls,
      r.finishReason,
      r.usage,
      observeParts,
    ]);
  } else {
    const r = await generateText({
      model,
      ...params,
      abortSignal: options?.abortSignal,
      timeout: { totalMs: SDK_TOTAL_TIMEOUT_MS },
    } as Parameters<typeof generateText>[0]);
    ({ text, toolCalls, finishReason, usage } = r);
  }

  return {
    id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model: modelId,
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolCalls.map(tc => ({
        type: 'tool_use',
        id: encodeToolUseId(tc.toolCallId, grabRoundTripSignature(tc as FullStreamPart)),
        name: tc.toolName,
        input: stripNullInputs(tc.input as Record<string, unknown>),
      })),
    ],
    stop_reason: finishReason === 'tool-calls' ? 'tool_use' : 'end_turn',
    usage: toAnthropicUsage(usage),
  };
}
