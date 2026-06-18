# Model compatibility

relay-ai shows models from live provider APIs by default. Models are hidden only when we have a specific reason.

## Two layers

1. **Curated blacklist** — `src/data/model-incompatible.json`  
   Researched entries with provider, model id, category, reason, and sources.

2. **models.dev capabilities** — bundled full snapshot in `src/data/models-dev-cache.json` (~2 MB, all providers)  
   When a model exists in that catalog, relay-ai may auto-hide it if it cannot support coding agents (no text output, `tool_call: false`, etc.). Missing catalog data never hides a model.

   **Offline / blocked network:** the bundled snapshot is always used when `~/.relay-ai/models-dev-cache.json` is missing or fetch fails.

   **On launch:** relay-ai refreshes from `https://models.dev/api.json` in the background (non-blocking). The next compatibility check uses the updated file.

## Google Gemini (raw API)

Google's `GET /v1/models` returns **many non-chat models** (Imagen, Veo, embeddings, TTS, robotics, etc.). **models.dev only catalogs a subset**, so relay-ai also maintains explicit `provider: google` entries in `model-incompatible.json` for models verified on the live API list.

After `relay-ai providers refresh-models`, if new non-coding ids appear, add them to the blacklist (do not rely on name patterns alone).

## Add a blacklist entry

Edit `src/data/model-incompatible.json`:

```json
{
  "provider": "google",
  "modelId": "example-bad-model",
  "category": "managed_agent",
  "reason": "Plain English explanation",
  "sources": ["https://…"],
  "verifiedAt": "2026-06-10"
}
```

- Use `"provider": "*"` when the model id should be hidden for every provider (stale promos, deprecated ids).
- Optional `"agents": ["codex", "codex-app"]` limits hiding to specific launch surfaces.

Rebuild after changes: `npm run build`

## Debug

Run with `--trace` where supported; hidden models log via `hideReason()`.

## Maintainer: refresh bundled snapshot

Before a release (or when models.dev changes materially):

```bash
npm run refresh:models-dev
```

Commits an updated `src/data/models-dev-cache.json` for offline installs.

User cache path: `~/.relay-ai/models-dev-cache.json` (written automatically on launch when network allows).
