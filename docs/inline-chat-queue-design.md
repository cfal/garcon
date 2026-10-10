# Inline chat queue

Queued messages remain visible above the composer, with drag ordering, per-message
and full-list expansion, a direct edit button, and a Steer button on every text
message while the current provider supports steering. Mobile rows place actions
below the message to preserve its reading width. Remove and Send now belong in
the overflow menu; Send now retains its existing first-entry behavior.

The public Codex CLI distinguishes pending steers from queued follow-ups and
keeps both visible above the composer. Its pending preview explains that guidance
waits for the next tool/result boundary and keeps editing separate from delivery:
[pending input preview](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/tui/src/bottom_pane/pending_input_preview.rs#L14-L22).
Its [preview rendering](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/tui/src/bottom_pane/pending_input_preview.rs#L98-L175)
shows pending guidance before ordinary follow-ups. Garcon adapts that distinction
to explicit per-message buttons and a visible Waiting to steer status.

The controller owns message selection and delivery:

- An explicit Steer selects any queued entry by its stable ID, guarded by its
  content revision and the observed queue order revision. Successful delivery
  consumes only that entry. A definite rejection restores its queued status in
  the same position; an uncertain delivery retains the existing consume and
  reconciliation behavior.
- If the active turn cannot take guidance, or another steer is pending, the
  selected entry becomes a pending steer before queued turns and after existing
  pending steers. Moving it increments the order revision. Other follow-ups
  retain their relative order, and the input keeps its submission identity.
- Automatic delivery still selects only the first entry and observes queue
  pause. An explicit ready Steer retains its existing ability to act while the
  follow-up queue is paused.
- Messages with attachments retain the disabled Steer action and its explanation.
  Unsupported providers do not expose it. Pending steers show their waiting
  status instead of offering duplicate submission.

The existing HTTP request/response shapes and executor messages remain unchanged.
No queue persistence, transport retry, or provider-specific client behavior is
introduced. The transcript boundary remains governed by
[transcript-ledger-v5-design.md](transcript-ledger-v5-design.md#71-the-queuetranscript-boundary).

Verification covers selected middle/tail entries, original-order recovery on
rejection, revision conflicts, pending-steer ordering, delayed provider readiness,
exactly-once submission, Local and both remote executor directions, and desktop
and mobile layout, including long queues and rapid chat switches.
