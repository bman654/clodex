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

### VS Code's bundled binary

In the inspected VS Code extensions 2.1.267 and 2.1.273, macOS can point
`claudeCode.claudeProcessWrapper` at the spawnable `clodex-claude` executable; Linux follows the
same POSIX launch path, and Windows points it at the `.exe` from `clodex install-vscode-launcher`
(below), which starts the same wrapper. The Linux host path was not run for this change. The
extension invokes it as `clodex-claude <bundled-claude> <args...>`, sets
`CLAUDE_CODE_ENTRYPOINT=claude-vscode`, and clears the child-session markers. With a live
**proxy-mode** server, that exact host/shape enables one conservative target change:

- `CLODEX_HOME/patch-state.json` must contain the complete current manifest, including full
  `pristineSha256` and `patchedSha256` fingerprints;
- the handed-in file's full SHA-256 must equal `pristineSha256`; and
- the manifest's different `binaryPath` must still be an executable file whose full SHA-256 equals
  `patchedSha256`. The target is rechecked at the exec handoff.

"Executable" is `requireWrapperExecutable` in `src/wrapper-target.ts`: `access(X_OK)` on POSIX;
on Windows, where libuv's `access` ignores `X_OK` entirely, a `.exe` name — the shape the spawn
fallback starts directly. A `.cmd`/`.bat` (spawned through `cmd.exe`, naming any program) is
refused on either side. File identity around the hash-to-exec window is compared from
`statSync(path, { bigint: true })`: `dev`, `ino`, `size`, `mode`, `mtimeNs`, `ctimeNs`. Bigints
because NTFS file reference numbers are 64-bit (a 16-bit sequence over a 48-bit MFT record — NTFS
layout, and libuv reports the whole value; past sequence 32 a double rounds it, which
`tests/wrapper-target.test.ts` shows with a synthetic id), and nanoseconds because NTFS stamps are
100 ns units and the `*Ms` doubles round them. What the `windows-launcher` job measures
(`tests/wrapper-substitution.windows.test.ts`): `ino` is non-zero and stable across stats, an open
handle and a hard link; `dev` equals the volume serial; `ctime` moves on an in-place same-size
rewrite with `mtime` restored (it is the NTFS ChangeTime, and `birthtime` is the creation time);
`mode` changes with the read-only attribute; `access(X_OK)` passes for a text file; and the
selector declines exactly that rewrite between prepare and finalize. First run (2026-09-17,
`windows-latest`, Node 24.20): `ino` sequence 3, well under 2^53; `dev` 0xd6f2a281 = the C: serial;
`ctime` +80 ms across the rewrite with `mtime` and `birthtime` unchanged; mode 0o100666 → 0o100444;
SHA-256 of 200 MB 1180 ms then 348 ms on one run, 177 ms then 183 ms on the next — a few hundred
milliseconds per eligible spawn in steady state, with the occasional first-touch second.

Only then does the wrapper run the recorded patched install, preserving every original argument
following the handed-in path. A missing/legacy/invalid manifest, an already-patched or same-file
input, different bytes (even at the same size or version), a missing/changed target, or any read
failure keeps the handed-in path authoritative. It never falls through to ordinary Claude binary
discovery, runs a version subprocess, writes state, caches a decision, or patches at launch. Chat
and extension helper commands are both eligible for verified substitution. When verification fails,
the wrapper emits its one bounded stderr notice only for the persistent SDK chat spawn, identified
by `--output-format stream-json` or `--input-format stream-json` without
`--no-session-persistence`. Auth, MCP, plugin, edit-hook, and nonpersistent suggestions helpers stay
silent when refused so their own error text remains first. The inspected VS Code extension source
records main-chat stderr in the **Claude VSCode** output channel with a `From claude: ...` prefix.
This output-channel behavior
was not exercised in a running editor. Stdout remains the Agent SDK protocol channel. A fingerprint
mismatch still reads the full handed-in executable on each eligible spawn before refusing; selection
is deliberately not cached.

If VS Code itself inherits `CLAUDECODE=1` because it was launched from inside a Claude Code session,
the extension removes that marker from the chat environment but helper commands merge it back from
the extension host. The chat remains eligible for substitution while helpers keep the handed-in
binary; neither path selects an unverified executable.

