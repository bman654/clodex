# clodex patch canary

Scripts that automate monitoring `clodex patch` against new Claude Code releases: every hour they
download the newest release for **every** published platform into a throwaway sandbox, run
`clodex patch` against it, and raise a Slack alert plus a background investigation session when a
release does not patch cleanly.

They live here so they are versioned like everything else. They run from `~/.local/bin`, which
symlinks to this folder.

| File | What it is |
| --- | --- |
| `clodex-patch-canary.sh` | the canary itself; `--help` documents every flag |
| `clodex-patch-canary-platforms.sh` | the platform matrix — sourced by the canary, not run directly |
| `clodex-patch-canary-cron.sh` | launchd entry point (forces `HOME`/`PATH`) |
| `clodex-patch-canary-selftest.sh` | assertions over report parsing, verdict logic and launch argv; no downloads |
| `com.experoinc.brandon.clodex-patch-canary.plist` | the hourly launchd schedule |

State lives outside the repo: `~/.local/state/clodex-patch-canary/` (triage record `state.json` and
one log per run) and `~/.cache/clodex-patch-canary/` (a private clone hard-reset to `origin/main`
each run, plus sandboxes — removed on success, kept on failure for the investigation).

## The three legs, and what each one actually proves

Only three of the eight published builds can go through the real `clodex patch`: `clodex patch`
resolves the version by **executing** the binary, so a foreign build needs either this Mac's own
architecture or a native-architecture container. That is `darwin-arm64` on this Mac, plus
`linux-arm64` and `linux-arm64-musl` in a container — the only two rows in `CANARY_PLATFORM_TABLE`
carrying an image. The other five get the probe,
`scripts/probe-patch-mechanism.mjs`, which works on any build from any host because it never
executes anything.

| Leg | Patch anchors checked | Binary repacked | Patched binary started |
| --- | --- | --- | --- |
| `host` — the real command on this Mac | yes | yes | **yes** |
| `container` — the real command in a Linux container | yes | yes | **yes** |
| `probe` — `probe-patch-mechanism.mjs` | yes | yes | no |

A probe **does** now prove: every clodex patch site matched an anchor in that specific build's
bundle exactly once; no site was ambiguous, missing or silently skipped; the transforms threw
nothing; and the bundle they produced survived the PE/ELF/Mach-O read-resize-publish-restore round
trip byte for byte, still carrying clodex's own `ccpatch:` markers. Since the write stopped
rebuilding the Bun blob, the resize is tweakcc's half and the publish is clodex's; the probe also
checks that the blob the resize produced is exactly the size clodex sized its placeholder for, which
is the only place that arithmetic meets a real repack.

A probe **does not** prove:

- **that the patched binary runs.** Nothing here starts it, so a repack that produces a PE
  Windows refuses to load, or an ELF the kernel rejects, would still pass. Only the `host` and
  `container` legs answer that, and only for `darwin-arm64`, `linux-arm64` and `linux-arm64-musl`.
- **that an anchor bound to the right code.** A regex that matches a lookalike function still
  emits valid JavaScript and reports `OK`. The probe checks that a site *applied*, never that it
  applied to the thing it was aimed at.

That distinction is why a probe leg's coverage line reads "native execution not checked" and why
the Slack alert never calls a probe pass "`clodex patch` applies cleanly". Before this existed a
probe exercised **zero** patch sites, and Claude Code 2.1.238 shipped with the `PATCH 5: model
picker options` anchor no longer matching its `linux-arm64`, `linux-arm64-musl` and `win32-arm64`
builds. The two Linux builds have container images and were reported as failures. `win32-arm64`
has none, so it was a probe — and it was reported as a clean pass.

## When the alert is not an all-clear

The two container legs need a running Docker daemon. With Docker Desktop quit they fall back to the
probe, which establishes nothing about whether a patched Linux binary starts, so the run is recorded
as `partial` rather than `pass` and the notification withholds the green tick. `partial` does not
close a version off: the canary re-tries it every `CANARY_PARTIAL_RETRY_HOURS` (6 by default) until
a run achieves full coverage, so the same release is announced again — with the same verdict — for
as long as the hole persists.

Because that is a one-action fix, a **pass/partial** notification short of full coverage opens with
what to do about it, before any of the evidence. Every cause that applies is named, not just the
first: Docker being down, `--no-container`, a `--platforms` debug run, a host leg that did not pass,
and a platform package that has not published yet each get their own line.

A `--platforms` run is deduplicated before the matrix is built, and completeness compares distinct
platform names rather than row counts — otherwise naming one build eight times would reach the
published-platform count and be announced as a clean pass over seven builds nobody looked at.

A **failure** alert has no such line — it leads with which platforms broke and what a background
investigation session is doing about it. What it does share is the disclosure that a `--platforms`
run tested only a subset, because otherwise "breaks `clodex patch` on 1 of 1 builds" reads as a
statement about the release rather than about one hand-picked build.

## Install

```bash
ln -sfn "$PWD/canary/clodex-patch-canary.sh"           ~/.local/bin/clodex-patch-canary.sh
ln -sfn "$PWD/canary/clodex-patch-canary-platforms.sh" ~/.local/bin/clodex-patch-canary-platforms.sh
ln -sfn "$PWD/canary/clodex-patch-canary-selftest.sh"  ~/.local/bin/clodex-patch-canary-selftest.sh
ln -sfn "$PWD/canary/clodex-patch-canary-cron.sh"      ~/.local/bin/clodex-patch-canary-cron.sh

cp canary/com.experoinc.brandon.clodex-patch-canary.plist ~/Library/LaunchAgents/
launchctl load  ~/Library/LaunchAgents/com.experoinc.brandon.clodex-patch-canary.plist
launchctl start com.experoinc.brandon.clodex-patch-canary   # run once now
```

The canary resolves its sibling scripts through `${BASH_SOURCE[0]}`, which does **not** follow the
symlink — so all four must be symlinked together, not just the entry point.

Uninstall: `launchctl unload ~/Library/LaunchAgents/com.experoinc.brandon.clodex-patch-canary.plist`.
Pause without unloading: uncomment the `exit 0` near the top of `clodex-patch-canary-cron.sh`.

## Before changing anything here

```bash
./canary/clodex-patch-canary-selftest.sh     # must be green
./canary/clodex-patch-canary.sh --status     # triage state
```

The selftest drives the real functions against fixtures and stand-ins, so it needs no network and
touches no real install. It mocks the `claude` binary, which means it cannot see bugs in how the
canary invokes the *real* CLI — the argv tests exist because one such bug (a prompt silently
swallowed by the variadic `--add-dir`) shipped and cost a day of coverage.

The probe has automated coverage on both sides of the repo boundary:

```bash
pnpm vitest run tests/probe-patch-sites.test.ts   # the patch-site half, against a bundle fixture
./canary/clodex-patch-canary-selftest.sh          # the verdict half, against captured probe.json
```

`tests/probe-patch-sites.test.ts` is also what stops the probe from paging you over a *clodex*
change: it pins the probe's synthetic config and its list of expected patch sites against the real
transform set, so adding or renaming a `PATCH` site reddens `pnpm test` instead of failing five
platforms at 03:00. Bump `PATCH_TRANSFORMS_VERSION` and that file is the one that tells you the
probe needs updating too.

Neither of those touches a real Claude Code binary, so neither can see a break specific to one
executable format. For that, run the probe by hand against a build of each — it needs no Linux or
Windows host:

```bash
node scripts/probe-patch-mechanism.mjs /path/to/claude.exe --label win32-arm64
```
