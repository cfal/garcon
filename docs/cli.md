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
  start \
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
bun cli/main.ts --workspace default resume 1785337200123456 \
  "Address the review findings."
```

Start a chat without waiting for its turn to settle:

```bash
bun cli/main.ts --workspace default start-async \
  --cwd /path/to/project \
  --agent codex \
  --model gpt-5.4 \
  "Investigate the failing release check."
```

`start-async` prints the accepted chat and turn IDs, then returns. `--json` emits
one versioned envelope containing the exact receipt, parent relationship, server
instance, workspace, and title-update outcome. Use the turn ID with `wait` when
exact completion identity matters.

New chats created through the CLI receive the `cli` tag. Add repeatable tags with `--tag review --tag delegated`. `--title` sets the chat title.

Use `--parent <chat-id>` when the new chat is delegated from an existing chat,
for example when one agent starts another for review. Garcon records an immutable
`delegation` relationship and shows it in Chat Map. The parent must exist in the
same workspace. Declaring it does not copy transcript content, inherit execution
settings, or make either chat wait for the other. `--parent` is creation-only and
cannot be used with `resume`.

New chats resolve matching preambles from their own project, agent, and tags.
Use `--no-preamble` to send an explicit empty selection, or repeat
`--preamble <uuid>` to select exact IDs in order. These options are mutually
exclusive. Omitting both preserves server-side default selection. Delegated CLI
starts do not inherit parent tags or preamble selection; a child can independently
match defaults only from its own creation context.

```bash
bun cli/main.ts \
  --workspace default \
  start \
  --cwd /path/to/project \
  --parent 1785337200123456 \
  --agent claude \
  --model claude-sonnet-4-5 \
  --tag review \
  "Review the parent chat's implementation."
```

The CLI supports write-capable delegation and does not force plan mode. Permission and reasoning values use the selected agent's live catalog. A single `-` prompt reads UTF-8 stdin. Use `--` before prompt text that begins with an option-like token. Prompts beginning with command words are unambiguous after `start`, `start-async`, or `resume`.

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

`--provider` accepts a configured provider ID or its exact, case-sensitive display name. Quote names containing spaces. IDs take precedence over names. If multiple providers have the same name, use an ID; agent, model, and endpoint filters do not disambiguate provider names. This applies to catalog lists, starts, and resume model overrides. Resolved routing and saved chat configuration always use canonical IDs. Renaming a provider changes which name future commands can select, without changing existing chats.

## Lookup By Native Session

Resolve an agent's current native session binding through the authenticated server:

```bash
garcon-cli lookup-native-session session-123
garcon-cli lookup-native-session session-123 --agent codex
```

The optional `--agent` filter uses an exact agent ID. Without it, every current agent binding in the connected workspace is searched. Exactly one match prints only the 16-digit Garcon chat ID and a newline. No match or multiple matches fails without writing to stdout. Historical, replaced, handed-off, cleared, and deleted bindings are not searched.

## Message Presentation

Start, resume, and `resume-async` messages can add a visual header with `--message-title` and `--message-style info|notice|error|custom`. A title alone uses `notice`. Custom styling uses `--color <light[,dark]>`.

Presentation distinguishes the ordinary user message in Garcon and is not included in the prompt sent to the agent. `--collapsible` starts the message body collapsed.

```bash
bun cli/main.ts --workspace default resume 1785337200123456 \
  --message-title "Deployment constraint" \
  --color 0ea5e9,7dd3fc \
  --collapsible \
  "Do not deploy until the migration checksum matches."
```

Restart, replay, shares, and frozen forks preserve CLI presentation. Explicit native-history Reload and provider-native fork segments may drop it.

## Search And Chat History

List the complete chat metadata snapshot, optionally using the same filter language as the sidebar:

```bash
bun cli/main.ts --workspace default chats --json
bun cli/main.ts --workspace default chats \
  --filter 'project:/garcon tag:cli is:!archived' \
  --limit 50 --offset 0
