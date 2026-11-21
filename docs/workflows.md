# Workflows

A workflow definition is a reusable set of steps connected by signals. Publishing saves an immutable revision of the YAML. A run captures that revision and its launch inputs; edits and new revisions affect future runs only. An agent or Shell step runs in an ordinary Garcon chat. A repeated step has one instance per key, and a retry makes a new attempt under that instance.

## First Run

This workflow needs a signed-in Garcon browser session, an executor that supports [Shell](shell.md) with `sh` installed, and an existing folder on that executor. It needs neither an AI provider nor a Git repository.

```yaml
version: 1
name: Print a sample after review
steps:
  - id: review
    kind: decision
    prompt: Print the sample message?
    choices:
      approve: Print the sample
      stop: Stop here

  - id: print_sample
    kind: command
    shell: sh
    on: { kind: once, signal: review.approve }
    command: |
      printf '%s\n' 'Workflow approved'
```

1. Open **New Workflow**, then **Definition editor** and **Paste definition**. Paste the YAML.
2. To try it without publishing, select **Test run**, choose the executor and folder, then start the test. To start from a published revision, select **Publish**, then **New run**. Choose the definition, executor, and folder, and select **Start workflow**.
3. In the run viewer, select `review`. **Print the sample** starts the Shell step. When it has an attempt, select that step and use **Open chat** to read its output. **Stop here** records the other choice and leaves that Shell branch unrun.

Make human decisions in the signed-in browser run viewer. A delegated executor CLI does not have that authority, and running Garcon without authentication does not supply a human identity. A choice selects a branch; it does not grant tool permissions. Neither an agent response nor a successful command counts as a decision.

For typed inputs, keyed verifier instances, a join, and a decision on the summary, see the [full research recipe](../common/workflow-definition/fixtures/research.workflow.yaml). It uses Codex and synthetic findings; supply a `topic` and a folder on an executor where Codex is available.

## Definitions And Drafts

- **Open source file** edits the file on the selected executor. **Save draft file** uses [Files revision checks](executor/files.md) and is separate from publishing. If the file changed or a save could not be confirmed, use **Compare with disk** before saving again. Garcon keeps the draft for comparison.
- **Import YAML** reads a browser file. **Paste definition** reads text. Both make a new draft, without changing a namesake, publishing, or starting work.
- **Outline**, **Graph**, and **YAML source** show the same draft. Use **Edit graph** to add, branch, duplicate, or remove steps, or select a step to change its start condition and bindings. Use **Step settings** for executor and chat options. Use **YAML source** to declare inputs, custom signals, and decision choices. Graph edits preserve comments and text outside the edited fields. Undo and redo apply to the draft.
- A diagnostic opens the relevant line and column in the source. Invalid source can be saved to a draft file, but any last valid graph is stale and graph edits, publish, and test are disabled until the source is fixed. If removing a step leaves a dangling reference, the graph edit is rejected; remove the dependency first or fix both in YAML.
- **Share YAML** previews exactly what **Copy YAML** and **Download YAML** export: the authored source, not run inputs, evidence, chats, or access grants. Literal secrets pasted into a prompt or default are still in that source. Review it before sharing. Executor IDs, folders, attachments, and provider references must resolve for the recipient; sharing does not transfer credentials or files.

**Test run** really executes the draft, in a separate run without publishing. **Publish** creates a revision without running anything. Editing, moving, or deleting the source file does not change a published revision or an existing run. Only run definitions you trust: [Garcon does not sandbox agents or Shell commands](security.md).

## YAML v1

Use one UTF-8 YAML 1.2 mapping with `version: 1`, `name`, and a `steps` list of 1 to 64 entries. `description` and `inputs` are optional. The source limit is 256 KiB. Comments and literal blocks (`|`) are supported; duplicate keys, explicit tags, anchors, aliases, merge keys, and multiple documents are not. Each entry of `inputs` has a `type` (`string`, `number`, `boolean`, or `json`) and optional `description` and `default`. Without a default, the input is required at launch.

Each step has a unique `id`, a `kind`, and optional display `name` and start condition `on`. Use stable IDs with letters, digits, underscores, and hyphens, starting with a letter or digit. Step list order is not execution order.

| `kind` | Required | Optional fields |
| --- | --- | --- |
| `agent` | `prompt` | `bindings`, `signals`, `executorId`, `projectPath`, `agentId`, `model`, `apiProviderId`, `modelEndpointId`, `permissionMode`, `thinkingMode`, `agentSettings`, `orderedPreambleIds`, `attachments`, `tags` |
| `command` | `command` | `executorId`, `projectPath`, `shell` (defaults to `sh`; choose an executable mode, not Notes) |
| `decision` | `prompt`, `choices` | `bindings` |

`choices` maps signal names to button labels. Choosing one emits that name once, without a payload. A decision step needs no executor or folder. A command is literal Shell input, not a binding template, and has no model, preambles, or custom signals.

For an agent, `agentSettings` is a mapping with `ownerId`, `schemaVersion`, and `values`. `apiProviderId` and `modelEndpointId` select a configured provider route; `apiProviderId: null` selects native routing without an endpoint. `orderedPreambleIds: []` explicitly uses no preambles; omit it for defaults. Use normalized `tags` such as `[review-needed]`. `attachments` is a list such as `[{ path: ./notes.md }]`: files are read on the step's executor, relative to the step's folder or by absolute path, and must be supported by that agent and model.

### Locations And Settings

Agent and command steps inherit the launch executor unless they set `executorId`. Enter an existing folder for each executor that needs one, or set `projectPath` on a step to override it. A folder on one executor is never used as a fallback on another. Step settings can select a worktree where the Git picker is available; a workflow does not automatically create or isolate a checkout.

