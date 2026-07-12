# Gemini CLI with relay-ai (Experimental)

Use the **Google Gemini CLI** with models from your relay-ai registry — Anthropic, xAI, Google Gemini, Nvidia, DeepSeek, OpenAI, and more. *Note: Gemini CLI integration is currently experimental.*

| Command | What it launches | Config target |
|---------|------------------|---------------|
| **`relay-ai gemini`** | Gemini **terminal** (TUI / Prompt loop) | Ephemeral proxy port via environment variables |

The command uses the registry (`~/.relay-ai/providers.json`) and the same provider picker as Claude Code and Codex. The CLI uses Google's native Gemini format endpoints when possible, and a local API translation proxy for other models (Anthropic, OpenAI-compatible, etc.).

**Full flag reference:** `relay-ai gemini --help`. This guide explains *how it works* and *how to use it*.

**Agent / alef-agent integration** (boot flags, NDJSON streaming): see **[AI-AGENTS.md](AI-AGENTS.md)** or run `relay-ai --ai`.

---

## Prerequisites

1. **relay-ai** installed on your PATH (`npm install -g @jacobbd/relay-ai`, or built locally).
2. **At least one provider** in the registry:
   ```bash
   relay-ai providers add
   # or: relay-ai providers import
   ```
3. **Gemini CLI installed:**
   ```bash
   npm install -g @google/gemini-cli
   ```

**Supported:** Registry providers plus OpenCode Zen/Go cloud backends all route through relay-ai's translation layer if they don't natively speak Gemini format.

---

## How it works

The Gemini CLI uses the **Gemini API format** (`POST /v1beta/models/:model:generateContent`). When you select a non-Google provider, relay-ai spins up a local translation proxy:

```
Gemini CLI  →  relay-ai Proxy (127.0.0.1, Tier 2)  →  Vercel AI SDK  →  Anthropic / xAI / OpenAI / …
Gemini CLI  →  Google directly (Tier 1, Google API only)
```

Your real API keys stay in relay-ai (keychain / registry). The proxy securely handles them in memory for the session.

---

## Quick start

```bash
relay-ai gemini
```

Pick provider → pick model → Gemini prompt loop opens. relay-ai automatically points the Gemini CLI at the translation proxy.

### relay-ai flags

| Flag | Purpose |
|------|---------|
| *(none)* | Interactive launch |
| `--trace` | Write debug logs to `~/.relay-ai/logs/gemini-proxy-debug.log` |
| `--help` | Help text |

relay-ai **manages** `--provider` and `--model`. You can pass other Gemini CLI flags directly:

```bash
relay-ai gemini -p "Analyze this"
relay-ai gemini --provider google --model gemini-2.5-flash -p "Review this file" -o stream-json
```

### Environment isolation

When you launch, relay-ai builds a clean child environment:

1. Removes conflicting env vars from the child process.
2. Sets `GOOGLE_API_KEY` to the proxy placeholder and configures endpoint discovery via `GEMINI_API_BASE_URL`.
3. Sets `GEMINI_MODEL` to the selected model.

When the Gemini CLI exits (normal exit, Ctrl+C, terminal close), your shell is unchanged.

### Favorites catalog mode

When you have saved favorites via `relay-ai models`, `relay-ai gemini` will show your starting model + favorites in the mid-session model picker natively.

---

## Provider routing

| Provider | Route | Notes |
|----------|-------|-------|
| **Google** | Tier 1 direct | SDK adapter bypass for pure Gemini performance |
| **Anthropic, xAI, OpenAI, Nvidia, DeepSeek, …** | Tier 2 proxy | Local translation proxy converts Gemini format requests to the respective native formats via Vercel AI SDK |
| **OpenCode Zen / Go** | Tier 2 proxy | Requires an OpenCode API key |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Provider missing in picker | `relay-ai providers add` |
| Model errors / disconnected | Run `relay-ai gemini --trace` to view proxy logs in `~/.relay-ai/logs/gemini-proxy-debug.log` |
| JSON parse error on first stdout lines (agents) | Missing `-o stream-json` or `-o json` when running in agent mode |

### Known Limitations

- **Model name does not switch:** The model name displayed in the top right corner of the Gemini CLI UI does not automatically switch/update after we do the `.model_name` change mid-session. This is a known UI limitation with the Gemini CLI.

## See also

- [Gemini CLI NPM package](https://www.npmjs.com/package/@google/gemini-cli)
- [AI Agents & alef-agent](AI-AGENTS.md)
- `relay-ai gemini --help`
