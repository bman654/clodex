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

### Pacing new connections

`src/oauth/ws-upgrade-pacer.ts`. OpenAI's edge rejects a WebSocket upgrade with HTTP 403, and in the
traffic sampled below those rejections clustered in the minutes that opened the most new
connections. The rejection is handled (see below) but the rate was previously unlimited. That the
rate is what the edge reacts to is this module's working assumption, not a demonstrated cause. A process-wide token bucket now gates **primary connection creation** — a request that
reuses an established or nursery head never consults it, so pacing can never add latency to a
continuation, and the two replacement paths below are exempt by design.

Defaults: 60 new connections per minute sustained, burst 10. Override the rate with
`CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN` (integer 1-600; `0` disables pacing, values above 600 clamp,
malformed values are reported once and ignored). The bucket is shared process-wide for the same
reason the pools are: the server holds a separate transport per model, so a per-transport bucket
would multiply the rate by the number of models in play. What the throttle is scoped to is not
known — one account on one machine cannot tell an account-, IP-, model- or edge-level limit
apart — so one shared bucket is the conservative reading, not a modelled one.

**Overflow is refused, not delayed indefinitely.** A request the rate cannot serve within the wait
bound gets the same retryable 429 frame shape the upgrade 403 produces — `code: '429'` plus the
load-bearing `retry after Ns` prose — and the AI SDK backs off and retries it. Admitting anyway past
the bound was tried first and does not work: with the bound doubling as the debt floor, sustained
output settles at exactly the offered rate delayed by the bound, so an 82/min fan-out still went out
at 82/min. Refusing sheds the overflow instead, so the rate of *admissions* is capped. It is not
free: the refused request returns through the SDK's retry ladder, and that backoff runs *inside* the
same no-data deadline a queue wait spends — which is why the bound below budgets the whole ladder
rather than one wait.

**With `CLODEX_UPSTREAM_MAX_RETRIES=0` the pacer cannot refuse** — the SDK rethrows before consulting
`shouldRetry`, so a refusal would be an immediate hard failure. In that mode it shapes the opening
burst (`burst + bound x refill`, 25 connections at the defaults) and then stops delaying anything at
all. **That is not a safety guarantee, it is limiting switched off past the floor**: sustained
traffic is unshaped, exactly as it would be with pacing disabled. Delaying every request by the
bound instead was measured to shape nothing — sustained output simply equals sustained input,
late — so it taxes the user for no benefit. The burst is kept because the burst is the part that
correlates with rejection.

**What pacing costs.** One new connection per second is an aggregate ceiling, not a per-request
delay. By Little's law, N agents that each need a new connection per turn settle at roughly N
seconds per turn once the burst is spent: about 20s per turn at 20 agents against ~3s unpaced. The
trade is throughput for a lower chance of tripping the throttle, and it is the point of the feature
rather than a side effect. It is a reduction in risk, not a guarantee: the causal link is assumed
(see the scope note below), and a fan-out large enough to exhaust the bound is refused by the pacer
itself, which the client sees as a rate limit.

**A refusal debits nothing.** That is what makes the retry ladder safe — a refused request opens no
connection and will be retried, so charging it a token would let each retry deepen the deficit that
caused the refusal. Because only an admitted request debits, and only within the bound, `tokens`
cannot fall below `-bound x refill`: the queue is bounded by construction and admissions in any
window stay within `burst + bound x refill + rate x T + cancellations` however many retries arrive.

**That bounds admissions, not sockets.** Both replacement paths — a transport retry and a
`previous_response_not_found` retry — build their connection through `createReplacement`, which does
not consult the pacer, so connections opened can exceed admissions granted. A cancellation likewise
refunds its token without rescheduling the reservations queued behind it, so each one permits one
extra admission at that instant.

**The wait bound is derived, not chosen.** Every attempt of one request shares ONE no-data deadline
(the timer starts before the SDK call and only a stream part resets it), so the whole ladder must
fit: `(maxRetries + 1) x bound + totalBackoff < idleTimeout`. At the default 120s deadline and five
retries the backoff ladder alone is 62s and the bound works out at ~4.8s; a flat 15s would instead
let six attempts plus backoff reach 152s against 120s.

**Both terms are read, not assumed.** Every term of that inequality is user-configurable
(`CLODEX_UPSTREAM_IDLE_TIMEOUT_MS`, `CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS`,
`CLODEX_UPSTREAM_MAX_RETRIES`) and they interact — a shorter deadline lowers the retry ceiling — so
the pacer resolves them together through the same `upstreamRequestBudget()` call every SDK
generation entry point makes, and sizes its bound against the deadline the paced request will
actually spend. No production caller overrides `idleTimeoutMs` on that call, so the two resolve
identically. Hardcoding either term would leave the bound correct only at the default
configuration.

The inequality holds strictly for every resolvable configuration rather than by coincidence at one
of them: pacing takes at most half of what the ladder leaves, so `attempts x bound + backoff <=
(idle + backoff) / 2 < idle` whenever `backoff < idle`, and `upstreamRequestBudget` guarantees that
side condition by capping `maxRetries` at the largest ladder fitting the resolved deadline. Where a
configuration leaves too little room — the extreme being a deadline barely wider than its own
backoff ladder, e.g. `CLODEX_UPSTREAM_IDLE_TIMEOUT_MS=14001` — the bound floors to zero and the
pacer disables itself with a notice, since refusing everything past the burst would be worse than
not pacing. It degrades to less pacing, never to a request pushed past its deadline.

