---
name: pr-verification
description: The bar a clodex change must clear before its PR is opened. Use when preparing a change for a pull request, writing or strengthening the tests for a fix, proving a bug is real before fixing it, self-checking your own work, or writing the PR description. Derived from ~100 merged and closed PRs. To review someone else's PR, use pr-review instead — it holds changes to this bar.
---

# Before you open a PR

Your change will be held to a higher bar than "the suite is green." Across ~100 merged and closed
PRs, three failures dominate — in this order. They are what most review rounds are spent on, and
every one of them is cheaper to catch now than after a reviewer finds it.

## 1. Tests must discriminate. Green is not evidence.

The single most common defect. Tests pass; the behavior they claim to pin is absent, unreachable,
or staged in a state production can never produce.

**The acceptance test: delete the feature and run the suite.** If nothing turns red, the tests are
theatre regardless of how many there are. One detector shipped with tests staging the scenario in a
data region the detector never touches — deleting the entire feature left **85/85 green**, and the
detector was dead in production.

- **Run the full file, not `-t` isolation** — they disagree, and CI runs the file. A test has
  passed in the full run and failed under `-t`.
- **Stage state through production producers.** For chain/head/normalization work, emit the item
  via `response.output_item.done` into the expected-assistant history; never plant it directly in
  the request input. That region is kept verbatim and can never diverge, so a test staged there
  passes no matter what the code does. This defect has now been seen twice.
- **Mutate each independent guard and precedence branch**, not just the happy path.
- **Include over-scope and under-scope negatives** — prove the change does not fire where it
  shouldn't.
- **Never accept the sha256 source-digest pin as the failing test.** It is a tripwire, not a
  behavioural test. A mutation that broke a real bridge leak passed **1329/1330** with the digest
  pin as the only red. If the pin is the only thing failing, the behaviour is unpinned.

## 2. Claims must not outrun evidence.

The second most common defect, and it is calibration, not dishonesty. Prose in the PR body, commit
message, test name, or doc asserts more than what was actually observed.

- **Label inference as inference.** Every categorical claim maps to a source fact, an authoritative
  contract, or an executed observation.
- **State the environment each measurement was taken in.** A green suite in a bridged shell proves
  nothing unless the ambient proxy is dead. Use an isolated `CLODEX_HOME`; disclose node version and
  proxy vars.
- **Re-measure baselines against current `main`.** A stale baseline reads as a regression.
- **Beware measurements that match themselves** — `ps -eo … | grep <pattern>` matches its own
  command line, which has produced false orphan counts twice.
- **Don't inherit claims from existing comments or docs.** A wrong comment in this repo was copied
  faithfully into a contributor's PR; we nearly asked him to fix our bug. If you repeat an existing
  claim, verify it.

## 3. Reachability decides severity.

A finding must name **who triggers it** and **what they must already control**. A mechanism you can
execute in a test but cannot reach from a real, supported configuration is hardening — say so
explicitly and give it no severity. If it requires compromising a host that already holds the
credential, the reachability is nil.

This repo is a trimmed fork, so **some code is vestigial** — it supports providers and options that
no longer ship. A fix to an unreachable path passes review and CI while the real bug survives. Two
PRs were closed on exactly this ground.

Before implementing, record: the user-visible symptom; the supported configuration and route; the
production callers from external input down to the branch; a real reproduction or wire capture; and
the alternative explanations you ruled out.

## Claims about Claude Code's own behavior come from the binary

Never from docs, comments, or a subagent's summary. Raw byte greps do **not** work — the bundle is
compressed inside the native binary. Extract it with `node scripts/extract-cc-bundles.mjs`; the
procedure, and what is already known so you need not re-derive it, are in
`.claude/docs/claude-code-internals.md`.

Then **enumerate every branch of the function yourself.** Shipped bugs have come from reading the
two gates that happened to be visible. Grepping one syntactic form of a comparison is not an
enumeration — grep the *value*.

## Pre-PR gate

Ordered by how often each would have caught a real finding.

1. **Feature-deletion mutation**, full-file run. Mandatory for any detector, guard, canary, or
   warning.
2. **Enumerate sibling shapes of the same signal** and say which you checked. Four follow-up-fix
   chains exist because a fix was written against the one captured example rather than the class —
   same signal, different arrival point.
3. **Mode matrix, not a single path.** proxy × endpoint × interactive × background-agent, whenever
   `launch.ts`, `env.ts`, `claude-wrapper.ts`, `proxy.ts`, or the gateway is touched. Interactive
   sessions have hidden a bug that broke every background agent session.
