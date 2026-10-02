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
- `GARCON_PUBLIC_URL` / `--public-url`: external HTTP(S) base URL for executor onboarding, including any proxy path prefix.
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

Explicit flags take precedence over environment variables; nonempty environment values take precedence over defaults. The controller, executor, and CLI share `--config-dir` / `GARCON_CONFIG_DIR`, defaulting to `~/.garcon`. Relative roots are resolved from the process's working directory. Workspace options configure controller storage only, not CLI discovery or executor storage.

## Executor Connections

Set `--public-url https://controller.example.com/garcon/` or `GARCON_PUBLIC_URL`
on a proxied controller. The flag wins; the base path is retained when generating
`wss://controller.example.com/garcon/executor/<id>`. Without configuration, the
authenticated management request's validated `Host` and actual HTTP(S) scheme
provide a best-effort suggestion. Forwarded headers are not used. This cannot
infer external TLS termination or proxy path rewriting: configure those explicitly.
An executor's manually saved full URL overrides the generated default. No example
URL is generated, and Copy is disabled for unusable addresses or WS without the
explicit no-TLS opt-in. Changing the public base does not rotate executor secrets.
TLS-policy edits preserve the inherited public URL. In connection PATCH requests,
omit `connectionUrl` to retain the current address and secret; an explicit URL
sets an override. Changing direction requires an explicit URL.

Add executors from the Executors dialog or the CLI management commands below.
For an executor that connects to the
controller, supply the complete generated URL through `GARCON_CONTROLLER_URL`.
Use a private service environment file or secret manager, not a literal assignment
in shell history. For example, read a mode-0600 file into the environment:

```bash
GARCON_CONTROLLER_URL="$(cat /private/controller-connection-url)" \
bun server/main.ts executor \
  --config-dir "$HOME/.garcon" --project-base-dir /path/to/repos
```

The value is a `wss://...#secret=...` URL. `--connect` is no longer accepted.
The worker consumes the variable before runtime startup and excludes its value
from provider and PTY child environments. PTYs explicitly receive an empty
variable because their native launcher inherits variables omitted from its
environment overrides. The initial environment can still be inspected by
privileged processes or retained by diagnostics.

For a controller that connects to a worker, start a TLS listener:

```bash
bun server/main.ts executor --listen 19781 --bind-address 0.0.0.0 \
  --tls-cert /private/fullchain.pem --tls-private-key /private/key.pem \
  --config-dir "$HOME/.garcon" \
  --project-base-dir /path/to/repos
```

Alternatively, use `--no-tls` instead of both TLS flags behind an access-controlled
TLS proxy, or on a trusted private network. Never combine the modes. Incomplete,
unreadable, invalid, or mismatched certificate/key pairs fail startup. Certificates
are loaded at startup; restart the worker to load renewed files.

`--advertise-url wss://worker.example.com/executor` sets the complete public endpoint;
it overrides `GARCON_EXECUTOR_ADVERTISE_URL` and does not change listener TLS.
Proxy paths and queries are preserved. Routine startup output contains no secret.
Reveal the existing listener credential explicitly, then paste it into the editor:

```bash
bun server/main.ts executor connection-url --config-dir "$HOME/.garcon" \
  --advertise-url wss://worker.example.com/executor
```

This command neither starts a worker nor creates or rotates a credential. Its
stdout is sensitive. Replace wildcard bind addresses with a reachable hostname.
A `ws:` reveal URL requires `--no-tls`; a dialing worker likewise needs `--no-tls`
for a `ws:` controller URL, and rejects that flag with a `wss:` controller URL.

One controller and one executor may run simultaneously under the same config root. Each role holds its own lease; two controllers or two workers cannot share the same role's storage. Controller workspace data and worker data stay separate, so switching roles does not overwrite either. Worker credentials and provider data live under `<config-dir>/executor`; this directory is reserved for executor storage, not a controller workspace. Use separate roots for independent workers. Existing default worker storage is unchanged. Replace an old `--workspace-dir /root/executor` with `--config-dir /root`, not `--config-dir /root/executor`. For a custom data directory, move its contents under the new root's `executor` directory while the worker is stopped.

