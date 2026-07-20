# Changelog

## [1.0.0](https://github.com/bman654/clodex/compare/v0.1.1...v1.0.0) (2026-07-20)


### Documentation

* refine README wording and add proxy/agents tips ([614ea7d](https://github.com/bman654/clodex/commit/614ea7d7daf7e0a58eaa5c7341ad5e42c86751ef))

## [0.1.1](https://github.com/bman654/clodex/compare/v0.1.0...v0.1.1) (2026-07-20)


### Features

* **patch:** make short aliases the model identity and use real model labels ([1eda5f1](https://github.com/bman654/clodex/commit/1eda5f17468b9d71018c39e30f309f12e9faa444))
* **server:** multi-server discovery, --no-discovery opt-out, endpoint alias resolution ([cfe91f5](https://github.com/bman654/clodex/commit/cfe91f5ed08af0ebc36d150e2d8d67d44309d549))

## [0.1.0] - 2026-07-19

Initial release of **clodex**, a fork of the original relay-ai project, heavily modified and streamlined to do one thing: bridge Claude Code to OpenAI models (OpenAI API key and ChatGPT/Codex-plan OAuth). The full relay-ai commit history is preserved in this repository.

### Kept from relay-ai (battle-tested subsystems, unchanged)

- Anthropic ↔ OpenAI translation through the Vercel AI SDK adapter, including prompt-cache breakpoint mapping and cache-token accounting.
- ChatGPT/Codex OAuth Responses WebSocket continuation (`previous_response_id` incremental input with exact-prefix chain heads and safe full-context fallback).
- Endpoint bridge mode (local Anthropic-format gateway + `ANTHROPIC_BASE_URL`) with the multi-route favorites switch menu.
- Proxy bridge mode (selective `api.anthropic.com` MITM) with the alias response-model echo that keeps Claude Code's auto-compaction working.
- Favorites/alias management (`clodex models`) and the foreground gateway (`clodex server`, endpoint + proxy modes, `--port`).

### New in the fork

- Rebrand: `clodex` binary/package, `~/.clodex` config home (`CLODEX_HOME` override), `clodex:` model-id prefix, `clodex` keychain service — with silent one-time migration from legacy `~/.relay-ai` config and `relay-ai` keychain entries (legacy data is never modified).
- `clodex patch` — first-class Claude Code binary patcher built on tweakcc: bakes favorites + aliases into the binary (model validation, `/model` listing, alias resolution, real context windows), with a pristine per-version backup, a staleness manifest, a concurrency lock, and `--restore`.
- Launch-time patch freshness check in `clodex claude` (interactive y/N offer; non-blocking notice when non-interactive).
- Per-command bridge-mode defaults: `--endpoint`/`--proxy` select the mode for one run; `--save-mode` persists it as that command's default; bare runs default to proxy mode.

### Removed relative to relay-ai

All non-Claude-Code launch targets and non-OpenAI providers: the web UI, Codex/ChatGPT app and Gemini CLI launchers, Antigravity gateway, Claude Desktop setup, Vertex mode, OpenCode/Zen/Go backends and subscription tiers, and all other provider registries/templates.
