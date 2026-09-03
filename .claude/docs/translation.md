# Translation layer

<!-- Read when changing src/sdk-adapter.ts, src/provider-factory.ts, or src/openai-adapter.ts. -->

## Translation layer

`src/sdk-adapter.ts` + `src/provider-factory.ts`: Anthropic `/v1/messages` ↔ Vercel AI SDK, one turn
per request (Claude Code owns the tool loop). This is the **single** translation path — no
hand-rolled per-provider translation. Preserved hard-won behavior:

- Inline `role:'system'` messages stay in their original conversation positions, so volatile
  reminders do not invalidate the stable prompt prefix.
- On public-API OpenAI GPT-5.6+ routes, Anthropic `cache_control` blocks become explicit OpenAI
  cache breakpoints. ChatGPT/Codex OAuth sends a hashed Claude session-derived `prompt_cache_key`
  and strips Claude Code's volatile billing-attribution header from instructions, but omits
  `prompt_cache_options` and explicit breakpoints — those produced successful-but-empty OAuth
  responses in testing.
- Cache reads and GPT-5.6 cache writes map to Anthropic
  `cache_read_input_tokens`/`cache_creation_input_tokens`.
- **Images in `tool_result` are lifted out of the text-only function-output channel** and delivered
  as real image parts on the following user message. Inline, a JSON.stringify'd base64 screenshot
  tokenizes at ~1.5 chars/token — 200k+ tokens per screenshot, killing agents with "Prompt is too
  long" while the local bytes/4 estimate showed half the real count.
  `estimateAnthropicInputTokens` likewise counts each image block at a flat vision estimate.
- **A compaction turn is forced to plain text with `toolChoice: 'none'`.** Claude Code forks that
  turn — automatic and manual `/compact` alike — with the forking session's full tool list and
  relies only on the prompt to stop the model calling them, while denying tool *execution* and
  allowing one turn. So an emitted call buys nothing: it burns the turn and returns no summary. The
  reactive path gets no retry; the manual path retries once outside the fork with a reduced tool
  set, then gives up as well. Three
  consecutive failures open a circuit breaker that skips later automatic compaction with no API
  call, until a successful compaction or a fresh query invocation resets it — which never happens
  inside one headless or subagent run, so the context grows until "Prompt is too long".
  `isClaudeCodeCompactRequest` keys on the envelope text and nothing else. Two rules it must keep:
  **do not re-narrow it to a particular tool** (`StructuredOutput` was the old precondition and
  missed every session without a schema — 15 of 173 real translated compact requests in the local
  ledgers), and **keep the header match anchored to the start of a text block**, because clodex's
  own sources, agent reports and pasted prompts quote the envelope and an unanchored match strips
  their tools. Tool *definitions* stay in the request so the cached prompt prefix still matches.
- `streamAnthropicResponse` maps SDK events to Anthropic SSE, aborting after 120s without an event.
- `modelPrefersResponsesApi()` selects `provider.responses(id)` for models requiring the Responses
  API (GPT-5.4+, GPT-5.5, `*-codex`, o-series); `provider.chat(id)` otherwise. Originator string is
  `clodex`.

