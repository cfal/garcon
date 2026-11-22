# Agent CLI Updates

Settings > Providers shows the Claude Code and Codex CLI versions on the selected
executor. When a newer release exists, it either updates the CLI in place or
shows the command to run. Detection and installer selection are ported from T3
Code's provider maintenance resolver at
[be91767](https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/packages/provider-core/src/server/maintenanceResolver.ts#L801-L1035).

## Data Flow

```text
Settings > Providers -> GET /api/v1/agents/cli-updates?executorId[&refresh=1][&agent=<id>...]
                     POST /api/v1/agents/cli-updates { agentId, executorId }
  -> AgentCliUpdateService (controller): one call per integration with the facet
    -> AgentIntegration.cliUpdates on the executor (Local or remote)
      -> CliUpdateService (server-agents/common/src/cli-update)
```

- `cliUpdates` is a nullable `AgentIntegration` facet. Claude and Codex
  implement it; other integrations report `null`. Its RPC methods
  `cliUpdates.status` and `cliUpdates.startUpdate` are journaled on the primary
  lane.
- Everything runs on the executor that runs the CLI: PATH resolution, version
  probes, latest-version lookups, and the installer. The controller validates
  each status with `parseAgentCliUpdateStatus` and never interprets worker paths.
- Installers, version probes, and lookups run with the executor's process
  environment minus every provider credential: any `*_API_KEY`, Claude's
  OAuth and auth tokens, and the AWS and Google credentials Claude uses for
  Bedrock and Vertex. The CLI's own `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is
  added. Registry and proxy settings such as `NPM_TOKEN` and `HTTPS_PROXY`
  pass through; a private registry token kept in a `*_API_KEY` variable must
  be renamed for an `.npmrc` to read it during an update.
- A status check that fails for one agent is reported in `failures` for that
  agent only, including one that outlasts the controller's 25 second deadline.
  An unavailable executor fails the request.
- Starting an update that Garcon cannot run, such as an unmanaged
  install, answers 422 `OPERATION_UNSUPPORTED` with the reason.
- While a run is active, the page polls every two seconds with `agent` set to
  the running agents, so other CLIs are not probed again.

## Installation Methods

The updater uses the same executable as the agent: `CLAUDE_BINARY` or `claude`
for Claude Code, and `GARCON_CODEX_CLI` or `codex` (`codex.exe` on Windows)
for Codex. Bare names use the executor's service PATH. The updater follows
symlinks to identify the installation:

| Method | Recognized by | Update command | Latest version |
| --- | --- | --- | --- |
| `native` | Claude: `~/.local/share/claude/`, `claude/versions/`; Codex: `<CODEX_HOME>/packages/standalone/` | `<launcher> update` | Claude's release channel, Codex's native release channel |
| `npm` | `<prefix>/lib/node_modules/<package>/` outside any other `node_modules` | `npm install -g --prefix <prefix> --allow-scripts=<package> <package>@latest` | `npm view` |
| `bun` | `~/.bun/bin/`, `~/.bun/install/global/` | `bun i -g <package>@latest` | `npm view` |
| `pnpm` | pnpm global directories | `pnpm add -g [--allow-build=<package>] <package>@latest` | `npm view` |
| `yarn` | `yarn/global/node_modules/` | `yarn global add <package>@latest` | `npm view` |
| `homebrew` | `<prefix>/Cellar/<name>/` or `<prefix>/Caskroom/<name>/` | `brew upgrade [--cask] <name>` | `brew info --json=v2` |
| `unmanaged` | Nix store, mise, and anything else | none | `npm view` |

- An npm-owned install wins over a native-looking launcher that points into it.
- Claude's channel is `autoUpdatesChannel` from `$CLAUDE_CONFIG_DIR/settings.json`,
  overridden by managed settings, and defaults to `latest`.
- `npm view` uses npm's own registry, scope, and proxy configuration; without
  npm the public registry is read. Found versions are cached for an hour and
  misses for a minute; Check for updates bypasses the cache.
- When the installer itself is missing from PATH, or the method is
  `unmanaged`, the status carries `canUpdate: false` and the UI shows the
  command to run, if one is known.
- Mise, Volta, Vite+, MacPorts, Chocolatey, and WinGet ownership are not
  ported from T3 Code; such installs report `unmanaged`.

## Update Runs

- A run belongs to the executor process and is not persisted. A repeated start
  while a run is active returns that run. Runs that share an installer, such as
  two CLIs in one npm prefix, are serialized within the process.
- The run first rechecks the latest version and finishes as `succeeded`
  without running the installer when the CLI is already current.
- The installer runs with no stdin, a 30 minute deadline, and the last 10,000
  bytes of each output stream, where failures are reported. A deadline stops
  its whole process tree. Its latest output line is the run's progress
  message, updated at most once a second.
- A status read during a run reports the snapshot taken when the run started,
  so the binary is not probed mid-install.
- After the installer exits, the CLI is probed again. The run is `succeeded`
  when the new version reaches the latest release, `unchanged` when it does not
  or cannot be read, and `failed` when the installer exits non-zero or times
  out, with the last line naming an error.
- Running chats keep the process they started with. Claude drops its cached
  version check after a run, so the next session verifies the new binary
  against Garcon's minimum supported version.
- Sessions are not held back during a run. A package manager replaces its
  install in place, so a session started while npm, bun, pnpm, yarn, or
  Homebrew is writing can fail to start; starting it again after the run
  succeeds. The native installers switch versions atomically.
- A start whose reply is lost, for example to a browser timeout, may still have
  started the run, so the page reads that agent's status again instead of
  assuming it did not.
- In the Docker image, Claude Code is installed natively under
  `/home/garcon/.local`, outside the state volumes. An update applies to that
  container until it is recreated; rebuild the image to keep it.