```

Supported metadata operators are `title:`, `tag:`, `agent:`, `model:`,
`project:`, exact `id:`, direct-parent `parent:`, `created-before:`,
`created-after:`, `updated-before:`, `updated-after:`, `status:active|unread`,
and `is:pinned|normal|archived`. Negate an
order group with `is:!pinned`, `is:!normal`, or `is:!archived`. Pipe-separated
identity values are OR alternatives within one clause and repeated identity
clauses are ANDed. Repeated title and tag groups are also ANDed; agent,
model, and project values accumulate as alternatives. Bare terms are ANDed and
match chat title, project path, first and last previews, and tags. `chats` sorts
by effective activity descending and uses the chat ID as a stable tie-breaker.

Date-only filter values mean `00:00:00.000Z`. Datetimes must be RFC3339 with an
explicit `Z` or numeric offset and at most millisecond precision. Before and
after comparisons are strict. `created-*` uses chat creation time; `updated-*`
uses last transcript/list activity. Rename, tag, pin, and archive changes do not
advance that activity field.

Search normalized transcript content and join each hit to chat metadata:

```bash
bun cli/main.ts --workspace default transcript-search enable
bun cli/main.ts --workspace default transcript-search rebuild --json
bun cli/main.ts --workspace default transcript-search status --json
bun cli/main.ts --workspace default search '"version bump"' \
  --filter 'project:/garcon agent:codex' \
  --sort relevance --limit 20 --offset 0 --snippets 3 --json
```

Transcript search is disabled by default and is enabled or disabled explicitly
with `transcript-search enable|disable`. While search is enabled,
`transcript-search rebuild` deletes and recreates the derived index, then starts
a complete resynchronization. `transcript-search status` reports the
index phase, chat coverage, queued and active indexing work, backlog and resync
progress, the last error code, and query admission/execution/total latency
statistics. JSON status is the validated server status document.

Search is lexical. Quoted phrases require adjacent words in one indexed entry.
Unquoted terms are ANDed at chat scope and can occur in different messages;
terms of at least three code points use prefix matching. The plain result shows
the interpreted query, labels chat activity separately from snippet timestamps,
and prints an exact follow-up `read` command carrying the resolved workspace,
config directory, optional server assertion, and any category includes needed to
retain the matched anchor. Snippet timestamps answer when the matching message was
written; activity sorting does not order mentions by time.

Metadata filtering happens before ranking and restricts the server candidate
set. An empty filter omits the candidate list. A filter selecting more than
10,000 chats is rejected rather than split into independently ranked searches.

Search results are paged. Follow only `page.hasMore` and `page.nextOffset`; a
short result array is not proof that paging is complete. Offset pages are not a
snapshot while chats change, so callers should deduplicate chat IDs and compare
totals between pages. `--sort created` is the least volatile order for long
enumerations.

Coverage diagnostics are written to stderr. Pending, failed, unindexed, or
unsupported chats mean the result cannot establish absence. Failed coverage
includes up to 20 typed chat details with the affected chat ID, failure stage,
error code, indexed frontier where available, and recovery classification; an
omitted count preserves the total when more failures exist. Likewise,
`resultsTruncated` means index row sampling can make matches and `page.total`
incomplete; narrow the metadata filter or quote a phrase before drawing a
negative conclusion. Tool inputs and results are indexed with size bounds, so a
missing path match is not proof that the path was never used.
If a transcript view changes after the index page is selected, the response
reports how many stale hits were removed. The CLI warns for any positive count,
including a partially retained page, and callers should rerun the search.
`page.hasMore` and `page.nextOffset` remain authoritative.
Disabled search exits with the exact enable-command guidance. Busy, timeout, and
unavailable index states remain retryable operational failures. Invalid search
queries exit as argument failures.

Read bounded context around a search ordinal while pinning the transcript view:

```bash
bun cli/main.ts --workspace default read 1785337200123456 84 \
  -B 5 -A 5 --transcript-view-id view-1

bun cli/main.ts --workspace default read 1785337200123456 84 \
  --before-context 3 --after-context 8 --include tools --json
