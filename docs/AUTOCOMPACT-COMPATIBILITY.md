# Structured-output autocompact compatibility

## Summary

Claude Code reactive compaction requires a plain-text response and rejects every tool call. However, a workflow agent created with `agent({ schema })` inherits its parent tool inventory when Claude Code forks the compact turn, including the terminal `StructuredOutput` tool.

Some OpenAI-family models select that highly salient schema tool despite Claude Code's compact prompt explicitly requiring text only. Claude Code rejects the call locally, receives no summary text, retries three times, then disables autocompaction for the session. The context subsequently grows until the model returns `Prompt is too long`.

relay-ai prevents this failure for SDK-translated providers while preserving prompt-cache reuse.

## Observed failure sequence

The failure was reproduced with Sol and Terra structured-output agents on 2026-07-17:

```text
autocompact: routing through reactive (thresholdSource=env)
StructuredOutput tool permission denied
Reactive compact: empty summary text in summarization response
```

After three attempts:

```text
autocompact: circuit breaker tripped after 3 consecutive failures
```

The upstream compact responses were successful HTTP 200 responses ending in `stop_reason: "tool_use"`. They contained `StructuredOutput` calls and no text, so this was not a relay transport or provider availability failure.

Haiku received the same leaked `Read` and `StructuredOutput` definitions but followed the no-tools instruction and returned text. This established that the triggering difference was model behavior, not an additional Anthropic-only compact instruction.

## Relay compatibility behavior

`translateRequest()` recognizes only the observed structured-output compact envelope:

1. The request has no top-level `diagnostics` field. Normal agent turns include it; reactive compact turns do not.
2. The raw tool inventory contains `StructuredOutput`.
3. The final message is from the user.
4. Text blocks in that final message contain both exact compact markers:
   - `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`
   - `REMINDER: Do NOT call any tools. Respond with plain text only`

When all conditions match, relay-ai:

- Retains the resolved tool definitions unchanged.
- Overrides the translated request's tool choice to `none`.
- Leaves messages, the compact instruction, and the parent request object unchanged.

OpenAI Responses treats `tool_choice: "none"` as an API-enforced prohibition on all tool calls. The tool schemas remain inert: the model must return ordinary text, so the `StructuredOutput` schema cannot constrain the compact digest.

If Claude Code changes its compact envelope, detection deliberately fails open. Ordinary requests keep their original tools and tool choice instead of being misclassified.

## Why tools remain in the request

Tool definitions are part of the stable OpenAI prompt prefix. Physically removing them fixes compaction, but changes that prefix and loses cache reuse for the compact call.

Keeping the identical definitions and changing only `tool_choice` preserves the cacheable system/tool prefix and the session-derived `prompt_cache_key`. In the paired live verification:

- Physical tool removal: compact response reported 0 cached input tokens.
- Retained tools plus `tool_choice: "none"`: compact response reported 34,560 cached input tokens.

The runs are not a controlled cache benchmark, but the result is consistent with the expected prefix behavior. The behavioral test also verifies that ordinary and compact translations produce the same `promptCacheKey` and tool names.

## Verification

The retained-tools implementation was exercised through the real selective HTTP proxy with the installed Claude Code binary and a Sol/medium workflow agent using a small structured-output schema.

The probe crossed the reactive compaction threshold and returned to the normal context level. The compact turn retained both `Read` and `StructuredOutput` in the sanitized incoming envelope, then successfully returned a text summary. The debug log contained none of:

- `StructuredOutput tool permission denied`
- `Reactive compact: empty summary text`
- compact circuit-breaker activation
- `Prompt is too long`

The workflow later stopped at `chunk 18 done` because of Claude Code's separate post-compaction task-retention behavior; compaction itself succeeded.

Automated coverage in `tests/sdk-adapter.test.ts` executes `translateRequest()` and verifies:

- Positive compact detection retains tools but forces `toolChoice: "none"`.
- The compact prompt and preceding tool result remain translated.
- The original tool array is not mutated.
- A one-marker request fails open.
- An ordinary structured-output request retains its original tool choice.
- Compact and ordinary translations retain the same prompt-cache key.

## Scope

The workaround is at the shared Anthropic-to-SDK translation boundary. Native Anthropic passthrough remains byte-preserving and does not use it. No Claude Code binary patch is required.
