# CLAUDE.md

Guidance for coding agents and maintainers working in this repo. Read this file in full; load the
deeper documents below only when you touch the subsystem they cover.

**clodex** bridges Claude Code to non-Anthropic models — OpenAI API key (`openai`),
ChatGPT/Codex-plan OAuth (`openai-oauth`), or community-supported OpenCode Go (`opencode-go`).
Provider support tiers are documented in README. It is a trimmed fork of relay-ai (full commit
history preserved).

**Prime directive.** The translation, caching, auto-compaction, and OAuth-continuation code encodes
real production failures that are not visible in the diff. Prefer surgical changes over
restructuring.

## Where everything lives

| Load this | When |
| --- | --- |
| `.claude/skills/pr-verification/SKILL.md` | **Before the first `git push` of any change** — the gate it must clear, and why pushing before your review reports costs more than it saves. Load it when you start preparing the change, not when you are about to open the PR. |
| `.claude/skills/pr-review/SKILL.md` | Reviewing someone else's PR: panels, proof techniques, verdicts, merging. |
| `.claude/docs/claude-code-internals.md` | Before asserting how Claude Code itself behaves, or re-deriving it. |
| `.claude/docs/patcher.md` | Changing `clodex patch`, patch transforms, or backups. |
| `.claude/docs/oauth-continuation.md` | Changing `src/oauth/`, head matching, upstream retries, WS diagnostics. |
| `.claude/docs/translation.md` | Changing `sdk-adapter.ts`, `provider-factory.ts`, `openai-adapter.ts`. |
| `.claude/docs/launch-and-wrapper.md` | Changing launch, bridge modes, env, server discovery, `clodex-claude`, outbound proxy. |
| `.claude/docs/registry-and-server.md` | Changing `src/registry/`, `src/server/`, model or alias resolution. |
| `CONTRIBUTING.md` | Outside contributors: how to scope a PR. |
| `RELEASING.md` | Maintainers: how a release is cut and staged. |

`.agents` is a committed symlink to `.claude`, so harnesses that look for `.agents/` find the same
skills and docs.

## Toolchain and commands

```bash
corepack enable          # activates the pinned pnpm version
pnpm install
pnpm build               # compile TypeScript → dist/cli.js (tsup, ESM, shebang injected)
pnpm test                # vitest
pnpm typecheck           # tsc --noEmit
pnpm dev                 # watch mode

pnpm vitest run tests/patcher.test.ts    # a single test file

# Manual testing (after pnpm build; npm link once)
clodex claude --dry-run     # full wizard, preview instead of launch, no writes
clodex claude --trace       # debug logs to ~/.clodex/logs/
clodex models --list        # print clodex:<provider>:<model> names + aliases
clodex patch                # patch the Claude Code binary
clodex server               # foreground gateway
clodex providers            # provider registry management
clodex-claude [args...]     # second bin: launch claude bridged to a running clodex server
```

Before opening a PR run `pnpm typecheck && pnpm test && pnpm build` — the same three the `CI / test`
job runs on every pull request. Passing them is necessary and never sufficient; see the
pr-verification skill.

Development targets **Node 24** (`.nvmrc` pins v24.14.1; CI runs 24) while the published package
supports **Node >= 22** (`engines.node`) — don't use APIs newer than Node 22 in `src/`. Dev package
manager is **pnpm**, pinned via `packageManager: "pnpm@10.34.5"` and activated with corepack.
Dependencies are **exact-pinned** (no `^`/`~`). `pnpm-workspace.yaml` sets
`minimumReleaseAge: 14400` (minutes) — no **direct or transitive** dependency version younger than
10 days can be resolved; already-locked versions install fine, but fresh resolution of a too-new
version fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. End users install with
`npm install -g @bman654/clodex`; the dev package manager does not affect consumers.

Use `CLODEX_HOME=$(mktemp -d)` to exercise the CLI against throwaway config instead of your real
`~/.clodex`.

## Commit messages

Conventional Commits, enforced by commitlint (Husky `commit-msg` hook locally, and in CI on every
pull request).

| Prefix | Use for |
| --- | --- |
| `feat:` | adds a feature |
| `fix:` | fixes behavior |
| `docs:` | documentation only |
| `test:` | tests only |
| `refactor:` | no behavior change |
| `build:` / `ci:` / `chore:` | maintenance |

