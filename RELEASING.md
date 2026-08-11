# Releasing clodex

Maintainer-facing. Contributors do not need anything in this file — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the commit format, and
[`CLAUDE.md`](./CLAUDE.md#commit-messages) for how to write the summary line that becomes a
changelog entry.

## How a release happens

Releases are managed by release-please from conventional commits. Write conventional commits,
then push or merge them to `main`.

`.github/workflows/release-please.yml` has two jobs:

1. **`test`** — typecheck + tests + build on Node 24 with pnpm. This workflow triggers only on
   pushes to `main`; pull requests are covered by the separate `ci.yml`.
2. **`release`** — `needs: test`, so nothing is tagged on a red build.

release-please maintains a release PR accumulating the generated changelog and the
`package.json` version bump. Merging that PR creates the `vX.Y.Z` tag and GitHub Release; the
release job then rebuilds `dist/` and **stages** the npm release via trusted publishing (OIDC,
`id-token: write` — no npm secret anywhere) with `npm stage publish`.

**Nothing goes live from CI.** A maintainer approves the staged version with 2FA: npmjs.com →
package → "Staged Packages" → Approve, or `npm stage approve <stage-id>` (inspect first with
`npm stage list` / `npm stage view` / `npm stage download`).

> `npm stage` needs **npm >= 11.15.0**, which is newer than the npm bundled with Node 24 — on the
> pinned toolchain `npm stage` fails with `Unknown command: "stage"`. Run `npm install -g npm@latest`
> first, or just use the npmjs.com web UI. The release workflow upgrades npm for the same reason.

> Ordering matters: an earlier design ran tests *after* release-please tagged, so a flaky test
> left a dangling `v1.0.1` tag with nothing on npm. The tag-then-test ordering is fixed —
> don't reintroduce it.

Publishing happens inside the release-please job deliberately: a tag created by the default
`GITHUB_TOKEN` does not trigger another workflow.

## Hard rules

- **Do NOT run `npm publish` locally.** `.github/workflows/release-please.yml` is the only
  release path; manually pushing a `v*` tag publishes nothing.
- **Never hardcode a version string.** `package.json` is the single source of truth
  (`src/constants.ts::VERSION` reads `pkg.version`).
- **Never commit `dist/`.** It is gitignored; `prepublishOnly` and release CI rebuild it.

## Version bumping

Normal conventional-commit bumping applies (the repo is past 1.0). To force a specific
version, land a commit on `main` whose body contains `Release-As: X.Y.Z` on its own line.

## Repository setup (one-time; already done)

Kept for reference — this is not repeatable and should not be re-run.

The release job is guarded by `if: vars.CLODEX_PUBLISH_ENABLED == 'true'`. **Commitlint is
deliberately ungated** — it once carried the same gate, but repository variables do not resolve for
`pull_request` runs from a fork, so the job reported "skipped" for exactly the contributors who need
it: a green check that never ran. Linting commit messages publishes nothing, so there is nothing to
gate. Do not re-add that condition.

1. `@bman654/clodex` is **scoped** because npm's name-similarity guard rejects unscoped
   `clodex`; `publishConfig.access: public` keeps publishes public. The package was created by
   a one-time manual `npm publish` of 0.1.0 — neither trusted publishing nor staging can do a
   package's *first* publish. That was the sole exception to the no-local-publish rule; the
   commit is tagged `v0.1.0`.
2. On npmjs.com, the package's Trusted Publisher is GitHub Actions, owner `bman654`, repo
   `clodex`, workflow filename `release-please.yml`. No npm token secret exists or is needed.
3. Repository variable `CLODEX_PUBLISH_ENABLED=true`.

`.release-please-manifest.json` records the released version. `bootstrap-sha` (a fallback used
only if the release tag is missing) fences off the inherited relay-ai fork history so pre-fork
commits are never scanned. Release-please's changelog updater prepends generated entries above
the hand-written 0.1.0 fork entry rather than replacing it.

## Commitlint

Husky v9 was chosen for its small, standard `prepare`-based pnpm integration. Setup exits
successfully when `.git` is unavailable, so CI and non-git installs are not broken. Commitlint
runs on the `commit-msg` hook locally and again in CI over pull-request/push commit ranges.
