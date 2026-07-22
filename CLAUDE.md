# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**clodex** bridges Claude Code to OpenAI models — OpenAI API key (`openai`) or ChatGPT/Codex-plan OAuth (`openai-oauth`). It is a trimmed fork of relay-ai (full commit history preserved). Prime directive of the fork applies to future work too: the translation, caching, auto-compaction, and OAuth-continuation code took extensive real-world testing — prefer surgical changes over restructuring.

## Release workflow

Releases are managed by release-please from conventional commits. Write conventional commits, then push or merge them to `main`. The workflow has two jobs: a `test` job (typecheck + tests + build on Node 24 with pnpm) runs first on every push, and the `release` job `needs: test` — so nothing is tagged on a red build. release-please maintains a release PR that accumulates the generated changelog and `package.json` version bump; merging that release PR creates the `vX.Y.Z` tag and GitHub Release, then the release job rebuilds `dist/` and **stages** the npm release via trusted publishing (OIDC, `id-token: write` — no npm secret anywhere) with `npm stage publish`. (Tests gating the tag matters: an earlier design ran tests *after* release-please tagged, so a flaky test left a dangling `v1.0.1` tag with nothing on npm — the tag-then-test ordering is fixed.) Nothing goes live from CI: a maintainer must approve the staged version with 2FA — npmjs.com → package → "Staged Packages" tab → Approve, or `npm stage approve <stage-id>` (inspect first with `npm stage list` / `npm stage view` / `npm stage download`). **Do NOT run `npm publish` locally.** Manually pushing a `v*` tag no longer publishes anything; `.github/workflows/release-please.yml` is the only release path.

The release and commitlint CI jobs are guarded by `if: vars.CLODEX_PUBLISH_ENABLED == 'true'`. One-time setup in the dedicated repo (github.com/bman654/clodex): (1) the `@bman654/clodex` package (scoped — npm's name-similarity guard rejects unscoped `clodex`; `publishConfig.access: public` keeps publishes public) was created by a one-time manual `npm publish` of 0.1.0 from the repo (neither trusted publishing nor staging can do a package's *first* publish) — the sole exception to the no-local-publish rule, with the commit tagged `v0.1.0` and the release-please manifest set to `0.1.0` so the next release PR proposes 0.1.1+, (2) on npmjs.com configure the package's Trusted Publisher: GitHub Actions, owner `bman654`, repo `clodex`, workflow filename `release-please.yml`, and select the staging/publish action it offers, (3) set repository variable `CLODEX_PUBLISH_ENABLED=true`. No npm token secret is needed. The release workflow deliberately publishes in the release-please job because a tag created by the default `GITHUB_TOKEN` does not trigger another workflow.

**Commit cheat sheet:** `feat:` adds a feature, `fix:` fixes behavior, and `build:`, `ci:`, `docs:`, or `chore:` cover non-feature maintenance. Add `!` after the type/scope (for example `feat!:`) or a `BREAKING CHANGE:` footer for an incompatible change. Commitlint enforces this locally through Husky's `commit-msg` hook and in CI for pull-request/push commit ranges. Husky v9 was chosen for its small, standard `prepare`-based pnpm integration; setup exits successfully when `.git` is unavailable, so CI/non-git installs are not broken.

Version baseline: **0.1.0 was published manually** (see one-time setup above), so `.release-please-manifest.json` records `0.1.0`, the `v0.1.0` tag marks the released commit, and release-please's first PR proposes 0.1.1+ from commits after that tag. `bootstrap-sha` (a fallback used only if the release tag is missing) also fences off the inherited relay-ai/fork history so pre-fork commits are never scanned. Release-please's changelog updater prepends generated entries above the existing hand-written 0.1.0 fork entry, preserving that content rather than replacing it.

Before 1.0, `bump-patch-for-minor-pre-major` makes `feat:` bump patch, ordinary `fix:` also bumps patch, and `bump-minor-pre-major` makes `!`/`BREAKING CHANGE` bump minor (for example 0.1.x → 0.2.0). Once local testing is satisfactory, land a commit on `main` whose body contains `Release-As: 1.0.0` on its own line; the next release PR proposes exactly 1.0.0, then normal conventional-commit bumping resumes.

`package.json` is the single source of truth for the version (`src/constants.ts::VERSION` reads `pkg.version`). Never hardcode a version string anywhere. `dist/` is gitignored — `prepublishOnly` and release CI rebuild it; never commit build output.

## Toolchain

