# Google Antigravity Agent

Status: implemented, 2026-11-20. Garcon hosts Google's Antigravity CLI (`agy`) as the `antigravity` agent through the Agent Client Protocol (ACP). The behavior below was verified against `agy` 1.5.13 (linux_amd64, SHA-512 `014b3738...c68f`) driven by a scripted Gemini model during development.

Gemini models remain separately reachable without an agent through the `gemini` API-provider preset (`common/api-provider-templates.ts`). This document covers only the agent.

## Reference

[t3code](https://github.com/pingdotgg/t3code) ships an Antigravity driver at [be91767](https://github.com/pingdotgg/t3code/tree/be9176761ce2f6597013678b4538c772ae507400). Its findings that Garcon reuses are cited inline as `t3code:<path>:<line>`. Garcon does not copy its per-instance private profiles, managed CLI downloads, or quota scraping; see [Comparison With t3code](#comparison-with-t3code).

## Ownership

- `server-agents/common/src/acp/` owns the provider-neutral ACP client: the stdio JSON-RPC transport, the typed protocol subset, reconnect policy, and `AcpAgentRuntime`, which is shared by the Cursor and Antigravity integrations. Provider differences are expressed as an `AcpAgentPolicy` plus an `AcpEventConverter`.
- `server-agents/antigravity/` owns the Antigravity policy: launch and authentication, model discovery, mode mapping, tool normalization, executor-error detection, login, and one-shot queries.
- Core never branches on `antigravity`. The web layer adds only its label, provider color tokens, and its Settings card.

## Why ACP

agy 1.5.13 has three surfaces, and ACP is the only one that covers Garcon's needs.

| Capability | `agy acp` | `agy -p --input-format stream-json --output-format stream-json` | TUI |
| --- | --- | --- | --- |
| Permission requests | `session/request_permission` (Allow/Deny) | None: actions that need approval are soft-denied with a stderr notice | Interactive |
| Cancel | `session/cancel` | None documented; closing stdin ends the session after the turn | Interactive |
| Resume | `session/resume` | `--conversation <id>`, one process per session | `/resume` |
| Model and mode | `session/set_model`, `mode` config option | Process flags | Interactive |
| Mid-turn steering | A second `session/prompt` | Undocumented | `queuedMessages` setting |
| Fork / rewind | Absent (`session/fork` returns -32601; `/fork` is sent to the model as text) | Rejected: "/fork is not available in print mode" | `/fork` (alias `/branch`), `/rewind` (alias `/undo`) |

The engine implements `ForkConversation` (with a step index) and `RewindConversation` internally, but only the TUI exposes them. Garcon therefore forks Antigravity chats through its provider-neutral path: the fork seeds a new chat from the Garcon ledger, and the first turn carries that transcript as a prefix into a fresh agy session. Fork-at-message works the same way. What is lost compared with a native fork is agy's internal state (cached reads, plan state) rather than the conversation itself.

Native storage cannot back a file-level fork the way Claude's JSONL does:

- **`~/.gemini/antigravity-cli/conversations/<id>.db`** is the store agy resumes from. It is SQLite, with protobuf step payloads in `steps`, and it is also indexed outside the file. A copy under a new ID fails to resume with `trajectory not found`.
- **`brain/<id>/.system_generated/logs/transcript.jsonl`** and **`transcript_full.jsonl`** are derived step logs. They carry no tool-call IDs, and tool results are untyped `GENERIC` steps with no link to their call. They could support a lossy Reload, but they are not a resume source.

## Process And Transport

Each Garcon session owns one `agy acp` child process, started in the chat's project directory. The executor's ambient `PATH`, `HOME`, and Antigravity configuration apply, so the agent uses the same sign-in, settings, skills, and conversation store as the user's interactive `agy`. This matches how Claude, Codex, and Cursor use their native homes.

The binary resolves from `GARCON_ANTIGRAVITY_BINARY`, then `agy` on `PATH`. Garcon sets `AGY_CLI_DISABLE_AUTO_UPDATE=1` on its children so the CLI's background updater cannot replace a binary that running sessions use.

ACP calls:

| Call | Use |
| --- | --- |
| `initialize` | Protocol version 1 and no `fs`/`terminal` client capabilities, so the CLI reads and edits files itself and streams edits back as diffs. |
| `authenticate` | Always sent, with the configured method (see [Authentication](#authentication)). |
| `session/new` | Starts a chat. The result carries `models.availableModels`, `models.currentModelId`, and the `mode` config option. |
| `session/resume` | Reopens a session after process loss without replaying history (t3code:apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts:237). The CLI advertises `sessionCapabilities.resume`, so the shared reconnect order already prefers it. |
| `session/set_model` | Selects a model before a prompt when the request differs from the session's current model. |
| `session/set_config_option` (`mode`) | Applies the mapped permission mode before a prompt when it differs. |
| `session/prompt` | Text, plus inline base64 `image` blocks; `promptCapabilities.image` is true. |
| `session/cancel` | A notification, per the ACP specification. The open prompt resolves with `stopReason: "cancelled"`, so Antigravity aborts cooperatively and keeps its process. Cursor keeps `process-restart`. |

### Stop

A cooperative cancel settles only when the agent answers the open prompt. The next turn on that session waits for the cancelled prompt to settle before it sends a new `session/prompt`. Otherwise agy would treat the new prompt as a mid-turn steer. If the prompt has not settled after 10 s, the runtime retires the process, and the turn reconnects with `session/resume`. Content the agent streams between the cancel and its settlement belongs to the stopped turn and is published with it, because it is also in the agent's native history.

After a cancelled turn, agy merges the next user message into the unanswered one, so the model sees both prompts as one request.

### Executor Errors

Upstream model failures (invalid key, quota, HTTP 4xx/5xx) do not fail the ACP prompt. The CLI emits one complete `agent_message_chunk` whose text begins with `\n⚠ agent executor error: ` and then ends the turn normally with `end_turn`. The converter recognizes that chunk exactly, publishes it as an `ErrorMessage` instead of assistant text, and reports the turn as a provider failure. t3code reaches the same outcome by reading error steps from the CLI's SQLite store (t3code:apps/server/src/provider/acp/AntigravityTurnOutcome.ts:16-31). Garcon matches the wire marker instead, because the ledger, not native storage, is its serving authority.

## Authentication

The ACP auth method comes from `GARCON_ANTIGRAVITY_AUTH_METHOD` when it is set. Otherwise it is `gemini-api-key` when `GEMINI_API_KEY` is set, and `oauth-personal` when it is not. The accepted values are the CLI's advertised methods: `oauth-personal`, `oauth-business`, `gemini-api-key`, and `agent-platform`.

- **Google account (`oauth-personal`):** uses credentials the CLI cached from an interactive `agy` or `agy acp --login`. When none are cached, `authenticate` fails fast with the CLI's actionable "Run `agy acp --login`..." message, which surfaces as the run error.
- **In-app sign-in:** `auth.launchLogin` runs `agy acp --login` through the shared `CliLoginController` in `browser-code` mode, with `DISPLAY` and `WAYLAND_DISPLAY` removed so the CLI prints its Google link instead of opening a browser (t3code:apps/server/src/provider/Drivers/AntigravityDriver.ts:402-474). The user opens the link, then pastes the code or the final URL, which is written to the CLI's stdin. Exit code 0 means the credentials are stored. This works when the executor is headless or remote.
- **Credential storage:** the CLI stores Google sign-in in the OS keyring (Secret Service over D-Bus on Linux). On a headless executor without a running Secret Service, Antigravity's documented fix is to start a session bus (`export $(dbus-launch)`) before `agy` runs. The Docker image persists `~/.gemini` so CLI settings and history survive container recreation.
- **Gemini API key / Agent Platform:** the key and Google Cloud variables pass to the child through the inherited environment. Antigravity documents that `agy models` needs `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` for API-key accounts. Without that setting, model discovery returns no models and chats use the CLI's default model.

`auth.status` reports `GEMINI_API_KEY` as environment authentication. Otherwise it runs `agy models` with a 10 s timeout, the CLI's own signed-in check: exit 0 means authenticated, and anything else is reported with its stderr.

## Models And Modes

`agy models` prints `<id>\t<label>` lines such as `gemini-3.1-pro-high	Gemini 3.1 Pro (High)`. Each ID encodes the model and its thinking level, and the levels differ per model. Garcon therefore exposes these IDs directly as catalog models and declares no thinking modes. Discovery runs no session, so it leaves no empty conversation in the user's history. `session/set_model` accepts the same IDs and updates both the `model` and `thought_level` options.

Permission modes:

| Garcon | `mode` option | Approval handling |
| --- | --- | --- |
| `default` | `default` | Requests go to the user. |
| `acceptEdits` | `accept-edits` | Requests are auto-approved. |
| `plan` | `plan` | Requests go to the user. |
| `manualBypass`, `bypassPermissions` | `default` | Requests are auto-approved. |

Permission options are chosen by their ACP `kind` (`allow_once`, `allow_always`, `reject_once`, `reject_always`), not by option ID. Antigravity's option IDs are `allow` and `deny`. The shared runtime previously fell back to the first option when an ID was missing, which would have turned Deny into Allow.

## One-Shot Queries

`singleQuery` runs one prompt in a disposable session started in a temporary directory, using `default` mode. Every permission request is answered with the reject option, and an executor-error chunk fails the query. The CLI still records that session in its conversation store; Garcon does not delete native files.

## Tool Normalization

Tool calls carry the raw tool `name`, `kind`, `rawInput`, and on completion `rawOutput`, `content` (text or diffs), and `status`.

| Antigravity tool | Garcon message |
| --- | --- |
| `run_command` | `bash-tool-use` (`CommandLine`, `toolSummary`) |
| `read_file` | `read-tool-use` (`Path`, `StartLine`, `EndLine`) |
| `write_file` | `write-tool-use` (`Path`, `Content`) |
| `edit_file` | `edit-tool-use` (`Path`, `Target`, `Replacement`) |
| `search_web` | `web-search-tool-use` (`query`) |
| `invoke_subagent` | `task-tool-use` (`Role`/`TypeName`, `Prompt`, `Model`) |
| `ask_question`, `manage_task`, `send_message`, `schedule`, `define_subagent`, `manage_subagents`, `run_workflow`, `swarm` | `external-tool-use` with namespace `antigravity` |
| MCP calls (`rawInput.server` + `rawInput.tool`) | `mcp-tool-use` |
| Anything else | `unknown-tool-use` |

`ask_question` is not interactive over ACP without elicitation support. The CLI prints the question as assistant text and ends the turn, so the user answers in the next message.

## Testing

Antigravity is a best-effort provider like Cursor: unit coverage only, with no scripted-model tier.

- **Unit tests** (`server-agents/antigravity/src/**/__tests__`) cover configuration and auth-method selection, model parsing, mode mapping, and tool and result normalization. They also cover executor-error detection and the login environment. A runtime suite drives the shared ACP runtime against a fake agent that speaks agy's wire shapes. It covers agent-defined permission option IDs, cancellation (prompt, late, and ignored), in-band executor errors, and resume in a new process.
- **Shared ACP tests** in `server-agents/common/src/acp/__tests__` cover permission-option selection by kind and the cancel notification.
- **Manual verification** when bumping agy: agy honors `GOOGLE_GEMINI_BASE_URL` with the `gemini-api-key` auth method, so a local server that answers `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` can drive the real CLI without a Google account. Requests without tool declarations are auxiliary: title generation and web-search grounding. agy keeps a model-supplied `functionCall.id` as the ACP `toolCallId`. It rejects calls that miss required schema fields without emitting a tool call; for example, `run_command` requires `toolSummary` and `WaitMsBeforeAsync`. Its own rules auto-approve some commands, such as `touch`.

## Comparison With t3code

| Capability | t3code | Garcon |
| --- | --- | --- |
| Transport | ACP stdio, `session/resume` | Same |
| Google sign-in | `agy acp --login` code paste; loopback replay for `oauth-business` | Code paste for the default account; other methods via the CLI |
| API key / Vertex | Per-instance secret and settings file | Executor environment |
| Account isolation | Private `GEMINI_HOME` per provider instance | User's native `agy` home (one account per executor) |
| CLI install | Managed, checksummed download with version leases | User-installed `agy` on the executor |
| Models | `session/new` config options, probed per model for thinking levels | `agy models` flattened IDs |
| Permission modes | default, auto, plan via `/plan`; full access by policy | default, accept-edits, plan; bypass by policy |
| Steering mid-turn | Yes (second `session/prompt`) | No (queued as the next turn) |
| Images | Yes, plus audio, PDFs, and text resources | Images |
| Executor-error outcome | Native SQLite error steps | Wire marker |
| Subagent child-work tracking | From native `brain/` files | Tool row only |
| Usage limits / quota | OAuth quota API, token cost from native DBs | Not implemented |
| Text generation | Disposable ACP session | `singleQuery` via a disposable ACP session |

Gaps deliberately left for follow-up are steering, Reload from native history (`session/load` replay), quota reporting, and ACP elicitation for `ask_question`.