This substitution does not apply to endpoint mode, no-server launches, `--check`, direct terminal
use, or ordinary/background `CLAUDE_CODE_PROCESS_WRAPPER` children. Tool, hook, and agent
children carry child-session markers; background pty wrappers instead lose the `claude-vscode`
entrypoint. Both shapes therefore keep their handed-in executable. The extension and installed CLI
update independently: while their source artifacts differ, the wrapper deliberately launches the
extension's bundled copy and the picker may omit clodex entries. After either channel updates,
align the builds and re-run `clodex patch`; re-run it after favorites or patch configuration changes
as well. Equal version labels are not enough because supported same-version distributions have
shipped different bytes.

**The wrapper must `exec` into claude (`process.execve`), never spawn it as a child.** Claude Code
starts each background pty host with `detached: true`, then delivers resizes to that process group
via `process.kill(-process.pid, 'SIGWINCH')`. A wrapper that parents claude keeps the group-leader
role,
claude's pid stops matching its group id, and the signal dies as ESRCH inside a silent catch —
background sessions freeze at their startup size. Interactive sessions hide this entirely, because
there the kernel delivers SIGWINCH through the controlling terminal. `execve` is POSIX-only and
needs Node 22.15, so Windows and older 22.x keep a spawn fallback (on Windows with a shell only for
`.cmd`/`.bat` launchers — `wrapperSpawnShell`); it **aborts the process on
syscall failure instead of throwing**, which is why the binary is re-checked immediately before the
call rather than relied on to fall back. Any shell launcher in front of the wrapper must `exec` too.

**Keep the wrapper tiny and its imports minimal** — it runs for every spawned agent process. Setup
doc: `docs/background-agents.md` (shipped via the `docs` entry in package.json `files`).

### The Windows VS Code launcher (`clodex install-vscode-launcher`)

`src/vscode-launcher.ts`, `launcher/clodex-claude-launcher.cs` (shipped via the `launcher` entry in
`files`; deliberately **not** a `bin` — a bin-link would put a `.cmd` shim in front again).

