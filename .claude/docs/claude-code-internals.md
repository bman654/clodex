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
`TWEAKCC_CONFIG_DIR`) and writes one `.js` per version (~23 MB before 2.1.242, ~36 MB after),
skipping any it has already extracted. It uses clodex's own tweakcc dependency for detection, and
`readClaudeBundle` for the JavaScript, which is why it has to run from inside this repo, where
`node_modules` resolves.

**The file it writes is a JOIN of every JavaScript module**, separated by
``/*clodex:module-boundary`;{}"]*/`` lines — the same document `clodex patch` matches its anchors
against. That is true of every version, not only the split ones: a pre-2.1.242 binary carries the
bundle plus five ~2 KB helper modules, so its extract is a six-module join. Since 2.1.242 it is
roughly 1,380. Do not go back to tweakcc's `readContent` for this: it returns only the module it
recognizes by name, which since 2.1.242 is a ~20 KB stub holding none of Claude Code's behaviour.

Extract from a **pristine** `.orig` backup, never a patched live binary: a patched claude reports
its version perfectly well, so the only thing distinguishing them is the patch marker.

Then **enumerate every branch of the function yourself.** Shipped bugs have come from reading the two
gates that happened to be visible, and from grepping one syntactic form of a comparison — grep the
*value*, then trace every hit.

## The bundle was code-split in 2.1.242

Through 2.1.241 the whole ~28 MB bundle was ONE Bun module. 2.1.242 split it: the entry module is
now a ~20 KB ESM stub whose body is `import{…}from"/$bunfs/root/chunk-<hash>.js"` plus a `main()`
call, and the code lives in ~1,374 sibling `chunk-*.js` modules — 1,391 modules in the blob, against
15 before. Chunk names are content-hashed, so they differ between releases AND between platform
builds of the same release.

| Version | Modules in the blob | Entry module payload |
| --- | --- | --- |
| 2.1.232 | 15 | 26,504,651 bytes — the whole bundle |
| 2.1.241 | 15 | 28,252,504 bytes — the whole bundle |
| 2.1.242, 2.1.243 | 1,391 | ~19,950 bytes — an import stub |
| 2.1.245 | 1,393 | 19,949 bytes — an import stub |
| 2.1.246 | 1,582 | 20,605 bytes — an import stub |

(Measured on darwin-arm64. 2.1.242 and 2.1.243 have the same module count and differ only in their
chunk hashes and version string. 2.1.246 adds 189 modules over 2.1.245: 25 more JavaScript chunks
and 164 embedded text files — 118 `.md` and 46 `.txt`, carrying a loader id, 13, that no earlier
release used, and which Bun does not execute as JavaScript.)

Consequences worth knowing before you touch any of this:

- **The anchors did not move; the reader did.** Every clodex patch site still occurs exactly once
  across the bundle — they are just in six different chunks on 2.1.243, none of them the entry.
- **Bun executed the chunk SOURCE, not the chunk bytecode — through 2.1.245 only.** Verified on
  2.1.243 darwin-arm64 by overwriting eleven bytes of one chunk's payload in place (`Your prompt` →
  `YOUR_PROMPT`), re-signing, and running `claude --help`: the edited string is what printed. **On
  2.1.246 this is no longer true** — see the Bun 1.4.1 section below. The reason it changed is that
  the source hash JSC keys its code cache on used to be computed from the source that is actually
  there; since Bun 1.4.1 it is read out of the blob.
- **A module's payload can be repointed without moving it.** `{ offset, length }` in the module
  struct is the only thing that says where a module's source is, so several modules can be patched
  in ONE repack by appending their new sources past the end of the blob and pointing each module at
  its own slice. That is what `src/bun-bundle.ts` does.

## The blob carries more than the module structs describe (Bun 1.4.1, 2.1.246)

