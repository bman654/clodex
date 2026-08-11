# OpenAI OAuth WebSocket continuation

<!-- Read when changing src/oauth/, continuation/head matching, upstream retries, or WS diagnostics. -->

## OpenAI OAuth WebSocket continuation

`src/oauth/responses-websocket.ts`. **Do not restructure this file.**

All ChatGPT/Codex OAuth Responses models use a persistent WebSocket transport. Connections are
partitioned by provider, OAuth account, upstream model, normalized effort, and hashed Claude
session. Completed responses become validated chain heads (exact text/tool/reasoning capture;
function-call args compared as canonical JSON). The next request picks the longest exact-prefix head
and sends `previous_response_id` + incremental input; any mismatch, failure, or expiry falls back
safely to full context. `previous_response_not_found` retries once with full context before anything
is emitted downstream. A transport failure likewise retries once **with full context** — not the
same continuation payload — while no downstream bytes, model data, or accumulated output exist; buffered control frames do not close that safe window, but any model
output makes the failure terminal. OAuth requires `store:false` (a `store:true` probe returns 400).

**Connection pools are process-wide, not per-partition:** `maxConnections` (established, default 32)
and `maxNurseryConnections` (default 8). A head starts in the nursery and is promoted only when
successfully continued — so a workload fanning out into many concurrent subagent conversations (all
inheriting the parent's Claude session id, therefore sharing one partition) can evict heads before
their next turn and lose the continuation. Override via `CLODEX_WS_MAX_CONNECTIONS` /
`CLODEX_WS_MAX_NURSERY_CONNECTIONS` (integer 1–1024; malformed values are logged and ignored). An
explicit programmatic option outranks the environment so tests are never perturbed. Eviction reasons
(`nursery_lru_cap`, `established_lru_cap`, `idle_ttl`, `nursery_idle_ttl`, `hard_ttl`) appear in the
`evictions` array on every `ws_head_decision` diagnostic — sustained `*_lru_cap` counts mean a cap
is too small.

### Upstream retries

Every SDK generation entry point resolves `CLODEX_UPSTREAM_MAX_RETRIES` through
`src/upstream-retry.ts`. Unset or malformed values leave the SDK's two-retry default in control;
valid integers are bounded to 0–5. Five retries complete before the translated streaming paths'
120-second no-data timeout; larger integers clamp to 5 with a one-time stderr warning. That idle
deadline — not the separate ten-minute total timeout — is the effective retry ceiling. Keep
translated and OpenAI-format streaming and non-streaming consumers wired together. **This policy can
recover only before output begins**; replay after partial output could duplicate content or tool
calls.

### Mismatch diagnostics

On a history mismatch the head-decision log includes `expected_hash`/`actual_hash` (SHA-256 of each
side's canonical item bytes) whenever at least one side has an item at the divergent index, so
same-kind mismatches are diagnosable without exposing content; `none` marks an unavailable side.

`CLODEX_MISMATCH_DUMP=1` additionally writes both divergent items' canonical bytes (capped per line,
`(absent)` past a history's end) into the adapter debug log. **Privacy tradeoff:** the dump contains
raw conversation content. Reaching disk takes a double opt-in — `--trace` **and**
`CLODEX_MISMATCH_DUMP=1` — and the write path runs `redactTraceLine`, scrubbing bearer tokens and
known API-key shapes. The exposure is the durable artifact itself: the mode-0600 file clodex prints
as `Adapter debug log:`, which is what users paste into bug reports. It is never re-printed to the
terminal (`printTraceLog` reads the separate Claude Code debug log, a different file).

### The tool-argument normalization canary

A `function_call` echoed back with the same `call_id` and `name` as the stored head that still
compares unequal is a candidate clodex normalization gap — `call_id` is the call's identity, and a
genuine rewind or branch regenerates the call under a new one. These record
`toolArgumentNormalizationGap` (`tool`, `equalAfterStrip`) on the head-decision diagnostic.

- **Only `equalAfterStrip: true` warns on stderr**, deduplicated by tool and hard-capped (the
  terminal is shared with Claude Code's UI). It means the two items are identical once the shared
  filler-strip rule is applied to `arguments` — nothing but filler stood between the head and its
  own echo.
- **Coverage is narrower than it looks, in two directions.** It fires only when the divergent
  `function_call` is the *first* divergent item, with one alignment: a stored reasoning item Claude
  legitimately omitted (`continuationMatch`'s omitted-reasoning mode) shifts divergence onto a
  reasoning-vs-call pair, and the canary re-aims at the first non-reasoning stored item so that
  omission cannot hide a fork on the very next call. Anything diverging earlier is what the mismatch
  reports, and the gap is never reached. And it detects only the fork half where the difference is
  filler the shared rule removes: if either side strips *more* than the rule does — a snapshot or a
  client over-stripping — the two remain unequal after it runs and land in the silent `false` bucket. The `parallel_isolated` arm does not
  warn. **Treat a quiet terminal as weak evidence, not proof.**
- `false` means the difference is one the rule cannot explain — a scalar/array/malformed `arguments`
  that `sanitizedCallArguments` deliberately passes through, a divergence in another field, or a
  genuinely different value — indistinguishable from legitimate divergence, so counted and never
  warned.
- The `required` sets used to judge the strip are those the head was snapshotted under
  (`headRequiredToolProps`), not the replaying turn's, so a mid-session tool-schema change cannot
  flip the verdict.
- On a turn where no head matches, **every** abandoned idle candidate passes through the warning
  path, so a regression on an older head cannot hide behind a newer head's ordinary mismatch.

The warning states the observation and asks for a report rather than naming a cause, since
`equalAfterStrip` cannot tell which side diverged. This exists because the originating bug was
invisible without `--trace` or `--ws-diagnostics` — it presented only as a quietly larger prompt and
took mining ~11k ledger records to find.

A reasoning item echoed back carrying the same `encrypted_content` as the stored head but still
failing to compare equal is a normalization gap, not a divergent branch. Those warn on stderr
(deduplicated and capped) and record `reasoningNormalizationGap` plus a `reasoningGapShape`
descriptor — summary/content element counts per side and the length of the consecutive same-blob
reasoning run. The shape distinguishes one upstream item split into several on the way back from a
single item that genuinely differs.

