# CLODEX — Verification Criteria

Acceptance checklist for the clodex fork. A verifier agent checks EVERY criterion and
records pass/fail with evidence (command output, file:line references) in a findings
file. A criterion passes only with concrete evidence — reading the code or running the
command, not assuming. Criteria marked **[E2E]** require live execution; run them via
real commands (including `claude -p`) but NEVER add them to the automated test suite.

## A. Branding & packaging

- A1. `package.json` name is `clodex` (unscoped), version `0.1.0`, bin exposes
  exactly `clodex` and `clodex-claude` (see section G).
- A2. `node dist/cli.js --help` (fresh `pnpm build`) shows clodex branding; no
  occurrence of `relay-ai`/`relay:` in any user-visible help/banner output.
- A3. Config home is `~/.clodex/` with `CLODEX_HOME` override; no `RELAY_AI_*` env
  vars remain in src (grep clean, excluding migration code reading legacy paths).
- A4. One-time migration: with `CLODEX_HOME` pointing at an empty temp dir and a
  populated fake legacy `~/.relay-ai`-style dir, first run copies config + auth state.
  (Test with temp dirs — do not mutate the real `~/.relay-ai`.)
- A5. Model-id prefix is `clodex:{provider}:{model}` everywhere (routes, MITM
  matching, aliases, patcher, tests); `grep -rn "relay:" src/ tests/` shows no live
  model-id prefix usage.
- A6. Response-model echo preserved: proxy/MITM responses echo the exact model id the
  client sent (alias or `clodex:` id), per the regression documented in CLAUDE.md —
  covered by a passing test.
- A7. Git history preserved: branch `worktree-clodex` contains the relay-ai history
  (`git log --oneline | wc -l` is large; no squash/orphan commit).

## B. Stripping

- B1. Deleted (no files, no imports, no dispatch, no help text): UI (`src/ui*`),
  antigravity (`src/antigravity*`, antigravity oauth), gemini client (`src/gemini*`),
  codex client (`src/codex*`, codex proxy/app), claude desktop (`src/claude-app.ts`,
  `src/claude-desktop/`), vertex (`--vertex`, `server/vertex-config.ts`).
- B2. OpenCode integration gone: no `opencode serve` spawning, no Zen/Go backends, no
  subscription tiers, no free-models filtering, no opencode import/auth in registry.
- B3. Non-OpenAI OAuth gone (xai, github, antigravity); `data/xai-oauth-models.ts`
  deleted. OpenAI OAuth (`oauth/openai.ts`, `responses-websocket.ts`, pkce, callback
  server, refresh) intact.
- B4. Only OpenAI providers are configurable/selectable: openai (API key) and openai
  OAuth. No UI/prompt path offers google/mistral/groq/xai/etc.
- B5. package.json dependencies: non-OpenAI `@ai-sdk/*` provider packages removed
  (keep `@ai-sdk/openai`, `ai`, and `@ai-sdk/anthropic` only if imported).
- B6. Commands `clodex ui`, `clodex gemini`, `clodex codex`, `clodex codex-app`,
  `clodex chatgpt`, `clodex agy`/`antigravity` are gone: unknown-command error, and
  absent from help.
- B7. Stripped modules' tests are deleted, not skipped.
- B8. No refactor binge: kept core modules (`sdk-adapter.ts`,
  `oauth/responses-websocket.ts`, `proxy.ts`, `http-proxy/*`, `env.ts`,
  `context-window.ts`, caching/auto-compaction logic) show only rename/import-pruning
  diffs vs their relay-ai originals — no structural rewrites. Verify with
  `git diff <fork-point> -- <file>` spot checks.

## C. Preserved functionality