Development targets **Node 24** (`.nvmrc` pins v24.14.1; CI runs Node 24) while the published package still supports **Node >= 22** (`engines.node`) — don't use APIs newer than Node 22 in `src/`. Dev package manager is **pnpm**, pinned via `packageManager: "pnpm@10.34.5"` in package.json and activated with corepack (`corepack enable`). Dependencies are **exact-pinned** (no `^`/`~`). `pnpm-workspace.yaml` (pnpm 10's settings file) sets `minimumReleaseAge: 14400` — no direct or transitive dependency version younger than 10 days (value in minutes) can be resolved; already-locked versions install fine, but fresh resolution of a too-new version fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. End users still install with `npm install -g @bman654/clodex` — the dev PM does not affect consumers.

## Commands

```bash
pnpm build          # compile TypeScript → dist/cli.js (tsup, ESM, shebang injected)
pnpm test           # vitest
pnpm typecheck      # tsc --noEmit
pnpm dev            # watch mode

pnpm vitest run tests/patcher.test.ts   # single test file

# Manual testing (after pnpm build; npm link once)
clodex --help
clodex claude --dry-run     # full wizard, preview instead of launch, no writes
clodex claude --trace       # debug logs to ~/.clodex/logs/
clodex models --list        # print clodex:<provider>:<model> names + aliases
clodex patch                # patch the Claude Code binary (see Patcher below)
clodex server               # foreground gateway
clodex-claude [args...]     # second bin: launch claude bridged to a running clodex server
```

**`claude -p` end-to-end tests are manual only — NEVER add them to the automated test suite.**

## Architecture

**Entry points:** `src/cli.ts` — arg parsing (`parseArgs`, `consumeBridgeModeFlag`), help texts, and dispatch for `claude`, `server`, `models`/`favorites`, `providers`, `patch` — and `src/claude-wrapper.ts` (the `clodex-claude` bin, see below). Every other module is a focused unit with no side effects at import time.

**Two bridge modes** (both `clodex claude` and `clodex server`):

- **endpoint** — local Anthropic-format gateway (`src/proxy.ts` for the claude launch path, `src/server/` for the standalone gateway); the child gets `ANTHROPIC_BASE_URL` via `buildChildEnv()` (`src/env.ts`). With favorites, `startProxyCatalog()` serves a multi-route catalog and Claude Code's `/model` menu lists starting model + favorites.
- **proxy** — selective MITM of `api.anthropic.com` (`src/http-proxy/`): Claude Code keeps its normal Anthropic auth; request model ids matching `clodex:{provider}:{model}` (prefix constant `HTTP_PROXY_MODEL_PREFIX` in `src/http-proxy/routes.ts`) or saved aliases (`src/model-aliases.ts`) route to OpenAI; everything else passes through untouched.

