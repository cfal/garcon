<h1 align="center">Garcon</h1>

<p align="center"><strong>Run the agents. Steer the work. Ship the change.</strong></p>

<p align="center">
  Garcon is a self-hosted browser workspace for Claude Code, Codex, Cursor Agent, OpenCode, Amp, Factory Droid, Pi, and your own model endpoints. Keep parallel sessions visible, redirect work while it runs, inspect the real files and diffs, turn pull request feedback into agent tasks, and ship from your computer or phone.
</p>

<p align="center">
  <a href="#why-garcon">Why Garcon</a> &middot;
  <a href="#see-it-in-action">See it in action</a> &middot;
  <a href="#works-with">Works with</a> &middot;
  <a href="#quick-start">Quick Start</a>
</p>

<p align="center">
  <a href="screenshots/readme-parallel-agents-dark.png">
    <img src="screenshots/readme-parallel-agents-dark.png" alt="Claude and Pi sessions side by side in Garcon, one implementing order validation while the other reviews its test coverage" width="100%" />
  </a>
</p>

<p align="center"><em>Different agents, different tasks, one workspace.</em></p>

Garcon runs on the machine that has your code and uses the agent logins and model endpoints you configure. Agent, terminal, file, and Git operations execute on the Garcon host.

## Why Garcon

The terminal is excellent for one focused agent session. It gets harder when several agents are working, one needs approval, another has finished, and the resulting change still needs review. Generic chat interfaces improve visibility but usually stop before the project files, terminal, Git history, and pull request.

Garcon keeps that entire workflow together:

- **Run work in parallel.** Keep up to four live sessions in resizable split panes, drag chats into place, and see which agents are active, unread, or waiting for you.
- **Steer without waiting.** Queue the next instruction while an agent is busy, interrupt and redirect the current turn, approve tool use, and answer agent questions in place. Codex sessions can also steer an active turn directly.
- **Change approach without losing context.** Continue a conversation under another agent or model, fork supported sessions from the full history or an exact message, and compare alternatives side by side.
- **Review the work, not just the summary.** Browse and edit project files, open a terminal, inspect rendered reasoning and tool calls, review large diffs, and stage individual lines, hunks, files, or folders.
- **Close the loop.** Read GitHub pull requests and review threads, send a PR or individual comment to the active agent, generate commit messages, commit and push, and manage branches, worktrees, history, and reverts.
- **Keep the workload usable.** Search and organize chats by project, save filters, tag, pin, rename, reorder, archive, and track what needs attention. Share read-only transcripts and schedule one-off or recurring prompts into new or existing chats.
- **Step away without going blind.** Use the installable workspace from a phone and receive optional Telegram alerts when work completes, fails, or needs permission.

## See It In Action

<p align="center"><strong>Steer work while it is still running</strong></p>

<p align="center">
  <a href="screenshots/readme-agent-steering.png">
    <img src="screenshots/readme-agent-steering.png" alt="A light Garcon workspace with a diff-review follow-up queued while Claude waits to run targeted tests, with controls to interrupt or stop it" width="100%" />
  </a>
</p>

<p align="center">Queue the next instruction for later, or interrupt and send it immediately when the plan changes.</p>

<table>
  <tr>
    <td width="70%" align="center">
      <a href="screenshots/readme-git-review.png">
        <img src="screenshots/readme-git-review.png" alt="Garcon's dark Git workbench showing a multi-file TypeScript diff, mixed staged state, and line-level staging controls" width="100%" />
      </a>
    </td>
    <td width="30%" align="center">
      <a href="screenshots/readme-mobile-workspace.png">
        <img src="screenshots/readme-mobile-workspace.png" alt="A light mobile Garcon session showing a Claude command permission request with allow and deny actions" width="100%" />
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <strong>Review and ship</strong><br />
      Inspect the real diff, stage the lines you want, commit, and push.
    </td>
    <td align="center">
      <strong>Unblock work from anywhere</strong><br />
      Approve a blocked step or reply without going back to your desk.
    </td>
  </tr>
</table>

### Built For Agent Work

- Attach images, Markdown, text, and PDF documents, or mention project files with `@` autocomplete.
- Read code, Markdown, images, diagrams, agent reasoning, tool calls, and file edits in purpose-built views instead of raw terminal output.
- Follow Codex subagents from one status bar, and use slash-command autocomplete for agent commands, session forks, context compaction, and Codex goals.
- Share a secure, read-only transcript with a teammate or another agent, then revoke it when the work is finished.

## Works With

**Coding agents:** Claude Code, Codex, Cursor Agent, OpenCode, Amp, Factory Droid, and Pi.

**Direct model access:** Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions compatible endpoints.

