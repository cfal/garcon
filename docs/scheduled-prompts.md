# Scheduled prompts

Scheduled prompts are enabled by default. Open **More actions → Scheduled prompts** and use the switch on the right of a prompt to pause or resume its automatic runs. Paused prompts retain their configuration, position, and run history, and show **Paused** instead of a next-run countdown.

Pausing prevents future dispatches. A run already claimed, started, or queued continues normally. Pauses persist across controller restarts and apply equally to Local and remote executor targets. The switch remains available when a target executor is offline.

When a recurring prompt resumes, its next run uses the first future slot on its original cadence. Occurrences during the pause are skipped without catch-up dispatches or missed-run log entries. An overdue paused one-off needs a future run time before enabling; an expired recurring prompt needs an updated end date. Editing a paused prompt keeps it paused.

The controller owns enablement in `scheduled-prompts.json`. Records without an `enabled` field load as enabled. `PUT /api/v1/scheduled-prompts/enabled` accepts `{ expectedRevision, id, enabled }` and returns the existing mutation snapshot envelope. Revision conflicts require refresh; the browser retains the saved switch value until persistence succeeds. This route is browser-facing and does not change the CLI forwarding allowlist or executor RPC contract.

## Literal Chat Targets

Existing-chat schedules for Shell, including Notes, capture the saved agent,
ownership epoch, and mode at creation. The same guard applies to Settings, API,
and composer `/in` creation. When the agent catalog is unavailable, creation
conservatively captures the selection too. Known conversational targets retain
their current-selection behavior.

Dispatch checks the capture under the chat's mutation lock before admitting
input. A changed owner or mode fails with a run-log entry, without sending or
queueing the payload. An unguarded older schedule cannot dispatch to a literal
agent. Captures survive restarts and edits to the same target; recreate the
schedule to intentionally target a different mode. This prevents delayed Notes
text from becoming executable shell input.

Editing an older unguarded schedule captures the current selection, just as
creating a new schedule does.

`POST /api/v1/scheduled-prompts/in` accepts optional `expectedSelection` with
`agentId`, nullable `agentOwnershipEpoch`, and nullable `model`. The composer
sends its displayed literal selection; a stale selection is rejected before
saving. Existing-chat schedule targets retain the same optional typed field.
These browser/controller fields do not change executor RPC or CLI forwarding.

`/in` remains a one-off, busy-skip operation, using the current confirmed cwd
when it fires. A paused queue also skips it. Template substitution still applies,
but literal payloads keep their whitespace and slash-leading text. Scheduled
payloads never run composer app commands. See [Shell app commands](shell.md#app-commands).