- C1. `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass cleanly (pnpm via corepack).
- C2. `clodex claude --dry-run` completes a simulated launch (endpoint mode) without
  writing state.
- C3. Endpoint mode: `clodex server` starts; `GET /v1/models` (or `/models`) lists the
  configured OpenAI models with context windows.
- C4. Proxy mode: `clodex server --proxy` starts the MITM
  proxy; CA cert + env instructions printed as before.
- C5. `clodex models` favorites/alias management works against the OpenAI catalog.
- C6. OAuth WebSocket continuation, prompt-cache key handling, and cache-token mapping
  code paths are intact (tests from relay-ai for these still present and passing).
- C7. **[E2E]** With real credentials: start `clodex server` (endpoint mode) and get a
  successful completion through it from a real OpenAI model via
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port> claude -p "reply with exactly: pong"`
  (model set to a clodex OpenAI model via env/flag). Response arrives, is non-empty,
  and the response model id echoes the requested id.
- C8. **[E2E]** Same smoke test through proxy mode if feasible non-interactively
  (HTTPS_PROXY + NODE_EXTRA_CA_CERTS env pointed at `clodex server --proxy`, then
  `claude -p` with a `clodex:` model). If Claude Code's OAuth interaction makes this
  impossible non-interactively, document why and verify the proxy accepts/routes a
  raw curl request instead.

## D. New features

### Bridge-mode defaults
- D1. `--endpoint` / `--proxy` flags exist on both `claude` and `server` and select
  the mode for that run only — they are never auto-persisted (`--http-proxy` is
  removed entirely; `--proxy` is the only spelling).
- D2. Persisting requires the explicit `--save-mode` flag together with a mode flag
  (e.g. `clodex claude --endpoint --save-mode` saves endpoint as the claude default,
  keys `claudeBridgeMode`/`serverBridgeMode`); `--save-mode` without a mode flag is
  an error with guidance; `--dry-run` never persists anything. Verify with a temp
  `CLODEX_HOME`: a bare run after `--endpoint` alone still selects proxy, after
  `--endpoint --save-mode` selects endpoint.
- D3. No flag and no saved mode → defaults to **proxy** for both commands; non-TTY
  does not prompt or hang and gets the same proxy default.
- D4. Modes are saved independently for `claude` vs `server`.

### `clodex patch`
- D5. `clodex patch` exists as a first-class command (in help, with its own section).
- D6. Auto-config: patch map built from clodex config (favorites + aliases), never a
  hand-maintained model-config.json; context windows resolved from model metadata
  automatically; unknown-window models warn and default to 200k.
- D7. Auto-apply: no y/N confirmation, no raw tweakcc output requiring approval;
  prints a summary of models/aliases/windows patched.
- D8. Idempotence: second `clodex patch` with unchanged config is a fast no-op that
  says the binary is already patched.
- D9. Re-patch: after changing config (e.g. add a favorite/alias), `clodex patch`
  restores the pristine backup first, then patches fresh (evidence: manifest hash
  changes, backup file untouched, no double-patch).
- D10. Pristine per-version backup exists; `clodex patch --restore` restores it.
- D11. Patch manifest (`~/.clodex/patch-state.json` or similar) records claude
  version + config hash and drives D8/D9 staleness detection.
- D12. **[E2E]** Run the real patch against the installed claude binary once: patch
  applies, `claude --version` still works, patched model names appear (e.g. via
  `claude -p` with a patched alias as `--model`, or the binary strings contain the
  alias). Then `clodex patch --restore` returns the binary to pristine (hash matches
  backup). Leave the user's binary in its ORIGINAL state afterward.

### Launch-time patch check
- D13. `clodex claude` compares desired patch config vs manifest; if stale/unpatched
  and TTY, prompts y/N to patch; declining continues the launch.
- D14. Non-TTY: no prompt, no hang; one-line notice suggesting `clodex patch`;
  launch proceeds. (Verify by piping stdin/stdout: e.g. `clodex claude --dry-run </dev/null | cat`.)
- D15. Concurrency: two simultaneous `clodex claude` launches (temp CLODEX_HOME,
  stale patch state) cannot both run the patcher — lock file with pid + staleness
  handling; loser skips with notice; no hang, no corrupted binary. Unit-test the lock
  logic; E2E if practical.

## E. README & docs

- E1. README is fully rewritten: one-paragraph description first.
- E2. Attribution: brief note that clodex derives from the original relay-ai project,
  heavily modified and streamlined for this single use case, full commit history
  preserved — and nothing more (no relay-ai feature docs, no badges/links beyond at
  most one to the original repo).
