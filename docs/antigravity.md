# Google Antigravity Agent

Status: implemented, 2026-11-20. Garcon hosts Google's Antigravity CLI (`agy`) as the `antigravity` agent through the Agent Client Protocol (ACP). The behavior below was verified against `agy` 1.5.13 (linux_amd64, SHA-512 `014b3738...c68f`) driven by a scripted Gemini model.

Gemini models remain separately reachable without an agent through the `gemini` API-provider preset (`common/api-provider-templates.ts`). This document covers only the agent.

## Reference

[t3code](https://github.com/pingdotgg/t3code) ships an Antigravity driver at [be91767](https://github.com/pingdotgg/t3code/tree/be9176761ce2f6597013678b4538c772ae507400). Its findings that Garcon reuses are cited inline as permalinks at that commit. Garcon does not copy its per-instance private profiles, managed CLI downloads, or quota scraping; see [Comparison With t3code](#comparison-with-t3code).

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
| Mid-turn steering | An overlapping `session/prompt` joins the running turn; see [Steering](#steering) | A second input line queued a separate turn in the held-model probe | `queuedMessages` setting |
| Fork / rewind | Absent (`session/fork` returns -32601; `/fork` is sent to the model as text) | Rejected: "/fork is not available in print mode" | `/fork` (alias `/branch`), `/rewind` (alias `/undo`) |

ACP defines an [optional native fork](https://github.com/agentclientprotocol/agent-client-protocol/blob/c9fef684e0ed6686a7b4aac6b9edb89f5187eed9/docs/rfds/session-fork.mdx#L45). The agy engine implements `ForkConversation` (with a step index) and `RewindConversation` internally, but only the TUI exposes them. Garcon therefore forks Antigravity chats through its provider-neutral path: the fork seeds a new chat from the Garcon ledger, and the first turn carries that transcript as a prefix into a fresh agy session. Fork-at-message works the same way. What is lost compared with a native fork is agy's internal state (cached reads, plan state) rather than the conversation itself.

Native storage cannot back a file-level fork the way Claude's JSONL does:

- **`~/.gemini/antigravity-cli/conversations/<id>.db`** is the store agy resumes from. It is SQLite, with protobuf step payloads in `steps`, and it is also indexed outside the file. A copy under a new ID fails to resume with `trajectory not found`.
- **`brain/<id>/.system_generated/logs/transcript.jsonl`** and **`transcript_full.jsonl`** are derived step logs. They carry no tool-call IDs, and tool results are untyped `GENERIC` steps with no link to their call. They could support a lossy Reload, but they are not a resume source.

## Process And Transport

Each Garcon session owns one `agy acp` child process, started in the chat's project directory. The executor's ambient `PATH`, `HOME`, and Antigravity configuration apply, so the agent uses the same sign-in, settings, skills, and conversation store as the user's interactive `agy`. This matches how Claude, Codex, and Cursor use their native homes.

The binary resolves from `GARCON_ANTIGRAVITY_BINARY`, then `agy` on `PATH`. Garcon sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` on its children so the CLI's background updater cannot replace a binary that running sessions use. agy accepts only `true`: with `1`, even `agy models` spawns the updater and replaces the binary (verified on 1.5.13, which updated itself to 1.5.14).

ACP calls:

| Call | Use |
| --- | --- |
| `initialize` | Protocol version 1 and no `fs`/`terminal` client capabilities, so the CLI reads and edits files itself and streams edits back as diffs. |
| `authenticate` | Depends on `initialize.authMethods` and the [configured method](#authentication). |
| `session/new` | Starts a chat. The result carries `models.availableModels`, `models.currentModelId`, and the `mode` config option. |
| `session/resume` | Reopens a session after process loss without replaying history ([t3code AntigravityAdapterV2.ts](https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L237)). The CLI advertises `sessionCapabilities.resume`, so the shared reconnect order already prefers it. |
| `session/set_model` | Selects a model before a prompt when the request differs from the session's current model. |
| `session/set_config_option` (`mode`) | Sets the mapped permission mode before every prompt and checks the mode in the reply. A missing or different mode stops the prompt. The agent can change its own mode, so a cached value is not confirmation. |
| `session/prompt` | Text, plus inline base64 `image` blocks; `promptCapabilities.image` is true. |
| `session/cancel` | A notification, per the ACP specification. The open prompt resolves with `stopReason: "cancelled"`, so Antigravity aborts cooperatively and keeps its process. Cursor keeps `process-restart`. |

The prompt RPC determines the turn outcome. Closing stdout fails unanswered requests, but does not undo a final reply. Closing stderr alone has no effect on the turn. After transport loss, the next turn resumes the same native session on a new process and sends only its own input; Garcon does not retry the previous prompt.

### Stop

A cooperative cancel settles only when the agent answers the open prompt. The next turn on that session waits for the cancelled prompt to settle before it sends a new `session/prompt`, so the two prompts never overlap. If the prompt has not settled after 10 s, the runtime retires the process, and the turn reconnects with `session/resume`. Content the agent streams between the cancel and its settlement belongs to the stopped turn and is published with it, because it is also in the agent's native history.

Stop works the same way while a turn is still being configured (model and mode are applied before the prompt). The turn is reserved from admission, so that window counts as busy, and an abort there ends the turn before its prompt is sent. A follow-up that is waiting on a stopped turn gives up as soon as its own admission closes.

After a cancelled turn, agy merges the next user message into the unanswered one, so the model sees both prompts as one request.

### Steering

agy folds a `session/prompt` sent during a running turn into that turn. Held-model probes against 1.5.13 established:

- The open prompt settles with `end_turn` as soon as the new one arrives. That reply carries no `usage`, unlike a turn that finished on its own.
- The turn keeps running. Its next model request carries the new input after the current step: after the pending tool result, or after the reply being streamed when there is no tool call.
- The new prompt settles when the combined turn ends, with the turn's `usage`. A further prompt supersedes it the same way, and `session/cancel` settles the latest prompt with `cancelled`.
- A prompt sent before the first model request is merged into that request.
- While the turn waits for a permission or question answer, agy refuses the new prompt with JSON-RPC `-32603` ("answer it or send session/cancel, then send this prompt again"). The open prompt keeps running.

The shared ACP runtime enables this through the policy's `steersWithOverlappingPrompts`; Cursor leaves it off. A steer is a text-only `session/prompt` on the running session, and a Garcon run ends only when none of its prompts is open. The agent settling a prompt the steer supersedes accepts the steer. An error on the steer's prompt while a superseded prompt still runs is a refusal, reported as `provider-rejected`, and does not count as the run's outcome. If neither happens within 15 s, or the transport fails, the outcome is unknown, and the run still waits for the steer's prompt. Steers on one turn run one at a time, each from its checks to the agent's decision, and a steer in flight holds its turn open: if the turn's prompt settles while a recorded steer is still being prepared, the steer is sent anyway and the agent runs it as the next prompt of the same run. A turn offers no steering target while it waits for a permission answer, and reports itself steerable again once the answer is sent, so a pending steer is delivered then.

A chat's project path cannot change. agy keeps the working directory recorded with the conversation and ignores the `cwd` that `session/resume` passes, even in a new process started in the new directory, so a moved chat would keep reading and editing the old one. The descriptor therefore declares `supportsProjectPathUpdate: false`, and the scripted tier asserts that Garcon refuses the move.

### Message And Thought Text

agy relays the model's thought and text parts in the order the model streams them, so `agent_thought_chunk` updates can fall between the `agent_message_chunk` updates of a single answer. The converter keeps the answer in one buffer until a tool frame or the end of the turn, so each segment has at most one assistant row. Thinking that precedes the answer is published when the answer starts; thinking that arrives within the answer is held and published ahead of it. Publishing at every switch between thought and text made each chunk its own row, and Markdown that spans a chunk boundary rendered broken ([#1060](https://github.com/cfal/garcon/issues/1060)).

### Executor Errors

Upstream model failures (invalid key, quota, HTTP 4xx/5xx) do not fail the ACP prompt. The CLI emits one complete `agent_message_chunk` whose text begins with `\n⚠ agent executor error: ` and then ends the turn normally with `end_turn`. The converter treats the marker as a failure only when two things hold:

- It opens the chunk or is the chunk's last line.
- It is the turn's final output.

Any later message, thought, or tool call means the chunk was ordinary text that quoted the marker. A recognized failure is published as an `ErrorMessage` instead of assistant text, and the turn is reported as a provider failure. t3code reaches the same outcome by reading error steps from the CLI's SQLite store ([t3code AntigravityTurnOutcome.ts](https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L16-L31)). Garcon matches the wire marker instead, because the ledger, not native storage, is its serving authority.

## Authentication

The ACP auth method comes from `GARCON_ANTIGRAVITY_AUTH_METHOD` when it is set. Otherwise it is `gemini-api-key` when `GEMINI_API_KEY` is set, and `oauth-personal` when it is not. The accepted values are the CLI's advertised methods: `oauth-personal`, `oauth-business`, `gemini-api-key`, and `agent-platform`. An executor without an executable `agy` is not ready, even if it has a Gemini API key. The controller Compose service forwards both variables; workers take them from their executor environment file.

If `initialize` omits `authMethods` or lists the configured method, Garcon sends that method. A nonempty list without it fails the handshake; Garcon never substitutes another method. An explicit `[]` skips `authenticate` without confirming sign-in. Opening or resuming the session can still fail.

- **Google account (`oauth-personal`):** uses credentials the CLI cached from an interactive `agy` or `agy acp --login`. When none are cached on a headless executor, `authenticate` fails fast with the CLI's actionable "Run `agy acp --login`..." message, which surfaces as the run error. With a display, agy may open its browser sign-in instead, and the turn waits for it within the ACP request timeout. Sessions keep the display because commands the agent runs inherit its environment; only the status probe and the in-app sign-in drop it.
- **In-app sign-in:** `auth.launchLogin` runs `agy acp --login` through the shared `CliLoginController` in `browser-code` mode, with `DISPLAY` and `WAYLAND_DISPLAY` removed so the CLI prints its Google link instead of opening a browser ([t3code AntigravityDriver.ts](https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/apps/server/src/provider/Drivers/AntigravityDriver.ts#L402-L474)). The user opens the link, then pastes the code or the final URL, which is written to the CLI's stdin. Exit code 0 means the credentials are stored. This works when the executor is headless or remote, and was verified on Linux. A macOS executor may also open its own browser, since removing the display variables does not stop LaunchServices; the printed link and code still complete the sign-in. While a sign-in is running, auth status does not probe the CLI. It repeats the last probed status, or "Sign-in in progress" if there is none.
- **Credential storage:** the CLI stores Google sign-in in the OS keyring (Secret Service over D-Bus on Linux). On a headless executor without a running Secret Service, Antigravity's documented fix is to start a session bus (`export $(dbus-launch)`) before `agy` runs. The Docker image persists `~/.gemini` so CLI settings and history survive container recreation.
- **Gemini API key / Agent Platform:** Garcon drops any `GEMINI_API_KEY` the process inherited and passes the key from the integration's environment reader, only under the `gemini-api-key` method, so no other method can succeed on a stray key. Google Cloud variables pass through unchanged for `agent-platform`. Antigravity documents that `agy models` needs `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` for API-key accounts. Without that setting, model discovery returns no models and chats use the CLI's default model.

`auth.status` checks sign-in without opening a session:

- **API key:** `agy --version` confirms the CLI can run, not that Google accepts the key.
- **OAuth and Agent Platform on Linux:** the probe uses the session's ACP handshake without a display. When authentication is skipped, status is unknown and Garcon does not offer in-app sign-in.
- **OAuth and Agent Platform on macOS:** agy can open a browser even without display variables, so status uses the noninteractive `agy models` check. It cannot distinguish among cached credentials and does not affect the session handshake.

Closing Settings does not stop sign-in, even while the worker is still launching the CLI. Reopening Settings restores the current browser owner's sign-in without reopening its browser link; after a page reload, use Sign in to reattach to an active CLI login.

Once credentials are confirmed, Garcon requests a fresh catalog from that worker. A successful empty model list offers Default. A missing executable or invalid provider configuration instead removes that provider's native models, leaving healthy providers selectable. A transient native listing failure leaves the refresh pending for the next use, subject to the normal throttle. If reconnecting invalidated the prior catalog, an ordinary listing from the same worker restores usable models without claiming that native discovery succeeded. A replacement worker cannot confirm the old sign-in or validate its cached catalog.

Agent Platform requires a project, location, and Application Default Credentials. Compose forwards `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, but not a host credentials path. To use a credentials file, add its mount and its **container** path together in a Compose override:

```yaml
services:
  garcon:
    volumes:
      - ${HOME}/.config/gcloud/application_default_credentials.json:/run/secrets/google-adc.json:ro
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/google-adc.json
```

For a standalone worker, put the project, location, and container credential path in `executor.env` and add the same read-only mount to the `executor` service in a `docker-compose.executor.yml` override.

## Models And Modes

`agy models` prints `<id>\t<label>` lines such as `gemini-3.1-pro-high	Gemini 3.1 Pro (High)`. Each ID encodes the model and its thinking level, and the levels differ per model. Garcon therefore exposes these IDs directly as catalog models and declares no thinking modes. Discovery runs no session, so it leaves no empty conversation in the user's history. `session/set_model` accepts the same IDs and updates both the `model` and `thought_level` options.

When the executor can launch agy with the configured authentication method, the first catalog entry is **Default** (`default`), even when `agy models` exits unsuccessfully or returns no IDs. A missing or unlaunchable binary, or an invalid method, leaves no selectable models. A new chat without a model override uses the native default, not the first model printed by `agy models`. On an existing chat, omitting the override keeps the saved selection; explicitly select **Default** to return to the native default learned for that project. A resumed session reports only its current model. When no default has been learned for the project since executor startup, Default keeps the current model rather than opening an empty conversation to discover another one.

Permission modes:

| Garcon | `mode` option | Approval handling |
| --- | --- | --- |
| `default` | `default` | Requests go to the user. |
| `acceptEdits` | `accept-edits` | agy approves edits itself; the requests it still sends, such as commands, go to the user. |
| `plan` | `plan` | Requests go to the user. |
| `manualBypass`, `bypassPermissions` | `default` | Requests are auto-approved. |

Once the provider has admitted a bound turn, explicitly saving a permission mode applies it to Garcon's approval decisions at once, even if the saved mode already has that value and only the turn overrides it. Saving an unrelated setting leaves the override intact. While Garcon is preparing a turn or waiting for the provider to admit it, an explicit permission save returns a retryable conflict, even if a previous turn established a session ID. agy's native mode (`accept-edits`, `plan`) changes only with the next turn's `session/set_config_option`, so switching from accept-edits to default mid-turn still lets agy approve the rest of that turn's edits itself.

The shared runtime chooses permission options by their ACP `kind` (`allow_once`, `allow_always`, `reject_once`, `reject_always`), not by option ID. Antigravity's option IDs are `allow` and `deny`. The runtime used to fall back to the first option when an ID was missing, which would have turned Deny into Allow.

The selection rules:

- A one-time choice never falls back to a persistent grant or a persistent deny rule. When nothing safe matches, the runtime answers `cancelled`.
- Untyped options match conventional IDs (`allow`, `deny`, `allow-once`, `reject-once`), never a typed option of another kind.
- Auto-approval is Garcon's policy for the turn, so bypass modes answer with the one-time option. They take a persistent grant only when the agent offers nothing else, because bypass means the tool runs.
- After Stop, any permission request that arrives before the cancelled prompt settles is answered `cancelled`.

## One-Shot Queries

Antigravity is not a default generation agent (`generation: null`, like Cursor), because every one-shot session stays in the user's agy conversation history. When a caller does pick it, `singleQuery` runs one prompt in a disposable session started in a temporary directory, in `plan` mode. In `plan` mode agy asks before running even the commands its own rules would otherwise auto-approve; verified against 1.5.13 with `touch`. Every permission request is answered with the reject option, and an executor-error chunk fails the query. The CLI still records that session in its conversation store; Garcon does not delete native files.

## Tool Normalization

Tool updates are correlated by call ID. A terminal update can carry just a status, without output text.

For `run_command`, ACP `completed` means the invocation finished, not that the command succeeded. A nonzero `rawOutput.exit_code` marks the tool result as an error; the enclosing agent turn may still finish normally.

| Antigravity tool | Garcon message |
| --- | --- |
| `run_command` | `bash-tool-use` (`CommandLine`, `toolSummary`) |
| `read_file`, `view_file` | `read-tool-use` (`Path`/`AbsolutePath`, `StartLine`, `EndLine`) |
| `write_file`, `write_to_file` | `write-tool-use` (`Path`/`TargetFile`, `Content`/`CodeContent`) |
| `edit_file`, `replace_file_content`, `multi_replace_file_content` | `edit-tool-use` (`Path`/`TargetFile`, `Target`/`TargetContent`, `Replacement`/`ReplacementContent`) |
| `grep_search`, `find_by_name`, `list_dir` | `grep-tool-use`, `glob-tool-use`, `list-tool-use` |
| `read_url_content` | `web-fetch-tool-use` (`Url`) |
| `search_web` | `web-search-tool-use` (`query`) |
| `invoke_subagent` | `task-tool-use` (`Role`/`TypeName`, `Prompt`, `Model`) |
| `manage_task` | `background-task-tool-use`: list tasks, check status, request stop (`kill`), or send input to a task |
| `update_steps` (also identified by the native title `Run update_steps`) | `update-plan-tool-use`: step titles and statuses; `done` becomes `completed`, while `skipped` and `failed` remain distinct |
| `send_message` | `agent-message-tool-use`: recipient and literal message body |
| MCP calls (`rawInput.server` + `rawInput.tool`) | `mcp-tool-use` |
| Any other named agy tool, such as `ask_question` or `run_workflow` | `external-tool-use` with namespace `antigravity` |
| A call without an identifiable tool | `unknown-tool-use` |

A background task row describes an operation, not the state of the task. For example, a successful `kill` call is not proof that the process exited. When ACP supplies no output, Garcon does not reconstruct it from native history. Previously stored rows retain their original representation.

ACP can split a call's name, arguments, and result across frames. Garcon correlates them by call ID and settles the result with the terminal status. An unresolved call can wait across buffered text and other incomplete calls. It publishes with the available evidence before a later tool row or result, at turn end, or at the pending-call limit. An interactive approval releases calls older than the requested call, leaving its own identity open to later evidence. Automatic approvals do not force publication. A stderr diagnostic releases pending calls but does not split a streamed answer. Published rows are not revised. An MCP marker or MCP envelope takes precedence over a native tool label.

`ask_question` is not interactive over ACP without elicitation support. The CLI prints the question as assistant text and ends the turn, so the user answers in the next message.

## Testing

- **Unit tests** (`server-agents/antigravity/src/**/__tests__`) cover configuration and auth-method selection, model parsing, mode mapping, and tool and result normalization. They also cover executor-error detection and the login environment. A runtime suite drives the shared ACP runtime against a fake agent that speaks agy's wire shapes. It covers agent-defined permission option IDs, cancellation (prompt, late, and ignored), in-band executor errors, resume in a new process, and steering acceptance, refusal, and the permission-answer gate.
- **Shared ACP tests** in `server-agents/common/src/acp/__tests__` cover authentication-method negotiation, permission-option selection by kind, and the cancel notification.
- **Web tests** cover executor-scoped auth diagnostics, submitting a sign-in code, catalog refresh after Settings closes, and selecting Default or a discovered model in New Chat.
- **Scripted-model tier** (`integration-tests/tests/server/antigravity-scripted-model.test.ts`) runs the real pinned `agy` behind `FakeGeminiModel`, the Gemini sibling of `FakeClaudeModel` and `FakeCodexModel`, in all three execution lanes with an isolated `HOME`. agy honors `GOOGLE_GEMINI_BASE_URL` with the `gemini-api-key` auth method and streams `POST /v1beta/models/<model>:streamGenerateContent?alt=sse`. Requests without tool declarations are auxiliary (title generation, web-search grounding) and get a canned reply outside the script. The suite covers catalog discovery, command approval and denial, file edits in accept-edits mode, and model switching on resume. It also covers Stop, upstream API errors, resume after a server restart, and the refused project path update.
  - agy keeps a model-supplied `functionCall.id` as the ACP `toolCallId`, so tool IDs are deterministic.
  - Task listing, checking an absent task, and messaging an absent recipient verify use/result pairing, including empty successes and failures. The pinned Gemini API-key fixture does not advertise `update_steps`; synthetic ACP frames exercise checklist normalization and sparse updates.
  - With no discovered models, the suite starts a chat with the catalog's Default and checks the actual Gemini model and thinking budget. While a turn is held, a queued image must arrive only in the next turn.
  - A nonzero command exit fails the tool, not the turn. A rejected model request fails that turn, not the next one. A disposable title query must not execute a requested command or publish its tool or reply to the chat. Stop must abort the held model request and retain the same agy process for the follow-up.
  - Scripted calls must satisfy agy's tool schema; for example, `run_command` requires `toolSummary` and `WaitMsBeforeAsync`. Otherwise the CLI rejects them without emitting a tool call. agy's own rules also auto-approve some commands, such as `touch`.
  - The shared scripted steering conformance suite (`scripted-steering-conformance.test.ts`) runs the same binary: queued guidance becomes same-turn input exactly once, and accepted guidance survives Stop.
  - `antigravity-scripted-steer.test.ts` matches the Claude and Codex steering guarantees: concurrent steers reach the running turn in committed ledger order, and a steer sent while a command awaits approval waits in the queue and joins the same turn once the command is approved.
  - `ANTIGRAVITY_BIN` supplies the binary. `scripts/install-antigravity-cli.ts` downloads the pinned version and verifies its SHA-512, and CI caches it as it does Lightpanda. When `ANTIGRAVITY_BIN` is unset, the real-CLI scenarios are skipped; synthetic discovery-failure cases still run.
- **Server agent compatibility suite** (`integration-tests/tests/sacs`) registers an Antigravity driver on the same binary and fake model whenever `ANTIGRAVITY_BIN` is set. It exercises transcript lifecycle, interrupt, restart and remote disconnect, plus a handoff fork that submits exactly the selected transcript prefix to a fresh native session. Its steering facet runs the shared commit-before-delivery case. The driver has no history-import or native-forking facets.

## Comparison With t3code

| Capability | t3code | Garcon |
| --- | --- | --- |
| Transport | ACP stdio, `session/resume` | Same |
| Google sign-in | `agy acp --login` code paste; loopback replay for `oauth-business` | Code paste for the default account; other methods via the CLI |
| API key / Vertex | Per-instance secret and settings file | Executor environment |
| Account isolation | Private `GEMINI_HOME` per provider instance | User's native `agy` home (one account per executor) |
| CLI install | Managed, checksummed download with version leases | User-installed `agy` on the executor; pinned download for tests |
| Models | `session/new` config options, probed per model for thinking levels | `agy models` flattened IDs |
| Permission modes | default, auto, plan via `/plan`; full access by policy | default, accept-edits, plan; bypass by policy |
| Steering mid-turn | Yes (second `session/prompt`) | Same |
| Images | Yes, plus audio, PDFs, and text resources | Images |
| Executor-error outcome | Native SQLite error steps | Wire marker |
| Subagent child-work tracking | From native `brain/` files | Tool row only |
| Usage limits / quota | OAuth quota API, token cost from native DBs | Not implemented |
| Text generation | Disposable ACP session | `singleQuery` via a disposable ACP session |

Gaps deliberately left for follow-up are Reload from native history (`session/load` replay), quota reporting, and ACP elicitation for `ask_question`.

