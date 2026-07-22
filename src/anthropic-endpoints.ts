const MESSAGE_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

export type AnthropicMessagesEndpoint = 'messages' | 'count_tokens';

/** Match Anthropic message endpoints by pathname, never by a shared prefix. */
export function anthropicMessagesEndpoint(url: string | undefined): AnthropicMessagesEndpoint | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://relay.local').pathname;
  } catch {
    return null;
  }
  if (pathname === MESSAGE_PATH) return 'messages';
  if (pathname === COUNT_TOKENS_PATH) return 'count_tokens';
  return null;
}

const NON_CONTEXT_FIELDS = new Set([
  'model',
  'stream',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
]);

/**
 * Rough vision-input cost per image. Images are forwarded as real image parts
 * (never inline base64 text), so they cost tile-based vision tokens — for a
 * typical screenshot on GPT-family and Claude models that lands around 1-2k.
 */
const IMAGE_INPUT_TOKEN_ESTIMATE = 1600;

function isAnthropicImageBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as { type?: unknown; source?: unknown };
  return rec.type === 'image' && !!rec.source && typeof rec.source === 'object';
}

/**
 * Provider-neutral local estimate for translated models, whose SDKs do not expose
 * a token-count API. It is intentionally conservative and, unlike inference, is
 * immediate, local, free, and side-effect free. Claude Code labels /context counts
 * as estimates already.
 *
 * Image blocks (top-level or inside tool_result content) are excluded from the
 * bytes/4 text heuristic — base64 payloads are huge but are delivered as vision
 * parts — and counted at a flat per-image estimate instead.
 */
export function estimateAnthropicInputTokens(body: object): number {
  const contextBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => !NON_CONTEXT_FIELDS.has(key)),
  );
  let imageCount = 0;
  const serialized = JSON.stringify(contextBody, (_key, value: unknown) => {
    if (isAnthropicImageBlock(value)) {
      imageCount += 1;
      return { type: 'image' };
    }
    return value;
  });
  if (!serialized || serialized === '{}') return 0;
  const textTokens = Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4);
  return Math.max(1, textTokens + imageCount * IMAGE_INPUT_TOKEN_ESTIMATE);
}

/** Anthropic-compatible message for an upstream context-length rejection. */
export function anthropicPromptTooLongMessage(body: object, contextWindow: number): string {
  const maximum = Math.max(1, Math.floor(contextWindow));
  // The translated providers do not expose an exact token-count endpoint. Keep the
  // message structurally compatible with Anthropic while ensuring the rejected
  // prompt count is represented as larger than the advertised maximum.
  const estimatedPromptTokens = estimateAnthropicInputTokens(body);
  const promptTokens = Math.max(estimatedPromptTokens, maximum + 1);
  return `prompt is too long: ${promptTokens} tokens > ${maximum} maximum`;
}