The Claude Code VS Code extension spawns `claudeCode.claudeProcessWrapper` with no shell and
`windowsHide`, as `<wrapper> <bundled claude.exe> <args...>`; the setting is one executable string
with no argument field. On Windows npm installs `clodex-claude` as three script shims
(extensionless POSIX shell, `.cmd`, `.ps1`) and no executable; the spawn rejects them with
`spawn EINVAL` (#196, #234). The command compiles a native `.exe` on the
user's machine with the C# compiler inside the .NET Framework (`%WINDIR%\Microsoft.NET\
Framework64\v4.*\csc.exe`, then `Framework\`), C# 5 language level, and publishes it to
`<CLODEX_HOME>\bin\clodex-claude.exe` by temp-and-rename (`publishFileByRename`). No prebuilt
binary ships (Defender/SmartScreen on unsigned Go/C executables) and no npm lifecycle script runs
it (pnpm 10 blocks them, npm runs them silently).

The launcher:

- forwards the **raw command line** from `GetCommandLineW` minus its first token (its own path,
  quoted or not, per the C runtime's argv[0] rule) rather than re-quoting `string[] args` — .NET
  Framework has no `ArgumentList`, and CRT re-quoting is lossy for JSON and empty arguments;
- runs `"<node.exe>" "<dist/claude-wrapper.js>" <tail>` with both paths **baked in as constants**
  at compile time (`process.execPath` and the installed package's `dist/claude-wrapper.js`);
  falls back to `node.exe` on `PATH` if the baked Node is gone, exits 127 with a re-run message if
  the wrapper script is gone;
- creates a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, starts Node `CREATE_SUSPENDED`,
  assigns it, then resumes — so the extension killing the launcher takes Node and claude with it.
  The job handle is never closed on purpose; process exit closes it. Every Win32 return is checked:
  job creation/configuration/assignment failure prints one `warning: … cancellation cleanup is not
  guaranteed` line and continues; a failed resume or wait terminates the child and exits 1 with a
  one-line reason;
- returns `true` from its console control handler for Ctrl+C/Break so the child, which shares the
  console, handles them; exits with the child's exit code.

The launcher chooses no binary. It hands the wrapper the bundled `claude.exe` the extension named,
and the wrapper applies the substitution rules above unchanged (`wrapperSubstitutionEligible` has
no platform term); the selected `.exe` is then started by the wrapper's Windows spawn fallback
without a shell, with the fallback notice already written to the inherited stderr.

Every environmental input of the command (platform, env, node path, compiler runner, scratch root)
is an option, and `tests/vscode-launcher.test.ts` drives the whole path against a fake `csc.exe`
in a fake `%WINDIR%` tree, plus a tsup-built package layout for the default path resolution. The
real compile and the real executable are covered by **`tests/vscode-launcher.windows.test.ts` on the
`windows-launcher` CI job** (`windows-latest`): it runs the built `dist/cli.js` so the runner's own
Framework `csc.exe` compiles the shipped source, then spawns the `.exe` the way the extension does
(no shell, argv array) with node.exe + a probe script as the "bundled claude" — argument values
with spaces, quotes, JSON, `""`, `%PATH%`, `&|<>^` and non-ASCII arrive at the probe unchanged
through node and the wrapper, stdin/stdout/exit code pass through, killing the launcher takes node,
the probe and its grandchild down, and a stale baked wrapper path exits 127 with the re-run hint.
That job is also what proves the inner boundary: `wrapperSpawnShell` (`src/wrapper-env.ts`) makes
the wrapper's Windows spawn fallback use a shell only for `.cmd`/`.bat` launchers (Node refuses to
spawn those without one); a native `.exe` is spawned directly, and the JSON/`%PATH%` assertions
only hold on that direct path. Off Windows the file is skipped at collection. The C# source can
also be compile-checked and its command-line splitting executed on macOS/Linux with the .NET SDK
(`LangVersion=5`).

The same job runs `tests/wrapper-substitution.windows.test.ts`, the Windows counterpart of the
patched-install selection tests in `tests/claude-wrapper.test.ts`: `tests/fixtures/fake-claude.cs`
is compiled with the runner's `csc.exe` into a stand-in `claude.exe` (answers `--version`, reports
which copy of itself ran by looking for clodex's `/*ccpatch:` marker in its own overlay bytes), the
fake bundle is appended after a sentinel, the REAL `runPatchCommand` patches it with tweakcc mocked
byte-for-byte (latin1, not utf8 — the head is a PE image), and the launcher built by the first
suite is spawned as the extension spawns it with a pristine copy as the handed-in path. It asserts
the patched copy runs for chat and helper spawns, that a same-size different-bytes copy runs as
handed in with one stderr line written before the binary's own output (both fds into one file),
that refused helper spawns stay silent, and that a dead server disables substitution. Its first
suite records the NTFS facts listed above and prints the SHA-256 time for a 200 MB file.


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

`src/outbound-proxy.ts`. `installOutboundDispatcher()` (called at the top of `main()`) always
installs the package undici dispatcher globally with HTTP/2 disabled. It uses `EnvHttpProxyAgent`
when `HTTP_PROXY`/`HTTPS_PROXY` are configured, so every fetch-based call (OAuth device flow/refresh,
model-list and models.dev refresh, AI-SDK upstream calls) honors those variables and `NO_PROXY`;
otherwise it uses a direct `Agent`. Pinning fetch to HTTP/1.1 prevents Node 26's bundled undici 8
from retaining a destroyed pooled HTTP/2 session and failing every later request to that origin.

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

## WebSocket upgrade forwarding in proxy mode

WebSocket upgrade requests inside intercepted `api.anthropic.com:443` connections use
`forwardAnthropicUpgrade` (`src/http-proxy/server.ts`). It connects to the fixed Anthropic
origin with the ordinary passthrough agent and TLS settings, preserves the upgrade status and
headers from the upstream response, forwards any buffered head bytes, and pipes the sockets in
both directions. Upstream HTTP rejections remain HTTP responses with correct chunk framing. Client
disconnects and proxy shutdown cancel the upstream request and socket. This path does not
translate models or inspect audio. Voice workloads use it to stream over persistent WebSocket
connections.

---

