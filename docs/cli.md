# Garcon CLI And Server

`bun cli/main.ts` controls ordinary Garcon chats through an already-running server. Chats started or resumed from the CLI stay visible in the SPA with their tools, permission requests, transcript, queue, and Stop controls.

The examples below run from a Garcon checkout. `bun run build-exe` produces `dist/garcon-cli-linux-x64` and `dist/garcon-cli-darwin-arm64`; their help and command syntax use the `garcon-cli` name.

## Server Configuration

```bash
bun run start --port 8080 --bind-address 127.0.0.1 \
  --project-base-dir /path/to/repos
```

Common options and environment variables:

- `GARCON_PORT` / `--port`: listen port. Use `0` for a random port.
- `GARCON_BIND_ADDRESS` / `--bind-address`: server bind address.
- `GARCON_CONFIG_DIR` / `--config-dir`: base config directory. Defaults to `~/.garcon`.
- `GARCON_WORKSPACE` / `--workspace`: named workspace under the config directory.
- `GARCON_WORKSPACE_DIR` / `--workspace-dir`: explicit workspace directory.
- `GARCON_PROJECT_BASE_DIR` / `--project-base-dir`: filesystem access boundary.
- `GARCON_TERMINAL_SHELL`: shell used by terminal sessions.
- `CLAUDE_BINARY`, `AMP_BINARY`, `FACTORY_BINARY`: native CLI overrides.
- `GARCON_CODEX_CLI`: Codex CLI override.
- `GARCON_CURSOR_BINARY`: Cursor Agent CLI override.
- `CURSOR_API_KEY`: Cursor Agent API key for native sessions.
- `GARCON_PI_BINARY` / `PI_BINARY`: Pi CLI override.
- `PI_CODING_AGENT_SESSION_DIR`: optional Pi session directory override.

Run `bun run help` for the complete server option list.

## Start And Resume

Start a visible chat and wait for its accepted turn:

```bash
bun cli/main.ts \
  --workspace default \
  --cwd /path/to/project \
  --agent codex \
  --model gpt-5.4 \
  --permissions acceptEdits \
  --reasoning-effort high \
  --title "Implement validation" \
  --tag implement \
  "Implement the validation and run its focused tests."
```

Every accepted start or resume prints an exact handle before waiting:

```text
chat id: 1785337200123456
turn id: 7fc16cb7-53e0-4c10-a4a4-cd85900eb548
```

Resume the same agent session without repeating its saved selection:

```bash
bun cli/main.ts --workspace default --resume 1785337200123456 \
  "Address the review findings."
```

New chats created through the CLI receive the `cli` tag. Add repeatable tags with `--tag review --tag delegated`. `--title` sets the chat title.

Use `--parent <chat-id>` when the new chat is delegated from an existing chat,
for example when one agent starts another for review. Garcon records an immutable
`delegation` relationship and shows it in Work Map. The parent must exist in the
same workspace. Declaring it does not copy transcript content, inherit execution
settings, or make either chat wait for the other. `--parent` is creation-only and
cannot be used with `--resume`.

```bash
bun cli/main.ts \
  --workspace default \
  --cwd /path/to/project \
  --parent 1785337200123456 \
  --agent claude \
  --model claude-sonnet-4-5 \
  --tag review \
  "Review the parent chat's implementation."
```

The CLI supports write-capable delegation and does not force plan mode. Permission and reasoning values use the selected agent's live catalog. A single `-` prompt reads UTF-8 stdin. Use `--` before a prompt whose first word is a CLI subcommand.

Interrupting the terminal detaches the CLI without stopping work in Garcon.

## Discover Exact Selections

Query the running server rather than guessing provider, model, permission, or effort values:

```bash
bun cli/main.ts list agents
bun cli/main.ts list providers --agent codex
bun cli/main.ts list endpoints --provider local-openai --agent codex
bun cli/main.ts list models --agent codex --provider local-openai
bun cli/main.ts list permissions --agent codex
bun cli/main.ts list reasoning-efforts --agent codex
```

List commands print compact tables and accept `--json` for scripts and agents.

## Message Presentation

Start, resume, and `send-async` messages can add a visual header with `--message-title` and `--message-style info|notice|error|custom`. A title alone uses `notice`. Custom styling uses `--color <light[,dark]>`.

Presentation distinguishes the ordinary user message in Garcon and is not included in the prompt sent to the agent. `--collapsible` starts the message body collapsed.

```bash
bun cli/main.ts --workspace default --resume 1785337200123456 \
  --message-title "Deployment constraint" \
  --color 0ea5e9,7dd3fc \
  --collapsible \
  "Do not deploy until the migration checksum matches."
```

Restart, replay, shares, and frozen forks preserve CLI presentation. Explicit native-history Reload and provider-native fork segments may drop it.

## Wait And Status

Reattach to an accepted turn without submitting its prompt again:

