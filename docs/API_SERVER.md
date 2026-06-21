# relay-ai API Server Guide

The `relay-ai server` command starts a local gateway server that acts as a bridge between various LLM backends (OpenCode Zen, OpenCode Go, Local Providers, or Vertex AI) and client applications/tools. It exposes a unified API supporting both Anthropic-compatible and OpenAI-compatible requests on the same port.

---

## 1. Starting the Server

To launch the gateway server in the foreground, run:

```bash
relay-ai server
```

If you want to use the Vertex AI gateway (which uses Google Application Default Credentials via `gcloud ADC`), run:

```bash
relay-ai server --vertex
```

### Startup Log Output Example
When the server starts, it will guide you through configuration steps (e.g., password setup, choosing which providers to expose, filtering by favorites) and print startup logs similar to:

```text
Relay AI server running
  Anthropic:  http://127.0.0.1:17645/anthropic
  OpenAI:     http://127.0.0.1:17645/openai/v1
  Network (en0):
    Anthropic:  http://192.168.68.70:17645/anthropic
    OpenAI:     http://192.168.68.70:17645/openai/v1
  Network (en7):
    Anthropic:  http://192.168.68.6:17645/anthropic
    OpenAI:     http://192.168.68.6:17645/openai/v1
  API key:    saved, rotate with `relay-ai server --setup`
  Catalog:    favorite models only

Model catalog:

  Anthropic
    claude-haiku-4-5-20251001
      anthropic: claude-haiku-4-5-20251001
      openai:    claude-haiku-4-5-20251001

  DeepSeek
    deepseek-v4-pro
      anthropic: anthropic-deepseek__deepseek-v4-pro
      openai:    deepseek-v4-pro

  Google Gemini
    gemini-3.1-flash-lite
      anthropic: anthropic-google__gemini-3.1-flash-lite
      openai:    gemini-3.1-flash-lite
    gemini-3.1-pro-preview
      anthropic: anthropic-google__gemini-3.1-pro-preview
      openai:    gemini-3.1-pro-preview
    gemini-3.5-flash
      anthropic: anthropic-google__gemini-3.5-flash
      openai:    gemini-3.5-flash

  Nvidia
    minimaxai/minimax-m2.7
      anthropic: anthropic-nvidia__minimaxai/minimax-m2.7
      openai:    minimaxai/minimax-m2.7
    minimaxai/minimax-m3
      anthropic: anthropic-nvidia__minimaxai/minimax-m3
      openai:    minimaxai/minimax-m3

  OpenCode Go
    Kimi K2.7 Code
      anthropic: anthropic-go__kimi-k2.7-code
      openai:    kimi-k2.7-code
    MiMo V2.5 Pro
      anthropic: anthropic-go__mimo-v2.5-pro
      openai:    mimo-v2.5-pro
    MiniMax M3 (3x usage)
      anthropic: anthropic-go__minimax-m3
      openai:    minimax-m3
    Qwen3.7 Plus
      anthropic: anthropic-go__qwen3.7-plus
      openai:    qwen3.7-plus

  OpenCode Zen
    Big Pickle
      anthropic: anthropic-zen__big-pickle
      openai:    big-pickle
    MiMo V2.5 Free
      anthropic: anthropic-zen__mimo-v2.5-free
      openai:    mimo-v2.5-free

  OpenRouter
    Z.ai: GLM 5.2
      anthropic: anthropic-openrouter__z-ai/glm-5.2
      openai:    z-ai/glm-5.2

  xAI Grok (SuperGrok)
    grok-4.3
      anthropic: anthropic-xai-oauth__grok-4.3
      openai:    grok-4.3
    grok-build-0.1
      anthropic: anthropic-xai-oauth__grok-build-0.1
      openai:    grok-build-0.1
```

Each model in the catalog is printed with two identifiers:
- **`anthropic:`**: Use this identifier if your client tool expects Anthropic-format requests (e.g. Anthropic SDK or Claude Code).
- **`openai:`**: Use this identifier if your client tool expects OpenAI-format requests (e.g. OpenAI SDK or general OpenAI-compatible extensions).

---

## 2. Configuring Clients

### [THE AI Counsel](https://github.com/jacob-bd/the-ai-counsel)

[THE AI Counsel](https://github.com/jacob-bd/the-ai-counsel) can be easily configured to use the local or network-accessible `relay-ai` gateway.

1. Open **THE AI Counsel** settings panel.
2. Scroll to the **LLM API Keys** section.
3. Locate **Custom OpenAI-Compatible Endpoint**:
   - **Display Name**: Give your server connection any descriptive name you want (e.g., `Relay AI Server`).
   - **Base URL**:
     * **Local connection (same machine)**: Set to `http://127.0.0.1:17645/openai/v1`
     * **Remote/Network connection (other machine)**: Set to `http://<IP_ADDRESS>:17645/openai/v1` using one of the local network IP addresses printed by the server on startup (e.g., `http://192.168.68.6:17645/openai/v1`).
   - **API Key**: Optional. Enter the server password if password protection is enabled, or leave empty if the server runs without a password.
4. Click **Connect** to query and fetch all models available on the gateway.

![THE AI Counsel Settings](/Users/jbendavi/dev_projects/relay-ai/docs/ai-counsel-setup.png)
