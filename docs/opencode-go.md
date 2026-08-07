# OpenCode Go provider

Clodex can expose OpenCode Go models alongside Claude and OpenAI/Codex models in the same Claude Code session.

## Setup

Run:

```bash
clodex providers add
```

Choose **OpenCode Go API key**, paste an API key from OpenCode, then use `clodex models` to add the desired models to favorites. The pasted key is verified against the authenticated chat-completions endpoint before it is saved — `/models` alone cannot validate a credential (see below) — so a mistyped key is rejected at add time instead of failing on first inference. Favorites can be assigned short aliases and patched into Claude Code in the same way as OpenAI models.

The provider uses one credential with two upstream wire protocols:

- Anthropic Messages models are passed through to `https://opencode.ai/zen/go/v1/messages`.
- OpenAI Chat Completions models are translated through the OpenAI-compatible SDK at `https://opencode.ai/zen/go/v1/chat/completions`.

The selective proxy diverts only explicit `clodex:opencode-go:...` model ids or saved aliases. Ordinary Claude model traffic remains on Claude Code's native Anthropic connection.

## Supported transport scope

The upstream OpenCode Go catalog also contains Responses-API models. Clodex intentionally excludes those entries from this provider. At the source revision currently pinned by Clodex, the excluded entry is Grok 4.5. The supported catalog contains only Anthropic Messages and Chat Completions models.

Live `/models` results are treated as availability data. Clodex layers its committed catalog over those results to supply the correct protocol, endpoint, context window, modalities, pricing, and compatibility behavior per model. Models absent from the committed allowlist are hidden even when the live endpoint advertises them.

## Updating the catalog

The committed catalog is generated from a pinned revision of `monotykamary/pi-opencode-go-provider`:

```bash
pnpm update:opencode-go
```

The updater resolves the requested source ref to an immutable commit, merges upstream `models.json`, `patch.json`, and `custom-models.json`, filters unsupported transports, writes `src/data/opencode-go-models.json`, and updates the pinned commit constant. It defaults to upstream `main`; set `OPENCODE_GO_SOURCE_REF` to review a specific branch, tag, or commit.

Review catalog, pricing, endpoint, and compatibility changes before committing generated output. In particular, a model changing between Anthropic Messages, Chat Completions, and Responses is a routing change rather than a cosmetic catalog refresh.