```bash
bun cli/main.ts --workspace default wait 1785337200123456 \
  --turn 7fc16cb7-53e0-4c10-a4a4-cd85900eb548
```

`wait --json` prints one terminal turn receipt. Receipts belong to the running server process and may expire after restart or retention eviction even though the durable transcript remains available.

Inspect current chat-level progress when no retained turn handle is available:

```bash
bun cli/main.ts --workspace default status 1785337200123456
bun cli/main.ts --workspace default status 1785337200123456 \
  --messages 20 --json
```

`status` reports processing, execution controls, pending inputs, and 10 recent normalized transcript messages by default. `--messages` accepts 0 through 200; zero skips transcript loading. JSON is the stable machine-readable interface; plain text redacts image bodies and truncates long messages.

Status is a one-shot, non-transactional observation. Use `wait` with the exact accepted chat and turn IDs when completion identity matters.

## Export

Export the complete transcript at one pinned ledger watermark as Markdown or XML:

```bash
bun cli/main.ts --workspace default export 1785337200123456
bun cli/main.ts --workspace default export 1785337200123456 \
  --format xml --exclude tools --exclude reasoning \
  --output transcript.xml
```

Without `--output`, stdout contains only the document. File output is private and atomic; an existing path is refused unless `--force` is supplied.

Markdown is intended for human and agent reading. XML uses explicit typed elements and is the authoritative structured format. Both retain durable ordinals so filtered gaps remain visible.

`--exclude` is repeatable or comma-separated. Categories are:

- `tool-calls`
- `tool-results`
- `reasoning`
- `permissions`
- `diagnostics`
- `handoffs`
- `tools`, shorthand for both tool categories

User and assistant messages, compaction summaries, and carryover-quarantine disclosures cannot be excluded. Exclusions apply to top-level entries; excluding tool calls does not remove a requested tool embedded in a retained permission entry.

Export reads Garcon's authoritative ledger through the running authenticated server. Session-native references and provider-private metadata do not enter the normalized fold. Sharing remains separate: Share publishes a persisted public snapshot, while export reads the current private ledger without changing a share.

## Handoff Artifacts

Create a bounded XML projection for whole-chat summarization:

```bash
bun cli/main.ts --workspace default handoff 1785337200123456 \
  --context-window-size 131072 --output handoff.xml
```

`handoff` is read-only: it creates no chat, changes no agent or owner, starts no run, and appends no transcript row.

The context window is the consuming model's token capacity. Garcon limits the artifact to 75% of that capacity using a generic estimate, leaving headroom for instructions and the response. Token usage varies by model.

Every retained source element carries its durable ordinal. Gap markers and the file receipt disclose omitted or abridged entries, transcript view and watermark, estimated usage, byte count, and SHA-256.

Use a handoff artifact for comprehensive high-level synthesis. Use complete XML export for exact enumeration and quotation.

## Asynchronous Delivery And Steering

`send-async` submits to an existing chat and returns as soon as Garcon accepts it. The turn stays visible and stoppable in the SPA and inherits the target chat's saved execution settings.

```bash
bun cli/main.ts --workspace default send-async 1785337200123456 \
  "Implement the reviewed changes and run the focused tests."
```

If the target is busy, the command exits `3` without queueing or steering. Pass `--allow-steer` to deliver into the active turn instead. `--allow-steer` never queues:

```bash
bun cli/main.ts --workspace default send-async 1785337200123456 \
  --allow-steer \
  --message-title "New blocker" \
  --message-style error \
  "Also update the migration test."
```

Successful output identifies `delivery: new-turn|steer` and the accepted turn ID. Garcon bounds run/steer race retries and reports ambiguity rather than risking duplicate delivery.

CLI exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Command completed successfully |
| `1` | The accepted agent turn failed |
| `2` | Invalid arguments, selection, or request |
| `3` | Operational, transport, busy, or unavailable result |
| `4` | The accepted turn was stopped or its chat was deleted |
| `130` | The terminal command was interrupted |

## Presentation Rows And Stop

`add-row` appends a durable presentation-only row without submitting agent work. It is excluded from model context and transcript search.

```bash
bun cli/main.ts --workspace default add-row 1785337200123456 \
  --color 7c3aed,c4b5fd \
  --markdown \
  --collapsible \
  --title "Consultation status" \
  "**The architecture review is complete.**"
```

`stop` interrupts the active turn through the same command as the SPA Stop button:

```bash
bun cli/main.ts --workspace default stop 1785337200123456
```

If queued messages exist, stopping pauses the queue. Resume it in Garcon before sending a new direct turn. Ctrl-C only detaches the terminal and does not send Stop.

## Connection Rules

Discovery requires a server using a named workspace. Servers launched with `--workspace-dir` are intentionally undiscoverable. `--server` asserts the workspace descriptor's exact URL but cannot redirect credentials to another listener.

Run `bun cli/main.ts --help` for the complete command and option reference.