**Provider presets and discovery:** Ollama, OpenRouter, Gemini, Fireworks, Together, Alibaba Cloud, Z.AI, and custom OpenAI or Anthropic compatible services.

Use an existing agent login or subscription where its CLI supports one, or configure API providers in Settings. Each chat keeps its own agent, model, effort, and permission settings where supported.

For CLI-backed agents, Garcon preserves the agent's native history where supported so existing work is not trapped in a separate inbox. Direct API-backed chats live in Garcon and do not have a corresponding CLI session.

## Quick Start

```bash
git clone https://github.com/cfal/garcon.git
cd garcon
bun run setup
bun run start
```

Open `http://127.0.0.1:8080`. On first launch, create an account at `/setup`, then connect agents and API providers in Settings.

`bun run setup` installs the root, server, web, and integration-test dependencies. Authentication is enabled by default.

### Requirements

- [Bun](https://bun.sh/) and `git`.
- A modern browser: Chrome/Edge 116+, Firefox 124+, or Safari/iOS Safari 17.4+.
- At least one working coding agent or API provider.
- Optional pull request support: an authenticated GitHub CLI on the Garcon host (`gh auth login`, `GH_TOKEN`, or `GITHUB_TOKEN`). The Pull Requests tab stays hidden when `gh` is unavailable.

## Run And Configure

```bash
bun run start --port 8080 --bind-address 127.0.0.1 --project-base-dir /path/to/repos
```

Useful options and environment variables:

- `GARCON_PORT` / `--port`: listen port. Use `0` for a random port.
- `GARCON_BIND_ADDRESS` / `--bind-address`: server bind address.
- `GARCON_CONFIG_DIR` / `--config-dir`: base config directory. Defaults to `~/.garcon`.
- `GARCON_WORKSPACE` / `--workspace`: named workspace under the config directory.
- `GARCON_WORKSPACE_DIR` / `--workspace-dir`: explicit workspace directory.
- `GARCON_PROJECT_BASE_DIR` / `--project-base-dir`: filesystem access boundary.
- `GARCON_TERMINAL_SHELL`: shell used by terminal sessions.
- `CLAUDE_BINARY`, `AMP_BINARY`, `FACTORY_BINARY`: override native CLI paths.
- `GARCON_CODEX_CLI`: override the Codex CLI used by Garcon.
- `GARCON_CURSOR_BINARY`: override the Cursor Agent CLI path.
- `CURSOR_API_KEY`: Cursor Agent API key for native Cursor sessions.
- `GARCON_PI_BINARY` / `PI_BINARY`: override the Pi CLI path.
- `PI_CODING_AGENT_SESSION_DIR`: optional Pi session directory override.

Configure Telegram notifications in Settings. Create and manage scheduled prompts from the sidebar menu. Run `bun run help` for the full option list.

### Agent Consultations From The CLI

`garcon-cli` starts an ordinary Garcon chat through an already-running local server, waits for the submitted turn, and prints the accepted chat and turn IDs before the final assistant response. The same chat remains visible in the SPA, including its tools, permission requests, transcript, and Stop controls.

```bash
garcon-cli \
  --workspace default \
  --cwd /path/to/project \
  --agent codex \
  --model gpt-5.4 \
  --permissions acceptEdits \
  --reasoning-effort high \
  --title "Implement validation" \
  "Implement the validation and run its focused tests."
```

Resume the same agent session without repeating its persisted selection:

```bash
garcon-cli --workspace default --resume 1785337200123456 \
  --title "Address review findings" \
  "Now address the review findings."
```

Query the running server for exact selection values before starting a chat:

```bash
garcon-cli list agents
garcon-cli list providers --agent codex
garcon-cli list endpoints --provider local-openai --agent codex
garcon-cli list models --agent codex --provider local-openai
garcon-cli list permissions --agent codex
garcon-cli list reasoning-efforts --agent codex
```

List commands print compact tables by default and accept `--json` for scripts and agents. Add
repeatable tags with `--tag review --tag delegated`; every new chat receives the `cli` tag
automatically, and `cli` records creation through `garcon-cli` and nothing else. `--title` sets
an explicit title on either a new or resumed chat.

Conversational start, resume, and `send-async` messages may add a visual CLI header with
`--message-title <title>` and `--message-style info|notice|error|custom`. A title alone uses
`notice`; a preset style alone displays its corresponding CLI label. Custom presentation uses
`--color <light[,dark]>`; one six-digit hex value applies to both themes. These values distinguish the
ordinary user message in Garcon and are not included in the prompt sent to the agent. `--title`
remains the chat title. Ordinary restart, replay, shares, and frozen forks preserve this
presentation; explicit native-history Reload and provider-native fork segments may drop it.

```bash
garcon-cli --workspace default --resume 1785337200123456 \
  --message-title "Deployment constraint" --color 0ea5e9,7dd3fc \
  "Do not deploy until the migration checksum matches."
```

The CLI supports write-capable delegation and does not force `plan` mode. Permission and reasoning values use the selected agent's live Garcon catalog; inherited bypass modes require the matching explicit `--permissions` flag. A single `-` prompt reads stdin. Use `--` before a positional prompt whose first word is `list`, `send-async`, `stop`, `add-row`, `status`, `wait`, or `export`. Interrupting the terminal detaches the CLI without stopping work in Garcon.

Every accepted start or resume prints an exact handle before waiting:

```text
chat id: 1785337200123456
turn id: 7fc16cb7-53e0-4c10-a4a4-cd85900eb548
```

Retain both values to reattach after a terminal interruption without submitting the prompt again:

```bash
garcon-cli --workspace default wait 1785337200123456 \
  --turn 7fc16cb7-53e0-4c10-a4a4-cd85900eb548
```

`wait --json` prints the terminal turn receipt as one JSON document. Turn receipts belong to the running server process and may expire under retention pressure, so reattachment can fail after a server restart or receipt eviction even though the chat transcript remains available in Garcon.

Inspect current chat-level progress when no retained turn handle is available:

```bash
garcon-cli --workspace default status 1785337200123456
garcon-cli --workspace default status 1785337200123456 --messages 20 --json
```

`status` returns the current processing phase, execution control, pending inputs, and the latest 10 normalized transcript messages by default. `--messages` accepts `0` through `200`; zero skips transcript loading for a lightweight execution-state check. A temporarily unavailable transcript is reported inside an otherwise successful snapshot. JSON is the stable machine-readable snapshot interface; plain text redacts image bodies and truncates each message at 4,000 characters. It is intentionally bounded operational state, not transcript export.

Status is a one-shot, non-transactional chat observation. `status: idle` does not prove that a particular turn settled or that a just-finished message batch is already visible. Use `wait` with the exact accepted chat and turn IDs when completion identity matters, especially before retrying write-capable delegated work.

Export the complete transcript at one pinned ledger watermark as Markdown or XML:

```bash
garcon-cli --workspace default export 1785337200123456
garcon-cli --workspace default export 1785337200123456 \
  --format xml --exclude tools --exclude reasoning --output transcript.xml
```

Without `--output`, stdout contains only the document. A file output is written privately through a sibling temporary file and published atomically; an existing path is refused unless `--force` is supplied. Markdown is intended for human and agent reading. Its entry headings contain only the durable ordinal and role or type; CLI-authored presentation labels remain on user entries because they distinguish operator notices and errors from ordinary prompts. Verbatim Markdown content may resemble an entry heading, so use XML when authoritative structure matters. XML uses explicit `<user>` and `<assistant>` elements plus typed elements for reasoning, tools, permissions, notices, handoffs, and run lifecycle rows; tags and types make repeated category and timestamp attributes unnecessary.

`--exclude` is repeatable and comma-separated. Its canonical categories are `tool-calls`, `tool-results`, `reasoning`, `permissions`, `diagnostics`, and `handoffs`; `tools` is shorthand for both tool categories. User messages, assistant messages, compaction summaries, and carryover-quarantine disclosures are never excludable. The typed response and file-output confirmation report canonical exclusions and omitted counts. Markdown includes one compact summary when rows were omitted; XML includes one compact `<omitted>` element with positive counts only when rows were omitted. Both artifacts preserve original ordinals, so filtered gaps remain visible. Exclusions apply to top-level entries: excluding tool calls does not remove a requested tool embedded in a retained permission entry.

`diagnostics` includes presentation-only `add-row` notices and errors, provider errors and notices, and run lifecycle rows.

Export reads Garcon's authoritative SQLite ledger through the running authenticated server. Session-native references and provider-private metadata never enter the export fold. Image bodies and structured data URLs are omitted with visible markers, while authored user and assistant text is retained. XML-illegal control characters are emitted as literal `\uXXXX` text in both formats. Sharing remains separate: Share publishes a persisted public snapshot, while export reads the current private ledger without creating or changing a share.

### One-Shot Chat Control From The CLI

`send-async` submits one turn to an existing chat and returns immediately after Garcon accepts it, without waiting for the agent to finish. The turn runs in Garcon and stays fully visible and stoppable in the SPA. It inherits the chat's saved execution settings, so it may edit files or run tools when the chat permits them; it accepts no model, permission, or other execution overrides.

```bash
garcon-cli --workspace default send-async 1785337200123456 \
  "Implement the reviewed changes and run the focused tests."
```

```text
chat id: 1785337200123456
delivery: new-turn
turn id: 7fc16cb7-53e0-4c10-a4a4-cd85900eb548
```

If the chat is busy running another turn, `send-async` reports the busy state and exits `3` without queueing or steering. Pass `--allow-steer` to deliver the message into the active turn instead; `--allow-steer` never queues:

```bash
garcon-cli --workspace default send-async 1785337200123456 \
  --allow-steer --message-title "New blocker" --message-style error \
  "Also update the migration test."
```

```text
chat id: 1785337200123456
delivery: steer
turn id: 7fc16cb7-53e0-4c10-a4a4-cd85900eb548
```

When the chat state changes between the run and steer checks, `send-async` alternates between the two endpoints for at most three total attempts with a short delay, then reports the race instead of risking a duplicate delivery. Use a single `-` as the message to read UTF-8 text from stdin:

```bash
printf '%s' "Apply the patch described in /tmp/review.md" | \
  garcon-cli --workspace default send-async 1785337200123456 --allow-steer -
```

`add-row` appends a durable presentation-only row without submitting agent work. Its
`--type info|notice|error` preset or `--color <light[,dark]>` custom style and optional `--title`
are visible in Garcon but excluded from model context and transcript search. Pass `--markdown`
to render the row body as Markdown. One custom color applies to both themes; a second selects the
dark-theme accent:

```bash
garcon-cli --workspace default add-row 1785337200123456 \
  --color 7c3aed,c4b5fd --markdown --title "Consultation status" \
  "**The architecture review is complete.**"
```

`stop` interrupts the active turn through the same REST command the SPA Stop button uses, and treats an already-idle chat as success. If queued messages exist, stopping pauses the queue so they do not start after the interruption; resume the queue in Garcon before sending a new direct turn:

```bash
garcon-cli --workspace default stop 1785337200123456
```

```text
chat id: 1785337200123456
stop: interrupt-requested
```

Ctrl-C detaches the terminal without sending `stop`; interrupting a `send-async` or `stop` invocation reports that the command may have reached Garcon, so inspect the chat before retrying. Neither `send-async` nor `stop` adds the `cli` tag; only starting a chat through `garcon-cli` does.

Discovery requires the server to use a named `--workspace`; servers launched with `--workspace-dir` are intentionally not discoverable. `--server` may assert the descriptor's exact URL but cannot redirect credentials to another listener. Run `garcon-cli --help` for provider, endpoint, and complete mode options.

### Local Trusted Use

To disable Garcon's local authentication for a trusted single-user environment:

```bash
bun run start --disable-auth
# or
GARCON_DISABLE_AUTH=true bun run start
```

Do not expose an unauthenticated instance to an untrusted network. API keys are stored on the Garcon server and redacted from client responses, but configured agents and model providers still receive the context required to perform their work. Review the [security notes](docs/security.md), including the WebSocket token logging considerations, before exposing Garcon beyond a trusted network.

## Build And Develop

```bash
bun run build      # Build the SvelteKit frontend
bun run build-exe  # Build and smoke-test standalone executables
bun run check      # Lint and type-check
bun run test       # Run server, protocol integration, and web tests
```

### Integration Tests

`integration-tests/` starts a real Garcon server in an isolated temporary workspace and drives it through public HTTP and WebSocket contracts. A deterministic fake OpenAI-compatible server covers direct-chat lifecycle, queueing, interrupt delivery, reconnect and transcript stability, persistence, deletion, forking, concurrent chats, and provider failures without external credentials.

```bash
bun run test:integration:server
bun run build
LIGHTPANDA_BIN=/path/to/lightpanda bun run test:integration:e2e
```

The Lightpanda suite reuses the same process fixture and fake provider to exercise the production SPA without graphical screenshot assertions. CI pins and verifies the Lightpanda binary; local runs require `LIGHTPANDA_BIN` to name an executable binary.

Future integration coverage should add credential-backed, non-blocking validation for Pi, Cursor Agent, Amp, Factory Droid, and other supported agents; broaden the existing Claude Code, Codex, and OpenCode live lanes across real provider APIs; cover agent-native transcript, permission, tool, compaction, and subprocess behavior; authentication; partial assistant-token reconnects; and a graphical Chromium/WebKit lane for layout, screenshot, and accessibility rendering checks. External canaries must remain separate from deterministic correctness gates because they are costly and nondeterministic.

Repository layout:

- `web/`: SvelteKit and Svelte 5 frontend.
- `server/`: Bun HTTP/WebSocket server, agents, providers, queueing, Git, auth, and notifications.
- `common/`: shared chat, transport, agent, provider, model, settings, and API contracts.
- `integration-tests/`: black-box server and Lightpanda SPA integration suites.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Garcon is licensed under [GPL-3.0](LICENSE).
