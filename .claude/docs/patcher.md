<!-- Read when changing src/patcher.ts, patch-transforms.ts, patch-backup.ts, local-patches.ts,
     built-in-patch-proofs.ts, bun-entry-module.ts, bun-bundle.ts, or anything about
     `clodex patch`. -->

# Patcher

`src/patcher.ts` + `src/patch-transforms.ts` + `src/built-in-patch-proofs.ts` +
`src/local-patches.ts` + `src/patch-backup.ts` + `src/bun-entry-module.ts` + `src/bun-bundle.ts`.

`clodex patch` uses tweakcc's programmatic API — an exact-pinned, declared runtime dependency
(externalized in `tsup.config.ts`; it brings `node-lief` for native repacking and `ink`/`react` for
its picker, which is why `patcher.ts` loads it via lazy `import()`). **Never `npx`, never the
network.** Flow: `tryDetectInstallation({ path })` → `readClaudeBundle` → `applyClodexPatches(source,
config)` (in-process pure function applying built-in PATCH 1–10 sites) → optional
`applyLocalPatches` transaction with built-in postcondition verification → `writeContent` (repacks
the native binary) → `applyBundleWritePlan` (points each patched module at its own payload). Both
layers return per-site OK/SKIP/FAIL results shown by `--trace`. Since 2.1.229, the reads and the
repack are each wrapped in the entry-module shim below, without which tweakcc cannot find the
bundle at all.

tweakcc ships no `.d.ts` despite its `types` field — `src/tweakcc.d.ts` declares the verified API
surface; re-verify when bumping the pin. `node-gyp-build` is a deliberate direct dependency even
though no clodex source imports it: a node-lief release demoted it to a devDependency while still
`require`-ing it at runtime (reported against 1.3.1; the lockfile currently resolves 1.3.0), so
fresh installs resolved a node-lief throwing
`Cannot find module 'node-gyp-build'` — which tweakcc's lazy loader swallows into a null and clodex
surfaces as the misleading "Failed to extract JavaScript from native installation" (the same message
a module-name mismatch produces, so read the entry-module section below before chasing this one).
Declaring it
ourselves guarantees it lands somewhere node-lief's `require` can resolve — that is the invariant to
check any alternative fix against, which matters because this repo uses pnpm's strict non-hoisted
layout with exact pins. Keep it even after node-lief fixes the packaging.

The built-ins bake favorites + aliases into the binary: model validation, `/model` listing, alias
resolution, context windows via a `/*ccpatch:ctx*/`-marked map, per-model effort
capabilities/defaults, and child-command network isolation.

## The bundle is many modules (`bun-bundle.ts`)

Claude Code 2.1.242 code-split its bundle — one ~28 MB Bun module became a ~20 KB entry stub plus
~1,374 `chunk-*.js` siblings. tweakcc reads and writes exactly ONE module, the one it recognizes by
name, so `clodex patch` started seeing a stub with none of its anchors in it and aborted at
`PATCH 1` on all eight published builds at once. `.claude/docs/claude-code-internals.md` has the
bundle-side detail and the module counts.

`bun-bundle.ts` keeps the old contract: `readClaudeBundle` reads every module Bun will execute as
JavaScript and joins them with a ``/*clodex:module-boundary`;{}"]*/`` line, `applyClodexPatches` still sees
one document, and `splitBundleSource` cuts it back up. **The transforms did not change and must not
have to.** A patched document with the wrong number of boundaries is a hard failure, not a best
effort: a boundary consumed by an anchor would silently move code between modules.

**Selection is by Bun's loader id, not by name.** Only `loader === 1` — what Bun executes as
JavaScript — is part of the bundle. The vendored assets (`mermaid.min.js`,
`hljsBundle.generated.min.js`, `chart.umd.min.js`) are `.js` files that Bun never runs, and feeding
megabytes of foreign JavaScript to anchors that must match exactly once is a way to invent
ambiguity and refuse a release that is perfectly patchable. Two consequences follow, and the second
is easy to miss: **a module's position in the blob table is not its position in the bundle**, so
every repoint is addressed by table index; and **the read corpus grew for old releases too** — a
pre-split blob holds five ~2 KB loader-1 stubs (`image-processor.js`, `audio-capture.js`,
`url-handler.js`, `computer-use-*.js`) beside the bundle, which tweakcc's read never included.
Checked on a real 2.1.232: none of them contains any anchor, any `process.env` read, or anything
the whole-bundle count guards in PATCH 5 and PATCH 10 look at.

