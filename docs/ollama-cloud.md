# Ollama Cloud provider

Clodex can expose Ollama Cloud models alongside Claude and OpenAI/Codex models in the same Claude Code session.

## Setup

```bash
clodex providers add
```

Choose **Ollama Cloud API key** and paste a key from <https://ollama.com>. Then use `clodex models` to add models to favorites and `clodex patch` to make them selectable in Claude Code.

Models are served through the OpenAI-compatible SDK at `https://ollama.com/v1/chat/completions` (Bearer key). The destination is fixed by the template.

## Supported models

Chat Completions only, from a committed allowlist (`src/data/ollama-cloud-models.ts`): `kimi-k3`, `glm-5.3`, `glm-5.3-flash`, `deepseek-v4.1-flash`. Live `/v1/models` results are availability data; models absent from the allowlist are hidden. Pricing is subscription-based, so no per-token cost is recorded and the global pricing cache is not applied.

## Credential check

Whether `/v1/models` requires authentication is unverified, so the pasted key is probed against the authenticated chat-completions endpoint before it is saved. Only a definite 401/403 authentication rejection blocks the add; plan/entitlement 403s, timeouts, and network errors are inconclusive and the key is saved.

## Known gaps

- Context windows come from `model_info.*.context_length` in `https://ollama.com/api/show` (1,048,576 for all four as of 2026-10-01).
- Reasoning-effort mapping is unverified, so no effort is sent (`supportsReasoningEffort: false`).
