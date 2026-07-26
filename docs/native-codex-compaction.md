# Native OpenAI/Codex compaction

Status: implemented for ChatGPT/Codex OAuth Responses models.

## Outcome

clodex now uses the same native opaque compaction item as Codex while preserving
Claude Code's Anthropic-compatible session and its existing prompt-cache and
`previous_response_id` optimizations.

The default threshold mirrors Codex: 90% of the model's advertised context
window. For a 272,000-token model, compaction starts at 244,800 tokens.

Set `CLODEX_OPENAI_COMPACTION=0` to disable native compaction. For testing, an
explicit positive token threshold can be set with
`CLODEX_OPENAI_COMPACT_THRESHOLD`.

## Efficient live-chain path

When a completed OpenAI response reports input usage at or above the threshold,
the next matching request is handled transactionally:

1. Exact Claude lineage selects one idle Responses head.
2. clodex appends the current delta plus `{ "type": "compaction_trigger" }`
   using that head's `previous_response_id`.
3. OpenAI returns one opaque `compaction` item.
4. clodex keeps the old head as a transactional fallback and builds a new
   canonical input from:
   - recent user messages, bounded to Codex's 64K retained-message policy;
   - the opaque native compaction item.
5. The actual Claude request starts a fresh Responses chain from that compacted
   input, without the old `previous_response_id`.
6. After `response.completed`, clodex closes the old head and later Claude turns
   continue on the new head with delta-only input.

This is Codex's newer remote-compaction-v2 protocol. It avoids sending the full
transcript to a second HTTP endpoint. A live synthetic probe sent a 455-byte
incremental trigger; OpenAI reported 6,912 of 7,665 logical input tokens as
cached (90.2%).

## Standalone recovery path

`POST /responses/compact` remains a fallback when no usable live head exists,
such as:

- the first request after a process restart is already over the threshold;
- a compacted checkpoint needs another compaction but has no live socket;
- the in-band trigger fails before producing a valid compaction item.

The request preserves the exact model, instructions, tools, reasoning,
`prompt_cache_key`, service tier, and text settings used by Codex's compact
client. Its canonical output is forwarded as-is to a fresh response chain.

Standalone compaction consumes a separate inference request. In a live repeated
probe, two identical 7,613-token compact calls both reported zero cached input.
It is therefore deliberately a recovery path, not the normal live-session path.

## State and branch safety

Claude transcript lineage and OpenAI canonical compacted input are kept
separately:

- Claude lineage is used only for exact-prefix branch selection.
- Opaque reasoning and compaction items are allowed to be absent from Claude's
  echo, but every remaining assistant/tool item must still match exactly.
- Compaction applies to one selected head, never an entire session partition.
- Hidden parallel requests keep their existing isolated-socket behavior.
- A compacted head is promoted only after the first post-compact response
  completes.

Completed compacted heads also create bounded process-local checkpoints:

- at most 8 per partition and 32 globally;
- keyed by the full model/effort/account/cache/session partition;
- selected only by exact Claude lineage;
- used to restore canonical compacted input after socket expiry or replacement.

Cross-process checkpoint persistence is intentionally not implemented. After a
restart, clodex safely falls back to standalone compaction or the normal full
request because Claude's saved transcript cannot reconstruct OpenAI's opaque
item.

## Claude's local compaction handoff

Native OpenAI compaction does not replace or suppress Claude Code's own
compaction. Claude still asks the model for a portable summary and then rewrites
its local transcript around that summary. That changes Claude's source lineage,
so an ordinary exact-prefix match can no longer find the compacted OpenAI head.

clodex bridges the boundary without retaining the summary text:

1. The post-compact response completes on the new OpenAI chain.
2. If that response is Claude's compaction turn, clodex normalizes Claude's
   `<analysis>`/`<summary>` output exactly as the current Claude Code client
   does and stores only its SHA-256 hash beside the compacted head.
3. On the next request, clodex recognizes Claude's standard continuation
   wrapper and requires the wrapped portable summary to match that hash exactly.
4. The summary wrapper is removed, the remaining current input becomes the
   delta, and the request continues from the compacted head's
   `previous_response_id`.
5. After that response completes, Claude's rewritten transcript is once again
   an ordinary exact-prefix lineage.

An absent, short, malformed, duplicated, or non-matching summary never selects
the opaque head. It falls through to checkpoint or full-context recovery.
Neither the summary plaintext nor the opaque compaction item is written to
diagnostics.

## Failure behavior

- Invalid or failed trigger: try standalone `/responses/compact`.
- Failed standalone compact: continue through the normal full-context path.
- Claude portable-summary mismatch: do not attach the rewritten transcript to
  opaque state; use the ordinary safe fallback path.
- Pre-frame transport failure after compaction: retry once with canonical
  compacted input, never the old full transcript.
- `previous_response_not_found`: retry once on a fresh chain using the canonical
  compacted checkpoint when available.
- Failure after model output: do not replay the request.

Compaction diagnostics record only bounded metadata: trigger reason, transport,
threshold, item counts, input/cache/output usage, status code, and hashed
correlation identifiers. Conversation and compacted content are never logged.

## Capability findings

Live ChatGPT/Codex OAuth probes confirmed:

- `/responses/compact` works for GPT-5.6 Sol and GPT-5.6 Luna.
- `compaction_trigger` works over a Sol WebSocket continuation.
- automatic `context_management` is currently rejected by the ChatGPT/Codex
  backend, even though the pinned OpenAI AI SDK supports the field.

The implementation therefore does not send `context_management`.

## Prior art and references

[`raine/claude-code-proxy`](https://github.com/raine/claude-code-proxy)
demonstrated the portable-summary anchor needed to reconnect Claude's rewritten
transcript to a native Codex compaction artifact. Its
[`compaction.rs`](https://github.com/raine/claude-code-proxy/blob/main/src/providers/codex/compaction.rs)
implementation sends the translated conversation plus a compaction trigger as
an additional request. clodex adopts the exact-anchor safety property, stores a
hash rather than summary plaintext, and uses the live
`previous_response_id` chain when available so the trigger itself contains only
the incremental delta.

OpenAI protocol references:

- [Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