4. **If the deliverable is user-visible output, run the real user command and read the actual bytes
   on fd 1/2.** Assertions against a test-framework-replaced `console` cannot measure this. Capture
   a real Claude Code session under `tmux` for terminal output.
5. **Trigger every new failure path** rather than reasoning about it — dead pipe, missing binary,
   malformed env value, hostile control characters. Verify that any fallback a comment claims can
   actually run.
6. **Resource-delta check** for anything creating temp dirs, files, processes, or listeners. A
   test-sandbox change leaked one directory per test file; 2467 had accumulated before it was
   found.
7. **Doc accuracy sweep.** Grep this file, README, `docs/`, and `cli.ts` help strings for every
   symbol, flag, and env var in the diff, and re-read for *accuracy and scope* — not just presence.
   Overstated coverage claims go stale silently.
8. **Rescue-path check.** Enumerate the degraded and recovery paths (`--restore`, fallbacks, offline
   modes) that must keep working when your new invariant's precondition is unavailable.
9. **Concurrency check.** `git log main --since=<branch-cut> -- <touched files>` and `git merge-tree`
   against current `main`; state which open PRs touch the same region and the intended land order.
10. **Hostile composition.** `CLODEX_HOME="$(mktemp -d)" pnpm test`, plus a write-path tripwire —
    `os.userInfo().homedir` ignores both `CLODEX_HOME` and `$HOME`.
11. **Standard gate:** `pnpm typecheck && pnpm test && pnpm build`. Necessary, never sufficient.

## Fit the change to the codebase

- **Follow existing patterns rather than introducing parallel ones.** Where the codebase already
  solves a problem — file locking, credential resolution, stale-state detection — match the
  established approach. A new mechanism that is subtly weaker than the existing one is much harder
  to spot than an obvious bug, and several of these are documented precisely because the weaker
  version was tried first.
- **Update every consumer.** When you change a representation — a type, a stored format, a sentinel
  value — search the tree for readers of the old form. A missed consumer is where the real bug
  hides, especially in auth code, where the failure is silent rather than loud. Grep the *value*,
  not one comparison spelling.
- **Consider the upgrade path.** If a change affects data persisted in `~/.clodex` or the system
  keychain, make sure an existing install still works after upgrading, or add a migration.
- **Don't leave no-op edits behind.** A conditional whose branches are identical, an option parsed
  but never read, a helper implemented but never called — these read as finished work and quietly
  aren't. If you started a change and decided against it, revert it rather than leaving the
  scaffolding.

**When a change touches a launch path, smoke test the product, not just the path you changed.**
Launch real Claude Code through clodex on the default proxy mode and confirm it answers:

```bash
# Anthropic passthrough — always run this leg; it needs only your normal Claude Code auth.
clodex claude -- --model haiku -p 'Reply with exactly: HAIKU-OK'

# Translated leg — one model per provider you have credentials for, using your own alias.
clodex claude -- --model <your-openai-alias> -p 'Reply with exactly: MODEL-OK'
```

**Run the Anthropic leg plus every other provider you have access to that the change could
affect.** A shared-code change — error formatting, status mapping, usage accounting — can be
perfectly fine on the translated path and broken on passthrough, or fine on one provider and broken
on the next. Passthrough is the leg people forget, because it looks like the path clodex "doesn't
touch."

Add an `--endpoint` leg when the change touches `buildChildEnv` or the gateway. If you lack
credentials for a provider your change plausibly affects, say so in the PR rather than leaving it
unmentioned — an untested provider is a known gap, not a silent one.

Curl against a running server is a fallback, only for wire shapes the client will not produce.

**A change made after review earns a new review**; a redesign earns a fresh one, not a re-read. And
"not a regression versus `main`" does not excuse shipping a broken guarantee — if the change exists
to make a class of failure unreachable, judge it against that goal, not against the status quo.


## PR descriptions

**The first paragraph is for a clodex user, not a reviewer.** Plain language, no jargon: what was
broken or missing, and what is different now. Someone who only reads that paragraph should
understand the purpose of the PR.

Everything after it is for reviewers and may be as technical as needed. Cover, in order: the
user-visible failure; root cause and production reachability; the change and what you deliberately
left out; the discriminating tests and mutations you ran; real runtime evidence with the environment
it was measured in; assumptions or boundaries you could not verify; and failure/rollback behavior.

Stating what you could *not* verify is a strength, not a weakness — the best PRs in this repo's
history do it routinely.

---

