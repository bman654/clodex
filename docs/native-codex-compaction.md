# Experimental native OpenAI/Codex compaction

Native compaction is an experimental, opt-in feature for ChatGPT/Codex OAuth
Responses models. It replaces part of a long OpenAI-side response chain with
OpenAI's opaque `compaction` item.

It is off by default because Claude Code and OpenAI maintain different views of
the conversation. OpenAI can compact its chain without shrinking Claude Code's
local transcript. If the live OpenAI state is later lost, Claude may try to
replay a transcript that no longer fits the model's context window.

## Enable it

Set the opt-in flag in the environment that launches Clodex:

```sh
CLODEX_OPENAI_COMPACTION=1 clodex claude
```

The default trigger is 90% of the model's advertised context window. A positive
integer override can be used in production or tests:

```sh
CLODEX_OPENAI_COMPACTION=1 \
CLODEX_OPENAI_COMPACT_THRESHOLD=220000 \
clodex claude
```

`CLODEX_OPENAI_COMPACT_THRESHOLD` does not enable the feature by itself.
Invalid, fractional, zero, and negative thresholds are ignored.

## Clodex-owned context lifecycle

Clodex-launched OpenAI OAuth children set `CLODEX_NATIVE_CONTEXT_OWNER=1`.
The patched Claude binary then leaves automatic/precomputed compaction, the
local blocking guard, and Claude's local context-window override disabled for
that child. Manual `/compact` remains available. Native OpenAI compaction at
the configured threshold owns the model-facing chain, with the advertised
model window retained as the hard provider ceiling and recovery boundary.

Native compaction intentionally does not rewrite Claude's local transcript. The
two ledgers therefore remain different: Claude retains UI/resume history while
Clodex retains compacted OpenAI continuation state. On restart, model
switch, checkpoint expiry, or recovery failure, Claude's manual/portable
summary path remains the safe handoff.

Enabling native compaction also opts into durable recovery checkpoints under
`~/.clodex/responses-checkpoints`. These files can contain retained user
messages, assistant/tool state, and OpenAI's opaque compaction item. Clodex
creates the directory with mode `0700` and files with mode `0600`, rejects
symlinked stores, limits each file to 8 MiB, and removes checkpoints after seven
days on the next checkpoint scan. Keep the Clodex home directory private.

Claude-initiated compaction turns, including `/compact`, never trigger an
additional hidden native compaction. They run against the existing response
chain so the portable summary sees the full available history.

## Operations that can lose native state

After native compaction has occurred, these operations can abandon the live
response chain or select a different partition:

- restarting Clodex or using `--resume`;
- leaving the session idle beyond the WebSocket/checkpoint lifetime;
- switching the model or reasoning effort;
- `/rewind`, `/fork`, or `/btw`;
- checkpoint eviction;
- a failed standalone recovery request.

Process-local compact checkpoints expire after 30 minutes. Durable checkpoints
expire after seven days. Both are capped at 16 per model/account/session
partition and 64 globally. Durable storage is bounded, rescanned periodically
for checkpoints written by another Clodex process, and used to recover matching
agent lineages after restart.

Before a planned restart, model switch, or resume, use Claude's normal
`/compact` while the transcript still fits. If native state is already gone and
the saved transcript is over the model window, the session is not recoverable
in-session: start a new session with a portable handoff rather than repeatedly
retrying the oversized transcript.

## Request and cache behavior

For a matching live response head:

1. Clodex sends only the current delta plus
   `{ "type": "compaction_trigger" }` with `previous_response_id`.
2. OpenAI returns exactly one opaque compaction item.
3. Clodex starts a fresh response chain from recent retained user input followed
   by that opaque item.
4. The new head is recorded only after `response.completed`; later turns return
   to delta-only continuation.

The trigger request is cache-warm by construction because it continues the live
response chain. The fresh post-compaction chain is a new prefix and can incur a
one-time cache write before later turns can reuse that new cached prefix.
Native compaction is an additional inference request and consumes plan/API
usage.

Retained user messages use a 64K approximate-token budget. Text is counted by
UTF-8 bytes and media is charged the same flat vision estimate used elsewhere
in Clodex, so base64 payload size is not mistaken for text tokens.

## Recovery path and time budget

`POST /responses/compact` is used only when no live head is available or the
in-band trigger fails. Its returned array is canonical and is forwarded as-is;
Clodex does not prune or reinterpret it.

The in-band trigger and standalone call each have a 60-second budget and run
sequentially inside one fetch. Together they can consume the full 120-second
Claude Code no-data watchdog before the ordinary fallback starts. A failed
compact attempt preserves the ordinary request path where possible.

## Claude transcript handoff

When Claude later writes a portable summary, Clodex stores only an SHA-256 hash
of the normalized summary beside an already compacted head. The next rewritten
request can reattach only when exactly one continuation envelope has the exact
hash. Missing, short, malformed, duplicated, or non-matching envelopes fall
back without selecting opaque state. Diagnostics report an `anchor_missed`
outcome without recording summary text.

Summary extraction mirrors the client: the last assistant message containing a
`<summary>` block supplies the first text part used for the anchor.

## Diagnostics and live probe

`--trace` or `--ws-diagnostics` emits bounded `ws_compaction` metadata without
conversation text or opaque content. The guarded probe is available with:

```sh
CLODEX_LIVE_COMPACTION_PROBE=1 \
pnpm dlx tsx scripts/probe-openai-compaction.ts
```

The probe reports trigger request bytes as `triggerWireBytes` and received SSE
bytes as `responseWireBytes`; these are deliberately separate measurements. It
also reports input, cached-input, cache-write, and output token usage when the
backend supplies it.

Live capability checks established that Sol and Luna accept
`/responses/compact`, and Sol accepts an in-band `compaction_trigger`.
Automatic `context_management` was rejected by the ChatGPT/Codex backend during
testing, so Clodex does not send it.

## Protocol references

- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Codex remote-compaction-v2 source](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2.rs)

The portable-summary anchor was informed by
[`raine/claude-code-proxy`](https://github.com/raine/claude-code-proxy).
