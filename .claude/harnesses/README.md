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

## Patcher / PATCH 10

| Harness | Claim it settles |
| --- | --- |
| `pr78-patch10-anchor-over-real-bundles` | PATCH 10's anchor self-identifies the child-env builder across every real bundle — match count, bound function, matched span, and that no rewritten `process.env` reference escapes the declaring function. Extracts the regex from `patch-transforms.ts` so it cannot drift. The default first move on any anchor PR. |
| `pr78-patch10-wrong-target-mutations` | The three wrong-target classes — preceding decoy, token-bearing neighbour, nested named function — plus a `vm.Script` parse of the patched output. |
| `pr78-patch10-execute-real-builder` | Extracts the *patched* builder out of a real bundle and **executes** it with stubs. Reading a regex replacement is not evidence the code runs. |
| `pr78-r3-audit-proof-publication` | What actually reaches `writeContent`, driving the real `applyLocalPatchSet` → `builtInPatchProofsChanged` → `applyPatch` chain — a publication guarantee proven without repacking 250 MB. Self-contained. |
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
| `fix-parent-notice-tui-and-epipe-round2` | Parent notices under a real Claude Code TUI, plus async EPIPE containment. Needs a real binary; set `CLODEX_CLAUDE_PATH` and `MAINBASE_DIR`. |
