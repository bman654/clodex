# Contributing to clodex

Contributions are welcome — bug reports, fixes, and features all.

clodex bridges Claude Code to primarily OpenAI models, but community contributors have also
added support for some other AI providers. A lot of its behavior encodes real production
failures that aren't obvious from reading the code, so this guide is mostly about the
context you can't infer from the diff. Please skim it before opening a PR; it should save
you rework.

## Before you start

**Small changes** — bug fixes, docs, tests, a focused improvement — just open a PR. No
ceremony needed.

**Larger changes** — anything touching a subsystem, spanning several files, or changing
behavior users depend on — please open an issue first. This isn't a gate, and you won't be
turned away for skipping it. It's to protect your time: clodex has invariants that look
arbitrary until you know the failure they came from, and it's much cheaper to sort that out
in an issue than after you've written the code.

**Read [`CLAUDE.md`](./CLAUDE.md).** Despite the name it's the working guide for the whole
repo — architecture, build and test commands, commit format, and the invariants — and it's
the single best thing to read before changing anything. It applies to everyone, not just
Claude Code. It points at deeper documents for each subsystem; load the one covering the
code you're changing.

**Read [`.claude/skills/pr-verification/SKILL.md`](./.claude/skills/pr-verification/SKILL.md)
before you open the PR.** It is the bar your change will actually be held to, derived from
what has gone wrong across ~100 previous PRs. The short version: green tests are not
evidence — delete your feature and confirm the suite turns red; don't claim more than you
observed; and prove the path you fixed is reachable in a real configuration. It also
describes what belongs in the PR description.

## Scoping your PR

This is the guidance most worth following, because it's the one that's hard to see from
inside a single PR.

**One coherent change per PR — but keep a coherent change together.** If a fix requires
touching four files, that's one PR with four files, not four PRs. The unit is the change,
not the file.

**Don't split one subsystem across parallel PRs.** This is the big one. Several
independent PRs that each rework the same area will each look reasonable in isolation
and still collide badly in aggregate: whoever merges first wins, and everyone else
rebases into a conflict they couldn't have predicted. Worse, reviewing them separately
hides design disagreements — two PRs can extend the same type in two incompatible
directions and neither review will catch it, because the conflict doesn't exist in either
diff.

If you find yourself opening a third PR against the same subsystem, that's a signal the
work wanted to be one PR (or an issue first). Three separate PRs have already been
consolidated for exactly this reason.

**Prefer a few well-scoped PRs over many micro-PRs.** Three or four substantial,
self-contained PRs are easier to review and land than six or more fine-grained ones
that share files. Splitting has real costs — reviewer context, merge conflicts,
integration risk — and they're paid per-PR.

**If your changes genuinely must stack, say so.** Note the dependency and intended merge
order in the PR description, and target each PR at the branch it builds on rather than
`main`. That makes the diffs readable and the order explicit.

**Stay inside clodex's mission.** The change should serve bridging Claude Code to other
model providers, rather than being a general Claude Code modification. A permanent patch
site for behavior outside that mission is out of scope.

**Keep source files manageable.** Prefer files under ~750 lines, and consider splitting when
adding to one already over — smaller files let independent work proceed without colliding.
This never licenses restructuring the files `CLAUDE.md` marks as do-not-restructure.

## Everything else

Build and test commands, the toolchain and pinned versions, commit message format, the
architecture, and the hard rules all live in [`CLAUDE.md`](./CLAUDE.md) so there is one copy
of each. Maintainers are held to the same ones.

## Review

PRs are reviewed manually, and review may include running the change locally. Expect
questions about reachability, test coverage of the actual fix, and interaction with other
in-flight PRs — those are the three things that most often need another pass.

If a review asks for changes, that's normal and not a rejection. If you disagree with a
review comment, say so; the reasoning behind an invariant is sometimes wrong or no longer
applies, and that's worth knowing.

Thanks for contributing.