**The write is one repack plus a pointer edit, and both halves are load-bearing.**

- Calling `writeContent` once per changed module is not an alternative. Each ELF repack relocates
  the whole ~290 MB blob to `align(nextVirtualAddress())` and extends the segment, so six of them
  would leave a multi-gigabyte `claude` and take minutes. Mach-O and PE assign in place, so this is
  invisible on macOS and Windows — the same asymmetry that hid the restore-sweep bug.
- So every changed module's patched source is concatenated (NUL-separated, because Bun
  NUL-terminates every string in the blob and tweakcc only terminates the buffer as a whole) into
  the one buffer tweakcc writes, and then `repointBunModuleContents` rewrites the 8-byte
  `{ offset, length }` pair in each module's struct to address its own slice. Nothing moves and
  nothing grows; the bytes are already in the blob.
- **The module tweakcc writes has to come first in that buffer**, because its position is the only
  one knowable before the repack — every other slice is addressed relative to it. After the repack
  `applyBundleWritePlan` re-reads the table, refuses if the recognized module is not the one the
  plan was built around or does not hold exactly the bytes that were written, and then reads every
  repointed module back and compares it to the patched source it should be. A module left pointing
  at its neighbour's bytes would start and then misbehave, which is much worse than a patch that
  refuses.
- **When the only changed module is the one tweakcc writes, the plan degrades to today's single
  call with no pointer edit** — which is every release up to 2.1.241, **for the built-ins**. Read it
  as a statement about the WRITE, and only about a patch whose edits all land in that one module: a
  local patch that changes a helper module does produce a repoint on those releases too.
  The READ changed on every version. The joined document has always been more than the entry
  module, because a pre-split blob carries five loader-1 helper stubs beside it — verified on 18
  binaries from 2.1.208 to 2.1.241, all six-module, entry first. For a built-in that is inert
  (measured on a real 2.1.232: no anchor and no count-guard text in any of the five), but a LOCAL
  patch that appends or prepends by position rather than matching an anchor now lands in a
  different module than it used to. README says so where a local-patch author will see it.
- **A repoint is a write AFTER tweakcc's repack, which signs on its way out.** Restoring the
  entry-module name re-signs and covers the normal path; `resignMachOBinary` covers the binary that
  needed no shim. Skip either and macOS refuses to start the result.
- Bun runs the module SOURCE, not the bytecode that sits beside it — verified on a real 2.1.243
  build, see `claude-code-internals.md`. Without that, none of this would have any effect.

## The entry-module shim (`bun-entry-module.ts`)

tweakcc finds the module holding the bundle **by name**, and Claude Code 2.1.229 renamed it from
`/$bunfs/root/src/entrypoints/cli.js` to `/$bunfs/root/cli`, which none of tweakcc's six accepted
names match — so `readContent` threw and 2.1.229 and later could not be patched at all. (2.1.228 is
the last `discoverable` release; 2.1.230 was never published.)
tweakcc **4.3.3** added `/cli` to that list, but bumping the pin alone changes nothing: clodex
mirrors the accepted-name list in `tweakccRecognizesModuleName` and it has no `/cli`, so the shim
keeps firing until it is deleted. `.claude/docs/claude-code-internals.md` has the bundle-side
detail. **Delete this shim once the tweakcc pin reaches 4.3.3, or once tweakcc identifies the module
by `entryPointId`.**

The name is used for identification only, so `shimEntryModuleName` swaps it for a stand-in of
**identical byte length** (`/clodex--/claude` for a 16-byte original) that tweakcc does recognize,
and `restoreEntryModuleName` puts the real name back. Equal length is the whole safety argument: no
offset, length, or size field in the blob changes, so the edit is a pure byte overwrite that
tweakcc's own repack reads back as an ordinary module name.

