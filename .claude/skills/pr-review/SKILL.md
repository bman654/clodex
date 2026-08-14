---
name: pr-review
description: How to conduct a review of a clodex pull request — orienting on what actually changed, building an adversarial panel, the proof technique that fits each claim shape, mutation discipline, calibrating severity, and posting or merging the result. Use when reviewing a clodex PR, auditing a change, adjudicating a finding, or deciding whether a reported defect is real.
---

# Reviewing a clodex PR

The bar you are checking the change against is `.claude/skills/pr-verification/SKILL.md` — read that
first; this document is only about how to run the review itself. Everything here was paid for by a
review that got something wrong.

## Orient before you read code

- **Diff `head.sha` against your notes before re-reviewing anything.** GitHub does not make "what is
  new since my review" legible: a stale review request or an old force-push notification reads
  exactly like fresh work. One `gh api repos/bman654/clodex/pulls/N --jq .head.sha` settles it. A PR
  timeline that ends on your own review is the other tell.
- **When the author rebased, diff patch-vs-patch, not head-vs-head.** After a rebase onto a new
  release, `git diff old..new` is pure noise. Use
  `git diff $(git merge-base main X)..X` for each head and then `diff -u` the two patches. This is
  how you find out a "small update" was actually a full rebuild.
- **Before alleging the author skipped work or misstated a result, read the PR body *and* the
  comments, and tie every claim to the head it describes.** A reviewer once called a contributor's
  number an unsupported inference when the PR's own validation section stated the source in as many
  words — the same failure shape we warn contributors about, committed by the reviewer. Later, a
  panel drafted a note telling an author to re-run a gate his own transplant comment had already
  reported, with the exact numbers we had measured ourselves. After a rebase or transplant the
  current gate result often lands in a comment while the body still describes the dead head — but a
  comment ages the same way, so neither surface is authoritative until you match it to the head.
  Note what did *not* save us there: four lenses, a refuter pass, and a cross-family cross-check all
  missed it, and the cross-check actually endorsed the note and extended it. Only an explicit
  body-versus-comment check before drafting caught it. That is why this is a named step and not a
  thing you can expect the panel to notice.

## Build the panel

- **Size:** 4 lenses for a large or high-stakes PR, 2–3 medium, 1 trivial.
- **Cross-family is per stage, not per panel.** The principle keys on *who authored the thing being
  attacked*, so it flips downstream:
  - **Lenses** attack the PR's code → use the family opposite the PR's author.
  - **Refuters and the synthesis cross-check** attack the *lens's finding*, which your own model
    wrote → use the family opposite the lenses.
  Running same-family refuters against same-family findings is the panel's weakest link, and the
  refuter stage is precisely the one that has historically overturned findings. Mixing families
  within one panel is encouraged; it buys perspective diversity and spreads quota.
- **Refuters earn their keep, and they must attack the supporting facts, not the headline.** One
  panel overturned 3 of 5 BLOCKER/MAJOR findings, every time because a true-sounding claim rested on
  a false supporting detail. Brief them to default to `refuted=true` and to go after the load-bearing
  sub-claim.
- **A finding that originates in the cross-check stage has had no adversarial pass — refute it before
  posting.** A late blocker was killed by a single refuter that showed the same partial-proof pattern
  already existed on `main`, making the PR consistent with posture rather than departing from it.
- **Name your own weakest link in the panel prompt.** Flagging a doubt explicitly is what gets it
  attacked first and settled, instead of shipped.
- **Never cancel an in-flight panel to fix its model assignment.** Add the missing-family pass as a
  cross-check stage between synthesis and posting — same perspective, one stage instead of a restart.
- **Reproduce and judge; don't count votes.** When two lenses contradict each other, run it yourself.

