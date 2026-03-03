# Garcon

Garcon is a local-first coding workspace for AI agents, with one UI for Claude, Codex, and OpenCode.

## Capabilities

- Multi-provider chat sessions (`claude`, `codex`, `opencode`) with per-chat model selection
- Unified coding workspace tabs: chat, files, terminal, and git
- Full Git workbench: status, diff, staging/hunks, branches, history, commit/push/pull/fetch, worktrees, revert
- Persistent chat history with pin/archive/reorder/read-state/fork operations
- Per-chat message queueing (enqueue, pause, resume, clear) with recovery after restart
- File workspace: tree/list/browse, text editing, binary/image viewing, and image upload for prompts
- Built-in terminal tab (PTY over WebSocket) with reconnectable sessions
- Configurable project access boundary for filesystem safety

## Architecture

- `web/`: SvelteKit frontend (chat, files, shell, git panels)
- `server/`: Bun server + WebSocket orchestration + provider adapters
- `common/`: shared WS contracts and chat/event types

## Requirements

- [Bun](https://bun.sh/)
- At least one agent backend:
  - Claude CLI (`claude`) and local Claude auth
  - Codex auth (`~/.codex/auth.json`) or `OPENAI_API_KEY`
  - OpenCode provider keys/config (through OpenCode SDK)

## Quick Start

```bash
git clone https://github.com/cfal/garcon.git
cd garcon
bun run install
bun run start
```

Default URL: `http://127.0.0.1:8080`

On first launch, create the single local account at `/setup`, then configure providers in Settings.

## Docker

Run Garcon in a container with auto-restart on crash or machine reboot:

```bash
docker compose up -d
```

Point `GARCON_PROJECT_DIR` at the directory containing your repos:

```bash
GARCON_PROJECT_DIR=~/repos docker compose up -d
```

Pass API keys from the host:

```bash
OPENAI_API_KEY=sk-... docker compose up -d
```

View logs:

```bash
docker compose logs -f
```

Configuration is persisted in a Docker volume (`garcon-data`), so it survives container restarts.

## Run and Configuration

CLI options:

```bash
bun server/main.js --port 8080 --bind-address 127.0.0.1 --project-base-dir /path/to/repos
```

Common environment variables:

- `GARCON_PORT`, `GARCON_BIND_ADDRESS`
- `GARCON_CONFIG_DIR`, `GARCON_WORKSPACE_DIR`, `GARCON_WORKSPACE`
- `GARCON_PROJECT_BASE_DIR`
- `GARCON_TERMINAL_SHELL`
- `GARCON_JWT_TOKEN_EXPIRY`
- `OPENAI_API_KEY`
- `CLAUDE_BINARY`
