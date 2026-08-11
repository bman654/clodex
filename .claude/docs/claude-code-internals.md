# Claude Code internals we have verified

<!-- Read before asserting anything about how Claude Code itself behaves, and before re-deriving
     something in this list. -->

Everything here was read out of a real Claude Code bundle. **Every entry is stamped with the version
it was verified against** — Claude Code is minified and reshaped between releases, so treat an entry
older than the version you care about as a lead, not a fact, and re-verify before relying on it.

Nothing in this file is a clodex invariant. It is what the *client* does, which is why our
invariants are shaped the way they are.

## How to read the bundle

Raw byte greps **do not work** — the JS is compressed inside the native binary. Extract it:

```bash
node scripts/extract-cc-bundles.mjs           # → <tmpdir>/cc-bundles, or $REVIEW_BUNDLE_DIR
export REVIEW_BUNDLE_DIR=<that directory>     # the real-bundle harnesses read this
```

That script walks every pristine `*.orig` backup in `~/.tweakcc` (override with
`TWEAKCC_CONFIG_DIR`) and writes one ~23 MB `.js` per version, skipping any it has already
extracted. It uses clodex's own tweakcc dependency — `tryDetectInstallation({ path })` then
`readContent` — which is why it has to run from inside this repo, where `node_modules` resolves.

Extract from a **pristine** `.orig` backup, never a patched live binary: a patched claude reports
its version perfectly well, so the only thing distinguishing them is the patch marker.

Then **enumerate every branch of the function yourself.** Shipped bugs have come from reading the two
gates that happened to be visible, and from grepping one syntactic form of a comparison — grep the
*value*, then trace every hit.

## Unknown-model context-window enforcement (verified 2.1.223+)

Enforcement hangs off a single gate: `KJe(e,t)` returns `Q9(e,t).source !== "auto"`. `Q9` returns
`{window, configured, source}`; the enforcement branch and the fallthrough return the **identical**
`{window, configured}` and differ only in the source string.

`KJe`'s five call sites gate the blocking branch in the query path, the autocompact check, and the
status line. **Only `"auto"` turns enforcement off** — every other source value (`unknown-model`,
`model-default`, `settings`, `clientdata`, `experiment`) leaves it on. The companion `cCe()` is true
for normal local use and false only under `CLAUDE_CODE_REMOTE`.

Scope: only models that fall through to the `unknown-model` branch are affected — that is exactly
clodex identities. Recognized Anthropic models hit earlier branches.

**Three consumers read the source string, not one.** Besides `KJe`, `eOv` gates the unrecognized-model
startup notice (`if (n !== "unknown-model") return null`) and the auto-compact setup wizard both
labels the source and seeds its initial value differently. Both are **cosmetic**, so `KJe` remains the
only behavioural gate — but the bundle already renders `model-default` as a first-class label.

## The shared child-environment builder (verified 2.1.221)

`pH()` is the shared child-env builder, with 14 call sites. The split that matters for bridge
isolation:

- **Shell-mediated** (reachable from a `.zshenv`-style user snippet): the Bash tool, hooks, subagent
  status line, the shell snapshot/env probe.
- **Direct binary spawns** (no shell, unreachable from any rc file): stdio MCP servers, LSP servers,
  sandboxed exec, `gh`.

That split is why a shell-rc workaround is a valid stopgap for bridge leakage but never a substitute
for PATCH 10.

**Claude Code snapshots the login shell** — `<shell> -c -l <script>` once into `shell-snapshots/`,
then reuses it. rc-derived state is captured at snapshot time and cached, and the snapshot itself is
built with `pH()` env.

**Settings-sourced env is applied AFTER any wrapper snapshot.** `S7()`/`mht()` do
`Object.assign(process.env, phr(<settings>.env, scope))` per scope, and the recorder keeps only
`NO_COLOR`/`FORCE_COLOR` — so settings-level proxy or CA values get no second chance inside `pH()`.

**The `utn()` allowlist branch is not a leak path.** Several Bash spawns use
`utn() ? {...KIs(), ...Qdt()} : pH()`, and `KIs()` copies only
`["HOME","LOGNAME","PATH","SHELL","TERM","USER"]`.

## `NO_PROXY` cannot solve child-env isolation (verified 2.1.221)

It has **no process dimension** — parent and children read the same variables — and it is a denylist
with no allow-list spelling. Dead ends already checked, so don't re-check them:

- `CLAUDE_CODE_PROXY_*` is a proxy **auth-helper** plus DNS interface; `CLAUDE_CODE_PROXY_URL` is
  passed *to* a helper subprocess, not read as config.
- `fallbackProxy` in `yg()` is reachable only from the MCP agent-proxy fallback.
- `ANTHROPIC_UNIX_SOCKET` genuinely avoids the proxy variables and is stripped from child env by
  Claude Code itself — but it flips the session into host-managed auth and kills keychain OAuth.

Two matcher behaviors worth knowing before touching `src/outbound-proxy.ts`: `no_proxy || NO_PROXY`
means **lowercase wins outright — do not union the casings**, and `*` is bypass-all **only as the
entire value** (a list-member `*` matches nothing).

## Terminal ownership (verified against 2.1.226 under tmux)

Parent and child share one PTY with no render lock. A live write from clodex lands mid-frame or on
the prompt, where it reads as typed input. **Sanitizing the message cannot make a live write safe** —
this is why `src/parent-notice.ts` queues rather than paints. See
`.claude/docs/launch-and-wrapper.md`.

Background pty hosts are started `detached: true` and resized via
`process.kill(-process.pid, 'SIGWINCH')` to the process group — which is why the wrapper must `exec`
rather than spawn.

## Things that looked like clodex bugs and were not

- **"Concurrent subagents died at turn 2" was not unknown-model classification.** The agents' first
  tool call injected ~230k tokens of bundled-skill content into a 272k-window model, exceeding any
  threshold. Enforcement was reporting a real problem. Check the actual prefix size before theorising
  about window plumbing.
- **A zero-usage symptom in the client is upstream's.** clodex floors `input_tokens` with
  `estimateAnthropicInputTokens` on both translation paths and retains it at `finish`; the client's
  usage merge is last-non-zero-wins and yields the assistant event once.
