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

The Anthropic translation keeps consecutive OpenAI reasoning in a single live thinking block,
with a self-contained signature envelope that restores individual summaries and encrypted items
on the return trip (see `translation.md`). Restored reasoning IDs are kept in outgoing requests
but omitted from comparison, matching the existing expected-assistant snapshot. Comparison still
accepts legacy histories that omitted earlier summaries when the encrypted content matches; this
compatibility rule is not permission to rewrite summaries in new upstream requests.

### Only a possible parent may force a request onto an isolated socket

An in-process Claude Code subagent forks the session and keeps the root session identity, so it sends
its parent's id in `X-Claude-Code-Session-Id` (verified in the 2.1.267 bundle; a separately launched
process has its own). One partition therefore holds many unrelated conversations at once. A request that matches no idle head is pushed to `parallel_isolated` — full
context, no head retained — only when some **in-flight** head could still turn out to be its parent:
`couldPrecedeThisRequest`. A head that has committed a response is tested with `continuationMatch`.
A head still streaming its very first response has no stored history, but it is not unknowable:
`entry.current.originalPayload` is the conversation it is generating *for*, and this request can only
be a later turn of that response if it carries those items as a prefix — `isPrefixOrEqual`, the
non-strict form, because a client that re-sent the identical turn is a duplicate of the response in
flight rather than a branch off it and must not be stitched onto a turn whose output it has never
seen. Two shapes therefore still isolate against an uncommitted head: an exact repeat of the turn
being generated (a client retry), and a request that extends it. Everything else — the sibling
subagent whose history diverges at the first item, which is what a fan-out produces — is no longer
blocked by THIS head, though pacing refusal or a transport failure can still cost it one. Note which
side is the candidate prefix: a request holding FEWER items than the turn in
flight, a rewind or an abandoned branch, cannot be a later turn of it, so the in-flight items are
tested as the prefix of the request and never the reverse. `inFlight` and `current` are set together at dispatch, so the `!current` fallback is for the
type rather than a state this predicate is reachable with; it blocks rather than guesses. Both the
arrival gate and the post-pacing re-check use the predicate, and the `ws_head_decision` records
`isolatedByConnectionId` naming the head that decided it.

Gating instead on "any head in this partition is busy" is expensive *cumulatively*: an isolated socket
retains no head, so the next turn of that same subagent isolated again for as long as anything in the
partition was in flight. In one frozen local ledger — 13,530 head decisions spanning
2026-09-10T03:17Z to 2026-09-11T06:53Z across 20 recorded Claude session ids — 3,995 decisions
(29.5%) were `parallel_isolated`. Their 3,775 recorded responses reported 202.7M uncached input
tokens, 96.9% of their input, against 4.2% for responses on continuation decisions. In **3,611 of
those decisions (90.4%) every recorded busy candidate diverged from the request in a `user`-to-`user`
comparison** — all 4,983 such comparisons — and those responses account for 196.0M of the uncached tokens. Multiple
heads per partition were already routine, and an idle head is already continued while a sibling
streams, so an unrelated busy head was never a reason to give up a chain.

That is observed traffic on one account, not a counterfactual: it does not say 3,611 isolations would
be *prevented*, nor that their tokens would be saved. A retained head cannot help the turn that
opened it, only a later turn of the same conversation.

Two measurement traps this section has already fallen into. **Freeze the file before counting** — it
is appended to live, and an earlier revision mixed figures read minutes apart into a ratio that did
not divide. **Count each response once**: 254 request ids here carry more than one head decision
(retries), so joining usage per decision double-counts the successful attempt and inflated these very
numbers by ~2.3M tokens.

**Connection pools are process-wide, not per-partition:** `maxConnections` (established, default 32)
and `maxNurseryConnections` (default 8). A head starts in the nursery and is promoted when selected
for its first continuation, before that continuation is known to succeed — so a workload whose
concurrent subagents inherit the parent's Claude session id, and therefore share one partition, can
lose heads before their next turn and with them the continuation.

**Keeping a fan-out's chains alive trades throwaway sockets for retained heads.** The mismatching
turn still opens its own socket; only a LATER turn of that conversation can reuse it. Of the 4,934
primary connection-creation decisions in the ledger above, 3,611 had final diagnostics in which every
recorded busy candidate showed a `user`-to-`user` divergence. Those are candidates for a different
decision, not proof that 3,611 live isolations are replaced — the diagnostic reflects mutable entry
state at emission time. Of the remaining 384, 319 recorded at least one busy strict-prefix candidate
and still isolate by design; 65 had no busy candidate left in the final diagnostic and cannot be
classified from this snapshot.