**The backoff ladder is NOT an upper bound on the pacing case.** `getRetryDelayInMs` SUBSTITUTES a
supplied `retry-after` for its own rung rather than taking the larger of the two, and a refusal
carries one. So the gap between paced attempts is the hint, and since the hint is capped at the
bound — which can exceed an early rung, 15s against a 2s first rung — a paced gap can be longer
than the rung it replaced. The conservative term is the per-gap maximum:

    (maxRetries + 1) x bound + SUM_i max(cappedHint, rung_i) < idleTimeout

That is the property the tests assert across the resolvable space. `wsNewConnectionMaxWaitMs`
budgets the ladder alone; the halving is the slack that keeps the stronger inequality true, and
that is measured rather than argued.

**An uncapped hint was a real defect, and capping it created a second one.** The hint used to be
the raw token deficit, so a 30s hint could be spent inside a 10s deadline: the request died having
made one attempt, with its remaining retries never run. Capping the hint at the bound fixed that
and broke low rates in the other direction — at 1/minute the first token is 60s away while six
attempts ~4s apart are all spent inside 20s, so every refused request exhausted its retries before
a token could exist. Measured at 1/min and 2/min: 10 of 10 refused requests terminal.

**That is a trade-off, not an impossibility** — an earlier draft of this section claimed no hint
strategy could fix it and was wrong. A separately budgeted 12s hint does reach the 1/minute refill
(attempts at 0, 12, 24, 36, 48, 60s) and still fits the conservative mixed-gap bound:
`6 x 4833 + max(12,2) + max(12,4) + max(12,8) + max(12,16) + max(12,32) = 112,998ms < 120,000ms`.
What is true is narrower: no strategy admits ALL the overflow inside the deadline while preserving
the configured ceiling, because at 1/minute ten simultaneous overflow requests need ten minutes of
capacity.

So **the pacer refuses only when its retry schedule can outlast the wait for a refill**
(`canRefuseAtRate`); below that it shapes the opening burst and then admits the remaining overflow
rather than failing it, with a notice. That is the same rule the zero-bound case already used, and
it is chosen because it spends the shortfall on latency the user configured rather than on errors.
A separately budgeted hint would be a reasonable follow-up.

Because the head scan runs before the wait, an admitted request re-reads the clock, reaps whatever
expired while it was queued, and demotes itself to `parallel_isolated` if a same-partition request
went in flight meanwhile — otherwise two requests would each register a persistent nursery head for
one key and a fan-out would evict other conversations' heads.

Diagnostics: a `ws_new_connection_paced` event (`outcome` of `admitted`, `refused`, or `aborted`,
with `waitedMs` / `requiredWaitMs` / `retryAfterSeconds`) and `pacingWaitedMs` on the same request's
`ws_head_decision`. Requests admitted on arrival record nothing. A request cancelled while queued
returns its reservation and opens no connection.

The numbers come from re-reading one machine's `ws_head_decision` log (103,698 records over about a
day and a half), bucketing records that carry a `createdConnectionId` by wall-clock minute. Every
upgrade 403 fell in three minutes, and 39 of the 40 fell in two minutes that each opened 82 new
connections; across the 1,158 minutes that opened any connection the median was 6, the 90th
percentile 22 and the 99th 48, and four exceeded 60.

**Scope of that measurement**, so it is not over-read: one account on one machine, one contiguous
window of roughly a day and a half, counted by the `ws_head_decision` predicate
`createdConnectionId != null`, which counts PRIMARY connections only — replacements never emit a
head decision, so they are absent from every figure above. It is a correlation, not a published
limit and not a demonstrated cause, which is why the default is conservative and tunable. The replacement connections
are deliberately **not** paced — both the transport retry and the `previous_response_not_found`
retry: each recovers a request that was already admitted, each is capped at one per request, and
both are built inside socket callbacks where an await would restructure the retry path.

### Upstream timeouts and retries

Every AI SDK generation entry point, for both Anthropic- and OpenAI-format routes, resolves one
budget through `src/upstream-retry.ts`. `streamText` consumers abort their SDK controller at the idle
and total deadlines; true `generateText` consumers abort at the total deadline only because they
expose no stream event that could reset an idle clock. Cancellation is cooperative, so a provider
transport that ignores the signal can settle later. The idle default is 120s (range 10s–1h), and the
total default is 10m (range 1m–6h). Each provider call gets a fresh total timer, including a new call
after an OAuth 401 refresh; it is not an end-to-end route deadline. An explicit total wins when the
pair conflicts, lowering the idle value; when only an idle value exceeds the default total, the total
rises to match. Malformed values fall back safely, out-of-range values clamp, and each problem emits
one parent-terminal notice. Raw relays are not SDK generations and receive neither timeout.

SDK generation entry points retry transient provider failures up to five times by default and resolve
`CLODEX_UPSTREAM_MAX_RETRIES` through the same budget. Valid non-negative integers override the
default; unset or malformed values preserve it. The default and ceiling fall with a shorter idle
timeout. At the default timeout the ceiling is five, and the configured range permits at most ten,
estimated from the SDK's fallback exponential backoff. Five retries can add roughly 62s of fallback
backoff on a dead provider, versus roughly 6s for the SDK's former two-retry default. Provider retry
hints and failed-attempt time can mean fewer retries begin before a streaming idle deadline; the
stream's shared signal requests cancellation when that deadline expires. A deadline during retry
backoff preserves the provider failure that prompted the retry, while a deadline during a silent
active provider call remains a timeout. Proxy mode's raw HTTP MITM path shares the retry setting but
retains its independent ceiling of five and one-retry default; other direct raw relays add no
transport-failure replay, although an OAuth 401 refresh can still start a new authenticated call.
**This policy can recover only while no model output has been exposed downstream**; replay after
partial output could duplicate content or tool calls.

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

