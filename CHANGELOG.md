# Changelog

## [0.2.7] - 2026-06-19 (Official Launch Release)

### Added
- **Native provider registry** — Add, list, remove, refresh, and import providers with secure OS credential storage and templates for OpenRouter, Groq, Mistral, Together AI, Zen/Go, and SDK-backed custom endpoints.
- **Claude Code launcher** — Launch registry models through `relay-ai claude`, including provider/model boot flags, local OpenCode provider discovery, recent models, search, pagination, and favorites catalogs for mid-session switching.
- **Codex CLI launcher** — Launch the Codex terminal with registry providers via `relay-ai codex`.
- **Codex App launcher** — Launch the Codex desktop app with registry providers via `relay-ai codex-app`. Preserves existing conversation history by keeping Codex's built-in OpenAI provider identity; routes the selected model through a foreground local Responses proxy. Supports `--trace` for proxy debug logging.
- **Unified SDK gateway** — Route non-Anthropic providers through the Vercel AI SDK adapter while preserving Anthropic-compatible tool use, streaming, context windows, and model catalogs.
- **Claude Desktop integration** — Launch Claude Desktop in third-party provider mode with automatic configuration backup and restore.
- **Foreground server gateway** — Run `relay-ai server` for Claude Desktop or LAN usage, with registry-backed routing, password protection, and optional Vertex AI support.
- **Reasoning capability metadata** — Resolve reasoning controls from provider metadata, including OpenRouter `supported_parameters`, so models receive compatible reasoning options.
- **Favorites catalogs** — Save up to 20 models and switch mid-session in Claude Code (`/model`) and Codex.
- **First-run setup** — Configure providers from an inline wizard or import existing OpenCode provider settings.
- **Complete command help** — Every top-level command fully documented, including `codex-app`, `claude-app`, Vertex, restore, config, trace, and agent-reference flags.
- **Agent / headless launch** — Boot flags (`--provider`, `--model`), clean NDJSON/JSONL stdout, and `relay-ai --ai` reference for scripts and alef-agent.
