<!-- Read when changing src/patcher.ts, patch-transforms.ts, patch-backup.ts, local-patches.ts,
     built-in-patch-proofs.ts, or anything about `clodex patch`. -->

# Patcher

`src/patcher.ts` + `src/patch-transforms.ts` + `src/built-in-patch-proofs.ts` +
`src/local-patches.ts` + `src/patch-backup.ts`.

`clodex patch` uses tweakcc's programmatic API — an exact-pinned, declared runtime dependency
(externalized in `tsup.config.ts`; it brings `node-lief` for native repacking and `ink`/`react` for
its picker, which is why `patcher.ts` loads it via lazy `import()`). **Never `npx`, never the
network.** Flow: `tryDetectInstallation({ path })` → `readContent` → `applyClodexPatches(source,
config)` (in-process pure function applying built-in PATCH 1–10 sites) → optional
`applyLocalPatches` transaction with built-in postcondition verification → `writeContent` (repacks
the native binary). Both layers return per-site OK/SKIP/FAIL results shown by `--trace`.

tweakcc ships no `.d.ts` despite its `types` field — `src/tweakcc.d.ts` declares the verified API
surface; re-verify when bumping the pin. `node-gyp-build` is a deliberate direct dependency even
though no clodex source imports it: a node-lief release demoted it to a devDependency while still
`require`-ing it at runtime (reported against 1.3.1; the lockfile currently resolves 1.3.0), so
fresh installs resolved a node-lief throwing
`Cannot find module 'node-gyp-build'` — which tweakcc's lazy loader swallows into a null and clodex
surfaces as the misleading "Failed to extract JavaScript from native installation". Declaring it
ourselves guarantees it lands somewhere node-lief's `require` can resolve — that is the invariant to
check any alternative fix against, which matters because this repo uses pnpm's strict non-hoisted
layout with exact pins. Keep it even after node-lief fixes the packaging.

The built-ins bake favorites + aliases into the binary: model validation, `/model` listing, alias
resolution, context windows via a `/*ccpatch:ctx*/`-marked map, per-model effort
capabilities/defaults, and child-command network isolation.

## Patcher invariants

- **The alias IS the model identity in the binary.** For any favorite with an alias, the short name
  (`sol`) — never the canonical `clodex:<provider>:<model>` id — is what lands in the Agent-tool zod
  enum (PATCH 1), the known-alias validator list (PATCH 3), the `/model` picker value (PATCH 5), and
  the context-window map (PATCH 7). Subagent/skill/agent `model:` frontmatter is validated against
  that same enum, so injecting canonical ids made `model: sol` fail with InputValidationError.
  Favorites with no alias fall back to their canonical id as the identity (enum + validator +
  context map only; no resolver case, no picker entry).
- **PATCH 6 (alias resolver switch) maps each alias to ITSELF.** The case must exist — the switch's
  `default:` returns null — but resolving to the canonical id would make Claude Code send one name
  while looking its context window up under another. That is the same mismatch as the response-echo
  bug — the MITM layer resolves short alias names as request model ids and echoes bodies unrewritten,
  so *name in enum == name sent == name echoed == context-map key*. The map keeps the canonical id
  as an extra key so pre-alias lookups still hit.
- Picker/description text uses the canonical label from `httpProxyDisplayName()`
  (`src/http-proxy/routes.ts`, built on `formatModelLabel`) — the same string `clodex server` prints
  at startup and `clodex models --list` shows, e.g. `GPT-5.6 Sol (OpenAI (ChatGPT))`. Missing label
  → the old `Custom model (<id>)` wording.
- `buildDesiredPatchConfig()` is disk-only (preferences + registry models cache — no network, no
  credentials).
- `computePatchConfigHash` = sha256 of `[PATCH_TRANSFORMS_VERSION, key-sorted [key, alias??null,
  context??null, display??null, effort-levels??null, default-effort??null] array]`, plus the
  versioned local-module content identity only while local patches are enabled. Disabled users
  retain the exact historical hash shape. The manifest at `~/.clodex/patch-state.json` (binary path,
  claude version, config hash, patched size/sha256, backup path, pristine sha256 — the last absent
  in pre-content-addressed manifests) drives `evaluatePatchState` →
  `unpatched | current | stale-config | stale-binary`.
