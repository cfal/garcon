# Managed turns

Create one `chatCommands.createAutomation({ serverInstanceId, chatIds, execution: queue })`
at controller composition. Inject its `AutomationExecutionPort` into the workflow owner.
Call `beginShutdown()` before tearing down transcript observation. The port owns no
workflow persistence or scheduling, requires no Git repository, and does not alter
the supplied execution modes, permission grants, provider selection, or tags.

- `prepare(input, { onSignal? })` validates the explicitly selected executor and
  settings and returns a fresh `{ serverInstanceId, chatId, turnId, clientRequestId }`
  before creating a chat or dispatching. Persist that key before calling `start()`.
  `published` means the input committed and dispatch was scheduled, not that the
  executor started the native turn. The same prepared object cannot start twice.
- `waitForTerminal(key, signal)` observes exact process-local evidence. Only
  `completed` releases successful completion edges. Its `completeText` is
  `null` when text is missing, incomplete, too large, expired, or gapped; an empty
  string is a complete empty response. The receipt may still carry best-effort
  display text. An interrupted terminal can describe only a requested Stop.
- `stop(key)` targets only the matching attempt and reports delivery uncertainty
  for best-effort aborts; a key from another controller lifetime requires explicit
  chat Stop. No receipt or unknown outcome is replayed. Call `release()` after
  persisting settlement or abandoning observation; it is not native Stop.

## Signals

Supply `onSignal` only when a step is authorized to emit custom signals. Claude
and Codex advertise exact provenance for fresh starts. Claude binds to the first
matched input on its new CLI process; Codex binds to the native turn named by
the submission reply. Unsupported integrations, including Shell, are rejected
before starting emit-enabled steps; use built-in completion signals with them.

Emit as a standalone assistant message, without prose, indentation, or a code
fence. Separate multiple envelopes in one message with blank lines:

```xml
<garcon-workflow-emit signal="research.finding_ready" content-type="json">{"finding_id":"f1"}</garcon-workflow-emit>
```

`content-type` is `none`, `text`, or `json`. Omit it to defer interpretation
to the signal definition. A self-closing envelope carries no body. Body text
is raw, with one framing line break removed at each end. Quoted, nested, mixed
prose, replayed history, retired turn, or command output text is not a signal.

The callback receives `{ key, source: { transcriptViewId, ordinal, index }, candidate }`
only from committed live rows on the exact attempt. It serializes persistence
per attempt; it should resolve to `undefined` (or `{ kind: 'accepted' }`) after
acceptance, or resolve `{ kind: 'rejected', message }` after recording a rejection.
Validate the declared signal and payload before accepting. Rejections produce a
notice in the emitting transcript, not a new prompt or an unrelated steer. Wait
does not release successful completion until queued callbacks settle. A thrown
callback, overflow, or relay gap leaves signal intake unconfirmed and does not
replay any callbacks.
