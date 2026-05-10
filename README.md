# Garcon

Garcon is a local coding workspace for agentic CLI and API backends: Claude Code,
Codex, OpenCode, Amp, Factory Droid, and OpenAI/Anthropic-compatible endpoints.

<table>
  <tr>
    <td align="center">
      <a href="screenshots/main-screen.png">
        <img src="screenshots/main-screen.png" alt="Garcon main workspace" width="200" />
      </a>
    </td>
    <td align="center">
      <a href="screenshots/git-screen.png">
        <img src="screenshots/git-screen.png" alt="Garcon git panel" width="200" />
      </a>
    </td>
    <td align="center">
      <a href="screenshots/main-screen-mobile.png">
        <img src="screenshots/main-screen-mobile.png" alt="Garcon mobile layout" width="70" />
      </a>
    </td>
    <td align="center">
      <a href="screenshots/main-screen-dark.png">
        <img src="screenshots/main-screen-dark.png" alt="Garcon main workspace in dark theme" width="200" />
      </a>
    </td>
  </tr>
  <tr>
    <td align="center"><em>Main workspace</em></td>
    <td align="center"><em>Git workbench</em></td>
    <td align="center"><em>Mobile layout</em></td>
    <td align="center"><em>Dark theme</em></td>
  </tr>
</table>

## What It Does

- Runs persistent coding chats across Claude, Codex, OpenCode, Amp, Factory, and direct API-compatible providers.
- Supports Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, Ollama, OpenRouter, Gemini, Fireworks, Together, Alibaba Cloud, Z.AI, and custom endpoints through Settings.
- Provides per-chat model, permission, thinking, image, tag, queue, read-state, pin, archive, reorder, fork, and share controls.
- Keeps a unified workspace with chat, file browser/editor, terminal, and Git tabs.
- Supports split chat panes with drag-and-drop, resizable layouts, and up to four visible chats.
- Offers saved searches, structured sidebar filters, quick search pills, tags, and unread/active filters.
- Includes a Git workbench for status, staged/unstaged review, split diffs, line/hunk/file staging, commits, branches, remotes, push/pull/fetch, worktrees, and revert/reset flows.

## Architecture

- `web/`: SvelteKit/Svelte 5 frontend.
- `server/`: Bun HTTP/WebSocket server, provider adapters, queueing, Git, auth, and notifications.
- `common/`: shared chat, WebSocket, provider, model, settings, and API contracts.

## Requirements

- [Bun](https://bun.sh/)
- `git`
- At least one backend:
  - Claude CLI/auth, `ANTHROPIC_API_KEY`, or an Anthropic-compatible endpoint
  - Codex auth, `OPENAI_API_KEY`, or an OpenAI-compatible endpoint
  - OpenCode config
  - Amp CLI/login
  - Factory Droid CLI/login or `FACTORY_API_KEY`
  - Local Ollama or another configured API provider

## Quick Start

```bash
git clone https://github.com/cfal/garcon.git
cd garcon
bun run install
bun run start
```

Default URL: `http://127.0.0.1:8080`.

On first launch, create the local account at `/setup`, then configure providers in
Settings. To skip local auth:

```bash
bun run start --disable-auth
# or
GARCON_DISABLE_AUTH=true bun run start
```

## Run And Configure

```bash
bun run start --port 8080 --bind-address 127.0.0.1 --project-base-dir /path/to/repos
```

Useful options and environment variables:

- `GARCON_PORT` / `--port`: listen port. Use `0` for a random port.
- `GARCON_BIND_ADDRESS` / `--bind-address`: server bind address.
- `GARCON_CONFIG_DIR` / `--config-dir`: base config directory. Defaults to `~/.garcon`.
- `GARCON_WORKSPACE` / `--workspace`: named workspace under the config dir.
- `GARCON_WORKSPACE_DIR` / `--workspace-dir`: explicit workspace directory.
- `GARCON_PROJECT_BASE_DIR` / `--project-base-dir`: filesystem access boundary.
- `GARCON_TERMINAL_SHELL`: shell used by PTY sessions.
- `GARCON_TELEGRAM_BOT_TOKEN`: enables Telegram notifications.
- `CLAUDE_BINARY`, `AMP_BINARY`, `FACTORY_BINARY`: override CLI binary paths.

Run `bun run help` for the full option list.

## Providers And Models

Configure providers from Settings. Garcon can use native harnesses, direct
Anthropic/OpenAI-compatible endpoints, and endpoint-backed models inside
compatible harnesses. API provider definitions are stored server-side; API keys
are redacted from client catalog responses.

Local Ollama models are supported through API provider templates and model
discovery.

## Build

Build the SvelteKit frontend:

```bash
bun run build
```

Build a standalone Bun executable:

```bash
bun run build-exe
```

`build-exe` runs checks/tests, builds `web/build`, compiles target-specific
executables under `dist/`, and runs an executable smoke test.

## Docker

Docker Hub images are published periodically but may lag behind the latest
commits. For the freshest image, build locally:

```bash
GARCON_PROJECT_DIR=~/repos docker compose up -d --build
```

Run a published image:

```bash
docker run -d \
  --name garcon \
  --init \
  --restart unless-stopped \
  -p 8080:8080 \
  -e GARCON_PORT=8080 \
  -e GARCON_BIND_ADDRESS=0.0.0.0 \
  -e GARCON_PROJECT_BASE_DIR=/projects \
  -e OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  -v garcon-data:/home/garcon/.garcon \
  -v "$HOME/repos":/projects \
  -v "$HOME/.claude":/home/garcon/.claude \
  -v "$HOME/.codex":/home/garcon/.codex \
  -v "$HOME/.opencode":/home/garcon/.opencode \
  -v "$HOME/.opencode/opencode-data":/home/garcon/.local/share/opencode \
  -v "$HOME/.opencode/opencode-state":/home/garcon/.local/state/opencode \
  -v "$HOME/.opencode/opencode-cache":/home/garcon/.local/cache/opencode \
  -v "$HOME/.amp":/home/garcon/.amp \
  garconide/garcon:latest
```

Set `GARCON_PROJECT_DIR` for Compose or mount `/projects` for `docker run`.
Config and workspace data are persisted in `garcon-data`.

## Development

```bash
bun run check
bun run test
```

For startup validation after code changes:

```bash
timeout 45s bun run start --port 0
```
