# Scheduled prompts

Scheduled prompts are enabled by default. Open **More actions → Scheduled prompts** and use the switch on the right of a prompt to pause or resume its automatic runs. Paused prompts retain their configuration, position, and run history, and show **Paused** instead of a next-run countdown.

Pausing prevents future dispatches. A run already claimed, started, or queued continues normally. Pauses persist across controller restarts and apply equally to Local and remote executor targets. The switch remains available when a target executor is offline.

When a recurring prompt resumes, its next run uses the first future slot on its original cadence. Occurrences during the pause are skipped without catch-up dispatches or missed-run log entries. An overdue paused one-off needs a future run time before enabling; an expired recurring prompt needs an updated end date. Editing a paused prompt keeps it paused.

The controller owns enablement in `scheduled-prompts.json`. Records without an `enabled` field load as enabled. `PUT /api/v1/scheduled-prompts/enabled` accepts `{ expectedRevision, id, enabled }` and returns the existing mutation snapshot envelope. Revision conflicts require refresh; the browser retains the saved switch value until persistence succeeds. This route is browser-facing and does not change the CLI forwarding allowlist or executor RPC contract.