An isolated socket is never registered, so it never evicts anything, while a retained one runs
`evictOldestIdleGeneration` first, **so a newly retained sibling can displace an older idle head that
its own conversation was going to come back for.** That is reachable at the default nursery cap of 8:
seven idle heads from finished turns, an eighth conversation streaming its first response, and one
divergent sibling in that partition — the sibling is retained, the oldest idle head is evicted, and
resuming that conversation costs a fresh upgrade and a full-context resend. Constructed and observed
through the transport (nine sockets before this change, ten after), so the mechanism is established;
its frequency in ordinary traffic is not, and the cap replay below finds no eviction-caused loss
across the ledger's 27.6 hours — while also showing that at the default nursery cap the evicted head
had often been idle for only seconds.

**On a fresh pool, and for a fan-out whose members have distinguishable opening turns, it opened
fewer sockets** — it reuses instead of dialing. That is not a general result: a warmed pool whose
older conversations return is the case that can lose a head, and siblings that share an opening turn
still isolate by design. Four single-purpose servers built from pinned commits (endpoint mode,
`--no-discovery`, own port, freshly started, one leg at a time so each leg had the upstream account to
itself), 16 conversations x 4 turns started simultaneously against a real ChatGPT-OAuth model,
2026-09-11. `baseline` is 9bd5205, the commit that introduced the gate for *committed* heads;
`this change` extends it to uncommitted ones:

| leg | uncached input | client-visible failures | sockets opened | paced: admitted / refused | gauge peak nursery/established | `*_lru_cap` evictions | `parallel_isolated` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline, caps 32/8 | 74.8% | 1 (pacer 429) | 50 | 38 / 36 | 1/6 | 0 | 42 of 61 |
| this change, caps 32/8 | 47.6% | 0 | 17 | 6 / 1 | 11/16 | 0 | **0 of 65** |
| baseline, caps 64/24 | 82.0% | 0 | 52 | 42 / 35 | 1/6 | 0 | 44 of 64 |
| this change, caps 64/24 | 32.8% | 0 | 16 | 6 / 1 | 11/16 | 0 | **0 of 64** |

Sixteen conversations, sixteen sockets, one head each; all 48 later turns continued. Zero
`*_lru_cap` evictions on any leg. **Read the socket and decision columns, not the token
percentages** — an earlier run of the same four legs gave 78.5 / 40.2 / 73.0 / 31.1, and the two
cap settings differ by 9 points on identical workloads, so the token share carries upstream
cache variance this experiment does not control. The decision counts are a consequence of the
code AND of the workload's shape: these 16 conversations had distinct opening turns, which is
what makes them distinguishable; 16 siblings sharing one opening turn would still isolate, by
design.

Two things the table must not be read as saying. The baseline's single client-visible 429 is one
observation in one cell — the baseline's other leg had none despite 35 refusals — so it does not
establish that this change removes 429s, only that this change asked the pacer for an order of
magnitude less. And the gauge columns are the counts recorded *in* the decision diagnostic, which
is emitted before the new entry registers; actual nursery occupancy peaked one higher (4, 11, 2, 11).
Note nursery reaching 11 against a cap of 8 at all: eviction only considers IDLE entries, so a cap
is not a ceiling while every head in that generation is busy.

Legs were run one at a time on freshly started servers so that no other *diagnostics-enabled*
clodex process was competing for the account; an external client or a process without diagnostics
would be invisible to that check.

**A retraction, because this section previously predicted the opposite.** An earlier run of the
lineage gate recorded 14 `established_lru_cap` evictions, every one on a promoting decision with
`establishedConnectionCount` at exactly the cap — which reads as the change causing eviction
pressure. That server had accumulated 30 established heads from four prior runs still inside their
30-minute idle TTL. On a fresh process at the same caps there are none. Long-lived servers do
accumulate, but do not read a cap-sized pool at the start of a measurement as a result of it.