Claude Code 2.1.245 ships Bun 1.4.0; 2.1.246 ships **Bun 1.4.1**, and 1.4.1 writes three structures
after the module table that no module struct points at. Which of them are present is announced by
the blob's `flags` word — 15 on 2.1.245, 255 on 2.1.246 — and every one of them is addressed by an
offset relative to the start of the blob:

| Flag | Bit | What follows the module table |
| --- | --- | --- |
| `SOURCE_TEXT_CONTIGUOUS` | 4 | nothing; it asserts every module's source lies in one run |
| `HAS_SOURCE_HASHES` | 5 | `[u32; modules]`, each module's WTF source hash (`0` = not recorded) |
| `HAS_BUILTIN_BYTECODE` | 6 | `u32 count`, then `count` x `{ u32 id, u32 offset, u32 length }` |
| `HAS_BYTECODE_STRING_TABLE` | 7 | one `{ u32 offset, u32 length }` for the shared string table |

On a real 2.1.246 darwin-arm64 that is 6,328 bytes of source hashes, a builtin-bytecode table with a
count of zero, and a pointer to a **9,878,164-byte shared bytecode string table** every chunk's
compiled form references by ordinal — 6,341 bytes of tail plus ~9.9 MB of payload, none of it
reachable from a module struct. Read the layout precisely: only the tail records follow the module
table. The string table PAYLOAD is written among the other payloads, well before it (offset
103,812,984 of 164,222,846 on that build, with the module table at 164,134,241); it is the 8-byte
`{offset, length}` record pointing at it that comes after. Two more invariants come with it, from Bun's own source
(`src/standalone_graph/StandaloneModuleGraph.rs`, `append_bytecode_aligned`):

- **Cached bytecode must start 128-byte aligned once mapped**, because JSC decodes it in place. The
  blob's section base is aligned to at least 512 bytes in every container Bun emits and its data
  begins 8 bytes in, so every bytecode offset is `120 mod 128` blob-relative and `0 mod 128` once
  mapped — checked and true on 2.1.245 and on all six 2.1.246 builds.
- **A source hash vouches for the bytecode beside it, and on 2.1.246 the bytecode WINS.** The hash
  exists so a module loaded from bytecode never has to page in its source text to hash it — so a
  module whose source is replaced while its recorded hash and bytecode are left alone runs its
  PRE-PATCH compiled form. Measured, on a pristine 2.1.246 darwin-arm64: rewriting all 1,659
  occurrences of `2.1.246` in the JavaScript source to the same-length `2.1.XXX`, leaving every
  bytecode range and source hash alone, re-signing, then `claude --version` → prints **`2.1.246`**.
  The identical edit with each touched module's bytecode, module info and source hash cleared →
  prints **`2.1.XXX`**. That matched pair is why `clodex patch` clears them.
  The bound on the risk is that JSC's cache key also carries the source LENGTH, so an edit that
  changes a module's length is rejected regardless. Every built-in clodex patch site clears that
  bar: the transforms change six chunks on a real 2.1.246 bundle and all six GROW, at every model
  count measured (1, 2 and 3 favourites). Do not quote the individual byte deltas — they scale with
  the configured model count. A SAME-LENGTH edit, which is exactly what a local patch may be, is the
  reachable case.

Rebuilding the blob from the module structs — which is what tweakcc's repack does — keeps the flags
and drops all of it. That is what broke `clodex patch` on 2.1.246 on every platform: see
`patcher.md`.

## The entry module's name is not stable (renamed in 2.1.229)

The bundle lived in a Bun data blob as one module among ~15 (see the code-split section above for
what changed in 2.1.242), and tweakcc finds it **by name**:
`/claude`, `claude`, `/claude.exe`, `claude.exe`, `/src/entrypoints/cli.js`, `src/entrypoints/cli.js`.

| Version | Entry module |
| --- | --- |
| 2.1.224, 2.1.226, 2.1.228 | `/$bunfs/root/src/entrypoints/cli.js` |
| 2.1.229, 2.1.231–2.1.234, 2.1.241–2.1.243 | `/$bunfs/root/cli` |

