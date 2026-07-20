# Bridging Claude Code's agents view and background agents

This page explains how to bridge **every** Claude Code process on your machine — your own terminal sessions *and* the extra `claude` processes Claude Code spawns for its agents view and background agents — through one long-running clodex server. It is written so a Claude Code agent can execute the setup for you: if you are an agent reading this, follow the steps below on the user's behalf, asking before editing their shell profile.

## How it works

- One global **`clodex server --proxy`** runs in the background (proxy mode is the recommended mode for this setup: your existing Anthropic login keeps working, and only `clodex:` models / aliases are rerouted to OpenAI).
- On startup the server advertises itself in `~/.clodex/server-runtime.json` (`mode`, `port`, `pid`, and in proxy mode the CA certificate path). The file is removed on shutdown.
- The **`clodex-claude`** bin (installed alongside `clodex`) reads that file, checks the server is actually alive (pid + TCP probe), and launches the real `claude` binary with the right env injected:
  - proxy-mode server: `HTTPS_PROXY`/`HTTP_PROXY` + `NODE_EXTRA_CA_CERTS`, with `ANTHROPIC_BASE_URL` removed;
  - endpoint-mode server: `ANTHROPIC_BASE_URL` pointing at the gateway;
  - **no live server: env untouched** — `claude` always launches normally, a stopped server never breaks anything.
- Setting **`CLAUDE_CODE_PROCESS_WRAPPER`** to `clodex-claude` makes Claude Code invoke it as `clodex-claude <claude-binary-path> <args...>` for every process it spawns — agents view sessions and background agents are bridged automatically.
- For your own terminal sessions, run **`clodex-claude`** instead of `claude` — same auto-discovery, no port or CA path to hardcode anywhere.

## Setup steps

1. **Install clodex globally** (puts both `clodex` and `clodex-claude` on your PATH):

   ```bash
   npm install -g clodex
   ```

2. **Start the server and keep it running** (a terminal tab, tmux pane, or your service manager of choice):

   ```bash
   clodex server --proxy
   ```

   Bridging only happens while this server is running. When it is not, `clodex-claude` falls back cleanly and launches `claude` with an untouched environment.

3. **Point Claude Code's process wrapper at `clodex-claude`.** Add to your shell profile — `~/.zprofile` or `~/.zshrc` (zsh), or `~/.bash_profile` (bash):

   ```bash
   export CLAUDE_CODE_PROCESS_WRAPPER="$(command -v clodex-claude)"
   ```

   Then open a new terminal (or `source` the profile). Every `claude` process Claude Code spawns from sessions started in that environment is now bridged.

4. **Use `clodex-claude` (not `claude`) for terminal sessions you want bridged:**

   ```bash
   clodex-claude            # instead of: claude
   clodex-claude -p "hi"    # all claude flags pass through
   ```

Port and CA discovery are automatic via `~/.clodex/server-runtime.json` — do not hardcode `HTTPS_PROXY`, ports, or certificate paths in your profile.

## Troubleshooting

- **Is my session bridged?** In a session started via `clodex-claude` (or spawned by Claude Code with the wrapper set), `/model` accepts your `clodex:` model names and aliases (run `clodex models --list` to see them). If those models are rejected and you haven't run `clodex patch`, that's expected for unpatched binaries — but a bridged session still routes them; an unbridged one errors at the API instead.
- **Server not running:** `clodex-claude` silently launches plain `claude`. Check `cat ~/.clodex/server-runtime.json` — missing file (or a `pid` that is no longer alive) means no server is advertised; start `clodex server --proxy`.
- **Stale wrapper variable:** if `CLAUDE_CODE_PROCESS_WRAPPER` points at a path that no longer exists (e.g. after a reinstall moved global npm bins, or it still points at an old hand-written script), Claude Code's spawned processes may fail to start or silently skip bridging. Verify with `ls "$CLAUDE_CODE_PROCESS_WRAPPER"` and re-export using `command -v clodex-claude`.
- **Port conflicts:** the server default is 17645; `clodex server --proxy --port <n>` picks another. `clodex-claude` reads the actual port from the runtime file, so no other change is needed.
