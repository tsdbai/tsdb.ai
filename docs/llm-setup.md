# LLM Connection — Setup Guide

TSDB.ai's AI Chat and AI Dashboard can use any of three LLM providers: **OpenAI**, **Anthropic (Claude)**, or a **self-hosted local model** via any OpenAI-compatible endpoint. This document covers how to connect each one.

---

## Where credentials are stored

LLM credentials are stored **entirely in your browser's `localStorage`** — they never touch the TSDB.ai Go server, are never written to disk on the server, and are never transmitted anywhere except directly from your browser to the LLM provider's API (or your local endpoint). This is safe to use on a private network without a proxy.

---

## Opening the LLM settings panel

Both the **AI Chat** page (`/chat`) and the **AI Dashboard** page (`/ai-dashboard`) have an **API Key** button in the top-right of the page header. Click it to expand the provider settings panel.

---

## Option A — OpenAI

**Supported models:** `gpt-4o`, `gpt-4-turbo`, `gpt-4o-mini`, `gpt-3.5-turbo`

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and create a new secret key.
2. In the TSDB.ai settings panel, select **🟢 OpenAI**.
3. Choose your model from the dropdown.
4. Paste your key (format: `sk-...`) into the API Key field.
5. Click **Save**.

The key is masked by default. Click the eye icon to reveal it.

**Billing note:** GPT-4o costs approximately $0.005 per 1K input tokens. A typical TSDB.ai query with live metric context attached is about 2,000–4,000 tokens. Keep this in mind for high-volume usage.

---

## Option B — Anthropic (Claude)

**Supported models:** `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`

1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) and generate an API key.
2. In the TSDB.ai settings panel, select **🔶 Anthropic**.
3. Choose your model from the dropdown.
4. Paste your key (format: `sk-ant-...`) into the API Key field.
5. Click **Save**.

**Note on browser access:** The Anthropic API call is made directly from the browser using the `anthropic-dangerous-direct-browser-access: true` header. This is intentional — it avoids needing a server-side proxy. For production deployments exposed to the internet, consider adding a lightweight auth proxy in front of the admin panel.

---

## Option C — Local LLM (Enterprise / Air-gapped)

For enterprise environments that cannot send data to cloud APIs, TSDB.ai supports any server that implements the **OpenAI-compatible `/v1/chat/completions` endpoint**. This includes:

| Software | Default port | Notes |
|---|---|---|
| **Ollama** | `11434` | Most popular; pull models with `ollama pull <name>` |
| **LM Studio** | `1234` | GUI-based; enable "Local Server" in settings |
| **llama.cpp server** | `8000` | Minimal C++ inference server |
| **vLLM** | `8000` | High-throughput serving for GPU clusters |
| **LocalAI** | `8080` | Drop-in OpenAI API replacement |
| **text-generation-webui** | `5000` | With the `--api` flag enabled |

### Setting up Ollama (recommended)

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model (choose based on your hardware)
ollama pull llama3          # 8B — good balance, needs ~6 GB RAM
ollama pull mistral         # 7B — fast, good for structured queries
ollama pull phi3            # 3.8B — very fast, runs on laptops
ollama pull llama3:70b      # 70B — best quality, needs ~48 GB RAM
ollama pull deepseek-coder  # optimized for code/data questions

# Verify the server is running
curl http://localhost:11434/v1/models
```

### Connecting to your local model in TSDB.ai

1. In the settings panel, select **🖥️ Local LLM**.
2. Set **Base URL** to your server's address:
   - Same machine: `http://localhost:11434`
   - Another server on LAN: `http://192.168.1.50:11434`
   - Docker container: `http://host.docker.internal:11434`
3. Set **Model Name** to the model you pulled (e.g. `llama3`, `mistral`, `phi3`).
4. Leave **API Key** blank unless your local server requires authentication.
5. Click **Save**.

The model name must exactly match what the server expects. For Ollama, run `ollama list` to see your installed models.

### Allowing cross-origin requests (CORS)

If the local LLM server and the TSDB.ai admin panel are on different origins, you may need to configure CORS on the LLM server.

**Ollama — enable CORS:**
```bash
# Set allowed origins (or * for all)
OLLAMA_ORIGINS="*" ollama serve

# Or permanently in your shell config:
echo 'export OLLAMA_ORIGINS="*"' >> ~/.bashrc
```

**LM Studio:** Go to Settings → Server → CORS → Enable.

**llama.cpp:** Start with `--cors-allow-all`.

---

## Verifying the connection works

After saving credentials, type any message in the chat and press Enter. If the connection is working you'll see a response within a few seconds.

Common errors and what they mean:

| Error | Cause | Fix |
|---|---|---|
| `OpenAI API error 401` | Invalid or expired API key | Re-generate the key at the provider console |
| `OpenAI API error 429` | Rate limit or quota exceeded | Check your billing/quota at the provider |
| `Local LLM error 404` | Wrong base URL or model name | Verify the server is running; check model name with `ollama list` |
| `Local LLM error 0 — is ... running?` | Server not reachable (network/CORS) | Check CORS settings; verify the URL is reachable from your browser |
| `Anthropic API error 403` | Direct browser access not enabled | Ensure `anthropic-dangerous-direct-browser-access` header is accepted by your proxy |

---

## Switching providers mid-session

You can switch providers at any time — existing chat messages stay in the session history, but subsequent replies will use the newly selected provider. This is useful for comparing responses from different models on the same question.

---

## Using LLM credentials with the MCP Server

The MCP Server (AI agent integration for Claude Desktop / Cursor) is separate from the admin panel's AI chat. It connects over SSE on port `8000` and does not use the browser-stored credentials. See [mcp-server.md](./mcp-server.md) for MCP configuration.
