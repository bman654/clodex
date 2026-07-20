# CLODEX — Implementation Brief

Clodex is a trimmed-down, rebranded fork of relay-ai focused on exactly one thing:
**bridging Claude Code to OpenAI models** (OpenAI API key and ChatGPT/Codex-plan OAuth).
This document is the authoritative instruction set for implementation agents.
The companion `CLODEX-VERIFICATION.md` is the acceptance checklist.

## Prime directive: 90% cut & rename, 10% small features

This is NOT a rewrite or refactor. The relay-ai code — especially the SDK adapter,
OAuth WebSocket continuation, prompt-caching behavior, auto-compaction/context-window
handling, and the alias response-model echo — took extensive real-world testing to get
right. **Do not restructure, "clean up", or rewrite working code.** Allowed changes:

1. **Delete** modules for stripped features (and their tests).
2. **Rename** user-visible branding and identifiers (see Renames).
3. **Add/modify** only the specific features listed under New Features.
4. Minimal glue edits needed to make the above compile and pass tests.

If a kept file imports a stripped file, prefer removing the import/call-site branch over
restructuring. When in doubt, keep the code as-is.

## What clodex IS

- `clodex claude [...]` — launch Claude Code bridged to OpenAI models (single session).
  Two bridge modes, both kept:
  - **endpoint** mode: local Anthropic-format gateway proxy; child launched with
    `ANTHROPIC_BASE_URL` pointing at it (the classic relay-ai launch path).
  - **proxy** mode (today `--http-proxy`): selective MITM of api.anthropic.com;
    Claude Code keeps its normal Anthropic auth, `clodex:` models route to OpenAI.
- `clodex server` — foreground gateway, same two modes: **endpoint** (Anthropic-format
  HTTP gateway, today's default `relay-ai server`) and **proxy** (today
  `relay-ai server --http-proxy`). `--vertex` is stripped.
- `clodex patch` — first-class Claude Code binary patcher (see New Features).
- `clodex models` — favorites/alias management (kept; it feeds the catalog, the
  switch menu, and the patcher).
- Supporting commands that serve the above may be kept (e.g. auth/login flow for
  OpenAI OAuth, `--trace`, `--dry-run`). Anything serving stripped features goes.

Providers kept: **openai (API key)** and **openai OAuth (ChatGPT/Codex plan)** only.
The Anthropic passthrough path must remain wherever the bridge needs it (proxy mode
passes non-clodex traffic through to api.anthropic.com; endpoint mode may still
passthrough claude-* models if that's how the code works today — don't break it).

## What gets STRIPPED (delete code + tests)

- All UI: `src/ui/`, `src/ui-command.ts`, `src/ui.ts`, `src/ui/public/` assets.
- Antigravity: `src/antigravity/`, `src/antigravity.ts`, `src/oauth/antigravity-oauth.ts`.
- Gemini client: `src/gemini.ts`, `src/gemini/`, `src/gemini-proxy.ts`, `src/gemini-parts.ts`.
- Codex-as-client: `src/codex.ts`, `src/codex-app.ts`, `src/codex/`, `src/codex-proxy.ts`,
  and `src/codex-responses-adapter.ts` **unless** the import graph shows the
  claude→openai path uses it (verify before deleting).
- Claude desktop app: `src/claude-app.ts`, `src/claude-desktop/`.
- Vertex: `src/server/vertex-config.ts`, `--vertex` flag and dispatch.
- OpenCode integration: `opencode-serve.ts`, `providers.ts` local-provider discovery via
  opencode, `registry/import-opencode.ts`, `registry/opencode-auth.ts`, Zen/Go cloud
  backends, subscription tiers, free-models, `cloud-code-backend.ts`.
- Non-OpenAI OAuth: xai, github; `src/data/xai-oauth-models.ts`. Keep `oauth/openai.ts`,
  `oauth/pkce.ts`, `oauth/callback-server.ts`, `oauth/refresh*.ts`,
  `oauth/responses-websocket.ts`, `oauth/types.ts`. `oauth/claude-code*.ts` /
  `claude-identity.ts`: keep ONLY if the kept bridge paths import them (check graph).
- Registry: trim to what's needed to define/auth the two OpenAI providers and resolve
  model metadata (context windows, model lists). Delete provider templates/import/CRUD
  surface that only served the multi-provider registry UX — but do NOT rewrite the
  registry's kept internals; delete whole unused modules, keep the rest untouched.
- Non-Anthropic SDK provider deps: drop `@ai-sdk/google`, `@ai-sdk/mistral`, etc. from
  package.json; keep `@ai-sdk/openai` (and `ai`, `@ai-sdk/anthropic` if imported).
- Any command dispatch, help text, prompts, and docs for the above.

Deletion discipline: drive by the **import graph from the kept entry points**
(`clodex claude`, `clodex server`, `clodex patch`, `clodex models`, auth/setup).
A module unreachable from those is deleted along with its tests. A module reachable
from those is kept as-is.

## Renames

- npm package: `clodex` (unscoped — verified available on npm). Version `0.1.0`.
- bin: `clodex` (remove `relay-ai` bin).
- Config home: `~/.clodex/` (env override `CLODEX_HOME` replacing `RELAY_AI_HOME`).
  All `RELAY_AI_*` env vars become `CLODEX_*`.
- Model-id prefix: `relay:{provider}:{model}` → `clodex:{provider}:{model}` — must be
  renamed **globally and consistently** (proxy routes, http-proxy MITM matching, alias
  echo, patcher config, tests). The response-model echo behavior (respond with the exact
  id the client sent) MUST be preserved — see CLAUDE.md "Key constraints".