If you drive the panel with `Workflow`: `pipeline(LENSES, review, verify)`, fan BLOCKER/MAJOR
findings to refuters, keep structured returns small (write findings to a file, return the path), and
point the final stage at the output *directory* rather than an enumerated list of returns — agents
that die on the return cap have usually already written their findings file, and a directory-scoped
final stage recovers their work for free. Backticks inside a workflow script's template literals
break the parser; build prompts with `[...].join('\n')`.

## Match the proof to the claim

| Claim shape | What actually proves it |
| --- | --- |
| "Claude Code behaves like X" | Extract the bundle and read it. See `.claude/docs/claude-code-internals.md`. |
| "This patch anchor matches the right thing" | Run the real `applyClodexPatches` over every extracted bundle; assert span and enclosing function. |
| "This emitted patch behaves correctly" | Extract the patched function out of the real bundle and **execute** it with stubs. Reading it is not evidence it runs. |
| "These two implementations agree" | A differential harness over a generated corpus, plus a key census. Not hand-written expected values. |
| "This is/isn't reachable in practice" | Mine the diagnostics ledgers for rate and reachability. |
| "This terminal output is safe" | Drive real Claude Code under `tmux` and read the actual bytes. |
| "Nothing consumes X" | Grep the **value**, not one comparison spelling, and trace every hit. |
| "This hunk is required by the feature" | Revert it and run the full suite. Only its own tests red, none of the feature's, is strong evidence it is severable — then trace the consumers to be sure. |

**Mining the ledgers.** `~/.clodex/logs/sessions/*websocket-diagnostics*.jsonl` is a large corpus of
real traffic and it has settled more disputes than any other technique. Gotchas: files exceed Node's
max string, so stream with `readline` and never `readFileSync`; mismatch detail is nested at
`.heads[].mismatch`, and the head clodex gave up on is the one with the **largest `firstMismatch`**;
`request_diagnostic.body` is an Anthropic-format structural summary, not the Responses `input`, so it
cannot reconstruct compared items. **The ledger stores hashes, not content — a historical replay is
impossible, so do not promise one.** Bucket by filename date to A/B a fix across a release boundary,
and map fixes to releases with `git tag --contains <sha> | sort -V | head -1` before crediting
anything.

**Ask which version each of the author's measurements was taken on.** A before/after that straddles
one of our own releases looks exactly like a working fix. Standing first question on any
performance or caching PR. Convert the steady-state rate into an expected count for their run size
before accepting "it went to zero" — 0 against an expected 4 is not signal.

## Reuse the harnesses

**Check `.claude/harnesses/` before writing any verification harness.** A differential harness was
once rebuilt from scratch that already existed there. Its README maps each harness to the claim it
settles. They drift — treat them as starting points, not fixtures — but starting from one beats
starting from nothing.

They are named `*.harness.ts` and live outside `tests/`, so `vitest.config.ts`'s
`include: ['tests/**/*.test.ts']` does not collect them. Copy one into `tests/` only after running
it and confirming it asserts something — several fail at collection, one hangs, and a few would pass
vacuously with zero assertions.

Bundle-dependent harnesses need `node scripts/extract-cc-bundles.mjs` run once, with
`REVIEW_BUNDLE_DIR` pointed at the output.

## Mutation discipline

- **Commit before mutation testing.** `git checkout HEAD -- <file>` restores from HEAD and silently
  discards uncommitted fixes; snapshot with `cp` instead.
- **Mutate both directions on a scoped fix** — revert the fix (positive tests must fire) and widen
  the guard (negative tests must fire).
- **Run the feature-deletion mutation in the full-file run, not `-t` isolation — they disagree.** A
  test has failed under mutation in isolation and passed in the run CI actually does.
- **Never accept the sha256 source-digest pin as the failing test.** A mutation that broke a real
  bridge leak passed 1329/1330 with the pin as the only red.
- **`Date.now()` ties are a real soundness hazard.** Two heads created in the same millisecond tie on
  `lastUsedAt`, and V8's stable sort then silently reverses which is "most recent". Any
  recency-dependent test must inject the `now` option that `responses-websocket.ts` exposes.

