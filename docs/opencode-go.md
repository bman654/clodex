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

The upstream OpenCode Go catalog also contains Responses-API models. Clodex intentionally excludes those entries from this provider (currently Grok 4.5; other unmapped ids are reported by the updater until their transport is verified). The checked-in runtime catalog contains 17 reviewed models and only Anthropic Messages and Chat Completions routes.

Live `/models` results are treated as availability data. Clodex layers its committed catalog over those results to supply the correct protocol, endpoint, context window, modalities, pricing, and compatibility behavior per model. Models absent from the committed allowlist are hidden even when the live endpoint advertises them; pinned OpenCode Go metadata does not consult models.dev.

## Reasoning effort

Alongside the catalog, the updater generates `src/data/opencode-go-effort-profiles.json`: per model, the reasoning-effort levels that route can actually execute, the exact value each puts on the wire, and whether the provider declares a default.

The table is an intersection, not a copy. The committed resolver snapshot advertises reasoning variants; the reviewed per-model wire maps in the updater say what clodex has exercised on the route it runs. A level is exposed only when both agree, so a changed capture can never widen what goes upstream. Disagreements are recorded in the same file rather than resolved:

- `deepseek-v4-flash` advertises a `low` variant that the reviewed map sends nothing for, so `low` is not exposed.
- `qwen3.6-plus` advertises Anthropic thinking budgets, but clodex routes it over Chat Completions, so that representation is denied and the reviewed effort map governs the route.
- `minimax-m3`, `qwen3.7-max`, `qwen3.7-plus`, and `qwen3.8-max` advertise thinking variants on the Messages passthrough, which carries no clodex-controlled effort control at all — their profiles are empty on purpose.

Widening or narrowing any of these needs live validation and is a review decision, not a regeneration.

No model declares a default effort, so `defaultLevel` is `null` throughout and a request that omits an effort reaches the gateway without one. Two invariants are enforced before anything is written: every reviewed map must be a fixed point on its own output, and no two levels may send the same value. Together they let the translated and direct request paths produce identical bytes, and let an already-native value be forwarded rather than translated twice.

Profiles are runtime-only. They are attached by retained provider identity after model projection, never stored in a model cache, so a stale cache cannot state what a model's effort control is. What a request does with an unsupported level is the user's global `clodex models --effort-policy` setting; see the README.

The patched Claude Code client's native effort picker needs a dense low/medium/high ladder, so only `gpt-5.6-luna` and `qwen3.6-plus` reach it. The other reviewed ladders are sparse and correctly appear with no effort control; representing them needs a new patch-transform version and is deliberately out of scope here.

## Updating the catalog

The runtime catalog is the checked-in 17-model allowlist. The retained deterministic product data at `src/data/opencode-go-cli-snapshot.json` is the existing updater's committed input. Its recorded digest proves the integrity and reproducibility of the supplied asset, not independent authenticity or provenance.

Ordinary maintained regeneration is offline and derives the catalog and provenance from that committed snapshot:

```bash
pnpm update:opencode-go
```

Regeneration writes the catalog, the effort-profile table, and the provenance constants, and prints every effort-profile disagreement it recorded.

Verification is offline and zero-write:

```bash
pnpm update:opencode-go -- --check
```

For an advisory effort-ladder comparison, run the explicit networked mode:

```bash
pnpm update:opencode-go -- --verify-ladders
```

This is the only updater mode that consults models.dev. The feed is advisory and contributes no generated metadata; the snapshot remains the source for generated bytes. No live provider or credential validation is claimed for this slice.

Current reviewed runtime transport remains authoritative. The three explicit resolver/runtime transport overrides (`gpt-5.6-luna`, `minimax-m2.7`, `qwen3.6-plus`) conserve reviewed OpenAI-compatible Chat Completions routing pending independent live validation; future unknown divergence fails closed rather than being generated. `gpt-5.6-luna` temperature remains pending that same live-validation disposition. Pinned exact-route metadata suppresses temperature only for `kimi-k2.7-code` and `kimi-k3`.

The refresh/maintenance trigger is an intentional supported resolver-contract update. Review `src/data/opencode-go-cli-snapshot.json`, the generated catalog, effort-profile, and provenance files, `scripts/update-opencode-go-models.mjs`, and the updater tests together before committing. In particular, a model changing between Anthropic Messages, Chat Completions, and Responses is a routing change rather than a cosmetic catalog refresh.