Enable **Allow workspace CLI access** for the executor in the controller's editor. Then an ordinary shell on that worker can use the same root, without a runtime UUID:

```bash
GARCON_CONFIG_DIR="$HOME/.garcon" bun cli/main.ts list agents
# Explicit flags override the environment:
bun cli/main.ts --config-dir "$HOME/.garcon" --runtime executor list agents
```

**Allow executor management via CLI** is a separate, default-off grant. It is
effective only while workspace CLI access is also enabled. It trusts the worker
OS account with executor configuration, connection credentials, access grants,
and assignment of existing provider profiles to Local or other executors.
Disabling either grant cancels the old CLI authorization lease without stopping
the worker or its running agents. Provider credentials already disclosed to a
worker cannot be recalled by revoking an assignment.

Worker-launched terminals and provider subprocesses inherit the config root and `GARCON_RUNTIME=executor`. Ordinary shells default to automatic selection, described below. Access grants are workspace-wide, including permission decisions and agent execution on other hosts. Provider sandboxes may independently block loopback HTTP.

Every executor connection requires [Noise NNpsk0 encryption](https://github.com/cfal/noise-ws/tree/536eb503e81a1f9d90436006d3821e2080630488), on both `ws:` and `wss:`. Each physical reconnect negotiates fresh keys before the existing authenticated Garcon session resumes. There is no plaintext fallback. Upgrade the controller and all workers together. The pinned library is new and unaudited; vector, interoperability, and integration tests are not a security audit. Bun 1.4.2 or later is required.

Remote executors use two sockets to the identical configured URL: primary control
and subordinate bulk traffic. Proxies must allow both concurrent upgrades. Bulk
loss does not stop native turns or mark a healthy primary offline. The executor
list's `BULK` column and detail panel report bulk separately. Files content, most
Git operations, history import, and large CLI operations wait up to 20 seconds
for bulk within their existing deadline; they never fall back to Local or primary.
CLI context, turn receipts, Stop, and permission decisions stay on primary with
a 64 KiB encoded RPC cap. Other forwarded operations retain their 1 MiB request
and 8 MiB reply limits. An undeliverable mutation reply remains an unknown
outcome, not permission to retry. See [Executor Transport](./executor/transport.md).

WSS certificate verification is enabled by default. **Allow unverified TLS certificates** in an outbound executor's editor, or `--allow-unverified-tls` on a dialing worker, explicitly disables only outer certificate verification. Noise still requires the shared secret. Optional certificate pinning is deferred pending [Bun issue 43635](https://github.com/oven-sh/bun/issues/43635). Non-TLS connections require the separate **Allow connection without TLS** checkbox or `--no-tls` flag. HTTP metadata and traffic timing remain visible without outer TLS; Noise protects the execution payload, not the browser UI or other HTTP routes.

Upgrade controller and workers together. Executor configuration and management
payloads now use `noTls`, replacing `allowInsecureDevelopment`; stored executor
entries must use the new field before startup. The old startup flags are rejected,
not treated as aliases. General controller HTTP TLS configuration is unchanged.

Connection URLs are credentials. Their `#secret` fragment is removed before dialing the execution endpoint, never sent in the upgrade's HTTP headers, query, or WebSocket subprotocol. The authenticated management API still carries full descriptors; protect browser-to-controller access with HTTPS or a trusted private network. Keep the URL private: clipboard contents, shell history, process arguments, and captured onboarding output can expose it locally. Stored listener credentials and controller executor configuration require private file permissions. Use an independent random 32-byte secret for every executor; human-chosen passwords are not supported. For compromise, contain network access and revoke workspace CLI access first. Disabling an executor or changing its connection requires idle work; stop native work when necessary, then disable it and replace its credential on both endpoints before reconnecting. See [credential revocation](./security.md#connection-credentials-and-revocation). Routine connection diagnostics and executor-list responses omit credentials.

## Executor Management

`garcon-cli executor` configures the running controller. It does not install or
start worker processes; `garcon executor` with `GARCON_CONTROLLER_URL` or
`--listen` still does that.
Every command works through direct controller HTTP and an authorized executor
gateway. Keep the same explicit `--config-dir` and `--runtime` selectors when
following up on a mutation.

```bash
bun cli/main.ts executor list --json
bun cli/main.ts executor create --label 'Build machine' --direction executor-connects \
  --advertise-url 'wss://controller.example.com/executor/{executorId}' --json
bun cli/main.ts executor connection <executor-id> --output ./worker-connection.txt
bun cli/main.ts executor create --label 'Listening worker' --direction controller-connects \
  --connection-url - < ./listener-connection.txt
bun cli/main.ts executor update <executor-id> --allow-controller-cli true --allow-executor-management true
bun cli/main.ts executor wait <executor-id> --ready --timeout 60 --json
bun cli/main.ts executor providers --json
bun cli/main.ts executor assign-provider <executor-id> --provider existing-profile
bun cli/main.ts executor unassign-provider <executor-id> --provider existing-profile
bun cli/main.ts executor disable <executor-id>
bun cli/main.ts executor enable <executor-id>
bun cli/main.ts executor delete <executor-id>
```

Executor IDs are UUIDs; labels are not selectors. New labels and renames must be
unique, ignoring case and surrounding whitespace, including disabled executors;
`Local` is reserved. Existing duplicates remain readable and can be renamed.
`show`, `wait`, and provider
assignments also accept `local`. Provider assignment uses an exact existing
profile ID; it does not create profiles, accept API keys, or change native login.
The `providers` management listing shows all existing profiles and their assigned
executor IDs, unlike the executor-scoped execution catalog from `list providers`.

Inbound creation inherits the controller's public URL by default. An optional
`--advertise-url` supplies a reachable, secret-free per-executor override; the
literal `{executorId}` is expanded atomically before saving, preserving arbitrary
proxy paths and query strings. Generated URLs are not saved. Direct HTTP requests
can fall back to their Host as a suggestion, which may be loopback for a local CLI.
Forwarded CLI requests have no public Host: without an explicit override they
require `GARCON_PUBLIC_URL` / `--public-url` on the controller, for both creation
and `connection` reveal. Otherwise they fail with a configuration error rather
than returning a synthetic address. Outbound creation takes the listening worker's
full credential URL. Creation returns only the new ID. Saving configuration does
not claim the worker is ready; use the bounded readiness wait separately.

`update` accepts a label or either access grant. Connection edits require a full
`--connection-url`, `--direction`, and explicit `--no-tls
true|false`. `--allow-unverified-tls true|false` applies only to outbound TLS.
Neither TLS opt-out disables Noise authentication. Changing an active executor's
connector or deleting it can fail with an in-use conflict; no command force-stops
work. Deletion leaves saved references unavailable and does not delete worker data.

Connection URLs are secrets. `connection` explicitly reveals one; `--output`
writes a new private file atomically and refuses overwrite. `--connection-url -`
accepts one bounded UTF-8 URL from stdin so it need not appear in process arguments.
Avoid recording reveal output in agent transcripts. Ordinary list/create/update
output omits credentials. Provider assignment may disclose a profile's credentials
to subsequent execution on the target; removing it does not recall disclosed keys.

Remote callers need ordinary workspace CLI access for redacted executor listing,
and the separate management grant for administrative operations and the global
provider assignment list. A caller may rename its own executor, but must use the
controller or another authorized executor to change its own grants/connection,
disable it, or delete it. New workers cannot bootstrap their own grants.

Mutation requests are not retried automatically. A timeout, interrupted CLI,
invalid reply, or server error after dispatch can mean the save succeeded.
Definitive validation and pre-dispatch rejections retain their original errors.
Inspect executors/provider assignments
before retrying, especially creation, which generates a new UUID for each request.
`--json` emits one JSON result; diagnostics go to stderr. Ctrl-C exits 130 without
claiming rollback. An offline target remains configurable through a healthy origin.

## Execution Targets

`--executor local|<uuid>` selects where a new chat runs. It also scopes `list`
catalogs (except workspace-wide preambles) and `lookup-native-session`. Omission
preserves the authenticated origin's default: Local through the controller,
or the originating executor through its gateway. Selection requires ordinary
workspace CLI access, not the administrative management grant.

```bash
bun cli/main.ts executor list --json
bun cli/main.ts list models --executor <executor-id> --agent codex --json
bun cli/main.ts start-async --executor <executor-id> --cwd /srv/project \
  --agent codex --model <model-id> 'Review the changes'
bun cli/main.ts --runtime executor start --executor local --cwd /srv/controller-project \
  --agent codex --model <model-id> 'Review the controller project'
bun cli/main.ts lookup-native-session <native-session-id> --executor <executor-id>
```

`--runtime` selects the authenticated origin; `--executor` never changes that
connection or its authority. Model/provider resolution and chat creation use the
same selected target. Unknown or unavailable targets fail without falling back
to another executor.

Cross-executor starts require an explicit absolute `--cwd` on the target machine.
The CLI sends it unchanged, including Windows drive/UNC paths; it does not expand
`~`, normalize remote paths, or check them against the CLI machine's filesystem.
The target validates its own filesystem boundary. Same-origin starts retain local
directory validation and canonicalization, including when `--executor` is explicit.

`resume`, `resume-async`, `fork`, and all other existing-chat commands retain the
chat's saved executor and reject `--executor`. Target selection does not move chats.

## Tickets

Tickets belong to the selected Garcon workspace, independently of chats and Git. All commands use the authenticated server API; the CLI never opens the ticket database or starts an agent.

```bash
bun cli/main.ts ticket create --title 'Preserve failed-save drafts' --cwd /path/to/worktree
bun cli/main.ts ticket create --title 'Release checklist' --project 'September release' --priority 1
bun cli/main.ts ticket list --ready --json
bun cli/main.ts ticket read G-42
bun cli/main.ts ticket update G-42 --expected-revision 1 --patch '{"status":"in-review","labels":["ui"]}'
bun cli/main.ts ticket claim G-42 --expected-revision 2 --from-chat 1000000000000001
bun cli/main.ts ticket comment G-42 --stdin
bun cli/main.ts ticket history G-42 --limit 20
bun cli/main.ts ticket close G-42 --expected-revision 3 --resolution done --comment 'Verified through the API.'
```

`project` is an arbitrary, editable string, not a directory capability. New creates resolve an omitted project from `--cwd` or the process directory. Normal Git worktrees share the primary repository path; non-Git contexts use their canonical folder. If Git fails or cannot identify the primary checkout, the default is the canonical `--cwd` or process directory. An explicit `--project` bypasses filesystem lookup. Lists default to all projects and nonclosed tickets, not the process directory. Use `--include-closed` or an explicit `--status closed` to include closed work.

Priorities are `0` Urgent, `1` High, `2` Normal (default), and `3` Low. Create accepts repeatable `--label`, `--assignee chat:<id>|user:<username>|unassigned`, and `--parent-id G-n`. User assignment is limited to the current authenticated user. Update accepts a JSON patch containing title, description, project, nonclosed status, priority, labels, assignee, or parentId; use JSON null to clear assignee/parent. Only `close` and `reopen` transition into/out of Closed.

Read the current revision before a field or workflow mutation. Comment append does not need a ticket revision and does not advance it. Claim atomically assigns the caller (or declared chat) and moves Open to In progress; release removes only that caller's assignment. Neither is an access-control lock. `--from-chat` records declared provenance alongside the actual HTTP principal; it cannot grant permission to edit a chat-authored comment.

Agent ticket commands produce one concise transcript notice per command, with clickable ticket IDs in the workspace. Relationship notices name both tickets and the link kind; list notices include supplied filters as literal values. Each notice keeps its own source address, including when an assistant message contains multiple commands. Native `garcon-ticket-*-result` envelopes carry JSON `{data, context?}` on success or `{errorCode, message, context?}` on failure. Optional context contains only list filters or relationship kind/target, so native history reload can reconstruct the same notices without copying ticket descriptions or comment bodies.

Malformed ticket commands remain visible and are not executed. When agent ticket commands are enabled, Garcon also sends one best-effort `<garcon-command-rejected>` reply per affected assistant message, containing the detected edge failures and correction guidance. For JSON bodies, serialize JSON first, then XML-escape `&`, `<`, and `>` once, leaving the outer tags unchanged. Retry only rejected candidates: other valid commands in the same message may already have executed.

Ticket results and rejection feedback queue as hidden server control input for a subsequent turn, respecting queue pauses. They never steer the active turn: a provider can acknowledge a late steer without sampling it. Neither creates a user message. Pending feedback is process-ephemeral and is lost on server restart; native reload reconstructs notices without replaying commands or feedback.

Additional mutations:

```bash
bun cli/main.ts ticket release G-42 --expected-revision 4
bun cli/main.ts ticket reopen G-42 --expected-revision 5
bun cli/main.ts ticket comment-edit G-42 --comment-id 33333333-3333-4333-8333-333333333333 --expected-revision 1 --body 'Updated progress.'
bun cli/main.ts ticket comment-delete G-42 --comment-id 33333333-3333-4333-8333-333333333333 --expected-revision 2
bun cli/main.ts ticket link G-42 --expected-revision 6 --target-id G-43 --target-revision 1 --link-kind blocks
bun cli/main.ts ticket unlink G-42 --expected-revision 7 --target-id G-43 --target-revision 2 --link-kind blocks
```

`related` is an undirected alternative to `blocks`. Parent grouping does not imply blocking. Canceled blockers remain unresolved until unlinked or later closed as Done. Comment edit/remove is author-only. Removal hides the current comment body but preserves all previous versions in activity history; it is not redaction.

Reads are bounded. Lists accept project, status, priority, one label, assignee, ready, and literal title/description query filters. List/history limits default to 50, maximum 100. Follow returned continuations with the same filters:

```bash
bun cli/main.ts ticket list --before-number 100 --expected-collection-revision 12
bun cli/main.ts ticket read G-42 --include-description false --comment-limit 10 --before-comment-sequence 21 --expected-collection-revision 12
bun cli/main.ts ticket history G-42 --before-sequence 300 --limit 20
```

List/comment continuations require the returned collection revision; refresh from the first page if it changed. Immutable activity history needs no revision fence. `--include-description false --comment-limit 0` reads only metadata and links. Responses never silently truncate authored bodies.

Every mutation prints its generated request ID, expected store ID, and resolved retry command prefix to stderr **before** submission. Creates also print the resolved project. If confirmation is lost, use that connection prefix with the same ticket operation and body, replacing or adding the printed `--request-id`, `--expected-store-id`, and inferred create `--project`. The prefix includes the config root and selected runtime role, never `auto`. Replace old connection options rather than appending duplicates. Retrying through Local instead of the original executor is a different authority and does not deduplicate. The server returns the original committed result, even after later edits or restart. That result confirms the operation; use `read` for current state. A changed payload under the same identity conflicts. A replacement ticket database has a different store ID and rejects stale requests. The CLI never automatically resubmits mutations or stores stdin for recovery.

`--stdin` supplies create descriptions, comment bodies, or closing comments as strict UTF-8 up to 48 KiB; it is mutually exclusive with the corresponding inline flag. Encoded requests must fit 64 KiB, so escape-heavy text may require a smaller body. `--json` emits only the typed response on stdout; progress/retry hints stay on stderr. Human output renders terminal control sequences visibly; JSON remains lossless while escaping terminal controls. Exit 0 means confirmed success, 2 means invalid CLI input, and 3 means a domain/transport failure. An interrupted command exits 130 and may already have committed.

## Start And Resume

Start a visible chat and wait for its accepted turn:

```bash
bun cli/main.ts \
  --runtime controller \
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
bun cli/main.ts --runtime controller resume 1785337200123456 \
  "Address the review findings."
```

Start a chat without waiting for its turn to settle:

```bash
bun cli/main.ts --runtime controller start-async \
  --cwd /path/to/project \
  --agent codex \
  --model gpt-5.4 \
  "Investigate the failing release check."
```

`start-async` prints the accepted chat and turn IDs, then returns. `--json` emits
one versioned envelope containing the exact receipt, parent relationship, server
instance, workspace, and title-update outcome. Use the turn ID with `wait` when
exact completion identity matters.

Synchronous `start --json` and `resume --json` buffer one versioned document
until the turn settles. They reuse the matching async acceptance fields and add
`turnReceipt`; `resume` also reports its title-update outcome. Failed,
interrupted, and output-unavailable receipts are still printed before the CLI
returns the same nonzero exit status as plain output. Automation that needs the
handle immediately should use `start-async --json` or `resume-async --json`,
then pass the returned chat and turn IDs to `wait --json`.

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
  --runtime controller \
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

## Fork Chats

Create a whole-chat fork at the source chat's current transcript watermark:

```bash
bun cli/main.ts --runtime controller fork 1785337200123456
```

Add a prompt to atomically create the fork and start its first turn. This is one
server operation, not a fork followed by a separately admitted resume:

```bash
bun cli/main.ts --runtime controller fork 1785337200123456 \
  "Continue the investigation in a separate chat."

bun cli/main.ts --runtime controller fork-async 1785337200123456 \
  --json "Run the independent review."
```

Bare `fork` returns after creation. Prompted `fork` waits for the new turn, while
`fork-async` returns its accepted fork and turn identities immediately. A single
`-` message reads stdin. Every form accepts `--json`; synchronous prompted JSON
adds `turnReceipt` to the same acceptance fields emitted by `fork-async`.

Forks fail closed when the provider cannot produce a settled native fork. Pass
`--allow-handoff-fork` only when a frozen Garcon-ledger fork is an acceptable
fallback. The fallback preserves the provider-neutral transcript but starts a
new native session. Fork-at-message is not exposed by this CLI command.

Prompted forks use the command ledger and safely retry an identical correlated
request after ambiguous transport failure. Bare forks are sent without a
request identity, so they are not automatically retried; an ambiguous failure
names the generated target chat ID to inspect first.

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
bun cli/main.ts --runtime controller resume 1785337200123456 \
  --message-title "Deployment constraint" \
  --color 0ea5e9,7dd3fc \
  --collapsible \
  "Do not deploy until the migration checksum matches."
```

Restart, replay, shares, and frozen forks preserve CLI presentation. Explicit native-history Reload and provider-native fork segments may drop it.

## Search And Chat History

List the complete chat metadata snapshot, optionally using the same filter language as the sidebar:

```bash
bun cli/main.ts --runtime controller chats --json
bun cli/main.ts --runtime controller chats \
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
bun cli/main.ts --runtime controller transcript-search enable
bun cli/main.ts --runtime controller transcript-search rebuild --json
bun cli/main.ts --runtime controller transcript-search status --json
bun cli/main.ts --runtime controller search '"version bump"' \
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
bun cli/main.ts --runtime controller read 1785337200123456 84 \
  -B 5 -A 5 --transcript-view-id view-1

bun cli/main.ts --runtime controller read 1785337200123456 84 \
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
bun cli/main.ts --runtime controller wait 1785337200123456 \
  --turn 7fc16cb7-53e0-4c10-a4a4-cd85900eb548
```

`wait --json` prints one terminal turn receipt. Available output contains one `text` value: the complete final assistant response selected by the integration, including all its text parts, without earlier commentary. Synchronous `start`, `resume`, prompted `fork`, and plain-text `wait` use that same result. An explicitly empty final succeeds without answer text; a successful turn without an identifiable final reports `no-final-response` and exits nonzero. Failed and interrupted turns never return partial commentary as an answer. Receipts belong to the running server process and may expire after restart or retention eviction even though the durable transcript remains available.

Inspect current chat-level progress when no retained turn handle is available:

```bash
bun cli/main.ts --runtime controller status 1785337200123456
bun cli/main.ts --runtime controller status 1785337200123456 \
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

When the provider supplies an explanation, status includes `permission reason:`;
the browser permission card and transcript also retain it. Claude Code can
request human approval for ambiguous destructive `rm` or `rmdir` targets even
in `bypassPermissions`. Garcon preserves that safety check rather than
automatically approving it. A prompt alone does not imply that the saved
permission mode changed after a restart.

Status is a one-shot, non-transactional observation. Use `wait` with the exact accepted chat and turn IDs when completion identity matters.

Submit an exact pending permission decision using every fence shown by status:

```bash
bun cli/main.ts --runtime controller permission-decision 1785337200123456 \
  permission-occurrence-id allow \
  --run run-id --server-instance server-instance-id --json
```

Answer a structured question with the exact IDs shown by `status`:

```bash
bun cli/main.ts --runtime controller permission-answer 1785337200123456 \
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
automatically redelivered while that record is retained. A decision the
executor never received, for example while it reconnects, is reported as not
delivered and leaves the request pending; repeating the same command once the
executor is ready delivers it.

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
bun cli/main.ts --runtime controller export 1785337200123456
bun cli/main.ts --runtime controller export 1785337200123456 \
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

Exports, shares, and handoff artifacts share a limit of four in-flight transcript
snapshots per controller. Admission happens before reading the snapshot and is
held through rendering. Excess requests fail with retryable HTTP 503
`TRANSCRIPT_WORK_BUSY`; they are not queued or retried automatically. Each
transcript Worker also admits at most eight waiting jobs behind its active job.

## Handoff Artifacts

Create a bounded XML projection for whole-chat summarization:

```bash
bun cli/main.ts --runtime controller handoff 1785337200123456 \
  --context-window-size 131072 --output handoff.xml
```

`handoff` is read-only: it creates no chat, changes no agent or owner, starts no run, and appends no transcript row.

The context window is the consuming model's token capacity. Garcon limits the artifact to 75% of that capacity using a generic estimate, leaving headroom for instructions and the response. Token usage varies by model.

Every retained source element carries its durable ordinal. Gap markers and the file receipt disclose omitted or abridged entries, transcript view and watermark, estimated usage, byte count, and SHA-256.

Use a handoff artifact for comprehensive high-level synthesis. Use complete XML export for exact enumeration and quotation.

## Asynchronous Delivery And Steering

`resume-async` submits to an existing chat and returns as soon as Garcon accepts it. The turn stays visible and stoppable in the SPA and inherits the target chat's saved execution settings.

```bash
bun cli/main.ts --runtime controller resume-async 1785337200123456 \
  "Implement the reviewed changes and run the focused tests."
```

If the target is busy, the command exits `3` without queueing or steering. Pass `--allow-steer` to deliver into the active turn instead. `--allow-steer` never queues:

```bash
bun cli/main.ts --runtime controller resume-async 1785337200123456 \
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
bun cli/main.ts --runtime controller add-row 1785337200123456 \
  --color 7c3aed,c4b5fd \
  --markdown \
  --collapsible \
  --title "Consultation status" \
  "**The architecture review is complete.**"
```

`add-row --json` emits one versioned envelope containing the complete correlated
server response, including the durable ordinal, transcript view, presentation,
format, disclosure, timestamp, and whether the row was appended or replayed as
a duplicate.

`stop` interrupts the active turn through the same command as the SPA Stop button:

```bash
bun cli/main.ts --runtime controller stop 1785337200123456
```

`stop --json` emits one versioned envelope with the chat-scoped stop receipt,
authoritative outcome and execution-control state. It does not invent an
affected turn ID when the stop contract does not provide one.

If queued messages exist, stopping pauses the queue. Resume it in Garcon before sending a new direct turn. Ctrl-C only detaches the terminal and does not send Stop.

## Connection Rules

The CLI uses two connection settings:

- `--config-dir <directory>` / `GARCON_CONFIG_DIR`, default `~/.garcon`.
- `--runtime auto|controller|executor` / `GARCON_RUNTIME`, default `auto`.

For each setting, an explicit flag wins over its environment variable. Empty environment values are unset. `--workspace`, `--workspace-dir`, and their environment variables belong to controller configuration only. The CLI learns the active controller's workspace from the authenticated API; it does not select a workspace directory. `--runtime-file` and `GARCON_CLI_RUNTIME` are removed. `--server` remains an optional assertion that must exactly match the selected runtime's URL, not a way to redirect credentials.

When upgrading, restart controllers and workers to publish the new fixed runtime files. Replace CLI workspace or runtime-file selectors with the intended config root and role. Flags now override environment variables, unlike earlier releases: review launch scripts that set both to different values before restarting, because the selected storage root will change.

Startup atomically publishes a private JSON file containing the actual bound address/port, a random per-process bearer token, instance identity, and `startedAt` timestamp:

```text
<config-dir>/runtime.json                 controller
<config-dir>/executor/runtime.json  executor
```

These are runtime metadata, not configuration. Named and explicit-directory controllers both publish at the root, so `--port 0` works without giving the CLI a port or workspace. After taking its lease, each process clears its role's predecessor file before initialization, publishes fresh metadata when listening, and removes only its own instance on clean shutdown. Crashes can leave stale files; discovery never deletes them.

`auto` reads only these two locations. With one file, it selects that role. With both, it compares `startedAt` (not filesystem modification time), chooses the newer runtime, and prints a warning on **stderr** naming the selection and how to select a role explicitly. Equal timestamps choose the controller. Malformed or insecure files are errors, not candidates to silently skip. With neither file, the CLI reports that no runtime is available under the selected root. Explicit `controller` or `executor` selection reads only that role's file and does not warn about the other role.

Timestamps express preference, not liveness. After selection, the CLI verifies the endpoint's identity with a capability-free HMAC challenge before sending its bearer token, then fetches authenticated controller context. A stale file, failed verification, denied gateway, or disconnected controller fails the command; it never triggers fallback to the other role or rereads a replacement during discovery. Selection and controller identity remain fixed throughout the invocation, including retries. Starting another role can change the target of a later `auto` invocation. An explicit role prevents switching roles, but still selects whichever process currently holds that role, potentially with a different controller workspace after restart. Warnings never contaminate JSON stdout.

Controllers export their resolved `GARCON_CONFIG_DIR` and `GARCON_RUNTIME=controller` to terminals and provider subprocesses. Workers export the same root setting and `GARCON_RUNTIME=executor`. Explicit CLI flags can override either value. Nested controllers and workers install their own role before spawning children. Generated follow-up commands and ticket retry prefixes carry the resolved root and explicit role, preserving their origin across separate invocations.

Run `bun cli/main.ts --help` for the complete command and option reference.
