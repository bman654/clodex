# AGENTS.md

This file provides guidance to coding agents working in this repository.

**clodex** bridges Claude Code to OpenAI models (OpenAI API key or ChatGPT/Codex-plan OAuth). It is a trimmed fork of relay-ai with the full commit history preserved.

The complete architecture guide, hard-won constraints, release workflow, and testing rules live in [CLAUDE.md](CLAUDE.md) — read it in full before making changes. It applies to all agents, not just Claude Code.

## Quick reference

```bash
npm run build       # compile TypeScript → dist/cli.js (tsup, ESM)
npm test            # vitest
npm run typecheck   # tsc --noEmit
npx vitest run tests/patcher.test.ts   # single test file
```

## Non-negotiables (details in CLAUDE.md)

- Do not restructure the translation/caching/OAuth-continuation code (`src/sdk-adapter.ts`, `src/oauth/responses-websocket.ts`) — it encodes extensively field-tested behavior.
- The proxy-mode MITM must echo the exact requested model id in responses (auto-compaction depends on it).
- Anthropic-passthrough base URLs must NOT include `/v1`.
- `claude -p` end-to-end tests are manual only — never add them to the automated test suite.
- Never `npm publish` locally; releases are tag-driven CI.
