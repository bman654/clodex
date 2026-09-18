# Review harnesses

Verification harnesses written during past reviews, one per claim someone needed to settle. **Check
here before writing a new one** — a differential harness was once rebuilt from scratch that already
existed in this folder.

## How to use them

These are **starting points, not fixtures.** They were written against the head of a specific PR and
some are pinned to a bundle version or a since-changed function shape. Expect to fix imports and
re-point paths; that still beats starting from nothing.

They are named `*.harness.ts`, **not** `*.test.ts`, and they live outside `tests/` — two reasons
`vitest.config.ts`'s `include: ['tests/**/*.test.ts']` never collects them. Several would fail at
collection, one would hang unbounded, and a few would pass vacuously with zero assertions, so copy
one into `tests/` only after you have run it and confirmed it actually asserts something.
`tsconfig.json` includes only `src`, so nothing here is typechecked either.

Several need real Claude Code bundles. Extract them once with
`node scripts/extract-cc-bundles.mjs` and point `REVIEW_BUNDLE_DIR` at the output.

## Patcher / PATCH 5, PATCH 6 and PATCH 10

| Harness | Claim it settles |
| --- | --- |
| `cc238-patch5-anchor-over-real-bundles` | PATCH 5's /model picker anchor binds one builder per bundle **at the sole model selection**, identified from the builder's own content rather than from what it sits next to, pushes into the array that builder returns, and the patched builder **executes** and yields the entries. Per bundle it also runs the strongest wrong-target attack — a twin carrying its own opus/sonnet selection while the real picker drifts by one space — and re-runs the pre-2.1.238 anchor to assert the exact set of builds it missed. Copy this one when a release moves the picker; the position-derived oracle it replaced blessed the twin. |
| `pr78-patch10-anchor-over-real-bundles` | PATCH 10's anchor self-identifies the child-env builder across every real bundle — match count, bound function, matched span, and that no rewritten `process.env` reference escapes the declaring function. Extracts the regex from `patch-transforms.ts` so it cannot drift. The default first move on any anchor PR. |
| `pr78-patch10-wrong-target-mutations` | The three wrong-target classes — preceding decoy, token-bearing neighbour, nested named function — plus a `vm.Script` parse of the patched output. |
| `pr78-patch10-execute-real-builder` | Extracts the *patched* builder out of a real bundle and **executes** it with stubs. Reading a regex replacement is not evidence the code runs. |
| `cc228-patch10-execute-real-builder` | The same execution proof against the real 2.1.228 bundle, whose builder gained a declarator and broke the anchor. Recovers every free identifier from the builder's own text, so a name it fails to account for is a ReferenceError rather than a vacuous pass. Copy this one when a new release moves the builder again. |
| `cc239-patch10-execute-real-builder` | The same execution proof against **all eight** real 2.1.239 bundles, the release whose builder moved at BOTH ends at once — destructuring declarator in the opening `let`, GitHub-Actions input scrub deleted from the tail — and which `clodex patch` therefore refused on every platform. One bundle is not enough evidence: platform builds of one release can be minified differently, which is how 2.1.238's picker anchor missed three of them, and 2.1.239 names this very builder `nO`/`nL`/`rO`/`nP` depending on the build. Copy this one when a new release moves the builder again. |
| `cc260-patch10-execute-real-builder` | The same execution proof against **all eight** real 2.1.260 bundles, the release that rewrote the remote-mode check the head anchor ended on (`<fn>(process.env.CLAUDE_CODE_REMOTE)?` became `a.CLAUDE_CODE_REMOTE===!0`) and which `clodex patch` therefore refused on every platform. It compares the eight patched builders after replacing every identifier-like token with its first-appearance index — a textual skeleton check, not semantic alpha-equivalence — then binds each builder's free names by that same index rather than by spelling, so one reviewed stub table covers all eight builds. Copy this one when a new release moves the builder again. |
| `pr247-patch6-resolver-region-over-real-bundles` | PATCH 6's alias-resolver region binds the tier resolver on every real bundle — anchor and region bind exactly once at the same offset, the region ends on that switch's own `default:return`, and the enclosing function's cases are exactly `opus/sonnet/haiku/fable/opusplan`, each of which `applyClodexPatches` is then shown to reject as an alias. Also proves the regression it fixes (an alias colliding with zod's `case"union":return`). **Re-pointed to the DYNAMIC region bound shipped in #247** (2000 of drift headroom plus the bytes of the cases PATCH 6 injects): LENS 2 now asserts that a re-patch is idempotent even at the 20 × 64-char alias maximum, and keeps the old fixed 2000 only to show the bug that motivated the change. LENS 2c pins the property that actually makes a growable bound safe — the anchor is unique, so a second `case"best":{` aborts the patch; the lazy quantifier alone is NOT sufficient, and the harness executes the two-anchor counterexample that proves it. LENS 2b reports the foreign-`default:return` margin **per release** (bundle versions come from filenames — a fifth of the corpus is filed under the wrong directory) and records, rather than hides, that a maximal alias config would exceed the margin on 2.1.252 and older, while every build from 2.1.257 on sits clear of it; it then asserts why even those old builds are unreachable: the only case names in the swallowed window are camelCase, PATCH 6 lowercases aliases before it looks for them, AND its presence test is case-sensitive — the last half executed against the shipped predicate with a config wide enough for the region to actually reach those labels (a one-alias config never did, and stayed green under a case-insensitive mutation). The copied regexes are checked against the shipped predicate's real verdict on discriminating inputs, **including a near-boundary pair that puts the region exactly on the computed bound and one byte past it, at three alias configurations** (one configuration pins only one total — a compensating `1000 + Σ(2·len + 67)` passed it) — without those, both `+ 17` → `+ 16` and `2 * a.length` → `a.length` left the whole harness green, because on a pristine build the resolver's own `default:return` is adjacent to the anchor and the bound is never consulted. That pins the coefficients and the headroom of any linear formula; it is not a proof that any conceivable rewrite of the formula reds. Whole-bundle equality goes through a length+digest comparison, because handing vitest two 36 MB strings to diff exhausted V8's heap and reported no counts and no failing test name — on the one mutation the harness exists to catch. Last verified against 57 bundles, 2.1.208 → 2.1.276. |
| `pr78-r3-audit-proof-publication` | Which local-patch outcome reaches the write, driving the real proof-capture → verify → discard chain in `applyPatch` without repacking 250 MB. Self-contained. It seeds a `pristine-native` file with no Bun blob, so it exercises the single-module fallback, NOT the native publish path — it says nothing about what `applyBundleWritePlan` writes. |
| `pr78-r3-audit-partial-drift` | A required literal appearing twice means migrating only one occurrence still validates. A one-occurrence fixture cannot show this. |