(2.1.228 is the last release clodex's pinned tweakcc 4.3.0 — and clodex's own mirrored copy of its
name list — can discover, and 2.1.230 was never published for any platform package, so 2.1.229 is
where the rename actually landed. Confirmed on linux-x64 and darwin-arm64.)

2.1.229 and later match none of them, so `readContent` threw and every patch failed with
"Failed to extract JavaScript from native installation" — which reads like the `node-gyp-build`
packaging fault described in `patcher.md` and is not it. tweakcc carried the old list through
4.3.2; **4.3.3** added `/cli`, but clodex mirrors the list itself and is still pinned to 4.3.0, so
`src/bun-entry-module.ts` works around it; see `patcher.md`.

Two things that are easy to assume wrongly about the blob:

- **Every JavaScript module also carries Bun bytecode** (`// @bun @bytecode`) — ~190 MB on the
  single-module releases, a few hundred KB per chunk since the split — and the write preserves it
  verbatim for every module clodex did not patch. (A module clodex DOES patch has its bytecode
  range cleared, because since Bun 1.4.1 the recorded source hash would otherwise vouch for it.)
  It does **not** win over the patched source — a canary injected
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

## The shared child-environment builder (verified 2.1.221, re-verified 2.1.239)

The shared child-env builder — `pH()` in 2.1.221, with 14 call sites there and 16 in every 2.1.239
build. The split that matters for bridge isolation:

**Its minified name, its declarator list and its statements change release to release, and the
name is not even stable across one release's eight platform builds** — `pH()` in 2.1.221,
`XH()` in 2.1.224, `$M()` in 2.1.226, `o1()` in 2.1.228, which also hoisted the settings-colour
env into its own binding (`r=<mod>.settingsColorEnv`) inside the opening `let`,
`YR()`/`JP()`/`YI()` across the builds of 2.1.238, and `nO()`/`nL()`/`rO()`/`nP()` across the
builds of 2.1.239, which moved the agent-proxy env behind a registry lookup
(`sUn.of(lr().host)`), turned the settings-colour binding into a **destructuring** declarator
(`{settingsColorEnv:n}=e`), added a second computed deny list, and **deleted** the GitHub-Actions
`INPUT_${…}` scrub from the tail entirely. That is why PATCH 10's anchor identifies the function
by landmarks inside its body that survive all of that — the `CLAUDE_CODE_REMOTE` ternary, the
passthrough early-out `)return process.env;let <copy>={` (counted across the whole bundle), the
back-referenced `return <copy>}` tail, and the required-literal, nested-function and brace-balance
checks — rather than by counting bindings or by naming a statement upstream is free to delete.

**Two paths overlay the child env AFTER PATCH 10's restore, and neither is inside the builder.**
The merge is `{...<restored>,...<settingsColour>,...<agentProxy>,...<remote>}`, so the agent-proxy
helper wins over the reverted values. Its active branch returns Claude Code's own proxy and is
meant to be authoritative. Its **disabled fallback** is the one to know about: gated on ambient
`HTTPS_PROXY && SSL_CERT_FILE`, it copies the live ambient proxy variables forward — and under
clodex the ambient `HTTPS_PROXY` *is* the injection, so the bridge URL reaches the child. Verified
by executing the real helper against the patched builder on every 2.1.238 and 2.1.239 build.
Reachability is nil from clodex alone: the helper is only registered under `CLAUDE_CODE_REMOTE`, and
clodex sets neither that nor `SSL_CERT_FILE` (it sets only `HTTPS_PROXY`, `HTTP_PROXY` and
`NODE_EXTRA_CA_CERTS`), so both gates need the user's own environment. It is **not** fixable by
moving PATCH 10's anchor — the gate and the copy both read `process.env` outside the builder's
matched span — and would need its own patch site or a launch-side guard.

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
