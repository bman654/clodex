# Claude Code internals we have verified

<!-- Read before asserting anything about how Claude Code itself behaves, and before re-deriving
     something in this list. -->

Everything here was read out of a real Claude Code bundle. **Each section states the version it was
verified against wherever that was recorded** — Claude Code is minified and reshaped between
releases, so treat an entry older than the version you care about as a lead, not a fact, and
re-verify before relying on it. Where a stamp is missing or open-ended (`2.1.223+` means "first seen
in .223 and not re-checked since"), treat the entry as *less* trustworthy, not more, and stamp it
properly the next time you confirm it.

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

## The entry module's name is not stable (renamed in 2.1.229)

The bundle lives in a Bun data blob as one module among ~15, and tweakcc finds it **by name**:
`/claude`, `claude`, `/claude.exe`, `claude.exe`, `/src/entrypoints/cli.js`, `src/entrypoints/cli.js`.

| Version | Entry module |
| --- | --- |
| 2.1.224, 2.1.226, 2.1.228 | `/$bunfs/root/src/entrypoints/cli.js` |
| 2.1.229, 2.1.231–2.1.234 | `/$bunfs/root/cli` |

(2.1.228 is the last release clodex's pinned tweakcc 4.3.0 — and clodex's own mirrored copy of its
name list — can discover, and 2.1.230 was never published for any platform package, so 2.1.229 is
where the rename actually landed. Confirmed on linux-x64 and darwin-arm64.)

2.1.229 and later match none of them, so `readContent` threw and every patch failed with
"Failed to extract JavaScript from native installation" — which reads like the `node-gyp-build`
packaging fault described in `patcher.md` and is not it. tweakcc carried the old list through
4.3.2; **4.3.3** added `/cli`, but clodex mirrors the list itself and is still pinned to 4.3.0, so
`src/bun-entry-module.ts` works around it; see `patcher.md`.

Two things that are easy to assume wrongly about the blob:

- **The entry module also carries ~190 MB of Bun bytecode** (`// @bun @bytecode @bun-cjs`), and
  repacking preserves it verbatim. It does **not** win over the patched source — a canary injected
  into the JS prints at startup on a repacked 2.1.231 (verified twice on macOS arm64 — once by
  hand and once through clodex's own local-patches feature, both printing the canary on stderr
  ahead of `--version`). Bytecode has been present since at least 2.1.226, so this was never the
  thing standing between clodex and a working patch.
- The blob's own 32-byte offsets record where it starts, and it ends with a fixed `---- Bun! ----`
  trailer, so it can be located by scanning back from EOF with no Mach-O/ELF/PE parsing at all.
  `entryPointId` names the entry module directly and survives renames; the *name* is only how
  tweakcc happens to look it up.

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

**Its minified name and declarator list change release to release** — `pH()` in 2.1.221, `XH()` in
2.1.224, `$M()` in 2.1.226, `o1()` in 2.1.228, which also hoisted the settings-colour env into its
own binding (`r=<mod>.settingsColorEnv`) inside the opening `let`. That is why PATCH 10's anchor
identifies the function by the landmarks inside its body — the `CLAUDE_CODE_REMOTE` ternary, the
`INPUT_${…}` deletion tail, and the required-literal check — and tolerates declarator drift ahead of
the ternary rather than counting bindings.

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

## Things that looked like clodex bugs and were not (not version-specific)

- **"Concurrent subagents died at turn 2" was not unknown-model classification.** The agents' first
  tool call injected ~230k tokens of bundled-skill content into a 272k-window model, exceeding any
  threshold. Enforcement was reporting a real problem. Check the actual prefix size before theorising
  about window plumbing.
- **A zero-usage symptom in the client is upstream's.** clodex floors `input_tokens` with
  `estimateAnthropicInputTokens` on both translation paths and retains it at `finish`; the client's
  usage merge is last-non-zero-wins and yields the assistant event once.