## Translation and transport

| Harness | Claim it settles |
| --- | --- |
| `pr80-differential-translate-vs-provider` | Two implementations agree, by driving both over a generated corpus and diffing canonical bytes, plus a key census. The harness that got rebuilt from scratch once — start here. |
| `pr82-idle-abort-vs-retry-budget` | The retry budget interacts correctly with the idle abort deadline. |
| `pr83-transport-replay-lens` | Which transport failures are replay-safe, across the partition matrix. |
| `pr93-billing-strip-differential` | The volatile billing header is stripped on every translated route. Captured `cch` values are replaced with placeholders. |
| `pr99-echo-invariant-real-socket` | The response-model echo survives over a real socket — load-bearing for auto-compaction. |

## OAuth continuation and credentials

| Harness | Claim it settles |
| --- | --- |
| `pr91-canary-blindspot-realistic-staging` | Staging through production producers rather than the request body. Written after the `requestInput`-vs-`expectedAssistant` defect was seen a second time. |
| `pr98-l1-pairing-attack` | Attacks the account/credential pairing invariant directly instead of asserting it. |
| `pr98-credential-leak-scan` | Disk-wide sweep for credential residue using synthetic canaries. The canary is built by concatenation so it does not trip push protection. |
| `pr98-credential-residue` | Credentials do not survive removal in any store. |

## Launch, proxy, terminal

| Harness | Claim it settles |
| --- | --- |
| `pr92-selfconnect-guard-matrix` | The self-connection guard across address forms — exact, loopback alias, wildcard bind. |
| `pr92-selfconnect-loop-repro` | Reproduces the recursive self-tunnel the guard exists to prevent. |
| `fix-parent-notice-tui-and-epipe-round2` | **BROKEN — does not run.** It imports `tests/helpers/register-ts-resolve-hook.mjs`, which was never committed, so both probes exit 1 at module resolution. Supply that hook before trusting anything here. Claim it was written to settle: parent notices under a real Claude Code TUI, plus async EPIPE containment. Needs a real binary; set `CLODEX_CLAUDE_PATH` and `MAINBASE_DIR`. |