## Patcher review rules

- **"Applied once, emitted one marker" cannot distinguish a correct match from a catastrophic
  over-match** — both produce exactly those numbers. Assert the matched span and the enclosing
  function of every rewritten reference.
- **The decoy-fixture technique.** Adding one competing line to the fixture immediately before the
  target turns a mis-binding anchor from green into failing. Ask for it by default.
- **A fixture with no earlier candidate can only match correctly.** When an anchor's correctness
  depends on *which* of several candidates it picks, the fixture must contain a competitor or it
  proves nothing.
- **Re-run the anchor over every real bundle when the fix is an anchor change** — the fixture is the
  weaker evidence. Then swap the old anchor back in to prove the fixture would catch a regression.
  Both halves matter.
- **First question on any patcher PR: is the symptom even ours?**
- **Read the enclosing function for an existing guard before accepting a patch that adds one.**

## Calibrate before you call it a blocker

- **Assess reachability first; label hygiene as hygiene.** A real mechanism sitting behind trusted,
  explicitly opted-in code is calibration, not a hole.
- **State demotions out loud in the posted review.** Saying plainly that a concern was checked and is
  not a problem is cheaper than the author re-deriving it, and it buys credibility for the findings
  that did survive.
- **A wrong claim in our own code comment or docs propagates into contributor PRs.** This has
  happened twice. When an author's description is wrong, check whether they got it from us first.
- **Aim at the decision, not just the comment.** A *circular* justification — one citing as an
  external given the behavior its own hunk creates — still needs correcting, but it is also a tell
  that the real rationale went unstated. Ask why the hunk exists before you file the wording. We
  filed a blocking ask because a comment said the Anthropic passthrough "already" refused to echo on
  a fallback when the same hunk is what made it refuse; the better question was why the change was
  there at all. Reverting both halves left **1716/1719** green — only that change's own three
  tests red, every feature test passing — so it was severable from the PR's stated purpose, and
  the commit message turned out to carry the rationale the comment lacked. That converted one
  blocking ask into a prose fix plus a scope note.
- **When the ask turns on a vendor fact nobody here has observed, ask for the fact before
  prescribing the code.** For a community-supported provider we cannot exercise, a synthetic
  response body shows a risk, not a reachable defect, and narrowing a predicate around it can make
  the code worse — a panel proposed exactly that against an auth response no reviewer had seen.
  Frame it as "tell us the real response, **or** make this change," and say plainly that we could
  not verify it.
- **Verify "blocked by X" justifications by executing them.** A structural claim that sounds
  obviously true is exactly the kind that ships into a review and gets cited for years.
- **Don't let "not a regression versus `main`" excuse shipping a broken guarantee.**
- **A redesign needs a fresh review, not a re-read**, and we owe a re-review whenever we change our
  own PR after it was reviewed.
- **Review our own PRs with the same panel rigor as contributors'.** The first time we did, it caught
  us shipping tests that exercised fiction; another caught two wrong assumptions that would have made
  a fix a silent no-op for the users it targeted.

## Environment discipline

- **A green suite in a bridged shell proves nothing unless the ambient proxy is dead.** A dev shell
  running under clodex has `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` set pointing at a *live* server, which
  makes CONNECT succeed and env-dependence tests pass. Re-run with an unreachable proxy
  (`HTTPS_PROXY=http://127.0.0.1:9`) and always diff head against base under identical env.
- **Every `pnpm test`/`build` in a worktree must export `CLODEX_HOME=$(mktemp -d)`.**
- **Don't kill shared infrastructure your own agents depend on.** Subagents inherit this process's
  proxy env, so restarting the long-lived `clodex server` mid-session breaks the very fan-out you are
  preparing. Check the blast radius first. (The rule it qualifies is still right: after merging any
  transport fix, rebuild and restart that server *before* the next big fan-out — `ps -p <pid> -o
  lstart=` tells you its vintage. A panel once reviewed a transport fix while being killed by the bug
  it repairs.)