- **The shim must never survive into a published binary.** Claude Code's other modules
  (`image-processor.node`, `audio-capture.node`, …) live at `/$bunfs/root/*` and resolve against the
  entry module's own directory, so shipping the stand-in name would break them. It is applied twice —
  around `readContent`, and again around `writeContent`, which re-parses the candidate — and undone
  after each.
- **`restoreEntryModuleName`'s `resign` flag is load-bearing, and `false` is not the safe default.**
  Re-signing is *required* after a repack, because the write invalidates the ad-hoc signature and an
  unsigned Mach-O will not run. It is *forbidden* on the read path, because `codesign` replaces
  Claude Code's own signature: the seeded candidate stops being byte-identical to the install it came
  from, and the bootstrap path publishes exactly those bytes as the content-addressed pristine
  backup. In development this produced a backup whose content hash did not match the hash in its
  own name; it never shipped, and only an end-to-end run caught it, because a synthetic non-Mach-O
  fixture never reaches `codesign`. The candidate is now re-hashed against `plan.pristineSha256`
  immediately before it is published as a backup, so drifted bytes fail loudly instead.
- **Only rename when tweakcc would otherwise find nothing.** If any module name already matches, the
  shim is a no-op — a second match could hand tweakcc a different module than it picks today, and
  every release before 2.1.229 must keep behaving exactly as it did. This is also what makes the
  two selectors agree: tweakcc *reads* the first name-matching module but *rewrites every* one,
  while the shim renames the entry module specifically. Refusing to fire when a match already
  exists guarantees exactly one match, so all three always mean the same module.
- Locating the name parses the Bun blob directly (scan back from EOF for the trailer, recover the
  blob start from its own `byteCount`) rather than the executable container, so it needs no
  `node-lief`. **Verified on Mach-O only** — ELF and PE are inferred from tweakcc's own reader.
  Every derived offset is bounds-checked and every name must be printable and NUL-terminated: a
  misparse returns null — leaving tweakcc's own error — instead of overwriting sixteen bytes at a
  guessed offset.
- **More than one trailer can be in the file, so the scan validates rather than trusting position.**
  Repacking is not size-neutral (an identity repack of 2.1.231 on Mach-O *shrinks* the blob by 61
  bytes; ELF relocates instead, see below) and
  the replacement section content is written over the old, so the previous blob's trailer survives at
  a **higher** offset. Real binaries also carry a decoy `---- Bun! ----` around 55 MB — Bun's runtime
  ships the literal in `__TEXT`. Candidates are therefore tried from EOF backwards and the first one
  that validates wins. `TAIL_SCAN_BYTES` is a cost bound with a hard floor: the last trailer sits
  683–802 KB from EOF on real binaries, and a window below that silently disables the shim.
