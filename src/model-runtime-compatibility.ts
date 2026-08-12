/**
 * Provider-neutral per-model compatibility hints.
 *
 * These describe Chat Completions wire quirks that cannot be inferred safely
 * from a provider or model family. Runtime adapters consume only the fields
 * they understand; unknown fields remain inert metadata.
 */
export interface ModelRuntimeCompatibility {
  /** Claude/Codex effort -> upstream reasoning_effort map. null disables that level. */
  reasoningEffortMap?: Record<string, string | null>;
  /** Explicitly enable or disable reasoning_effort for this model. */
  supportsReasoningEffort?: boolean;
  /** Additional request shape required when reasoning is enabled. */
  thinkingFormat?: 'deepseek' | 'qwen';
  /** Replay an empty reasoning_content field when prior assistant reasoning is absent. */
  requiresReasoningContentOnAssistantMessages?: boolean;
  /** Whether the upstream accepts the OpenAI `store` request field. */
  supportsStore?: boolean;
  /** Whether the upstream accepts the Chat Completions `temperature` request field. */
  supportsTemperature?: boolean;
  /** Whether the upstream accepts Chat Completions `developer` messages. */
  supportsDeveloperRole?: boolean;
  /** Output-token field accepted by the upstream Chat Completions endpoint. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Whether the upstream accepts long prompt-cache retention controls. */
  supportsLongCacheRetention?: boolean;
  /**
   * Whether an anthropic-format upstream implements
   * `POST /v1/messages/count_tokens`. Speaking the Messages API does not imply
   * it — OpenCode Zen documents `/v1/responses`, `/v1/chat/completions` and
   * `/v1/messages` and no token-counting endpoint — and forwarding a count to
   * an upstream without it answers the client's token accounting with a 404
   * instead of a number. Only an explicit `false` diverts to the local
   * estimate; unset keeps forwarding, so a custom Anthropic-compatible
   * endpoint that does implement it is unaffected.
   */
  supportsCountTokens?: boolean;
}

export type OpenAiCompatibleRequestBody = Record<string, unknown>;

type ChatMessage = Record<string, unknown> & { role?: unknown };

function remapMaxTokensField(
  body: OpenAiCompatibleRequestBody,
  field: ModelRuntimeCompatibility['maxTokensField'],
): void {
  if (field === 'max_tokens') {
    if (body.max_tokens === undefined && body.max_completion_tokens !== undefined) {
      body.max_tokens = body.max_completion_tokens;
    }
    delete body.max_completion_tokens;
    return;
  }
  if (field === 'max_completion_tokens') {
    if (body.max_completion_tokens === undefined && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens;
    }
    delete body.max_tokens;
  }
}

function transformMessages(
  messages: unknown,
  compatibility: ModelRuntimeCompatibility,
): unknown {
  if (!Array.isArray(messages)) return messages;
  const rewriteDeveloper = compatibility.supportsDeveloperRole === false;
  const replayReasoning = compatibility.requiresReasoningContentOnAssistantMessages === true;
  if (!rewriteDeveloper && !replayReasoning) return messages;

  let changed = false;
  const transformed = messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const source = message as ChatMessage;
    const role = source.role;
    const needsRoleRewrite = rewriteDeveloper && role === 'developer';
    const needsReasoningReplay = replayReasoning
      && role === 'assistant'
      && !Object.prototype.hasOwnProperty.call(source, 'reasoning_content');
    if (!needsRoleRewrite && !needsReasoningReplay) return message;

    changed = true;
    return {
      ...source,
      ...(needsRoleRewrite ? { role: 'system' } : {}),
      ...(needsReasoningReplay ? { reasoning_content: '' } : {}),
    };
  });

  return changed ? transformed : messages;
}

/**
 * Apply model-specific OpenAI-compatible request quirks after the AI SDK has
 * assembled its Chat Completions payload.
 */
export function transformOpenAiCompatibleRequestBody(
  body: OpenAiCompatibleRequestBody,
  compatibility: ModelRuntimeCompatibility,
): OpenAiCompatibleRequestBody {
  const transformed = { ...body };

  const reasoningEffort = transformed.reasoning_effort;
  const reasoningEffortMap = compatibility.reasoningEffortMap;
  if (compatibility.supportsReasoningEffort === false) {
    delete transformed.reasoning_effort;
  } else if (
    typeof reasoningEffort === 'string'
    && reasoningEffortMap !== undefined
    && Object.prototype.hasOwnProperty.call(reasoningEffortMap, reasoningEffort)
  ) {
    const mapped = reasoningEffortMap[reasoningEffort];
    if (mapped === null) {
      delete transformed.reasoning_effort;
    } else {
      transformed.reasoning_effort = mapped;
    }
  }

  if (compatibility.supportsStore === false) delete transformed.store;
  if (compatibility.supportsTemperature === false) delete transformed.temperature;
  if (compatibility.supportsLongCacheRetention === false) {
    delete transformed.prompt_cache_retention;
    delete transformed.promptCacheRetention;
  }
  remapMaxTokensField(transformed, compatibility.maxTokensField);

  const messages = transformMessages(transformed.messages, compatibility);
  if (messages !== transformed.messages) transformed.messages = messages;

  const hasReasoningEffort = typeof transformed.reasoning_effort === 'string'
    && transformed.reasoning_effort.trim().length > 0;
  if (hasReasoningEffort && compatibility.thinkingFormat === 'deepseek') {
    if (transformed.thinking === undefined) transformed.thinking = { type: 'enabled' };
  } else if (hasReasoningEffort && compatibility.thinkingFormat === 'qwen') {
    if (transformed.enable_thinking === undefined) transformed.enable_thinking = true;
  }

  return transformed;
}
