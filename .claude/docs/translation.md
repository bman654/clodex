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
- Consecutive OpenAI Responses reasoning summaries/items stream into **one Anthropic thinking
  block** until text, a tool, or successful completion closes it. A thinking-only WebSocket drop
  leaves that block open, so an earlier summary cannot disable Claude Code's mid-stream retry.
  `src/openai-thinking.ts` carries a versioned, self-contained signature envelope: original SDK
  item IDs, original summary text, and encrypted content. On the next request it restores separate
  SDK reasoning parts; the SDK rebuilds the original summary groups. Display-only paragraph breaks
  never enter the upstream summaries. Original text lives inside the opaque signature rather than
  being recovered from the display text, so client-side text edits or Unicode sanitization cannot
  change what goes back to OpenAI. This duplicates summary text in client requests and transcripts
  and retains any intermediate ciphertext the SDK exposes; only each item's final ciphertext goes
  upstream. The envelope itself is never sent upstream. No process-local registry or provider
  ciphertext rewriting is involved. Legacy raw signatures remain readable. An unknown or malformed
  envelope is omitted, never forwarded as ciphertext; switching a valid envelope to another
  translated provider retains only the display text. Older clodex builds cannot decode these new
  signatures and would forward the envelope as provider ciphertext, which can cause upstream errors.
  Resume such transcripts with an envelope-aware build rather than downgrading the bridge. This does not
  change non-streaming responses' existing omission of reasoning, or the transport's prohibition
  on replaying already-emitted model output. The guarantee covers SDK-visible summary text,
  grouping and encrypted content, not output-only fields the SDK omits (such as `status`).
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
  set, then gives up as well. Three consecutive failures open a circuit breaker that skips later
  automatic compaction with no API
  call, until a successful compaction or a fresh query invocation resets it — which never happens
  inside one headless or subagent run, so the context grows until "Prompt is too long".
  `isClaudeCodeCompactRequest` keys on the envelope text and nothing else. Two rules it must keep:
  **do not re-narrow it to a particular tool** (`StructuredOutput` was the old precondition and
  missed every session without a schema — 15 of 173 real translated compact requests in the local
  ledgers), and **keep the header match anchored to the start of a text block**, because clodex's
  own sources, agent reports and pasted prompts quote the envelope and an unanchored match strips
  their tools. Tool *definitions* stay in the request so the cached prompt prefix still matches.
  If the strict header changes, a deliberately bounded warning-only recognizer can report one
  subset of drift without changing tool choice: after an optional known severity label, the new
  header must still start with `respond`, `return`, `answer`, `output`, `write`, or `provide`, then
  say text only and prohibit tools on one short line; the rejected-tool/only-turn anchor must remain
  at line start. It is not a general drift detector. The reverse shape — strict header
  intact, reminder changed — is deliberately invisible at runtime because it is indistinguishable
  from a pasted header. The per-build probe checks both strict markers in every extracted bundle;
  that catches their removal or in-place rewording, not a new third builder that leaves both old
  strings present. A warning is diagnostic only: tools stay enabled and compaction can still fail
  until clodex updates its markers. Terminal notices are capped at three `cc_version` signatures per
  process (plus one suppression line), while every sighting remains in the trace log.
- Anthropic- and OpenAI-format `streamText` calls abort after the configured idle window without an
  event (120s by default) or the configured total provider-call window (10m by default). True
  `generateText` calls enforce only the total window because they expose no event that can reset an
  idle clock.
- `modelPrefersResponsesApi()` selects `provider.responses(id)` for models requiring the Responses
  API (GPT-5.4+, GPT-5.5, `*-codex`, o-series); `provider.chat(id)` otherwise. Originator string is
  `clodex`.

