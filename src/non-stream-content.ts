import { grabRoundTripSignature, type FullStreamPart } from './proxy-shared.js';
import { OpenAiThinkingBlock, openAiReasoningItemId } from './openai-thinking.js';

type Block = Record<string, unknown>;

type OpenBlock =
  | { type: 'text'; block: Block }
  | { type: 'thinking'; block: Block; openAi?: OpenAiThinkingBlock; signature?: string };

/**
 * Content for a non-streaming Anthropic response, built from AI SDK parts in
 * the order they arrived. Thinking blocks open, merge and close by the same
 * rules as `writeAnthropicStream`, so a turn Claude Code received without
 * streaming — its fallback after a stream fails partway — replays the same
 * reasoning as the turn would have streamed. Keep the two in step;
 * tests/non-stream-reasoning.test.ts compares them.
 */
export class NonStreamContent {
  private readonly blocks: Block[] = [];
  private open: OpenBlock | undefined;

  add(part: FullStreamPart): void {
    switch (part.type) {
      case 'reasoning-start':
        if (openAiReasoningItemId(part) && part.id) {
          // Consecutive OpenAI reasoning items share one block and one envelope.
          let open = this.open;
          if (open?.type !== 'thinking' || !open.openAi) {
            open = this.openThinking(new OpenAiThinkingBlock());
          }
          open.openAi!.start(part);
        } else {
          this.openThinking();
        }
        break;
      case 'reasoning-delta': {
        const open = this.open?.type === 'thinking' ? this.open : this.openThinking();
        open.block.thinking += open.openAi ? open.openAi.append(part) : part.text ?? '';
        break;
      }
      case 'reasoning-end':
        if (this.open?.type !== 'thinking') break;
        if (this.open.openAi) this.open.openAi.end(part);
        else this.open.signature = grabRoundTripSignature(part) ?? this.open.signature;
        break;
      case 'text-start':
        this.openText();
        break;
      case 'text-delta': {
        const open = this.open?.type === 'text' ? this.open : this.openText();
        open.block.text += part.text ?? '';
        break;
      }
      default:
        break;
    }
  }

  /** Append a finished block, such as a tool_use, after whatever is open. */
  push(block: Block): void {
    this.close();
    this.blocks.push(block);
  }

  content(): Block[] {
    this.close();
    return this.blocks;
  }

  private openThinking(openAi?: OpenAiThinkingBlock): Extract<OpenBlock, { type: 'thinking' }> {
    this.close();
    const block = { type: 'thinking', thinking: '', signature: '' };
    const open = { type: 'thinking' as const, block, openAi };
    this.open = open;
    return open;
  }

  private openText(): Extract<OpenBlock, { type: 'text' }> {
    this.close();
    const open = { type: 'text' as const, block: { type: 'text', text: '' } };
    this.open = open;
    return open;
  }

  private close(): void {
    const open = this.open;
    this.open = undefined;
    if (!open) return;
    if (open.type === 'thinking') {
      open.block.signature = open.openAi?.signature() ?? open.signature ?? '';
      this.blocks.push(open.block);
    } else if (open.block.text) {
      // An empty text block is never sent: Anthropic rejects one if the
      // history is later replayed there.
      this.blocks.push(open.block);
    }
  }
}

/**
 * Feed a `generateText` result's content through the same rules as a stream.
 *
 * `@ai-sdk/openai-compatible` appends a non-streamed response's reasoning after
 * its text, although the model reasoned first and the stream delivers it first.
 * Reasoning without an OpenAI item id that follows text therefore moves to the
 * front, as it would have streamed. Reasoning the extract-reasoning middleware
 * lifts out of the text already sits just ahead of that text, and OpenAI
 * reasoning keeps its place: the Responses API needs each reasoning item
 * replayed ahead of the output it produced.
 */
export function addGeneratedContent(
  content: NonStreamContent,
  parts: FullStreamPart[],
  addToolCall: (part: FullStreamPart) => void,
): void {
  const firstText = parts.findIndex(part => part.type === 'text');
  const late = parts.map((part, index) => firstText >= 0 && index > firstText
    && part.type === 'reasoning' && !openAiReasoningItemId(part));
  const ordered = [...parts.filter((_, i) => late[i]), ...parts.filter((_, i) => !late[i])];
  ordered.forEach((part, index) => {
    if (part.type === 'reasoning') {
      const id = `reasoning-${index}`;
      const { text, providerMetadata } = part;
      content.add({ type: 'reasoning-start', id, providerMetadata });
      content.add({ type: 'reasoning-delta', id, text, providerMetadata });
      content.add({ type: 'reasoning-end', id, providerMetadata });
    } else if (part.type === 'text') {
      content.add({ type: 'text-start' });
      content.add({ type: 'text-delta', text: part.text });
    } else if (part.type === 'tool-call') {
      addToolCall(part);
    }
  });
}
