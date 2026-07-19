# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**clodex** bridges Claude Code to OpenAI models — OpenAI API key (`openai`) or ChatGPT/Codex-plan OAuth (`openai-oauth`). It is a trimmed fork of relay-ai (full commit history preserved). Prime directive of the fork applies to future work too: the translation, caching, auto-compaction, and OAuth-continuation code took extensive real-world testing — prefer surgical changes over restructuring.

## Release workflow

Publishing is automated by GitHub Actions (`.github/workflows/publish.yml`): **pushing a `v*` tag** runs typecheck + tests + build, then `npm publish` (auth via the `CLODEX_NPM_TOKEN` repo secret) and creates a GitHub Release from the matching `CHANGELOG.md` section. **Do NOT run `npm publish` locally.**

```bash
# 1. Land all code changes and a CHANGELOG.md "## [x.y.z]" section first (committed).
npm version patch --no-git-tag-version   # bump package.json + package-lock
npm run build                            # rebuild dist — VERSION derives from package.json
git add -A && git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push --follow-tags
```

`package.json` is the single source of truth for the version (`src/constants.ts::VERSION` reads `pkg.version`). Never hardcode a version string anywhere. `dist/` is committed, so rebuild it in the release commit.

## Commands

```bash
npm run build       # compile TypeScript → dist/cli.js (tsup, ESM, shebang injected)
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run dev         # watch mode

npx vitest run tests/patcher.test.ts    # single test file

# Manual testing (after npm run build; npm link once)
clodex --help
clodex claude --dry-run     # full wizard, preview instead of launch, no writes
clodex claude --trace       # debug logs to ~/.clodex/logs/
clodex models --list        # print clodex:<provider>:<model> names + aliases
clodex patch                # patch the Claude Code binary (see Patcher below)
clodex server               # foreground gateway
```

**`claude -p` end-to-end tests are manual only — NEVER add them to the automated test suite.**

## Architecture

**Entry point:** `src/cli.ts` — arg parsing (`parseArgs`, `consumeBridgeModeFlag`), help texts, and dispatch for `claude`, `server`, `models`/`favorites`, `providers`, `patch`. Every other module is a focused unit with no side effects at import time.

**Two bridge modes** (both `clodex claude` and `clodex server`):

- **endpoint** — local Anthropic-format gateway (`src/proxy.ts` for the claude launch path, `src/server/` for the standalone gateway); the child gets `ANTHROPIC_BASE_URL` via `buildChildEnv()` (`src/env.ts`). With favorites, `startProxyCatalog()` serves a multi-route catalog and Claude Code's `/model` menu lists starting model + favorites.
- **proxy** — selective MITM of `api.anthropic.com` (`src/http-proxy/`): Claude Code keeps its normal Anthropic auth; request model ids matching `clodex:{provider}:{model}` (prefix constant `HTTP_PROXY_MODEL_PREFIX` in `src/http-proxy/routes.ts`) or saved aliases (`src/model-aliases.ts`) route to OpenAI; everything else passes through untouched. `--http-proxy` is a kept alias of `--proxy`.

**Bridge-mode memory:** `resolveBridgeMode(command, explicit, {persist})` in `src/config.ts` — `claudeBridgeMode`/`serverBridgeMode` prefs; an explicit `--endpoint`/`--proxy` is persisted per command (claude skips persisting on `--dry-run`).

**Translation layer** (`src/sdk-adapter.ts` + `src/provider-factory.ts`): Anthropic `/v1/messages` ↔ Vercel AI SDK, one turn per request (Claude Code owns the tool loop). This is the **single** translation path — no hand-rolled per-provider translation. Preserved hard-won behavior:

- Inline `role:'system'` messages remain in their original conversation positions so volatile reminders do not invalidate the stable prompt prefix.
- On public-API OpenAI GPT-5.6+ routes, Anthropic `cache_control` blocks become explicit OpenAI cache breakpoints. ChatGPT/Codex OAuth sends a hashed Claude session-derived `prompt_cache_key` and strips Claude Code's volatile billing-attribution header from instructions, but omits `prompt_cache_options` and explicit breakpoints — those produced successful-but-empty OAuth responses in testing.
- Cache reads and GPT-5.6 cache writes map to Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens`.
- `streamAnthropicResponse` maps SDK events to Anthropic SSE, aborting after 120s without an event.
- `modelPrefersResponsesApi()` (`provider-factory.ts`) selects `provider.responses(id)` for models that require the Responses API (GPT-5.4+, GPT-5.5, `*-codex`, o-series); `provider.chat(id)` otherwise. Originator string is `clodex`.

**OpenAI OAuth WebSocket continuation** (`src/oauth/responses-websocket.ts`): all ChatGPT/Codex OAuth Responses models use a persistent WebSocket transport. Connections are partitioned by provider, OAuth account, upstream model, normalized effort, and hashed Claude session. Completed responses become validated chain heads (exact text/tool/reasoning capture; function-call args compared as canonical JSON); the next request picks the longest exact-prefix head and sends `previous_response_id` + incremental input; any mismatch/failure/expiry falls back safely to full context, and `previous_response_not_found` retries once with full context before anything is emitted downstream. OAuth requires `store:false` (a `store:true` probe returns HTTP 400). **Do not restructure this file.**

**Auto-compaction / alias response-model echo (critical):** the proxy-mode MITM layer forwards request bodies **unrewritten** so responses echo the exact model id the client sent. Claude Code resolves context windows from the response `model` field but uses the request alias for preflight — substituting the canonical id in responses made patched/alias ids miss their window config, auto-compact never fired, and agents died with "Prompt is too long". Endpoint mode's synthetic `GET /v1/models` returns `context_window` per model so the status bar is accurate.

**Critical URL constraint:** Anthropic-passthrough base URLs must NOT include `/v1` — the Anthropic SDK appends `/v1/messages` itself.

**Provider registry** (`src/registry/`): only two providers exist — templates in `src/provider-templates.ts` (`openai` API-key template with `https://api.openai.com/v1`, and `openai-oauth`). `provider-auth.ts` implements the OpenAI device-code OAuth flow; `refresh-models.ts` fetches the model list (3-tier fetch for OAuth). `io.ts::loadRegistry` and `config.ts::readConfig` both trigger the one-time legacy migration. Materialization (`materialize.ts`) turns registry providers into `LocalProvider`s with per-model `npm`/`baseUrl`/`upstreamModelId`.