- **PATCH 10 isolates proxy-mode bridge settings from standard child commands.**
  `computeWrapperEnv()` and `buildHttpProxyChildEnv()` write `CLAUDE_CODE_CLODEX_NETWORK_ENV`, a
  versioned compare-before-revert contract holding the external and injected values for the proxy
  variables, bypass lists, and `NODE_EXTRA_CA_CERTS`. The patched shared child-environment builder
  restores an external value only while the live value still equals what clodex injected, so nested
  wrappers cannot preserve a dead bridge port and settings-level overrides remain authoritative. It
  always removes the contract from the child and requires both contract records to contain the same
  recognized keys with only string or null values. PATCH 10 is deliberately **required**: publishing
  without it would silently reintroduce bridge settings into child commands, while a failed required
  patch leaves the installed binary untouched. **The contract does not cover** endpoint-mode
  `ANTHROPIC_*` variables, the separate `--bg --exec` environment path, or a plain nested `claude`
  launched from Bash — use `clodex-claude` when a nested client must stay bridged.
- **Bump `PATCH_TRANSFORMS_VERSION` in the same commit whenever the transform set changes
  materially** — a site added or removed, or a site's regex, replacement, or ordering changed. That
  hash is the manifest's only record of the transform set; without the version folded in, a user
  whose favorites are unchanged stays `current` forever and silently never receives the new
  transforms. A test pins a sha256 of `patch-transforms.ts` plus `network-env.ts` so the decision is
  forced rather than forgotten; for a comment-only edit, re-pin the digest and leave the version
  alone. **That pin is a tripwire, not a behavioural test** — never let it be the only red test in a
  mutation check (see `.claude/skills/pr-verification/SKILL.md`).
- **Never patch on top of a patch, and never publish a partial patch.** `applyPatch` never writes
  the live binary in place. It builds into a *candidate* inside a sibling temp dir
  (`.clodex-patch-*`, removed in a `finally`) and `renameSync`s it over the binary only after every
  *required* site applied and the repack succeeded (PATCH 4 and 5 are `required:false` and may FAIL
  without blocking) — which is what makes the "required effort patches failed" throw (PATCH
  8a/8b/8c/9) safe: the install is still whole. The candidate is seeded from the *established
  pristine bytes*, not the live binary, whenever the live binary is not itself provably pristine —
  regardless of what the manifest says.
- **Whatever the seed, the bytes about to be patched must carry no clodex patch marker.** The live
  binary is checked on the bootstrap path, and a backup is checked after it is seeded, because
  `verifyPristineSource` only proves the *version* — and a patched claude reports its version
  perfectly well. A poisoned backup is reachable (every clodex before content addressing snapshotted
  whatever was live when no backup existed), and patching one would both double-patch the install
  and launder the result into a content-addressed name that is otherwise trusted on sight. Both
  reachability paths are observed, not hypothetical: pre-content-addressing clodex snapshotted
  whatever was live when no backup existed, **and the version-resolution bug generated exactly that
  state**. That check runs **before** any write to the backup directory, so a poisoned backup can
  neither be adopted nor clobber the `native-binary.backup` mirror. Extraction is expensive (~250 MB), so it
  happens **once**: the candidate is seeded from the live binary and inspected there — a
  byte-identical copy — and the same extraction feeds the patch when the verdict is "unpatched".
  Only unusable bytes pay for a second seed + extract.
- **Local patches are explicitly trusted code and an extension, never a local-only mode.** Only
  `~/.clodex/local-patches.mjs` (respecting `CLODEX_HOME`) is considered, and only after
  `--enable-local-patches` persists the opt-in; there is no cwd, package, dependency, or
  `node_modules` discovery. `inspectLocalPatchSource` captures and hashes the module **without
  executing it**. Execution happens only inside `applyPatch`, after required built-ins succeed,
  against their pristine-seeded output. The set is all-or-none: any load, validation, marker,
  transform, or post-local built-in verification failure discards every local mutation but still
  publishes the complete built-ins. Host-generated `/*clodex-local:<id>*/` markers are distinct from
  the blocking `/*ccpatch:` tier, and local transforms may not alter prior local markers or built-in
  sites. Keep the module deterministic and self-contained — only its entry bytes participate in
  freshness.