- **Restoration is swept, not assumed.** Locating the blob is a search, so "I wrote the name where I
  found the marker" is weaker than it sounds — it is also true of a write into a stale copy while the
  live blob stays shimmed. So after the parse-directed write the whole file is scanned and the real
  name goes back over **every remaining copy that is a module name**, then a second scan proves none
  is left. That is what holds the never-publish-the-stand-in rule up, and it does not depend on the
  parse having picked the live blob: the stale-copy case gets the real name too.
  Read that rule precisely: it is *never publish a binary that resolves its entry module to the
  stand-in*, not *never let those sixteen bytes appear anywhere*. Inert copies may legitimately
  remain — a local patch is allowed to contain the literal — and they are harmless because Bun's
  parser only accepts a NUL-terminated name.
  Refusing to publish on any surviving copy — the earlier behaviour — could not distinguish that
  case from a benign one, and **every ELF build produces the benign one on every patch**. tweakcc
  branches on container format, and only the ELF-with-a-`.bun`-section path *relocates* the section
  to `align(nextVirtualAddress())` and repoints `BUN_COMPILED`; the original bytes are stranded
  rather than overwritten, so the previous module table survives with one orphan copy of the
  stand-in at its original offset, below the relocated blob, while the live table is correct.
  Mach-O and PE assign in place and leave none. That refusal made every Linux install — x64 and
  arm64, glibc and musl — unpatchable from clodex 2.5.2 on, for every Claude Code release since
  2.1.229; macOS and Windows were never affected.
  Relocation is also why an ELF candidate is ~2.4x the pristine binary (324 MB → 770 MB on
  linux-x64 2.1.233), with roughly 2 GB live while candidate, backup and tweakcc's temp coexist.
  That predates the shim — 2.1.228, which needs no shim at all, balloons identically — and it does
  not compound, because the candidate is reseeded from pristine bytes on every run. Do not add a
  size sanity bound: at 2.37x today, any plausible cap would recreate the refusal this replaced.
  Rewriting is sound only while every rewritten copy is one the shim wrote, so `isModuleNameAt`
  requires a trailing NUL and `shimEntryModuleName` declines a binary whose blob already carries a
  marker *as a module name*. Without that test the sweep reached content the guard could never have
  seen, because a local patch's output only lands in the file at `writeContent`, long after the
  guard ran — a patch emitting the stand-in literal had it rewritten to the real name in the
  published binary while `clodex patch` reported success. Both halves need the same predicate:
  narrowing only the sweep would leave the literal in place and then trip the guard on the next run,
  making the binary unreadable.
  **The NUL test narrows this case; it does not eliminate it.** Bun NUL-terminates every string
  field in the blob, not only module names, so a local patch that emits the stand-in immediately
  before a NUL is still rewritten — reproduced against a real repack. Proving an occurrence is a
  module name means parsing the stale table it belongs to, which is not worth adding to a module
  that disappears entirely once tweakcc recognizes `/cli` and the rename goes away. Deleting the
  shim closes this by construction; until then it is a known, opt-in-only limitation — tracked in
  issue #129, which also records the one behaviour the deletion must not silently drop.
- `scripts/extract-cc-bundles.mjs` needs the same shim to read a 2.1.229-or-later bundle. It shims a
  **scratch copy**; the `.orig` backups are the only pristine bytes on the machine and nothing may write to
  them.
- **`scripts/probe-patch-mechanism.mjs` is how you check this on a platform you are not running.**
  The refusal above shipped because every check we had ran on Mach-O, where the ELF behaviour it
  turned on cannot occur. The probe drives the same shim → `readContent` → repack → restore cycle
  `applyPatches` runs, against a Claude Code build for any platform, **without executing it** — so
  a linux-arm64 or win32-x64 binary can be checked from macOS, and it calls the exported functions
  rather than a copy so it cannot drift.

  ```bash
  node scripts/probe-patch-mechanism.mjs <claude-binary> --label linux-x64 --expect-version 2.1.233
  ```

  It checks that the binary parses, that the seeded candidate is byte-identical to the release
  (what the content-addressed pristine backup depends on), that the restore leaves no stand-in
  behind, that a repacked Mach-O still verifies under `codesign`, and that the published bytes read
  back carrying what was written.

  **It also applies every patch site to that build's own bundle** (`scripts/probe-patch-sites.mjs`,
  which calls the real `applyClodexPatches` with a synthetic config that activates all of them),
  fails on any `FAIL`, `SKIP`, missing or duplicated site, and repacks **what the transforms
  produced** rather than the pristine bytes — so the byte-for-byte readback also proves clodex's
  own emitted patch survives the PE/ELF/Mach-O round trip. Anchors were assumed platform-independent
  until Claude Code 2.1.238, where `PATCH 5: model picker options` matched five builds and missed
  `linux-arm64`, `linux-arm64-musl` and `win32-arm64`.

  Two things it still cannot tell you: **that the patched binary runs**, and **that an anchor bound
  to the function it was aimed at** rather than a lookalike that also emits valid JavaScript. Only a
  host or containerised `clodex patch` answers the first. `clodex patch` resolves the version by
  executing the binary (`getClaudeVersionForBinary`), which is exactly why a foreign binary can go
  through the probe and not through the real command.

  `tests/probe-patch-sites.test.ts` pins the probe's synthetic config and its expected-site list
  against the real transform set — so a new or renamed `PATCH` site reddens `pnpm test` rather than
  failing five platforms in the hourly canary. Revisit it whenever you bump
  `PATCH_TRANSFORMS_VERSION`.

