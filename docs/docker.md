# Docker

The Compose setup builds the current checkout and includes Claude Code, Codex, Cursor Agent, OpenCode, Amp, Factory Droid, Pi, Git, SSH, and the GitHub CLI.

## Start

Create `.env` next to `docker-compose.yml` with the project directory and the non-root UID and GID that own those files. Use `id -u` and `id -g` to find the values:

```dotenv
GARCON_PROJECT_DIR=/home/you/repos
GARCON_UID=1000
GARCON_GID=1000
```

The UID and GID must not be `0`. `GARCON_PROJECT_DIR` must be an absolute path to an existing directory owned by those IDs. Keep the values stable because existing named volumes retain their numeric ownership.

The host directory selected by `GARCON_PROJECT_DIR` appears inside the container as `/projects`; choose project paths below `/projects` when creating chats.

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:8080`. Set `GARCON_PORT` to change the port. The host listener defaults to `127.0.0.1`; set `GARCON_HOST_ADDRESS=0.0.0.0` only when other devices need access. Authentication remains enabled.

Garcon, every coding agent, terminal command, Git operation, and pull request command runs inside the container. Host project toolchains are not visible there. Add required language runtimes or system packages to a derived image or to the runtime stage in `Dockerfile`.

## Persistent State

Compose uses named volumes for credentials, configuration, and native history. This avoids host/container UID conflicts, platform-specific binaries overwriting Linux binaries, and SQLite databases on desktop bind mounts.

| Volume | Container path | Persistent state |
| --- | --- | --- |
| `garcon-data` | `/home/garcon/.garcon` | Garcon workspaces, settings, ledgers, and indexes |
| `agent-config` | `/home/garcon/.config` | Amp, Git, GitHub CLI, and OpenCode configuration |
| `agents-home` | `/home/garcon/.agents` | Shared agent skills |
| `claude-home` | `/home/garcon/.claude` | Claude credentials and native history |
| `codex-home` | `/home/garcon/.codex` | Codex credentials and native history |
| `cursor-home` | `/home/garcon/.cursor` | Cursor credentials and native history |
| `factory-home` | `/home/garcon/.factory` | Factory credentials and native history |
| `pi-home` | `/home/garcon/.pi` | Pi credentials, settings, and native history |
| `opencode-data` | `/home/garcon/.local/share/opencode` | OpenCode credentials and session database |
| `opencode-state` | `/home/garcon/.local/state/opencode` | OpenCode runtime state |
| `amp-data` | `/home/garcon/.local/share/amp` | Amp device state |
| `ssh-home` | `/home/garcon/.ssh` | SSH keys and known hosts |

OpenCode cache remains ephemeral. Its data and state volumes mount the actual XDG paths directly; Docker does not need the single-disk symlink indirection used by VM setups.

Normal builds may reuse cached agent-installer layers. Run `docker compose build --no-cache` before `docker compose up -d` when refreshing those CLIs. Agent binaries remain outside the state volumes, so rebuilding does not delete credentials or history. `docker compose down` preserves volumes; `docker compose down -v` permanently deletes them.

## Agent And Git Setup

Claude and Codex login can be started from Settings. Configure other CLIs in a container shell, or provide their supported API-key environment variables to Compose:

```bash
docker compose exec garcon bash -l
```

For commit, push, and pull request workflows, configure the container-owned Git and GitHub state once:

```bash
docker compose exec garcon git config --global user.name "Your Name"
docker compose exec garcon git config --global user.email "you@example.com"
docker compose exec garcon gh auth login
docker compose exec garcon sh -c 'ssh-keyscan github.com >> "$HOME/.ssh/known_hosts"'
```

The SSH step is needed only for SSH remotes. HTTPS remotes can use GitHub CLI authentication instead.