- E3. "Get started" targets a ChatGPT/Codex-plan OAuth user: install (`npm install -g
  clodex`), OAuth login, `clodex models`, `clodex patch`, `clodex claude` — in that
  order, each with a one-liner.
- E4. Full CLI reference covers every kept command/flag; no stripped feature is
  mentioned anywhere in README, docs/, or help text.
- E5. CHANGELOG reset to `## [0.1.0]` fork entry. CLAUDE.md/AGENTS.md updated to the
  trimmed architecture while preserving hard-won constraint notes for kept subsystems.
- E6. `npm pack --dry-run` succeeds and the tarball contains only what's needed
  (dist, README, LICENSE, package.json — no stripped assets/ui files).

## G. Server discovery & `clodex-claude` wrapper

- G1. Runtime state file lifecycle: the standalone `clodex server` command in BOTH
  modes writes `<CLODEX_HOME>/server-runtime.json` with `{mode, port, pid, caPath
  (proxy mode only, absolute), startedAt}` after a successful start, and removes it
  on graceful SIGINT/SIGTERM shutdown. The per-session MITM spawned by
  `clodex claude --proxy` never writes it.
- G2. Stale detection is reader-side and unit-tested as pure functions:
  `parseServerRuntimeState` rejects malformed payloads (including proxy-mode state
  without a caPath); `readLiveServerRuntimeState` returns null for missing files and
  dead pids (`kill(pid,0)` probe, EPERM counts as alive). A crashed server's leftover
  file wedges nothing.
- G3. Wrapper env cases (pure `computeWrapperEnv`, unit-tested): live proxy-mode
  server → `HTTPS_PROXY`/`HTTP_PROXY` (+ lowercase variants) set to
  `http://127.0.0.1:<port>`, `NODE_EXTRA_CA_CERTS` = advertised caPath,
  `ANTHROPIC_BASE_URL` removed; live endpoint-mode server → `ANTHROPIC_BASE_URL` =
  `http://127.0.0.1:<port>/anthropic` plus a non-empty local `ANTHROPIC_API_KEY`,
  proxy vars removed; no live server → env returned untouched (clean fallback:
  claude always launches).
- G4. Wrapper arg contract: an executable-file first arg is treated as the claude
  binary path (the `CLAUDE_CODE_PROCESS_WRAPPER` shape) with remaining args passed
  through; otherwise the binary is discovered like `clodex claude` does
  (`CLODEX_CLAUDE_PATH` honored) and all args pass through. Child exit code is
  preserved; stdio is inherited.
- G5. Packaging: `package.json` bin maps `clodex-claude` → `dist/claude-wrapper.js`;
  tsup builds both entries; `npm pack --dry-run` shows `dist/claude-wrapper.js` and
  `docs/background-agents.md` in the tarball.
- G6. README Bridge modes section contains two mermaid diagrams matching the code
  (proxy: clodex:/alias decision, OpenAI via OAuth WebSocket or API-key HTTPS with
  clodex-managed credentials, passthrough carrying Claude Code's own Anthropic
  credentials; endpoint: `ANTHROPIC_BASE_URL` + local API key, `/v1/models` catalog
  fetch feeding the `/model` menu) and ends with the pointer to
  `docs/background-agents.md`.
- G7. **[E2E]** With a temp `CLODEX_HOME`: start `clodex server --proxy` — the
  runtime file appears with the real port and caPath and disappears on SIGINT.
  Run `clodex-claude` against a fake env-dumping claude script in both invocation
  shapes and verify all three env cases of G3 plus the stale-pid fallback.

## F. Meta

- F1. No `claude -p`/E2E invocations exist inside `tests/` or any vitest file.
- F2. CLODEX-BRIEF.md's "Prime directive" was honored — the verifier's spot-check
  diffs (B8) found no gratuitous rewrites.
- F3. All work is committed on `worktree-clodex` with a clean `git status`. `dist/`
  is NOT tracked (gitignored); it is rebuilt by `prepublishOnly` and the publish CI.