## Patcher invariants

- **The eight published builds of one Claude Code version are eight different bundles, and a
  minified identifier is not stable across them.** 2.1.238 named the `/model` picker's builder
  `(e,t,r){let n=…}` on five of the eight published builds but `(e,t,n){let r=…}` on linux-arm64,
  linux-arm64-musl and win32-arm64, so PATCH 5's anchor — which spelled `r` out — matched five
  builds and silently dropped every picker entry on the other three. Tie repeated names together
  with back-references instead of spelling them out, and when the replacement has to name a
  variable, capture it from the match rather than assuming the name. **Wildcarding alone is not
  enough**: an anchor made of pure structure (ternary → loop → call) identifies nothing, and a
  review demonstrated a same-shaped neighbour being patched, with status `OK`, once the real site
  drifted out of the match. Keep a semantic discriminator that only the intended site can satisfy —
  for PATCH 5 that is the builder's own `"opus"`/`"sonnet"` comparison — and **count the
  discriminator across the whole bundle, not just the anchor**. "Matched once" means one candidate
  survived, not that it was the right one: a second review built a twin carrying its own
  opus/sonnet selection, moved the real picker out of the match by turning `for(` into `for (`, and
  PATCH 5 injected into the twin and reported success. Because the anchor begins with the counted
  expression, at most one site in the bundle can match it. Read that guarantee precisely — it
  holds **only while the real site keeps spelling the discriminator the way the count spells it**.
  Were
  the picker respelt upstream to the equivalent `(x==="sonnet"||x==="opus")` while something else
  adopted the counted spelling, the survivor would be the wrong function again; if only the
  spelling drifts, the count goes to zero and PATCH 5 fails loud, which is the safe direction.
  Note also that both regexes are **lexical, not syntax-aware**: they match inside block comments
  and template literals (executed — one match each), so "occurs once" is a claim about bytes, not
  about executable code. **An identity oracle must be derived from content, never position** — an
  oracle that took "the function following the built-in option factory" blessed that same twin,
  because the twin was inserted into exactly that gap. Note what the replacement does and does not
  prove: it validates the appender the builder loops through, so a different caller of the genuine
  appender would inherit that evidence; it rejects the realistic impostor, which brings its own.
  Verify with the real-bundle
  harness over **every platform's** bundle (`scripts/extract-cc-bundles.mjs` reads a foreign binary
  fine), not just this Mac's: the canary's probe legs exercise zero patch sites, so win32-arm64
  recorded a `pass` for the release this broke.
