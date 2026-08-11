# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and for anyone — human or agent — changing this repo.

**clodex** bridges Claude Code to OpenAI models — OpenAI API key (`openai`) or ChatGPT/Codex-plan
OAuth (`openai-oauth`). It is a trimmed fork of relay-ai (full commit history preserved).

**Prime directive.** The translation, caching, auto-compaction, and OAuth-continuation code encodes
real production failures that are not visible in the diff. Prefer surgical changes over
restructuring.

**Where things live:** [`CONTRIBUTING.md`](./CONTRIBUTING.md) has the rules, toolchain, and
commands. [`RELEASING.md`](./RELEASING.md) has release mechanics (maintainers only). This file has
the architecture, the reasons behind the invariants, and the verification standard below.

Commands CONTRIBUTING does not list: `clodex patch` (patch the Claude Code binary — see
[Patcher](#patcher)), `clodex providers`, `clodex favorites`, and the second bin `clodex-claude`
(launch claude bridged to an already running clodex server). Dispatch for all of them is in
`src/cli.ts`.

---

# Verification standard

Review holds changes to a higher bar than "the suite is green." Across ~100 merged and closed PRs,
three failures dominate — in this order. They are what most review rounds are spent on, and every
one of them is preventable before opening.

## 1. Tests must discriminate. Green is not evidence.

The single most common defect. Tests pass; the behavior they claim to pin is absent, unreachable,
or staged in a state production can never produce.

**The acceptance test: delete the feature and run the suite.** If nothing turns red, the tests are
theatre regardless of how many there are. One detector shipped with tests staging the scenario in a
data region the detector never touches — deleting the entire feature left **85/85 green**, and the
detector was dead in production.

- **Run the full file, not `-t` isolation** — they disagree, and CI runs the file. A test has
  passed in the full run and failed under `-t`.
- **Stage state through production producers.** For chain/head/normalization work, emit the item
  via `response.output_item.done` into the expected-assistant history; never plant it directly in
  the request input. That region is kept verbatim and can never diverge, so a test staged there
  passes no matter what the code does. This defect has now been seen twice.
- **Mutate each independent guard and precedence branch**, not just the happy path.
- **Include over-scope and under-scope negatives** — prove the change does not fire where it
  shouldn't.
- **Never accept the sha256 source-digest pin as the failing test.** It is a tripwire, not a
  behavioural test. A mutation that broke a real bridge leak passed **1329/1330** with the digest
  pin as the only red. If the pin is the only thing failing, the behaviour is unpinned.

## 2. Claims must not outrun evidence.

The second most common defect, and it is calibration, not dishonesty. Prose in the PR body, commit
message, test name, or doc asserts more than what was actually observed.

- **Label inference as inference.** Every categorical claim maps to a source fact, an authoritative
  contract, or an executed observation.
- **State the environment each measurement was taken in.** A green suite in a bridged shell proves
  nothing unless the ambient proxy is dead. Use an isolated `CLODEX_HOME`; disclose node version and
  proxy vars.
- **Re-measure baselines against current `main`.** A stale baseline reads as a regression.
- **Beware measurements that match themselves** — `ps -eo … | grep <pattern>` matches its own
  command line, which has produced false orphan counts twice.
- **Don't inherit claims from existing comments or docs.** A wrong comment in this repo was copied
  faithfully into a contributor's PR; we nearly asked him to fix our bug. If you repeat an existing
  claim, verify it.

## 3. Reachability decides severity.

A finding must name **who triggers it** and **what they must already control**. A mechanism you can
execute in a test but cannot reach from a real, supported configuration is hardening — say so
explicitly and give it no severity. If it requires compromising a host that already holds the
credential, the reachability is nil.

This repo is a trimmed fork, so **some code is vestigial** — it supports providers and options that
no longer ship. A fix to an unreachable path passes review and CI while the real bug survives. Two
PRs were closed on exactly this ground.

Before implementing, record: the user-visible symptom; the supported configuration and route; the
production callers from external input down to the branch; a real reproduction or wire capture; and
the alternative explanations you ruled out.

## Claims about Claude Code's own behavior come from the binary

Never from docs, comments, or a subagent's summary. Extract the bundle using clodex's own tweakcc
dependency (`tryDetectInstallation({ path })` → `readContent`) against a pristine
`~/.tweakcc/claude-<ver>-<hash>.orig`. Raw byte greps do **not** work — the bundle is compressed
inside the native binary. The script must live inside this repo so `node_modules` resolves.

Then **enumerate every branch of the function yourself.** Shipped bugs have come from reading the
two gates that happened to be visible. Grepping one syntactic form of a comparison is not an
enumeration — grep the *value*.

## Pre-PR gate

Ordered by how often each would have caught a real finding.

1. **Feature-deletion mutation**, full-file run. Mandatory for any detector, guard, canary, or
   warning.
2. **Enumerate sibling shapes of the same signal** and say which you checked. Four follow-up-fix
   chains exist because a fix was written against the one captured example rather than the class —
   same signal, different arrival point.
3. **Mode matrix, not a single path.** proxy × endpoint × interactive × background-agent, whenever
   `launch.ts`, `env.ts`, `claude-wrapper.ts`, `proxy.ts`, or the gateway is touched. Interactive
   sessions have hidden a bug that broke every background agent session.
4. **If the deliverable is user-visible output, run the real user command and read the actual bytes
   on fd 1/2.** Assertions against a test-framework-replaced `console` cannot measure this. Capture
   a real Claude Code session under `tmux` for terminal output.
5. **Trigger every new failure path** rather than reasoning about it — dead pipe, missing binary,
   malformed env value, hostile control characters. Verify that any fallback a comment claims can
   actually run.
6. **Resource-delta check** for anything creating temp dirs, files, processes, or listeners. A
   test-sandbox change leaked one directory per test file; 2467 had accumulated before it was
   found.
7. **Doc accuracy sweep.** Grep this file, README, `docs/`, and `cli.ts` help strings for every
   symbol, flag, and env var in the diff, and re-read for *accuracy and scope* — not just presence.
   Overstated coverage claims go stale silently.
8. **Rescue-path check.** Enumerate the degraded and recovery paths (`--restore`, fallbacks, offline
   modes) that must keep working when your new invariant's precondition is unavailable.
9. **Concurrency check.** `git log main --since=<branch-cut> -- <touched files>` and `git merge-tree`
   against current `main`; state which open PRs touch the same region and the intended land order.
10. **Hostile composition.** `CLODEX_HOME="$(mktemp -d)" pnpm test`, plus a write-path tripwire —
    `os.userInfo().homedir` ignores both `CLODEX_HOME` and `$HOME`.
11. **Standard gate:** `pnpm typecheck && pnpm test && pnpm build`. Necessary, never sufficient.

**When a change touches a launch path, smoke test the product, not just the path you changed.**
Launch real Claude Code through clodex on the default proxy mode against *both* an OpenAI model
(translated) and an Anthropic model (passthrough). A shared-code change — error formatting, status
mapping — can be fine on one and broken on the other. Add an `--endpoint` leg when the change
touches `buildChildEnv` or the gateway. Curl against
a running server is a fallback, only for wire shapes the client will not produce.

**A change made after review earns a new review**; a redesign earns a fresh one, not a re-read. And
"not a regression versus `main`" does not excuse shipping a broken guarantee — if the change exists
to make a class of failure unreachable, judge it against that goal, not against the status quo.

## Scope

Code-level surgery is generally done well here; **PR boundaries** are where scope actually goes
wrong — three separate PRs were once consolidated because each recut the same subsystem. The
boundary rules are in [CONTRIBUTING](./CONTRIBUTING.md#scoping-your-pr). Two things it does not
cover:

- The change should serve clodex's mission, not be a general Claude Code modification. A permanent
  patch site for behavior outside that mission is out of scope.
- Prefer source files under ~750 lines; consider splitting when adding to one already over, so
  independent work does not collide. This never licenses restructuring the do-not-restructure files
  below.

---

# Release notes are written for users

**Generated changelog entries come from commit summary headers only — never bodies.** Your summary
text is what every user reads: release-please renders `type(scope): summary` as a bullet with the
scope bolded and issue/commit links appended, but the summary text itself is carried through
unchanged. Get it right; nobody polices commit-body wording, because it reaches no user-facing
surface. (The one hand-written entry, 0.1.0, predates this and is preserved as prose.)

Today most summaries fail. Reviewing the 60 generated entries in `CHANGELOG.md` against the rules
below, **44 were judged unreadable to a non-technical user** and only 2 clearly passed. That
judgment is a review assessment, not a measurement — but the direction is not in doubt.

**Write the summary line for someone who uses clodex and has never read the source.** It must say
what they can now do, what they stop seeing, or what got more reliable.

Testable rules:

1. **Name the user-visible outcome**, not the mechanism. Replace `canonicalize`, `replay`, `strip`,
   `snapshot`, `serialize` with what the user notices.
2. **Say why it matters** — a concrete "so", "to prevent", "to avoid", or equivalent.
3. **No internal vocabulary without a plain-language gloss**: module names, symbols, protocol
   fields, `function_call`, `heads`, `nursery`, `canary`, `pty`, `stderr`, `previous_response_id`,
   `store:false`, `cache_control`.
4. **No implementation-only detail** — hash formats, dependency versions, test/CI fixes — unless
   tied to a visible install or runtime result.
5. **Self-contained.** The reader should not need the issue, the body, or the code.
6. **The 10-second test:** could a non-technical user explain the problem solved and decide whether
   they care, from this line alone?
7. Conventional-commit form, lowercase imperative, **whole line ≤ 100 characters**.

| Don't | Do |
| --- | --- |
| `fix(oauth): snapshot function_call arguments in the sanitized downstream shape` | `fix(oauth): keep tool arguments consistent so conversations continue reliably` |
| `feat(oauth): omitted-reasoning alignment and abandoned-head canary coverage` | `feat(oauth): keep long conversations working when reasoning details are omitted` |
| `fix(reasoning): suppress reasoning.summary for gpt-5.3-codex-spark` | `fix(reasoning): prevent blank responses on gpt-5.3-codex-spark` |
| `fix(proxy): isolate bridge settings from child commands` | `fix(proxy): prevent nested Claude commands from using a stale clodex connection` |
| `fix(patcher): include transform-set version in patch config hash` | `fix(models): detect patch updates so new model settings take effect` |

Prefer a scope a user recognizes (`auth`, `models`, `launch`, `images`) over one that only names an
internal module (`adapter`, `transport`, `sdk`) where you have the choice.

Hard-wrap commit bodies and footers at **≤100 characters per line** — commitlint's
`body-max-line-length` is enforced by the Husky hook and again on every push to `main`.

## PR descriptions

**The first paragraph is for a clodex user, not a reviewer.** Plain language, no jargon: what was
broken or missing, and what is different now. Someone who only reads that paragraph should
understand the purpose of the PR.

Everything after it is for reviewers and may be as technical as needed. Cover, in order: the
user-visible failure; root cause and production reachability; the change and what you deliberately
left out; the discriminating tests and mutations you ran; real runtime evidence with the environment
it was measured in; assumptions or boundaries you could not verify; and failure/rollback behavior.

Stating what you could *not* verify is a strength, not a weakness — the best PRs in this repo's
history do it routinely.

---

# Architecture

**Entry points:** `src/cli.ts` — arg parsing (`parseArgs`, `consumeBridgeModeFlag`), help texts, and
dispatch for `claude`, `server`, `models`/`favorites`, `providers`, `patch` — and
`src/claude-wrapper.ts` (the `clodex-claude` bin). Every other module is a focused unit with no
side effects at import time.

## Two bridge modes

Both `clodex claude` and `clodex server` support:

- **endpoint** — local Anthropic-format gateway (`src/proxy.ts` for the claude launch path,
  `src/server/` for the standalone gateway); the child gets `ANTHROPIC_BASE_URL` via
  `buildChildEnv()` (`src/env.ts`). With favorites, `startProxyCatalog()` serves a multi-route
  catalog and Claude Code's `/model` menu lists starting model + favorites.
- **proxy** — selective MITM of `api.anthropic.com` (`src/http-proxy/`): Claude Code keeps its
  normal Anthropic auth; request model ids matching `clodex:{provider}:{model}`
  (`HTTP_PROXY_MODEL_PREFIX` in `src/http-proxy/routes.ts`) or saved aliases
  (`src/model-aliases.ts`) route to OpenAI; everything else passes through untouched.

**Defaults:** `resolveBridgeMode(command, explicit, {persist})` in `src/config.ts` —
`claudeBridgeMode`/`serverBridgeMode` prefs. An explicit `--endpoint`/`--proxy` applies to that run
only and is **never auto-persisted**; persisting requires `--save-mode` alongside a mode flag
(`--save-mode` alone is an arg-parse error). With no flag and nothing saved, both commands default
to **proxy** (works with existing Claude auth; non-TTY gets the same default without prompting).
`--dry-run` never persists. `--proxy` is the only spelling; the former `--http-proxy` alias is gone.

## Server discovery and the `clodex-claude` wrapper

`src/server-runtime.ts`, `src/wrapper-env.ts`, `src/claude-wrapper.ts`.

`clodex server` (both modes) registers itself in `~/.clodex/server-runtime.json` — an **array** of
`{mode, port, pid, caPath (proxy only), startedAt}` records keyed by pid, so a proxy server and an
endpoint server can be advertised simultaneously. Each server removes only its own record on
SIGINT/SIGTERM. The legacy single-object file shape is tolerated on read, wrapped as a one-element
list.

- Read-modify-write is serialized by `~/.clodex/server-runtime.lock`, deliberately the **same pid +
  staleness + ESRCH-liveness pattern as the patcher's `patch.lock`** (10s staleness); after a bounded wait a writer proceeds lockless rather than losing its
  registration. The file is replaced atomically (temp + rename).
- **Stale detection is the reader's job:** readers reject malformed records and dead pids
  (`kill(pid,0)`, EPERM counts as alive); writers additionally prune dead pids under the lock.
- `clodex server --no-discovery` (or `CLODEX_NO_DISCOVERY=1`) opts a server out entirely — e.g. an
  endpoint server used only as a local OpenAI-compatible API that must never co-opt wrapper
  discovery. The per-session MITM spawned by `clodex claude --proxy` never registers either.
- Registration happens after `listenTcpServer` confirms reachability, so a loopback refusal needs no
  retry.

`clodex-claude` (`dist/claude-wrapper.js`) serves both the `CLAUDE_CODE_PROCESS_WRAPPER` contract
(executable first arg = claude binary path, remaining args passed through) and direct terminal use
(binary discovered the same way `clodex claude` discovers it, honoring `CLODEX_CLAUDE_PATH`). `orderWrapperServerCandidates`
prefers **proxy mode over endpoint** (bridging keeps Claude Code's own Anthropic auth), newest
`startedAt` breaking ties. One concurrent TCP probe round covers every candidate; the
highest-priority responder wins. When none answers, only timed-out probes retry under one shared
500ms deadline — definitive connection errors fail immediately.

The wrapper then launches claude with one of three environments (`src/wrapper-env.ts`), and the
branches are asymmetric:

- **proxy-mode server** — sets the proxy variables to `http://127.0.0.1:<port>`, deletes
  `ANTHROPIC_BASE_URL`, sets `NODE_EXTRA_CA_CERTS` when the record carries a CA path, and removes
  the Anthropic proxy bypass.
- **endpoint-mode server** — deletes the proxy variables and sets `ANTHROPIC_BASE_URL` to
  `http://127.0.0.1:<port>/anthropic` plus the local gateway API key.
- **no live server** — an untouched env: **a down server must never break launching claude.**

Env computation is the pure `computeWrapperEnv`.

**The wrapper must `exec` into claude (`process.execve`), never spawn it as a child.** Claude Code
starts each background pty host with `detached: true`, then delivers resizes to that process group
via `process.kill(-process.pid, 'SIGWINCH')`. A wrapper that parents claude keeps the group-leader
role,
claude's pid stops matching its group id, and the signal dies as ESRCH inside a silent catch —
background sessions freeze at their startup size. Interactive sessions hide this entirely, because
there the kernel delivers SIGWINCH through the controlling terminal. `execve` is POSIX-only and
needs Node 22.15, so Windows and older 22.x keep a spawn fallback; it **aborts the process on
syscall failure instead of throwing**, which is why the binary is re-checked immediately before the
call rather than relied on to fall back. Any shell launcher in front of the wrapper must `exec` too.

**Keep the wrapper tiny and its imports minimal** — it runs for every spawned agent process. Setup
doc: `docs/background-agents.md` (shipped via the `docs` entry in package.json `files`).

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

## Auto-compaction and the response-model echo (critical)

The proxy-mode MITM layer forwards request bodies **unrewritten**, so responses echo the exact model
id the client sent. Claude Code resolves context windows from the response `model` field but uses
the request alias for preflight — substituting the canonical id in responses made patched/alias ids
miss their window config, auto-compact never fired, and agents died with "Prompt is too long".
Endpoint mode's synthetic `GET /v1/models` returns `context_window` per model so the status bar is
accurate.

**Critical URL constraint:** Anthropic-passthrough base URLs must NOT include `/v1` — the Anthropic
SDK appends `/v1/messages` itself.

## Provider registry

`src/registry/`. The shipped registry has two provider templates in `src/provider-templates.ts`:
`openai` (API key, `https://api.openai.com/v1`) and `openai-oauth`. `provider-auth.ts` implements
the OpenAI device-code OAuth flow; `refresh-models.ts` fetches the model list (3-tier fetch for
OAuth). Materialization (`materialize.ts`) turns registry providers into `LocalProvider`s with
per-model `npm`/`baseUrl`/`upstreamModelId`.

Registry writes use atomic hard-link lock publication, so the filesystem containing `CLODEX_HOME`
must support hard links. **A parseable lock owned by a live PID is never reclaimed based on age;**
contenders wait a bounded interval and fail with the owner PID. Malformed locks and locks owned by
dead PIDs remain reclaimable. This live-owner rule is what makes the final ownership check before
`providers.json` publication meaningful — a concurrent process cannot invalidate a live writer
between its check and its rename.

**Named OAuth account slots:** `clodex providers auth openai --account <name>` stores an additional
ChatGPT account under a named slot with its own credential-store lineage; the default sign-in is
untouched. `CLODEX_OAUTH_ACCOUNT=<name>` selects a slot at launch — the swap happens once at
registry materialization (`applySelectedOAuthAccount`), so credential resolution, OAuth metadata,
and refresh-token rotation transparently use the selected account, and the WebSocket cache partition
(keyed on the token's account id) stays per-account. Naming a missing slot on a provider that has
slots is a hard error, never a silent fallback to the default identity. Removing the provider queues
every slot credential for deletion.

## Server

`src/server/`: `index.ts` loads models from the registry (`loadServerModels`); `router.ts` handles
`/anthropic` (passthrough for `modelFormat:'anthropic'` with `baseUrl`, SDK adapter for `'openai'`)
and `/openai/v1` (via `src/openai-adapter.ts`). Wizard/quick-start settings persist to config;
network mode requires a password; default port 17645 (`--port` overrides).

Endpoint-mode request model resolution (`createGatewayModelCatalog` in `server/models.ts`) accepts,
in precedence order: exact catalog id (and its gateway-discovery id) → unmasked gateway id when
`--mask-gateway-ids` is on (`vendor-mask.ts`) → canonical `clodex:{provider}:{model}` id → saved
short aliases from `clodex models --alias` — **the same alias table the proxy-mode MITM resolves**,
so endpoint and proxy routing must never evolve separate alias semantics → 400. Saved alias names
are canonicalized to lowercase, and **requests must use that stored spelling**: resolution is an
exact `Map.get`, so a wrong-case endpoint alias does not resolve.
Invalid, reserved, conflicting, unavailable, or catalog-colliding aliases remain preserved in config
but are reported and kept out of routing. **Aliases and canonical ids are accepted INPUT only** —
`/models` listings advertise exactly the canonical/masked ids. **Echo invariant:** an aliased
request's response `model` field echoes the alias verbatim (even under masking) so a patched Claude
Code's context-window lookup keys match (`aliasNames` in `ServerOptions`).

## Config and env isolation

`src/paths.ts`, `src/config.ts`, `src/env.ts`:

- Config home `~/.clodex`, override `CLODEX_HOME`. Keychain service `clodex` supports chunked
  entries for Windows credential size limits.
- Preferences: `lastModel`, `lastProvider`, `recentModelsByProvider`, `favoriteModels`,
  `modelAliases`, `claudeBridgeMode`, `serverBridgeMode`, `appPathOverrides`, `localPatchesEnabled`,
  `recentLaunchFolders`, `server*`. All writes skipped when `dryRun`.
- `CLODEX_CLAUDE_PATH` overrides Claude Code binary discovery (`src/claude-binary.ts`, re-exported
  by `src/launch.ts`; the wrapper imports it directly so `launchClaude` stays out of its chunk).
- `buildChildEnv()` copies `process.env`, deletes conflicting `ANTHROPIC_*`/related vars, and sets
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` **for the child only**. Claude Code may
  persist the model to `~/.claude/settings.json` itself; that is outside clodex's control (reset
  with `claude --model sonnet`).

## Parent diagnostics while Claude Code runs

`src/parent-notice.ts`. `launchClaude` mutes `process.stdout/stderr.write` for the child's whole
lifetime because the child inherits the terminal — but clodex's gateway runs in the same process and
produces the warnings documented above. Those sites call `emitParentNotice`, an **opt-in, enumerable
channel**; there is no prefix rule, since a prefix would silently enrol future writers.

Notices are **queued, not painted.** Parent and child share one PTY with no render lock, so a live
write lands mid-frame or on the prompt where it reads as typed input — both observed against real
Claude Code. Sanitizing the message cannot make a live write safe. The queue (bounded, overflow
counted) is flushed in `restore()` once the child has exited, with a synchronous `process.on('exit')`
backstop; the `--debug-file` `[parent] ...` copy stays immediate.

Every terminal write is guarded against an **asynchronous EPIPE** — a closed pipe
(`clodex claude 2>&1 | head -n 1`) reports through the stream's `error` event *after* `write()`
returns, so a synchronous try/catch cannot contain it, and an unhandled one would kill the gateway
out from under a running child.

## Outbound proxy

`src/outbound-proxy.ts`. When `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` are set in clodex's environment,
`installOutboundProxyDispatcher()` (called at the top of `main()`) installs undici's
`EnvHttpProxyAgent` as the global fetch dispatcher, so every fetch-based call (OAuth device
flow/refresh, model-list and models.dev refresh, AI-SDK upstream calls) honors them. Without proxy
env vars it is a no-op.

Transports that do not use the undici dispatcher share the same resolver: the `ws`-based OAuth
Responses WebSocket gets an `https-proxy-agent` CONNECT tunnel via `outboundWsProxyAgent()`, and the
raw first-party passthrough creates one keep-alive `outboundHttpProxyAgent()` synchronously after
the local bridge binds and reuses it. If the resolved proxy URL names that same listener — by exact
address, loopback alias, or a local interface behind a wildcard bind — raw passthrough warns and
connects directly rather than recursively tunnelling through itself. Malformed proxy URLs also warn
and fall back to direct connections.

Claude Code's own `NO_PROXY` matcher has two behaviors worth knowing before changing this area:
`no_proxy || NO_PROXY` means **lowercase wins outright — do not union the casings**, and `*` is
bypass-all **only as the entire value** (a list-member `*` matches nothing).

---

# Patcher

`src/patcher.ts` + `src/patch-transforms.ts` + `src/built-in-patch-proofs.ts` +
`src/local-patches.ts` + `src/patch-backup.ts`.

`clodex patch` uses tweakcc's programmatic API — an exact-pinned, declared runtime dependency
(externalized in `tsup.config.ts`; it brings `node-lief` for native repacking and `ink`/`react` for
its picker, which is why `patcher.ts` loads it via lazy `import()`). **Never `npx`, never the
network.** Flow: `tryDetectInstallation({ path })` → `readContent` → `applyClodexPatches(source,
config)` (in-process pure function applying built-in PATCH 1–10 sites) → optional
`applyLocalPatches` transaction with built-in postcondition verification → `writeContent` (repacks
the native binary). Both layers return per-site OK/SKIP/FAIL results shown by `--trace`.

tweakcc ships no `.d.ts` despite its `types` field — `src/tweakcc.d.ts` declares the verified API
surface; re-verify when bumping the pin. `node-gyp-build` is a deliberate direct dependency even
though no clodex source imports it: a node-lief release demoted it to a devDependency while still
`require`-ing it at runtime (reported against 1.3.1; the lockfile currently resolves 1.3.0), so
fresh installs resolved a node-lief throwing
`Cannot find module 'node-gyp-build'` — which tweakcc's lazy loader swallows into a null and clodex
surfaces as the misleading "Failed to extract JavaScript from native installation". Declaring it
ourselves guarantees it lands somewhere node-lief's `require` can resolve — that is the invariant to
check any alternative fix against, which matters because this repo uses pnpm's strict non-hoisted
layout with exact pins. Keep it even after node-lief fixes the packaging.

The built-ins bake favorites + aliases into the binary: model validation, `/model` listing, alias
resolution, context windows via a `/*ccpatch:ctx*/`-marked map, per-model effort
capabilities/defaults, and child-command network isolation.

## Patcher invariants

- **The alias IS the model identity in the binary.** For any favorite with an alias, the short name
  (`sol`) — never the canonical `clodex:<provider>:<model>` id — is what lands in the Agent-tool zod
  enum (PATCH 1), the known-alias validator list (PATCH 3), the `/model` picker value (PATCH 5), and
  the context-window map (PATCH 7). Subagent/skill/agent `model:` frontmatter is validated against
  that same enum, so injecting canonical ids made `model: sol` fail with InputValidationError.
  Favorites with no alias fall back to their canonical id as the identity (enum + validator +
  context map only; no resolver case, no picker entry).
- **PATCH 6 (alias resolver switch) maps each alias to ITSELF.** The case must exist — the switch's
  `default:` returns null — but resolving to the canonical id would make Claude Code send one name
  while looking its context window up under another. That is the same mismatch as the response-echo
  bug — the MITM layer resolves short alias names as request model ids and echoes bodies unrewritten,
  so *name in enum == name sent == name echoed == context-map key*. The map keeps the canonical id
  as an extra key so pre-alias lookups still hit.
- Picker/description text uses the canonical label from `httpProxyDisplayName()`
  (`src/http-proxy/routes.ts`, built on `formatModelLabel`) — the same string `clodex server` prints
  at startup and `clodex models --list` shows, e.g. `GPT-5.6 Sol (OpenAI (ChatGPT))`. Missing label
  → the old `Custom model (<id>)` wording.
- `buildDesiredPatchConfig()` is disk-only (preferences + registry models cache — no network, no
  credentials).
- `computePatchConfigHash` = sha256 of `[PATCH_TRANSFORMS_VERSION, key-sorted [key, alias??null,
  context??null, display??null, effort-levels??null, default-effort??null] array]`, plus the
  versioned local-module content identity only while local patches are enabled. Disabled users
  retain the exact historical hash shape. The manifest at `~/.clodex/patch-state.json` (binary path,
  claude version, config hash, patched size/sha256, backup path, pristine sha256 — the last absent
  in pre-content-addressed manifests) drives `evaluatePatchState` →
  `unpatched | current | stale-config | stale-binary`.
- **PATCH 10 isolates proxy-mode bridge settings from standard child commands.**
  `computeWrapperEnv()` and `buildHttpProxyChildEnv()` write `CLAUDE_CODE_CLODEX_NETWORK_ENV`, a
  versioned compare-before-revert contract holding the external and injected values for the proxy
  variables, bypass lists, and `NODE_EXTRA_CA_CERTS`. The patched shared child-environment builder
  restores an external value only while the live value still equals what clodex injected, so nested
  wrappers cannot preserve a dead bridge port and settings-level overrides remain authoritative. It
  always removes the contract from the child and requires both contract records to contain the same
  recognized keys with only string or null values. PATCH 10 is deliberately **required**: publishing
  without it would silently reintroduce bridge settings into child commands, while a failed required
  patch leaves the installed binary untouched. **The contract does not cover** endpoint-mode
  `ANTHROPIC_*` variables, the separate `--bg --exec` environment path, or a plain nested `claude`
  launched from Bash — use `clodex-claude` when a nested client must stay bridged.
- **Bump `PATCH_TRANSFORMS_VERSION` in the same commit whenever the transform set changes
  materially** — a site added or removed, or a site's regex, replacement, or ordering changed. That
  hash is the manifest's only record of the transform set; without the version folded in, a user
  whose favorites are unchanged stays `current` forever and silently never receives the new
  transforms. A test pins a sha256 of `patch-transforms.ts` plus `network-env.ts` so the decision is
  forced rather than forgotten; for a comment-only edit, re-pin the digest and leave the version
  alone. **That pin is a tripwire, not a behavioural test** — never let it be the only red test in a
  mutation check (see the verification standard above).
- **Never patch on top of a patch, and never publish a partial patch.** `applyPatch` never writes
  the live binary in place. It builds into a *candidate* inside a sibling temp dir
  (`.clodex-patch-*`, removed in a `finally`) and `renameSync`s it over the binary only after every
  *required* site applied and the repack succeeded (PATCH 4 and 5 are `required:false` and may FAIL
  without blocking) — which is what makes the "required effort patches failed" throw (PATCH
  8a/8b/8c/9) safe: the install is still whole. The candidate is seeded from the *established
  pristine bytes*, not the live binary, whenever the live binary is not itself provably pristine —
  regardless of what the manifest says.
- **Whatever the seed, the bytes about to be patched must carry no clodex patch marker.** The live
  binary is checked on the bootstrap path, and a backup is checked after it is seeded, because
  `verifyPristineSource` only proves the *version* — and a patched claude reports its version
  perfectly well. A poisoned backup is reachable (every clodex before content addressing snapshotted
  whatever was live when no backup existed), and patching one would both double-patch the install
  and launder the result into a content-addressed name that is otherwise trusted on sight. Both
  reachability paths are observed, not hypothetical: pre-content-addressing clodex snapshotted
  whatever was live when no backup existed, **and the version-resolution bug generated exactly that
  state**. That check runs **before** any write to the backup directory, so a poisoned backup can
  neither be adopted nor clobber the `native-binary.backup` mirror. Extraction is expensive (~250 MB), so it
  happens **once**: the candidate is seeded from the live binary and inspected there — a
  byte-identical copy — and the same extraction feeds the patch when the verdict is "unpatched".
  Only unusable bytes pay for a second seed + extract.
- **Local patches are explicitly trusted code and an extension, never a local-only mode.** Only
  `~/.clodex/local-patches.mjs` (respecting `CLODEX_HOME`) is considered, and only after
  `--enable-local-patches` persists the opt-in; there is no cwd, package, dependency, or
  `node_modules` discovery. `inspectLocalPatchSource` captures and hashes the module **without
  executing it**. Execution happens only inside `applyPatch`, after required built-ins succeed,
  against their pristine-seeded output. The set is all-or-none: any load, validation, marker,
  transform, or post-local built-in verification failure discards every local mutation but still
  publishes the complete built-ins. Host-generated `/*clodex-local:<id>*/` markers are distinct from
  the blocking `/*ccpatch:` tier, and local transforms may not alter prior local markers or built-in
  sites. Keep the module deterministic and self-contained — only its entry bytes participate in
  freshness.
- **Patch-marker detection is two-tier** (`patch-backup.ts`). Only the `/*ccpatch:` prefix —
  clodex's own injected text — may *block*, and it covers everything current clodex publishes
  because PATCH 8a/8b/8c/9 are required and each emits one. The weaker legacy signals (PATCH 4's
  description text, PATCH 5's picker dedupe guard, `"clodex:` ids) only *warn*: they can collide
  in principle with Claude Code's own bytes, and a false positive is **unrecoverable** — refusing to
  bootstrap tells the user to reinstall Claude Code, which yields identical bytes and an identical
  refusal. A missed legacy patch is recoverable by comparison. **Proof blocks, heuristic warns.**
  The proof tier has one known narrow gap: a pre-effort-sites clodex emitted `/*ccpatch:ctx*/` only
  when some model had a non-default context window — verified against the real 2.1.220 bundle.
- **Pristine backups are content-addressed:** `~/.tweakcc/claude-<ver>-<sha256 prefix>.orig`, so one
  name can never hold two different contents and every backup self-validates by rehashing. A backup
  becomes the pristine source ONLY when its provenance is established: the version tag must equal
  the version probed from the binary being patched, its hash must match its own name, and a legacy
  `claude-<ver>.orig` (no hash in the name, possibly mislabeled by an older clodex) must
  additionally report that version when executed (`verifyPristineSource`). Conflicting or
  unverifiable backups produce a loud error, never a copy. This gate covers both consumers —
  `applyPatch` seeds its candidate from those bytes, and **`clodex patch --restore` copies straight
  over the live binary** (nothing to publish atomically), so an unverified backup would be a silent
  downgrade either way. An already-patched binary is never snapshotted as pristine. Legacy backups
  are adopted (copied to their content address) rather than orphaned — and whether the canonical
  name already holds the right bytes is decided from the scan's **content hash, not `existsSync`**,
  so a truncated or foreign file parked there is replaced instead of adopted and published. Every
  write into the backup directory goes through `publishBackupFile` (temp + `rename`), because an
  interrupted ~250 MB `copyFileSync` would leave a truncated file under a name asserting its content
  hash — the one corruption content-addressing cannot notice without re-hashing.
  `~/.tweakcc/native-binary.backup` is still mirrored from the pristine bytes for `tweakcc
  --restore`.
- **`clodex patch --restore` must work on a binary that no longer runs** — that is what a pristine
  backup is *for*. It resolves the version from `claude --version` when it can, and otherwise falls
  back to the manifest's `claudeVersion` when `manifest.binaryPath` matches the resolved install,
  establishing provenance without executing anything. The patch path keeps the hard `version-unknown`
  failure (patching is elective; restoring is the way out), and its error message names `--restore`
  as the recovery.
- **Binary resolution bypasses PATH shims** (cmux installs a shim copy):
  `TWEAKCC_CC_INSTALLATION_PATH` → `~/.local/bin/claude` → `findClaudeBinary()`. **The version is
  probed from that resolved binary** (`getClaudeVersionForBinary`), never from
  `getInstalledClaudeVersion()`, whose PATH lookup can land on a different install and whose
  `'2.1.183'` fallback is only safe for request metadata. The version names the backup that gets
  restored, so borrowing it from a shim silently downgraded the user's Claude Code.
  `resolveClaudeBinaryForPatch` returns `binary-not-found` vs `version-unknown`; the launch-time
  check stays non-fatal for both.
- Concurrency lock `~/.clodex/patch.lock` (pid + 10-min staleness + ESRCH liveness); the loser skips
  with a notice — never blocks, corrupts, or double-patches.
- `runLaunchPatchCheck()` in `clodex claude`: interactive y/N offer when stale; non-TTY or
  `--dry-run` prints a one-line stderr notice and proceeds. It may read/hash an enabled local module
  for freshness but must never execute it unless the user accepts. Wrapped in try/catch — a
  patch-check failure must never break launch.
- Context is omitted from the patch map when unknown or equal to Claude Code's 200k default;
  `[1m]`-suffixed model ids and explicit context are mutually exclusive in the transforms.
- **The per-site transforms in `patch-transforms.ts` (regexes, replacements, ordering, SKIP/FAIL
  semantics) are hard-won — change them only with byte-for-byte equivalence evidence on a real
  binary.** "Applied once, emitted one marker" **cannot** distinguish a correct match from a
  catastrophic over-match; both produce exactly those numbers. Assert the **matched span** and the
  **enclosing function of every rewritten reference**, run the real `applyClodexPatches` over every
  extracted bundle, and execute the emitted patch — reading it is not evidence that it runs.

---

# Tests

`tests/` is almost all pure functions — adapter, provider factory, proxy, http-proxy routes,
registry, config, bridge-mode persistence, help text, and patcher (config building, hash stability,
manifest staleness, lock behavior, per-site transforms).

The exception is `tests/patcher-command.test.ts`, a genuine end-to-end exercise of `clodex patch`
and the only automated coverage of `runPatchCommand`: it drives the real command against fake claude
"binaries" (shell scripts answering `--version` and carrying a bundle payload after a sentinel) with
tweakcc's three API calls mocked, covering version resolution, backup selection, the
poisoned/corrupt-backup refusals, `--restore`, and the manifest without touching a real install.

Interactive launch flow and real-provider behavior are verified manually.

**`claude -p` end-to-end tests are manual only — NEVER add them to the automated suite.**

---

# Key constraints

- `~/.claude/settings.json` is never touched by clodex. Launch config is env-var-only (plus
  `--model`), child process only.
- `--dry-run` skips all writes (including bridge-mode persistence).
- The `::ts::` separator in tool_use ids encodes reasoning signatures for round-tripping; would only
  break if a signature literally contained `::ts::`.
- In endpoint switch-menu mode the displayed context window reflects the **launch** model and does
  not update on live `/model` switch (Claude Code fetches `/v1/models` once at startup). Proxy mode
  + `clodex patch` reports correct per-model windows.
- Cost display in Claude Code is always inaccurate for OpenAI models (Claude Code applies its own
  pricing table).
- `MAX_MODEL_CATALOG = 20` (`constants.ts`) — favorites cap and max catalog routes.
- OpenAI catalog ids may differ from upstream API ids — `upstreamModelId` carries the real API id.
