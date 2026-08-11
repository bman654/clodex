<!--
  The first paragraph is for a clodex USER, not a reviewer.
  Plain language, no jargon: what was broken or missing, and what is different now.
  Someone who reads only that paragraph should understand the point of this PR.
  Everything below it can be as technical as it needs to be.
-->

## What this changes for users

<!-- One short paragraph. No module names, no symbols, no protocol fields. -->

## Problem and root cause

<!-- The user-visible symptom, the root cause, and proof the path is reachable in a real
     supported configuration: who triggers it and what they must already control. -->

## The change

<!-- What you changed, and what you deliberately left out for a follow-up. -->

## Evidence

<!-- Discriminating tests: what fails if the feature is deleted or reverted?
     Mutations run. Real runtime/manual evidence, and the environment it was measured in
     (isolated CLODEX_HOME, ambient proxy dead or live, node version).
     Say plainly what you could NOT verify — that is a strength, not a weakness. -->

- [ ] `pnpm typecheck && pnpm test && pnpm build`
- [ ] Feature-deletion mutation run (full file, not `-t`) — the intended test fails without the fix
- [ ] Reachability stated above
- [ ] Manual smoke, if a launch path changed — Anthropic passthrough (`--model haiku`) **plus**
      every other provider you have credentials for that the change could affect. Name any
      provider you could not test.
- [ ] Commit summary line reads as a release note for a non-technical user

## Failure and rollback behavior

<!-- What happens if this fails at runtime? Anything persisted in ~/.clodex or the keychain
     that an existing install needs migrated? -->