- **Patch-marker detection is two-tier** (`patch-backup.ts`). Only the `/*ccpatch:` prefix —
  clodex's own injected text — may *block*, and it covers everything current clodex publishes
  because PATCH 8a/8b/8c/9 are required and each emits one. The weaker legacy signals (PATCH 4's
  description text, PATCH 5's picker dedupe guard, `"clodex:` ids) only *warn*: they can collide
  in principle with Claude Code's own bytes, and a false positive is **unrecoverable** — refusing to
  bootstrap tells the user to reinstall Claude Code, which yields identical bytes and an identical
  refusal. A missed legacy patch is recoverable by comparison. **Proof blocks, heuristic warns.**
  The proof tier has one known narrow gap: a pre-effort-sites clodex emitted `/*ccpatch:ctx*/` only
  when some model had a non-default context window — verified against the real 2.1.220 bundle.
- **Pristine backups are content-addressed:** `~/.tweakcc/claude-<ver>-<sha256 prefix>.orig`, so one
  name can never hold two different contents and every backup self-validates by rehashing. A backup
  becomes the pristine source ONLY when its provenance is established: the version tag must equal
  the version probed from the binary being patched, its hash must match its own name, and a legacy
  `claude-<ver>.orig` (no hash in the name, possibly mislabeled by an older clodex) must
  additionally report that version when executed (`verifyPristineSource`). Conflicting or
  unverifiable backups produce a loud error, never a copy. This gate covers both consumers —
  `applyPatch` seeds its candidate from those bytes, and **`clodex patch --restore` copies straight
  over the live binary** (nothing to publish atomically), so an unverified backup would be a silent
  downgrade either way. An already-patched binary is never snapshotted as pristine. Legacy backups
  are adopted (copied to their content address) rather than orphaned — and whether the canonical
  name already holds the right bytes is decided from the scan's **content hash, not `existsSync`**,
  so a truncated or foreign file parked there is replaced instead of adopted and published. Every
  write into the backup directory goes through `publishBackupFile` (temp + `rename`), because an
  interrupted ~250 MB `copyFileSync` would leave a truncated file under a name asserting its content
  hash — the one corruption content-addressing cannot notice without re-hashing.
  `~/.tweakcc/native-binary.backup` is still mirrored from the pristine bytes for `tweakcc
  --restore`.
- **`clodex patch --restore` must work on a binary that no longer runs** — that is what a pristine
  backup is *for*. It resolves the version from `claude --version` when it can, and otherwise falls
  back to the manifest's `claudeVersion` when `manifest.binaryPath` matches the resolved install,
  establishing provenance without executing anything. The patch path keeps the hard `version-unknown`
  failure (patching is elective; restoring is the way out), and its error message names `--restore`
  as the recovery.
- **Binary resolution bypasses PATH shims** (cmux installs a shim copy):
  `TWEAKCC_CC_INSTALLATION_PATH` → `~/.local/bin/claude` → `findClaudeBinary()`. **The version is
  probed from that resolved binary** (`getClaudeVersionForBinary`), never from
  `getInstalledClaudeVersion()`, whose PATH lookup can land on a different install and whose
  `'2.1.183'` fallback is only safe for request metadata. The version names the backup that gets
  restored, so borrowing it from a shim silently downgraded the user's Claude Code.
  `resolveClaudeBinaryForPatch` returns `binary-not-found` vs `version-unknown`; the launch-time
  check stays non-fatal for both.
- Concurrency lock `~/.clodex/patch.lock` (pid + 10-min staleness + ESRCH liveness); the loser skips
  with a notice — never blocks, corrupts, or double-patches.
- `runLaunchPatchCheck()` in `clodex claude`: interactive y/N offer when stale; non-TTY or
  `--dry-run` prints a one-line stderr notice and proceeds. It may read/hash an enabled local module
  for freshness but must never execute it unless the user accepts. Wrapped in try/catch — a
  patch-check failure must never break launch.
- Context is omitted from the patch map when unknown or equal to Claude Code's 200k default;
  `[1m]`-suffixed model ids and explicit context are mutually exclusive in the transforms.
- **The per-site transforms in `patch-transforms.ts` (regexes, replacements, ordering, SKIP/FAIL
  semantics) are hard-won — change them only with byte-for-byte equivalence evidence on a real
  binary.** "Applied once, emitted one marker" **cannot** distinguish a correct match from a
  catastrophic over-match; both produce exactly those numbers. Assert the **matched span** and the
  **enclosing function of every rewritten reference**, run the real `applyClodexPatches` over every
  extracted bundle, and execute the emitted patch — reading it is not evidence that it runs.

---

