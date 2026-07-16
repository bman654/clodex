# patch-custom-models — make `relay:` models first-class in Claude Code

`relay-ai claude --http-proxy` lets you route Claude Code to a `relay:<provider>:<model>`
favorite via `/model`. But Claude Code only fully integrates models it *knows about*:
a name it doesn't recognize is rejected by the **Agent tool's** `model` validation,
never shows up in the interactive **`/model` picker**, and is assumed to be a **200k**
context model. You can still type the exact name into `/model`, but that's it.

This tool patches your installed Claude Code binary (via [tweakcc](https://github.com/Piebald-AI/tweakcc)'s
`adhoc-patch` mode) so your chosen models are treated like the built-in aliases:

- accepted by the Agent tool's `model` argument (subagent overrides work),
- listed in the `/model` picker,
- resolve to their concrete model id, and
- report the **correct per-model context window** (autocompact threshold, `/context`,
  the countdown, statusline, and subagent budgets all use it).

> **Optional.** `--http-proxy` works without this. The patch only removes the rough
> edges of using non-built-in model names inside Claude Code's own tooling.

## Configure

Copy the example and edit it:

```bash
cp model-config.example.json model-config.json
```

Keys are the **real model id** (a relay-ai favorite, e.g. from `relay-ai models --list`);
values are the **alias you type**. A value is either the alias string, or
`{ "alias": "...", "context": <tokens> }` to also pin that model's context window:

```json
{
  "relay:openai-oauth:gpt-5.6-sol": { "alias": "sol", "context": 272000 },
  "relay:groq:llama-3.3-70b-versatile": "llama"
}
```

The wrapper looks for the config in this order: `$RELAY_AI_PATCH_MODEL_CONFIG`,
then `./model-config.json`, then the example baked into `patch-custom-models.js`.

### Context window: `context` vs. the `[1m]` suffix

Claude Code only knows two things about an unknown model's context: a `[1m]` suffix
means exactly 1M, otherwise it's the 200k default. Since a model's real window is
usually neither (e.g. 272k), set `context` and drop the suffix. The two are mutually
exclusive and the script throws if you set both — `[1m]` isn't just a context hint,
it also sends the `context-1m-2025-08-07` beta header and raises the retained-media
cap from 100 to 600 items. `context` sets the window without those side effects.

Dropping `[1m]` does **not** change the model id sent upstream — Claude Code strips
the suffix from the wire id anyway.

## Apply (run after every `claude` update)

```bash
./patch-custom-models.sh            # backup (once per version) + apply
./patch-custom-models.sh restore    # roll back to the pristine binary
```

tweakcc shows a diff and asks to confirm before writing. It handles both native and
npm installs (unpack/repack of the native binary is automatic).

### Finding the Claude Code binary (wrappers / shims)

If your `claude` on `PATH` is a wrapper or shim (e.g. **cmux**), tweakcc's auto-detect
can't unpack it. The wrapper avoids this by resolving the real binary itself, in order:

1. `$TWEAKCC_CC_INSTALLATION_PATH` — set this to force an exact binary,
2. `~/.local/bin/claude` — the stable native-install symlink,
3. `command -v claude` — last resort.

It must resolve to a **file** (the native binary or a `cli.js`), not a directory.

### Backups (why the wrapper exists)

`adhoc-patch` creates no backup, and tweakcc has no standalone backup command. The
wrapper copies the current binary to `~/.tweakcc/claude-<ver>.orig` (pristine,
version-tagged, made only if absent) and mirrors it to `~/.tweakcc/native-binary.backup`,
so both `./patch-custom-models.sh restore` and `tweakcc --restore` work.

> **Changing an existing alias's `[1m]` suffix?** Run `./patch-custom-models.sh restore`
> **before** re-applying. The alias patches top up rather than replace, so going from
> `sol[1m]` to `sol` on an already-patched binary leaves *both* registered. (The
> context-window patch does refresh in place, so plain `context` value edits don't
> need a restore.)

## What it patches

| Patch | Effect | Required |
|-------|--------|----------|
| 1 | Agent-tool `model` zod enum accepts the aliases | yes |
| 3 | known-alias validator list treats them as first-class | yes |
| 6 | alias resolves to its concrete model id | yes |
| 5 | aliases appear in the `/model` picker | best-effort |
| 4 | Agent-tool `model` description text mentions them | best-effort |
| 7 | per-model context window from `context` | yes (only if any model sets `context`) |

Anchors key on **stable string literals** (model names, `case"best":{`, describe text)
rather than minified identifiers, so they survive per-build identifier churn and
tolerate new built-in models being added. Every required patch verifies its anchor
matches exactly once and **aborts loudly** on failure rather than half-patching.
The patch is idempotent and top-up capable: rerunning is a no-op; adding an alias
and rerunning inserts only the missing pieces.

If an anchor ever breaks after an update, re-unpack and inspect the new source:

```bash
npx tweakcc unpack ./cli.js "$(readlink -f "$(command -v claude)")"
# grep for: .enum(["sonnet"  /  ,"opusplan"]  /  case"best":{  /  Optional model override for this agent
```

## Attribution

Inspired by [claude-alias-patch](https://github.com/East-rayyy/claude-alias-patch)
(MIT). This is a from-scratch reimplementation: it applies through
[tweakcc](https://github.com/Piebald-AI/tweakcc) `adhoc-patch --script` instead of
the original's Python patcher, anchors on different sites, and adds the per-model
context-window patch (PATCH 7). Licensed under relay-ai's MIT license.