Add `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer for an incompatible change.
Hard-wrap bodies and footers at **≤100 characters per line** — commitlint's `body-max-line-length`
is enforced by the hook and again on every push to `main`.

**Your summary line is the release note.** Changelog entries are generated from commit summary
headers. Release-please renders `type(scope): summary` as a bullet with the scope bolded and
issue/commit links appended, but the summary text itself is carried through unchanged. Get it
right — it is what every user reads. (The one hand-written entry, 0.1.0, predates this and is
preserved as prose.)

Ordinary commit-body wording reaches no user-facing surface, so nobody polices it. **The exception
is a merge commit**: `gh pr merge` without `--body ""` puts the PR title into the merge-commit body,
and release-please parses it as a second entry — a release has shipped with a duplicate changelog
line proving it. See `.claude/skills/pr-review/SKILL.md`.

Today most summaries fail. Reviewing the generated entries in `CHANGELOG.md` against the rules below
— 62 bullets, 60 distinct summaries once two duplicates are collapsed — **44 were judged unreadable
to a non-technical user** and only 2 clearly passed. That judgment is a review assessment, not a
measurement, but the direction is not in doubt.

**Write the summary line for someone who uses clodex and has never read the source.** It must say
what they can now do, what they stop seeing, or what got more reliable.

1. **Name the user-visible outcome**, not the mechanism. Replace `canonicalize`, `replay`, `strip`,
   `snapshot`, `serialize` with what the user notices.
2. **Say why it matters** — a concrete "so", "to prevent", "to avoid", or equivalent.
3. **No internal vocabulary without a plain-language gloss**: module names, symbols, protocol
   fields, `function_call`, `heads`, `nursery`, `canary`, `pty`, `stderr`, `previous_response_id`,
   `store:false`, `cache_control`.
4. **No implementation-only detail** — hash formats, dependency versions, test/CI fixes — unless
   tied to a visible install or runtime result.
5. **Self-contained.** The reader should not need the issue, the body, or the code.
6. **The 10-second test:** could a non-technical user explain the problem solved and decide whether
   they care, from this line alone?
7. Conventional-commit form, lowercase imperative, **whole line ≤ 100 characters**.

| Don't | Do |
| --- | --- |
| `fix(openai): snapshot function_call arguments in the sanitized downstream shape` | `fix(oauth): improve OpenAI cache hit rate by keeping tool arguments consistent` |
| `feat(openai): omitted-reasoning alignment and abandoned-head canary coverage` | `feat(oauth): keep long conversations working when reasoning details are omitted` |
| `fix(openai): suppress reasoning.summary for gpt-5.3-codex-spark` | `fix(reasoning): prevent blank responses on gpt-5.3-codex-spark` |
| `fix(proxy): isolate bridge settings from child commands` | `fix(proxy): prevent nested Claude commands from using a stale clodex connection` |
| `fix(patcher): include transform-set version in patch config hash` | `fix(models): detect patch updates so new model settings take effect` |

Prefer a scope a user recognizes (`auth`, `models`, `launch`, `images`, `openai`) over one that only
names an internal module (`adapter`, `transport`, `sdk`) where you have the choice.

## Architecture map

**Entry points:** `src/cli.ts` — arg parsing (`parseArgs`, `consumeBridgeModeFlag`), help texts, and
dispatch for `claude`, `server`, `models`/`favorites`, `providers`, `patch` — and
`src/claude-wrapper.ts` (the `clodex-claude` bin). Every other module is a focused unit with no
side effects at import time.

**Two bridge modes**, supported by both `clodex claude` and `clodex server`:

- **endpoint** — a local Anthropic-format gateway; the child gets `ANTHROPIC_BASE_URL`.
- **proxy** — selective MITM of `api.anthropic.com`; Claude Code keeps its normal Anthropic auth and
  only `clodex:{provider}:{model}` ids and saved aliases route to their configured providers. **This
  is the default.**

Details, including bridge-mode persistence rules, are in `.claude/docs/launch-and-wrapper.md`.

**The single translation path** is `src/sdk-adapter.ts` + `src/provider-factory.ts` (Anthropic
`/v1/messages` ↔ Vercel AI SDK, one turn per request — Claude Code owns the tool loop). There is no
hand-rolled per-provider translation; don't add one. See `.claude/docs/translation.md`.

### Cross-cutting invariants that are easy to break

These bite from outside the subsystem that owns them, so they live here rather than in a deep doc.

- **Auto-compaction depends on the response-model echo.** The proxy-mode MITM forwards request
  bodies **unrewritten** so responses echo the exact model id the client sent. Claude Code resolves
  context windows from the response `model` field but uses the request alias for preflight —
  substituting the canonical id in responses made patched/alias ids miss their window config,
  auto-compact never fired, and agents died with "Prompt is too long". Endpoint mode's synthetic
  `GET /v1/models` returns `context_window` per model so the status bar is accurate.
- **Anthropic-passthrough base URLs must NOT include `/v1`** — the Anthropic SDK appends
  `/v1/messages` itself.
- **The alias IS the model identity** once a binary is patched: the short name is what lands in the
  Agent-tool enum, is sent, is echoed, and keys the context-window map. Full rules in
  `.claude/docs/patcher.md`.
- **Do not restructure `src/oauth/responses-websocket.ts` or `src/sdk-adapter.ts`.** The
  continuation and translation logic took extensive real-world testing. Surgical changes only.
- **`~/.claude/settings.json` is never touched by clodex.** Launch config is env-var-only (plus
  `--model`), child process only.
- **`node-gyp-build` is a deliberate direct dependency that no clodex source imports.** Routine
  "remove the unused dependency" cleanup breaks fresh installs. Reason in
  `.claude/docs/patcher.md`.
- **Every AI SDK generation entry point must resolve its timeout and retry budget through
  `src/upstream-retry.ts`.** Anthropic- and OpenAI-format `streamText` consumers abort at idle and
  total deadlines; `generateText` consumers abort at total only. Cancellation remains cooperative
  with the provider transport. Raw relays are not SDK generations and use no shared timeout. Details
  in `.claude/docs/oauth-continuation.md`.

## Tests

`tests/` is almost all pure functions — adapter, provider factory, proxy, http-proxy routes,
registry, config, bridge-mode persistence, help text, and patcher (config building, hash stability,
manifest staleness, lock behavior, per-site transforms).

The exception is `tests/patcher-command.test.ts`, a genuine end-to-end exercise of `clodex patch`
and the only automated coverage of `runPatchCommand`: it drives the real command against fake claude
"binaries" (shell scripts answering `--version` and carrying a bundle payload after a sentinel) with
tweakcc's three API calls mocked, covering version resolution, backup selection, the
poisoned/corrupt-backup refusals, `--restore`, and the manifest without touching a real install.

Interactive launch flow and real-provider behavior are verified manually.

**Nothing automated touches a real Claude Code binary, so nothing automated can see a break that is
specific to one executable format.** That is not hypothetical: `clodex patch` was broken on every
ELF build of Claude Code across two releases while macOS stayed green. Before changing
`src/bun-entry-module.ts` or anything else in the read/repack/restore path, run
`scripts/probe-patch-mechanism.mjs` against a build for each format — Mach-O, ELF and PE. It needs
no Linux or Windows host, because it never executes the binary. See `.claude/docs/patcher.md`.

**A green macOS/Windows run says nothing about ELF.** Claude Code 2.1.257 moved the global Bun
reads its blob's address from off the 16 KiB boundary tweakcc's ELF repack scans for it, and
`clodex patch` failed on all four ELF builds while Mach-O and PE stayed green — Mach-O and PE
assign the section in place and rewrite no pointer. `src/bun-compiled-pointer.ts` works around it;
see `.claude/docs/patcher.md`.

**Patch anchors are not platform-independent either.** Claude Code 2.1.238 minified one helper's
parameter differently on its arm64 builds, so `PATCH 5: model picker options` matched five builds
and missed `linux-arm64`, `linux-arm64-musl` and `win32-arm64`. The probe now applies every patch
site to each build's own bundle; run it per format when you touch `src/patch-transforms.ts` too.

**`claude -p` end-to-end tests are manual only — NEVER add them to the automated suite.**

## Key constraints

- `--dry-run` skips all writes (including bridge-mode persistence).
- The `::ts::` separator in tool_use ids encodes reasoning signatures for round-tripping; would only
  break if a signature literally contained `::ts::`.
- In endpoint switch-menu mode the displayed context window reflects the **launch** model and does
  not update on live `/model` switch (Claude Code fetches `/v1/models` once at startup). Proxy mode
  + `clodex patch` reports correct per-model windows.
- Cost display in Claude Code is always inaccurate for routed third-party models (Claude Code applies
  its own pricing table).
- `MAX_MODEL_CATALOG = 20` (`constants.ts`) — favorites cap and max catalog routes.
- OpenAI catalog ids may differ from upstream API ids — `upstreamModelId` carries the real API id.
- Never commit `dist/` (gitignored, rebuilt by CI), never hardcode a version string
  (`package.json` is the source of truth), and never run `npm publish` locally.
