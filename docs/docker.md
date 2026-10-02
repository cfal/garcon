# Docker

Garcon's official container image is `ghcr.io/cfal/garcon:main`. It includes `garcon-cli` on PATH, Claude Code, Codex, Cursor Agent, OpenCode, Amp, Factory Droid, Pi, Git, SSH, and the GitHub CLI. The same image runs a controller by default or an executor with an explicit command. CI publishes every commit on `main` to `ghcr.io/cfal/garcon` for `linux/amd64` and `linux/arm64`.

## Start From GHCR

Published images use UID and GID `1000`. Create `.env` next to `docker-compose.yml` with the image and a project directory owned by those IDs:

```dotenv
GARCON_IMAGE=ghcr.io/cfal/garcon:main
GARCON_PROJECT_DIR=/home/you/repos
```

Pull and start the image without building the checkout:

```bash
docker compose pull garcon
docker compose up --no-build -d
```

The `main` tag advances after a successful build and controller/executor smoke test of the current `main` branch head. Every published commit also has an immutable `sha-<full commit SHA>` tag for pinned deployments. Pin controllers and executors to the same commit and upgrade them together; a matching package version alone does not guarantee executor protocol compatibility. Run the same pull and up commands to update a moving-tag installation.

The GHCR package must be public for anonymous pulls. The first publication creates the package; verify its visibility in the repository package settings.

## Build From Source

Build locally when using a different UID or GID, testing checkout changes, or customizing the runtime. Create `.env` with the project directory and the non-root UID and GID that own those files. Use `id -u` and `id -g` to find the values:

```dotenv
GARCON_PROJECT_DIR=/home/you/repos
GARCON_UID=1000
GARCON_GID=1000
```

Leave `GARCON_IMAGE` unset so Compose tags the build as `garcon:local`. The UID and GID must not be `0`. `GARCON_PROJECT_DIR` must be an absolute path to an existing directory owned by those IDs. Keep the values stable because existing named volumes retain their numeric ownership.

The host directory selected by `GARCON_PROJECT_DIR` appears inside the container as `/projects`; choose project paths below `/projects` when creating chats.

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:8080`. Set `GARCON_PORT` to change the port. The host listener defaults to `127.0.0.1`; set `GARCON_HOST_ADDRESS=0.0.0.0` only when other devices need access. Authentication remains enabled.

Garcon, every coding agent, terminal command, Git operation, and pull request command runs inside the container. Host project toolchains are not visible there. Add required language runtimes or system packages to a derived image or to the runtime stage in `Dockerfile`.

## CLI Access

`garcon-cli` uses the image's Bun and `/app/cli/main.ts`, like the VM launcher. It forwards arguments unchanged and works from any working directory without moving relative paths into `/app`:

```bash
docker compose exec garcon garcon-cli --version
docker compose exec garcon garcon-cli --runtime controller executor list --json
docker compose exec --workdir /projects/my-repo garcon garcon-cli list agents --json
```

The CLI discovers the process inside its own container through `GARCON_CONFIG_DIR`. Do not mount another container's runtime descriptor or copy controller CLI credentials to a worker. `--runtime` selects a local role, not a remote HTTP address; `--executor` selects an execution target through that authenticated origin.

## Executor Connects To Controller

Use the standalone `docker-compose.executor.yml` with Docker Compose 2.30 or newer. It starts only an executor, publishes no ports, and uses separate worker-prefixed state volumes. Do not combine it with the controller Compose file or share their state volumes. Use a distinct Compose project name for each independent worker.

On the controller, set `GARCON_PUBLIC_URL=https://controller.example.com` in `.env` when behind a TLS proxy, then recreate the controller container. The proxy must forward WebSocket upgrades for `/executor/<executor-id>`. The controller Compose file publishes only on host loopback by default: a remote worker needs a reachable proxy or an explicitly configured host binding, not `localhost` on the worker.

Register a worker from the controller container, retaining its returned UUID:

```bash
docker compose exec garcon garcon-cli executor create \
  --label 'Docker worker' --direction executor-connects
```

An explicit `--advertise-url 'wss://controller.example.com/executor/{executorId}'` can override the controller's public URL. Export the credential into a new private environment file without displaying it:

```bash
(
  set -euC
  umask 077
  printf 'GARCON_CONTROLLER_URL=' > executor.env
  docker compose exec -T garcon garcon-cli executor connection <executor-id> >> executor.env
)
```

Transfer `executor.env` securely to the worker host, owned by the operator and mode `0600`. Keep it outside version control; the default filename is excluded from Git and Docker build context. Set `GARCON_EXECUTOR_ENV_FILE` to use a different path, preferably outside the checkout. The raw environment-file format preserves URL fragments, dollar signs, and query strings. Do not put the credential in image layers, build arguments, command arguments, or logs. Docker administrators can inspect container environment; this is not isolation from administrators. Garcon consumes the value before launching providers and terminals, but those processes share the worker OS account and must be trusted.