**Comparing against an in-flight turn is memoized per response, not per lookup.** Canonicalizing a
whole conversation is the one cost this check adds, and a wide fan-out would otherwise pay it once per
arriving sibling per busy head — measured at 13.6ms per arrival across 16 in-flight heads holding
11.7MB, against 0.4ms memoized. `RequestContext.canonicalInput` caches it; `originalPayload` is
assigned once at construction and never reassigned (a transport retry resets `sendPayload` back to it
and reuses the same context), so the memo has no reachable staleness. The cost it trades for is
retained size: the canonical strings run about as large as the payload, so an in-flight head holds
roughly twice its context until the response completes. This mirrors `canonicalPrefix` on the
committed path, which has the same property. A stale memo could only mis-decide isolate versus
don't-isolate — the committed history that drives `previous_response_id` is recomputed from
`originalPayload` and never reads it.

**Cap enforcement touches BOTH pools, at two different moments.** Creating a retained head calls
`evictOldestIdleGeneration('nursery', maxNurseryConnections, 'nursery_lru_cap')` first; when that head
is later selected for its first continuation, `continueOnHead` calls
`evictOldestIdleGeneration('established', maxConnections, 'established_lru_cap')` before promoting it.
Either call removes an entry only when that generation is at or above its cap AND has an idle entry —
neither is an unconditional eviction. The entry displaced is the oldest idle one in that generation,
which could be a large long-lived conversation that then resends full context. Watch
`established_lru_cap` alongside `nursery_lru_cap`.

**No cap setting changed head reuse in this ledger, but the margin at the default is thin.**
Replaying the ledger's decisions through a pool model — one head per *content key* (partition plus
first-input-item hash, which is a transport-and-content heuristic, NOT a conversation id), promoted
on first reuse — gives **92.9% key recurrence (12,307 of 13,245) at every cap pair tested**, from
8/32 to unlimited. Misses are 938: 935 keys seen for the first time, which have no head by
definition, plus 3 returning after a TTL expiry. **No miss at any tested cap was caused by an
eviction.** Collapse the 285 duplicate decisions that retried request ids contribute before counting
any of this — the undeduplicated figures are 91.8% and 1,111, and this document warns about exactly
that trap two sections above.

What the model does show is how little headroom the default leaves. The LRU victim is the oldest
IDLE entry, and at nursery 8 it had been idle a median of 26 seconds and as little as **8 seconds**,
against an inter-turn gap distribution of p50 5s / p90 20s / p99 63s. 85 of the 268 nursery
evictions displaced a head idle for less than the p90 gap. None of them was in fact reused, so this
ledger records no loss — but "was not reused" at 8 seconds idle is luck, not margin. Raising the
nursery cap moves the victim out of that distribution: at 16 no victim is below the p90 gap, and at
48 none is below the p99 gap.

Counts and reasons at 8/32 are 268 nursery plus 53 established evictions; at 24/64, 231 nursery and
none established; at unlimited, none. Only cap pairs were simulated, not measured, and the model
cuts both ways rather than being uniformly conservative: it lets in-flight heads be evicted, which
the real pool forbids, but it also assumes every attempt yields an immediately reusable head and
collapses a conversation's branches into one key.

**What that ledger's own gauges looked like, pre-change, on caps of 64/24:** pooled connections p50
16, p90 23, p99 27, max 31 (unweighted per decision); nursery peaked at 24, its cap, with 10
`nursery_lru_cap` evictions; established peaked at 28 of 64 with **zero** `established_lru_cap`
evictions. So in this ledger the pressured pool was the nursery, not the established one.
`activeConnectionCount` equals nursery plus established on all 13,530 records, so isolated sockets
are invisible in it and the true socket count was higher whenever one was open.

**Held connections do NOT have an established relationship with upstream errors here, and an earlier
revision of this section claimed they did.** Bucketing the ledger's 13,524 upstream-attempt outcomes
by the pooled-connection count at the nearest preceding head decision gives 2.96% / 3.29% / 3.34%
below 25 connections and 114 of 630 at 25 or more. That last bucket is one incident: all 114 errors
fall inside a **5.8-minute window**, where the rate was 114/147; across the other 483 outcomes at 25+
connections the rate was **zero**. The errors also began below 25 connections and preceded the pool
climb. Treat the gradient as an artifact of that incident, not a cost of holding connections. (The
join is also a global latest-gauge proxy rather than a per-request measurement.) What does survive:
41 of the 44 upgrade rejections — HTTP 429 at the upgrade, from 13 request ids, all of which later
succeeded — occurred at 20-24 pooled connections, so *dialing* under load is throttled, which is
what the pacer is for and which this change reduces.