Garcon resolves omitted agent settings from the applicable New Chat selections and defaults at launch. Bypass permissions must be explicitly selected. The run retains the selected settings, and Garcon rechecks the executor, folder, and allowed configuration at admission. A run with a captured but unavailable target can wait for that executor. An unresolved model, folder, or permission needs correction, not a silent substitute.

### Dependencies And Bindings

| Start condition | Meaning |
| --- | --- |
| Omit `on` | Start independently. |
| `on: { kind: once, signal: research.report_ready }` | Start on the first accepted occurrence of a once signal. |
| `on: { kind: each, signal: research.finding_ready, maxConcurrency: 2 }` | Start one instance per accepted key. `maxConcurrency` defaults to 1 and accepts 1 to 4. |
| `on: { kind: all, close: research.turn_completed, steps: [verify] }` | Close intake at the producer's successful completion, then wait for every accepted instance in the listed groups to succeed. Each group must subscribe to a many signal from that producer. |

Joins include accepted items that are still queued and items manually added before intake closed. With no accepted items, a confirmed close is enough. A failed item or an unconfirmed close is not success. Subscribe to the original producer or join the group; an `each` step's own output is not a direct trigger in v1. A run can contain up to 128 repeated instances in total.

For agent and decision prompts, map placeholder names to data, for example `bindings: { topic: inputs.topic, claim: signal.claim }`, then use `{{topic}}` and `{{claim}}` in `prompt`. `inputs.<name>` selects a launch input. `signal` selects the whole triggering payload (the close signal in a join), and `signal.<field>` selects a declared JSON field. `all.<step>` binds the complete final text of a joined group as a JSON array in intake order. Strings are inserted as text; other values are rendered as JSON. Bindings are not expressions and are not expanded recursively.

### Live Signals

On an agent step, declare each custom signal under `signals`. Set `payload` to `none`, `text`, or `json`. `delivery` defaults to `once`. For `delivery: many`, use `payload: json`, declare `fields` with their types, and set `key` to a declared string field. For example, `finding_ready: { payload: json, delivery: many, fields: { finding_id: string, claim: string }, key: finding_id }`. Declared fields are required in the payload. A whole JSON value can be bound without declaring fields, but field bindings require a declaration.

Claude Code (`claude`) and Codex (`codex`) support custom signals from fresh workflow-managed turns on Local and remote executors. Use completion-only steps with other agents. An agent emits by making its **entire assistant message** one or more standalone Garcon envelopes, with blank lines between them and no surrounding prose, quote, indentation, or code fence. For example, for the declarations in the research recipe:

```xml
<garcon-workflow-emit signal="research.finding_ready" content-type="json">{"finding_id":"F-01","claim":"Two rows of two squares have four squares.","evidence":"2 + 2 = 4."}</garcon-workflow-emit>

<garcon-workflow-emit signal="research.report_ready" content-type="text">Two synthetic findings in geometry.</garcon-workflow-emit>

<garcon-workflow-emit signal="research.research_started" />
```

The envelope requires `signal`. If `content-type` is present, it must match the declared `payload`; otherwise Garcon uses the declaration. A self-closing envelope has no body.

This is a Garcon assistant-message envelope, not a shell command or `garcon-cli` subcommand. Quoted examples, Shell stdout, tool output, user messages, ordinary assistant prose, and reloaded or late messages from an old turn do not trigger edges. Workflow chats still follow normal steering and permission rules. People or peers can influence what an agent replies; their messages themselves neither emit signals nor attest a human decision.

Garcon checks the payload and key against the declaration. A rejected emit starts no work and can appear as a notice in the emitting chat. For the same producer instance, signal, and key, an identical payload is a duplicate; different content is a conflict. Retrying a producer does not forget its accepted signals.

`turn_completed` is reserved for Garcon. It is emitted only on confirmed success of the managed turn, including a confirmed zero exit for Shell. It carries final response or command output text only when captured completely and within limits. Completion-only edges still work without that text; a binding that requires missing or partial text blocks its consumer. An early custom report does not close intake or establish success.

## Operate A Run

Open a run from the sidebar or **Recent runs**. Use the graph or list to select a step. For a repeated step, filter instances by key or status, then inspect the bound inputs, evidence, executor, and attempts. **Open chat** opens the selected attempt; **Open source chat** opens the chat that produced evidence. A run's active or attention-needed chats can appear beneath it in the sidebar; older attempts remain in the run history.

- **Add item** supplies a human-attributed key and JSON payload to an open repeat group. The payload's declared key field must match. It counts in that group's join. If intake closes first, Garcon refuses the addition.
- **Add step** adds run-only work. Start independently, wait for a future signal, or select **Use a stored result**. A future listener does not replay prior signals. **Add step from result** chooses already recorded evidence, and an agent or decision can include its payload in the prompt. Existing dependencies and the published definition stay unchanged. To follow up on a succeeded run, start a new run.
- **Retry step** is for a definitively failed attempt. **Outcome unknown** means Garcon could not confirm what happened. Inspect the original attempt chat and executor before starting replacement work. A restart retains accepted signals and recorded history. Ready work can still start, but Garcon does not replay running attempts, infer success, or retry unknown work. This differs from **Retry same action** or **Retry same launch** after an unconfirmed browser request, which checks or resends the same operation rather than creating another attempt or run.
- **Archive run** retires the run without deleting its revision, inputs, signals, attempts, or chats. It refuses while a live attempt is unsettled. Archiving is not Stop and does not undo any side effects from an unknown attempt. Once archived, pending work will not dispatch and the run no longer accepts decisions, retries, or additions. Its history remains available, and it no longer holds workflow executor or provider references. Individual chats and other runs can still hold those references. Archiving does not retire the definition.
