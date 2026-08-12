# OpenCode Go provider

Clodex can expose OpenCode Go models alongside Claude and OpenAI/Codex models in the same Claude Code session.

## Setup

Run:

```bash
clodex providers add
```

Choose **OpenCode Go API key**, paste an API key from OpenCode, then use `clodex models` to add the desired models to favorites. The pasted key is checked against the authenticated chat-completions endpoint before it is saved — `/models` alone cannot validate a credential (see below). The pre-save probe rejects only definite, recognized authentication failures; timeout, network, and unrecognized responses are inconclusive, so a bad key may still be saved and surface an authentication failure on first inference. Favorites can be assigned short aliases and patched into Claude Code in the same way as OpenAI models.

The provider uses one credential with two upstream wire protocols:

- Anthropic Messages models are passed through to `https://opencode.ai/zen/go/v1/messages`.
- OpenAI Chat Completions models are translated through the OpenAI-compatible SDK at `https://opencode.ai/zen/go/v1/chat/completions`.

The selective proxy diverts only explicit `clodex:opencode-go:...` model ids or saved aliases. Ordinary Claude model traffic remains on Claude Code's native Anthropic connection.

## Supported transport scope

The upstream OpenCode Go catalog also contains Responses-API models. Clodex intentionally excludes those entries from this provider (currently Grok and mainline GPT; other unmapped ids are reported by the updater until their transport is verified). The supported catalog contains only Anthropic Messages and Chat Completions models.

Live `/models` results are treated as availability data. Clodex layers its committed catalog over those results to supply the correct protocol, endpoint, context window, modalities, pricing, and compatibility behavior per model. Models absent from the committed allowlist are hidden even when the live endpoint advertises them.

## Updating the catalog

The committed catalog is generated directly from OpenCode's own catalog service (`models.dev/api.json`, provider `opencode-go`):

```bash
pnpm update:opencode-go
```

The updater takes per-model metadata (name, context window, cost, modalities) from models.dev and merges it with the transport map and compatibility patches maintained in `scripts/update-opencode-go-models.mjs` — models.dev does not publish wire transports, and per-model routing is live-validated clodex knowledge. Only transport-mapped ids enter the catalog; new models on models.dev are reported as unmapped so their transport can be verified against the live endpoint before they ship. The script records the fetch time in `OPENCODE_GO_SOURCE_FETCHED_AT`.

Review catalog, pricing, endpoint, and compatibility changes before committing generated output. In particular, a model changing between Anthropic Messages, Chat Completions, and Responses is a routing change rather than a cosmetic catalog refresh.
