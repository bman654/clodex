# Codex with relay-ai

Use **OpenAI Codex** (terminal CLI or desktop app) with models from your relay-ai registry — Anthropic, xAI, Google Gemini, Nvidia, DeepSeek, OpenAI, and more.

| Command | What it launches | Config target |
|---------|------------------|---------------|
| **`relay-ai codex`** | Codex **terminal** (TUI) | Temporary sidecar profile — never touches your main Codex config |
| **`relay-ai codex-app`** | Codex **desktop app** (macOS / Windows) | Patches `~/.codex/config.toml` with backup; restored on Ctrl+C |

Both commands use the same registry (`~/.relay-ai/providers.json`), the same provider picker, and the same routing (OpenAI direct vs local Responses proxy for everything else).

**Full flag reference:** `relay-ai codex --help` and `relay-ai codex-app --help`. This guide explains *how it works*, *what files are touched*, and *how to recover*.

**Agent / alef-agent integration** (boot flags, NDJSON, `exec --json`): see **[AI-AGENTS.md](AI-AGENTS.md)** or run `relay-ai --ai`.

---

## Prerequisites

1. **relay-ai** installed on your PATH (`npm install -g @jacobbd/relay-ai`, or built locally with `npm run build && npm link`).
2. **At least one provider** in the registry:
   ```bash
   relay-ai providers add
   # or: relay-ai providers import
   ```
