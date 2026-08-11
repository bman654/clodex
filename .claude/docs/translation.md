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
- `streamAnthropicResponse` maps SDK events to Anthropic SSE, aborting after 120s without an event.
- `modelPrefersResponsesApi()` selects `provider.responses(id)` for models requiring the Responses
  API (GPT-5.4+, GPT-5.5, `*-codex`, o-series); `provider.chat(id)` otherwise. Originator string is
  `clodex`.