On the worker host, set `.env` with a controller-compatible `GARCON_IMAGE` and that host's `GARCON_PROJECT_DIR`, then start:

```bash
docker compose -p garcon-worker -f docker-compose.executor.yml pull executor
docker compose -p garcon-worker -f docker-compose.executor.yml up --no-build -d
```

For a local build, leave `GARCON_IMAGE` unset and use `up --build -d` instead. The recipe explicitly passes `--project-base-dir /projects`: the worker does not read the controller's `GARCON_PROJECT_BASE_DIR` environment setting. Worker storage lives at `/home/garcon/.garcon/executor` in its own persistent volume. Provider credentials, skills, Git configuration, and native histories use the same container paths documented below, with independent `executor-` volume names. Supported provider API-key environment variables may be supplied in the private worker environment file.

Verify readiness and grant workspace CLI access only when worker-side agents or shells need it:

```bash
docker compose exec garcon garcon-cli executor wait <executor-id> --ready --timeout 60
docker compose exec garcon garcon-cli executor update <executor-id> --allow-controller-cli true
# Run on the worker host:
docker compose -p garcon-worker -f docker-compose.executor.yml exec executor \
  garcon-cli --runtime executor list agents --json
```

The separate executor-management grant remains off; it is not required to run agents. Existing custom provider profiles can be assigned using `garcon-cli executor assign-provider <executor-id> --provider <profile-id>` on the controller. Do not copy controller configuration stores. Native provider logins remain worker-local, and provider endpoints must be reachable from that worker. See [executor permissions and targeting](cli.md#executor-management).

## Controller Connects To Executor

For an inbound TLS listener, create an override file such as `executor-listen.yml` alongside the Compose files. This removes the dialing credential file rather than leaving both connection modes configured:

```yaml
services:
  executor:
    env_file: !reset []
    environment:
      GARCON_CONTROLLER_URL: ""
    command:
      - bun
      - server/main.ts
      - executor
      - --project-base-dir
      - /projects
      - --listen
      - "19781"
      - --bind-address
      - 0.0.0.0
      - --tls-cert
      - /run/executor-tls/fullchain.pem
      - --tls-private-key
      - /run/executor-tls/key.pem
    ports:
      - "19781:19781"
    volumes:
      - /private/executor-tls:/run/executor-tls:ro
```

The certificate and key must be readable by the image's non-root UID; keep the key private. Allow controller traffic to the published port. Use both `-f docker-compose.executor.yml -f executor-listen.yml` for every Compose command in this mode:

```bash
docker compose -p garcon-worker -f docker-compose.executor.yml -f executor-listen.yml up --no-build -d
(
  set -euC
  umask 077
  mkdir -p "$HOME/.config/garcon-onboarding"
  docker compose -p garcon-worker -f docker-compose.executor.yml -f executor-listen.yml \
    exec -T executor bun /app/server/main.ts executor connection-url \
    --advertise-url wss://worker.example.com:19781/executor \
    > "$HOME/.config/garcon-onboarding/listener-connection.txt"
)
```

Keep this credential outside the checkout. Securely deliver it to
`$HOME/.config/garcon-onboarding/listener-connection.txt` on the controller host,
owned by the operator and mode `0600`, then register it without placing the URL in argv:

```bash
docker compose exec -T garcon garcon-cli executor create \
  --label 'Listening Docker worker' --direction controller-connects \
  --connection-url - < "$HOME/.config/garcon-onboarding/listener-connection.txt"
```

Readiness and CLI grants work as above. The listener credential survives container recreation through the worker data volume. Restart the worker after renewing TLS files. Behind a protected TLS proxy, replace both TLS flags with `--no-tls`, restrict the host-port binding to the proxy, and advertise the public `wss:` address. On a trusted private network, explicit `--no-tls` / `--no-tls true` permits `ws:` on both endpoints; Noise authentication remains mandatory. Never disable TLS implicitly. See [connection policy](cli.md#executor-connections).

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

## Image Validation

After building an image, run `bun run docker:smoke garcon:local`. The smoke test uses an isolated Docker network, fresh named volumes, and no provider credentials or model calls. It checks the packaged CLI from `/projects`, controller web assets and authentication, both executor connection directions, explicit project roots, CLI grants, catalogs, restart persistence, and graceful shutdown. Only its own containers, volumes, and network are removed. CI runs this smoke on amd64 against the published commit digest before promoting `:main`; arm64 is built but not runtime-smoke-tested by this gate.