3. **Codex installed:**
   - **CLI:** `npm install -g @openai/codex` (required for `relay-ai codex`)
   - **Desktop app:** [Codex for macOS or Windows](https://developers.openai.com/codex/cli) (required for `relay-ai codex-app`)

**Supported in Codex:** registry providers plus OpenCode Zen/Go cloud backends route through relay-ai's local Responses proxy.

---

## How it works (both commands)

Codex speaks the **OpenAI Responses API** (`POST /v1/responses`). Most registry providers do not. relay-ai bridges the gap:

```
Codex  →  relay-ai Responses proxy (127.0.0.1, Tier 2)  →  Vercel AI SDK  →  Anthropic / xAI / Gemini / …
Codex  →  OpenAI directly (Tier 1, OpenAI only)
```

| Tier | Providers | What relay-ai does |
|------|-----------|-------------------|
| **Tier 1 — Direct** | OpenAI (API key or ChatGPT OAuth) | Points Codex at OpenAI; no local proxy |
| **Tier 2 — Proxy** | Anthropic, xAI, Gemini, Nvidia, DeepSeek, most others | Local HTTP server translates Responses ↔ upstream SDK |

Your real API keys stay in relay-ai (keychain / registry). The proxy holds them in memory for the session.

---

## Codex CLI (`relay-ai codex`)

### Quick start

```bash
relay-ai codex
```

Pick provider → pick model → Codex TUI opens. relay-ai runs:

```bash
codex --profile relay-ai-launch -m <model-id>
```

### relay-ai flags

| Flag | Purpose |
|------|---------|
| *(none)* | Interactive launch |
| `--restore` | Remove leftover relay-ai CLI files after a crash |
| `--config` | Write profile + catalog to disk, print paths, exit (no Codex launch) |
| `--help` | Help text |

relay-ai **manages** `--profile` and `-m` / `--model`. Sandbox defaults to `danger-full-access`; pass other Codex flags directly:

```bash
relay-ai codex -s workspace-write
```

You do **not** need `--` before `-s`.

### Files relay-ai owns (CLI)

| File | Purpose |
|------|---------|
| `~/.codex/relay-ai-launch.config.toml` | Temporary profile for this session |
| `~/.relay-ai/codex/models-<provider>.json` | Model catalog |
| `~/.relay-ai/codex/session.json` | Session lock (one CLI session at a time) |

relay-ai **never edits** `~/.codex/config.toml` for CLI launches. Your personal Codex settings (sandbox, approvals, etc.) stay in that file and still apply.

### Cleanup (CLI)

| Situation | What happens |
|-----------|----------------|
| Normal exit (Codex quits, including Ctrl+C in Codex) | relay-ai removes overlay files automatically |
| Crash / closed terminal / force-quit | Files may remain; next launch auto-recovers when possible |
| Manual cleanup | `relay-ai codex --restore` |

You’ll see a **Cleanup** note before launch and a short message after exit.

### What relay-ai injects (CLI)

| Variable | When | Why |
|----------|------|-----|
| `RELAY_AI_CODEX_KEY=proxy-local` | Tier 2 only | Placeholder so Codex hits the local proxy; real key stays in the proxy |
| `OPENAI_API_KEY` (etc.) | Tier 1 OpenAI | Codex calls OpenAI natively |

relay-ai **strips CI-related env vars** (`CI`, `CODEX_CI`, `GITHUB_ACTIONS`, …) before spawning Codex so IDE terminals don’t accidentally force read-only CI mode.

**Not from relay-ai:** `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, etc. — those are set by Codex when it runs shell commands. `RELAY_AI_CODEX_KEY` does **not** control sandbox policy.

### Sandbox and network (CLI)

Two layers people confuse:

1. **Codex’s sandbox** — shell commands inside Codex (files, network, approvals). Lives in `~/.codex/config.toml` and Codex CLI flags.
2. **relay-ai’s proxy** — model API traffic only.

**relay-ai codex defaults to `danger-full-access`** — the launch profile and spawn args both set it so shell tools (`curl`, `nlm`, npm, MCP CLIs) can reach the network without you passing `-s` every time. Override for one session:

```bash
relay-ai codex -s workspace-write
```

relay-ai **does not** edit your personal `~/.codex/config.toml` for CLI launches. To change sandbox for bare `codex` (without relay-ai), edit that file yourself:

```toml
sandbox = "danger-full-access"
ask_for_approval = "never"

[shell_environment_policy]
inherit = "all"
```

On macOS, profile TOML alone may not be enough; relay-ai also passes `-s danger-full-access` on spawn ([Codex #10390](https://github.com/openai/codex/issues/10390)).

---

## Codex desktop app (`relay-ai codex-app`)

### Quick start

```bash
relay-ai codex-app
```

Pick provider → pick model → Codex **app** opens. **Keep the relay-ai terminal open** until you’re done (Tier 2 needs the foreground proxy). Press **Ctrl+C** to stop the proxy and restore your previous Codex config.

**Platforms:** macOS and Windows. Linux is not supported (no Codex desktop app).

### relay-ai flags

| Flag | Purpose |
|------|---------|
| *(none)* | Interactive launch + open app |
| `--restore` | Restore `config.toml` and remove relay-ai app files |
| `--config` | **Preview only** — print TOML that would be written; no disk writes, no app, no proxy |
| `--help` | Help text |

**`--config` note:** Skips the picker. Uses your last Codex provider/model from prefs (or the first compatible provider). The proxy port shown (`54321`) is a **placeholder**; a real launch uses a random port.

### Files relay-ai owns (App)

| File | Purpose |
|------|---------|
| `~/.codex/config.toml` | **Patched while session is active** — restored on Ctrl+C or `--restore` |
| `~/.relay-ai/codex/app-models-<provider>.json` | Model catalog (all routable models for that provider) |
| `~/.relay-ai/codex/session-app.json` | App session lock |
| `~/.relay-ai/codex/app-restore-state.json` | Snapshot of your pre-session root keys (for surgical restore) |
| `~/.relay-ai/codex/backups/config.toml.*.bak` | Rotating file backups before each patch |

CLI files (`relay-ai-launch.config.toml`, `session.json`, `models-*.json`) are **separate**. Running CLI after app (or vice versa) should not break the other.

### What gets written to `config.toml`

Example (Tier 2 / proxy):

```toml
model = "claude-sonnet-4-6"
model_provider = "relay-ai-launch-codex-app"
model_catalog_json = "/Users/you/.relay-ai/codex/app-models-anthropic.json"

[model_providers.relay-ai-launch-codex-app]
name = "Claude Sonnet 4.6 · Anthropic"
base_url = "http://127.0.0.1:<random-port>/v1"
wire_api = "responses"
```

The provider `name` and catalog `display_name` use human-readable labels (e.g. `Claude Haiku 4.5`). The Codex app bar may still show **Custom** for registry providers — see troubleshooting below.

Tier 1 OpenAI adds `env_key = "OPENAI_API_KEY"` and points `base_url` at OpenAI.

### Cleanup (App)

| Situation | What to do |
|-----------|--------------|
| Normal end of session | **Ctrl+C** in the relay-ai terminal → config restored, proxy stopped |
| Codex already running | relay-ai asks to **restart Codex** so new settings apply; you can decline and reopen manually |
| Crash / killed terminal | Next launch auto-recovers when possible, or `relay-ai codex-app --restore` |
| Live session still running | `--restore` refuses until you Ctrl+C the other terminal |

### App vs CLI — config safety

| | CLI | App |
|--|-----|-----|
| Touches `~/.codex/config.toml`? | **Never** | Yes, with backup + restore |
| Proxy lifetime | Until Codex CLI exits | Until **Ctrl+C** in relay-ai terminal |
| Picker every launch? | Yes (prefs pre-highlight last choice) | Yes |

---

## Favorites catalog mode

When you have saved favorites via `relay-ai models`, both `relay-ai codex` and `relay-ai codex-app` will show your starting model + favorites in the mid-session model picker. Zen/Go favorites are included when an OpenCode API key is available.

### Slug policy

- **CLI** (`relay-ai codex`): slugs are `${providerId}__${modelId}` so models from different providers never collide.
- **App** (`relay-ai codex-app`): slugs are prefixed with `relay-ai-launch-codex-app/` (per `codexAppModelSlug`). The two schemes are distinct on purpose.

### Authentication

The launched Codex child gets `OPENAI_API_KEY=proxy-local`, not your real upstream key. The local Responses proxy at `127.0.0.1:<port>` holds the real credentials. This is the same placeholder as single-provider Codex.

### Reasoning effort

The reasoning-effort slider in the Codex picker is shown only for models with a resolver-backed controllable reasoning profile. OpenRouter uses provider metadata (`supported_parameters`) when available; generic `@ai-sdk/openai-compatible` providers stay hidden unless relay-ai has a verified provider rule.

### Proxy warm-up

With 20 favorites spanning many providers, the first request after launch may be slow as the proxy initializes one `LanguageModel` per favorite. This is a known characteristic; subsequent requests are fast.

---

## Provider routing (shared)

| Provider | Route | Notes |
|----------|-------|-------|
| **OpenAI** | Tier 1 direct | `relay-ai providers auth openai` for ChatGPT OAuth |
| **Anthropic, xAI, Gemini, Nvidia, DeepSeek, …** | Tier 2 proxy | Anthropic showcase path for Codex |
| **OpenCode Zen / Go** | Tier 2 proxy | Requires an OpenCode API key |

Add providers with `relay-ai providers add` or import from OpenCode.

---

## OAuth

Tokens (e.g. xAI, OpenAI OAuth) refresh at **launch only**. Long sessions may return 401 when a token expires. Restart `relay-ai codex` or `relay-ai codex-app`.

---

## Reasoning effort

Codex exposes a **reasoning effort** picker when relay-ai's model catalog includes supported levels. relay-ai fills `supported_reasoning_levels`, `default_reasoning_level`, and `supports_reasoning_summaries` from the centralized reasoning resolver, using provider metadata first and provider-specific rules second.

**You control effort in Codex's native UI** — relay-ai does not add its own menu. For `relay-ai codex-app`, an existing `model_reasoning_effort` in `~/.codex/config.toml` is **preserved** (not deleted on launch).

### Supported models (best-effort)

| Provider npm | Example models | Picker levels | Wire mapping |
|--------------|----------------|---------------|--------------|
| `@ai-sdk/anthropic` | claude-sonnet-4-6, claude-opus-4-6 | low, medium, high | SDK `thinking: adaptive` + `effort` |
| `@ai-sdk/openai` | gpt-5.5, gpt-5.4-codex | low, medium, high, xhigh | `reasoningEffort` on Responses API |
| `@ai-sdk/google` | gemini-2.5-pro, gemini-3-flash | low, medium, high | Gemini 2.5 → token budget; Gemini 3 → `thinkingLevel` |
| `@ai-sdk/mistral` | mistral-large, magistral-* | **high, off only** | `reasoningEffort: high \| none` |
| `@ai-sdk/xai` | grok-* | none, low, medium, high | `reasoningEffort` |
| `@openrouter/ai-sdk-provider` | z-ai/glm-5.2, provider models with `reasoning` in `supported_parameters` | none, minimal, low, medium, high, xhigh | `providerOptions.openrouter.reasoning.effort` |
| `@ai-sdk/openai-compatible` | unknown backends | *(picker hidden)* | no effort sent |

**Partial support:** Mistral only supports on/off — relay-ai shows `high` and `off`, not low/medium. Gemini 2.5 uses token budgets under the hood; the picker labels are low/medium/high for UX consistency.

**Local providers:** Same heuristics apply. Unrecognized models (e.g. Ollama `llama3:8b`) get an empty picker — best-effort, no v1 guarantee.

**Claude Code / Desktop gateway:** `relay-ai claude` and `relay-ai server` map Claude Code's `/effort` (`output_config.effort`) to the same SDK options. Anthropic direct passthrough routes forward effort unchanged.

**App bar "Custom" label:** When using registry providers, Codex desktop may still show "Custom" in the app bar — see [Troubleshooting](#app-relay-ai-codex-app) below.

---

## Troubleshooting

### CLI (`relay-ai codex`)

| Symptom | Fix |
|---------|-----|
| Provider missing in picker | `relay-ai providers add` |
| Leftover files after crash | Next launch auto-cleans, or `relay-ai codex --restore` |
| “Another session running” | Wait or `--restore` |
| Shell tools have no network | Should be default; confirm with `relay-ai codex --config` (profile has `sandbox = "danger-full-access"`) or pass `-s danger-full-access` |
| Read-only / CI behavior | relay-ai strips CI vars; try Terminal.app outside IDE |
| `codex` not found | `npm install -g @openai/codex` |

### App (`relay-ai codex-app`)

| Symptom | Fix |
|---------|-----|
| App bar shows **"Custom"** not model name | Known [Codex desktop limitation](https://github.com/openai/codex/issues/19694) for third-party providers. relay-ai prints **Active model:** in the terminal and sets catalog `display_name` + provider `name` — trust the terminal line for what's running. |
| App didn’t open | Open Codex manually once, run `relay-ai codex-app` again |
| Model errors / disconnected | Keep relay-ai terminal open (proxy must run) |
| Stuck on relay-ai settings | `relay-ai codex-app --restore` |
| `--restore` blocked | Ctrl+C the other relay-ai codex-app terminal first |
| Wrong config after test | `--restore`; backups in `~/.relay-ai/codex/backups/` |

### Shared

| Symptom | Fix |
|---------|-----|
| Anthropic key rejected on `providers add` | Update relay-ai (Bearer vs `x-api-key` fix) |
| Model says relay-ai forced sandbox | Wrong — check Codex sandbox flags, not `RELAY_AI_CODEX_KEY` |

---

## See also

- [Codex advanced config](https://developers.openai.com/codex/config-advanced)
- [Codex agent approvals & security](https://developers.openai.com/codex/agent-approvals-security)
- [README — Codex sections](../README.md)
- `relay-ai codex --help` · `relay-ai codex-app --help`
