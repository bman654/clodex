// Shared Gemini content-part → Anthropic block parsing.

import type { AnthropicContentBlock, GeminiPart, GeminiUsageMetadata, ParsedGeminiPart } from './proxy-types.js';
import { encodeToolUseId, parseToolArguments } from './proxy-shared.js';

export function partThoughtSignature(part: GeminiPart): string | undefined {
  const sig = part.thoughtSignature ?? part.thought_signature;
  if (typeof sig === 'string' && sig.length > 0) return sig;
  const nested = part.functionCall?.thoughtSignature ?? part.functionCall?.thought_signature;
  if (typeof nested === 'string' && nested.length > 0) return nested;
  return undefined;
}

export function parseGeminiPart(
  part: GeminiPart,
  messageId: string,
  toolIndex: number,
): ParsedGeminiPart | null {
  // Gemini internal reasoning (part.thought) is not surfaced to Claude Code.
  // includeThoughts is disabled upstream; thought_signature on tool calls is separate.
  if (part.thought) return null;

  if (part.text !== undefined && !part.thought) {
    if (!part.text.trim()) return null;
    return { kind: 'text', text: part.text };
  }

  if (part.functionCall) {
    const fc = part.functionCall;
    const signature = partThoughtSignature(part);
    return {
      kind: 'tool_use',
      id: encodeToolUseId(`${messageId}_tc${toolIndex}`, signature),
      name: fc.name,
      input: parseToolArguments(fc.args),
      signature,
    };
  }

  return null;
}

export function collectAnthropicBlocksFromGeminiParts(
  parts: GeminiPart[],
  messageId: string,
): { content: AnthropicContentBlock[]; hasToolUse: boolean } {
  const content: AnthropicContentBlock[] = [];
  let toolIndex = 0;
  let hasToolUse = false;

  for (const part of parts) {
    const parsed = parseGeminiPart(part, messageId, toolIndex);
    if (!parsed) continue;

    if (parsed.kind === 'thinking') {
      content.push({ type: 'thinking', thinking: parsed.text, signature: parsed.signature });
    } else if (parsed.kind === 'text') {
      content.push({ type: 'text', text: parsed.text });
    } else {
      content.push({
        type: 'tool_use',
        id: parsed.id,
        name: parsed.name,
        input: parsed.input,
      });
      hasToolUse = true;
      toolIndex++;
    }
  }

  return { content, hasToolUse };
}

export function mapGeminiUsage(usageMetadata?: GeminiUsageMetadata) {
  const cached = usageMetadata?.cachedContentTokenCount ?? 0;
  return {
    input_tokens: Math.max(0, (usageMetadata?.promptTokenCount ?? 0) - cached),
    output_tokens: usageMetadata?.candidatesTokenCount ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}
