# Bridging Claude Code's agents view and background agents

This page explains how to bridge **every** Claude Code process on your machine — your own terminal sessions *and* the extra `claude` processes Claude Code spawns for its agents view and background agents — through one long-running clodex server. It is written so a Claude Code agent can execute the setup for you: if you are an agent reading this, follow the steps below on the user's behalf, asking before editing their shell profile.

## How it works

- One global **`clodex server --proxy`** runs in the background (proxy mode is the recommended mode for this setup: your existing Anthropic login keeps working, and only `clodex:` models / aliases are rerouted to OpenAI).
- On startup the server adds its own record to `~/.clodex/server-runtime.json` (`mode`, `port`, `pid`, and in proxy mode the CA certificate path). The file holds one record per running server — several `clodex server` instances (say a proxy server for Claude Code plus a separate endpoint server for another tool) can be advertised at once — and each server removes only its own record on shutdown. Start a server with `--no-discovery` (or `CLODEX_NO_DISCOVERY=1`) to keep it out of the file entirely so `clodex-claude` never bridges to it.
- The **`clodex-claude`** bin (installed alongside `clodex`) reads that file, checks each server is actually alive (pid + TCP probe), picks one — proxy-mode servers are preferred over endpoint-mode (bridging keeps Claude Code's own auth), newest first within a mode — and launches the real `claude` binary with the right env injected:
  - proxy-mode server: `HTTPS_PROXY`/`HTTP_PROXY` + `NODE_EXTRA_CA_CERTS`, with `ANTHROPIC_BASE_URL` removed;
  - endpoint-mode server: `ANTHROPIC_BASE_URL` pointing at the gateway;
  - **no live server: env untouched** — `claude` always launches normally, a stopped server never breaks anything.
- Setting **`CLAUDE_CODE_PROCESS_WRAPPER`** to `clodex-claude` makes Claude Code invoke it as `clodex-claude <claude-binary-path> <args...>` for every process it spawns — agents view sessions and background agents are bridged automatically.
- For your own terminal sessions, run **`clodex-claude`** instead of `claude` — same auto-discovery, no port or CA path to hardcode anywhere.
- Set **`CLODEX_REQUIRE_SERVER=1`** in an isolated routed profile when bypassing Clodex must be impossible. `clodex-claude` then exits with an error if no advertised server passes its process and TCP checks. The default remains fail-open for ordinary installations.
- Proxy-mode wrapper launches remove Anthropic entries from the union of `NO_PROXY` and `no_proxy`, while preserving unrelated bypasses. The manual server output prints the same adjusted values for users who export the proxy settings themselves.

## Setup steps

1. **Install clodex globally** (puts both `clodex` and `clodex-claude` on your PATH):

   ```bash
   npm install -g @bman654/clodex
   ```

2. **Start the server and keep it running** (a terminal tab, tmux pane, or your service manager of choice):

   ```bash
   clodex server --proxy
   ```

   If the server prints `NO_PROXY` and `no_proxy`, export those adjusted values with the proxy and CA settings. Empty values intentionally clear inherited wildcard or Anthropic bypasses.

   Bridging only happens while this server is running. When it is not, `clodex-claude` falls back cleanly and launches `claude` with an untouched environment.

3. **Point Claude Code's process wrapper at `clodex-claude`.** This variable must hold a **literal absolute path that is valid in any environment** — see the Node version manager warning below before you pick it. Add to your shell profile (`~/.zprofile` / `~/.zshrc` for zsh, `~/.bash_profile` for bash):

   ```bash
   export CLAUDE_CODE_PROCESS_WRAPPER="$HOME/.local/bin/clodex-claude"
   ```

   Then open a new terminal (or `source` the profile) and confirm it resolves:

   ```bash
   echo "$CLAUDE_CODE_PROCESS_WRAPPER"                     # must be non-empty
   [ -x "$CLAUDE_CODE_PROCESS_WRAPPER" ] && echo OK        # must print OK
   ```

   Every `claude` process Claude Code spawns from sessions started in that environment is now bridged.

   > ### ⚠️ If you use a Node version manager (fnm, nvm, asdf, volta), read this
   >
   > Do **not** write `export CLAUDE_CODE_PROCESS_WRAPPER="$(command -v clodex-claude)"`. It fails in three separate ways:
   >
   > 1. **Profile ordering.** Version managers usually initialize in `~/.zshrc`, which runs *after* `~/.zprofile` for login shells. A `command -v` in `~/.zprofile` therefore finds nothing and silently exports an **empty string** — no error, just no bridging.
   > 2. **Ephemeral shim paths.** Some managers put the active binary in a per-shell directory (fnm's `.../fnm_multishells/<pid>_<timestamp>/bin`, for example). That path dies with the shell that created it, so a value captured at login is a dead path for anything spawned later. Others (nvm, asdf, volta) use a *version-specific* path that breaks the next time you upgrade Node.
   > 3. **Shebang PATH dependence.** The installed `clodex-claude` is a JS file with a `#!/usr/bin/env node` shebang, so it needs `node` **on PATH at spawn time**. If Claude Code is launched from a GUI context (Spotlight, Raycast, an IDE) rather than a terminal, PATH is minimal, `env node` fails, and the wrapper cannot start — which breaks spawning agents entirely.
   >
   > **Robust fix — a tiny launcher in a stable directory.** Create `~/.local/bin/clodex-claude` (any directory that never moves), make it executable with `chmod +x`, and point the variable at it. It resolves Node explicitly instead of trusting PATH:
   >
   > ```sh
   > #!/bin/sh
   > # Resolve node without depending on PATH, then run the real wrapper.
   > NODE="$HOME/.local/share/fnm/aliases/default/bin/node"   # fnm: stable, follows your default version
   > [ -x "$NODE" ] || NODE=node                              # fallback if that path is absent
   > exec "$NODE" "$(npm root -g)/@bman654/clodex/dist/claude-wrapper.js" "$@"
   > ```
   >
   > Replace the `NODE=` line with your manager's stable path — nvm: `"$NVM_DIR/alias/default"` names the version, so use `"$NVM_DIR/versions/node/$(cat "$NVM_DIR/alias/default")/bin/node"`; volta: `"$HOME/.volta/bin/node"`; asdf: `"$(asdf which node)"` captured once. Hardcode the resolved `npm root -g` path if you prefer not to shell out. Verify the result works even with no PATH:
   >
   > ```bash
   > env -i HOME="$HOME" PATH=/usr/bin:/bin ~/.local/bin/clodex-claude --version
   > ```
   >
   > That must print a Claude Code version. If it prints `env: node: No such file or directory`, the Node path in your launcher is wrong.

4. **Use `clodex-claude` (not `claude`) for terminal sessions you want bridged:**

   ```bash
   clodex-claude            # instead of: claude
   clodex-claude -p "hi"    # all claude flags pass through
   ```

Port and CA discovery are automatic via `~/.clodex/server-runtime.json` — do not hardcode `HTTPS_PROXY`, ports, or certificate paths in your profile.

For service-manager readiness checks, `clodex-claude --check` exits `0` when an
advertised server passes the process and TCP checks, and exits `1` otherwise.
It does not launch Claude.

## Troubleshooting

- **Is my session bridged?** In a session started via `clodex-claude` (or spawned by Claude Code with the wrapper set), `/model` accepts your `clodex:` model names and aliases (run `clodex models --list` to see them). If those models are rejected and you haven't run `clodex patch`, that's expected for unpatched binaries — but a bridged session still routes them; an unbridged one errors at the API instead.
- **Server not running:** `clodex-claude` launches plain `claude` by default. With `CLODEX_REQUIRE_SERVER=1`, it exits instead. Check `cat ~/.clodex/server-runtime.json` — a missing file (or records whose `pid` is no longer alive) means no server is advertised; start `clodex server --proxy`. If a server is running but absent from the file, make sure it was not started with `--no-discovery` / `CLODEX_NO_DISCOVERY=1`.
- **Wrapper variable empty or stale:** run `echo "$CLAUDE_CODE_PROCESS_WRAPPER"` in a **new login shell**. If it is empty, a `$(command -v ...)` in your profile ran before your Node version manager initialized (see the warning in step 3) — switch to a literal path. If it points at a path that no longer exists (a Node upgrade moved the global bin, an fnm/nvm shim directory expired, or it still names an old hand-written script), spawned processes fail to start or silently skip bridging. Verify with `[ -x "$CLAUDE_CODE_PROCESS_WRAPPER" ] && echo OK`.
- **Agents fail to spawn / `env: node: No such file or directory`:** the wrapper's `#!/usr/bin/env node` shebang could not find Node, typically because Claude Code was launched from a GUI (Spotlight, Raycast, an IDE) with a minimal PATH. Use the launcher script from step 3, which resolves Node by absolute path, and test it with `env -i HOME="$HOME" PATH=/usr/bin:/bin "$CLAUDE_CODE_PROCESS_WRAPPER" --version`.
- **Port conflicts:** the server default is 17645; `clodex server --proxy --port <n>` picks another. `clodex-claude` reads the actual port from the runtime file, so no other change is needed.
