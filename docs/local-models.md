# Local Models in Garcon

This guide shows the simplest way to run local models in Garcon using Ollama.

Garcon can auto-detect Ollama and expose local models directly in the model picker for:

- `claude`
- `codex`

When detected, local models appear with a `(local)` suffix.

## Prerequisites

- Garcon installed and runnable
- Ollama installed
- At least one local model pulled in Ollama

## 1) Install and start Ollama

macOS (Homebrew):

```bash
brew install ollama
ollama serve
```

If Ollama is already installed, only `ollama serve` is needed.

Pull at least one model:

```bash
ollama pull llama3.1:8b
```

Quick health check:

```bash
curl http://localhost:11434/api/tags
```

You should get JSON that includes your pulled models.

## 2) Start Garcon

In a second terminal:

```bash
bun run start
```

Garcon auto-detects Ollama at startup using:

- `GARCON_OLLAMA_URL` (default: `http://localhost:11434`)
- `GARCON_OLLAMA_AUTO_DETECT` (default: `true`)

You should see one of these startup log lines:

- `ollama: detected at http://localhost:11434 (...)`
- `ollama: not detected (local models unavailable)`

## 3) Use a local model in chat

1. Open Garcon.
2. Create a new chat.
3. Choose provider `claude` or `codex`.
4. Pick a model that ends with `(local)`.
5. Send your prompt as normal.

No extra provider config is required for the built-in Ollama bridge path.

## Important behavior

- Local/cloud switching is blocked mid-session.
- If you start a chat on a cloud model, you cannot switch that same chat to a local model (or vice versa).
- Start a new chat when changing local vs cloud backend.

This prevents invalid session history replay across incompatible backends.

## Optional: custom Ollama host

If Ollama runs on another host/port:

```bash
GARCON_OLLAMA_URL=http://192.168.1.50:11434 bun run start
```

To disable auto-detection entirely:

```bash
GARCON_OLLAMA_AUTO_DETECT=false bun run start
```

## Troubleshooting

### Local models do not appear

- Confirm Ollama is running: `curl http://localhost:11434/api/tags`
- Confirm Garcon startup logs show `ollama: detected ...`
- Restart Garcon after starting Ollama or pulling new models
- Verify `GARCON_OLLAMA_URL` points to the correct Ollama instance

### Auth looks different for local usage

When using local models through Ollama, Garcon routes provider traffic to your local endpoint. External provider login may not be required for that chat path.

### New model is missing right after pull

Garcon refreshes Ollama models periodically (about once per minute). You can also restart Garcon to pick up new models immediately.