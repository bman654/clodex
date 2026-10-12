# Ollama Cloud provider

Clodex can expose Ollama Cloud models alongside Claude and OpenAI/Codex models in the same Claude Code session.

## Setup

```bash
clodex providers add
```

Choose **Ollama Cloud API key** and paste a key from <https://ollama.com>. Then use `clodex models` to add models to favorites and `clodex patch` to make them selectable in Claude Code.

Models are served through the OpenAI-compatible SDK at `https://ollama.com/v1/chat/completions` (Bearer key). Every catalog model carries that address, so `providers add`, its key check, and launched sessions always use it. A model-list refresh (`clodex providers refresh-models`) instead uses the provider's stored `api.url` in `providers.json`, which `providers add` sets to the same address.

Streamed requests carry `stream_options: {"include_usage": true}`: ollama.com sends the final usage chunk only when asked (observed 2026-10-13 on all four models), and without it Claude Code would see zero output tokens on every streamed turn.

## Supported models

Chat Completions only, from a committed allowlist (`src/data/ollama-cloud-models.ts`): `kimi-k3`, `glm-5.3`, `glm-5.3-flash`, `deepseek-v4.1-flash`. Live `/v1/models` results are availability data; models absent from the allowlist are hidden. Ollama publishes pay-as-you-go per-token rates (<https://ollama.com/pricing>), but clodex does not record them for this provider: no per-token cost is set and the global pricing cache is not applied.

## Credential check

`https://ollama.com/v1/models` answers without a key (observed 2026-10-12), so listing models cannot tell a good key from a bad one. The pasted key is instead probed against the authenticated chat-completions endpoint before it is saved, with a request that names a catalog model but carries no messages. A bad key gets HTTP 401 there (observed 2026-10-12); a valid key gets HTTP 400 `invalid_request_error` for the missing messages (observed 2026-10-13 with one key). The probe classifies the response as follows:

- **401** always blocks the add, whatever the body says.
- **403** is inconclusive only if the body contains one of the whole words `subscription`, `plan`, `upgrade`, `quota`, `model` or `access` and does not mention `api key`, `api_key`, `api-key` or `apikey` (both matches ignore case). Every other 403 blocks the add, including a bare `{"error":"Forbidden"}` or an HTML page with none of those words.
- Any other status, a timeout or a network error is inconclusive.

An inconclusive probe does not block the add; model listing must still succeed.

## Known gaps

- Context windows come from `model_info.*.context_length` in `https://ollama.com/api/show` (1,048,576 for all four, measured 2026-10-01 and again 2026-10-12). That is the model's reported maximum; the largest prompt Ollama Cloud actually accepts has not been measured.
- Reasoning-effort mapping is unverified, so no effort is sent (`supportsReasoningEffort: false`).
- Input modalities follow the `capabilities` field of `https://ollama.com/api/show` (checked 2026-10-13): `kimi-k3`, `glm-5.3-flash` and `deepseek-v4.1-flash` are marked text and image, `glm-5.3` text only. Image input through clodex is untested.
