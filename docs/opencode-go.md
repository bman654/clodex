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

OpenCode CLI variants are exact, opt-in request overlays. Clodex exposes those
exact ladders in a patched Claude picker and applies the global setting from
`clodex models --effort-policy <provider-default|up|down|exact>` when a worker
requests a level the target lacks. Aliases inherit the resolved target's ladder.
The default policy omits an unsupported effort; omitted client effort is never
turned into a variant.

Four Messages models have a reviewed thinking-budget mapping derived from the
committed CLI snapshot: `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`, and
`qwen3.8-max`. Each maps `high` to 16,000 tokens and `max` to 31,999 tokens.
Clodex emits that `thinking` object only for an explicit exact/rounded effort;
it does not inject one when effort is omitted. A new or changed enabled-budget
variant makes catalog generation fail until the mapping is reviewed.

The selective proxy diverts only explicit `clodex:opencode-go:...` model ids or saved aliases. Ordinary Claude model traffic remains on Claude Code's native Anthropic connection.

## Supported transport scope

The upstream OpenCode Go catalog also contains Responses-API models. Clodex records but intentionally excludes those entries from this provider (currently GPT-5.6 Luna and Grok 4.5). The supported runtime catalog contains only Anthropic Messages and Chat Completions models.

Live `/models` results are treated as availability data. Clodex layers its committed catalog over those results to supply the correct protocol, endpoint, context window, modalities, pricing, and compatibility behavior per model. Models absent from the committed allowlist are hidden even when the live endpoint advertises them.

## Updating the catalog

End users do not need the OpenCode CLI. Clodex ships both a normalized snapshot of OpenCode's resolved `opencode-go` models and the runtime catalog generated from it:

- `src/data/opencode-go-cli-snapshot.json` preserves OpenCode's resolved metadata and exact variant objects, including Responses entries that Clodex records but does not route.
- `src/data/opencode-go-models.json` is the generated Messages/Chat Completions allowlist consumed at runtime.

The committed snapshot records the OpenCode release/tag commit, release asset and digest, capture time, raw catalog digest, resolver commands, and canonical resolved-model digest. `@ai-sdk/anthropic` resolves to Messages, `@ai-sdk/openai-compatible` resolves to Chat Completions, and `@ai-sdk/openai` is recorded as Responses-only and omitted. An unknown SDK transport makes generation fail closed.

Maintainers refresh the source snapshot from an exact official OpenCode release artifact. Do not use an `opencode` found on `PATH`, a repository checkout, the maintainer's home/configuration, or an inherited models override. The v1.18.15 isolation controls and `--pure` behavior below come from the pinned release source: [`packages/core/src/flag/flag.ts` lines 52-68](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/core/src/flag/flag.ts#L52-L68), [`packages/opencode/src/index.ts` lines 62-70](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/index.ts#L62-L70), [`packages/opencode/src/config/config.ts` lines 406-410](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/config/config.ts#L406-L410), [`packages/opencode/src/config/paths.ts` lines 23-39](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/config/paths.ts#L23-L39), [`packages/core/src/global.ts` lines 17-20](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/core/src/global.ts#L17-L20), and [`packages/opencode/src/config/managed.ts` lines 20-68](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/config/managed.ts#L20-L68).

The pinned v1.18.15 Darwin arm64 capture can be reproduced with this macOS-specific shape. Other platforms need a separately reviewed asset, extraction, and configuration-isolation recipe before their provenance can replace it.