**Bridge-mode defaults:** `resolveBridgeMode(command, explicit, {persist})` in `src/config.ts` — `claudeBridgeMode`/`serverBridgeMode` prefs. An explicit `--endpoint`/`--proxy` applies to that run only and is **never auto-persisted**; persisting requires the explicit `--save-mode` flag alongside a mode flag (`--save-mode` alone is an arg-parse error). With no flag and nothing saved, both commands default to **proxy** (works with the user's existing Claude auth; non-TTY gets the same default without prompting). `--dry-run` never persists. The former `--http-proxy` alias is removed — `--proxy` is the only spelling.

**Server discovery + `clodex-claude` wrapper** (`src/server-runtime.ts`, `src/wrapper-env.ts`, `src/claude-wrapper.ts`): the standalone `clodex server` command (both modes) registers itself in `~/.clodex/server-runtime.json` — an ARRAY of `{mode, port, pid, caPath (proxy only), startedAt}` records, one per running server, keyed by pid — after a successful start and removes ONLY its own record on SIGINT/SIGTERM, so a proxy server and an endpoint server can be advertised simultaneously without clobbering each other. The legacy single-object file shape is tolerated on read (wrapped as a one-element list). Read-modify-write cycles are serialized by `~/.clodex/server-runtime.lock` (same pid + staleness + ESRCH-liveness pattern as the patcher's `patch.lock`, 10s staleness; after a short bounded wait a writer proceeds lockless rather than losing its registration) and the file is replaced atomically (temp + rename). `clodex server --no-discovery` (or `CLODEX_NO_DISCOVERY=1`) opts a server out of registration entirely — e.g. an endpoint server used only as a local OpenAI-compatible API that must never co-opt wrapper discovery; the per-session MITM spawned by `clodex claude --proxy` never writes the file either. Stale detection is the READER's job: readers reject malformed records and dead pids (`kill(pid,0)`, EPERM counts as alive); writers additionally prune dead-pid records under the lock. The second bin `clodex-claude` (`dist/claude-wrapper.js`) serves both the `CLAUDE_CODE_PROCESS_WRAPPER` contract (executable first arg = claude binary path, rest passed through) and direct terminal use (binary discovered like `clodex claude`, honoring `CLODEX_CLAUDE_PATH`); it selects among live records with a deterministic policy (`orderWrapperServerCandidates`): **proxy mode preferred over endpoint** (bridging keeps Claude Code's own Anthropic auth), newest `startedAt` breaking ties within a mode, first candidate passing a pid + <100ms TCP liveness check wins. It then launches claude with proxy env + CA (proxy-mode server), `ANTHROPIC_BASE_URL` + local API key (endpoint-mode server), or an untouched env when no live server is found — a down server must never break launching claude. Env computation is the pure `computeWrapperEnv`. **Keep the wrapper tiny and its imports minimal — it runs for every spawned agent process.** Setup doc: `docs/background-agents.md` (shipped in the npm tarball via the `docs` entry in package.json `files`).

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

Registry writes use atomic hard-link lock publication, so the filesystem containing `CLODEX_HOME` must support hard links. A parseable lock owned by a live PID is never reclaimed based on age; contenders wait for a bounded interval and fail with the owner PID. Malformed locks and locks owned by dead PIDs remain reclaimable. This live-owner rule is what makes the final ownership check before `providers.json` publication meaningful because a concurrent process cannot invalidate a live writer between its check and rename.

**Config & migration** (`src/paths.ts`, `src/config.ts`, `src/env.ts`):

- Config home `~/.clodex`, override `CLODEX_HOME`. `ensureLegacyAppHomeMigrated()` silently copies a legacy `~/.relay-ai` (skipping `logs/`) on first read — **never mutates the legacy directory**.
- Keychain service `clodex` with per-account fallback read from legacy service `relay-ai` (copied into `clodex` on first hit). Chunked-entry support retained for Windows credential size limits.
- Preferences: `lastModel`, `lastProvider`, `recentModelsByProvider`, `favoriteModels`, `modelAliases`, `claudeBridgeMode`, `serverBridgeMode`, `appPathOverrides`, `recentLaunchFolders`, `server*` settings. All writes skipped when `dryRun`.
- `CLODEX_CLAUDE_PATH` overrides Claude Code binary discovery (`src/launch.ts`).

**Patcher** (`src/patcher.ts` + `src/patch-transforms.ts`): `clodex patch` uses tweakcc's programmatic API — `tweakcc` is an exact-pinned, declared runtime dependency (externalized in `tsup.config.ts`; it brings its own tree incl. `node-lief` for native repacking and `ink`/`react` for its picker, which is why `patcher.ts` loads it via lazy `import()`), never `npx` and never the network. Flow: `tryDetectInstallation({ path })` → `readContent` (extracts the bundled JS from the native binary) → `applyClodexPatches(source, config)` (in-process pure function applying the PATCH 1–7 regex sites; returns patched source + per-site OK/SKIP/FAIL results, shown by `--trace`) → `writeContent` (repacks). tweakcc 4.3.0 ships no `.d.ts` despite its `types` field — `src/tweakcc.d.ts` declares the verified API surface; re-verify it when bumping the pin. This bakes favorites + aliases into the Claude Code binary (model validation, `/model` listing, alias resolution, context windows via a `/*ccpatch:ctx*/`-marked map). Key invariants:

- **The alias IS the model identity in the binary.** For any favorite with an alias, the short name (`sol`) — never the canonical `clodex:<provider>:<model>` id — is what lands in the Agent-tool zod enum (PATCH 1), the known-alias validator list (PATCH 3), the `/model` picker value (PATCH 5), and the context-window map (PATCH 7). Subagent/skill/agent `model:` frontmatter is validated against that same enum, so injecting canonical ids made `model: sol` fail with InputValidationError. Favorites with no alias fall back to their canonical id as the identity (enum + validator + context map only; no resolver case, no picker entry).
- **PATCH 6 (alias resolver switch) maps each alias to ITSELF.** The case must exist — the switch's `default:` returns null — but resolving to the canonical id would make Claude Code send one name while looking its context window up under another. That is the same mismatch as the response-echo bug above: the MITM layer resolves short alias names as request model ids and echoes bodies unrewritten, so *name in enum == name sent == name echoed == context-map key*. The map keeps the canonical id as an extra key so pre-alias lookups still hit.
- Picker/description text uses the canonical label from `httpProxyDisplayName()` (`src/http-proxy/routes.ts`, built on `formatModelLabel`) — the same `GPT-5.6 Sol (OpenAI (ChatGPT))` string `clodex server` prints at startup and `clodex models --list` shows. Missing label → the old `Custom model (<id>)` wording.
- `buildDesiredPatchConfig()` is disk-only (preferences + registry models cache — no network, no credentials).
- `computePatchConfigHash` = sha256 of the key-sorted `[key, alias??null, context??null, display??null]` array; manifest at `~/.clodex/patch-state.json` (binary path, claude version, config hash, patched size/sha256, backup path) drives `evaluatePatchState` → `unpatched | current | stale-config | stale-binary`.
- **Never patch on top of a patch:** restore first whenever the pristine backup (`~/.tweakcc/claude-<ver>.orig`, tweakcc-compatible) differs from the current binary — regardless of what the manifest says.
- Binary resolution bypasses PATH shims (cmux installs a shim copy): `TWEAKCC_CC_INSTALLATION_PATH` → `~/.local/bin/claude` → `findClaudeBinary()`.
- Concurrency lock `~/.clodex/patch.lock` (pid + 10-min staleness + ESRCH liveness); the loser skips with a notice — never blocks, corrupts, or double-patches.
- `runLaunchPatchCheck()` in `clodex claude`: interactive y/N offer when stale; non-TTY or `--dry-run` prints a one-line stderr notice and proceeds. Wrapped in try/catch — a patch-check failure must never break launch.
- Context is omitted from the patch map when unknown or equal to Claude Code's 200k default; `[1m]`-suffixed model ids and explicit context are mutually exclusive in the patch transforms.
- The per-site transforms in `patch-transforms.ts` (regexes, replacements, ordering, SKIP/FAIL semantics) are hard-won — change them only with byte-for-byte equivalence evidence on a real binary.

**Server** (`src/server/`): `index.ts` loads models from the registry (`loadServerModels`), `router.ts` handles `/anthropic` (Anthropic-format; passthrough for `modelFormat:'anthropic'` with `baseUrl`, SDK adapter for `'openai'`) and `/openai/v1` (OpenAI-format via `src/openai-adapter.ts`). Wizard/quick-start settings persist to config; network mode requires a password; default port 17645 (`--port` overrides). Endpoint-mode request model resolution (`createGatewayModelCatalog` in `server/models.ts`) accepts, in precedence order: exact catalog id (and its gateway-discovery id) → unmasked gateway id when `--mask-gateway-ids` is on (`vendor-mask.ts`) → canonical `clodex:{provider}:{model}` id → saved short aliases from `clodex models --alias` (the same alias table the proxy-mode MITM resolves) → 400. Aliases and canonical ids are accepted INPUT only — `/models` listings still advertise exactly the canonical/masked ids. Echo invariant: an aliased request's response `model` field echoes the alias verbatim (even under masking) so a patched Claude Code's context-window lookup keys match (`aliasNames` in `ServerOptions`).

**Env isolation** (`src/env.ts`): `buildChildEnv()` copies `process.env`, deletes conflicting `ANTHROPIC_*`/related vars, sets `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` for the child only. Claude Code may persist the model to `~/.claude/settings.json` itself; outside clodex's control (reset with `claude --model sonnet`).

**Outbound proxy** (`src/outbound-proxy.ts`): when `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` are set in clodex's environment, `installOutboundProxyDispatcher()` (called at the top of `main()`) installs undici's `EnvHttpProxyAgent` as the global fetch dispatcher, so every fetch-based call (OAuth device flow/refresh, model-list + models.dev refresh, AI-SDK upstream calls) honors them; without proxy env vars it is a no-op and nothing changes. The `ws`-based OAuth Responses WebSocket doesn't use the undici dispatcher — `outboundWsProxyAgent()` gives it an `https-proxy-agent` CONNECT-tunnel agent instead (passed through `createConnection`). Self-loop guard: clodex never sets proxy vars in its own `process.env`; proxy bridge mode points only the CHILD at the MITM listener via env copies (`buildChildEnv`/`buildHttpProxyChildEnv` never mutate `process.env` — covered by a test), so the dispatcher can never route clodex's upstream calls through clodex's own listener.

**Tests** (`tests/`): pure functions only — adapter, provider factory, proxy, http-proxy routes, registry, config/migration, bridge-mode persistence, patcher (config building, hash stability, manifest staleness, lock behavior, per-site patch transforms), help text. Interactive launch flow and real-provider behavior are verified manually.

## Key constraints

- `~/.claude/settings.json` is never touched by clodex. Launch config is env-var-only (plus `--model`), child process only.
- `--dry-run` skips all writes (including bridge-mode persistence).
- The `::ts::` separator in tool_use ids encodes reasoning signatures for round-tripping; would only break if a signature literally contained `::ts::`.
- In endpoint switch-menu mode the displayed context window reflects the **launch** model and does not update on live `/model` switch (Claude Code fetches `/v1/models` once at startup). Proxy mode + `clodex patch` reports correct per-model windows.
- Cost display in Claude Code is always inaccurate for OpenAI models (Claude Code applies its own pricing table).
- `MAX_MODEL_CATALOG = 20` (`constants.ts`) — favorites cap and max catalog routes.
- OpenAI catalog ids may differ from upstream API ids — `upstreamModelId` carries the real API id.
