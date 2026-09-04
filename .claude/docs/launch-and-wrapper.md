# Launch, bridge modes, and the clodex-claude wrapper

<!-- Read when changing src/launch.ts, src/env.ts, src/proxy.ts, src/http-proxy/,
     src/server-runtime.ts, src/claude-wrapper.ts, src/parent-notice.ts, or src/outbound-proxy.ts. -->

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
- `CLODEX_UPSTREAM_IDLE_TIMEOUT_MS` and `CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS` are resolved by the
  process serving provider requests. `clodex claude` owns that server in-process. With a standalone
  `clodex server`, restart that server with the variables set; putting them only on a
  `clodex-claude` wrapper cannot reconfigure it. Request-time notices are immediate on standalone
  server stderr, while `clodex claude` queues them as described below.

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