```bash
set -euo pipefail

capture_dir="$(mktemp -d)"
capture_user="$(id -un)"
version=1.18.15
tag="v$version"
release_commit=d7b115f623760e68a4749d16508a9eca350f246f
asset=opencode-darwin-arm64.zip
asset_sha256=bd60b57cb9fe0494a5352c807424d36d6d7853cf6dbddb97065c7ccd3c5d391c
raw_catalog_sha256=7190dad062bbe077974f95c4dcf0ba945fc7beae274f7faf2f9c6ce217f65770

curl --fail --location --proto '=https' \
  "https://github.com/anomalyco/opencode/releases/download/$tag/$asset" \
  --output "$capture_dir/$asset"
printf '%s  %s\n' "$asset_sha256" "$capture_dir/$asset" | shasum -a 256 -c -
tag_refs="$(
  env -i \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    git -c credential.helper= ls-remote --exit-code \
      https://github.com/anomalyco/opencode.git \
      "refs/tags/$tag" "refs/tags/$tag^{}"
)"
resolved_release_commit="$(
  printf '%s\n' "$tag_refs" | awk '
    $2 ~ /\^\{\}$/ { peeled = $1 }
    $2 !~ /\^\{\}$/ { direct = $1 }
    END { print peeled != "" ? peeled : direct }
  '
)"
test "$resolved_release_commit" = "$release_commit"
test ! -e "/Library/Managed Preferences/$capture_user/ai.opencode.managed.plist"
test ! -e "/Library/Managed Preferences/ai.opencode.managed.plist"
mkdir -p "$capture_dir/release" "$capture_dir/work" "$capture_dir/home" \
  "$capture_dir/config" "$capture_dir/data" "$capture_dir/cache" \
  "$capture_dir/state" "$capture_dir/config-dir" "$capture_dir/managed"
ditto -x -k "$capture_dir/$asset" "$capture_dir/release"
opencode_bin="$capture_dir/release/opencode"
test "$("$opencode_bin" --version)" = "$version"

(
  cd "$capture_dir/work"
  env -i \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    OPENCODE_API_KEY=metadata-only \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    OPENCODE_TEST_HOME="$capture_dir/home" \
    OPENCODE_TEST_MANAGED_CONFIG_DIR="$capture_dir/managed" \
    XDG_CONFIG_HOME="$capture_dir/config" \
    XDG_DATA_HOME="$capture_dir/data" \
    XDG_CACHE_HOME="$capture_dir/cache" \
    XDG_STATE_HOME="$capture_dir/state" \
    OPENCODE_CONFIG_DIR="$capture_dir/config-dir" \
    "$opencode_bin" --pure models opencode-go --refresh

  env -i \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    OPENCODE_API_KEY=metadata-only \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    OPENCODE_TEST_HOME="$capture_dir/home" \
    OPENCODE_TEST_MANAGED_CONFIG_DIR="$capture_dir/managed" \
    XDG_CONFIG_HOME="$capture_dir/config" \
    XDG_DATA_HOME="$capture_dir/data" \
    XDG_CACHE_HOME="$capture_dir/cache" \
    XDG_STATE_HOME="$capture_dir/state" \
    OPENCODE_CONFIG_DIR="$capture_dir/config-dir" \
    "$opencode_bin" --pure models opencode-go --verbose \
      > "$capture_dir/opencode-go.verbose"
)

printf '%s  %s\n' "$raw_catalog_sha256" \
  "$capture_dir/cache/opencode/models.json" | shasum -a 256 -c -
```

OpenCode v1.18.15 also reads the two macOS managed-preferences plist locations preflighted above, with no disable flag. Abort if either exists and perform the capture in an unmanaged temporary macOS VM instead.

The placeholder only makes the provider visible to these metadata commands; neither command performs inference. Import from the exact artifact and raw cache paths so the generator computes both digests itself rather than trusting typed digest strings. The release tag must equal `v` plus the reported binary version:

```bash
pnpm update:opencode-go \
  --input "$capture_dir/opencode-go.verbose" \
  --opencode-version 1.18.15 \
  --release-tag v1.18.15 \
  --release-commit "$release_commit" \
  --release-asset-file "$capture_dir/opencode-darwin-arm64.zip" \
  --raw-catalog-file "$capture_dir/cache/opencode/models.json" \
  --captured-at 2026-08-09T17:47:18Z

pnpm update:opencode-go --check
```

The canonical resolved-model digest is computed as a compact JSON array with models sorted by id, object keys recursively sorted, and one trailing newline. The v1.18.15 CLI stream was already id-sorted, so its exact equivalent was `jq -s -cS . objects.jsonstream`; for an unordered future stream, use `jq -s -cS 'sort_by(.id)' objects.jsonstream`.

Review the source snapshot and generated catalog together before committing. The importer accepts only the explicit non-secret resolver schema, requires empty `headers` and `options`, and fails on unknown fields, unsafe URLs, inactive models, malformed numeric data, or unsupported variant shapes. In particular, a model changing among Anthropic Messages, Chat Completions, and Responses is a routing change rather than a cosmetic refresh. The generator maps exact `reasoningEffort` variants and the four reviewed Qwen Messages budget ladders above. Other request shapes remain provenance-only rather than becoming guessed transforms. CLI variants are opt-in overlays, so their presence never becomes a default effort when the client omitted an effort control.