- User-visible strings: help text, banners, spinner text, trace-log filenames
  (`/tmp/clodex-debug.log` etc.), keychain service names → `clodex`.
- **Migration:** on startup, if `~/.clodex/` does not exist and `~/.relay-ai/` does,
  copy config + auth state over silently (one-time). This keeps existing OAuth
  credentials working — required for real end-to-end testing on this machine.
- GitHub workflow: update package/tag references; do not otherwise touch CI.
- Git history is preserved by working on this branch of the relay-ai repo. No
  squashing, no history rewrite.

## New features (the 10%)

### 1. Bridge-mode config memory

- Config keys remembering the last-used/preferred bridge mode **separately** for
  `claude` and `server` (e.g. `claudeBridgeMode`, `serverBridgeMode`:
  `'endpoint' | 'proxy'`).
- Flags: `--endpoint` and `--proxy` (keep `--http-proxy` as an alias for `--proxy`)
  select the mode AND persist it as the new default.
- Bare `clodex claude` / `clodex server` uses the remembered mode; first-ever run
  defaults to endpoint mode (or asks once interactively — implementer's choice, but
  non-TTY must not hang: default to endpoint).

### 2. `clodex patch` — first-class binary patcher

Port `scripts/patch-custom-models/` (tweakcc adhoc-patch wrapper) into `src/` as a
real command. Behavior:

- **Auto-config**: no hand-written model-config.json. Build the patch map from the
  user's clodex config: favorite models + their aliases (from `clodex models` /
  modelAliases). Patch map entries: real model id → alias + context window.
- **Context windows resolved automatically** from the model metadata clodex already
  has (registry/models metadata, `data/openai-oauth-models.ts`, models.dev) — i.e.
  interrogate the provider metadata, never ask the user. Unknown window → warn and
  use the 200k default for that model.
- **Auto-apply**: no tweakcc y/n confirmation, no showing tweakcc output for approval.
  Print a concise summary of what was patched.
- **Idempotent + re-patch semantics**:
  - Keep a pristine per-claude-version backup of the binary (as the script does today).
  - Record a patch manifest (e.g. `~/.clodex/patch-state.json`): claude binary path +
    version + hash of the applied patch config.
  - `clodex patch` on an unpatched binary → patch it.
  - Already patched, manifest matches current desired config → no-op, say so.
  - Already patched, config/context-windows/claude-version changed → **restore the
    original backup, then patch fresh**. Never patch on top of a patch; never try to
    make patches incremental.
- `clodex patch --restore` (or similar) restores the pristine binary.

### 3. Launch-time patch check in `clodex claude`

- On `clodex claude`, cheaply compute desired patch state and compare to the manifest/
  binary (version + config hash).
- If unpatched or stale AND stdin/stdout is a TTY → ask the user "patch now? [y/N]"
  and run the patch on yes.
- **Non-TTY guard**: if not a TTY, never prompt and never block — print a one-line
  notice (`run clodex patch`) and continue launching.
- **Concurrency guard**: multiple concurrent `clodex claude` launches must not race
  the patcher. Use a lock file (e.g. `~/.clodex/patch.lock` with pid + staleness
  detection). Loser of the race skips the patch step with a notice (or waits briefly)
  — it must not corrupt the binary, double-patch, or hang.

### 4. README rewrite

Replace README.md entirely:

- One paragraph: what clodex is (bridge Claude Code to OpenAI models, including
  ChatGPT/Codex-plan OAuth, with working prompt caching, auto-compaction, model
  switching, and binary patching for first-class model integration).
- **Attribution** (exactly this scope, no more): a brief note that clodex is derived
  from the original relay-ai project, heavily modified and streamlined for this one
  use case, with the full commit history preserved. No other attribution content.
- "Get started" section assuming a ChatGPT/Codex plan (OAuth) user:
  `npm install -g @bman654/clodex`, the OAuth login step, `clodex models` (pick favorites/
  aliases), `clodex patch`, `clodex claude`. Each with a one-line explanation.
- Then a full CLI reference for every kept command and flag.
- No references to stripped features (ui, gemini, codex client, antigravity, vertex,
  opencode, zen/go, subscription tiers).
- Also trim `docs/` and CHANGELOG: delete docs pages for stripped features; CHANGELOG
  may be reset to a single `## [0.1.0]` entry describing the fork.
- Update CLAUDE.md/AGENTS.md to describe the trimmed architecture (remove stripped
  sections, keep the hard-won constraint documentation for kept subsystems).

## Testing rules

- Load/follow the existing test conventions. Keep all tests for kept modules; they
  must pass (`npm test`), plus `npm run typecheck` and `npm run build`.
- Update kept tests for renames (`clodex:` prefix, env vars, help text) — do not
  weaken assertions.
- New features get unit tests for their pure parts (patch-map building, manifest
  staleness, lock behavior, bridge-mode persistence).
- **`claude -p` end-to-end tests are manual/agent-run only — NEVER added to the
  automated test suite.**

## Practical notes for agents

- Worktree: `/Users/brandon/dev/general/relay-ai/.claude/worktrees/clodex`
  (branch `worktree-clodex`). Work only here.
- Commit incrementally with clear messages (strip commits separate from rename
  commits separate from feature commits, roughly).
- `dist/` is gitignored (not committed); `prepublishOnly` and publish CI rebuild it.
- The machine has working OpenAI OAuth credentials under `~/.relay-ai` — the
  migration copy makes real end-to-end testing possible. Do not delete or mutate
  `~/.relay-ai` itself.
- Do not run `npm publish`. Do not push. Do not touch the user's global claude
  binary with the patcher during implementation unless verifying patch behavior —
  and always restore it afterward.