- **A fan-out will lose agents to upstream overload — design so one dead agent degrades coverage
  instead of voiding the run.** `Server error mid-response` does **not** mean output had started;
  that is generic client wording. The ledger's `emittedModelData`/`emittedDownstreamData` are ground
  truth. Mine it before theorising.
- **Husky's commit-msg hook blocks trial merges.** A throwaway integration merge needs `HUSKY=0` and
  `--no-verify`, or commitlint rejects it and leaves `MERGE_HEAD` behind, which makes the *next*
  merge fail with a misleading "not concluded your merge".

## Worktrees

`git worktree add --detach <ABSOLUTE path>` under `clodex-review/`, symlink `node_modules` (the
symlink is not covered by `.gitignore`'s `node_modules/` — `git rm --cached node_modules` before
pushing). Keep them while the PR is open; clean up when it closes. One worktree per lens plus a
dedicated refuter worktree per lens gives every agent full mutation rights with zero contention at
2N worktrees instead of one per agent. Create the worktrees **before** launching a workflow.

**Salvage every delta from the reviewed head before pruning, and never let a clean `git status`
alone be the guard.** **Committed probes do not appear in `git status`** — one worktree held three
probe commits, including the only artifact pinning an interactive warning seam, while its status
showed nothing but the `node_modules` symlink, so an untracked-only sweep found nothing to salvage
and said so confidently.

Record the reviewed head externally *before* agents start. Never re-derive it from the worktree you
are inspecting, which makes drift undetectable by construction, and never from the worktrees' parent
directory — that is not a repository, so the SHA comes back empty and `git log "$X"..HEAD` silently
degrades to a no-op that reports nothing. Then, passing `git -C "$wt"` on every command:

- classify the head. Equal is clean; ahead means salvage first. Anything else — `git merge-base
  --is-ancestor "$head" HEAD` returns non-zero — means **stop and read the reflog**, because a
  worktree already reset or force-moved has dropped its probes from the range, from status, and from
  the filesystem alike, and resetting again buries them further.
- enumerate committed files with `git log --name-status "$head"..HEAD`. Plain `git log` lists
  commits, not paths, so it cannot drive a salvage.
- enumerate the rest with `git status --porcelain -uall`, then sweep for `zz-*` harnesses. That
  sweep is a naming-convention backstop, not an inventory: it misses differently-named scratch,
  anything written outside the worktree, and files a reset already removed.

Confirm every copy with `diff -q`, requiring exit 0 — exit 1 means the destination differs and 2
that it is missing, and either one blocks the prune. Only then reset a worktree you are keeping back
to the reviewed head, or later differentials run against polluted material. Never
delete-then-discover; a cleanup script once refused to delete precisely because four worktrees still
held unsalvaged harnesses. And never trust a stated branch state before destructive cleanup — verify
with a content diff, not ancestry, because a squash merge defeats ancestry checks.

## Verdict, posting, merging

- **APPROVE means the maintainer merges immediately.** APPROVE and "I have notes" are compatible.
  The verdict and the land order are the maintainer's call — draft, then confirm, before running
  `gh pr review`.
- **Posting:** body-only, `gh pr review N --approve|--request-changes|--comment --body-file <f>`.
  zsh gotchas: `local path=` clobbers `$PATH`, and `status=` is read-only.
- **Merging:** a standalone single-commit PR squashes with
  `--subject "<conventional> (#N)" --body ""`. A **stack** uses `gh pr merge N --merge --body ""` so
  successors need no rebase. **The empty body is mandatory** — otherwise `gh` puts the PR title in
  the merge-commit body and release-please counts it as a second changelog entry. A release shipped
  with a duplicate line proving it. Merge-commit lines still have to satisfy commitlint's 100-char
  limit. Use `--admin` for self-authored and release PRs.
- **When our merge breaks a contributor's PR, we fix it** — merge `main` into the contributor branch
  rather than rebasing it.