```

`-B` and `-A` count displayed entries after filtering. By default, `read`
retains the conversation spine: user and assistant messages, compaction
summaries, and carryover-quarantine notices. Optional `--include` categories are
repeatable or comma-separated:

- `tool-calls`
- `tool-results`
- `reasoning`
- `permissions`
- `diagnostics`
- `handoffs`
- `tools`, shorthand for both tool categories

Tool entries are opt-in because they can consume an entire bounded context
window, but they are often the decisive evidence for commands, file paths, and
failures. If the anchor itself is excluded, `read` fails and names the required
category. A supplied transcript view ID prevents a changed or forked transcript
from returning mismatched context; rerun search when the view is stale.

Plain read output redacts data URLs and truncates each rendered entry at 4,000
characters. `read --json` preserves the complete normalized values in the
bounded window and may expose sensitive tool inputs or results when those
categories are included. Use `export` for the complete archival transcript.

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

`status` reports processing, execution controls, pending inputs, pending
permission requests, and 10 recent normalized transcript messages by default.
Plain permission rows include the exact occurrence, run, and server-instance
fences plus shell-safe allow and deny commands where the request supports a
boolean decision. Structured rows include a typed answer template instead of an
allow command. They remain visible with `--messages 0` or an unavailable
transcript. `--messages` accepts 0 through 200; zero skips transcript loading.
JSON is the stable machine-readable interface; plain text redacts image bodies
and truncates long messages.

Status is a one-shot, non-transactional observation. Use `wait` with the exact accepted chat and turn IDs when completion identity matters.

Submit an exact pending permission decision using every fence shown by status:

```bash
bun cli/main.ts --workspace default permission-decision 1785337200123456 \
  permission-occurrence-id allow \
  --run run-id --server-instance server-instance-id --json
```

Answer a structured question with the exact IDs shown by `status`:

```bash
bun cli/main.ts --workspace default permission-answer 1785337200123456 \
  permission-occurrence-id \
  --answers '[{"questionId":"question-id","selectedOptionIds":["option-id"]}]' \
  --run run-id --server-instance server-instance-id --json
```

`--answers` is a JSON array with one row per answered question. Each row has a
unique `questionId` and a `selectedOptionIds` array containing unique option
IDs. Use `permission-decision ... deny` to skip or decline the request.

The command never fetches or substitutes the newest request. Its deterministic
idempotency identity binds the server instance, chat, run, and occurrence while
the complete payload also binds the decision. Repeating the same decision
replays its retained outcome; attempting the opposite decision conflicts rather
than answering a newer request. Old controls fail closed after restart. Replay
and conflict protection apply while the bounded command record remains retained.
After an ambiguous provider failure and later record eviction, retry protection
is no longer guaranteed; inspect live permission status before another decision.
Provider acknowledgement failure is reported as an unknown outcome and is not
automatically redelivered while that record is retained.

## Chat Metadata

Set lifecycle and metadata to explicit desired values:

```bash
bun cli/main.ts archive 1785337200123456
bun cli/main.ts unarchive 1785337200123456
bun cli/main.ts pin 1785337200123456
bun cli/main.ts unpin 1785337200123456
bun cli/main.ts rename 1785337200123456 "Review complete"
bun cli/main.ts set-tags 1785337200123456 --tag review --tag complete
bun cli/main.ts set-tags 1785337200123456 --clear
```

These commands are desired-state setters, not wrappers around toggle routes.
Repeating one converges without reordering or emitting another change. Pin and
archive are mutually exclusive order groups. `set-tags` replaces the complete
normalized set, including the `cli` tag; `--clear` is the explicit empty set.
Each command supports `--json` and reports whether authoritative state changed.
Concurrent metadata writers use last-writer-wins semantics.

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

`resume-async` submits to an existing chat and returns as soon as Garcon accepts it. The turn stays visible and stoppable in the SPA and inherits the target chat's saved execution settings.

```bash
bun cli/main.ts --workspace default resume-async 1785337200123456 \
  "Implement the reviewed changes and run the focused tests."
```

If the target is busy, the command exits `3` without queueing or steering. Pass `--allow-steer` to deliver into the active turn instead. `--allow-steer` never queues:

```bash
bun cli/main.ts --workspace default resume-async 1785337200123456 \
  --allow-steer \
  --message-title "New blocker" \
  --message-style error \
  "Also update the migration test."
```

Successful output identifies `delivery: new-turn|steer` and the accepted turn
ID. `--json` emits one versioned envelope with the exact receipt, delivery,
parent relationship, server instance, and workspace. Garcon bounds run/steer
race retries and reports ambiguity rather than risking duplicate delivery.

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

`stop --json` emits one versioned envelope with the chat-scoped stop receipt,
authoritative outcome and execution-control state. It does not invent an
affected turn ID when the stop contract does not provide one.

If queued messages exist, stopping pauses the queue. Resume it in Garcon before sending a new direct turn. Ctrl-C only detaches the terminal and does not send Stop.

## Connection Rules

Discovery requires a server using a named workspace. Servers launched with `--workspace-dir` are intentionally undiscoverable. `--server` asserts the workspace descriptor's exact URL but cannot redirect credentials to another listener.

Run `bun cli/main.ts --help` for the complete command and option reference.