An idle nursery head is exposed until its connection is **selected** for its first continuation, which
is when promotion happens — before that continuation is known to succeed. Nursery membership is a
property of the current connection's reuse history, not of the conversation's age: a long conversation
that just took a replacement head after a mismatch or an expiry is in the nursery too (this ledger
holds 58 new nursery heads whose input already carried several user messages, the largest 529 items).
Note also that eviction only considers IDLE entries, so while every nursery head is busy the cap
cannot be enforced immediately. Override via `CLODEX_WS_MAX_CONNECTIONS` /
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
ALREADY has an established or nursery head to reuse when it arrives never consults it, so pacing
never adds latency to a continuation it could have made on arrival, and the two replacement paths
below are exempt by design. The one continuation that does pay is the one that could not have been
made on arrival: a request admitted after queueing may find a head freed during its wait and
continue that instead (see below), in which case it waited for a connection it then did not open
and hands its token back.

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
rather than failing it, with a notice. That is the same rule the zero-bound case already used. It
avoids guaranteed local failures while retaining bounded opening-burst shaping, **at the cost of
relaxing the configured ceiling** — which is what is actually given up here. The user configured a
connection rate, not a latency, and the fallback mostly adds no latency: at 1/minute with 20
simultaneous requests, 19 are admitted immediately, one waits out the bound and none is refused.
A separately budgeted hint would be a reasonable follow-up.

Because the head scan runs before the wait, an admitted request re-reads the clock and reaps
whatever expired while it was queued, then re-evaluates the partition before it opens anything.

**A request that was actually QUEUED runs the head scan a second time**, because a sibling may have
FINISHED during the wait and left an idle head it can continue. Without that it would open a
duplicate head for a chain sitting right there — filling the nursery, evicting other conversations'
heads and forcing the full-context resends that open still more connections. The second scan is the
first one, unchanged: the same exact-prefix `continuationMatch`, the same tie-breaks, so a freed
head whose lineage does not match is still not continued. Adopting a head restores exactly the state
an arrival-time match would have left, including the persistence a transport-retry replacement
inherits, and RETURNS the pacing token the request was charged — it opened no connection, so
holding it would delay the next request for an upgrade that never happened. The scan is skipped for
a request admitted on arrival: it resumes in the same microtask turn, and a head can only be freed
by an upstream completion, which arrives on a socket event. The gate reads the pacer's `queued`
flag, not `waitedMs`, which is a difference of two clock reads and reports zero for a genuinely
queued request when the clock steps backwards. Nothing between that scan and the dispatch that
claims the head awaits, so two queued requests cannot both adopt one freed head.

**What makes this reachable at all is that `expectedAssistant` can be EMPTY.** A match needs the
head's stored `requestInput ++ expectedAssistant` to be a strict prefix of the waiting request,
which reads as though the waiter must already hold the head's output — something two independent
agents never have. But a response that completes with no output items stores a prefix equal to its
own input, and `continuationMatch`'s guard is `!entry.expectedAssistant`, which `[]` passes. Two
subagents fanned out from one Claude session open with byte-identical inputs, so the second can
extend the first's prefix having copied nothing from it.

**How often that happens is not known, and the available diagnostics cannot say.** The necessary
conditions are enumerable — a predecessor leaving a *reusable* head (a nursery creation or a
continuation; a `parallel_isolated` socket is discarded and leaves nothing), that head's input
being a strict prefix of the waiting request's, it completing inside the waiter's queue wait
(4,833ms at the shipped defaults), and the waiter having matched nothing on arrival — and no
qualifying opportunity appears anywhere in the local corpus (17 ledger files, 178,298 head
decisions, 63,508 primary creations). But that corpus records **zero pacing events and zero
decisions carrying `pacingWaitedMs`**, so it contains no queued requests at all and therefore
supports no rate for this: there is no denominator. Do not convert the zero into a frequency.
Note also that `ws_new_connection_paced` is emitted only on a nonzero wait, a refusal or an abort,
so its absence is not evidence that pacing did not engage — replaying real creation timestamps
through the shipped bucket predicts 1,686 waits and 1,590 refusals in one of those files.