**Config & migration** (`src/paths.ts`, `src/config.ts`, `src/env.ts`):

- Config home `~/.clodex`, override `CLODEX_HOME`. `ensureLegacyAppHomeMigrated()` silently copies a legacy `~/.relay-ai` (skipping `logs/`) on first read — **never mutates the legacy directory**.
- Keychain service `clodex` with per-account fallback read from legacy service `relay-ai` (copied into `clodex` on first hit). Chunked-entry support retained for Windows credential size limits.
- Preferences: `lastModel`, `lastProvider`, `recentModelsByProvider`, `favoriteModels`, `modelAliases`, `claudeBridgeMode`, `serverBridgeMode`, `appPathOverrides`, `recentLaunchFolders`, `server*` settings. All writes skipped when `dryRun`.
- `CLODEX_CLAUDE_PATH` overrides Claude Code binary discovery (`src/launch.ts`).

**Patcher** (`src/patcher.ts` + `src/patch-script-template.ts`): `clodex patch` drives `npx tweakcc adhoc-patch --script @file --confirm-possible-dangerous-patch` to bake favorites + aliases into the Claude Code binary (model validation, `/model` listing, alias→real-id resolution, context windows via a `/*ccpatch:ctx*/`-marked map). Key invariants:

- `buildDesiredPatchConfig()` is disk-only (preferences + registry models cache — no network, no credentials).
- `computePatchConfigHash` = sha256 of the key-sorted `[key, alias??null, context??null]` array; manifest at `~/.clodex/patch-state.json` (binary path, claude version, config hash, patched size/sha256, backup path) drives `evaluatePatchState` → `unpatched | current | stale-config | stale-binary`.
- **Never patch on top of a patch:** restore first whenever the pristine backup (`~/.tweakcc/claude-<ver>.orig`, tweakcc-compatible) differs from the current binary — regardless of what the manifest says.
- Binary resolution bypasses PATH shims (cmux installs a shim copy): `TWEAKCC_CC_INSTALLATION_PATH` → `~/.local/bin/claude` → `findClaudeBinary()`.
- Concurrency lock `~/.clodex/patch.lock` (pid + 10-min staleness + ESRCH liveness); the loser skips with a notice — never blocks, corrupts, or double-patches.
- `runLaunchPatchCheck()` in `clodex claude`: interactive y/N offer when stale; non-TTY or `--dry-run` prints a one-line stderr notice and proceeds. Wrapped in try/catch — a patch-check failure must never break launch.
- Context is omitted from the patch map when unknown or equal to Claude Code's 200k default; `[1m]`-suffixed model ids and explicit context are mutually exclusive in the patch script.

**Server** (`src/server/`): `index.ts` loads models from the registry (`loadServerModels`), `router.ts` handles `/anthropic` (Anthropic-format; passthrough for `modelFormat:'anthropic'` with `baseUrl`, SDK adapter for `'openai'`) and `/openai/v1` (OpenAI-format via `src/openai-adapter.ts`). Wizard/quick-start settings persist to config; network mode requires a password; default port 17645 (`--port` overrides).

**Env isolation** (`src/env.ts`): `buildChildEnv()` copies `process.env`, deletes conflicting `ANTHROPIC_*`/related vars, sets `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` for the child only. Claude Code may persist the model to `~/.claude/settings.json` itself; outside clodex's control (reset with `claude --model sonnet`).

**Tests** (`tests/`): pure functions only — adapter, provider factory, proxy, http-proxy routes, registry, config/migration, bridge-mode persistence, patcher (config building, hash stability, manifest staleness, lock behavior, patch-script rendering/syntax), help text. Interactive launch flow and real-provider behavior are verified manually.

## Key constraints

- `~/.claude/settings.json` is never touched by clodex. Launch config is env-var-only (plus `--model`), child process only.
- `--dry-run` skips all writes (including bridge-mode persistence).
- The `::ts::` separator in tool_use ids encodes reasoning signatures for round-tripping; would only break if a signature literally contained `::ts::`.
- In endpoint switch-menu mode the displayed context window reflects the **launch** model and does not update on live `/model` switch (Claude Code fetches `/v1/models` once at startup). Proxy mode + `clodex patch` reports correct per-model windows.
- Cost display in Claude Code is always inaccurate for OpenAI models (Claude Code applies its own pricing table).
- `MAX_MODEL_CATALOG = 20` (`constants.ts`) — favorites cap and max catalog routes.
- OpenAI catalog ids may differ from upstream API ids — `upstreamModelId` carries the real API id.
