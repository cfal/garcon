# Per-chat Fast mode

Codex chats default to **Standard**, including when the executor's Codex
`config.toml` selects Fast. Other chats and the executor's config file are not
changed when a chat selects Fast.

| Command | Result |
| --- | --- |
| `/fast` or `/fast status` | Shows this chat's saved speed setting. |
| `/fast on` | Selects Fast for this chat. Fast uses more allowance. |
| `/fast off` | Selects Standard for this chat. |

The composer's Speed control uses the same setting. A command is handled by
Garcon and does not submit a prompt or start a model turn. It accepts no
attachments. The setting is retained across browser reloads and server restarts.
An in-flight model request keeps its speed; subsequent requests use the new
selection. Provider availability and billing still apply.

## Ownership and failure behavior

`chats.json` owns `agentSettingsById.codex.values.speed`. Missing values mean
Standard. The existing versioned settings envelope, execution-settings API,
ownership epoch checks, and controller-to-executor settings flow carry it.
The frontend recognizes the advertised speed setting without importing Codex.
Unsupported agents do not advertise `/fast`.

The Codex adapter passes explicit `serviceTier: "default"` or `"priority"`
on start, resume, and each requested turn. It includes the tier in settings
updates and confirmation comparisons. A live update is successful only after
both the RPC and matching notification succeed. Existing timeout fencing remains
in force; ambiguous updates must not report success. A saved setting on an
unloaded chat is applied on the next start or resume.

Codex silently omits tiers not supported by a model. Garcon checks `model/list`
before enabling Fast on a loaded thread and before each Fast turn. Missing
support rejects the operation; it does not silently run Standard. This catalog
check does not establish account entitlement or guarantee the upstream serving
tier. Status reports the selected setting, not measured speed or billing.

The adapter enables the native Fast feature while keeping every chat's tier
explicit. No executor config file is rewritten. Controller and workers must
upgrade together (executor protocol revision 44).

The pinned protocol is Codex 0.166.0,
[`thread/settings/update`](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L236-L294).

## Verification

Unit tests cover command parsing, settings defaults, unsupported models,
explicit Standard/Fast values, notification matching, failure recovery, and
chat-switch ownership. The scripted Codex test observes actual model requests
through the pinned binary, including a conflicting executor default, two-chat
isolation, restart, and Fast-to-Standard transition. Run it on Local and both
remote executor dial directions. Browser coverage checks command submission,
status, persistence, and absence of model requests from the commands themselves.

The full repository check/test gates and an isolated startup are required
before release. Scripted tests use synthetic inputs and no paid model calls.