- **An anchor that spells out a statement upstream can delete is a required patch waiting to fail.**
  Claude Code 2.1.239 moved BOTH ends of PATCH 10's child-env builder in a single release — the
  opening `let` gained an optional call and a *destructuring* declarator (`{settingsColorEnv:n}=e`,
  so the declarator run now carries braces), and the GitHub-Actions input scrub the anchor ended on
  (``delete p[`INPUT_${f}`]``) was deleted outright. PATCH 10 is required, so every one of the eight
  published builds refused to patch at all. Neither end was load-bearing for the replacement: what
  the transform needs is the function's opening brace, its body, and its closing brace. Describe
  each end by what the builder MEANS and let back-references tie the repeats:
  * the head runs from `function X(){let ` to the `CLAUDE_CODE_REMOTE` ternary over `[^;{}]`
    characters **or one balanced `{...}` group** — that admits the destructuring and the `??{}`
    while still making it impossible to consume the enclosing function's closing brace, which
    would need an *unmatched* one;
  * the tail is `return <copy>}` where `<copy>` is **back-referenced** from the merged copy the
    builder declares (`let <copy>={...process.env,...}`), so it moves with any upstream rename and
    steps over a nested return of some *other* variable. It does NOT prove the match stopped on
    the function's own brace — the walk below does that.
  Identity is carried by the passthrough early-out — `)return process.env;let <copy>={` —
  counted across the WHOLE bundle before the anchor runs, the same discipline PATCH 5 uses. Over
  29 real bundles (2.1.208 through all eight 2.1.239 builds) it occurs exactly once and exactly one
  `<fn>(process.env.CLAUDE_CODE_REMOTE)?` ternary precedes it; on the 21 pre-2.1.239 bundles the
  widened anchor's matched span is **byte-identical** to the one it replaces, which is what shows
  this is a widening and not a rebinding. The last line is a postcondition: walk the real block
  from the function's own `{` and require that it ends exactly where the anchor ended. A lazily
  found tail can stop in the wrong place in **either** direction and both are silent without it.
  Short: a nested `return <copy>}` ends the match inside the function, so only part of it is
  rewritten and live `process.env` reads survive. Long: minify the builder's own final
  `return <copy>}` into the comma form `return f(),<copy>}` — 400+ of those already exist
  elsewhere in 2.1.239 — and the tail runs past the true end into a neighbour and rewrites ITS
  `process.env` to a name out of scope there, which throws at runtime. **Do not credit the
  `}<space>function` guard with stopping that**: a neighbour introduced as `};var x=()=>{` never
  matches it. Both shapes were executed against a real 2.1.239 bundle; with the walk they refuse,
  without it they report `OK`.
  **Tally `{` and `}` as characters and you get this backwards in both directions**: a single `"}"`
  in a string refuses a builder that patches fine, and that same string brace offsets the `{` of a
  nested `return <copy>}` so a truncated match reads as balanced. The walk therefore skips strings,
  template literals and comments. It reads `/` as division, never as a regex literal — telling
  those apart needs the grammar. **That is a known limit, not a safe approximation.** A review
  built `…if(x){var re=/}/;return <copy>}…;return <copy>}`, where the unbalanced `}` inside the
  regex literal moves the walk's zero-crossing onto the nested return: the truncated match agrees
  with it and PATCH 10 reports `OK` with a live `process.env` read stranded past the rewritten
  span. Left as-is deliberately — zero instances across the 29 real bundles, it needs a regex
  literal no minifier emits here, and closing it means parsing JavaScript. Calibrate it the way
  this file calibrates PATCH 5's surviving hole: every wrong bind reachable from a shape a real
  build could emit fails loud.
  Count the discriminator against the **original source**, not the partly-patched buffer: PATCH 4
  and PATCH 5 splice user-supplied model display text into the bundle, so counting afterwards lets
  a model label that happens to contain the signal refuse a patch that would otherwise succeed.
- **Calibrate a patch-anchor weakness by corpus reachability and by which direction it fails, not
  by whether an attack can be constructed** — one always can, against every site we ship.
  PATCH 5's surviving hole needs upstream to make two coordinated changes at once (respell its own
  discriminator *and* introduce the counted spelling elsewhere, in a function that also matches the
  full anchor shape); it has zero instances across every bundle we hold, and it was accepted rather
  than defended. The reason is the incident itself: **this outage was caused by an over-specific
  anchor**, and every discriminator added is one more thing a benign upstream rename can break for
  real users. Weigh added specificity against that, prefer anchors that fail loud over anchors that
  fail silent, and let the canary — which now runs the real patch sites on Linux and the host —
  catch the loud ones.
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
  freshness. The `source` a local patch receives is **every JavaScript module joined with
  ``/*clodex:module-boundary`;{}"]*/`` lines**, not one module's text — on every version, not only the
  split ones, because a pre-split blob already carried five helper modules beside the bundle.
  A transform that adds or removes a boundary fails the whole patch loudly. State the rest of the
  guarantee precisely, because it is narrower than it looks: that is a COUNT check, so a local
  transform that MOVES text across a boundary while leaving the separators intact would relocate
  code into another module's scope and nothing would report it. What rules the built-ins out is the
  separator itself, not the count — see `bun-bundle.ts` — and local patches are explicitly trusted
  code that may use any regex at all, so for them this is a documented limit rather than a hole to
  plug. The positional case (append/prepend rather than match) is called out in README, where a
  local-patch author will see it.
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
  **An unprobeable binary is a hard error on the patch path** — patching is elective, so it refuses
  rather than guessing. `resolveClaudeBinaryForPatch` returns `binary-not-found` vs
  `version-unknown`; the launch-time
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