**Boundary, deliberate:** the second scan cannot undo an ARRIVAL-time `parallel_isolated` demotion
when the partition simply goes quiet during the wait. Such a request already has `persistent` false
and, absent a re-match, keeps it, so it opens an isolated socket that retains no head at all.
Isolated sockets were 30-38% of decisions in busy diagnostics files before the lineage gate above
narrowed which of them qualify — a larger share of the same harm than the case this closes. Under
that gate a simultaneous 16-way fan-out produced none at all, so what remains of this boundary is
the retry and extension shapes rather than ordinary fan-out traffic.

Failing a re-match, an admitted request still demotes itself to `parallel_isolated` if a
same-partition request that could be its parent went in flight meanwhile — otherwise two requests
would each register two retained heads for one chain — the invariant being kept is one head per
chain, not one socket per response. The
duplicate this guards against is a second head for ONE conversation, which is what
`couldPrecedeThisRequest` describes. A head busy on a different conversation is not a duplicate of
anything and does not demote — including a brand-new sibling that has committed nothing, whose
in-flight items are compared instead. What reaches this branch is a request that exactly repeats or
strictly extends the turn being generated; an exact repeat is what a client retry produces, though
the shape alone does not establish the cause. That check is unconditional; only the re-match is gated
on having been queued.

Diagnostics: a `ws_new_connection_paced` event (`outcome` of `admitted`, `refused`, or `aborted`,
with `waitedMs` / `requiredWaitMs` / `retryAfterSeconds`) and `pacingWaitedMs` on the same request's
`ws_head_decision`. A request that waited also carries `pacingRescanOutcome` — `continuation` when
the second scan adopted a freed head, `parallel_isolated` when the in-flight demotion decided it,
`no_change` otherwise — so the ledger distinguishes a decision the second look changed. A queued
request whose clock stepped backwards carries `pacingRescanOutcome` with no `pacingWaitedMs`. When it
adopts a head, `candidateCount` / `idleCandidateCount` / `matchingCandidateCount` / `heads` report
the partition as re-scanned; otherwise they remain the arrival scan's, so a head that appeared or
was reaped during the wait shows up only in the pool counts. Requests admitted on arrival record
nothing. A request cancelled while queued returns its reservation and opens no connection.

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
estimated from the SDK's fallback exponential backoff. Without a retry hint, five retries can add
roughly 62s of fallback backoff on a dead provider, versus roughly 6s for the SDK's former two-retry
default. That fallback budget gives a transiently unavailable provider more time to recover. When
OpenAI explicitly states an acceptable delay for a WebSocket throttle, clodex gives that value to
the SDK instead of its fallback schedule. Clodex's existing 5s default remains a client-facing hint
for upgrade 403s and WebSocket connection-limit errors that state no delay; it is not promoted into
the SDK's retry loop. Other hintless 429s also retain the fallback schedule. A long accepted
upstream delay can replace an early fallback rung and consume more of the request budget, so fewer
retries may begin before the streaming idle deadline; the stream's shared signal requests
cancellation when that deadline expires.

Provider-utils snapshots Response headers when `fetch` resolves, before an asynchronous WebSocket
failure supplies its throttle hint. The transport therefore preserves the hint's source and raw
upstream value in the synthetic error's string `param`, which survives the OpenAI stream schema.
`trackUpstreamAttempts` restores only an upstream-stated safe hint into the captured `APICallError`
header record before the SDK selects its retry delay. A clodex-defaulted marker is deliberately
ignored. Restoration never replaces an existing `retry-after` or `retry-after-ms`,
even when that existing value is malformed; for values the SDK can parse, `retry-after-ms` takes
precedence. Restored second-based hints cap at 59s so acceptance does not depend on the current
fallback rung. An upstream value above clodex's 60s client-facing cap remains in diagnostics but is
not promoted into repeated in-process waits. A deadline during retry
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
- **A turn that reaches the mismatch branch rather than `parallel_isolated` passes every abandoned head
  through the canary** — including other conversations' heads once a fan-out keeps them. The identity
  gates still apply: a tool warning needs both items to be `function_call` with the same non-empty
  `call_id`, the same string-valued `name`, and `equalAfterStrip === true`; a reasoning warning needs two
  reasoning items with the same non-empty `encrypted_content` plus a remaining normalized difference.
  Where independently generated items carry distinct identities these gates exclude them, which reduces
  unrelated-head noise — but that is **not** proof against a false warning, because a shared or copied
  history can carry one item identity into more than one request. No such occurrence has been observed.
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

